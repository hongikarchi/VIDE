import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readScenePages } from '../../hosts/rhino/scene-pages.ts';

const object = (id = randomUUID()) => ({
  id,
  nativeId: id,
  kind: 'native',
  name: 'point',
  origin: [0, 0, 0],
});
function page(objects, offset, total, revision = 1) {
  return {
    objects,
    scene: objects.map((o) => ({
      ...o,
      nativeType: 'Point',
      name64: '',
      boundsSize: [0, 0, 0],
      vertices: [],
      indices: [],
      line: [],
      area: null,
      volume: null,
      length: null,
      layer64: '',
      attributes64: [],
      attributesComplete: true,
      valid: true,
    })),
    page: { offset, nextOffset: offset + objects.length, total, revision },
    measurementVersion: 1,
    measurementStats: { measuredObjects: objects.length, reusedObjects: 0 },
  };
}
test('native pages preserve all identities and one revision until complete', async () => {
  const items = Array.from({ length: 10713 }, () => object());
  let calls = 0;
  const result = await readScenePages(async ({ offset, limit, revision }) => {
    calls++;
    assert.equal(revision, offset === 0 ? undefined : 1);
    return page(items.slice(offset, offset + limit), offset, items.length);
  });
  assert.equal(calls, 11);
  assert.equal(result.objects.length, 10713);
  // No total cap by default (ADR-031): only an explicit budget stops a long read.
  const bulky = await readScenePages(async ({ offset, limit }) => {
    const reply = page(items.slice(offset, offset + limit), offset, items.length);
    reply.padding = 'x'.repeat(4 * 1024 * 1024);
    return reply;
  });
  assert.equal(bulky.objects.length, 10713);
  assert.equal(result.measurementStats.measuredObjects, 10713);
});
test('only an explicit oversized read reduces page size; singular overflow stops', async () => {
  const limits = [];
  await assert.rejects(
    readScenePages(async ({ limit }) => {
      limits.push(limit);
      return { ok: false, code: 'HOST_RESULT_TOO_LARGE' };
    }),
    { code: 'HOST_RESULT_TOO_LARGE' },
  );
  assert.deepEqual(limits, [1000, 500, 250, 125, 62, 31, 15, 7, 3, 1]);
});
for (const mode of ['duplicate', 'changed-revision', 'changed-total', 'empty', 'bad-offset'])
  test(`native page rejects ${mode} without returning partial success`, async () => {
    const a = object();
    await assert.rejects(
      readScenePages(async ({ offset }) => {
        if (offset === 0) return page([a], 0, 2);
        if (mode === 'duplicate') return page([a], 1, 2);
        if (mode === 'changed-revision') return page([object()], 1, 2, 2);
        if (mode === 'changed-total') return page([object()], 1, 3);
        if (mode === 'empty') return page([], 1, 2);
        return page([object()], 0, 2);
      }),
      { code: 'HOST_INVALID_RESPONSE' },
    );
  });
test('native page aggregate budget and ambiguous reply do not retry', async () => {
  await assert.rejects(
    readScenePages(async () => page([object()], 0, 1), {}, 1),
    { code: 'HOST_RESULT_TOO_LARGE' },
  );
  let calls = 0;
  await assert.rejects(
    readScenePages(async () => {
      calls++;
      throw Object.assign(new Error(), { code: 'HOST_RESULT_UNKNOWN' });
    }),
    { code: 'HOST_RESULT_UNKNOWN' },
  );
  assert.equal(calls, 1);
});

test('display sync preserves invalid source records without claiming editable valid geometry', async () => {
  const raw = page([object(), object()], 0, 2);
  raw.scene[1].valid = false;
  raw.scene[1].nativeType = 'Brep';
  const display = await readScenePages(async () => raw, {}, 1024 * 1024, true);
  assert.equal(display.objects.length, 2);
  assert.deepEqual(display.displayCoverage, {
    total: 2,
    displayed: 1,
    omitted: 1,
    omittedTypes: { 'Brep (invalid)': 1 },
  });
  await assert.rejects(readScenePages(async () => raw));
});
