import test from 'node:test';
import assert from 'node:assert/strict';
import { requestInputSchema } from '../../src/contracts/workspace.ts';
const input = () => ({
  id: 'job-1',
  body: 'test',
  permission: 'review',
  provider: 'codex-cli',
  pins: [],
  sketches: [],
  files: [],
});
test('shared request boundary rejects invalid coordinates, oversized content and unsafe extension permissions', () => {
  for (const points of [
    [
      [0, Infinity],
      [1, 2],
    ],
    [
      [0, 100001],
      [1, 2],
    ],
    [[0], [1, 2]],
  ]) {
    assert.equal(
      requestInputSchema.safeParse({
        ...input(),
        sketches: [{ plane: 'XY', unit: 'm', role: 'path', points }],
      }).success,
      false,
    );
  }
  for (const change of [
    { body: 'x'.repeat(20001) },
    { files: [{ name: 'a', text: 'x'.repeat(50001) }] },
    { provider: 'extension', permission: 'candidate', extension: 'test', extensionVersion: '1' },
    { model: '../injected' },
    { effort: 'invented' },
    { host: 'wrong' },
    { baseRequestId: '../other' },
    { conversationId: '../other' },
    { conversationId: '' },
    { body: ' ' },
  ]) {
    assert.equal(requestInputSchema.safeParse({ ...input(), ...change }).success, false);
  }
});
test('shared boundary preserves additive metadata and explicit new-work basis', () => {
  const original = {
    ...input(),
    baseRequestId: null,
    // The conversation a turn belongs to (SPEC-02.19); absent means the default conversation.
    conversationId: '6ab830a9-bf65-4bfe-949b-aeb7d3ca7c38',
    model: 'claude-fable-5-1[1m]',
    files: [{ name: 'a', text: 'content', contentStatus: 'included' }],
    source: 'document',
  };
  assert.deepEqual(requestInputSchema.parse(original), original);
  assert.equal(
    requestInputSchema.safeParse({
      ...input(),
      provider: 'extension',
      extension: 'test',
      extensionVersion: '1',
    }).success,
    true,
  );
});

test('brush sketches carry world XYZ strokes while plane sketches stay valid', () => {
  const sketches = requestInputSchema.shape.sketches;
  const plane = {
    plane: 'XY',
    unit: 'm',
    role: 'boundary',
    points: [
      [0, 0],
      [1, 2],
    ],
  };
  const stroke = {
    points: [
      [0, 0, 3],
      [1, 2, 3.5],
    ],
    color: '#d0473a',
    width: 4,
  };
  const brush = { unit: 'm', role: 'path', placement: 'surface', strokes: [stroke] };
  assert.ok(sketches.safeParse([plane, brush]).success);
  assert.ok(
    sketches.safeParse([{ ...brush, placement: 'plane', plane: 'XZ', planeOffset: 2.5 }]).success,
  );
  const long = Array.from({ length: 2000 }, (_, i) => [i, 0, 0]);
  for (const invalid of [
    { ...brush, strokes: [] },
    { ...brush, placement: 'free' },
    { ...brush, strokes: [{ ...stroke, points: [[0, 0, 0]] }] },
    { ...brush, strokes: [{ ...stroke, color: 'red' }] },
    {
      ...brush,
      strokes: [
        {
          ...stroke,
          points: [
            [0, 0, Infinity],
            [1, 1, 1],
          ],
        },
      ],
    },
    { ...brush, strokes: Array.from({ length: 11 }, () => ({ ...stroke, points: long })) },
    {
      unit: 'm',
      role: 'path',
      points: [
        [0, 0],
        [1, 1],
      ],
    },
  ])
    assert.equal(sketches.safeParse([invalid]).success, false);
});
