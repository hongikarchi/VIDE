import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelContext } from '../../src/server/model-context.ts';
import { buildPacket } from '../../src/ai/claude-cli.ts';

test('large model context prioritizes pins without sending meshes or changing the source', () => {
  const objects = Array.from({ length: 10000 }, (_, i) => ({
    id: `object-${i}`,
    name: `건물 ${i}`,
    kind: 'native',
    origin: [i, 0, 0],
    nativeId: `native-${i}`,
    points: Array(1000).fill([0, 0, 0]),
  }));
  const scene = objects.map(({ id }) => ({
    id,
    volume: 24,
    layer64: Buffer.from('검토').toString('base64'),
    vertices: [1, 2, 3],
    attributes64: [['secret', 'secret']],
  }));
  const items = modelContext({ objects, scene }, ['object-9999']);
  const result = items[0].data;
  assert.equal(result[0].id, 'object-9999');
  assert.equal(result.length, 100);
  assert.equal(result[0].points, undefined);
  assert.equal(items[1].data[0].layer, '검토');
  assert.equal(items[1].data[0].volume, 24);
  assert.equal(items[1].data[0].vertices, undefined);
  assert.equal(items[1].data[0].attributes64, undefined);
  assert.equal(items[2].data.total, 10000);
  assert.equal(items[2].data.omitted, 9900);
  assert.equal(items[2].data.geometryDetailsIncluded, false);
  const packet = buildPacket({
    goal: 'Review',
    items,
    includedIds: items.map((x) => x.id),
    revision: 1,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(packet.packet)) < 66 * 1024);
  assert.equal(objects[0].points.length, 1000);
  assert.equal(objects.length, 10000);
});

test('byte cap uses UTF-8 bytes and truthfully counts oversized omitted rows', () => {
  const objects = Array.from({ length: 500 }, (_, i) => ({
    id: `${i}`,
    name: '가'.repeat(1000),
    kind: 'native',
  }));
  objects[0].name = '가'.repeat(64000);
  const items = modelContext({ objects }, ['499', '0']);
  assert.equal(items[0].data[0].id, '499');
  assert.equal(
    items[0].data.some((x) => x.id === '0'),
    false,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(items[0].data)) +
      Buffer.byteLength(JSON.stringify(items[1].data)) <=
      65536,
  );
  assert.equal(items[2].data.omitted, 500 - items[0].data.length);
  assert.match(items[2].data.instruction, /Never infer omitted/);
});

test('empty and missing scene context remains explicit without inventing quantities', () => {
  assert.equal(modelContext(undefined, [])[2].data.total, 0);
  const items = modelContext({ objects: [{ id: 'a', name: 'A', kind: 'native' }] }, []);
  assert.deepEqual(items[1].data, []);
  assert.equal(items[2].data.omitted, 0);
});
