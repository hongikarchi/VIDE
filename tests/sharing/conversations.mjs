// PLAN-36 (ADR-037 4): conversation records on the account site. A member's PC uploads its hostless
// conversations with its host key (a long answer in several D1 chunks, back in full); members only
// read them (list, thread, text search) on the site and through their own PC's copy; a PC never
// replaces another PC's rows; turning the switch off removes that PC's rows. Browser: the site's
// list, search and thread view.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const root = fileURLToPath(new URL('../../src/sharing/', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { Miniflare, Log, LogLevel } = require('miniflare'),
  { build } = require('esbuild');
const directory = resolve(root, '../../.vide/sharing-conversations', randomUUID());
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
const bridge = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = await mf.dispatchFetch(url.href, {
        method: request.method,
        headers: { ...request.headers, 'cf-connecting-ip': '192.0.2.97' },
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
await new Promise((done) => bridge.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + bridge.address().port;
mf = new Miniflare({
  resourcePersistencePath: join(directory, 'state'),
  telemetry: { enabled: false },
  log: new Log(LogLevel.NONE),
  workers: [
    {
      config: {
        name: 'vide-sharing-conversations-test',
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
            worker: 'vide-sharing-conversations-test',
            exportName: 'NoteRoom',
          },
          ...Object.fromEntries(
            Object.entries({
              AUTH_MODE: 'manual-approval',
              AUTH_ORIGIN: origin,
              AUTH_SECRET: randomBytes(32).toString('hex'),
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

let apps = [];
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
  await db
    .prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'viewer')")
    .bind(project.id, bob.id)
    .run();
  const base = `/api/projects/${project.id}/conversations`;

  // Each member's work PC: a local store with the project and the account link.
  const { startServer } = await import('../../src/server/server.ts');
  const { RemoteAccess } = await import('../../src/server/remote-access.ts');
  const { ConversationMirror } = await import('../../src/server/conversation-mirror.ts');
  const { DocumentLinks } = await import('../../src/core/document-links.ts');
  const pcOf = async (who, name, ip) => {
    const home = join(directory, who.username);
    await mkdir(home, { recursive: true });
    const app = await startServer({ filename: join(home, 'pc.sqlite') });
    apps.push(app);
    app.store.ensureProject(project.id, project.name);
    const remote = new RemoteAccess({
      directory: home,
      port: () => 1234,
      status: async () => ({}),
      projects: () => [],
      fetcher: (url, init) =>
        mf.dispatchFetch(String(url), {
          ...init,
          headers: { ...init?.headers, 'cf-connecting-ip': ip },
        }),
      spawnProcess: () => {
        throw new Error('no tunnel in this test');
      },
      heartbeatMs: 60_000,
    });
    await remote.link(who.username, who.password, name, origin);
    const mirror = new ConversationMirror({
      directory: home,
      store: app.store,
      links: new DocumentLinks(app.store),
      remote,
    });
    return { app, remote, mirror, home };
  };
  const alicePc = await pcOf(alice, 'Studio PC', '192.0.2.61');
  const bobPc = await pcOf(bob, 'Bob PC', '192.0.2.62');
  const at = (n) => new Date(Date.parse('2026-10-06T09:00:00Z') + n * 60_000).toISOString();
  const pdb = alicePc.app.store.db(project.id);
  pdb
    .prepare(
      `INSERT INTO conversations(id,projectId,kind,title,provider,model,state,createdAt,updatedAt)
       VALUES('c-1',?,'session','마감재 검토','claude-cli','opus','open',?,?)`,
    )
    .run(project.id, at(0), at(0));
  const add = (id, input, result, n) =>
    pdb
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        id,
        project.id,
        JSON.stringify({ id, provider: 'claude-cli', pins: [], sketches: [], files: [], ...input }),
        'succeeded',
        JSON.stringify(result),
        at(n),
      );
  // A long answer (≈ 3 chunks) with a word only near its end.
  const longAnswer = '석재 단가 비교 '.repeat(25_000) + '결론: 화강석 버너구이';
  add(
    'req-1',
    { body: '마감재 단가 비교해줘', hostUse: 'none', conversationId: 'c-1' },
    {
      text: longAnswer,
      activity: [{ at: at(1), kind: 'execute', text: 'Bash', detail: 'Import-Csv 단가표.csv' }],
    },
    1,
  );
  add(
    'req-2',
    { body: 'X3열 기둥 옮겨줘', host: 'rhino', conversationId: 'c-1' },
    { text: '옮겼습니다', executions: [{ executionId: 'e1', label: 'move', body: 'Move()' }] },
    2,
  );
  assert.equal(await alicePc.mirror.upload(project.id, true), undefined);
  const chunks = await db
    .prepare('SELECT COUNT(*) AS n FROM shared_request_chunks WHERE project_id=? AND request_id=?')
    .bind(project.id, 'req-1')
    .first();
  assert.ok(chunks.n >= 3, `a long document is split (${chunks.n} chunks)`);
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) AS n FROM shared_requests WHERE project_id=?')
        .bind(project.id)
        .first()
    ).n,
    1,
    'the modeling request stays on the PC',
  );

  // Members only.
  assert.equal((await call(base, { cookie: eve.cookie })).status, 404);
  assert.equal((await call(base)).status, 401);
  const listed = await call(base, { cookie: bob.cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.value.conversations.length, 1);
  const conversation = listed.value.conversations[0];
  assert.equal(conversation.title, '마감재 검토');
  assert.equal(conversation.originName, 'alice');
  assert.equal(conversation.originPc, 'Studio PC');
  assert.equal(conversation.requests, 1);
  const thread = await call(`${base}/${conversation.originHost}/c-1`, { cookie: bob.cookie });
  assert.equal(thread.status, 200);
  assert.equal(thread.value.requests[0].answer, longAnswer, 'chunked text comes back whole');
  assert.equal(thread.value.requests[0].activity[0].detail, 'Import-Csv 단가표.csv');
  assert.equal(
    (await call(`${base}/${conversation.originHost}/c-1`, { cookie: eve.cookie })).status,
    404,
  );
  // Search reads the whole text (a word in the last chunk) and titles.
  const found = await call(base + '?q=' + encodeURIComponent('버너구이'), { cookie: bob.cookie });
  assert.deepEqual(
    found.value.matches.map((match) => match.id),
    ['req-1'],
  );
  assert.equal(
    (await call(base + '?q=' + encodeURIComponent('기둥'), { cookie: bob.cookie })).value.matches
      .length,
    0,
    'modeling text is not on the site',
  );
  // Another PC cannot replace or remove alice's rows.
  const bobPut = await bobPc.remote.deviceFetch(`/projects/${project.id}/conversations`, 'PUT', {
    conversations: [],
    requests: [
      {
        id: 'req-1',
        conversationId: 'c-1',
        state: 'failed',
        createdAt: at(1),
        endedAt: null,
        revision: 9,
        doc: JSON.stringify({ body: 'x', answer: null, activity: [], executions: [], files: [] }),
      },
    ],
  });
  assert.equal(bobPut.status, 409);
  await bobPc.remote.deviceFetch(`/projects/${project.id}/conversations`, 'DELETE');
  assert.equal((await call(base, { cookie: bob.cookie })).value.conversations.length, 1);
  // A PC of an account outside the project is refused.
  const evePc = await pcOf(eve, 'Eve PC', '192.0.2.63');
  assert.equal(
    (await evePc.remote.deviceFetch(`/projects/${project.id}/conversations`)).status,
    404,
  );

  // Bob's PC: alice's conversation in his copy (the AI reads the Markdown).
  const bobList = await bobPc.mirror.list(project.id);
  assert.equal(bobList.online, true);
  assert.equal(bobList.conversations[0].originName, 'alice');
  const folder = join(bobPc.home, 'projects', project.id, 'history');
  const files = (await readdir(folder)).filter((name) => name.endsWith('.md'));
  assert.equal(files.length, 2, files.join(','));
  const copy = await readFile(
    join(
      folder,
      files.find((name) => name !== 'README.md'),
    ),
    'utf8',
  );
  assert.match(copy, /마감재 단가 비교해줘/);
  assert.match(copy, /화강석 버너구이/);
  assert.doesNotMatch(copy, /기둥 옮겨줘/);
  // Alice's own PC does not list her own records as another member's.
  assert.equal((await alicePc.mirror.list(project.id)).conversations.length, 0);

  let browser = 'skipped (no dist/sharing)';
  if (existsSync(join(webRoot, 'index.html'))) {
    const { chromium } = await import('playwright');
    let chrome;
    try {
      chrome = await chromium.launch({ channel: 'chrome', headless: true });
    } catch {
      chrome = undefined;
      browser = 'skipped (no Chrome)';
    }
    if (chrome) {
      try {
        const errors = [];
        const page = await (
          await chrome.newContext({ viewport: { width: 1280, height: 820 } })
        ).newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(origin);
        await page.getByLabel('아이디').fill(bob.username);
        await page.locator('input[autocomplete="current-password"]').fill(bob.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click();
        await page.getByRole('button', { name: `${project.name} 메뉴` }).click();
        await page.getByRole('menuitem', { name: '대화 기록' }).click();
        await page.getByRole('button', { name: /마감재 검토/ }).click();
        const view = page.getByRole('article', { name: '마감재 검토 대화 기록' });
        await view.getByText('마감재 단가 비교해줘').waitFor();
        await view.getByText('alice · Studio PC').waitFor();
        await view.getByText('보기 전용').waitFor();
        await view.getByText(/활동 1줄/).click();
        await view.getByText('Import-Csv 단가표.csv').waitFor();
        await page.getByLabel('대화 기록 검색').fill('버너구이');
        await page.getByRole('button', { name: '찾기' }).click();
        await page.getByText('‘버너구이’ 결과 1').waitFor();
        if (process.env.VIDE_SHOT) await page.screenshot({ path: process.env.VIDE_SHOT });
        else await page.screenshot({ path: join(directory, 'conversations-site.png') });
        assert.deepEqual(errors, []);
        browser = 'site thread view and search';
      } finally {
        await chrome.close();
      }
    }
  }

  // Alice turns the switch off: her rows leave the site.
  assert.equal(await alicePc.mirror.remove(project.id), true);
  assert.equal((await call(base, { cookie: bob.cookie })).value.conversations.length, 0);
  assert.equal(
    (await db.prepare('SELECT COUNT(*) AS n FROM shared_request_chunks').first()).n,
    0,
    'the chunks go too',
  );
  const after = await bobPc.mirror.list(project.id);
  assert.equal(after.conversations.length, 0, "bob's copy drops them on the next read");

  console.log(
    JSON.stringify({
      passed: true,
      membersOnly: true,
      chunkedRoundtrip: chunks.n,
      search: true,
      modelingStaysOnPc: true,
      ownRowsOnly: true,
      memberPcCopy: true,
      optOutDelete: true,
      browser,
    }),
  );
} finally {
  for (const app of apps) await app.close().catch(() => {});
  await mf.dispose();
  bridge.close();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
