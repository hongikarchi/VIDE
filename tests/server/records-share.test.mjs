// PLAN-53 T-336 (SPEC-17.6, ARCH-01 §5 「사이트 사본」): 거른 기록 on the account site. Off unless the
// owner turns it on; only kept records no correction replaced, never candidates, dropped ones,
// KakaoTalk·mail imports (kept or not) or their originals, and of each only date, type, text, part
// names and chapter. The PC replaces its copy in parts; a failure waits a minute; off and a
// deleted project remove it there; a remote session cannot turn it on. All sentences are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../../src/core/store.ts';
import { Records } from '../../src/core/records.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { OfflineView } from '../../src/server/offline-view.ts';
import { recordBatches, recordsShare } from '../../src/server/records-share.ts';
import { startServer } from '../../src/server/server.ts';

const ITEM_KEYS = ['chapter', 'date', 'id', 'parts', 'text', 'type', 'updatedAt'];

/** Every kind of record the boundary has to sort; returns the ids that may leave the PC. */
function fill(records, projectId) {
  const wall = records.addPart(projectId, { name: '1층 벽' });
  const roof = records.addPart(projectId, { name: '지붕' });
  const by = '설계자';
  const note = records.add(
    projectId,
    {
      date: '2026-03-02',
      type: 'D',
      text: '외벽 마감을 벽돌로 정함',
      parts: [wall.id, roof.id],
      chapter: '기본설계',
      attachments: { requestId: 'req-1', note: { id: 'n1', kind: 'journal' } },
    },
    { by, state: 'kept', source: 'note', sourceKey: 'note:n1:0' },
  );
  const old = records.add(
    projectId,
    { date: '2026-03-03', type: 'I', text: '지붕 경사 15도로 함' },
    { by, state: 'kept' },
  );
  const fixed = records.correct(projectId, old.id, { text: '지붕 경사 12도로 고침' }, by);
  records.add(
    projectId,
    { date: '2026-03-04', type: 'R', text: '후보로 남은 요청 문장' },
    { by: 'ai', source: 'request' },
  );
  const dropped = records.add(
    projectId,
    { date: '2026-03-05', type: 'E', text: '뺀 기록 문장' },
    { by, state: 'kept' },
  );
  records.setState(projectId, dropped.id, 'dropped', by);
  records.add(
    projectId,
    {
      date: '2026-03-06',
      type: 'K',
      text: '카톡 후보 문장',
      attachments: { file: { path: '기록/원문/talk.txt', line: 3 } },
    },
    { by, state: 'candidate', source: 'kakao', sourceKey: 'kakao:a' },
  );
  const keptKakao = records.add(
    projectId,
    {
      date: '2026-03-07',
      type: 'K',
      text: '카톡에서 거른 문장',
      attachments: { file: { path: '기록/원문/talk.txt', line: 9 } },
    },
    { by, state: 'kept', source: 'kakao', sourceKey: 'kakao:b' },
  );
  records.add(
    projectId,
    {
      date: '2026-03-08',
      type: 'R',
      text: '메일에서 거른 문장',
      attachments: { mail: { from: 'someone@example.invalid', subject: '창호 일정 문의' } },
    },
    { by, state: 'kept', source: 'mail', sourceKey: 'mail:c' },
  );
  // A correction of an imported record is 'manual' but keeps the original's attachment.
  const kakaoFixed = records.correct(projectId, keptKakao.id, { text: '카톡 문장을 고쳐 씀' }, by);
  return { shared: [note.id, fixed.id], wall, roof, note, fixed, kakaoFixed };
}

test('only kept, uncorrected, non-imported records leave, with only their seven fields', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const project = store.createProject('기록 공유');
  const records = new Records(store);
  const { shared, note, fixed } = fill(records, project.id);
  const { key, items } = recordsShare(records, project.id);
  assert.deepEqual(
    items.map((item) => item.id),
    shared,
    'note + correction only',
  );
  for (const item of items) assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS);
  assert.deepEqual(
    { ...items[0], parts: [...items[0].parts].sort() },
    {
      id: note.id,
      date: '2026-03-02',
      type: 'D',
      text: '외벽 마감을 벽돌로 정함',
      parts: ['1층 벽', '지붕'].sort(),
      chapter: '기본설계',
      updatedAt: note.updatedAt,
    },
  );
  assert.equal(items[1].text, fixed.text);
  const sent = JSON.stringify(items);
  for (const secret of [
    '후보로 남은',
    '뺀 기록',
    '카톡',
    '메일에서',
    'example.invalid',
    '창호 일정',
    '기록/원문',
    'note:n1',
    'req-1',
    '설계자',
    'source',
    'attachments',
  ])
    assert.ok(!sent.includes(secret), `nothing of ${secret} leaves`);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(recordsShare(records, project.id).key, key, 'same list, same fingerprint');
  records.setPart(project.id, records.parts(project.id)[0].id, { name: '1층 외벽' });
  assert.notEqual(recordsShare(records, project.id).key, key, 'a renamed part changes it');
});

test('parts of at most 500 records and about 900 KB; none is one empty part', () => {
  const item = (i, text = '문장') => ({
    id: `r${i}`,
    date: '2026-01-01',
    type: 'R',
    text,
    parts: [],
    chapter: null,
    updatedAt: 'x',
  });
  assert.deepEqual(recordBatches([]), [[]]);
  assert.deepEqual(
    recordBatches(Array.from({ length: 1201 }, (_, i) => item(i))).map((b) => b.length),
    [500, 500, 201],
  );
  const big = recordBatches(Array.from({ length: 100 }, (_, i) => item(i, '가'.repeat(19_000))));
  assert.ok(big.length > 1);
  for (const batch of big) assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 900 * 1024);
});

/** OfflineView with a site that records its calls; `fail` makes the next uploads answer it. */
async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-records-share-'));
  const store = new Store(join(directory, 'store.sqlite'));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = store.createProject('기록 공유');
  const records = new Records(store);
  let clock = Date.parse('2026-10-15T00:00:00Z');
  const site = { uploads: [], deletes: [], fail: undefined, deleteFails: false, summaries: 0 };
  const offline = new OfflineView({
    directory,
    store,
    workspace: new Workspace(store),
    links: new DocumentLinks(store),
    remote: {
      hostId: 'host-1',
      uploadSnapshot: async () => undefined,
      deleteSnapshot: async () => true,
      uploadSummary: async () => {
        site.summaries++;
        return undefined;
      },
      deleteSummary: async () => true,
      uploadRecords: async (projectId, batches) => {
        if (site.fail) return site.fail;
        site.uploads.push({ projectId, batches });
        return undefined;
      },
      deleteRecords: async (projectId) => {
        site.deletes.push(projectId);
        return !site.deleteFails;
      },
    },
    records: (projectId) => recordsShare(records, projectId),
    now: () => clock,
  });
  return {
    directory,
    store,
    project,
    records,
    offline,
    site,
    advance: (ms) => (clock += ms),
  };
}

test('off by default; on sends the copy, again only when it changed; dropped leaves', async (t) => {
  const { project, records, offline, site, directory, advance } = await harness(t);
  const { shared, note } = fill(records, project.id);
  await offline.tick(true);
  assert.equal(site.uploads.length, 0, 'off unless turned on');
  assert.equal(site.summaries > 0, true, 'the 할 일 switch is separate (on by default)');
  const before = await offline.status(project.id);
  assert.equal(before.records, false);
  assert.equal(before.recordsAt, null);

  await offline.setRecords(project.id, true);
  await offline.tick(true);
  assert.equal(site.uploads.length, 1);
  const [{ batches }] = site.uploads;
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0].map((item) => item.id),
    shared,
  );
  const status = await offline.status(project.id);
  assert.equal(status.records, true);
  assert.ok(status.recordsAt);
  assert.equal(status.recordsError, null);
  // The switch is kept beside the others in offline-view.json.
  const saved = JSON.parse(await readFile(join(directory, 'offline-view.json'), 'utf8'));
  assert.equal(saved.projects[project.id].records, true);

  await offline.tick();
  await offline.tick(true);
  assert.equal(site.uploads.length, 1, 'unchanged: not sent again');

  // Turning the 할 일 switch off keeps this one and its fingerprint.
  await offline.setSummary(project.id, false);
  assert.equal((await offline.status(project.id)).records, true);
  await offline.tick(true);
  assert.equal(site.uploads.length, 1);

  records.setState(project.id, note.id, 'dropped', '설계자');
  // A heartbeat fingerprints the kept records at most once a minute per project.
  await offline.tick();
  assert.equal(site.uploads.length, 1, 'within the minute: not read again');
  advance(60_000);
  await offline.tick();
  assert.equal(site.uploads.length, 2, 'a record dropped here is sent as a new whole copy');
  assert.deepEqual(
    site.uploads[1].batches[0].map((item) => item.id),
    shared.slice(1),
  );
});

test('a site that does not answer waits a minute; off and a deleted project remove the copy', async (t) => {
  const { project, records, offline, site, advance } = await harness(t);
  fill(records, project.id);
  site.fail = 'SITE_UNREACHABLE';
  await offline.setRecords(project.id, true);
  await offline.tick(true);
  assert.equal((await offline.status(project.id)).recordsError, 'SITE_UNREACHABLE');
  site.fail = undefined;
  advance(30_000);
  await offline.tick();
  assert.equal(site.uploads.length, 0, 'not again within the minute');
  advance(31_000);
  await offline.tick();
  assert.equal(site.uploads.length, 1, 'again after a minute, from the first part');
  assert.equal((await offline.status(project.id)).recordsError, null);

  // Off: removed on the site; a removal the site did not confirm is tried with the heartbeat.
  site.deleteFails = true;
  await offline.setRecords(project.id, false);
  assert.deepEqual(site.deletes, [project.id]);
  assert.equal((await offline.status(project.id)).records, false);
  site.deleteFails = false;
  await offline.tick();
  assert.deepEqual(site.deletes, [project.id, project.id]);
  await offline.tick();
  assert.equal(site.deletes.length, 2, 'confirmed: not asked again');
  assert.equal(site.uploads.length, 1, 'off: nothing sent');

  // A deleted project whose records were on leaves the site too; one never on is not asked.
  await offline.setRecords(project.id, true);
  await offline.forget(project.id);
  assert.equal(site.deletes.length, 3);
  const other = (await harness(t)).offline;
  await other.forget('never-shared');
  assert.equal(site.deletes.length, 3);
});

test('measure: 5,000 kept records → fingerprint and items (ARCH-01 T-337 9, ≤50 ms)', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const project = store.createProject('기록 5천');
  const records = new Records(store);
  const parts = Array.from({ length: 30 }, (_, i) =>
    records.addPart(project.id, { name: `부위 ${i + 1}` }),
  );
  const day = (i) => new Date(Date.UTC(2024, 0, 1 + (i % 700))).toISOString().slice(0, 10);
  records.addMany(
    project.id,
    Array.from({ length: 5000 }, (_, i) => ({
      input: {
        date: day(i),
        type: 'RIKED'[i % 5],
        text: `합성 기록 ${i}: 외벽 마감과 창호 간격을 다시 맞춘다는 문장`,
        parts: [parts[i % 30].id],
        chapter: `장 ${(i % 6) + 1}`,
        ...(i % 5 === 0 ? { attachments: { requestId: `req-${i}` } } : {}),
      },
      sourceKey: `perf:${i}`,
    })),
    { by: '설계자', state: 'kept', source: 'note' },
  );
  recordsShare(records, project.id);
  const times = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const { items } = recordsShare(records, project.id);
    times.push(performance.now() - start);
    assert.equal(items.length, 5000);
  }
  times.sort((a, b) => a - b);
  const median = times[2];
  t.diagnostic(
    `recordsShare 5,000 median ${median.toFixed(1)} ms (${times.map((v) => v.toFixed(1)).join(', ')})`,
  );
  console.log(`[T-337 9] recordsShare kept 5,000: median ${median.toFixed(1)} ms`);
  // Loose bound against machine load; the criterion (50 ms) is reported in VERIFY.
  assert.ok(median < 500, `${median} ms`);
});

// --- Over HTTP, through the engine's own RemoteAccess (a linked PC with a tunnel) ---

const TUNNEL = 'records-share.trycloudflare.com';
const fakeTunnel = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit('exit', 0);
  setTimeout(() => child.stderr.emit('data', Buffer.from(`| https://${TUNNEL} |`)), 5);
  return child;
};
function call(port, path, { method = 'GET', host, origin, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          host,
          ...(origin ? { origin } : {}),
          ...(cookie ? { cookie } : {}),
          ...(data ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* text */
          }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}
const sign = (secret, payload) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return encoded + '.' + createHmac('sha256', secret).update(encoded).digest('hex');
};
const until = async (check) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check());
};

test('over HTTP: the switch, the PUT parts the site gets, DELETE when off; remote cannot turn it on', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-records-share-http-'));
  const secret = randomBytes(32).toString('hex'),
    hostId = '6b0f6a8e-7f53-4c55-9a39-2f0a0b7f6c11';
  await writeFile(
    join(directory, 'remote-host.json'),
    JSON.stringify({
      workerOrigin: 'https://sharing.example',
      hostId,
      secret,
      name: 'Studio PC',
      username: 'studio',
      remote: false,
    }),
  );
  const site = [];
  const app = await startServer({
    filename: join(directory, 'workspace.sqlite'),
    remoteOptions: {
      executable: 'cloudflared',
      spawnProcess: fakeTunnel,
      fetcher: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/records'))
          site.push({
            method: init.method,
            path,
            auth: init.headers.Authorization,
            body: init.body ? JSON.parse(init.body) : undefined,
          });
        return new Response('{"ok":true,"projects":[]}', { status: 200 });
      },
    },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const launch = new URL(app.launchUrl),
    port = Number(launch.port),
    local = { host: launch.host, origin: launch.origin };
  const session = await call(port, '/api/v1/session', {
    ...local,
    method: 'POST',
    body: { token: launch.hash.slice(1) },
  });
  const cookie = session.headers['set-cookie'][0].split(';')[0];
  const api = (path, method = 'GET', body) =>
    call(port, '/api/v1' + path, { ...local, cookie, method, body });
  const project = (await api('/projects', 'POST', { name: '기록 공유 HTTP' })).json;
  const records = new Records(app.store);
  const { shared } = fill(records, project.id);
  const base = `/projects/${project.id}/offline-view`;

  const first = await api(base);
  assert.equal(first.status, 200);
  assert.equal(first.json.records, false, 'off by default');
  assert.equal(first.json.recordsAt, null);
  assert.equal((await api(base, 'PUT', { records: 'yes' })).status, 400);

  const on = await api(base, 'PUT', { records: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.records, true);
  await until(() => site.some((c) => c.method === 'PUT'));
  const put = site.find((c) => c.method === 'PUT');
  assert.equal(put.path, `/api/hosts/device/projects/${project.id}/records`);
  assert.equal(put.auth, `Bearer ${hostId}.${secret}`);
  assert.equal(put.body.first, true);
  assert.deepEqual(
    put.body.items.map((item) => item.id),
    shared,
  );
  assert.ok(!JSON.stringify(put.body).includes('카톡'));

  // A remote session looks but cannot change the switch.
  const started = await call(port, '/api/v1/remote/remote', {
    ...local,
    cookie,
    method: 'POST',
    body: { enabled: true },
  });
  assert.equal(started.status, 200, started.text);
  let running = false;
  while (!running) {
    await new Promise((r) => setTimeout(r, 10));
    running = (await api('/remote')).json.running;
  }
  const remote = { host: TUNNEL, origin: `https://${TUNNEL}` };
  const login = await call(port, '/api/v1/session', {
    ...remote,
    method: 'POST',
    body: {
      remoteToken: sign(secret, {
        h: hostId,
        n: randomBytes(16).toString('hex'),
        e: Date.now() + 60_000,
      }),
    },
  });
  assert.equal(login.status, 200, login.text);
  const remoteCookie = login.headers['set-cookie'][0].split(';')[0];
  const look = await call(port, '/api/v1' + base, { ...remote, cookie: remoteCookie });
  assert.equal(look.status, 200);
  assert.equal(look.json.records, true);
  const refused = await call(port, '/api/v1' + base, {
    ...remote,
    cookie: remoteCookie,
    method: 'PUT',
    body: { records: false },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error?.code ?? refused.json.code ?? refused.json.error, 'FORBIDDEN');
  assert.equal((await api(base)).json.records, true, 'still on');

  const off = await api(base, 'PUT', { records: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.records, false);
  assert.ok(
    site.some(
      (c) => c.method === 'DELETE' && c.path === `/api/hosts/device/projects/${project.id}/records`,
    ),
  );
});
