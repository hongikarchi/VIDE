import { compare } from '../../tools/spikes/2026-09-25-decision-layer/compare.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  evaluate,
  recommend,
  validateCases,
} from '../../tools/spikes/2026-09-25-decision-layer/evaluate.mjs';
const cases = JSON.parse(
  await readFile(
    new URL('../../tools/spikes/2026-09-25-decision-layer/cases.json', import.meta.url),
    'utf8',
  ),
);
test('offline evaluation never treats provisional labels or rule timing as product acceptance', () => {
  const result = evaluate(cases);
  assert.equal(result.length, 2);
  for (const row of result) {
    assert.equal(row.count, 60);
    assert.equal(row.adoptionEligible, false);
    assert.equal(row.endToEndLatency, null);
  }
  const leaked = structuredClone(cases);
  leaked[0].split = 'evaluation';
  assert.throws(() => validateCases(leaked), /FAMILY_LEAKAGE/);
});
test('explicit effort wins and uncertain inputs abstain', () => {
  assert.equal(recommend({ explicitEffort: 'max', untrustedInstruction: true }).effort, 'max');
  assert.equal(recommend({ ambiguous: true }).effort, null);
  assert.equal(recommend({ untrustedInstruction: true }).effort, null);
});

test('comparison requires paired end-to-end observations, reviewed labels and no safety failures', () => {
  const records = Array.from({ length: 60 }, (_, i) =>
    ['baseline', 'candidate'].map((variant) => ({
      caseId: String(i),
      variant,
      success: true,
      safetyFailure: false,
      durationMs: variant === 'baseline' ? 100 : 80,
      providerCalls: 1,
      inputTokens: null,
      externalCost: null,
      version: 'synthetic',
    })),
  ).flat();
  assert.equal(compare({ labelsReviewed: false, records }).criteriaMet, false);
  const result = compare({ labelsReviewed: true, records });
  assert.equal(result.criteriaMet, true);
  assert.equal(result.adoptionApproved, false);
  assert.equal(result.unknownCost, true);
  records[1].safetyFailure = true;
  assert.equal(compare({ labelsReviewed: true, records }).criteriaMet, false);
  assert.throws(() => compare({ labelsReviewed: true, records: records.slice(1) }), /UNPAIRED/);
});
