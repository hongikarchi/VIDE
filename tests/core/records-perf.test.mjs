// PLAN-53 T-337 (ARCH-01 §5 「성능 측정」 1·7·8): 프로젝트 기록 at size — 5,000 records (1,000 pointing at
// requests), 30 parts mapped onto a linked file's layers, a document Sync of 20,000 objects on 30
// layers, 2,000 requests with change lists. Each step is timed (one warm-up, five runs, median)
// and printed; the bounds asserted are loose against machine load, the criteria are reported in
// VERIFY-2026-10-15-records-wave-3. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { startServer } from '../../src/server/server.ts';
import { Records } from '../../src/core/records.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { captureInput } from '../../src/server/import-model.ts';
import { partsStatusOf } from '../../src/server/parts-status.ts';
import { objectRecordsOf } from '../../src/server/object-records.ts';
import { requestUndone } from '../../src/server/records-routes.ts';

const RECORDS = 5000,
  PARTS = 30,
  OBJECTS = 20_000,
  REQUESTS = 2000;
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const layerName = (i) => `구조::부위 ${i + 1}`;

async function median(label, criterion, run) {
  await run();
  const times = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await run(i);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const value = times[2];
  console.log(
    `[T-337] ${label}: median ${value.toFixed(1)} ms (criterion ≤${criterion} ms; runs ${times
      .map((v) => v.toFixed(1))
      .join(', ')})`,
  );
  return value;
}

test('records at size: list API, parts status, an object’s records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-records-perf-'));
  const app = await startServer({ filename: join(directory, 'store.sqlite') });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = app.store;
  const project = store.createProject('기록 성능');
  const projectId = project.id;
  const workspace = new Workspace(store);
  const links = new DocumentLinks(store);
  const link = links.link(projectId, {
    host: 'rhino',
    name: 'tower.3dm',
    path: 'C:/work/tower.3dm',
    instance: '1:1',
    documentId: 1,
  });

  // A document Sync of 20,000 objects on 30 layers.
  let start = performance.now();
  const target = { id: 'sync-1', instance: '1:1', documentId: 1, linkId: link.id };
  workspace.submit(projectId, captureInput(target));
  const scene = Array.from({ length: OBJECTS }, (_, i) => ({
    id: `obj-${i}`,
    nativeId: `obj-${i}`,
    nativeType: 'Brep',
    geometryHash: `h-${i}`,
    layer64: b64(layerName(i % PARTS)),
    vertices: [i, 0, 0, i + 1, 0, 0, i, 1, 0],
    indices: [0, 1, 2],
    line: [],
    valid: true,
  }));
  workspace.update(projectId, 'sync-1', 'succeeded', {
    hostExecuted: true,
    displayOnly: true,
    executionMode: 'sdk',
    host: 'rhino',
    objects: scene.map((item) => ({
      id: item.id,
      nativeId: item.id,
      kind: 'native',
      name: item.id,
    })),
    scene,
    sourceDocument: { ...target, connection: 'attached-editor', documentHash: 'd', revision: 1 },
  });
  t.diagnostic(`fixture Sync ${(performance.now() - start).toFixed(0)} ms`);

  // 2,000 requests that changed objects (two each), with an empty execution list.
  start = performance.now();
  const db = store.db(projectId);
  const insert = db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < REQUESTS; i++) {
    const id = `req-${i}`;
    insert.run(
      id,
      projectId,
      JSON.stringify({
        id,
        body: `합성 요청 ${i}`,
        pins: [],
        sketches: [],
        files: [],
        provider: 'codex-cli',
        model: 'codex-cli',
        effort: 'default',
        permission: 'review',
        host: 'rhino',
        linkId: link.id,
      }),
      'succeeded',
      JSON.stringify({
        hostExecuted: true,
        host: 'rhino',
        changes: {
          added: [],
          removed: [],
          modified: [`obj-${i % OBJECTS}`, `obj-${(i * 7) % OBJECTS}`].map((oid) => ({
            id: oid,
            geometry: true,
            attributes: false,
            nativeIdentity: false,
          })),
        },
        executions: [],
      }),
      new Date(Date.UTC(2025, 0, 1) + i * 3_600_000).toISOString(),
    );
  }
  db.exec('COMMIT');

  // 30 parts on the file's layers, six chapters, 5,000 kept records (1,000 pointing at requests).
  const records = new Records(store);
  const parts = Array.from({ length: PARTS }, (_, i) =>
    records.addPart(projectId, {
      name: `부위 ${i + 1}`,
      grp: i % 2 ? '기존' : '신설',
      mapping: [{ kind: 'layer', linkId: link.id, layer: layerName(i) }],
    }),
  );
  const day = (i) =>
    new Date(Date.UTC(2024, 0, 1) + (i % 700) * 86_400_000).toISOString().slice(0, 10);
  records.addMany(
    projectId,
    Array.from({ length: RECORDS }, (_, i) => ({
      input: {
        date: day(i),
        type: 'RIKED'[i % 5],
        text: `합성 기록 ${i}: 외벽 마감과 창호 간격을 다시 맞춘다`,
        parts: [parts[i % PARTS].id],
        chapter: `장 ${(i % 6) + 1}`,
        ...(i % 5 === 0 ? { attachments: { requestId: `req-${(i / 5) % REQUESTS}` } } : {}),
      },
      sourceKey: `perf:${i}`,
    })),
    { by: '설계자', state: 'kept', source: 'note' },
  );
  t.diagnostic(`fixture requests+records ${(performance.now() - start).toFixed(0)} ms`);

  // 1. GET /records over HTTP (the engine's own Records, with the undone check).
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const headers = { Origin: app.origin, Cookie: login.headers.get('set-cookie').split(';')[0] };
  const list = async (query = '') => {
    const response = await fetch(`${app.origin}/api/v1/projects/${projectId}/records${query}`, {
      headers,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.records.length, RECORDS);
    return body;
  };
  const all = await median('GET /records 5,000 (no filter)', 500, () => list());
  const kept = await median('GET /records 5,000 (state=kept)', 500, () => list('?state=kept'));

  // 7. parts/status: 30 parts against the Sync's 30 layers.
  const status = partsStatusOf({ store, workspace, records: new Records(store) });
  const parts7 = await median('parts/status, 30 parts · 20,000 objects', 500, async () => {
    const { parts: rows } = await status(projectId);
    assert.equal(rows.length, PARTS);
    assert.ok(rows.every((row) => row.broken.length === 0));
  });

  // 8. An object's records: first (index built), then again within 15 s (index kept).
  let clock = 0;
  const objectRecords = objectRecordsOf({
    store,
    workspace,
    records: new Records(store, { undoneResolver: requestUndone(store) }),
    now: () => clock,
  });
  const first = await median("'이 객체의 기록' first (index built)", 500, async () => {
    clock += 60_000;
    const reply = await objectRecords(projectId, 'obj-7', link.id);
    assert.ok(reply.records.length > 0);
  });
  const again = await median("'이 객체의 기록' again (index kept)", 100, async () => {
    const reply = await objectRecords(projectId, 'obj-7', link.id);
    assert.ok(reply.records.length > 0);
  });

  console.log(
    JSON.stringify({
      listAll: all,
      listKept: kept,
      partsStatus: parts7,
      objectFirst: first,
      objectAgain: again,
    }),
  );
  // Loose bounds (twice the criteria) so a loaded machine does not fail the suite.
  assert.ok(all < 1000 && kept < 1000, `${all} / ${kept} ms`);
  assert.ok(parts7 < 1000, `${parts7} ms`);
  assert.ok(first < 1000 && again < 200, `${first} / ${again} ms`);
});
