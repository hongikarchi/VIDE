import test from 'node:test';
import assert from 'node:assert/strict';
import { guessRoles } from '../../extensions/jigs/s06-frame/steps/sync-input.ts';

// Role guesses from layer names (PLAN-23 T-044, fixed in PLAN-22 T-043): a basin model whose
// footing blocks sit on a layer named after the column can still be offered as the existing
// footings. The pickers stay explicit; this is only the first guess the person checks.

const structure = {
  syncId: 's',
  document: '구조.3dm',
  layers: [
    { name: '기둥', count: 34, kinds: { curve: 34 } },
    { name: '거더', count: 62, kinds: { curve: 62 } },
    { name: '신설 기초', count: 34, kinds: { block: 34 } },
  ],
};

test('a basin model with its footings on a column layer is picked as existing footings', () => {
  const basin = {
    syncId: 'b',
    document: '토목.3dm',
    layers: [
      { name: '유수지::기둥', count: 176, kinds: { block: 176 } },
      { name: '유수지::보', count: 309, kinds: { mesh: 309 } },
      { name: '유수지::문자', count: 40, kinds: { other: 40 } },
    ],
  };
  assert.deepEqual(guessRoles([structure, basin]), {
    columns: { syncId: 's', layer: '기둥' },
    girders: { syncId: 's', layer: '거더' },
    newFootings: { syncId: 's', layer: '신설 기초' },
    existingFootings: { syncId: 'b', layer: '유수지::기둥' },
    basinGirders: { syncId: 'b', layer: '유수지::보' },
  });
});

test('a real footing layer still wins over the column-named fallback', () => {
  const basin = {
    syncId: 'b',
    document: '토목.3dm',
    layers: [
      { name: 'EX-COLUMN', count: 20, kinds: { block: 20 } },
      { name: 'EX-FOOTING', count: 20, kinds: { block: 20 } },
      { name: 'BASIN-BEAM', count: 9, kinds: { mesh: 9 } },
    ],
  };
  const guess = guessRoles([structure, basin]);
  assert.deepEqual(guess.existingFootings, { syncId: 'b', layer: 'EX-FOOTING' });
  assert.deepEqual(guess.basinGirders, { syncId: 'b', layer: 'BASIN-BEAM' });
});

test('the fallback never takes a column layer of the structure model or a curve layer', () => {
  // Same document as the columns: a block layer named after columns is not an existing footing.
  const twoColumnLayers = {
    ...structure,
    layers: [...structure.layers, { name: '기둥 블록', count: 5, kinds: { block: 5 } }],
  };
  assert.equal(guessRoles([twoColumnLayers]).existingFootings, null);
  // Another document, but curves: not footings either.
  const curves = {
    syncId: 'b',
    document: '토목.3dm',
    layers: [{ name: '기둥', count: 12, kinds: { curve: 12 } }],
  };
  assert.equal(guessRoles([structure, curves]).existingFootings, null);
});
