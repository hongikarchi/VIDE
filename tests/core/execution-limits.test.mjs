import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationTurnLimits,
  executionLimits,
  executionLimitsSchema,
  requestLimits,
} from '../../src/contracts/execution-limits.ts';
import { initial, packet, failedRequestDraft } from '../../src/ui/model.ts';
import { draftSnapshot, restoreDraft } from '../../src/ui/draft-storage.ts';
import { interventionInput } from '../../src/core/intervention.ts';
import { Execution } from '../../src/server/execution.ts';

const limits = { maxToolCalls: 8, maxHostCommands: 3, timeoutSeconds: 60 };
test('execution limits preserve legacy defaults, reject unsafe boundaries and survive draft/intervention restore', () => {
  assert.equal(executionLimits({}).maxToolCalls, 30);
  assert.equal(executionLimits({ linkedTargets: [] }).maxToolCalls, 60);
  for (const invalid of [
    { maxToolCalls: 101 },
    { maxHostCommands: 49 },
    { timeoutSeconds: 29 },
    { maxToolCalls: 1.5 },
  ])
    assert.equal(executionLimitsSchema.safeParse({ ...limits, ...invalid }).success, false);
  const state = { ...initial(), body: 'Read', executionLimits: limits };
  const input = { ...packet(state), id: 'original' };
  assert.deepEqual(input.executionLimits, limits);
  assert.deepEqual(restoreDraft(draftSnapshot(state), []).executionLimits, limits);
  assert.deepEqual(failedRequestDraft(state, { state: 'failed', input }).executionLimits, limits);
  const next = { ...input, id: 'next', body: 'Continue' };
  delete next.executionLimits;
  assert.deepEqual(interventionInput(input, next).executionLimits, limits);
  assert.deepEqual(
    interventionInput(input, { ...next, executionLimits: { ...limits, timeoutSeconds: 90 } })
      .executionLimits,
    { ...limits, timeoutSeconds: 90 },
  );
});
test('request timeout is delivered to the actual provider factory', () => {
  let received;
  const execution = new Execution(
    {},
    {
      providerFactory: (options) => {
        received = options;
        return {};
      },
    },
  );
  execution.provider({ provider: 'codex-cli', executionLimits: limits });
  assert.equal(received.timeoutMs, 60000);
  execution.provider({ provider: 'codex-cli' });
  assert.equal(received.timeoutMs, 180000);
});
test('conversation turns and their question-card answer turns default to the wide turn limits', () => {
  const turn = { maxToolCalls: 100, maxHostCommands: 48, timeoutSeconds: 600 };
  assert.deepEqual(executionLimits({ conversationId: 'c1' }), turn);
  // The answer turn the server submits: same conversation, no host, no explicit limits.
  assert.deepEqual(
    executionLimits({ conversationId: 'c1', permission: 'review', hostUse: 'none' }),
    turn,
  );
  assert.deepEqual(executionLimits({ conversationId: 'c1', linkedTargets: [] }), turn);
  assert.equal(executionLimitsSchema.safeParse(conversationTurnLimits).success, true);
  assert.deepEqual(executionLimits({ conversationId: 'c1', executionLimits: limits }), limits);
  assert.deepEqual(executionLimits({}), requestLimits);
  executionLimits({ conversationId: 'c1' }).maxToolCalls = 1;
  assert.equal(conversationTurnLimits.maxToolCalls, 100);
  let received;
  new Execution({}, { providerFactory: (options) => ((received = options), {}) }).provider({
    provider: 'claude-cli',
    conversationId: 'c1',
  });
  assert.equal(received.timeoutMs, 600000);
});
