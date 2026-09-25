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
