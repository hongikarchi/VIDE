import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readScenePages, withSurvey } from '../../hosts/rhino/scene-pages.ts';

// Pages of the T-043 plugin repeat a document survey (`coverage`, `layers`): what the read left
// out before any row existed, and the layer table. The reader keeps the first one, checks that the
// listed count is the page total, forwards the read scope, and accepts pages of an older plugin.

const object = (id = randomUUID()) => ({
  id,
  nativeId: id,
  kind: 'native',
  name: 'point',
  origin: [0, 0, 0],
});
const layer = (fullPath, visible = true, objectCount = 0) => ({
  id: randomUUID(),
  parentId: null,
  fullPath,
  visible,
  locked: false,
  color: '#7f7f7f',
  order: 0,
  objectCount,
});
function page(objects, offset, total, survey = {}, revision = 1) {
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
    ...survey,
  };
}
const survey = (displayed) => ({
  coverage: {
    total: displayed + 97,
    displayed,
    omittedHidden: 96,
    omittedFiltered: 1,
    omittedBlockInternal: 14,
    hiddenLayers: [{ path: '기존::기초', count: 96 }],
  },
  layers: [layer('기둥', true, displayed), layer('기존::기초', false, 96), layer('빈 레이어')],
});

test('the survey of the first page joins the coverage and the layer table', async () => {
  const items = Array.from({ length: 1500 }, () => object());
  const params = [];
  const model = await readScenePages(
    async ({ offset, limit, ...rest }) => {
      params.push(rest);
      return page(items.slice(offset, offset + limit), offset, items.length, survey(1500));
    },
    {},
    32 * 1024 * 1024,
    true,
    { layers: ['기둥'], includeHidden: true },
  );
  assert.deepEqual(params[0], { layers: ['기둥'], includeHidden: true });
  assert.deepEqual(params[1], { revision: 1, layers: ['기둥'], includeHidden: true });
  assert.deepEqual(model.displayCoverage, {
    total: 1500,
    displayed: 1500,
    omitted: 0,
    omittedTypes: {},
    omittedHidden: 96,
    omittedFiltered: 1,
    omittedBlockInternal: 14,
    hiddenLayers: [{ path: '기존::기초', count: 96 }],
  });
  assert.equal(model.layers.length, 3);
  assert.equal(model.layers[2].objectCount, 0, 'empty layers are listed');
});

test('a display sync without a scope sends no filter and an older plugin needs no survey', async () => {
  const params = [];
  const model = await readScenePages(async ({ offset, limit, ...rest }) => {
    params.push(rest);
    return page([object()], 0, 1);
  });
  assert.deepEqual(params, [{}]);
  assert.deepEqual(model.displayCoverage, { total: 1, displayed: 1, omitted: 0, omittedTypes: {} });
  assert.equal(model.layers, undefined);
});

test('a survey whose listed count is not the page total is an invalid reply', async () => {
  await assert.rejects(
    readScenePages(async () => page([object()], 0, 1, survey(2))),
    { code: 'HOST_INVALID_RESPONSE' },
  );
});

test('withSurvey merges a Live Sync survey and keeps row coverage without one', () => {
  const merged = withSurvey(
    { scene: page([object()], 0, 1).scene },
    { coverage: survey(1).coverage, layers: survey(1).layers },
  );
  assert.equal(merged.displayCoverage.omittedHidden, 96);
  assert.equal(merged.layers.length, 3);
  const plain = withSurvey({ scene: [] }, {});
  assert.deepEqual(plain.displayCoverage, { total: 0, displayed: 0, omitted: 0, omittedTypes: {} });
  assert.equal('layers' in plain, false);
});
