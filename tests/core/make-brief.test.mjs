import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  briefPlan,
  briefPrompt,
  briefReady,
  emptyBrief,
  emptyParam,
  emptyStep,
  phaseOf,
  planOf,
  untouched,
} from '../../src/ui/make-brief.ts';

// PLAN-40 T-185: the 시작 양식 of a new jig, its first turn and the plan card before writing.

test('only the purpose is required', () => {
  assert.equal(briefReady(emptyBrief()), false);
  assert.equal(briefReady({ ...emptyBrief(), purpose: '   ' }), false);
  assert.equal(briefReady({ ...emptyBrief(), purpose: '격자 기둥 배치' }), true);
  assert.equal(emptyBrief().start, 'blank');
});

test('the first turn asks for the plan only and names the empty parts as assumptions', () => {
  const text = briefPrompt({ ...emptyBrief(), purpose: '격자 기둥 배치' });
  assert.match(text, /■ 목적: 격자 기둥 배치/);
  assert.match(text, /코드와 파일을 쓰지 말고/);
  assert.match(text, /\[만들기 시작\]/);
  assert.equal((text.match(/가정으로 채워 주세요/g) ?? []).length, 7);
  assert.match(text, /시작점: 빈 초안에서/);
});

test('the filled form reads as sentences; empty table rows are left out', () => {
  const text = briefPrompt({
    ...emptyBrief(),
    purpose: '신설 이음 선마다 양쪽 기둥 확인',
    when: '도면을 넘기기 전에',
    inputs: ['layers', 'zone'],
    layerShapes: ['곡선'],
    zoneShapes: ['폴리곤'],
    params: [
      { ...emptyParam(), name: '쌍기둥 간격', value: '0.6', min: '0.3', max: '1.2' },
      emptyParam(),
    ],
    steps: [{ ...emptyStep(), name: '이음 선 찾기', by: 'library', note: '선 교차' }, emptyStep()],
    outputs: ['preview', 'extrude', 'textdot', 'report'],
    checks: [{ text: '간격 ≤ 1.2 m', level: 'warn' }],
    start: 'example-grid',
  });
  assert.match(text, /- 호스트 레이어 \[sync-layers\]: 곡선/);
  assert.match(text, /- 사람이 그리는 구역 \[zone\]: 폴리곤/);
  assert.match(text, /- 쌍기둥 간격 · 길이 \(m\) · 기본값 0\.6m · 범위 0\.3~1\.2 · 근거 가정/);
  assert.match(text, /1\. 이음 선 찾기 · 맡는 쪽 라이브러리 · 선 교차/);
  assert.doesNotMatch(text, /^2\. /m);
  assert.match(text, /- Rhino에 만들기: 기둥 돌출·문자점/);
  assert.match(text, /- 간격 ≤ 1\.2 m \(어기면 주의\)/);
  assert.match(text, /본보기\(격자 예제\)/);
});

test('the plan card before writing follows the form', () => {
  const items = briefPlan({
    ...emptyBrief(),
    purpose: '격자 기둥 배치',
    inputs: ['zone'],
    params: [emptyParam()],
  });
  assert.deepEqual(
    items.map((item) => [item.title, item.done]),
    [
      ['목적 · 격자 기둥 배치', true],
      ['입력 1개', true],
      ['설정값 · AI가 가정', false],
      ['단계 · AI가 가정', false],
      ['결과 · AI가 가정', false],
      ['통과 조건 · AI가 가정', false],
      ['작성·시험 ([만들기 시작] 뒤)', false],
    ],
  );
  assert.equal(items.at(-1).current, true);
});

test("the starting point's files are not 작성 or done before writing starts", () => {
  const createdAt = '2026-10-06T01:00:00.000Z';
  const detail = {
    draft: { id: 'd', name: 'x', createdAt },
    manifest: {
      inputs: [],
      params: [{ key: 'count' }],
      steps: [{ id: 'main', kind: 'code' }],
    },
    files: [
      { path: 'jig.json', updatedAt: '2026-10-06T02:00:00.000Z' },
      { path: 'panel.json', updatedAt: createdAt },
      { path: 'steps/main.ts', updatedAt: createdAt },
      { path: 'fixtures/basic/input.json', updatedAt: createdAt },
    ],
  };
  assert.equal(untouched(detail), true);
  assert.equal(phaseOf(detail), '계획');
  assert.ok(planOf(detail).every((item) => !item.done));
  // [만들기 시작] sent: the files count.
  assert.equal(phaseOf(detail, true), '작성');
  assert.ok(planOf(detail, { writing: true }).some((item) => item.done));
  // The form's plan while not writing.
  const brief = { ...emptyBrief(), purpose: '격자' };
  assert.equal(planOf(detail, { writing: false, brief })[0].title, '목적 · 격자');
  // A file written after the start: writing has begun.
  const written = {
    ...detail,
    files: [...detail.files, { path: 'steps/more.ts', updatedAt: '2026-10-06T01:05:00.000Z' }],
  };
  assert.equal(untouched(written), false);
  assert.equal(phaseOf(written), '작성');
  // Unknown times count as written (the old behaviour).
  assert.equal(phaseOf({ ...detail, draft: { id: 'd', name: 'x' } }), '작성');
});
