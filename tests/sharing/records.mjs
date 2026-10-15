// PLAN-53 T-336 (SPEC-17.6, ARCH-01 §5 「사이트 사본」): the 거른 기록 copy on the account site. Only the
// PC that runs the project (its owner's device) replaces it, in parts (`first` starts over); only
// the seven fields are kept; `DELETE …/records` empties it and leaves the 할 일 copy, and turning the
// 할 일 copy off leaves the records; a project deleted on the site takes its rows along.
// Run: node tests/sharing/records.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const root = fileURLToPath(new URL('../../src/sharing/', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { Miniflare, Log, LogLevel } = require('miniflare'),
  { build } = require('esbuild');
const directory = await mkdtemp(join(tmpdir(), 'vide-sharing-records-'));
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
const origin = 'http://127.0.0.1:8796';
const mf = new Miniflare({
  resourcePersistencePath: join(directory, 'state'),
  telemetry: { enabled: false },
  log: new Log(LogLevel.NONE),
  workers: [
    {
      config: {
        name: 'vide-sharing-records-test',
        compatibilityDate: '2026-09-22',
        compatibilityFlags: ['nodejs_compat'],
        manifest: {
          mainModule: 'worker.js',
          modules: { 'worker.js': { type: 'esm', contents: bundled.outputFiles[0].text } },
        },
        env: {
          DB: { type: 'd1', id: 'test-db', dev: { remote: false } },
          ASSETS: { type: 'r2', name: 'test-assets', dev: { remote: false } },
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
const call = async (path, { method = 'GET', data, headers = {} } = {}) => {
  const response = await mf.dispatchFetch(origin + path, {
    method,
    redirect: 'manual',
    headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { status: response.status, value };
};

try {
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(join(root, 'migrations'))).sort()) {
    const sql = (await readFile(join(root, 'migrations', name), 'utf8')).replace(/^--.*$/gm, '');
    for (const statement of sql.split(';').filter((v) => v.trim()))
      await db.prepare(statement).run();
  }
  const passwords = {};
  let address = 10;
  const account = async (username) => {
    passwords[username] = randomBytes(20).toString('hex');
    const up = await call('/api/account/sign-up', {
      method: 'POST',
      headers: { Origin: origin },
      data: { username, password: passwords[username], code: 'test-code' },
    });
    assert.equal(up.status, 201, JSON.stringify(up.value));
  };
  const device = async (username, name) => {
    const login = await call('/api/hosts/device/login', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': `192.0.2.${++address}` },
      data: { name, username, password: passwords[username] },
    });
    assert.equal(login.status, 201, JSON.stringify(login.value));
    return `${login.value.hostId}.${login.value.secret}`;
  };
  await account('eve');
  await account('mallory');
  const evePc = await device('eve', '설계실 PC'),
    eveLaptop = await device('eve', '노트북'),
    malloryPc = await device('mallory', 'M PC');
  const auth = (key) => ({ Authorization: `Bearer ${key}` });
  const project = 'project-records-0001';
  assert.equal(
    (
      await call('/api/hosts/device/projects', {
        method: 'POST',
        headers: auth(evePc),
        data: { id: project, name: '기록 공유' },
      })
    ).status,
    201,
  );
  const path = `/api/hosts/device/projects/${project}/records`;
  const put = (key, data) => call(path, { method: 'PUT', headers: auth(key), data });
  const record = (i, extra = {}) => ({
    id: `rec-${i}`,
    date: '2026-03-0' + ((i % 9) + 1),
    type: 'RIKED'[i % 5],
    text: `합성 기록 ${i}`,
    parts: ['1층 벽'],
    chapter: i % 2 ? '기본설계' : null,
    updatedAt: '2026-10-15T00:00:00.000Z',
    ...extra,
  });
  const rows = () =>
    db
      .prepare('SELECT * FROM project_records WHERE project_id=? ORDER BY record_id')
      .bind(project)
      .all()
      .then((r) => r.results);

  // --- who may write ---
  assert.equal((await call(path, { method: 'PUT', data: { items: [] } })).status, 401);
  assert.equal((await put(malloryPc, { items: [record(1)], first: true })).status, 404);
  assert.equal(
    (await put(eveLaptop, { items: [record(1)], first: true })).status,
    404,
    "only the PC that runs the project, not the owner's other PC",
  );
  assert.equal((await rows()).length, 0);

  // --- replace, in parts ---
  const stored = await put(evePc, {
    items: [
      record(1, { source: 'kakao', attachments: { mail: { from: 'x' } }, by: '설계자' }),
      record(2),
    ],
    first: true,
  });
  assert.equal(stored.status, 200, JSON.stringify(stored.value));
  assert.deepEqual(stored.value, { stored: 2 });
  let saved = await rows();
  assert.deepEqual(Object.keys(saved[0]).sort(), [
    'chapter',
    'date',
    'parts',
    'project_id',
    'record_id',
    'text',
    'type',
    'updated_at',
  ]);
  assert.ok(!JSON.stringify(saved).includes('kakao') && !JSON.stringify(saved).includes('설계자'));
  assert.deepEqual(JSON.parse(saved[0].parts), ['1층 벽']);
  assert.equal(saved[0].chapter, '기본설계');
  assert.equal(saved[1].chapter, null);
  const summary = () =>
    db.prepare('SELECT * FROM project_summaries WHERE project_id=?').bind(project).first();
  assert.ok((await summary()).records_at > 0);

  // A second part adds; a new first part starts over (a record dropped on the PC leaves).
  assert.equal((await put(evePc, { items: [record(3)], first: false })).status, 200);
  assert.deepEqual(
    (await rows()).map((r) => r.record_id),
    ['rec-1', 'rec-2', 'rec-3'],
  );
  assert.equal((await put(evePc, { items: [record(2), record(4)], first: true })).status, 200);
  assert.deepEqual(
    (await rows()).map((r) => r.record_id),
    ['rec-2', 'rec-4'],
  );
  // 500 records in one part (one statement, not one per record).
  const many = Array.from({ length: 500 }, (_, i) => record(100 + i));
  assert.equal((await put(evePc, { items: many, first: true })).status, 200);
  assert.equal((await rows()).length, 500);
  assert.equal((await put(evePc, { items: [...many, record(9)], first: true })).status, 400);
  // Refused items change nothing.
  for (const bad of [
    record(5, { type: 'X' }),
    record(5, { date: '2026-02-30' }),
    record(5, { id: 'a b' }),
    record(5, { text: ' ' }),
    record(5, { text: '가'.repeat(20_001) }),
    record(5, { parts: 'wall' }),
    record(5, { parts: Array.from({ length: 51 }, (_, i) => `p${i}`) }),
    record(5, { chapter: 'x'.repeat(101) }),
  ])
    assert.equal(
      (await put(evePc, { items: [bad], first: true })).status,
      400,
      JSON.stringify(bad).slice(0, 80),
    );
  assert.equal((await put(evePc, { items: [], first: 'yes' })).status, 400);
  assert.equal((await rows()).length, 500);

  // --- 할 일 off keeps the records; records off keeps the 할 일 ---
  assert.equal(
    (
      await call(`/api/hosts/device/projects/${project}/agenda`, {
        method: 'PUT',
        headers: auth(evePc),
        data: { items: [] },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/api/hosts/device/projects/${project}/summary`, {
        method: 'DELETE',
        headers: auth(evePc),
      })
    ).status,
    200,
  );
  assert.equal((await rows()).length, 500, 'the 할 일 switch leaves the records');
  const after = await summary();
  assert.ok(after.records_at > 0);
  assert.equal(after.agenda_at, null);
  assert.equal((await call(path, { method: 'DELETE', headers: auth(malloryPc) })).status, 404);
  const removed = await call(path, { method: 'DELETE', headers: auth(evePc) });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.value, { removed: true });
  assert.equal((await rows()).length, 0);
  assert.equal((await summary()).records_at, null);
  assert.equal((await call(path, { method: 'GET', headers: auth(evePc) })).status, 405);

  // --- a project deleted on the site takes its rows ---
  assert.equal((await put(evePc, { items: [record(7)], first: true })).status, 200);
  await db.prepare('DELETE FROM projects WHERE id=?').bind(project).run();
  assert.equal((await rows()).length, 0, 'ON DELETE CASCADE');

  console.log(
    JSON.stringify({
      ownerPcOnly: true,
      replaceInParts: true,
      sevenFieldsOnly: true,
      refusesBadItems: true,
      separateFromAgenda: true,
      deleteEmpties: true,
      cascade: true,
    }),
  );
} finally {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
