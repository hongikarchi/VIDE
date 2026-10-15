// 동기화 쌍 (PLAN-54 T-349, SPEC-01.13 11, ARCH-01 '동기화 쌍과 갱신 제안'): pairs kept in the work
// folder manifest with its other keys intact, `pairs.json` when the folder is a read-only
// `architecture-workspace/1` one or there is none, PAIR_EXISTS, removal, the [무시] memory and the
// row keys. Synthetic folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDismissed,
  rowKey,
  setHash,
  SyncPairStore,
  withPairs,
  writeDismissed,
} from '../../src/core/sync-pairs.ts';
import { workspaceOf } from '../../src/core/workspace-config.ts';

const PROJECT = '11111111-2222-4333-8444-555555555555';

async function fixture(manifest) {
  const base = await mkdtemp(join(tmpdir(), 'vide-pairs-'));
  const root = join(base, 'work');
  const data = join(base, 'data');
  await mkdir(join(root, '03_모델'), { recursive: true });
  await mkdir(join(root, '04_도면'), { recursive: true });
  if (manifest)
    await writeFile(join(root, 'project.config.json'), JSON.stringify(manifest), 'utf8');
  const folders = { list: () => [{ kind: 'project', path: root }] };
  const store = new SyncPairStore({
    dataDirectory: data,
    workspaceOf: (projectId) => workspaceOf(folders, projectId),
    now: () => new Date('2026-10-15T05:00:00Z'),
  });
  return { base, root, data, store };
}
const videManifest = {
  schema: 'vide-workspace/1',
  paths: { rhino: '03_모델', cad: '04_도면' },
  vide: { projectId: PROJECT, createdAt: '2026-10-01T00:00:00Z' },
  custom: { keep: true },
};

test('a pair goes into the manifest relative to its role folders, other keys kept', async () => {
  const f = await fixture(videManifest);
  try {
    const model = join(f.root, '03_모델', 'A.3dm');
    const drawing = join(f.root, '04_도면', 'A-평면.dwg');
    const pair = await f.store.add(PROJECT, {
      model,
      drawing,
      relation: { rotation: 0, translation: [1, 2], dz: 0 },
      linkIds: { model: 'link-a' },
      createdBy: '김설계',
    });
    assert.equal(pair.where, 'manifest');
    assert.match(pair.id, /^[a-z0-9]{12}$/);
    const written = JSON.parse(await readFile(join(f.root, 'project.config.json'), 'utf8'));
    assert.deepEqual(written.custom, { keep: true });
    assert.equal(written.pairs.length, 1);
    assert.deepEqual(written.pairs[0].model, { role: 'rhino', path: 'A.3dm' });
    assert.deepEqual(written.pairs[0].drawing, { role: 'cad', path: 'A-평면.dwg' });
    assert.equal(written.pairs[0].createdBy, '김설계');
    assert.equal(written.pairs[0].relation.confirmedAt, '2026-10-15T05:00:00.000Z');
    assert.ok(written.vide.updatedAt);
    // Read back with absolute paths; the same two files again are refused.
    const [listed] = await f.store.list(PROJECT);
    assert.equal(listed.absolute.model.toLowerCase(), model.toLowerCase());
    await assert.rejects(f.store.add(PROJECT, { model, drawing }), { code: 'PAIR_EXISTS' });
    // A second drawing of the same model is its own pair.
    await f.store.add(PROJECT, { model, drawing: join(f.root, '04_도면', 'A-단면.dwg') });
    assert.equal((await f.store.list(PROJECT)).length, 2);
    // Relation replaced, then the pair removed.
    const moved = await f.store.setRelation(PROJECT, pair.id, {
      rotation: 0.1,
      translation: [0, 0],
      dz: 0,
    });
    assert.equal(moved.relation.rotation, 0.1);
    await f.store.remove(PROJECT, pair.id);
    const after = JSON.parse(await readFile(join(f.root, 'project.config.json'), 'utf8'));
    assert.equal(after.pairs.length, 1);
    assert.deepEqual(after.custom, { keep: true });
    await assert.rejects(f.store.remove(PROJECT, pair.id), { code: 'PAIR_NOT_FOUND' });
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test('entries the code cannot read stay in the manifest', () => {
  const cfg = { ...videManifest, pairs: [{ id: 'x', future: 1 }] };
  const next = withPairs(cfg, (pairs) => [
    ...pairs,
    {
      id: 'abcdefabcdef',
      model: { role: null, path: 'a.3dm' },
      drawing: { role: null, path: 'a.dwg' },
      createdBy: 'user',
      createdAt: '2026-10-15T00:00:00Z',
    },
  ]);
  assert.equal(next.pairs.length, 2);
  assert.deepEqual(next.pairs[1], { id: 'x', future: 1 });
  assert.throws(() => withPairs({ schema: 'architecture-workspace/1', paths: {} }, (p) => p), {
    code: 'WORKSPACE_READ_ONLY',
  });
});

test('a read-only 규모검토 folder or no folder keeps pairs in pairs.json', async () => {
  const f = await fixture({ schema: 'architecture-workspace/1', paths: { rhino: '03_모델' } });
  try {
    const model = join(f.root, '03_모델', 'A.3dm');
    const drawing = join(f.root, '04_도면', 'A.dwg');
    const pair = await f.store.add(PROJECT, { model, drawing });
    assert.equal(pair.where, 'file');
    const kept = JSON.parse(
      await readFile(join(f.data, 'projects', PROJECT, 'pairs.json'), 'utf8'),
    );
    assert.equal(kept.pairs[0].model.path, model);
    assert.equal(kept.pairs[0].model.role, null);
    // The manifest is untouched.
    const manifest = JSON.parse(await readFile(join(f.root, 'project.config.json'), 'utf8'));
    assert.equal(manifest.pairs, undefined);
    assert.equal((await f.store.list(PROJECT))[0].absolute.drawing, drawing);
    await f.store.remove(PROJECT, pair.id);
    assert.equal((await f.store.list(PROJECT)).length, 0);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
  const none = await fixture(null);
  try {
    const pair = await none.store.add(PROJECT, {
      model: 'C:\\a\\b.3dm',
      drawing: 'C:\\a\\b.dwg',
    });
    assert.equal(pair.where, 'file');
    await assert.rejects(none.store.add(PROJECT, { model: 'a.3dm', drawing: 'C:\\a\\b.dwg' }), {
      code: 'INVALID_INPUT',
    });
  } finally {
    await rm(none.base, { recursive: true, force: true });
  }
});

test('row keys round to 1 mm and the [무시] memory reads back', async () => {
  const a = rowKey({
    state: 'offset',
    rhino: { nativeId: 'r1' },
    cad: { nativeId: '2a' },
    deviation: 0.5004,
  });
  const b = rowKey({
    state: 'offset',
    rhino: { nativeId: 'r1' },
    cad: { nativeId: '2A' },
    deviation: 0.5001,
  });
  const c = rowKey({
    state: 'offset',
    rhino: { nativeId: 'r1' },
    cad: { nativeId: '2a' },
    deviation: 0.51,
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 16);
  assert.equal(setHash([a, c]), setHash([c, a]));
  const data = await mkdtemp(join(tmpdir(), 'vide-dismissed-'));
  try {
    assert.deepEqual(await readDismissed(data, PROJECT), {});
    await writeDismissed(data, PROJECT, { p1: { setHash: 'h', rowKeys: [a], at: 'now' } });
    assert.deepEqual((await readDismissed(data, PROJECT)).p1.rowKeys, [a]);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
