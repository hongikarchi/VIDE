// 역반영 적용 (SPEC-14.7·14.10 3·14.11·14.13, PLAN-47 T-233, ADR-022·027) with fake hosts: open drawings are
// applied now, one undo per file, all files or none; a closed drawing is computed in the work
// folder and written beside the original only after the save card, never over anything; the model
// or a drawing changed since the rows → refused; deletes beyond the guard need a confirmation; a
// conflict covered with the model is written; an unclear apply is never repeated and the re-read
// says which rows are done; only applied rows become baselines and an undo restores the previous
// ones; the Sync jig's "CAD를 Rhino에 맞춤" rows go through the same apply. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { DrawingBackflowStore } from '../../src/core/drawing-backflow.ts';
import { DrawingLayerStore } from '../../src/core/drawing-layers.ts';
import { XrefStore } from '../../src/core/xref-store.ts';
import { OutputTokens } from '../../src/core/drawing-output.ts';
import { DrawingBackflowService } from '../../src/server/drawing-backflow.ts';

const P = (x, y) => [x, y, 0];
const line = (a, b) => ({ kind: 'line', points: [P(...a), P(...b)] });
const sha = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const inspection = {
  error: null,
  version: 'AC1032',
  units: 4,
  layers: [{ name: '0' }, { name: 'A-WALL' }],
  linetypes: [],
  textStyles: [],
  dimStyles: [],
  blocks: [],
  xrefs: [],
};
const ent = (handle, geometry, extra = {}) => ({
  handle,
  type: 'Line',
  layer: 'A-WALL',
  owner: 'model',
  props: { color: 256, linetype: 'ByLayer', lineweight: -1 },
  geometry,
  ...extra,
});
const snapshotOf = (entities) => ({
  version: 'AC1032',
  units: 4,
  objects: Object.fromEntries(entities.map((e) => [e.handle, 'AcDbLine'])),
  digests: Object.fromEntries(entities.map((e) => [e.handle, JSON.stringify(e.geometry)])),
  tables: { layers: ['0', 'A-WALL'], regApps: ['ACAD'] },
  layouts: [],
  xrefs: [],
});

/** A fake ZWCAD: drawings by path (entities in mm), open or closed; applies ops in memory. */
function fakeHost(files) {
  const calls = [];
  let next = 0x100;
  const hash = (path) =>
    createHash('sha256').update(JSON.stringify(files[path].entities)).digest('hex');
  const applyOps = (entities, ops) => {
    const list = entities.map((e) => ({ ...e }));
    const results = [],
      failed = [];
    for (const op of ops) {
      if (op.op === 'add') {
        if (op.layer !== 'A-WALL' && op.layer !== '0') {
          failed.push({ id: op.id, code: 'LAYER_MISSING' });
          continue;
        }
        const handle = (next++).toString(16).toUpperCase();
        list.push(
          ent(handle, op.geometry, {
            layer: op.layer,
            origin: { id: op.origin, handle, revision: 1 },
          }),
        );
        results.push({ id: op.id, handle });
        continue;
      }
      const at = list.findIndex((e) => e.handle === op.handle);
      if (at < 0) {
        failed.push({ id: op.id, code: 'ENTITY_MISSING' });
        continue;
      }
      if (op.op === 'delete') list.splice(at, 1);
      else
        list[at] = {
          ...list[at],
          geometry: op.geometry,
          origin: { id: op.origin, handle: op.handle, revision: 1 },
        };
      results.push({ id: op.id, handle: op.handle });
    }
    return { list, results, failed };
  };
  const state = (entities) => ({
    entities,
    dims: [],
    layers: ['0', 'A-WALL'],
    snapshot: snapshotOf(entities),
  });
  const host = {
    calls,
    files,
    async available() {
      return true;
    },
    async open(path) {
      return files[path]?.open ? { instance: '1:2', documentId: 1, path } : null;
    },
    async readOpen(target) {
      const file = files[target.path];
      return {
        state: state(file.entities),
        documentHash: hash(target.path),
        units: 4,
        version: 'AC1032',
      };
    },
    async applyOpen(target, input) {
      calls.push(['applyOpen', target.path]);
      const file = files[target.path];
      if (file.unclear) throw new Error('socket hang up');
      if (input.expected !== hash(target.path)) return { ok: false, code: 'FILE_CHANGED' };
      const before = file.entities;
      const { list, results, failed } = applyOps(before, input.ops);
      if (failed.length || file.fail)
        return {
          ok: false,
          code: 'OP_REFUSED',
          failed: failed.length ? failed : [{ id: input.ops[0].id, code: 'LAYER_LOCKED' }],
        };
      file.entities = list;
      file.history = [...(file.history ?? []), before];
      return {
        ok: true,
        apply: { results, before: state(before), after: state(list) },
        undoId: 'u' + calls.length,
        documentHash: hash(target.path),
      };
    },
    async undoOpen(target, undoId) {
      calls.push(['undoOpen', target.path, undoId]);
      const file = files[target.path];
      file.entities = file.history.pop();
      return { ok: true };
    },
    async applyClosed({ tokens, token, jobs }) {
      calls.push(['applyClosed', jobs.length]);
      // The closed drawing of these tests (the service passed its copy).
      const closed = Object.keys(files).find((path) => !files[path].open);
      const out = [];
      for (const job of jobs) {
        const allowed = tokens.authorize(token, job.target);
        const entities = files[closed].entities;
        const { list, results, failed } = applyOps(entities, job.ops);
        if (failed.length)
          throw Object.assign(new Error('APPLY_FAILED'), {
            code: 'APPLY_FAILED',
            jobs: [{ id: job.id, failed }],
          });
        await writeFile(allowed.path, 'AC1032 applied');
        tokens.written(token, allowed.path);
        out.push({
          id: job.id,
          path: allowed.path,
          results,
          before: state(entities),
          after: state(list),
        });
      }
      return out;
    },
  };
  // The reader side: the source, and drawings (open: `open:<hash>`; closed: sha256 of the file).
  const reader = {
    snapshot: { linkId: 'L1', revision: 'r1', objects: [] },
    async available() {
      return true;
    },
    async source() {
      return reader.snapshot;
    },
    sourceOfSync() {
      return reader.snapshot;
    },
    async drawings(projectId, paths) {
      const out = new Map();
      for (const path of paths) {
        const file = files[path];
        if (!file) continue;
        out.set(path, {
          path,
          units: 4,
          sha256: file.open ? 'open:' + hash(path) : await sha(path),
          entities: file.entities,
        });
      }
      return out;
    },
    async fingerprints(projectId, paths) {
      return Promise.all(
        paths.map(async (path) => (files[path]?.open ? 'open:' + hash(path) : await sha(path))),
      );
    },
  };
  return { host, reader };
}

async function setup(t, files, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-backflow-apply-'));
  const folder = join(directory, '도면');
  const work = join(directory, 'work');
  await mkdir(folder, { recursive: true });
  await mkdir(work, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const named = {};
  for (const [name, file] of Object.entries(files)) {
    const path = join(folder, name);
    await writeFile(path, 'AC1032 synthetic ' + name);
    named[path] = file;
  }
  const store = new Store(':memory:');
  const project = store.createProject('역반영 적용');
  const layers = new DrawingLayerStore(store);
  for (const path of Object.keys(named))
    layers.saveRead(project.id, {
      path,
      size: 1,
      mtime: new Date().toISOString(),
      sha256: 'x',
      readAt: new Date().toISOString(),
      read: inspection,
    });
  const fake = fakeHost(named);
  const baselines = new DrawingBackflowStore(store);
  const service = new DrawingBackflowService({
    store: baselines,
    layers,
    xref: new XrefStore(store),
    reader: fake.reader,
    writer: fake.host,
    tokens: new OutputTokens({ workRoot: work }),
    workRoot: work,
    folders: () => [folder],
    denied: () => false,
    ...options,
  });
  return { service, project, folder, work, fake, baselines, paths: Object.keys(named) };
}
const relation = { rotation: 0, translation: [0, 0], dz: 0 };
const src = (id, geometry) => ({ id, layer: 'A-WALL', type: 'Curve', geometry });

test('open drawing: applied now, one undo, baselines only for applied rows and restored on undo', async (t) => {
  const { service, project, fake, baselines, paths } = await setup(t, {
    'a.dwg': {
      open: true,
      entities: [ent('1A', line([0, 0], [1000, 0])), ent('1B', line([0, 1000], [1000, 1000]))],
    },
  });
  const [root] = paths;
  fake.reader.snapshot = {
    linkId: 'L1',
    revision: 'r1',
    objects: [src('S1', line([0, 0], [1, 0])), src('S2', line([0, 1], [1, 1]))],
  };
  await service.establish(project.id, {
    root,
    link: 'L1',
    pairs: [
      { sourceId: 'S1', path: root, handle: '1A' },
      { sourceId: 'S2', path: root, handle: '1B' },
    ],
  });
  const recorded = baselines.baseline(project.id, root);
  fake.reader.snapshot = {
    linkId: 'L1',
    revision: 'r2',
    objects: [src('S1', line([0, 0], [2, 0])), src('S3', line([5, 5], [6, 5]))],
  };
  const diff = await service.diff(project.id, { root, link: 'L1', relation, scope: ['A-WALL'] });
  assert.deepEqual(
    diff.rows.map((r) => [r.kind, r.sourceId]),
    [
      ['modify', 'S1'],
      ['add', 'S3'],
      ['delete', 'S2'],
    ],
  );
  // The model changed after the rows: refused.
  fake.reader.snapshot = { ...fake.reader.snapshot, revision: 'r3' };
  await assert.rejects(service.apply(project.id, { diff: diff.id }), /SOURCE_CHANGED/);
  fake.reader.snapshot = { ...fake.reader.snapshot, revision: 'r2' };
  // Rows that cannot be chosen.
  await assert.rejects(service.apply(project.id, { diff: 'f'.repeat(24) }), /DIFF_NOT_FOUND/);
  const applied = await service.apply(project.id, { diff: diff.id, rows: ['B1', 'B2', 'B3'] });
  assert.equal(applied.state, 'applied', JSON.stringify(applied));
  const [file] = applied.files;
  assert.deepEqual(
    [file.mode, file.written, file.rows, file.check.ok],
    ['open', null, ['B1', 'B2', 'B3'], true],
  );
  assert.ok(file.undoId);
  assert.deepEqual(
    fake.host.files[root].entities.map((e) => e.handle),
    ['1A', '100'],
  );
  const after = baselines.baseline(project.id, root);
  assert.deepEqual(
    after.pairs.map((p) => [p.sourceId, p.handle, p.via]),
    [
      ['S1', '1A', 'backflow'],
      ['S3', '100', 'backflow'],
    ],
  );
  // Computed again: nothing left to write.
  const again = await service.diff(project.id, { root, link: 'L1', relation, scope: ['A-WALL'] });
  assert.deepEqual(again.rows, []);
  // [되돌리기]: ZWCAD's U, and the previous baseline.
  const undone = await service.undo(project.id, applied.id);
  assert.deepEqual(
    undone.files.map((f) => f.undone),
    [true],
  );
  assert.deepEqual(baselines.baseline(project.id, root).pairs, recorded.pairs);
  await assert.rejects(service.undo(project.id, applied.id), /APPLY_NOT_FOUND/);
});

test('two open drawings: a refused second file undoes the first (all or none)', async (t) => {
  const { service, project, fake, paths } = await setup(t, {
    'a.dwg': { open: true, entities: [ent('1A', line([0, 0], [1000, 0]))] },
  });
  const [root] = paths;
  const child = join(root, '..', 'b.dwg');
  await writeFile(child, 'AC1032 child');
  fake.host.files[child] = {
    open: true,
    fail: true,
    entities: [ent('2A', line([0, 0], [1000, 0]))],
  };
  const rows = [
    {
      id: 'B1',
      kind: 'modify',
      reason: null,
      sourceId: 'S1',
      sourceLayer: 'A-WALL',
      path: root,
      handle: '1A',
      layer: 'A-WALL',
      before: null,
      after: line([0, 0], [2000, 0]),
      via: 'sync',
      selectable: true,
      selected: true,
      absoluteXref: false,
      affectedRoots: [],
    },
    {
      id: 'B2',
      kind: 'modify',
      reason: null,
      sourceId: 'S2',
      sourceLayer: 'A-WALL',
      path: child,
      handle: '2A',
      layer: 'A-WALL',
      before: null,
      after: line([0, 0], [3000, 0]),
      via: 'sync',
      selectable: true,
      selected: true,
      absoluteXref: false,
      affectedRoots: [],
    },
  ];
  // A diff over both files (the child as an xref the root shows), injected as computed.
  const diff = await service.diff(project.id, { root, link: 'L1', relation });
  Object.assign(diff, {
    rows,
    drawings: [
      ...diff.drawings,
      {
        path: child,
        sha256:
          'open:' +
          createHash('sha256')
            .update(JSON.stringify(fake.host.files[child].entities))
            .digest('hex'),
      },
    ],
  });
  const answer = await service.apply(project.id, { diff: diff.id });
  assert.equal(answer.state, 'failed');
  assert.deepEqual(
    [answer.code, answer.path, answer.rolledBack, answer.undoFailed],
    ['OP_REFUSED', child, [root], []],
  );
  assert.deepEqual(
    fake.host.files[root].entities[0].geometry,
    line([0, 0], [1000, 0]),
    'the first file is back',
  );
});

test('closed drawing: computed in the work folder, written beside it only after [저장]', async (t) => {
  const { service, project, fake, folder, work, baselines, paths } = await setup(t, {
    'a.dwg': { open: false, entities: [ent('1A', line([0, 0], [1000, 0]))] },
  });
  const [root] = paths;
  const original = await sha(root);
  fake.reader.snapshot = {
    linkId: 'L1',
    revision: 'r1',
    objects: [src('S1', line([0, 0], [1, 0]))],
  };
  await service.establish(project.id, {
    root,
    link: 'L1',
    pairs: [{ sourceId: 'S1', path: root, handle: '1A' }],
  });
  fake.reader.snapshot = {
    linkId: 'L1',
    revision: 'r2',
    objects: [src('S1', line([0, 0], [1.5, 0]))],
  };
  const diff = await service.diff(project.id, { root, link: 'L1', relation });
  const card = await service.apply(project.id, { diff: diff.id });
  assert.equal(card.state, 'confirm');
  assert.equal(card.files.length, 1);
  assert.match(card.files[0].written, /a-VIDE반영-\d{8}-\d{4}\.dwg$/);
  assert.equal(card.files[0].version, 'AC1032');
  assert.equal(card.files[0].check.ok, true);
  assert.deepEqual(await readdir(folder), ['a.dwg'], 'nothing beside the drawing before [저장]');
  // [취소] leaves nothing anywhere; [저장] on a new card writes the file.
  await service.cancel(project.id, card.id);
  assert.deepEqual(
    (await readdir(work)).filter((n) => n.startsWith('apply-')),
    [],
  );
  const card2 = await service.apply(project.id, { diff: diff.id });
  const saved = await service.confirm(project.id, card2.id);
  assert.equal(saved.state, 'applied');
  const written = saved.files[0].written;
  assert.ok(existsSync(written));
  assert.equal(await sha(root), original, 'the original is never written');
  assert.deepEqual(
    baselines.baseline(project.id, written).pairs.map((p) => p.sourceId),
    ['S1'],
  );
  await assert.rejects(service.confirm(project.id, card2.id), /APPLY_NOT_FOUND/);
  // A name taken meanwhile is never overwritten.
  const card3 = await service.apply(project.id, { diff: diff.id });
  await writeFile(card3.files[0].written, 'someone else');
  await assert.rejects(service.confirm(project.id, card3.id), /OUTPUT_EXISTS/);
  assert.equal(await readFile(card3.files[0].written, 'utf8'), 'someone else');
  // The drawing changed after the rows: refused before anything is computed.
  await writeFile(root, 'AC1032 changed by a person');
  await assert.rejects(service.apply(project.id, { diff: diff.id }), /FILE_CHANGED/);
});

test('guards: deletes beyond the limit, conflicts covered with the model, an unclear apply', async (t) => {
  const { service, project, fake, paths } = await setup(
    t,
    {
      'a.dwg': {
        open: true,
        entities: [
          ent('1A', line([0, 0], [1000, 0])),
          ent('1B', line([0, 1000], [1000, 1000])),
          ent('1C', line([0, 2000], [1000, 2000])),
        ],
      },
    },
    { maxDeletes: 1 },
  );
  const [root] = paths;
  fake.reader.snapshot = {
    linkId: 'L1',
    revision: 'r1',
    objects: [
      src('S1', line([0, 0], [1, 0])),
      src('S2', line([0, 1], [1, 1])),
      src('S3', line([0, 2], [1, 2])),
    ],
  };
  await service.establish(project.id, {
    root,
    link: 'L1',
    pairs: [
      { sourceId: 'S2', path: root, handle: '1B' },
      { sourceId: 'S3', path: root, handle: '1C' },
    ],
  });
  fake.reader.snapshot = {
    linkId: 'L1',
    revision: 'r2',
    objects: [src('S1', line([0, 0], [2, 0]))],
  };
  // S1 was never recorded: its Sync pair differs → conflict (NO_BASELINE); S2, S3 deleted.
  const diff = await service.diff(project.id, {
    root,
    link: 'L1',
    relation,
    pairs: [{ sourceId: 'S1', path: root, handle: '1A' }],
  });
  assert.deepEqual(
    diff.rows.map((r) => [r.id, r.kind, r.reason]),
    [
      ['B1', 'conflict', 'NO_BASELINE'],
      ['B2', 'delete', null],
      ['B3', 'delete', null],
    ],
  );
  await assert.rejects(
    service.apply(project.id, { diff: diff.id, rows: ['B1'] }),
    /ROW_NOT_SELECTABLE/,
  );
  await assert.rejects(
    service.apply(project.id, { diff: diff.id, rows: ['B2', 'B3'] }),
    /DELETE_CONFIRMATION_REQUIRED/,
  );
  const applied = await service.apply(project.id, {
    diff: diff.id,
    rows: ['B2', 'B3'],
    cover: ['B1'],
    confirmDeletes: true,
  });
  assert.equal(applied.state, 'applied', JSON.stringify(applied));
  assert.deepEqual(
    fake.host.files[root].entities.map((e) => [e.handle, e.geometry.points[1][0]]),
    [['1A', 2000]],
  );
  // An apply whose answer is lost is not repeated; the re-read tells what the drawing shows.
  fake.reader.snapshot = {
    linkId: 'L1',
    revision: 'r3',
    objects: [src('S1', line([0, 0], [3, 0]))],
  };
  const next = await service.diff(project.id, { root, link: 'L1', relation });
  fake.host.files[root].unclear = true;
  const unclear = await service.apply(project.id, { diff: next.id });
  assert.deepEqual([unclear.state, unclear.applied, unclear.notApplied], ['unclear', [], ['B1']]);
  assert.equal(
    fake.host.calls.filter(([c]) => c === 'applyOpen').length,
    2,
    'applied once each, never again',
  );
});

test('Sync jig "CAD를 Rhino에 맞춤": rows of the jig through the same apply', async (t) => {
  const { service, project, fake, baselines, paths } = await setup(t, {
    'a.dwg': {
      open: true,
      entities: [ent('1A', line([0, 0], [1000, 0])), ent('1B', line([0, 5000], [1000, 5000]))],
    },
  });
  const [root] = paths;
  fake.reader.snapshot = {
    linkId: 'L1',
    revision: 's1',
    objects: [
      src('R1', line([0, 0], [1.2, 0])),
      src('R2', { kind: 'arc', center: P(3, 3), radius: 1, start: 0, end: Math.PI / 2 }),
      src('R3', null),
    ],
  };
  const answer = await service.syncApply(project.id, {
    rhino: 'sync-r',
    cad: 'sync-c',
    relation,
    path: root,
    linkId: 'L1',
    rows: [
      { id: 'R1', state: 'offset', rhino: 'R1', cad: '1a' },
      { id: 'R2', state: 'rhino-only', rhino: 'R2', layer: 'A-WALL' },
      { id: 'R3', state: 'rhino-only', rhino: 'R2', layer: '없는 레이어' },
      { id: 'R4', state: 'cad-only', cad: '1B' },
      { id: 'R5', state: 'offset', rhino: 'R3', cad: '1A' },
    ],
  });
  assert.equal(answer.state, 'applied', JSON.stringify(answer));
  assert.deepEqual(answer.refused, [
    { id: 'R3', code: 'LAYER_NEEDED' },
    { id: 'R5', code: 'SOURCE_TYPE' },
  ]);
  const entities = fake.host.files[root].entities;
  assert.deepEqual(
    entities.map((e) => [e.handle, e.geometry.kind]),
    [
      ['1A', 'line'],
      ['100', 'arc'],
    ],
  );
  assert.deepEqual(entities[0].geometry.points[1], [1200, 0, 0]);
  assert.equal(entities[1].geometry.radius, 1000);
  assert.deepEqual(
    baselines.baseline(project.id, root).pairs.map((p) => p.sourceId),
    ['R1', 'R2'],
  );
  // A drawing that is not open in ZWCAD cannot follow the jig.
  fake.host.files[root].open = false;
  await assert.rejects(
    service.syncApply(project.id, {
      rhino: 's',
      cad: 'c',
      relation,
      path: root,
      linkId: 'L1',
      rows: [{ id: 'R4', state: 'cad-only', cad: '1A' }],
    }),
    /ZWCAD_ATTACHED_EDIT_UNAVAILABLE/,
  );
});
