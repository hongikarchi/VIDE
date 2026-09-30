import assert from 'node:assert/strict';
import test from 'node:test';
import { factCitations } from '../../src/server/jig-gates.ts';
import { factRefIds } from '../../src/jigs/knowledge.ts';
import { statementOf } from '../../src/ui/jig-panel/registry.ts';

// SPEC-08.7 citation gate on a turn's answer, and the basis references the chip and the engine read
// (SPEC-08.6): the same `S<n>` forms on both sides.

test('fact citations: only statements a tool returned this turn pass; others are marked', () => {
  const returned = new Map([
    [1, 'confirmed'],
    [2, 'unconfirmed'],
  ]);
  assert.deepEqual(factCitations('인용 없음', returned), {});

  const ok = factCitations('경간 13 m 이하 [S1], 미확정 [S2]', returned);
  assert.equal(ok.text, undefined);
  assert.deepEqual(ok.factCheck.cited, [1, 2]);
  assert.deepEqual(ok.factCheck.unconfirmed, [2]);
  assert.equal(ok.factCheck.ok, true);

  const bad = factCitations('근거 [S1] [S9]', returned);
  assert.equal(bad.factCheck.ok, false);
  assert.deepEqual(bad.factCheck.unknown, [9]);
  assert.match(bad.text, /^근거 \[S1\] \[S9\]\n\n⚠ 확인되지 않은 인용: S9\./);

  // No tool call this turn: every citation is unverified.
  assert.deepEqual(factCitations('[S3]', undefined).factCheck.unknown, [3]);
  assert.deepEqual(factCitations('[S4]', new Map([[4, 'rejected']])).factCheck.excluded, [4]);
});

test('basis references: chip and engine read the same statement forms', () => {
  for (const ref of ['S12', 's12', '12', 'statement:12'])
    assert.equal(
      statementOf({ by: 'default', basis: { status: 'confirmed', factRefs: [ref] } }),
      12,
    );
  assert.deepEqual(factRefIds({ factRefs: ['S12', 'statement:13', 'x'] }), [12, 13]);
  assert.deepEqual(factRefIds({ statementId: -1 }), []);
  // A value set from a fact rests on that statement before the declared basis of the default.
  assert.equal(
    statementOf({ by: 'fact', ref: 'S7', basis: { status: 'confirmed', factRefs: ['S1'] } }),
    7,
  );
  assert.equal(statementOf({ by: 'user', basis: { status: 'assumed' } }), undefined);
});
