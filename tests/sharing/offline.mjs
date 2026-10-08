// PLAN-20: the account site while the work PC is off. The PC stores a view-only snapshot of a
// linked file (owner only, size and quota limited) and receives requests left on the site.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'node:http';

const root = fileURLToPath(new URL('../../src/sharing/', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { Miniflare, Log, LogLevel } = require('miniflare'),
  { build } = require('esbuild');
const directory = resolve(root, '../../.vide/sharing-offline', randomUUID());
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
// A local bridge: the built site page from dist/sharing, the API from the Worker.
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
        // The browser counts as its own client for the sign-in rate limit.
        headers: { ...request.headers, 'cf-connecting-ip': '192.0.2.99' },
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
const secret = randomBytes(32).toString('hex');
// Site settings on top of the defaults; a null value leaves the setting out.
const options = (settings = {}) => {
  const text = Object.entries({
    AUTH_MODE: 'manual-approval',
    AUTH_ORIGIN: origin,
    AUTH_SECRET: secret,
    SIGNUP_CODE: 'test-code',
    EMAIL_FROM: '',
    // A tiny account quota so the limit is reachable in a test; the site cap turns snapshots on.
    SNAPSHOT_QUOTA_MB: '0.05',
    SNAPSHOT_TOTAL_MB: '1',
    ...settings,
  }).filter(([, value]) => value !== null);
  return {
    resourcePersistencePath: join(directory, 'state'),
    telemetry: { enabled: false },
    log: new Log(LogLevel.NONE),
    workers: [
      {
        config: {
          name: 'vide-sharing-offline-test',
          compatibilityDate: '2026-09-22',
          compatibilityFlags: ['nodejs_compat'],
          manifest: {
            mainModule: 'worker.js',
            modules: { 'worker.js': { type: 'esm', contents: bundled.outputFiles[0].text } },
          },
          env: {
            DB: { type: 'd1', id: 'test-db', dev: { remote: false } },
            ASSETS: { type: 'r2', name: 'test-assets', dev: { remote: false } },
            ...Object.fromEntries(text.map(([key, value]) => [key, { type: 'text', value }])),
          },
        },
      },
    ],
  };
};
mf = new Miniflare(options());
const call = async (path, { method = 'GET', data, cookie, ip } = {}) => {
  const response = await mf.dispatchFetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      // A separate client for the sign-in rate limit.
      ...(ip ? { 'cf-connecting-ip': ip } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const raw = new Uint8Array(await response.arrayBuffer());
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    value = raw;
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
try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(join(root, 'migrations'))).sort()) {
    const sql = (await readFile(join(root, 'migrations', name), 'utf8')).replace(/^--.*$/gm, '');
    for (const statement of sql.split(';').filter((v) => v.trim()))
      await db.prepare(statement).run();
  }
  const account = async (username, ip) => {
    const password = randomBytes(20).toString('hex');
    assert.equal(
      (
        await call('/api/account/sign-up', {
          method: 'POST',
          data: { username, password, code: 'test-code' },
          ip,
        })
      ).status,
      201,
    );
    const response = await call('/api/account/sign-in', {
      method: 'POST',
      data: { username, password },
      ip,
    });
    return { cookie: response.cookie, password };
  };
  const alice = await account('alice'),
    eve = await account('eve'),
    mallory = await account('mallory', '192.0.2.77');

  const { RemoteAccess } = await import('../../src/server/remote-access.ts');
  const { buildSnapshot, packSnapshot } = await import('../../src/server/offline-snapshot.ts');
  const { decodeSnapshot } = await import('../../src/contracts/offline-snapshot.ts');
  const hostDirectory = join(directory, 'host');
  await mkdir(hostDirectory, { recursive: true });
  const project = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Tower' };
  const inbox = [],
    siteEdits = [];
  const pc = new RemoteAccess({
    directory: hostDirectory,
    port: () => 1234,
    status: async () => ({ version: '0.10.1' }),
    projects: () => [project],
    onQueue: (items) => {
      inbox.push(...items);
      return items.map((item) => item.id);
    },
    // PLAN-33: 할 일 edits made on the site (the PC side is covered by offline-view.test.mjs).
    onAgendaEdits: async (edits) => {
      siteEdits.push(...edits);
      return edits.map((edit) => ({ id: edit.id, editedAt: edit.editedAt, outcome: 'applied' }));
    },
    fetcher: (url, init) => mf.dispatchFetch(String(url), init),
    spawnProcess: () => {
      throw new Error('no tunnel in this test');
    },
    heartbeatMs: 60_000,
  });
  await pc.link('alice', alice.password, 'Studio PC', origin);
  assert.ok(pc.hostId, 'PC signed in');
  // The login names the account (SPEC-05.10): its id and ID, kept on the PC; no email.
  const aliceId = (await pc.status()).userId;
  assert.match(aliceId ?? '', /\S/);
  assert.deepEqual(pc.account(), { id: aliceId, name: 'alice' });
  await pc.pushProject(project);

  // A Sync of a linked file with a mesh at survey coordinates, a line, a hatch loop and a label.
  const b64 = (text) => Buffer.from(text).toString('base64');
  const sync = {
    scene: [
      {
        id: 'm',
        vertices: [200000, 500000, 0, 200001, 500000, 0, 200000, 500001, 0],
        indices: [0, 1, 2],
        layer64: b64('구조::보'),
        displayColor: '#ff0000',
      },
      {
        id: 'l',
        line: [200000, 500000, 0, 200002, 500000, 0, 200002, 500002, 0],
        layer64: b64('A'),
      },
      {
        id: 'h',
        fills: [{ loops: [[0 + 200000, 500000, 0, 200001, 500000, 0, 200001, 500001, 0]] }],
        layer64: b64('A'),
        colorIndex: 1,
      },
      { id: 't', texts: [{ s: '실명', p: [200001, 500001, 0], h: 0.3, r: 0 }], layer64: b64('A') },
      { id: 'bad', valid: false },
    ],
    sourceDocument: { name: 'plan.3dm', capturedAt: '2026-09-29T00:00:00.000Z' },
  };
  const snapshot = buildSnapshot(sync, { name: 'plan.3dm', host: 'rhino' });
  assert.equal(snapshot.objectCount, 4);
  assert.deepEqual(
    snapshot.groups.map((g) => `${g.layer}/${g.kind}`),
    ['A/lines', '구조::보/mesh'],
  );
  // Line (2 segments) + closed hatch loop (3 segments) = 10 line vertices.
  assert.equal(snapshot.groups[0].positions.length / 3, 10);
  assert.equal(snapshot.texts[0].s, '실명');
  const bytes = packSnapshot(snapshot);
  const roundTrip = decodeSnapshot(gunzipSync(bytes));
  assert.deepEqual([...roundTrip.groups[1].colors.slice(0, 3)], [255, 0, 0]);
  // Positions are local to the origin; the origin keeps the survey coordinates.
  assert.ok(Math.abs(roundTrip.origin[0] - 200001) < 1e-9);
  assert.ok(roundTrip.groups[1].positions.every((v) => Math.abs(v) <= 1.5));

  const linkId = randomUUID();
  const meta = { name: 'plan.3dm', host: 'rhino', objects: 4, capturedAt: Date.now() };
  assert.equal(await pc.uploadSnapshot(project.id, linkId, meta, bytes), undefined);
  // The owner lists and downloads it; another account cannot.
  const listed = await call(`/api/projects/${project.id}/snapshots`, { cookie: alice.cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.value.snapshots[0].linkId, linkId);
  assert.equal(listed.value.snapshots[0].objectCount, 4);
  const downloaded = await call(`/api/projects/${project.id}/snapshots/${linkId}`, {
    cookie: alice.cookie,
  });
  assert.deepEqual(Buffer.from(downloaded.value), Buffer.from(bytes));
  assert.equal(
    (await call(`/api/projects/${project.id}/snapshots`, { cookie: eve.cookie })).status,
    404,
  );
  // Another PC's project cannot be written, and the account quota holds (50 KB here).
  assert.equal(
    await pc.uploadSnapshot('bbbbbbbb-1111-4111-8111-111111111111', linkId, meta, bytes),
    'PROJECT_NOT_FOUND',
  );
  assert.equal(
    await pc.uploadSnapshot(project.id, randomUUID(), meta, randomBytes(60_000)),
    'SNAPSHOT_QUOTA',
  );
  // Replacing the same file's snapshot does not count twice.
  assert.equal(await pc.uploadSnapshot(project.id, linkId, meta, bytes), undefined);
  const config = async () => (await call('/api/config')).value;
  assert.equal((await config()).snapshotsEnabled, true);

  // RESEARCH-10 §13.6: the upload pause stops PC snapshot writes too, and snapshots stay off
  // unless the site sets a site-wide cap (default 0) and leaves the switch on.
  const spare = randomUUID();
  assert.equal(await pc.uploadSnapshot(project.id, spare, meta, bytes), undefined);
  for (const settings of [
    { UPLOADS_ENABLED: 'false' },
    { SNAPSHOTS_ENABLED: 'false' },
    { SNAPSHOT_TOTAL_MB: null },
    { SNAPSHOT_TOTAL_MB: '0' },
  ]) {
    await mf.setOptions(options(settings));
    assert.equal(
      await pc.uploadSnapshot(project.id, randomUUID(), meta, bytes),
      'SNAPSHOTS_DISABLED',
      JSON.stringify(settings),
    );
    assert.equal((await config()).snapshotsEnabled, false, JSON.stringify(settings));
  }
  // While uploads are paused, the owner still reads and the PC still removes snapshots.
  await mf.setOptions(options({ UPLOADS_ENABLED: 'false' }));
  assert.equal((await config()).uploadsEnabled, false);
  assert.equal(
    (await call(`/api/projects/${project.id}/snapshots/${linkId}`, { cookie: alice.cookie }))
      .status,
    200,
  );
  assert.equal(await pc.deleteSnapshot(project.id, spare), true);
  assert.deepEqual(
    (
      await call(`/api/projects/${project.id}/snapshots`, { cookie: alice.cookie })
    ).value.snapshots.map((s) => s.linkId),
    [linkId],
  );
  await mf.setOptions(options());

  // Requests left on the site wait for the PC, can be taken back until then, and arrive once.
  const queued = await call(`/api/projects/${project.id}/queue`, {
    method: 'POST',
    cookie: alice.cookie,
    data: { body: '2층 보 단면 검토해줘', linkId },
  });
  assert.equal(queued.status, 201);
  const other = await call(`/api/projects/${project.id}/queue`, {
    method: 'POST',
    cookie: alice.cookie,
    data: { body: '취소할 요청' },
  });
  assert.equal(
    (
      await call(`/api/projects/${project.id}/queue/${other.value.id}`, {
        method: 'DELETE',
        cookie: alice.cookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/api/projects/${project.id}/queue`, {
        method: 'POST',
        cookie: eve.cookie,
        data: { body: 'x' },
      })
    ).status,
    404,
  );
  await pc.heartbeat();
  assert.deepEqual(
    inbox.map((item) => item.body),
    ['2층 보 단면 검토해줘'],
  );
  assert.equal(inbox[0].linkId, linkId);
  await pc.heartbeat();
  assert.equal(inbox.length, 1, 'delivered once');
  const state = await call(`/api/projects/${project.id}/queue`, { cookie: alice.cookie });
  const delivered = state.value.requests.find((r) => r.id === queued.value.id);
  assert.ok(delivered.deliveredAt);
  assert.equal(
    (
      await call(`/api/projects/${project.id}/queue/${queued.value.id}`, {
        method: 'DELETE',
        cookie: alice.cookie,
      })
    ).status,
    409,
  );
  // Removing the snapshot (the owner turned the offline view off on the PC).
  assert.equal(await pc.deleteSnapshot(project.id, linkId), true);
  assert.deepEqual(
    (await call(`/api/projects/${project.id}/snapshots`, { cookie: alice.cookie })).value.snapshots,
    [],
  );
  // PLAN-33: the project without its PC — 할 일 (read and written), history summary (read only).
  // The D1 stub of before the settings changes above is gone.
  const d1 = await mf.getD1Database('DB');
  const api = (path, options) => call(`/api/projects/${project.id}${path}`, options);
  // Nothing shared yet: the page says so, and 할 일 cannot be written.
  assert.deepEqual((await api('/agenda', { cookie: alice.cookie })).value, {
    sharedAt: null,
    pending: 0,
    items: [],
  });
  assert.equal(
    (await api('/agenda', { method: 'POST', cookie: alice.cookie, data: { text: 'x' } })).value
      .error,
    'AGENDA_NOT_SHARED',
  );
  const pcItem = {
    id: 'item-1',
    text: '구조 검토 회의',
    date: '2026-10-07',
    time: '14:00',
    kind: 'meeting',
    doneAt: null,
    order: 1,
    revision: 3,
    updatedAt: '2026-10-06T00:00:00.000Z',
  };
  assert.equal(await pc.uploadSummary(project.id, 'agenda', [pcItem]), undefined);
  assert.equal(
    await pc.uploadSummary(project.id, 'history', [
      {
        id: 'r1',
        body: '2층 보를 H-400으로 바꿔줘',
        answer: '바꿨습니다.',
        state: 'succeeded',
        createdAt: '2026-10-06T00:00:00.000Z',
        files: ['tower.3dm'],
        // Fields beyond the summary are never kept by the site (ADR-035).
        model: 'secret-model',
        attachments: ['private.pdf'],
        scene: [{ id: 'a' }],
      },
    ]),
    undefined,
  );
  // Another PC cannot write it; a bad item is refused whole.
  assert.equal(
    await pc.uploadSummary('bbbbbbbb-1111-4111-8111-111111111111', 'agenda', [pcItem]),
    'PROJECT_NOT_FOUND',
  );
  // A kind this site does not know is a 할 일, not a refused list (PLAN-39); a bad date still is.
  assert.equal(
    await pc.uploadSummary(project.id, 'agenda', [{ ...pcItem, kind: 'party' }]),
    undefined,
  );
  assert.equal((await api('/agenda', { cookie: alice.cookie })).value.items[0].kind, 'task');
  assert.equal(
    await pc.uploadSummary(project.id, 'agenda', [{ ...pcItem, date: '2026-13-01' }]),
    'INVALID_INPUT',
  );
  assert.equal(await pc.uploadSummary(project.id, 'agenda', [pcItem]), undefined);
  // The PC goes off: opening answers HOST_OFFLINE (the site page then opens the project without
  // its PC), the iPad relay page links there, and 할 일·history still answer.
  await d1.prepare('UPDATE remote_hosts SET last_seen=0').run();
  assert.equal(
    (
      await call(`/api/projects/${project.id}/open`, {
        method: 'POST',
        cookie: alice.cookie,
        data: {},
      })
    ).value.error,
    'HOST_OFFLINE',
  );
  const relayPage = await mf.dispatchFetch(`${origin}/pc/${pc.hostId}/?project=${project.id}`, {
    headers: { Cookie: alice.cookie, Accept: 'text/html,application/xhtml+xml' },
  });
  assert.equal(relayPage.status, 503);
  const relayHtml = await relayPage.text();
  assert.ok(relayHtml.includes(`href="/?offline=${project.id}"`), relayHtml);
  const history = (await api('/history', { cookie: alice.cookie })).value;
  assert.ok(history.sharedAt);
  assert.deepEqual(history.items, [
    {
      id: 'r1',
      body: '2층 보를 H-400으로 바꿔줘',
      answer: '바꿨습니다.',
      state: 'succeeded',
      files: ['tower.3dm'],
      createdAt: '2026-10-06T00:00:00.000Z',
    },
  ]);
  const stored = JSON.stringify((await d1.prepare('SELECT * FROM project_history').all()).results);
  for (const secret of ['secret-model', 'private.pdf', 'scene'])
    assert.ok(!stored.includes(secret));
  // Every member (user decision 2026-10-06): a shared member reads and writes, another account 404.
  const malloryId = (
    await d1.prepare("SELECT id FROM user WHERE email='mallory@users.vide.invalid'").first()
  ).id;
  await d1
    .prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'commenter')")
    .bind(project.id, malloryId)
    .run();
  assert.equal((await api('/agenda', { cookie: eve.cookie })).status, 404);
  assert.equal((await api('/history', { cookie: eve.cookie })).status, 404);
  assert.equal(
    (await api('/agenda', { method: 'POST', cookie: eve.cookie, data: { text: 'x' } })).status,
    404,
  );
  assert.equal((await api('/snapshots', { cookie: eve.cookie })).status, 404);
  assert.equal((await api('/agenda', { cookie: mallory.cookie })).status, 200);
  assert.equal((await api('/history', { cookie: mallory.cookie })).status, 200);
  assert.equal((await api('/snapshots', { cookie: mallory.cookie })).status, 200);
  const memberItem = await api('/agenda', {
    method: 'POST',
    cookie: mallory.cookie,
    data: { text: '참여자가 더한 일' },
  });
  assert.equal(memberItem.status, 201);
  assert.equal(
    (await api(`/agenda/${memberItem.value.id}`, { method: 'DELETE', cookie: mallory.cookie }))
      .status,
    200,
  );
  // Edits wait for the PC, shown over the PC's copy; one waiting edit per item.
  const added = await api('/agenda', {
    method: 'POST',
    cookie: alice.cookie,
    data: { text: '현장 사진 정리', date: '2026-10-08' },
  });
  assert.equal(added.status, 201);
  // Another member changes the waiting add: the author stays alice, mallory is the editor.
  assert.equal(
    (
      await api(`/agenda/${added.value.id}`, {
        method: 'PATCH',
        cookie: mallory.cookie,
        data: { text: '현장 사진 정리·업로드' },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api('/agenda/item-1', {
        method: 'PATCH',
        cookie: alice.cookie,
        data: { done: true, revision: 3 },
      })
    ).status,
    200,
  );
  assert.equal(
    (await api('/agenda/item-1', { method: 'PATCH', cookie: alice.cookie, data: { date: null } }))
      .status,
    200,
  );
  assert.equal(
    (await api('/agenda/nope', { method: 'PATCH', cookie: alice.cookie, data: { done: true } }))
      .value.error,
    'AGENDA_ITEM_NOT_FOUND',
  );
  assert.equal(
    (
      await api('/agenda/item-1', {
        method: 'PATCH',
        cookie: alice.cookie,
        data: { date: '2026-02-30' },
      })
    ).status,
    400,
  );
  // An item added and removed before the PC took it never reaches the PC.
  const dropped = await api('/agenda', {
    method: 'POST',
    cookie: alice.cookie,
    data: { text: '취소' },
  });
  assert.equal(
    (await api(`/agenda/${dropped.value.id}`, { method: 'DELETE', cookie: alice.cookie })).status,
    200,
  );
  let view = (await api('/agenda', { cookie: alice.cookie })).value;
  assert.equal(view.pending, 2);
  assert.deepEqual(
    view.items.map((item) => [item.text, item.done, item.date, item.time, item.pending]),
    [
      ['구조 검토 회의', true, null, null, true],
      ['현장 사진 정리·업로드', false, '2026-10-08', null, true],
    ],
  );
  // Authors (SPEC-04.10 2): the waiting add is alice's and mallory changed it; the PC's item has
  // no recorded author and alice's waiting change makes her its editor.
  assert.deepEqual(
    view.items.map((item) => [item.createdBy?.name ?? null, item.updatedBy?.name ?? null]),
    [
      [null, 'alice'],
      ['alice', 'mallory'],
    ],
  );
  // The PC comes back: the edits arrive with the heartbeat, folded, and are confirmed.
  await pc.heartbeat();
  assert.deepEqual(
    siteEdits.map((edit) => [edit.op, edit.user?.name, edit.editor?.name ?? null]),
    [
      ['add', 'alice', 'mallory'],
      ['set', 'alice', null],
    ],
  );
  assert.ok(siteEdits.every((edit) => edit.user.id && !JSON.stringify(edit).includes('@')));
  assert.deepEqual(
    siteEdits.map((edit) => [edit.op, edit.itemId === 'item-1', edit.fields, edit.baseRevision]),
    [
      ['add', false, { text: '현장 사진 정리·업로드', date: '2026-10-08' }, null],
      ['set', true, { done: true, date: null }, 3],
    ],
  );
  // The PC uploads its list with the edits applied; nothing waits any more.
  assert.equal(
    await pc.uploadSummary(project.id, 'agenda', [
      { ...pcItem, date: null, time: null, doneAt: '2026-10-06T01:00:00.000Z', revision: 4 },
      {
        ...pcItem,
        id: 'item-2',
        text: '현장 사진 정리·업로드',
        kind: 'task',
        time: null,
        date: '2026-10-08',
        order: 2,
        revision: 1,
        // The PC keeps the accounts as recorded; the site shows the account's current ID.
        createdBy: { id: aliceId, name: 'alice-old' },
        updatedBy: { id: null, name: 'mallory' },
      },
    ]),
    undefined,
  );
  view = (await api('/agenda', { cookie: alice.cookie })).value;
  assert.equal(view.pending, 0);
  assert.deepEqual(
    view.items.map((item) => [item.createdBy, item.updatedBy]),
    [
      [null, null],
      [
        { id: aliceId, name: 'alice' },
        { id: null, name: 'mallory' },
      ],
    ],
  );
  assert.deepEqual(
    view.items.map((item) => [item.id, item.done, item.pending]),
    [
      ['item-1', true, false],
      ['item-2', false, false],
    ],
  );
  await pc.heartbeat();
  assert.equal(siteEdits.length, 2, 'delivered once');
  // PLAN-39: the period, 위치, 참석자 and 접수 travel with the copy; a waiting date change on the
  // site keeps the period (as the PC will).
  const period = {
    ...pcItem,
    id: 'item-3',
    text: '허가 서류 접수',
    kind: 'receipt',
    date: '2026-10-07',
    endDate: '2026-10-09',
    time: '14:00',
    endTime: '16:00',
    location: '구청 민원실',
    attendees: '김 대리, 설비 업체',
    order: 3,
    revision: 1,
  };
  assert.equal(await pc.uploadSummary(project.id, 'agenda', [period]), undefined);
  const shared = (await api('/agenda', { cookie: alice.cookie })).value.items[0];
  assert.deepEqual(
    [shared.kind, shared.endDate, shared.endTime, shared.location, shared.attendees],
    ['receipt', '2026-10-09', '16:00', '구청 민원실', '김 대리, 설비 업체'],
  );
  assert.equal(
    (
      await api('/agenda/item-3', {
        method: 'PATCH',
        cookie: alice.cookie,
        data: { date: '2026-10-12', revision: 1 },
      })
    ).status,
    200,
  );
  const shifted = (await api('/agenda', { cookie: alice.cookie })).value.items[0];
  assert.deepEqual(
    [shifted.date, shifted.endDate, shifted.pending],
    ['2026-10-12', '2026-10-14', true],
  );
  assert.equal(
    (
      await api('/agenda/item-3', {
        method: 'PATCH',
        cookie: alice.cookie,
        data: { location: 'x'.repeat(201) },
      })
    ).status,
    400,
  );
  // Sharing turned off on the PC: the copy and the summary leave the site.
  assert.equal(await pc.deleteSummary(project.id), true);
  assert.equal((await api('/agenda', { cookie: alice.cookie })).value.sharedAt, null);
  assert.deepEqual((await api('/history', { cookie: alice.cookie })).value.items, []);

  let browser = false;
  if (process.argv.includes('--browser')) {
    // A drawing-like file: a grid of lines, a slab and labels, then the PC goes off.
    const scene = [];
    for (let i = 0; i <= 10; i++) {
      scene.push({
        id: 'x' + i,
        segments: [200000 + i * 6, 500000, 0, 200000 + i * 6, 500048, 0],
        layer64: b64('A-GRID'),
        colorIndex: 1,
      });
      scene.push({
        id: 't' + i,
        texts: [{ s: 'X' + (i + 1), p: [200000 + i * 6, 500050, 0], h: 1.2, r: 0 }],
        layer64: b64('A-ANNO'),
        colorIndex: 7,
      });
    }
    for (let j = 0; j <= 8; j++)
      scene.push({
        id: 'y' + j,
        segments: [200000, 500000 + j * 6, 0, 200060, 500000 + j * 6, 0],
        layer64: b64('A-GRID'),
        colorIndex: 1,
      });
    scene.push({
      id: 'slab',
      vertices: [200006, 500006, 0, 200030, 500006, 0, 200030, 500030, 0, 200006, 500030, 0],
      indices: [0, 1, 2, 0, 2, 3],
      layer64: b64('S-SLAB'),
      displayColor: '#9fb7c9',
    });
    const drawing = packSnapshot(
      buildSnapshot(
        { scene, sourceDocument: { capturedAt: new Date().toISOString() } },
        { name: 'plan.dwg', host: 'zwcad' },
      ),
    );
    const drawingLink = randomUUID();
    assert.equal(
      await pc.uploadSnapshot(
        project.id,
        drawingLink,
        { name: 'plan.dwg', host: 'zwcad', objects: scene.length, capturedAt: Date.now() },
        drawing,
      ),
      undefined,
    );
    // 할 일 shared again for the page below (PLAN-33).
    assert.equal(await pc.uploadSummary(project.id, 'agenda', [pcItem]), undefined);
    await pc.close();
    const { chromium } = await import('playwright');
    const chrome = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await chrome.newPage({ viewport: { width: 1280, height: 820 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      await page.goto(origin);
      await page.getByLabel('아이디').fill('alice');
      await page.locator('input[autocomplete="current-password"]').fill(alice.password);
      await page.getByRole('button', { name: '로그인', exact: true }).click();
      // The PC is off: opening the project shows the saved model instead of an error.
      await page.getByRole('button', { name: 'Tower 열기' }).click();
      await page.getByText('plan.dwg · 객체 32개').waitFor();
      // PLAN-33: the banner, 할 일 (editable, waiting for the PC) and the history summary.
      await page.getByText('PC가 꺼져 있어 지금 모델은 보이지 않습니다').waitFor();
      await page.getByRole('button', { name: '협의구조 검토 회의' }).waitFor();
      await page.getByLabel('새 할 일', { exact: true }).fill('도면 번호 정리');
      await page.getByRole('button', { name: '추가', exact: true }).click();
      await page.getByText('PC 반영 대기').first().waitFor();
      // A 협의 has no done check (PLAN-39); a 할 일 has.
      assert.equal(await page.getByLabel('구조 검토 회의 완료').count(), 0);
      await page.getByLabel('도면 번호 정리 완료').check();
      await page.getByText('작업 PC가 아직 작업 이력 요약을 올리지 않았습니다.').waitFor();
      await page.locator('[data-testid="offline-canvas"] canvas').first().waitFor();
      await page.waitForTimeout(500);
      if (process.env.VIDE_SHOT) await page.screenshot({ path: process.env.VIDE_SHOT });
      await page.getByLabel('요청 내용').fill('X3열 보를 H-400으로 바꿔줘');
      await page.getByLabel('대상 파일').selectOption({ label: 'plan.dwg' });
      await page.getByRole('button', { name: '요청 남기기' }).click();
      await page.getByText('PC 대기 중').waitFor();
      await page.getByText('작업 PC가 켜지면').waitFor();
      await page.getByRole('button', { name: '취소' }).click();
      await page.getByText('취소됨').waitFor();
      // Layers can be turned off without reloading the model.
      await page.getByText('레이어 3').click();
      await page.getByLabel('A-ANNO').uncheck();
      assert.deepEqual(errors, []);
      browser = true;
    } finally {
      await chrome.close();
    }
  }
  await pc.close?.();
  console.log(
    JSON.stringify({
      passed: true,
      snapshots: true,
      quota: true,
      uploadPause: true,
      membersOnly: true,
      queue: true,
      offlineProject: true,
      browser,
    }),
  );
} finally {
  await mf.dispose();
  bridge.close();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
