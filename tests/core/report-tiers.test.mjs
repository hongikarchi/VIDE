// 보고서 두 등급 (PLAN-54 T-341, SPEC-07.11 두 등급, Design SCR-40): the same report model gives a
// 검토용 page (everything, as before) and a 보고용 page of the chosen sections only — with the
// first-page 가정·미검토 summary and the jig's notices, the 검토용 run it came from in the head,
// and without `[S#]` markers, section ids, settings history, gate ids or buttons. The five report
// frames mark their public sections and still parse. Synthetic values only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseReportTemplate, resolveReport } from '../../src/jigs/runtime/report-format.ts';
import { publicSectionIds, renderReportHtml, stripCitations } from '../../src/core/report-html.ts';
import { renderJigReport } from '../../src/server/report.ts';
import { complianceReportModel, reportHtml } from '../../src/ui/compliance/model.ts';
import { complianceResultSchema } from '../../src/contracts/compliance.ts';
import { complianceFixture } from '../fixtures/compliance-result.mjs';

const INSTANCE = '3f2a9c1e-0000-4000-8000-00000000abcd';
const ctx = () => ({
  outputs: {
    spans: {
      rows: [
        { key: 'G1', span: 7.2, note: '도면 치수 [S1]' },
        { key: 'G2', span: 9.6, note: '실측 [S2, S3]' },
      ],
      over: 1,
    },
  },
  params: { span_max: 8 },
  inputs: {
    settings: [{ title: '경간 상한', value: '8 m', by: '사용자' }],
    counts: { settings: 1 },
  },
  final: { spans: true },
  source: { readAt: '2026-10-15 14:00', statements: { total: 4, confirmed: 2 } },
});
const frame = () => ({
  template: 'study',
  title: '골조 검토',
  eyebrow: '구조 · 합성 예제',
  headline: { cases: [{ template: '보 {step.spans.over}개가 한도 {$span_max} m를 넘습니다.' }] },
  sections: [
    {
      id: 'spans',
      public: true,
      from: ['step.spans'],
      title: { cases: [{ template: '경간 표' }] },
      blocks: [
        {
          kind: 'table',
          from: 'step.spans.rows',
          columns: [
            { field: 'key', label: '보' },
            { field: 'span', label: '경간', unit: 'm', decimals: 1 },
            { field: 'note', label: '근거' },
          ],
        },
      ],
    },
    {
      id: 'mixed',
      public: true,
      from: ['inputs.counts'],
      title: { cases: [{ template: '설정값 {inputs.counts.settings}개' }] },
      blocks: [
        { kind: 'table', from: 'inputs.settings', columns: [{ field: 'title', label: '설정값' }] },
        { kind: 'list', from: 'step.spans.rows', field: 'key', title: '보 목록' },
      ],
    },
    {
      id: 'appendix',
      from: ['inputs.counts'],
      title: { cases: [{ template: '설정값 원장' }] },
      blocks: [
        {
          kind: 'table',
          from: 'inputs.settings',
          columns: [
            { field: 'title', label: '설정값' },
            { field: 'by', label: '누가' },
          ],
        },
      ],
    },
  ],
  assumptions: ['고정하중은 합성 예제 값 [S4]'],
  unchecked: ['지진하중'],
});
const ORIGIN = {
  project: '합성 프로젝트',
  instance: '작업본 1',
  version: '0.1.0',
  at: '2026-10-15 14:20',
};
const RUN = { instanceId: INSTANCE, reportId: 'study', at: '2026-10-15 14:00' };
const model = () => {
  const parsed = parseReportTemplate(frame());
  assert.deepEqual(parsed.issues, []);
  return resolveReport(parsed.template, ctx());
};

test('the frame carries `public` into the model; settings blocks are marked', () => {
  const m = model();
  assert.deepEqual(
    m.sections.map((s) => [s.id, s.public]),
    [
      ['spans', true],
      ['mixed', true],
      ['appendix', false],
    ],
  );
  assert.deepEqual(publicSectionIds(m), ['spans', 'mixed']);
  assert.equal(m.sections[1].blocks[0].settings, true);
  assert.equal(m.sections[1].blocks[1].settings, undefined);
  // `public` is a boolean or nothing; `tier` is not a frame word.
  const bad = frame();
  bad.sections[0].public = 'yes';
  assert.ok(parseReportTemplate(bad).issues.length);
  const tier = frame();
  tier.sections[0].tier = 'public';
  assert.match(parseReportTemplate(tier).issues[0].message, /목록에 없는 속성: tier/);
});

test('검토용 is the page renderJigReport always made', () => {
  const m = model();
  const review = renderReportHtml(m, ORIGIN, { tier: 'review' });
  assert.equal(review, renderJigReport(m, ORIGIN));
  assert.ok(review.includes('[S1]'));
  assert.ok(review.includes('[S4]'));
  assert.ok(review.includes('id="appendix"'));
  assert.ok(review.includes('설정값 원장'));
  assert.ok(review.includes('VIDE에서 열기: 합성 프로젝트 · 작업본 1 · 0.1.0'));
});

test('보고용: public sections only, summary kept, no citations, ids, settings or buttons', () => {
  const m = model();
  const html = renderReportHtml(m, ORIGIN, {
    tier: 'public',
    title: '골조 보고서',
    sourceRun: RUN,
  });
  assert.doesNotMatch(html, /\[S\d/, 'no [S#] markers');
  assert.ok(!html.includes(INSTANCE), 'no full instance id');
  assert.doesNotMatch(html, /<section id=/, 'no section ids');
  assert.ok(!html.includes('설정으로'));
  assert.doesNotMatch(html, /<(?:script|button|form|input|link|iframe)\b/i);
  assert.ok(!html.includes('VIDE에서 열기'));
  assert.ok(!html.includes('설정값 원장'), 'appendix is not public');
  assert.ok(!html.includes('<th>설정값</th>'), 'settings history block dropped');
  assert.ok(html.includes('보 목록'), 'the other block of the section stays');
  // First-page summary: assumptions and items not checked.
  assert.ok(html.includes('<h4>가정</h4>'));
  assert.ok(html.includes('고정하중은 합성 예제 값</li>'));
  assert.ok(html.includes('<h4>검토하지 않은 항목</h4><ul><li>지진하중</li>'));
  // Head: the title, the day made and the 검토용 run.
  assert.ok(html.includes('<title>골조 보고서</title>'));
  assert.ok(html.includes('만든 날 2026-10-15 14:20'));
  assert.ok(html.includes('검토용 2026-10-15 14:00 회차에서 만듦 · 회차 3f2a9c1e'));
  assert.ok(!html.includes('보고서 study'), 'no frame id on the paper');
  assert.ok(html.includes('도면 치수</td>'));
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
});

test('보고용: sections chosen explicitly, numbered in order', () => {
  const m = model();
  const html = renderReportHtml(m, ORIGIN, {
    tier: 'public',
    sourceRun: RUN,
    sections: ['appendix'],
  });
  assert.ok(html.includes('설정값 원장'));
  assert.ok(!html.includes('경간 표'));
  assert.ok(html.includes('<span class="no">01</span>'));
  assert.ok(!html.includes('<th>누가</th>'), 'even a chosen appendix drops the settings history');
  const none = renderReportHtml(m, ORIGIN, { tier: 'public', sections: [] });
  assert.doesNotMatch(none, /<section/);
  assert.ok(none.includes('<h4>가정</h4>'), 'the summary cannot be left out');
});

test('stripCitations takes out the markers only', () => {
  assert.equal(stripCitations('높이 30 m [S1].'), '높이 30 m.');
  assert.equal(stripCitations('A [S1, S2] B [S3–S5]'), 'A B');
  assert.equal(stripCitations('[Sx] 그대로 [12]'), '[Sx] 그대로 [12]');
});

test('the five frames still parse and mark their public sections', () => {
  const frames = {
    'src/jigs/official/jigs/building-summary/reports/summary.json': ['overview', 'floors', 'check'],
    'src/jigs/official/jigs/site-model/reports/site-summary.json': ['site', 'buildings'],
    'src/jigs/official/jigs/paneling/reports/paneling.json': [
      'layout',
      'members',
      'types',
      'connections',
    ],
    'extensions/jigs/s06-frame/reports/frame-study.json': [
      'placement',
      'spans',
      'members',
      'schedule',
    ],
    'extensions/jigs/example-grid/reports/grid-summary.json': ['beams'],
  };
  for (const [file, ids] of Object.entries(frames)) {
    const parsed = parseReportTemplate(JSON.parse(readFileSync(file, 'utf8')));
    assert.deepEqual(parsed.issues, [], file);
    assert.deepEqual(
      parsed.template.sections.filter((s) => s.public).map((s) => s.id),
      ids,
      file,
    );
  }
});

test('법규 체크: one model, 검토용 as before, 보고용 of the result table and exceedances', () => {
  const result = complianceResultSchema.parse(complianceFixture());
  const m = complianceReportModel(result);
  assert.deepEqual(publicSectionIds(m), ['results', 'exceedances']);
  const review = reportHtml(result);
  assert.ok(review.includes('숫자 출처와 경우별 결과'));
  assert.ok(review.includes('미적용 항목'));
  assert.ok(!review.includes('VIDE에서 열기'), 'no instance page to open');
  const html = renderReportHtml(
    m,
    { project: '합성', instance: '법규 체크', version: '', at: '2026-10-15 14:20' },
    { tier: 'public', sourceRun: { instanceId: INSTANCE, reportId: 'compliance', at: '14:00' } },
  );
  assert.ok(
    html.includes('탐색용 법규 체크 — 인허가 검토·법규 검토를 대체하지 않음'),
    'notice stays',
  );
  assert.ok(html.includes('초과 부분'));
  assert.ok(!html.includes('숫자 출처와 경우별 결과'));
  assert.ok(!html.includes('법규 답 번호'));
  assert.ok(!html.includes('VIDE에서 열기'));
});
