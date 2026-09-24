import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeEfforts } from '../../src/server/model-capabilities.ts';
test('effort is constrained by explicit model capabilities, unknown aliases use default', () => {
  assert.ok(claudeEfforts('claude-fable-5').includes('xhigh'));
  assert.ok(!claudeEfforts('claude-opus-4-6').includes('xhigh'));
  assert.deepEqual(claudeEfforts('custom-model'), ['default']);
  assert.deepEqual(claudeEfforts('opus'), ['default']);
  assert.deepEqual(claudeEfforts('claude-fable-5[1m]'), claudeEfforts('claude-fable-5'));
});
