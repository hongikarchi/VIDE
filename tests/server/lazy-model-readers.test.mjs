// T-129: the readers that took a whole stored model (`Workspace.get`) read it lazily
// (`Workspace.lazy`, `ModelView.lazy`): jig inputs (structure layers/diagnose, Sync jig, structure
// draft), quantities, comparison, report, review, publication and the offline snapshot give the
// same output as from the whole model, and none of them assembles a stored model
// (`ModelStore.load`). The structure jig's draft goes stale when a Live Sync changes its Sync in
// place (manifest revision).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../src/server/server.ts';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { ModelStore, StoredList } from '../../src/core/model-store.ts';
import { decodeItem, encodeItem, lazyItem } from '../../src/contracts/geometry-transfer.ts';
import { captureInput } from '../../src/server/import-model.ts';
import { quantities } from '../../src/core/quantities.ts';
import { candidateSchema, Reviews } from '../../src/core/reviews.ts';
import { compareCandidates } from '../../src/core/comparison.ts';
import { createPublicationBundle } from '../../src/core/publication.ts';
import { lazyCandidate } from '../../src/core/scene-items.ts';
import { SharedFeedback } from '../../src/core/shared-feedback.ts';
import { createHash } from 'node:crypto';
import { renderReport } from '../../src/server/report.ts';
import { buildSnapshot, packSnapshot } from '../../src/server/offline-snapshot.ts';
import { layersOf, rowsOfLayers } from '../../src/jigs/runtime/runtime.ts';
import { runSync } from '../../src/jigs/sync.ts';
import { draftStructure, documentKey } from '../../src/jigs/structure/index.ts';
import {
  documentName,
  guessRoles,
  roleRows,
  syncLayers,
} from '../../extensions/jigs/s06-frame/steps/sync-input.ts';
import { diagnose } from '../../extensions/jigs/s06-frame/steps/diagnose.ts';

const IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const b64 = (text) => Buffer.from(text).toString('base64');
const LAYERS = ['Mass', '기둥', '거더', '기초'];
/** A synthetic display Sync: meshes, vertical and level lines, block instances (`count` items). */
function model(count, { shift = 0, host = 'rhino', documentId = 7 } = {}) {
  const objects = [],
    scene = [];
  for (let i = 0; i < count; i++) {
    const key = `o${i}`;
    const kind = i % 4;
    const x = (i % 10) * 6 + shift,
      y = Math.floor(i / 10) * 8;
    const base = { id: key, nativeId: key, layer64: b64(LAYERS[kind]) };
    if (kind === 0)
      scene.push({
        ...base,
        nativeType: 'Brep',
        area: 6,
        volume: 1 + i,
        valid: true,
        vertices: [x, y, 0, x + 1, y, 0, x + 1, y + 1, 0, x, y + 1, 2],
        indices: [0, 1, 2, 0, 2, 3],
        displayColor: '#336699',
      });
    else if (kind === 1)
      scene.push({
        ...base,
        nativeType: 'Curve',
        name64: b64(`C${i}`),
        line: [x, y, 0, x, y, 3.5],
      });
    else if (kind === 2)
      scene.push({ ...base, nativeType: 'Curve', length: 6, line: [x, y, 3.5, x + 6, y, 3.5] });
    else
      scene.push({
        ...base,
        nativeType: 'InstanceReference',
        block: { definition: 'def1', transform: [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, 0, 0, 0, 0, 1] },
      });
    objects.push({ id: key, nativeId: key, kind: kind ? 'curve' : 'native', name: `n${i}` });
  }
  return {
    hostExecuted: true,
    displayOnly: true,
    verified: true,
    executionMode: 'sdk',
    host,
    objects,
    scene,
    definitions: {
      def1: {
        hash: 'def1',
        vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
        segments: [0, 0, 0, 1, 1, 0],
      },
    },
    sourceDocument: {
      instance: '1:2:3',
      documentId,
      connection: 'attached-editor',
      documentHash: 'r'.repeat(64),
      revision: 4,
      name: host === 'zwcad' ? 'plan.dwg' : 'Doc',
      units: 'Meters',
      capturedAt: '2026-10-06T00:00:00Z',
    },
  };
}
function sync(workspace, projectId, id, result, host = 'rhino') {
  workspace.submit(
    projectId,
    captureInput({ id, instance: '1:2:3', documentId: result.sourceDocument.documentId }, host),
  );
  workspace.update(projectId, id, 'succeeded', result);
}
/** Counts whole-model assemblies (every `Workspace.get`/`expand` of a stored model goes here). */
function spyLoads(t) {
  const load = ModelStore.prototype.load;
  const counter = { n: 0 };
  ModelStore.prototype.load = function (...args) {
    counter.n++;
    return load.apply(this, args);
  };
  t.after(() => (ModelStore.prototype.load = load));
  return counter;
}
const json = (value) => JSON.parse(JSON.stringify(value));

test('ModelView.lazy reads the same objects, scene and definitions as load', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const project = store.createProject('lazy');
  sync(workspace, project.id, 's1', model(40));
  const whole = workspace.get(project.id, 's1').result;
  const loads = spyLoads(t);
  const lazy = workspace.lazy(project.id, 's1').result;
  assert.ok(lazy.scene instanceof StoredList);
  assert.deepEqual([...lazy.objects], whole.objects);
  assert.deepEqual(json([...lazy.scene]), json(whole.scene));
  assert.deepEqual(json(lazy.definitions), json(whole.definitions));
  assert.deepEqual(Object.keys(lazy.definitions), Object.keys(whole.definitions));
  // Iterating again reads the manifest again; toJSON gives the whole list.
  assert.equal([...lazy.scene].length, 40);
  assert.deepEqual(JSON.parse(JSON.stringify(lazy.scene)), json(whole.scene));
  assert.equal(loads.n, 0);
  // A lazy item decodes its arrays on first read only, and equals decodeItem.
  const encoded = encodeItem(whole.scene[0]);
  const item = lazyItem(encoded.meta, encoded.geometry);
  assert.equal(typeof Object.getOwnPropertyDescriptor(item, 'vertices').get, 'function');
  assert.deepEqual({ ...item }, decodeItem(encoded.meta, encoded.geometry));
  item.vertices = [1, 2, 3];
  assert.deepEqual(item.vertices, [1, 2, 3]);
});

test('core readers give the same output from a lazy model without assembling it', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const project = store.createProject('readers');
  const p = project.id;
  sync(workspace, p, 's1', model(120));
  workspace.submit(p, {
    ...captureInput({ id: 'k2', instance: '1:2:3', documentId: 7 }),
    source: undefined,
    baseRequestId: 's1',
  });
  workspace.update(p, 'k2', 'succeeded', { ...model(120, { shift: 0.5 }), baseRequestId: 's1' });
  sync(workspace, p, 'c1', model(80, { host: 'zwcad', documentId: 9 }), 'zwcad');
  const whole = (id) => workspace.get(p, id);
  const expected = {
    layers: syncLayers(whole('s1').result),
    roles: roleRows(whole('s1').result, 's1', ['기둥', '기초']),
    picked: json(rowsOfLayers(whole('s1').result, ['거더', '기초'])),
    layerTable: layersOf(whole('s1').result),
    sync: runSync(whole('s1').result, whole('c1').result, { rhinoLayers: ['거더'] }),
    draft: draftStructure([
      {
        syncId: 's1',
        host: 'rhino',
        mode: 'curves',
        layers: ['기둥', '거더'],
        result: whole('s1').result,
      },
      {
        syncId: 'c1',
        host: 'zwcad',
        mode: 'cad',
        result: whole('c1').result,
        cad: { levels_m: [3.5], beamLayers: ['거더'], columnLayers: ['기둥'] },
      },
    ]),
    quantities: quantities(candidateSchema.parse(whole('s1')), { groupBy: 'layer' }),
    comparison: compareCandidates(whole('s1'), whole('k2'), true),
    report: renderReport({ name: 'P' }, { ...whole('s1'), applications: [] }, IMAGE),
    publication: createPublicationBundle(whole('s1'), {
      title: 'T',
      objectIds: ['o0', 'o4', 'o5'],
      includeNames: true,
      includeMeasurements: true,
    }),
    snapshot: packSnapshot(buildSnapshot(whole('s1').result, { name: 'Doc', host: 'rhino' })),
  };
  const loads = spyLoads(t);
  const lazy = (id) => workspace.lazy(p, id);
  assert.deepEqual(syncLayers(lazy('s1').result), expected.layers);
  assert.deepEqual(roleRows(lazy('s1').result, 's1', ['기둥', '기초']), expected.roles);
  assert.deepEqual(json(rowsOfLayers(lazy('s1').result, ['거더', '기초'])), expected.picked);
  assert.deepEqual(layersOf(lazy('s1').result), expected.layerTable);
  assert.deepEqual(
    runSync(lazy('s1').result, lazy('c1').result, { rhinoLayers: ['거더'] }),
    expected.sync,
  );
  assert.deepEqual(
    draftStructure([
      {
        syncId: 's1',
        host: 'rhino',
        mode: 'curves',
        layers: ['기둥', '거더'],
        result: lazy('s1').result,
      },
      {
        syncId: 'c1',
        host: 'zwcad',
        mode: 'cad',
        result: lazy('c1').result,
        cad: { levels_m: [3.5], beamLayers: ['거더'], columnLayers: ['기둥'] },
      },
    ]),
    expected.draft,
  );
  const candidate = (id) => lazyCandidate(workspace, p, id);
  assert.deepEqual(
    quantities(candidateSchema.parse(candidate('s1')), { groupBy: 'layer' }),
    expected.quantities,
  );
  assert.deepEqual(compareCandidates(candidate('s1'), candidate('k2'), true), expected.comparison);
  assert.equal(
    renderReport({ name: 'P' }, { ...candidate('s1'), applications: [] }, IMAGE),
    expected.report,
  );
  const bundle = createPublicationBundle(candidate('s1'), {
    title: 'T',
    objectIds: ['o0', 'o4', 'o5'],
    includeNames: true,
    includeMeasurements: true,
  });
  assert.deepEqual(bundle.manifest, expected.publication.manifest);
  assert.deepEqual(Buffer.concat(bundle.chunks), Buffer.concat(expected.publication.chunks));
  assert.deepEqual(
    packSnapshot(buildSnapshot(lazy('s1').result, { name: 'Doc', host: 'rhino' })),
    expected.snapshot,
  );
  // A review snapshot holds the same payload.
  const reviews = new Reviews(store);
  const payload = (id) => {
    const row = soleReview(store, p, id);
    return { ...row, createdAt: undefined };
  };
  const a = reviews.create(p, { title: 'A', image: IMAGE }, { ...whole('s1'), applications: [] });
  const before = loads.n;
  const b = reviews.create(
    p,
    { title: 'A', image: IMAGE },
    { ...candidate('s1'), applications: [] },
  );
  assert.deepEqual(payload(b.id), payload(a.id));
  assert.equal(loads.n - before, 0);
  assert.equal(loads.n, 1, 'only the whole read of the expected review');
  // A publication's source hash (checked again when shared feedback comes back) is the hash of
  // the whole result's canonical text, fed item by item.
  const canonical = (value) =>
    Array.isArray(value)
      ? '[' + value.map(canonical).join(',') + ']'
      : value && typeof value === 'object'
        ? '{' +
          Object.entries(value)
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
            .join(',') +
          '}'
        : (JSON.stringify(value) ?? 'null');
  const sourceHash = createHash('sha256')
    .update(canonical(whole('s1').result))
    .digest('hex');
  const loadsBefore = loads.n;
  const exportId = new SharedFeedback(store, workspace).record(p, 's1', { objectIds: [] });
  assert.equal(loads.n, loadsBefore);
  assert.equal(
    store.db(p).prepare('SELECT sourceHash FROM publication_exports WHERE id=?').get(exportId)
      .sourceHash,
    sourceHash,
  );
  assert.equal(documentName(lazy('s1').result), 'Doc');
  assert.equal(documentKey(lazy('s1').result), documentKey(whole('s1').result));
});

function soleReview(store, projectId, id) {
  const row = store
    .db(projectId)
    .prepare('SELECT payload FROM review_snapshots WHERE id=?')
    .get(id);
  return JSON.parse(row.payload);
}

test('routes read Syncs lazily; a Live Sync in place makes the structure draft stale', async (t) => {
  const app = await startServer({ filename: ':memory:', host: { status: async () => ({}) } });
  t.after(() => app.close());
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const headers = {
    Origin: app.origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    const text = await response.text();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  };
  const project = await api('/projects', 'POST', { name: 'routes' });
  const p = project.id;
  const workspace = new Workspace(app.store);
  sync(workspace, p, 's1', model(120));
  sync(workspace, p, 'c1', model(80, { host: 'zwcad', documentId: 9 }), 'zwcad');
  const whole = (id) => workspace.get(p, id);
  const expectedLayers = syncLayers(whole('s1').result);
  const expectedQuantities = quantities(candidateSchema.parse(whole('s1')));
  const expectedReport = renderReport(
    app.store.project(p),
    { ...whole('s1'), applications: [] },
    IMAGE,
  );
  const expectedSync = runSync(whole('s1').result, whole('c1').result, {});
  const roles = {
    columns: [{ syncId: 's1', layer: '기둥' }],
    girders: [{ syncId: 's1', layer: '거더' }],
    newFootings: [{ syncId: 's1', layer: '기초' }],
  };
  // The diagnosis as the route built it before: `roleRows` per role from the whole model.
  const inputs = { definitions: {} };
  for (const [role, picks] of Object.entries(roles)) {
    const read = roleRows(
      whole('s1').result,
      's1',
      picks.map((pick) => pick.layer),
    );
    inputs[role] = read.rows;
    inputs.definitions.s1 = { ...inputs.definitions.s1, ...read.definitions };
  }
  const expectedDiagnosis = json(diagnose(inputs, undefined));
  const selection = { title: 'T', objectIds: ['o0', 'o8'] };
  const expectedBundle = createPublicationBundle(whole('s1'), selection);
  const loads = spyLoads(t);

  const layers = await api(`/projects/${p}/jigs/structure/layers?syncIds=s1`);
  assert.deepEqual(layers.sources[0].layers, expectedLayers);
  assert.deepEqual(layers.guess, guessRoles(layers.sources));
  const {
    ms: _ms,
    sources,
    ...diagnosis
  } = await api(`/projects/${p}/jigs/structure/diagnose`, 'POST', { sources: ['s1'], roles });
  assert.deepEqual(sources, [{ syncId: 's1', document: 'Doc' }]);
  assert.deepEqual(diagnosis, expectedDiagnosis);
  const table = await api(`/projects/${p}/requests/s1/quantities`);
  assert.deepEqual(table, json(expectedQuantities));
  const report = await api(`/projects/${p}/requests/s1/report`, 'POST', { image: IMAGE });
  assert.equal(report, expectedReport);
  const exported = await api(`/projects/${p}/requests/s1/publication-export`, 'POST', selection);
  assert.deepEqual(exported.manifest, expectedBundle.manifest);
  const jig = await api(`/projects/${p}/jigs/sync`, 'POST', { rhino: 's1', cad: 'c1' });
  assert.deepEqual(jig.alignment, json(expectedSync.alignment));
  assert.equal(jig.totalRows, expectedSync.rows.length);
  const draft = await api(`/projects/${p}/jigs/structure/draft`, 'POST', {
    sources: [{ syncId: 's1', mode: 'curves', layers: ['기둥', '거더'] }],
  });
  assert.equal(draft.sources[0].revision, workspace.model(p, 's1').revision);
  assert.equal(loads.n, 0, 'a route assembled a whole stored model');

  assert.equal((await api(`/projects/${p}/jigs/structure`)).draftStale, false);
  // A Live Sync changes the Sync in place: same id, newer manifest revision.
  const changed = model(120, { shift: 0.25 });
  workspace.applyDelta(
    p,
    's1',
    { objects: [changed.objects[1]], scene: [changed.scene[1]], removed: [] },
    {},
  );
  assert.equal((await api(`/projects/${p}/jigs/structure`)).draftStale, true);
});
