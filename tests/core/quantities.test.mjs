import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantities, quantitiesCsv } from '../../src/core/quantities.ts';
const request = {
  id: 'candidate-a',
  createdAt: '2026-09-20',
  result: {
    hostExecuted: true,
    host: 'rhino',
    objects: [
      { id: 'a', name: '=SUM(1,2)', kind: 'polyline' },
      { id: 'b', name: 'Unknown', kind: 'native' },
    ],
    scene: [
      { id: 'a', line: [0, 0, 0, 3, 4, 0], area: 12, volume: null },
      { id: 'b', area: null, volume: null },
    ],
  },
};
test('quantities keep unknown measurements separate and calculate native line length', () => {
  const table = quantities(request);
  assert.equal(table.rows[0].length, 5);
  assert.deepEqual(table.totals.area, { value: 12, known: 1, unknown: 1 });
  assert.equal(table.totals.volume.known, 0);
  assert.equal(table.scope, 'candidate');
  assert.throws(() => quantities({ result: { hostExecuted: false } }), { code: 'NOT_FOUND' });
});
test('a parent layer filter takes its Rhino sublayers, not layers that only share a prefix', () => {
  const sample = structuredClone(request);
  const encode = (text) => Buffer.from(text).toString('base64');
  sample.result.scene[0].layer64 = encode('Bldg::L1::Walls');
  sample.result.scene[1].layer64 = encode('Bldg2');
  const ids = (layer) => quantities(sample, { layer }).rows.map((row) => row.id);
  assert.deepEqual(ids('Bldg'), ['a']);
  assert.deepEqual(ids('Bldg::L1'), ['a']);
  assert.deepEqual(ids('Bldg::L1::Walls'), ['a']);
  assert.deepEqual(ids('Bldg2'), ['b']);
});
test('CSV protects formulas and includes units and immutable candidate basis', () => {
  const csv = quantitiesCsv(quantities(request));
  assert.ok(csv.includes('"\'=SUM(1,2)"'));
  assert.ok(csv.includes('candidate-a'));
  assert.ok(csv.includes('기하 면적 (m²)'));
  assert.ok(csv.includes('미상'));
  assert.ok(csv.startsWith('\ufeff'));
});

test('saved filters are recalculated against each candidate and retain unknown groups', () => {
  const sample = structuredClone(request);
  sample.result.scene[0].layer64 = Buffer.from('Site').toString('base64');
  const query = { search: '', type: 'polyline', layer: 'Site', groupBy: 'layer' };
  const table = quantities(sample, query);
  assert.equal(table.rows.length, 1);
  assert.equal(table.groups[0].key, 'Site');
  assert.equal(table.groups[0].totals.area.value, 12);
  const next = structuredClone(sample);
  next.id = 'next';
  next.result.objects.push({ id: 'new', name: 'New boundary', kind: 'polyline' });
  next.result.scene.push({
    id: 'new',
    area: 8,
    length: 10,
    layer64: Buffer.from('Site').toString('base64'),
  });
  const updated = quantities(next, query);
  assert.equal(updated.rows.length, 2);
  assert.equal(updated.groups[0].totals.area.value, 20);
  assert.equal(table.rows.length, 1);
  assert.ok(quantitiesCsv(updated).includes('그룹 합계'));
  assert.equal(quantities(sample, { search: 'absent' }).totals.count, 0);
  assert.throws(() => quantities(sample, { groupBy: 'arbitrary-field' }), {
    code: 'INVALID_INPUT',
  });
});
test('native exact length is preferred and legacy sampled native curves are not claimed as measurements', () => {
  const sample = structuredClone(request);
  sample.result.objects[0].kind = 'native';
  sample.result.scene[0].length = 5.2;
  assert.equal(quantities(sample).rows[0].length, 5.2);
  delete sample.result.scene[0].length;
  assert.equal(quantities(sample).rows[0].length, null);
});
test('object scope uses identity, composes filters and never widens a missing selection', () => {
  const table = quantities(request, { objectId: 'a' });
  assert.equal(table.rows.length, 1);
  assert.equal(table.totals.area.value, 12);
  assert.equal(table.available.objects.length, 2);
  assert.equal(table.query.objectId, 'a');
  assert.equal(quantities(request, { objectId: 'missing' }).rows.length, 0);
  assert.equal(quantities(request, { objectId: 'a', search: 'Unknown' }).rows.length, 0);
  assert.throws(() => quantities(request, { objectId: ['a'] }), { code: 'INVALID_INPUT' });
  assert.equal(quantitiesCsv(table).includes('"Unknown"'), false);
});
