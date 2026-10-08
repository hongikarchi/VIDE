// 법규 체크 화면의 순수 부분 (PLAN-48 T-239, SPEC-15.9·15.11·15.12·15.13, Design SCR-32): the
// panel.json passes the part check against the declared names of `vide/compliance-check` (PLAN-48
// T-238), the result is drawn only when it passes the contract, rounding never hides a 위반, the
// head never says '위반 없음' over rows that are not 적합, '다시 체크 필요' says why, exports are off
// while stale, and the CSV and report carry every check with their 근거 and the notice.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { complianceResultSchema, COMPLIANCE_CHECKS } from '../../src/contracts/compliance.ts';
import { validatePanel } from '../../src/ui/jig-panel/spec.ts';
import {
  envelopeItems,
  exceedanceItems,
  exportBlock,
  exportName,
  headline,
  orderedItems,
  pairText,
  readResult,
  reportHtml,
  resultCsv,
  rowObjects,
  rowTexts,
  safeLink,
  staleReasons,
} from '../../src/ui/compliance/model.ts';
import { complianceFixture, LINK, OBJ } from '../fixtures/compliance-result.mjs';

const PANEL = join(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'jigs',
  'official',
  'jigs',
  'compliance-check',
  'panel.json',
);
const panel = JSON.parse(readFileSync(PANEL, 'utf8'));
// The names PLAN-48 T-238 declares for `vide/compliance-check` 0.1.0.
const scope = {
  steps: ['check'],
  params: [
    'groundLevel',
    'groundBasis',
    'exclusionsComplete',
    'noneParking',
    'noneLandscape',
    'noneOpenSpace',
    'includeHidden',
  ],
  inputs: ['model', 'limits', 'siteModel'],
};
const fixture = () => complianceFixture();
const parsed = () => complianceResultSchema.parse(fixture());

test('the 법규 체크 panel uses only registered parts in their places and the declared names', () => {
  const checked = validatePanel(panel, scope);
  assert.deepEqual(checked.issues, []);
  assert.deepEqual(
    checked.spec.left.map((p) => p.part),
    ['jig-source', 'jig-source', 'compliance-roles', 'param-group', 'compliance-run'],
  );
  assert.equal(checked.spec.center.kpis.part, 'compliance-summary');
  assert.equal(checked.spec.drawer.part, 'compliance-result');
  // A binding to a step the jig does not declare, and a part out of its place, are refused.
  const wrong = structuredClone(panel);
  wrong.drawer.from = 'step.verdict';
  assert.deepEqual(
    validatePanel(wrong, scope).issues.map((i) => i.code),
    ['PANEL_BINDING'],
  );
  const placed = structuredClone(panel);
  placed.left.push({ part: 'compliance-result', from: 'step.check' });
  assert.deepEqual(
    validatePanel(placed, scope).issues.map((i) => i.code),
    ['PANEL_PART_PLACE'],
  );
  const extra = structuredClone(panel);
  extra.center.kpis.color = 'red';
  assert.deepEqual(
    validatePanel(extra, scope).issues.map((i) => i.code),
    ['PANEL_PROPERTY'],
  );
});

test('the screen draws a result only when it passes the contract', () => {
  assert.equal(readResult(undefined).kind, 'none');
  assert.equal(readResult(null).kind, 'none');
  const ok = readResult(fixture());
  assert.equal(ok.kind, 'ok');
  // A row that says 적합 without a limit is not drawn as a verdict.
  const broken = fixture();
  broken.items[0] = { ...broken.items[0], limit: null };
  const bad = readResult(broken);
  assert.equal(bad.kind, 'invalid');
  assert.ok(bad.issues.length > 0);
});

test('rows come in the check-list order with their table numbers', () => {
  const rows = orderedItems(parsed());
  assert.equal(rows.length, COMPLIANCE_CHECKS.length - 1, 'one check is 미적용');
  assert.deepEqual(
    rows.map((r) => r.no),
    rows.map((_, i) => i + 1),
  );
  assert.deepEqual(
    rows.slice(0, 3).map((r) => r.id),
    ['coverage', 'far', 'height:heightMax'],
  );
  const groups = rows.map((r) => r.group);
  assert.deepEqual([...new Set(groups)], ['규모', '형상 제한', '주차·조경·공개공지']);
});

test('rounding never makes a 위반 read as 계획 = 한계 (SPEC-15.9 8)', () => {
  const height = orderedItems(parsed()).find((r) => r.id === 'height:heightMax');
  const texts = rowTexts(height);
  assert.notEqual(texts.planned, texts.limit);
  assert.equal(texts.planned, '30.004 m');
  assert.equal(texts.limit, '30.000 m');
  assert.equal(texts.margin, '−0.004 m');
  const ratio = pairText({ value: 0.6, unit: '비율' }, { value: 0.6, unit: '비율' });
  assert.equal(ratio.planned, '60.00%');
  assert.equal(ratio.limit, ratio.planned, 'equal values stay equal');
  const close = pairText({ value: 0.600001, unit: '비율' }, { value: 0.6, unit: '비율' });
  assert.notEqual(close.planned, close.limit);
  const coverage = rowTexts(orderedItems(parsed())[0]);
  assert.equal(coverage.margin, '+12.00%p');
  assert.equal(pairText(null, null).planned, '—');
});

test('the head says 위반 없음 only when every row is 적합 and nothing is unconfirmed', () => {
  const result = parsed();
  assert.deepEqual(headline(result), {
    text: '적합 3 · 위반 5 · 판단 필요 2 · 사람 입력 필요 7 · 검사 불가 1 · 미확정 3',
    tone: 'ng',
  });
  // No 위반, but rows that are not 적합: counts only, never a reassuring sentence.
  const noViolation = fixture();
  noViolation.items = noViolation.items.map((item) =>
    item.state === '위반'
      ? { ...item, state: '판단 필요', reason: '경우에 따라 갈림', cases: [], parts: [] }
      : item,
  );
  noViolation.counts = { ...noViolation.counts, 위반: 0, '판단 필요': 7 };
  const head = headline(complianceResultSchema.parse(noViolation));
  assert.equal(head.tone, 'warn');
  assert.doesNotMatch(head.text, /위반 없음/);
  // Every row 적합 but one unconfirmed row: still no '위반 없음'.
  const okRow = (item) => ({
    ...item,
    state: '적합',
    reason: '',
    planned: item.planned ?? { value: 0, unit: '㎥', text: '0' },
    limit: item.limit ?? null,
    cases: [],
    parts: [],
  });
  const allOk = fixture();
  allOk.items = allOk.items
    .filter(
      (i) =>
        i.limit || i.id.startsWith('zone:') || ['sun', 'envelope', 'outside-site'].includes(i.id),
    )
    .map(okRow);
  const kept = new Set(allOk.items.map((i) => i.id));
  allOk.notApplicable = [
    ...allOk.notApplicable,
    ...COMPLIANCE_CHECKS.filter(
      (c) => !kept.has(c) && !allOk.notApplicable.some((n) => n.check === c),
    ).map((c) => ({ check: c, id: c, title: c, basis: '시험' })),
  ];
  allOk.counts = {
    적합: allOk.items.length,
    위반: 0,
    '판단 필요': 0,
    '사람 입력 필요': 0,
    '검사 불가': 0,
  };
  allOk.unconfirmedCount = allOk.items.filter((i) => i.unconfirmed.length).length;
  assert.ok(allOk.unconfirmedCount > 0);
  assert.doesNotMatch(headline(complianceResultSchema.parse(allOk)).text, /위반 없음/);
  allOk.items = allOk.items.map((i) => ({ ...i, unconfirmed: [] }));
  allOk.unconfirmedCount = 0;
  assert.match(headline(complianceResultSchema.parse(allOk)).text, /^위반 없음/);
});

test('다시 체크 필요 names what changed and nothing when nothing did (SPEC-15.13)', () => {
  const result = parsed();
  const same = { instanceId: 'mass-1', at: null, needsRecompute: false, moved: false };
  const site = { instanceId: 'site-1', at: null, needsRecompute: false, moved: false };
  assert.deepEqual(
    staleReasons(result, { rolesVersion: 3, limits: same, siteModel: site }),
    [],
    'up to date',
  );
  assert.deepEqual(staleReasons(result, {}), [], 'nothing known: nothing claimed');
  assert.deepEqual(staleReasons(result, { modelRevisionKey: 'rhino|doc-합성|8' }), [
    'Rhino 모델이 바뀜',
  ]);
  assert.deepEqual(staleReasons(result, { modelRevisionKey: null }), ['모델 판 확인 불가']);
  assert.deepEqual(staleReasons(result, { rolesVersion: 4 }), ['분류가 바뀜']);
  assert.deepEqual(staleReasons(result, { limits: { ...same, moved: true } }), [
    '규제 조건이 바뀜',
  ]);
  assert.deepEqual(staleReasons(result, { limits: { ...same, instanceId: 'mass-2' } }), [
    '규제 조건이 바뀜',
  ]);
  assert.deepEqual(staleReasons(result, { limits: { ...same, needsRecompute: true } }), [
    '규제 조건이 바뀜(건축 가능 영역·매스를 다시 계산)',
  ]);
  assert.deepEqual(staleReasons(result, { siteModel: { ...site, moved: true } }), ['대지가 바뀜']);
  assert.deepEqual(staleReasons(result, { settingsChanged: true, stepStale: true }), [
    '설정값·수정 사항이 바뀜',
  ]);
  assert.deepEqual(staleReasons(result, { stepStale: true }), ['입력이 바뀜']);
});

test('exports wait for a check and for an up-to-date result (SPEC-15.12)', () => {
  assert.match(exportBlock(null, false), /아직 체크하지 않았습니다/);
  assert.equal(exportBlock(parsed(), true), '다시 체크한 뒤 내보낼 수 있습니다');
  assert.equal(exportBlock(parsed(), false), null);
  assert.equal(exportName(parsed()).startsWith('법규-체크-'), true);
});

test('3D: each exceedance once, in document metres, numbered as the table', () => {
  const result = parsed();
  const items = exceedanceItems(result);
  assert.deepEqual(
    items.map((i) => i.label),
    ['1', '2', '3'],
  );
  assert.ok(items.every((i) => i.kind === 'mesh' && i.tone === 'ov-clash'));
  const sun = items[0];
  // display.origin [1000, 2000, 30] + local (0, 18, 21).
  assert.deepEqual(sun.v.slice(0, 3), [1000, 2018, 51]);
  const outline = envelopeItems(result);
  assert.equal(outline.length, 1);
  assert.equal(outline[0].fill, false);
  const bare = complianceResultSchema.parse({ ...fixture(), display: undefined });
  assert.deepEqual(exceedanceItems(bare)[0].v.slice(0, 3), [0, 18, 21], 'local without display');
  assert.deepEqual(envelopeItems(bare), []);
});

test('a row selects its objects and its exceedances’ objects in the read document', () => {
  const result = parsed();
  const envelope = result.items.find((i) => i.id === 'envelope');
  assert.deepEqual(rowObjects(result, envelope), [
    { linkId: LINK, nativeIds: [OBJ.top, OBJ.floor1] },
  ]);
  const open = result.items.find((i) => i.id === 'open-space');
  assert.deepEqual(rowObjects(result, open), []);
});

test('only http(s) 근거 links are opened', () => {
  assert.equal(safeLink('https://law.example/1'), 'https://law.example/1');
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink(null), null);
});

test('CSV: every check once, unrounded values, 근거 and formula-safe cells', () => {
  const csv = resultCsv(parsed());
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(
    lines[0],
    '번호,검사,묶음,상태,계획 값,한계 값,단위,여유,한계 값 확정 상태,출처 구분,근거 조항,이유,미확정 사항',
  );
  assert.equal(lines.length, 1 + COMPLIANCE_CHECKS.length);
  assert.ok(
    lines.some((l) => l.startsWith('3,높이 · 최고 높이,규모,위반,30.004,30,m,-0.004,확정')),
  );
  assert.ok(lines.some((l) => l.includes('시험용 조항 제1조 L3')));
  assert.ok(
    lines.some((l) => l.includes(",'=SUM(1)")),
    'formula kept as words',
  );
  assert.ok(lines.some((l) => l.includes('높이 · 가로구역,규모,미적용 항목')));
});

test('the report is self-contained, escaped, and carries the notice and every part', () => {
  const result = fixture();
  result.items[0].title = '건폐율 <script>alert(1)</script>';
  const html = reportHtml(complianceResultSchema.parse(result));
  assert.ok(html.startsWith('<!doctype html>'));
  assert.doesNotMatch(html, /<script/i, 'no script, the title is escaped');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /javascript:/, 'unsafe links are dropped');
  assert.doesNotMatch(html, /<link|src=/, 'no outside files');
  for (const words of [
    '탐색용 법규 체크 — 인허가 검토·법규 검토를 대체하지 않음',
    '검사 목록 밖의 법규는 보지 않음',
    '초과 부분',
    '미적용 항목',
    '분류 요약',
    '높이 · 가로구역',
    'L3 · L4',
    '경우별 결과',
    '구간별 결과',
    '정북 일조',
    '<span class="tag">가정</span>',
  ])
    assert.ok(html.includes(words), words);
});
