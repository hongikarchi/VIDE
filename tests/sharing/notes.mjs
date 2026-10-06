// SPEC-10, ADR-034: shared project notes on the account site. Members only (any role edits),
// one Durable Object per note with two clients converging over the note socket, the Markdown
// snapshot in D1, one journal entry a day, journal append, and the work PC as a member through its
// host key (local copy for the AI, offline edits merged on reconnect).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import * as Y from 'yjs';

const root = fileURLToPath(new URL('../../src/sharing/', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { Miniflare, Log, LogLevel } = require('miniflare'),
  { build } = require('esbuild'),
  { WebSocketServer } = require('ws');
const directory = resolve(root, '../../.vide/sharing-notes', randomUUID());
await mkdir(directory, { recursive: true });
const bundled = await build({
  entryPoints: [join(root, 'worker.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['node:*', 'cloudflare:*'],
  conditions: ['workerd', 'worker', 'browser'],
});
let mf;
const webRoot = resolve(root, '../../dist/sharing');
// The local bridge: the built site page, the API from the Worker, and note sockets relayed to it.
const bridge = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = await mf.dispatchFetch(url.href, {
        method: request.method,
        headers: { ...request.headers, 'cf-connecting-ip': '192.0.2.98' },
        ...(!['GET', 'HEAD'].includes(request.method) ? { body: Buffer.concat(chunks) } : {}),
      });
      for (const [key, value] of result.headers) response.setHeader(key, value);
      if (result.headers.getSetCookie().length)
        response.setHeader('Set-Cookie', result.headers.getSetCookie());
      response.statusCode = result.status;
      response.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    const path = url.pathname.startsWith('/assets/')
      ? resolve(webRoot, '.' + url.pathname)
      : join(webRoot, 'index.html');
    if (!path.startsWith(webRoot)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      'Content-Type',
      path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html',
    );
    response.end(await readFile(path));
  } catch {
    response.writeHead(500).end('Test bridge failed');
  }
});
const sockets = new WebSocketServer({ noServer: true });
bridge.on('upgrade', async (request, socket, head) => {
  const reply = await mf.dispatchFetch(new URL(request.url, origin).href, {
    headers: { Upgrade: 'websocket', Origin: request.headers.origin ?? '' },
  });
  const inner = reply.webSocket;
  if (!inner) {
    socket.end('HTTP/1.1 ' + reply.status + ' Refused\r\n\r\n');
    return;
  }
  inner.accept();
  sockets.handleUpgrade(request, socket, head, (outer) => {
    outer.on('message', (data) => inner.send(new Uint8Array(data)));
    // 1005/1006 are "no code"/"abnormal" and cannot be sent on.
    const code = (value) => ([1000, 1001].includes(value) || value >= 3000 ? value : 1000);
    outer.on('close', () => {
      try {
        inner.close(1000);
      } catch {
        /* already closed */
      }
    });
    inner.addEventListener('message', (event) => outer.send(event.data));
    inner.addEventListener('close', (event) => outer.close(code(event.code)));
  });
});
await new Promise((done) => bridge.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + bridge.address().port;
const secret = randomBytes(32).toString('hex');
mf = new Miniflare({
  resourcePersistencePath: join(directory, 'state'),
  telemetry: { enabled: false },
  log: new Log(LogLevel.NONE),
  workers: [
    {
      config: {
        name: 'vide-sharing-notes-test',
        compatibilityDate: '2026-09-22',
        compatibilityFlags: ['nodejs_compat'],
        manifest: {
          mainModule: 'worker.js',
          modules: { 'worker.js': { type: 'esm', contents: bundled.outputFiles[0].text } },
        },
        exports: { NoteRoom: { type: 'durable-object', storage: 'sqlite' } },
        env: {
          DB: { type: 'd1', id: 'test-db', dev: { remote: false } },
          ASSETS: { type: 'r2', name: 'test-assets', dev: { remote: false } },
          NOTES: {
            type: 'durable-object',
            worker: 'vide-sharing-notes-test',
            exportName: 'NoteRoom',
          },
          ...Object.fromEntries(
            Object.entries({
              AUTH_MODE: 'manual-approval',
              AUTH_ORIGIN: origin,
              AUTH_SECRET: secret,
              SIGNUP_CODE: 'test-code',
              EMAIL_FROM: '',
            }).map(([key, value]) => [key, { type: 'text', value }]),
          ),
        },
      },
    },
  ],
});
const call = async (path, { method = 'GET', data, cookie, headers = {} } = {}) => {
  const response = await mf.dispatchFetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return {
    status: response.status,
    value,
    cookie: response.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; '),
  };
};
/** A WebSocket over Miniflare's dispatchFetch, for NoteSocket in Node (no listening port). */
class DispatchSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  constructor(url) {
    void mf
      .dispatchFetch(new URL(url.replace(/^ws/, 'http'), origin).href, {
        headers: { Upgrade: 'websocket' },
      })
      .then((reply) => {
        const ws = reply.webSocket;
        if (!ws) {
          this.readyState = 3;
          this.onclose?.({ code: reply.status === 404 ? 4404 : 4403 });
          return;
        }
        ws.accept();
        this.ws = ws;
        ws.addEventListener('message', (event) =>
          this.onmessage?.({
            data:
              event.data instanceof ArrayBuffer
                ? event.data
                : new Uint8Array(event.data).buffer.slice(0),
          }),
        );
        ws.addEventListener('close', (event) => {
          this.readyState = 3;
          this.onclose?.({ code: event.code });
        });
        this.readyState = 1;
        this.onopen?.();
      });
  }
  send(data) {
    this.ws?.send(data);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.ws?.close(code);
    this.onclose?.({ code });
  }
}
const until = async (check, what, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.fail('timed out: ' + what);
};

try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(join(root, 'migrations'))).sort()) {
    const sql = (await readFile(join(root, 'migrations', name), 'utf8')).replace(/^--.*$/gm, '');
    for (const statement of sql.split(';').filter((v) => v.trim()))
      await db.prepare(statement).run();
  }
  const account = async (username) => {
    const password = randomBytes(20).toString('hex');
    assert.equal(
      (
        await call('/api/account/sign-up', {
          method: 'POST',
          data: { username, password, code: 'test-code' },
        })
      ).status,
      201,
    );
    const response = await call('/api/account/sign-in', {
      method: 'POST',
      data: { username, password },
    });
    const me = await call('/api/me', { cookie: response.cookie });
    return { cookie: response.cookie, password, id: me.value.id, username };
  };
  const alice = await account('alice'),
    bob = await account('bob'),
    eve = await account('eve');
  const project = (
    await call('/api/projects', { method: 'POST', cookie: alice.cookie, data: { name: 'Tower' } })
  ).value;
  // Bob joins as a viewer: any member edits notes (SPEC-10.2).
  await db
    .prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'viewer')")
    .bind(project.id, bob.id)
    .run();
  const base = `/api/projects/${project.id}/notes`;

  // Members only.
  assert.equal((await call(base, { cookie: eve.cookie })).status, 404);
  assert.equal(
    (await call(base, { method: 'POST', cookie: eve.cookie, data: { title: 'x' } })).status,
    404,
  );
  assert.equal((await call(base)).status, 401);
  const created = await call(base, {
    method: 'POST',
    cookie: bob.cookie,
    data: { title: '구조 협의', kind: 'discussion' },
  });
  assert.equal(created.status, 201);
  const noteId = created.value.id;
  assert.equal(created.value.kind, 'discussion');
  assert.equal(
    (await call(base, { method: 'POST', cookie: bob.cookie, data: { kind: 'journal' } })).status,
    400,
    'a journal entry is made only through 오늘',
  );
  assert.equal(
    (await call(`${base}/${noteId}/ticket`, { method: 'POST', cookie: eve.cookie })).status,
    404,
  );
  // Eve cannot reach the socket with a forged or someone else's ticket.
  const forged = await mf.dispatchFetch(origin + '/api/notes/socket?t=abc.def', {
    headers: { Upgrade: 'websocket' },
  });
  assert.equal(forged.status, 401);

  // Two clients (Alice and Bob) edit the same note and converge.
  const { NoteSocket } = await import('../../src/contracts/note-socket.ts');
  const { NOTE_FIELD, noteMarkdown, actionItems } = await import('../../src/contracts/note-doc.ts');
  const ticketUrl = (cookie) => async () => {
    const reply = await call(`${base}/${noteId}/ticket`, { method: 'POST', cookie });
    if (reply.status !== 200) throw new Error(reply.value.error);
    return reply.value.url;
  };
  const paragraph = (text) => {
    const element = new Y.XmlElement('paragraph');
    const run = new Y.XmlText();
    run.insert(0, text);
    element.insert(0, [run]);
    return element;
  };
  const task = (text, checked = false) => {
    const item = new Y.XmlElement('taskItem');
    item.setAttribute('checked', checked);
    item.insert(0, [paragraph(text)]);
    return item;
  };
  const docA = new Y.Doc(),
    docB = new Y.Doc();
  const a = new NoteSocket({ doc: docA, url: ticketUrl(alice.cookie), WebSocket: DispatchSocket });
  const b = new NoteSocket({ doc: docB, url: ticketUrl(bob.cookie), WebSocket: DispatchSocket });
  await until(() => a.status.synced && b.status.synced, 'both synced');
  docA.getXmlFragment(NOTE_FIELD).insert(0, [paragraph('철골 보 춤 확인')]);
  const list = new Y.XmlElement('taskList');
  list.insert(0, [task('구조사무소에 경간 12 m 확인 요청'), task('지난 도면 회신', true)]);
  docB.getXmlFragment(NOTE_FIELD).insert(0, [list]);
  await until(
    () => noteMarkdown(docA) === noteMarkdown(docB) && noteMarkdown(docA).includes('[x]'),
    'two clients converge',
  );
  const markdown = noteMarkdown(docA);
  assert.match(markdown, /- \[ \] 구조사무소에 경간 12 m 확인 요청/);
  assert.match(markdown, /철골 보 춤 확인/);
  assert.deepEqual(actionItems(markdown), ['구조사무소에 경간 12 m 확인 요청']);

  // The snapshot reaches D1 (at once when the last socket leaves).
  a.destroy();
  b.destroy();
  await until(async () => {
    const row = await db
      .prepare('SELECT snapshot,updated_by FROM notes WHERE id=?')
      .bind(noteId)
      .first();
    return row.snapshot === markdown;
  }, 'snapshot in D1');
  const listed = await call(base + '?q=' + encodeURIComponent('경간'), { cookie: alice.cookie });
  assert.equal(listed.value.notes.length, 1, 'search reads the snapshot');
  assert.equal(listed.value.notes[0].title, '구조 협의');

  // A new client (after the room was left) gets the stored document.
  const docC = new Y.Doc();
  const c = new NoteSocket({ doc: docC, url: ticketUrl(alice.cookie), WebSocket: DispatchSocket });
  await until(() => c.status.synced && noteMarkdown(docC) === markdown, 'stored state reloads');
  c.destroy();

  // Journal: one entry a day, made by whoever presses 오늘 first.
  const day = '2026-10-06';
  const [j1, j2] = await Promise.all([
    call(`${base}/journal`, { method: 'POST', cookie: alice.cookie, data: { date: day } }),
    call(`${base}/journal`, { method: 'POST', cookie: bob.cookie, data: { date: day } }),
  ]);
  assert.equal(j1.status, 200);
  assert.equal(j1.value.id, j2.value.id, 'one journal entry per day');
  assert.equal(j1.value.title, '10월 6일 (화) 일지');
  assert.equal(
    (
      await call(`${base}/journal`, {
        method: 'POST',
        cookie: alice.cookie,
        data: { date: '10/6' },
      })
    ).status,
    400,
  );
  const other = await call(`${base}/journal`, {
    method: 'POST',
    cookie: alice.cookie,
    data: { date: '2026-10-07' },
  });
  assert.notEqual(other.value.id, j1.value.id);

  // Kind changes between 노트 and 협의 사항; a journal stays a journal. Delete: creator or owner.
  assert.equal(
    (
      await call(`${base}/${noteId}`, {
        method: 'PATCH',
        cookie: alice.cookie,
        data: { kind: 'note' },
      })
    ).value.kind,
    'note',
  );
  assert.equal(
    (
      await call(`${base}/${j1.value.id}`, {
        method: 'PATCH',
        cookie: alice.cookie,
        data: { kind: 'note' },
      })
    ).value.kind,
    'journal',
  );
  assert.equal(
    (await call(`${base}/${other.value.id}`, { method: 'DELETE', cookie: bob.cookie })).status,
    403,
  );

  // The work PC: a member through its host key; journal append, local copy, offline edits.
  const { RemoteAccess } = await import('../../src/server/remote-access.ts');
  const { SharedNotes } = await import('../../src/server/shared-notes.ts');
  const hostDirectory = join(directory, 'host');
  await mkdir(join(hostDirectory, 'projects', project.id), { recursive: true });
  const pc = new RemoteAccess({
    directory: hostDirectory,
    port: () => 1234,
    status: async () => ({}),
    projects: () => [],
    // The PC is its own client for the sign-in rate limit.
    fetcher: (url, init) =>
      mf.dispatchFetch(String(url), {
        ...init,
        headers: { ...init?.headers, 'cf-connecting-ip': '192.0.2.50' },
      }),
    spawnProcess: () => {
      throw new Error('no tunnel in this test');
    },
    heartbeatMs: 60_000,
  });
  await pc.link('alice', alice.password, 'Studio PC', origin);
  const added = [];
  const notes = new SharedNotes({
    remote: pc,
    dataDirectory: hostDirectory,
    WebSocket: DispatchSocket,
    agenda: {
      list: () => [],
      add: (projectId, input) => {
        added.push({ projectId, ...input });
        return { id: String(added.length), ...input };
      },
    },
    today: () => day,
  });
  // [퇴근하기]: the day's summary is appended to today's journal entry on the site.
  const appended = await notes.appendJournal(project.id, '오늘: 구조 협의 3건, 할 일 4/5 완료');
  assert.equal(appended.state, 'sent');
  assert.equal(appended.noteId, j1.value.id);
  await until(async () => {
    const row = await db.prepare('SELECT snapshot FROM notes WHERE id=?').bind(j1.value.id).first();
    return row.snapshot.includes('할 일 4/5 완료');
  }, 'journal append in D1');
  // The local copy: one Markdown file per note under the project's records folder.
  const listedOnPc = await notes.list(project.id);
  assert.equal(listedOnPc.online, true);
  const folder = join(hostDirectory, 'projects', project.id, 'notes');
  const journalFile = await readFile(join(folder, `journal-${day}.md`), 'utf8');
  assert.match(journalFile, /할 일 4\/5 완료/);
  assert.match(await readFile(join(folder, 'README.md'), 'utf8'), /구조 협의/);
  assert.match(await readFile(join(folder, `${noteId}.md`), 'utf8'), /경간 12 m/);

  // 협의 사항 → 할 일: the open check-list items go to the project's agenda.
  const sent = await notes.toAgenda(project.id, noteId);
  assert.deepEqual(
    sent.added.map((item) => item.text),
    ['구조사무소에 경간 12 m 확인 요청'],
  );
  assert.equal(
    (await notes.toAgenda(project.id, noteId)).added.length,
    1,
    'agenda stub keeps none',
  );

  // Offline: an edit on the PC while the site is unreachable is kept and merged on reconnect.
  let siteDown = true;
  const flakyPc = new RemoteAccess({
    directory: hostDirectory,
    port: () => 1234,
    status: async () => ({}),
    fetcher: (url, init) => {
      if (siteDown) return Promise.reject(new TypeError('fetch failed'));
      return mf.dispatchFetch(String(url), init);
    },
    spawnProcess: () => {
      throw new Error('no tunnel in this test');
    },
    heartbeatMs: 60_000,
  });
  const offlineNotes = new SharedNotes({
    remote: flakyPc,
    dataDirectory: hostDirectory,
    WebSocket: DispatchSocket,
    agenda: { list: () => [], add: () => ({}) },
    today: () => day,
  });
  assert.equal((await offlineNotes.list(project.id)).online, false, 'offline list from the copy');
  assert.equal(
    (await offlineNotes.appendJournal(project.id, '오프라인 퇴근 기록')).state,
    'queued',
  );
  const replica = await offlineNotes.open(project.id, noteId);
  replica.doc.getXmlFragment(NOTE_FIELD).push([paragraph('PC에서 오프라인으로 쓴 줄')]);
  await offlineNotes.flushLocal();
  assert.ok(existsSync(join(folder, '.yjs', `${noteId}.bin`)), 'offline state kept on disk');
  assert.match(await readFile(join(folder, `${noteId}.md`), 'utf8'), /오프라인으로 쓴 줄/);
  await offlineNotes.close();
  siteDown = false;
  const reopened = new SharedNotes({
    remote: flakyPc,
    dataDirectory: hostDirectory,
    WebSocket: DispatchSocket,
    agenda: { list: () => [], add: () => ({}) },
    today: () => day,
  });
  await reopened.pushPending(project.id);
  await until(
    async () => {
      const row = await db.prepare('SELECT snapshot FROM notes WHERE id=?').bind(noteId).first();
      return row.snapshot.includes('오프라인으로 쓴 줄') && row.snapshot.includes('경간 12 m');
    },
    'offline edit merged on the site',
    8000,
  );
  const journalRow = await db
    .prepare('SELECT snapshot FROM notes WHERE id=?')
    .bind(j1.value.id)
    .first();
  assert.match(journalRow.snapshot, /오프라인 퇴근 기록/, 'queued journal line sent on reconnect');
  await reopened.close();
  await notes.close();

  let browser = 'skipped (no dist/sharing)';
  if (existsSync(join(webRoot, 'index.html'))) {
    const { verifyNotesBrowser } = await import('./notes-browser.mjs');
    browser = await verifyNotesBrowser({ origin, alice, bob, project, directory });
    const { verifyNotesPc } = await import('./notes-pc-browser.mjs');
    browser +=
      ' · ' +
      (await verifyNotesPc({ origin, mf, db, alice, project, noteId, hostDirectory, directory }));
  }
  console.log(
    JSON.stringify({
      passed: true,
      membersOnly: true,
      converge: true,
      snapshot: true,
      journalPerDay: true,
      pcCopy: true,
      toAgenda: true,
      offlineMerge: true,
      browser,
    }),
  );
} finally {
  await mf.dispose();
  bridge.close();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
