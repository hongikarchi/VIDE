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
    { body: ' ' },
  ]) {
    assert.equal(requestInputSchema.safeParse({ ...input(), ...change }).success, false);
  }
});
test('shared boundary preserves additive metadata and explicit new-work basis', () => {
  const original = {
    ...input(),
    baseRequestId: null,
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
