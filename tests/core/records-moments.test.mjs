// 시점 형상 (PLAN-53 T-335, ARCH-01 §5 「시점 형상」): moments from linked files' Syncs and 검토본, one
// tick per day, the latest moment per file on or before the cursor date, the basis line. Made-up data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basisText,
  buildMoments,
  localDate,
  momentTicks,
  pickMoments,
} from '../../src/core/records-moments.ts';

const at = (date) => `${date}T12:00:00.000Z`;
const syncs = [
  { requestId: 's1', linkId: 'a', linkName: 'A.3dm', createdAt: at('2026-09-01') },
  { requestId: 's2', linkId: 'a', linkName: 'A.3dm', createdAt: at('2026-09-10') },
  { requestId: 's3', linkId: 'a', linkName: 'A.3dm', createdAt: at('2026-09-20') },
  { requestId: 'c1', linkId: 'b', linkName: 'B.dwg', createdAt: at('2026-09-05') },
  { requestId: 'c0', linkId: 'b', linkName: 'B.dwg', createdAt: at('2026-08-01'), pruned: true },
];
const reviews = [
  { id: 'r1', requestId: 's1', title: 'A안', createdAt: at('2026-09-02') },
  { id: 'r2', requestId: 's2', title: 'B안', createdAt: at('2026-09-12') },
  { id: 'r3', requestId: 'ai-result', title: 'AI 결과', createdAt: at('2026-09-15') },
  { id: 'r4', requestId: 'c0', title: '정리된 것', createdAt: at('2026-09-16') },
];
const latest = new Map([
  ['a', 's3'],
  ['b', 'c1'],
]);

test('moments: pruned Syncs left out; a 검토본 of no linked Sync is a tick only', () => {
  const moments = buildMoments(syncs, reviews);
  assert.equal(localDate(at('2026-09-02')), '2026-09-02');
  assert.deepEqual(
    moments.map((m) => `${m.date}:${m.kind}:${m.linkId ?? '-'}`),
    [
      '2026-09-01:sync:a',
      '2026-09-02:review:a',
      '2026-09-05:sync:b',
      '2026-09-10:sync:a',
      '2026-09-12:review:a',
      '2026-09-15:review:-',
      '2026-09-16:review:-',
      '2026-09-20:sync:a',
    ],
  );
  const ticks = momentTicks(moments);
  assert.equal(ticks.length, 8);
  assert.deepEqual(ticks[1], { date: '2026-09-02', kind: 'review', lines: ['09-02 검토본 · A안'] });
  assert.deepEqual(ticks[2].lines, ['09-05 동기화 · B.dwg']);
  // Same day: one tick, a 검토본 day draws as a 검토본 tick.
  const same = momentTicks(
    buildMoments(
      [{ requestId: 'x', linkId: 'a', linkName: 'A.3dm', createdAt: '2026-10-01T03:00:00.000Z' }],
      [{ id: 'y', requestId: 'x', title: '같은 날', createdAt: '2026-10-01T05:00:00.000Z' }],
    ),
  );
  assert.equal(same.length, 1);
  assert.equal(same[0].kind, 'review');
  assert.deepEqual(same[0].lines, ['10-01 동기화 · A.3dm', '10-01 검토본 · 같은 날']);
});

test('pick: per file the latest moment on or before the date; latest Sync needs no override', () => {
  const moments = buildMoments(syncs, reviews);
  const early = pickMoments(moments, '2026-08-15', latest);
  assert.equal(early.overrides.size, 0);
  assert.equal(early.basis, null);
  assert.equal(basisText(early.basis), '현재 모델 · 부위만 표시');

  const r1 = pickMoments(moments, '2026-09-04', latest);
  assert.deepEqual([...r1.overrides], [['a', 's1']]);
  assert.equal(basisText(r1.basis), '2026-09-02 검토본 기준');
  assert.equal(basisText(r1.basis, true), '2026-09-02 검토본 불러오는 중…');

  const mid = pickMoments(moments, '2026-09-16', latest);
  // B's only moment is its latest Sync: drawn as it is. The tick-only 검토본 change nothing.
  assert.deepEqual([...mid.overrides], [['a', 's2']]);
  assert.equal(basisText(mid.basis), '2026-09-12 검토본 기준');

  const now = pickMoments(moments, '2026-10-15', latest);
  assert.equal(now.overrides.size, 0);
  assert.equal(basisText(now.basis), '2026-09-20 동기화 기준');
});
