// 도면 읽기와 레이어 대응 (SPEC-14.3, PLAN-47 T-227): eligibility (mm only, unitless read as mm),
// the worker answer checked field by field, same-name matching, the person's choices limited to
// layers the drawing has, copying a table to another drawing, and the schema 15 rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DrawingLayerStore,
  copyLayerMap,
  drawingEligibility,
  inspectionOf,
  layerMap,
  targetLayers,
} from '../../src/core/drawing-layers.ts';
import { Store } from '../../src/core/store.ts';
import { schemaVersion } from '../../src/core/migrations.ts';

test('a drawing is a target only when it was read and is in mm (unitless read as mm)', () => {
  assert.deepEqual(drawingEligibility({ error: null, units: 4 }), {
    eligible: true,
    reason: null,
    unitsAssumed: false,
  });
  assert.deepEqual(drawingEligibility({ error: null, units: 0 }), {
    eligible: true,
    reason: null,
    unitsAssumed: true,
  });
  assert.equal(drawingEligibility({ error: null, units: 1 }).reason, 'UNITS_NOT_MM');
  assert.equal(drawingEligibility({ error: null, units: 6 }).reason, 'UNITS_NOT_MM');
  assert.equal(
    drawingEligibility({ error: 'eFileSharingViolation', units: null }).reason,
    'READ_FAILED',
  );
  assert.equal(drawingEligibility({ error: null, units: null }).reason, 'READ_FAILED');
});

test('the worker answer is checked field by field; xref layers are never targets', () => {
  const read = inspectionOf({
    id: 1,
    error: null,
    version: 'AC1032',
    units: 4,
    layers: [
      { name: '0', color: 7, linetype: 'Continuous', lineweight: -3, plot: true },
      { name: 'A-WALL', color: 1, linetype: 'VIDE점선', locked: true },
      { name: 'xref|A-WALL', color: 1, dependent: false },
      { name: '' },
      'junk',
    ],
    textStyles: [{ name: 'Standard', font: 'txt.shx', bigFont: 'whgtxt.shx' }],
    dimStyles: [{ name: 'VIDE치수', textStyle: 'VIDE문자', arrows: ['VIDE틱', 'VIDE틱', '', 'x'] }],
    blocks: [{ name: '도곽', inserts: 1, attributes: true }],
    xrefs: [{ name: 'child', path: '.\\XREF\\child.dwg', overlay: false, status: 'Unresolved' }],
    extra: 'ignored',
  });
  assert.equal(read.layers.length, 3);
  assert.equal(read.layers[1].locked, true);
  assert.equal(read.layers[2].dependent, true, 'a | name is an xref layer');
  assert.deepEqual(targetLayers(read), ['0', 'A-WALL']);
  assert.deepEqual(read.dimStyles[0].arrows, ['VIDE틱', 'VIDE틱', '']);
  assert.equal(read.xrefs[0].inserts, -1);
  assert.ok(!('extra' in read));
});

test('same names map themselves, by full path or last part; choices must exist', () => {
  const drawing = ['0', 'A-WALL', '창호', 'Defpoints'];
  const entries = layerMap(['a-wall', '건축::창호', '구조::기둥', '구조::기둥', '  '], drawing);
  assert.deepEqual(entries, [
    { source: 'a-wall', layer: 'A-WALL', how: 'same' },
    { source: '건축::창호', layer: '창호', how: 'same' },
    { source: '구조::기둥', layer: null, how: 'none' },
  ]);
  const chosen = layerMap(['구조::기둥', 'a-wall'], drawing, {
    '구조::기둥': 'a-wall',
    'a-wall': null,
  });
  assert.deepEqual(chosen, [
    { source: '구조::기둥', layer: 'A-WALL', how: 'user' },
    { source: 'a-wall', layer: null, how: 'user' },
  ]);
  // No layer is ever created in the drawing (SPEC-14.8 3).
  assert.throws(() => layerMap(['구조::기둥'], drawing, { '구조::기둥': '새 레이어' }), {
    code: 'LAYER_NOT_IN_DRAWING',
  });
});

test('copying a table keeps choices the other drawing can take and lists the rest', () => {
  const from = layerMap(['건축::벽', '구조::기둥', '가구', '문'], ['벽', 'S-COL', 'F-FURN', '0'], {
    '구조::기둥': 'S-COL',
    가구: 'F-FURN',
    문: null,
  });
  const { entries, dropped } = copyLayerMap(from, ['벽', 'S-COL', '0'], ['조경']);
  assert.deepEqual(entries, [
    { source: '건축::벽', layer: '벽', how: 'same' },
    { source: '구조::기둥', layer: 'S-COL', how: 'user' },
    { source: '가구', layer: null, how: 'none' },
    { source: '문', layer: null, how: 'user' },
    { source: '조경', layer: null, how: 'none' },
  ]);
  assert.deepEqual(dropped, ['가구']);
});

test('schema 15 keeps one read and one table per drawing path, revisions guard the table', () => {
  assert.equal(schemaVersion, 15);
  const store = new Store(':memory:');
  const project = store.createProject('도면 읽기');
  let tick = 0;
  const layers = new DrawingLayerStore(store, {
    now: () => new Date(Date.UTC(2026, 9, 8, 0, 0, tick++)),
  });
  const read = inspectionOf({ error: null, version: 'AC1027', units: 4, layers: [{ name: '벽' }] });
  layers.saveRead(project.id, {
    path: 'C:\\P\\평면.dwg',
    size: 10,
    mtime: '2026-10-08T00:00:00.000Z',
    sha256: 'a',
    readAt: 'r1',
    read,
  });
  // The same file by another spelling replaces the row.
  layers.saveRead(project.id, {
    path: 'c:/p/평면.DWG',
    size: 11,
    mtime: '2026-10-08T00:00:01.000Z',
    sha256: 'b',
    readAt: 'r2',
    read,
  });
  assert.equal(layers.reads(project.id).length, 1);
  assert.equal(layers.read(project.id, 'C:\\P\\평면.dwg').sha256, 'b');
  const entries = layerMap(['벽'], targetLayers(read));
  const first = layers.saveMap(project.id, 'C:\\P\\평면.dwg', entries, 'b');
  assert.equal(first.revision, 1);
  assert.throws(() => layers.saveMap(project.id, 'C:\\P\\평면.dwg', entries, 'b', 0), {
    code: 'REVISION_CONFLICT',
  });
  assert.equal(layers.saveMap(project.id, 'c:\\p\\평면.dwg', entries, 'b', 1).revision, 2);
  assert.deepEqual(layers.map(project.id, 'C:\\P\\평면.dwg').entries, entries);
  assert.equal(layers.map(project.id, 'C:\\P\\없음.dwg'), null);
  store.close();
});
