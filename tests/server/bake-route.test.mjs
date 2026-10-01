import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { Execution } from '../../src/server/execution.ts';
import { documentHolder } from '../../src/contracts/request-scope.ts';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { closeJigRuntime, jigRoutes } from '../../src/server/jig-routes.ts';
import { importPack, packJig } from '../../src/jigs/runtime/pack.ts';
import { decodeDataBlock } from '../../src/jigs/bake/data-block.ts';
import { bakeJobOf, pendingBakeJobs } from '../../src/jigs/bake/bake.ts';

// T-055 (PLAN-22): the bake route with a fake Rhino — forced read before every bake, gates,
// the jig-bake request that runs the fixed bodies without a provider, the bake record, the
// baseline read after application, replacement by recorded GUIDs and fingerprints only, and the
// protections: hidden target, pending baseline, stale work copy, missing job. No host, no user data.

const EXAMPLE = join(import.meta.dirname, '..', '..', 'extensions', 'jigs', 'example-grid');
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const ROOT = 'VIDE::격자';
const COLUMN_LAYER = `${ROOT}::jig 기둥`;
const BEAM_LAYER = `${ROOT}::jig 보`;
const INSTANCE = '100:200:' + randomUUID();
const DOCUMENT = 7;

/** A jig with two bake declarations: column marks as text dots, beams as curves. */
function bakeJig(root) {
  const dir = join(root, 'jigs', 'bake-test');
  cpSync(EXAMPLE, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'jig.json'), 'utf8'));
  manifest.id = 'project/bake-test';
  manifest.capabilities.push({ name: 'host.bake', reason: '기둥 부호와 보 선을 Rhino에 만듭니다' });
  manifest.bake = [
    {
      id: 'columns',
      template: 'vide.bake.textdot@1',
      host: 'rhino',
      items: 'step.grid.columns',
      layer: 'jig 기둥',
      key: 'key',
      map: { point: 'at', text: 'mark' },
      attrs: { 'vide-mark': 'mark' },
      mode: 'replace-own',
    },
    {
      id: 'beams',
      template: 'vide.bake.curves@1',
      host: 'rhino',
      items: 'step.beams.beams',
      layer: 'jig 보',
      key: 'key',
      map: { curve: 'line' },
      mode: 'replace-own',
    },
  ];
  writeFileSync(join(dir, 'jig.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

/** The fake linked document: rows and layers the fake `readLayers` returns, edited by the test. */
function fakeDocument() {
  const doc = {
    revision: 1,
    rows: new Map(),
    layers: new Map([
      ['VIDE', { visible: true, locked: false }],
      [ROOT, { visible: true, locked: false }],
      ['슬래브 외곽', { visible: true, locked: false }],
      ['기존::숨김', { visible: false, locked: false }],
    ]),
  };
  const add = (nativeId, layer, hash, tags = {}, line = [0, 0, 0, 1, 0, 0]) => {
    doc.rows.set(nativeId, { nativeId, layer, hash, tags, line });
    return nativeId;
  };
  add(
    randomUUID(),
    '슬래브 외곽',
    'outline',
    {},
    [0, 0, 0, 30, 0, 0, 30, 20, 0, 0, 20, 0, 0, 0, 0],
  );
  const model = (scope = {}) => {
    const rows = [...doc.rows.values()].filter(
      (row) =>
        (!scope.layers || scope.layers.includes(row.layer)) &&
        (scope.includeHidden || doc.layers.get(row.layer)?.visible !== false),
    );
    return {
      objects: rows.map((row) => ({
        id: row.nativeId,
        nativeId: row.nativeId,
        kind: 'native',
        name: 'o',
        origin: [0, 0, 0],
      })),
      scene: rows.map((row) => ({
        id: row.nativeId,
        nativeId: row.nativeId,
        layer64: b64(row.layer),
        geometryHash: row.hash,
        attributes64: Object.entries(row.tags).map(([k, v]) => [b64(k), b64(v)]),
        line: row.line,
      })),
      layers: [...doc.layers].map(([fullPath, state], order) => ({
        id: randomUUID(),
        parentId: null,
        fullPath,
        ...state,
        color: '#000000',
        order,
        objectCount: rows.filter((r) => r.layer === fullPath).length,
      })),
      sourceDocument: {
        connection: 'attached-editor',
        instance: INSTANCE,
        documentId: DOCUMENT,
        documentHash: `rev-${doc.revision}`,
        revision: doc.revision,
        name: 'synthetic.3dm',
        units: 'Meters',
        capturedAt: new Date().toISOString(),
      },
    };
  };
  return { doc, add, model };
}

/**
 * The fake attached Rhino of the direct path (바로 적용): `direct-execute` decodes the body's data
 * block and acts like the template (deletes only listed GUIDs with this instance's and bake's tags,
 * adds tagged objects), inside an undo record the fake `direct-undo` reverts while it is the latest.
 * `direct.rogue` deletes one more object the body never listed, as a faulty body would (only on
 * the `rogueAt`-th `direct-execute` call when set); `hostGuard: false` is a host without its own
 * deletion count.
 */
function fakeDirect(document, calls, options) {
  const stack = [];
  const direct = {
    stack,
    fingerprint: async () => ({
      documentHash: `rev-${document.doc.revision}`,
      revision: document.doc.revision,
    }),
    execute: async (target, command) => {
      assert.equal(target.instance, INSTANCE);
      assert.equal(target.documentId, DOCUMENT);
      calls.direct.push(command);
      if (options.failAt === calls.direct.length) return { ok: false, reason: 'EXCEPTION' };
      if (options.refuseAt === calls.direct.length)
        throw Object.assign(new Error(options.refuse), { code: options.refuse });
      const block = decodeDataBlock(Buffer.from(command.code.split('"')[1], 'base64'));
      const { header } = block;
      const removed = [];
      for (const id of header.deleteIds) {
        const row = document.doc.rows.get(id);
        if (
          !row ||
          row.tags['vide-instance'] !== header.instanceId ||
          row.tags['vide-bake'] !== header.bakeId
        )
          continue;
        document.doc.rows.delete(id);
        removed.push(row);
      }
      const rogue = direct.rogue;
      if (
        rogue &&
        document.doc.rows.has(rogue) &&
        (!direct.rogueAt || direct.rogueAt === calls.direct.length)
      ) {
        removed.push(document.doc.rows.get(rogue));
        document.doc.rows.delete(rogue);
      }
      const added = [];
      for (const item of block.items) {
        const nativeId = randomUUID();
        document.add(nativeId, header.layerPath, `hash:${item.key}`, {
          'vide-jig': header.jigId,
          'vide-instance': header.instanceId,
          'vide-run': header.runId,
          'vide-bake': header.bakeId,
          'vide-key': item.key,
          ...Object.fromEntries(item.attrs),
        });
        added.push({ key: item.key, nativeId });
      }
      document.doc.revision++;
      const revert = () => {
        for (const { nativeId } of added) document.doc.rows.delete(nativeId);
        for (const row of removed) document.doc.rows.set(row.nativeId, row);
        document.doc.revision++;
      };
      // The host guard: more deletions than allowed, unconfirmed, undoes the record at once.
      if (
        direct.hostGuard !== false &&
        removed.length > command.guard.maxDeletes &&
        !command.guard.confirmed
      ) {
        revert();
        return {
          ok: false,
          guarded: { kind: 'bulk-delete', detail: `${removed.length}개 삭제` },
        };
      }
      const undoId = randomUUID();
      stack.push({ undoId, revert });
      direct.afterExecute?.();
      return {
        ok: true,
        undoId,
        changes: {
          added: added.map(({ nativeId }) => ({ nativeId, hash: '', layer: header.layerPath })),
          changed: [],
          removed: removed.map((row) => ({ nativeId: row.nativeId, layer: row.layer })),
        },
        value: {
          removed: removed.length,
          keys: added.map((a) => a.key),
          ids: added.map((a) => a.nativeId),
          failed: [],
        },
        log: [],
      };
    },
    undo: async (target, undoId) => {
      calls.undo.push(undoId);
      if (stack.at(-1)?.undoId !== undoId) return { ok: false, reason: 'not-latest' };
      stack.pop().revert();
      return { ok: true };
    },
    /** Someone did something else in Rhino after the bake. */
    other: () => stack.push({ undoId: randomUUID(), revert: () => {} }),
  };
  return direct;
}

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vide-bake-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(root, 'workspace.sqlite'));
  const workspace = new Workspace(store);
  const jigStore = new JigStore(store.db);
  const links = new DocumentLinks(store.db);
  const project = store.createProject('만들기 시험');
  const document = fakeDocument();
  const calls = { reads: [], fixed: [], direct: [], undo: [] };
  let readFailure;
  const sdk = {
    readLayers: async (target, scope) => {
      if (readFailure) {
        const error = readFailure;
        readFailure = undefined;
        throw error;
      }
      assert.equal(target.instance, INSTANCE);
      calls.reads.push(scope);
      return document.model(scope);
    },
    importFile: async () => assert.fail('a host link never imports'),
    /** The fake work copy: decodes each body's data block and answers like the template would. */
    runFixed: async ({ codes, expectedDocumentHash, previous }) => {
      calls.fixed.push({ codes, expectedDocumentHash, previous: previous?.id });
      const values = codes.map((code) => {
        const block = decodeDataBlock(Buffer.from(code.split('"')[1], 'base64'));
        return {
          removed: block.header.deleteIds.length,
          keys: block.items.map((item) => item.key),
          ids: block.items.map(() => randomUUID()),
          failed: [],
        };
      });
      return {
        values,
        objects: [],
        scene: [],
        changes: { added: [], removed: [], modified: [] },
        filename: join(root, 'candidate.3dm'),
        fileHash: 'a'.repeat(64),
        verified: true,
        hostExecuted: true,
        host: 'rhino',
        executionMode: 'sdk',
        sourceDocument: document.model().sourceDocument,
      };
    },
  };
  const execution = new Execution(workspace, { sdk });
  const direct = options.direct ? fakeDirect(document, calls, options) : undefined;
  let last;
  const call = async (method, path, payload) => {
    last = undefined;
    const request = Object.assign(Readable.from([]), { method, headers: {} });
    const handled = await jigRoutes(new URL(path, 'http://127.0.0.1'), request, {
      workspace,
      body: async () => payload ?? {},
      send: (status, data) => (last = { status, data }),
      dataDirectory: dataDir,
      links,
      sdk,
      execution,
      ...(direct ? { direct } : {}),
    });
    return handled ? last : { status: 0, data: undefined };
  };
  t.after(async () => {
    await execution.close();
    await closeJigRuntime(workspace);
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return {
    root,
    dataDir,
    store,
    workspace,
    jigStore,
    links,
    project,
    document,
    calls,
    execution,
    direct,
    call,
    failNextRead: (error) => (readFailure = error),
  };
}

/** Pack, install and pin the bake jig; link the fake document; store its Sync; make an instance. */
async function ready(f) {
  const { root, dataDir, jigStore, workspace, links, project, document, call } = f;
  const packed = await packJig(bakeJig(root), { dataDir, bundle: false, skipTests: true });
  await importPack(packed.bytes, { store: jigStore, dataDir });
  const link = links.link(project.id, {
    host: 'rhino',
    name: 'synthetic.3dm',
    instance: INSTANCE,
    documentId: DOCUMENT,
  });
  const sync = {
    id: 'sync-1',
    body: 'Sync',
    permission: 'review',
    provider: 'claude-cli',
    pins: [],
    sketches: [],
    files: [],
    host: 'rhino',
    source: 'document',
    linkId: link.id,
  };
  workspace.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
    sync.id,
    project.id,
    JSON.stringify(sync),
    'succeeded',
    JSON.stringify({
      ...document.model(),
      displayOnly: true,
      hostExecuted: true,
      host: 'rhino',
      executionMode: 'sdk',
    }),
    new Date().toISOString(),
  );
  const base = `/api/v1/projects/${project.id}/jig-instances`;
  const created = await call('POST', base, {
    jig: 'project/bake-test',
    version: '0.1.0',
    title: '만들기 시험 작업본',
    layerRoot: ROOT,
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const iid = created.data.id;
  const read = await call('POST', `${base}/${iid}/reads`, {
    linkId: link.id,
    layers: ['슬래브 외곽'],
    purpose: 'assembly',
  });
  assert.equal(read.data.objectCount, 1);
  await call('PUT', `${base}/${iid}/assembly/${encodeURIComponent('site.outline')}`, {
    sources: [{ readId: read.data.readId, layers: ['슬래브 외곽'] }],
    confirm: true,
  });
  const first = await call('POST', `${base}/${iid}/run`, { mode: 'geometry' });
  assert.equal(first.data.steps[0].status, 'done');
  await call('POST', `${base}/${iid}/steps/confirmInputs/confirm`, {
    inputHash: first.data.steps[1].inputHash,
  });
  const second = await call('POST', `${base}/${iid}/run`, { mode: 'geometry' });
  assert.deepEqual(
    second.data.steps.map((s) => s.status),
    ['done', 'confirmed', 'done', 'done'],
  );
  return {
    base,
    iid,
    link,
    columns: second.data.outputs.grid.columns,
    beams: second.data.outputs.beams.beams,
  };
}

const decodeCodes = (codes) =>
  codes.map((code) => decodeDataBlock(Buffer.from(code.split('"')[1], 'base64')));
const finished = async (f, requestId) => {
  await f.execution.completion(requestId);
  return f.workspace.get(f.project.id, requestId);
};
/** Pretend the person applied the candidate: the tagged objects appear in the fake document. */
function applied(f, iid, result, hashOf = (key) => `hash:${key}`) {
  const made = {};
  for (const bake of result.bake.bakes) {
    const record = f.jigStore.bake(iid, bake.recordId);
    for (const [key, item] of Object.entries(record.items)) {
      if (item.runId !== record.runId) continue;
      f.document.add(item.nativeId, bake.layer, hashOf(key), {
        'vide-jig': 'project/bake-test',
        'vide-instance': iid,
        'vide-bake': bake.bakeId,
        'vide-run': record.runId,
        'vide-key': key,
        ...(bake.bakeId === 'columns' ? { 'vide-mark': key.replace('col:', '') } : {}),
      });
      made[key] = item.nativeId;
    }
  }
  f.document.doc.revision++;
  return made;
}

test('bake (work-copy fallback): forced read, fixed bodies without a provider, record, baseline, then replacement by recorded GUIDs only', async (t) => {
  const f = fixture(t);
  const { base, iid, link, columns, beams } = await ready(f);
  const readsBefore = f.calls.reads.length;

  // 1. First bake: everything is new. A pre-bake read of the whole document, hidden included.
  const bake1 = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns', 'beams'] });
  assert.equal(bake1.status, 200, JSON.stringify(bake1.data));
  assert.equal(bake1.data.status, 'submitted');
  assert.equal(
    bake1.data.notice,
    '파일을 Rhino에서 열어 연결하세요',
    'no attached editor: work copy',
  );
  assert.equal(f.calls.reads.length, readsBefore + 1);
  assert.deepEqual(f.calls.reads.at(-1), { includeHidden: true });
  assert.equal(f.jigStore.reads(iid).at(-1).purpose, 'pre-bake');
  assert.equal(bake1.data.readId, f.jigStore.reads(iid).at(-1).id);
  assert.deepEqual(
    bake1.data.plans.map((p) => [p.bakeId, p.added.length, p.replaced.length]),
    [
      ['columns', columns.length, 0],
      ['beams', beams.length, 0],
    ],
  );
  assert.ok(bake1.data.gates.every((g) => g.ok));
  assert.equal(pendingBakeJobs(), 0, 'the executor took the job at once');
  const request1 = await finished(f, bake1.data.requestId);
  assert.equal(request1.state, 'succeeded', JSON.stringify(request1.result).slice(0, 300));
  assert.equal(request1.input.jig.kind, 'jig-bake');
  assert.equal(request1.input.hostUse, 'write');
  assert.equal(request1.input.baseRequestId, 'sync-1');
  assert.equal(f.calls.fixed.length, 1);
  assert.equal(f.calls.fixed[0].expectedDocumentHash, 'rev-1');
  assert.equal(f.calls.fixed[0].previous, 'sync-1');
  const blocks1 = decodeCodes(f.calls.fixed[0].codes);
  assert.deepEqual(
    blocks1.map((b) => [
      b.header.template,
      b.header.layerPath,
      b.header.deleteIds.length,
      b.items.length,
    ]),
    [
      ['vide.bake.textdot@1', COLUMN_LAYER, 0, columns.length],
      ['vide.bake.curves@1', BEAM_LAYER, 0, beams.length],
    ],
  );
  assert.equal(blocks1[0].header.jigId, 'project/bake-test');
  assert.equal(blocks1[0].header.instanceId, iid);
  assert.equal(blocks1[0].header.runId, bake1.data.runId);
  assert.equal(blocks1[0].items[0].text, columns[0].mark);
  assert.deepEqual(blocks1[0].items[0].attrs, [['vide-mark', columns[0].mark]]);
  const summary = request1.result.bake;
  assert.equal(summary.totals.added, columns.length + beams.length);
  assert.equal(summary.totals.replaced, 0);
  assert.match(
    request1.result.text,
    /^Rhino에 만들기 · 추가 \d+ · 교체 0 · 사람이 고친 것 보존 0 · 복사본 그대로 0 · 사람이 지운 것 0 · 레이어 /,
  );
  const records = (await f.call('GET', `${base}/${iid}/bakes`)).data.bakes;
  assert.equal(records.length, 2);
  assert.ok(
    records.every(
      (r) => r.pendingBaseline && r.appliedAt === null && r.requestId === bake1.data.requestId,
    ),
  );
  const columnRecord = records.find((r) => r.bakeId === 'columns');
  assert.equal(Object.keys(columnRecord.items).length, columns.length);
  assert.ok(
    Object.values(columnRecord.items).every(
      (item) => item.hash === '' && item.state === 'jig' && item.layer === COLUMN_LAYER,
    ),
  );

  // 2. Before application there is nothing to baseline.
  await assert.rejects(f.call('POST', `${base}/${iid}/bakes/${columnRecord.id}/baseline`), {
    code: 'NOT_APPLIED',
  });

  // 3. The person applies the candidate; the baseline read records the fingerprints.
  const made = applied(f, iid, request1.result);
  for (const record of records) {
    const baseline = await f.call('POST', `${base}/${iid}/bakes/${record.id}/baseline`);
    assert.equal(baseline.status, 200, JSON.stringify(baseline.data));
    assert.deepEqual(baseline.data.missing, []);
    assert.ok(baseline.data.record.appliedAt && baseline.data.record.baselineReadId);
  }
  const baselined = f.jigStore.bake(iid, columnRecord.id);
  assert.equal(baselined.items[columns[0].key].hash, `hash:${columns[0].key}`);
  assert.equal(baselined.items[columns[0].key].nativeId, made[columns[0].key]);

  // 4. Human work in Rhino: one column edited, one deleted, one moved to a hidden layer, one copied.
  const [edited, deleted, moved, copied, ...unchanged] = columns.map((c) => c.key);
  f.document.doc.rows.get(made[edited]).hash = 'hash:edited-by-hand';
  f.document.doc.rows.delete(made[deleted]);
  f.document.doc.rows.get(made[moved]).layer = '기존::숨김';
  const copyId = f.document.add(randomUUID(), COLUMN_LAYER, `hash:${copied}`, {
    ...f.document.doc.rows.get(made[copied]).tags,
  });
  f.document.doc.revision++;
  const bake2 = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns'] });
  assert.equal(bake2.status, 200, JSON.stringify(bake2.data));
  const plan2 = bake2.data.plans[0];
  assert.deepEqual(plan2.replaced.sort(), [copied, ...unchanged].sort());
  assert.deepEqual(plan2.added, []);
  assert.deepEqual(
    plan2.preserved.map((p) => [p.key, p.reason]).sort(),
    [
      [edited, 'edited'],
      [moved, 'moved'],
    ].sort(),
  );
  assert.deepEqual(plan2.deleted, [deleted]);
  assert.equal(plan2.copies, 1);
  const request2 = await finished(f, bake2.data.requestId);
  assert.equal(request2.state, 'succeeded');
  const blocks2 = decodeCodes(f.calls.fixed.at(-1).codes);
  assert.equal(blocks2.length, 1);
  assert.deepEqual(
    blocks2[0].header.deleteIds.sort(),
    [copied, ...unchanged].map((key) => made[key]).sort(),
    'only recorded, unchanged objects are deleted',
  );
  assert.ok(!blocks2[0].header.deleteIds.includes(copyId), 'the copy is never deleted');
  assert.ok(!blocks2[0].header.deleteIds.includes(made[edited]));
  assert.ok(!blocks2[0].header.deleteIds.includes(made[moved]));
  assert.deepEqual(
    blocks2[0].items.map((i) => i.key).sort(),
    [copied, ...unchanged].sort(),
    'preserved and deleted keys are not made again',
  );
  assert.equal(f.calls.fixed.at(-1).expectedDocumentHash, 'rev-3');
  assert.equal(
    f.calls.fixed.at(-1).previous,
    'sync-1',
    'the basis is the Sync of the document, never the earlier candidate',
  );
  assert.equal(request2.input.baseRequestId, 'sync-1');
  const record2 = f.jigStore.bake(iid, request2.result.bake.bakes[0].recordId);
  assert.equal(record2.items[edited].state, 'jig', 'an edited object stays recorded');
  assert.equal(record2.items[deleted].state, 'deleted');
  assert.equal(record2.items[moved].nativeId, made[moved]);
  assert.equal(request2.result.bake.totals.preserved, 2);
  assert.equal(request2.result.bake.totals.deleted, 1);
  assert.equal(request2.result.bake.totals.copies, 1);

  // 5. Resolutions. Overwriting the object a person moved to a hidden layer would delete it there:
  // blocked. Keep records the person's choice; absorb records an override and asks for a recompute.
  const overwriteHidden = await f.call('POST', `${base}/${iid}/bake`, {
    bake: ['columns'],
    resolve: { [moved]: 'overwrite' },
  });
  assert.equal(overwriteHidden.status, 422);
  assert.deepEqual(overwriteHidden.data.blocked, ['hidden-target']);
  assert.deepEqual(
    overwriteHidden.data.plans[0].hiddenTargets.map((t) => t.key),
    [moved],
  );
  const keep = await f.call('POST', `${base}/${iid}/bake`, {
    bake: ['columns'],
    resolve: { [edited]: 'keep' },
  });
  assert.equal(keep.status, 200, JSON.stringify(keep.data));
  assert.deepEqual(keep.data.plans[0].kept, [edited]);
  assert.deepEqual(
    keep.data.plans[0].preserved.map((p) => p.key),
    [edited, moved],
  );
  await finished(f, keep.data.requestId);
  const keptRecord = f.jigStore.bake(
    iid,
    f.workspace.get(f.project.id, keep.data.requestId).result.bake.bakes[0].recordId,
  );
  assert.equal(keptRecord.items[edited].state, 'kept');
  const overwrite = await f.call('POST', `${base}/${iid}/bake`, {
    bake: ['columns'],
    resolve: { [edited]: 'overwrite' },
  });
  assert.equal(overwrite.status, 200, JSON.stringify(overwrite.data));
  assert.ok(
    overwrite.data.plans[0].replaced.includes(edited),
    'a kept key comes back only on overwrite',
  );
  await finished(f, overwrite.data.requestId);
  assert.ok(decodeCodes(f.calls.fixed.at(-1).codes)[0].header.deleteIds.includes(made[edited]));
  const absorb = await f.call('POST', `${base}/${iid}/bake`, {
    bake: ['columns'],
    resolve: { [edited]: 'absorb' },
  });
  assert.equal(absorb.data.status, 'absorbed');
  assert.equal(absorb.data.absorbed, 1);
  const view = (await f.call('GET', `${base}/${iid}`)).data;
  assert.equal(view.body.overrides.length, 1);
  assert.equal(view.body.overrides[0].origin, 'host-edit');
  assert.equal(view.status, 'stale');
  await assert.rejects(f.call('POST', `${base}/${iid}/bake`, { bake: ['columns'] }), {
    code: 'BAKE_NOT_COMPUTED',
  });
});

test('bake: a hidden or locked target blocks before anything runs; the person is told to turn the layer on', async (t) => {
  const f = fixture(t);
  const { base, iid } = await ready(f);
  const fixedBefore = f.calls.fixed.length;
  f.document.doc.layers.set(COLUMN_LAYER, { visible: false, locked: false });
  const blocked = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns'] });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.data.code, 'GATE_BLOCKED');
  assert.deepEqual(blocked.data.blocked, ['hidden-target']);
  assert.deepEqual(blocked.data.hints, ['Rhino에서 레이어를 켠 뒤 다시 누르세요']);
  assert.equal(f.calls.fixed.length, fixedBefore, 'no request was submitted');
  assert.equal(
    f.workspace.list(f.project.id).filter((r) => r.input.jig?.kind === 'jig-bake').length,
    0,
  );
  f.document.doc.layers.set(COLUMN_LAYER, { visible: true, locked: false });
  const first = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns'] });
  assert.equal(first.status, 200);
  const result = (await finished(f, first.data.requestId)).result;
  applied(f, iid, result);
  await f.call('POST', `${base}/${iid}/bakes/${result.bake.bakes[0].recordId}/baseline`);
  // A recorded object whose layer is now locked cannot be replaced either.
  f.document.doc.layers.set(COLUMN_LAYER, { visible: true, locked: true });
  const locked = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns'] });
  assert.equal(locked.status, 422);
  assert.ok(locked.data.plans[0].hiddenTargets.length > 0);
  // The parent turned off hides the whole output layer.
  f.document.doc.layers.set(COLUMN_LAYER, { visible: true, locked: false });
  f.document.doc.layers.set(ROOT, { visible: false, locked: false });
  assert.equal((await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns'] })).status, 422);
});

test('bake: a failed baseline read keeps the record unfingerprinted and the next bake preserves those objects', async (t) => {
  const f = fixture(t);
  const { base, iid, columns } = await ready(f);
  const first = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns'] });
  const result = (await finished(f, first.data.requestId)).result;
  const recordId = result.bake.bakes[0].recordId;
  const made = applied(f, iid, result);
  f.failNextRead(Object.assign(new Error('HOST_BUSY'), { code: 'HOST_BUSY' }));
  await assert.rejects(f.call('POST', `${base}/${iid}/bakes/${recordId}/baseline`), {
    code: 'HOST_BUSY',
  });
  const record = f.jigStore.bake(iid, recordId);
  assert.equal(record.appliedAt, null);
  assert.ok(Object.values(record.items).every((item) => item.hash === ''));
  // Applied objects without a baseline are treated like human work: preserved, not replaced.
  const again = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns'] });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  const plan = again.data.plans[0];
  assert.equal(plan.preserved.length, columns.length);
  assert.ok(plan.preserved.every((p) => p.reason === 'pending-baseline'));
  assert.deepEqual(plan.replaced, []);
  assert.deepEqual(plan.added, []);
  await finished(f, again.data.requestId);
  const blocks = decodeCodes(f.calls.fixed.at(-1).codes);
  assert.deepEqual(blocks[0].header.deleteIds, []);
  assert.deepEqual(blocks[0].items, []);
  // The retried baseline succeeds and the following bake replaces normally.
  const retry = await f.call('POST', `${base}/${iid}/bakes/${recordId}/baseline`);
  assert.equal(retry.data.recorded, columns.length);
  const third = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns'] });
  assert.equal(third.data.plans[0].replaced.length, columns.length);
  await finished(f, third.data.requestId);
  assert.deepEqual(
    decodeCodes(f.calls.fixed.at(-1).codes)[0].header.deleteIds.sort(),
    Object.values(made).sort(),
  );
});

test('bake: a jig-bake request without a prepared job fails instead of running anything', async (t) => {
  const f = fixture(t);
  const { link } = await ready(f);
  void link;
  const request = f.workspace.submit(f.project.id, {
    id: 'forged',
    body: 'forged bake',
    permission: 'candidate',
    provider: 'claude-cli',
    pins: [],
    sketches: [],
    files: [],
    host: 'rhino',
    baseRequestId: 'sync-1',
    jig: { kind: 'jig-bake', instanceId: 'x', bakeIds: ['columns'] },
  }).request;
  assert.throws(() => bakeJobOf(request), { code: 'BAKE_JOB_MISSING' });
  f.execution.start(request);
  const done = await finished(f, 'forged');
  assert.equal(done.state, 'failed');
  assert.equal(done.result.code, 'BAKE_JOB_MISSING');
  assert.equal(f.calls.fixed.length, 0);
  assert.equal(bakeJobOf({ id: 'plain', input: {} }), undefined);
});

test('SdkExecution.runFixed runs the bodies in order, refuses a stale work copy and fails on a rejected template', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'vide-bake-sdk-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executed = [];
  let stopped = 0;
  let answer = (code) => ({
    ok: true,
    revision: executed.length,
    operationId: randomUUID(),
    filename: join(directory, 'saved.3dm'),
    fileHash: 'b'.repeat(64),
    snapshot: {
      ok: true,
      revision: executed.length,
      uncertain: false,
      units: 'Meters',
      objects: [],
    },
    readbackVerified: true,
    changes: { added: ['x'], removed: [], modified: [] },
    value: { removed: 0, keys: [code], ids: [], failed: [] },
  });
  const worker = {
    identity: { sessionId: 'owned' },
    query: async () => ({ objects: [] }),
    execute: async (operationId, revision, code) => {
      executed.push({ operationId, revision, code });
      return answer(code);
    },
    exportModel: async () => ({ objects: [], scene: [] }),
    stop: async () => {
      stopped++;
    },
  };
  const launches = [];
  const sdk = new SdkExecution({
    directory,
    executable: 'rhino',
    plugin: 'plugin',
    bootstrap: 'bootstrap',
    origin: () => 'http://127.0.0.1:1',
    tools: {},
    launch: async (options) => {
      launches.push(options);
      return worker;
    },
  });
  const source = join(directory, 'source.3dm');
  writeFileSync(source, 'synthetic');
  const { createHash } = await import('node:crypto');
  const fileHash = createHash('sha256').update('synthetic').digest('hex');
  const capture = {
    filename: source,
    fileHash,
    verified: true,
    sourceDocument: { documentHash: 'rev-9' },
  };
  sdk.captureEditor = async () => capture;
  sdk.editors.inspect = async () => ({ documentHash: 'rev-9' });
  const input = {
    id: 'r',
    body: 'b',
    provider: 'claude-cli',
    permission: 'candidate',
    pins: [],
    sketches: [],
    files: [],
  };
  const previous = {
    id: 'sync',
    result: {
      displayOnly: true,
      sourceDocument: { instance: '1:2', documentId: 3, documentHash: 'rev-9' },
    },
  };
  const updates = [];
  const task = {
    input,
    previous,
    signal: new AbortController().signal,
    update: (u) => updates.push(u),
  };
  await assert.rejects(sdk.runFixed({ ...task, codes: ['a'], expectedDocumentHash: 'rev-8' }), {
    code: 'STALE_INPUT',
  });
  assert.equal(launches.length, 0, 'a stale work copy launches no worker');
  const result = await sdk.runFixed({
    ...task,
    codes: ['first', 'second'],
    expectedDocumentHash: 'rev-9',
  });
  assert.deepEqual(
    executed.map((e) => [e.revision, e.code]),
    [
      [0, 'first'],
      [1, 'second'],
    ],
  );
  assert.deepEqual(
    result.values.map((v) => v.keys[0]),
    ['first', 'second'],
  );
  assert.equal(result.hostExecuted, true);
  assert.equal(result.verified, true);
  assert.equal(result.fileHash, 'b'.repeat(64));
  assert.equal(result.baseRequestId, 'sync');
  assert.equal(stopped, 1);
  assert.ok(updates.some((u) => u.phase === 'host' && u.operationId));
  answer = () => ({
    ok: false,
    code: 'CODE_POLICY_REJECTED',
    revision: 0,
    diagnostics: ['API not permitted: X'],
  });
  await assert.rejects(
    sdk.runFixed({ ...task, codes: ['bad'] }),
    (error) => error.code === 'BAKE_TEMPLATE_REJECTED' && error.diagnostics[0].includes('X'),
  );
  answer = () => ({
    ok: false,
    code: 'HOST_RESULT_UNKNOWN',
    revision: 0,
    diagnosticId: randomUUID(),
    exceptionType: 'System.Exception',
  });
  await assert.rejects(sdk.runFixed({ ...task, codes: ['throws'] }), { code: 'BAKE_FAILED' });
  assert.equal(stopped, 3, 'the worker is stopped after a failure too');
  await assert.rejects(sdk.runFixed({ ...task, codes: [] }), { code: 'INVALID_INPUT' });
});

test('bake: the built-in lines bake, an absorbed edit respected by the next bake, members gated by analysis', async (t) => {
  const f = fixture(t);
  const { base, iid, beams } = await ready(f);
  const LINE_LAYER = `${ROOT}::jig 상단선`;
  const listed = (await f.call('GET', `${base}/${iid}/bakes`)).data;
  assert.deepEqual(
    listed.offers.map((o) => [o.id, o.builtin]),
    [
      ['columns', false],
      ['beams', false],
      ['lines', true],
      ['members', true],
      ['member-columns', true],
    ],
  );
  assert.equal(listed.stale, false);

  // Members need a confirmed analysis of the same inputs; this jig has none.
  const members = await f.call('POST', `${base}/${iid}/bake`, { bake: ['members'] });
  assert.equal(members.status, 422);
  assert.ok(members.data.blocked.includes('analysis-confirmed'));

  const bake1 = await f.call('POST', `${base}/${iid}/bake`, { bake: ['lines'] });
  assert.equal(bake1.status, 200, JSON.stringify(bake1.data));
  const plan1 = bake1.data.plans[0];
  assert.equal(plan1.layer, LINE_LAYER);
  const beamKeys = beams.map((b) => `beam:${b.key}`);
  assert.ok(beamKeys.every((key) => plan1.added.includes(key)));
  const request1 = await finished(f, bake1.data.requestId);
  assert.equal(request1.state, 'succeeded', JSON.stringify(request1.result).slice(0, 300));
  const [block] = decodeCodes(f.calls.fixed.at(-1).codes);
  assert.equal(block.header.template, 'vide.bake.curves@1');
  assert.equal(block.header.bakeId, 'lines');
  const made = applied(f, iid, request1.result);
  const [record] = (await f.call('GET', `${base}/${iid}/bakes`)).data.bakes;
  assert.equal(record.bakeId, 'lines');
  assert.equal((await f.call('POST', `${base}/${iid}/bakes/${record.id}/baseline`)).status, 200);

  // The person edits one line in Rhino and takes the edit as a 수정 사항.
  const [taken, other] = beamKeys;
  f.document.doc.rows.get(made[taken]).hash = 'hash:by-hand';
  f.document.doc.revision++;
  const absorb = await f.call('POST', `${base}/${iid}/bake`, {
    bake: ['lines'],
    resolve: { [taken]: 'absorb' },
  });
  assert.equal(absorb.data.status, 'absorbed');
  assert.deepEqual(absorb.data.plans[0].respected, [taken]);
  const override = (await f.call('GET', `${base}/${iid}`)).data.body.overrides[0];
  assert.deepEqual(override.target.identity, { key: taken, bake: 'lines' });
  // Recompute (the overrides are part of every step's fingerprint), confirming again if asked.
  let run = await f.call('POST', `${base}/${iid}/run`, { mode: 'geometry' });
  if (run.data.steps[1].status !== 'confirmed') {
    await f.call('POST', `${base}/${iid}/steps/confirmInputs/confirm`, {
      inputHash: run.data.steps[1].inputHash,
    });
    run = await f.call('POST', `${base}/${iid}/run`, { mode: 'geometry' });
  }
  assert.ok(run.data.steps.every((s) => s.status === 'done' || s.status === 'confirmed'));

  // The next bake leaves the taken object as it is and replaces the others.
  const bake2 = await f.call('POST', `${base}/${iid}/bake`, { bake: ['lines'] });
  assert.equal(bake2.status, 200, JSON.stringify(bake2.data));
  assert.deepEqual(bake2.data.plans[0].respected, [taken]);
  assert.deepEqual(bake2.data.plans[0].preserved, []);
  assert.ok(bake2.data.plans[0].replaced.includes(other));
  assert.ok(!bake2.data.plans[0].replaced.includes(taken));
  const request2 = await finished(f, bake2.data.requestId);
  assert.equal(request2.state, 'succeeded');
  assert.equal(request2.result.bake.totals.respected, 1);
  const [block2] = decodeCodes(f.calls.fixed.at(-1).codes);
  assert.ok(!block2.header.deleteIds.includes(made[taken]));
  assert.ok(block2.header.deleteIds.includes(made[other]));
  assert.ok(!block2.items.some((i) => i.key === taken));
  const record2 = f.jigStore.bake(iid, request2.result.bake.bakes[0].recordId);
  assert.deepEqual(
    [record2.items[taken].hash, record2.items[taken].state],
    ['hash:by-hand', 'jig'],
  );

  // Edited again: a person's edit again, preserved.
  f.document.doc.rows.get(made[taken]).hash = 'hash:by-hand-2';
  f.document.doc.revision++;
  const bake3 = await f.call('POST', `${base}/${iid}/bake`, { bake: ['lines'] });
  assert.deepEqual(
    bake3.data.plans[0].preserved.map((p) => [p.key, p.reason]),
    [[taken, 'edited']],
  );
  await finished(f, bake3.data.requestId);
});

// 바로 적용 (user decision 2026-09-30): with an attached Rhino the bake runs in the open document,
// one host undo record per body, and the read right after the run is the baseline.
const tagged = (f, runId) =>
  [...f.document.doc.rows.values()].filter((row) => row.tags['vide-run'] === runId);

test('bake (direct): runs in the attached document with undo records, baseline at once, replacement by recorded GUIDs, [되돌리기]', async (t) => {
  const f = fixture(t, { direct: true });
  const { base, iid, columns, beams } = await ready(f);

  // 1. First bake: two bodies, each its own undo record; nothing goes through the work copy.
  const bake1 = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns', 'beams'] });
  assert.equal(bake1.status, 200, JSON.stringify(bake1.data));
  assert.equal(bake1.data.status, 'applied');
  assert.equal(bake1.data.baseline, 'recorded');
  assert.equal(bake1.data.notice, undefined);
  assert.equal(f.calls.fixed.length, 0, 'no work copy');
  assert.equal(
    f.workspace.list(f.project.id).filter((r) => r.input.jig?.kind === 'jig-bake').length,
    0,
    'no candidate request',
  );
  assert.equal(f.calls.direct.length, 2);
  assert.ok(f.calls.direct.every((c) => /^VIDE jig: .+/.test(c.label)));
  assert.deepEqual(
    f.calls.direct.map((c) => c.guard),
    [
      { confirmed: false, maxDeletes: 0 },
      { confirmed: false, maxDeletes: 0 },
    ],
  );
  assert.equal(bake1.data.undoIds.length, 2);
  assert.equal(bake1.data.bake.direct, true);
  assert.equal(bake1.data.bake.totals.added, columns.length + beams.length);
  assert.equal(tagged(f, bake1.data.runId).length, columns.length + beams.length);
  // The baseline read came right after the run: fingerprints and appliedAt without a second step.
  const reads = f.jigStore.reads(iid).filter((r) => r.purpose === 'pre-bake');
  assert.equal(reads.length, 2, 'the forced read and the baseline read');
  let records = (await f.call('GET', `${base}/${iid}/bakes`)).data.bakes;
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.appliedAt && r.baselineReadId && !r.pendingBaseline));
  assert.ok(records.every((r) => r.undoable && !r.undone));
  const column1 = f.jigStore.bake(iid, records.find((r) => r.bakeId === 'columns').id);
  const key0 = columns[0].key;
  assert.equal(column1.items[key0].hash, `hash:${key0}`);
  assert.equal(
    f.document.doc.rows.get(column1.items[key0].nativeId).tags['vide-key'],
    key0,
    'the recorded GUID is the object in the document',
  );
  const made1 = Object.fromEntries(
    Object.entries(column1.items).map(([key, item]) => [key, item.nativeId]),
  );

  // 2. A person edits one column; the next bake deletes only recorded, unchanged objects.
  const [edited] = columns.map((c) => c.key);
  f.document.doc.rows.get(made1[edited]).hash = 'hash:by-hand';
  const untagged = f.document.add(randomUUID(), COLUMN_LAYER, 'mine', {});
  f.document.doc.revision++;
  const bake2 = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns'] });
  assert.equal(bake2.status, 200, JSON.stringify(bake2.data));
  assert.deepEqual(
    bake2.data.plans[0].preserved.map((p) => [p.key, p.reason]),
    [[edited, 'edited']],
  );
  const guard2 = f.calls.direct.at(-1).guard;
  assert.deepEqual(guard2, { confirmed: false, maxDeletes: columns.length - 1 });
  assert.ok(f.document.doc.rows.has(made1[edited]), 'the edited object stays');
  assert.ok(f.document.doc.rows.has(untagged), 'an object no record lists stays');
  assert.equal(tagged(f, bake2.data.runId).length, columns.length - 1);
  assert.equal(tagged(f, bake1.data.runId).filter((r) => r.layer === COLUMN_LAYER).length, 1);
  records = (await f.call('GET', `${base}/${iid}/bakes`)).data.bakes;
  const latest = records.find((r) => r.runId === bake2.data.runId);
  assert.ok(latest.undoable);

  // 3. [되돌리기] while another change is newer in Rhino: refused, nothing undone.
  f.direct.other();
  await assert.rejects(f.call('POST', `${base}/${iid}/bakes/${latest.id}/undo`), {
    code: 'BAKE_UNDO_NOT_LATEST',
  });
  assert.equal(tagged(f, bake2.data.runId).length, columns.length - 1);
  f.direct.stack.pop();

  // 4. [되돌리기] of the last bake: the host undoes it; the earlier objects are back.
  const undone = await f.call('POST', `${base}/${iid}/bakes/${latest.id}/undo`);
  assert.equal(undone.status, 200, JSON.stringify(undone.data));
  assert.deepEqual(undone.data.records, [latest.id]);
  assert.equal(tagged(f, bake2.data.runId).length, 0);
  assert.ok(Object.values(made1).every((id) => f.document.doc.rows.has(id)));
  records = (await f.call('GET', `${base}/${iid}/bakes`)).data.bakes;
  const after = records.find((r) => r.id === latest.id);
  assert.ok(after.undone && !after.undoable && !after.pendingBaseline);
  await assert.rejects(f.call('POST', `${base}/${iid}/bakes/${latest.id}/undo`), {
    code: 'BAKE_UNDO_UNAVAILABLE',
  });

  // 5. The next bake plans from the bake before the undone one again.
  f.document.doc.revision++;
  const bake3 = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns'] });
  assert.equal(bake3.status, 200, JSON.stringify(bake3.data));
  assert.equal(bake3.data.plans[0].replaced.length, columns.length - 1);
  assert.deepEqual(bake3.data.plans[0].deleted, []);
  assert.equal(bake3.data.plans[0].copies, 0);
});

test('bake (direct): a failing body undoes the bodies before it; the document is as it was', async (t) => {
  const f = fixture(t, { direct: true, failAt: 2 });
  const { base, iid } = await ready(f);
  const before = new Map(f.document.doc.rows);
  // The second body fails: the first body's record is undone too.
  const failed = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns', 'beams'] });
  assert.equal(failed.status, 422, JSON.stringify(failed.data));
  assert.equal(failed.data.code, 'BAKE_FAILED');
  assert.equal(f.calls.undo.length, 1);
  assert.deepEqual([...f.document.doc.rows.keys()].sort(), [...before.keys()].sort());
  assert.equal((await f.call('GET', `${base}/${iid}/bakes`)).data.bakes.length, 0);
});

test('bake (direct): a body refused before running (read-only) undoes the ones before it and says why', async (t) => {
  const f = fixture(t, { direct: true, refuseAt: 2, refuse: 'DOCUMENT_READ_ONLY' });
  const { base, iid } = await ready(f);
  const before = new Map(f.document.doc.rows);
  const refused = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns', 'beams'] });
  assert.equal(refused.status, 422, JSON.stringify(refused.data));
  assert.equal(refused.data.code, 'BAKE_FAILED');
  assert.equal(refused.data.reason, 'DOCUMENT_READ_ONLY');
  assert.match(refused.data.refused, /읽기 전용으로 열린 문서라 실행하지 않았습니다/);
  assert.equal(f.calls.undo.length, 1);
  assert.deepEqual([...f.document.doc.rows.keys()].sort(), [...before.keys()].sort());
});

test('bake (direct): one writer per document — refused while an AI turn writes it, and holds it while it runs', async (t) => {
  const f = fixture(t, { direct: true });
  const { base, iid } = await ready(f);
  const ai = (id) => ({
    id,
    body: '기둥 맞추기',
    provider: 'claude-cli',
    pins: [],
    sketches: [],
    files: [],
    host: 'rhino',
    mode: 'auto',
    baseRequestId: 'sync-1',
  });
  const doc = { host: 'rhino', instance: INSTANCE, documentId: DOCUMENT };
  // (a) An AI turn is writing the document: the bake runs nothing and says why.
  f.workspace.submit(f.project.id, ai('ai-1'));
  f.workspace.update(f.project.id, 'ai-1', 'running', { phase: 'host' });
  const refused = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns', 'beams'] });
  assert.equal(refused.status, 422, JSON.stringify(refused.data));
  assert.equal(refused.data.code, 'BAKE_FAILED');
  assert.equal(refused.data.reason, 'DOCUMENT_LOCKED');
  assert.match(refused.data.refused, /다른 작업이 이 문서를 고치는 중/);
  assert.equal(f.calls.direct.length, 0);
  f.workspace.update(f.project.id, 'ai-1', 'succeeded', {});
  // (b) While the bake runs, a turn's first write there is locked out and a new write waits.
  const during = [];
  f.direct.afterExecute = () => {
    if (during.length) return;
    during.push(documentHolder('turn-x', doc, f.workspace.claimRows(f.project.id))?.code);
    const queued = f.workspace.submit(f.project.id, ai('ai-2')).request;
    during.push(queued.state, queued.result?.waitingFor?.kind);
  };
  const made = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns', 'beams'] });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.deepEqual(during, ['DOCUMENT_LOCKED', 'queued', 'document']);
  // Released afterwards: nothing holds the document and the waiting request was let go.
  assert.equal(documentHolder('turn-x', doc, f.workspace.claimRows(f.project.id)), undefined);
  assert.equal(f.workspace.get(f.project.id, 'ai-2').result?.phase === 'queue', false);
});

test('bake (direct): a deletion no record lists is undone, by the host guard or by the engine', async (t) => {
  const f = fixture(t, { direct: true });
  const { base, iid } = await ready(f);
  const outline = [...f.document.doc.rows.values()].find((r) => r.layer === '슬래브 외곽');
  const before = [...f.document.doc.rows.keys()].sort();
  // A faulty body deletes the person's outline as well.
  f.direct.rogue = outline.nativeId;
  // (a) The host guard: more deletions than the body lists, unconfirmed; the host undid it.
  const hostGuarded = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns', 'beams'] });
  assert.equal(hostGuarded.status, 409, JSON.stringify(hostGuarded.data));
  assert.equal(hostGuarded.data.code, 'BAKE_GUARDED');
  assert.equal(hostGuarded.data.guarded.kind, 'bulk-delete');
  assert.deepEqual([...f.document.doc.rows.keys()].sort(), before);
  // (b) A host without its own count: the engine sees an unlisted GUID removed and undoes it,
  // with the body before it.
  f.direct.hostGuard = false;
  f.direct.rogueAt = f.calls.direct.length + 2;
  const engineGuarded = await f.call('POST', `${base}/${iid}/bake`, {
    bake: ['columns', 'beams'],
  });
  assert.equal(engineGuarded.status, 409, JSON.stringify(engineGuarded.data));
  assert.equal(engineGuarded.data.code, 'BAKE_GUARDED');
  assert.deepEqual([...f.document.doc.rows.keys()].sort(), before);
  assert.ok(f.document.doc.rows.has(outline.nativeId));
  assert.equal((await f.call('GET', `${base}/${iid}/bakes`)).data.bakes.length, 0);
});

test('bake (direct): a failed read after the run keeps the objects and the receipts; [반영 결과 읽기] records the baseline later', async (t) => {
  const f = fixture(t, { direct: true });
  const { base, iid, columns } = await ready(f);
  f.direct.afterExecute = () =>
    f.failNextRead(Object.assign(new Error('HOST_BUSY'), { code: 'HOST_BUSY' }));
  const bake = await f.call('POST', `${base}/${iid}/bake`, { bake: ['columns'] });
  assert.equal(bake.status, 200, JSON.stringify(bake.data));
  assert.equal(bake.data.baseline, 'pending');
  delete f.direct.afterExecute;
  const [record] = (await f.call('GET', `${base}/${iid}/bakes`)).data.bakes;
  assert.ok(record.pendingBaseline && !record.undone);
  assert.equal(Object.keys(record.items).length, columns.length);
  assert.ok(Object.values(record.items).every((item) => item.hash === ''));
  const retry = await f.call('POST', `${base}/${iid}/bakes/${record.id}/baseline`);
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(retry.data.recorded, columns.length);
});
