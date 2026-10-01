import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveRegions,
  referenceBoardInputSchema,
  regionLetter,
} from '../../src/contracts/reference-board.ts';
import {
  addRegion,
  addShape,
  badgeAnchor,
  commit,
  createHistory,
  deleteRegion,
  maskState,
  negligible,
  rectShape,
  redo,
  regionLayers,
  setNote,
  shapePath,
  thin,
  toImage,
  undo,
} from '../../src/ui/reference-mask.ts';

// The region editor's model (SPEC-09.3, PLAN-26 T-090 (a)): letters, history, coordinates.
const brush = (points, width = 0.02) => ({ kind: 'brush', width, points });

test('region letters run A…Z, then AA, AB… without a count limit', () => {
  assert.equal(regionLetter(0), 'A');
  assert.equal(regionLetter(25), 'Z');
  assert.equal(regionLetter(26), 'AA');
  assert.equal(regionLetter(27), 'AB');
  assert.equal(regionLetter(51), 'AZ');
  assert.equal(regionLetter(52), 'BA');
  assert.equal(regionLetter(701), 'ZZ');
  assert.equal(regionLetter(702), 'AAA');
  assert.throws(() => regionLetter(-1));
  // Thirty regions in a row: every letter differs and the 27th is AA.
  let state = maskState({ regions: [], nextIndex: 0 });
  for (let i = 0; i < 30; i++) state = addShape(addRegion(state), brush([i / 30, 0.5]));
  const letters = state.regions.map((region) => region.letter);
  assert.equal(new Set(letters).size, 30);
  assert.equal(letters[26], 'AA');
  assert.equal(letters[29], 'AD');
  assert.ok(
    referenceBoardInputSchema.safeParse({
      regions: state.regions,
      nextIndex: state.nextIndex,
      stage: 'mask',
    }).success,
  );
});

test('drawing with no region starts A; a deleted letter is not used again', () => {
  let state = maskState({ regions: [], nextIndex: 0 });
  // An eraser stroke with nothing to erase does nothing.
  assert.equal(addShape(state, { kind: 'erase', width: 0.02, points: [0.5, 0.5] }), state);
  state = addShape(state, brush([0.1, 0.1, 0.2, 0.2]));
  assert.deepEqual(
    state.regions.map((region) => [region.letter, region.shapes.length]),
    [['A', 1]],
  );
  assert.equal(state.active, 'A');
  state = addShape(state, rectShape([0.3, 0.3], [0.2, 0.1]));
  assert.equal(state.regions[0].shapes.length, 2, 'a stroke adds to the current region');
  state = addShape(addRegion(state), brush([0.6, 0.6]));
  state = deleteRegion(state, 'A');
  assert.equal(state.active, 'B');
  state = addRegion(state);
  assert.deepEqual(
    state.regions.map((region) => region.letter),
    ['B', 'C'],
  );
  state = setNote(state, 'B', '  루버  간격과\n깊이만 ');
  assert.equal(state.regions[0].note, ' 루버 간격과 깊이만 ');
});

test('undo and redo step through strokes, regions and notes', () => {
  let history = createHistory(maskState({ regions: [], nextIndex: 0 }));
  history = commit(history, addShape(history.present, brush([0.1, 0.1, 0.4, 0.4])));
  history = commit(history, addShape(history.present, rectShape([0.5, 0.5], [0.9, 0.8])));
  history = commit(history, addRegion(history.present));
  history = commit(history, setNote(history.present, 'B', '차양'));
  assert.equal(history.present.regions.length, 2);
  history = undo(history);
  assert.equal(history.present.regions[1].note, '');
  history = undo(undo(history));
  assert.equal(history.present.regions.length, 1);
  assert.equal(history.present.regions[0].shapes.length, 1);
  history = redo(history);
  assert.equal(history.present.regions[0].shapes.length, 2);
  // A new step after undo drops what could be redone.
  history = commit(history, deleteRegion(history.present, 'A'));
  assert.equal(history.future.length, 0);
  assert.equal(redo(history), history);
  assert.equal(undo(createHistory(history.present)).present, history.present);
});

test('screen points become image fractions; shapes draw in image pixels', () => {
  const box = { left: 100, top: 50, width: 400, height: 200 };
  assert.deepEqual(toImage(300, 150, box), [0.5, 0.5]);
  assert.deepEqual(toImage(100, 50, box), [0, 0]);
  // Far outside clamps a little past the edge.
  assert.deepEqual(toImage(-1000, 5000, box), [-0.05, 1.05]);
  assert.deepEqual(rectShape([0.8, 0.9], [0.2, 0.1]), {
    kind: 'rect',
    x: 0.2,
    y: 0.1,
    w: 0.6000000000000001,
    h: 0.8,
  });
  assert.equal(negligible(rectShape([0.5, 0.5], [0.501, 0.7])), true);
  assert.equal(shapePath(rectShape([0, 0], [0.5, 0.5]), 800, 600).d, 'M0 0h400v300h-400Z');
  const stroke = shapePath(brush([0.5, 0.5], 0.01), 800, 600);
  assert.equal(stroke.stroke, 8, 'brush width is a fraction of the long side');
  assert.equal(stroke.d, 'M400 300L400 300', 'a single point is a dot');
  assert.equal(
    shapePath({ kind: 'lasso', points: [0, 0, 1, 0, 1, 1] }, 10, 10).d,
    'M0 0L10 0L10 10Z',
  );
  // Thinning keeps the ends and drops points closer than the step.
  assert.deepEqual(
    thin([0, 0, 0.001, 0, 0.002, 0, 0.1, 0, 0.1005, 0, 0.2, 0], 0.01),
    [0, 0, 0.1, 0, 0.2, 0],
  );
});

test('erasers apply to what the region drew before them; letters sit at the top-left', () => {
  const region = {
    letter: 'A',
    note: '',
    shapes: [
      brush([0.4, 0.4, 0.6, 0.6]),
      { kind: 'erase', width: 0.05, points: [0.5, 0.5] },
      rectShape([0.2, 0.3], [0.3, 0.35]),
    ],
  };
  assert.deepEqual(
    regionLayers(region).map((layer) => [layer.paint.length, layer.erase.length]),
    [
      [1, 1],
      [1, 0],
    ],
  );
  const [x, y] = badgeAnchor(region);
  assert.ok(Math.abs(x - 0.2) < 1e-9 && Math.abs(y - 0.3) < 1e-9);
  // No region drawn: the whole image is region A (SPEC-09.3 4).
  assert.deepEqual(
    effectiveRegions([{ letter: 'B', note: '', shapes: [] }]).map((r) => [r.letter, r.whole]),
    [['A', true]],
  );
  assert.deepEqual(badgeAnchor({ shapes: [] }), [0.03, 0.04]);
});
