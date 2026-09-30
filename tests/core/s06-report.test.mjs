import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReportTemplate, resolveReport } from '../../src/jigs/runtime/report-format.ts';
import { renderJigReport } from '../../src/server/report.ts';
import { outputIsFinal, reportFrames, withoutEmptyBlocks } from '../../src/server/jig-routes.ts';
import { diagnose } from '../../extensions/jigs/s06-frame/steps/diagnose.ts';
import { girders } from '../../extensions/jigs/s06-frame/steps/girders.ts';
import { roleRows } from '../../extensions/jigs/s06-frame/steps/sync-input.ts';
import {
  LAYERS,
  buildCase,
  gridRot21,
} from '../../extensions/jigs/s06-frame/fixtures/synthetic.ts';

// S-06 report skeleton (PLAN-23 T-058) on the report frame of PLAN-22 T-057. Synthetic results only:
// every section reads the step outputs when they exist and says '아직 없음' when they do not; the
// claims pass the report gates on every stage of the flow; previews are never written as final.
const JIG = join(import.meta.dirname, '..', '..', 'extensions', 'jigs', 's06-frame');
const frame = () => {
  const parsed = parseReportTemplate(
    JSON.parse(readFileSync(join(JIG, 'reports', 'frame-study.json'), 'utf8')),
  );
  assert.deepEqual(parsed.issues, []);
  return parsed.template;
};
const params = { spanMax: 12 };
const gatesOk = (model) =>
  assert.deepEqual(
    model.gates.filter((g) => !g.ok),
    [],
    JSON.stringify(model.gates),
  );
const section = (model, id) => model.sections.find((s) => s.id === id);

function diagnoseOutput() {
  const built = buildCase(gridRot21);
  const inputs = { definitions: {} };
  const home = ['columns', 'girders', 'newFootings'];
  for (const role of Object.keys(LAYERS)) {
    const document = home.includes(role) ? 'structure' : 'civil';
    const { rows, definitions } = roleRows(built[document], document, [LAYERS[role]]);
    inputs[role] = rows;
    inputs.definitions[document] = { ...inputs.definitions[document], ...definitions };
  }
  return diagnose(inputs);
}
function girdersOutput() {
  const f = JSON.parse(readFileSync(join(JIG, 'fixtures', 'girders-straight-grid.json'), 'utf8'));
  return girders(f.input, f.params);
}
const counts = (ng) => ({ ok: 10 - ng, warn: 0, ng, na: 0, err: 0 });
const summary = (ratio, ng) => ({
  maxRatio: ratio,
  counts: counts(ng),
  margin: { name: '중력 조합', value: Number((1 - ratio).toFixed(3)) },
  issues: [{ level: 'info', code: 'NOTE', message: '합성 메모' }],
});
const analysisPreview = (ratio, ng) => ({
  schema: 'vide.s06.analysis/1',
  label: '미확정 미리보기',
  modelHash: 'h',
  preview: summary(ratio, ng),
  assumptions: ['합성 가정'],
  summary: { status: 'ok', members: 10, confirmed: false, maxRatio: ratio, ms: 5 },
});
const analysisConfirmed = (ratio, ng) => ({
  ...analysisPreview(ratio, ng),
  confirmed: { result: summary(ratio, ng), at: '2026-09-30T00:00:00Z', modelHash: 'h' },
  summary: { status: 'ok', members: 10, confirmed: true, maxRatio: ratio, ms: 5 },
});
const scheduleOutput = {
  mode: 'confirmed',
  rows: [
    {
      mark: 'SC1',
      sectionName: 'H-400',
      count: 6,
      totalLength_m: 36,
      weight_t: 6.12,
      maxRatio: 0.7,
    },
    {
      mark: 'SG1',
      sectionName: 'H-600',
      count: 4,
      totalLength_m: 48,
      weight_t: 7.3,
      maxRatio: 0.8,
    },
  ],
  totals: { count: 10, length_m: 84, weight_t: 13.42 },
  unlisted: [],
};
const context = (outputs) => ({
  outputs,
  params,
  final: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, outputIsFinal(v)])),
});

test('frame parses; with no outputs every section says 아직 없음 and the gates pass', () => {
  const model = withoutEmptyBlocks(resolveReport(frame(), context({})));
  gatesOk(model);
  assert.deepEqual(
    model.sections.map((s) => [s.no, s.id]),
    [
      ['01', 'placement'],
      ['02', 'spans'],
      ['03', 'members'],
      ['04', 'schedule'],
      ['05', 'open'],
    ],
  );
  for (const id of ['placement', 'spans', 'members', 'schedule'])
    assert.match(section(model, id).title.text, /아직 없음/, id);
  assert.ok(model.sections.every((s) => s.blocks.length === 0));
  assert.match(model.headline.text, /^아직 계산한 결과가 없습니다\./);
  assert.ok(model.unchecked.length >= 5 && model.assumptions.length >= 3);
});

test('drawn layout: diagnosis and drawn girders fill 01·02 with sourced numbers', () => {
  const d = diagnoseOutput();
  const g = girdersOutput();
  const model = withoutEmptyBlocks(resolveReport(frame(), context({ diagnose: d, girders: g })));
  gatesOk(model);
  const spans = section(model, 'spans');
  assert.equal(g.summary.spansOver, 2);
  assert.equal(
    spans.title.text,
    `그려진 거더 경간 ${g.spans.length}개 중 2개가 상한 12 m를 넘습니다.`,
  );
  assert.equal(spans.title.tone, 'ng');
  assert.equal(model.headline.text, '그려진 거더 경간 2개가 상한 12 m를 넘습니다.');
  const placement = section(model, 'placement');
  assert.match(placement.title.text, new RegExp(`그려진 기둥 ${d.summary.columns}개`));
  assert.doesNotMatch(placement.title.text, /아직 없음/);
  assert.ok(
    placement.blocks.some(
      (b) => b.kind === 'table' && b.rows.length === d.tables.interference.length,
    ),
  );
  const bars = spans.blocks.find((b) => b.kind === 'compare-bars');
  assert.equal(bars.limit.value, 12);
  assert.match(section(model, 'members').title.text, /아직 없음/);
  const kpi = Object.fromEntries(model.kpis.map((k) => [k.label, k.value]));
  assert.equal(kpi['경간 초과'], '2');
  assert.equal(kpi['중력 조합 부재 검정 여유'], '—');
});

test('an unconfirmed analysis is a preview: marked, never written as 확정, margin left empty', () => {
  const model = resolveReport(frame(), context({ analysis: analysisPreview(1.23, 2) }));
  gatesOk(model);
  const members = section(model, 'members');
  assert.match(members.title.text, /^미확정 미리보기에서 부재 10개 중 2개가 검정을 넘습니다/);
  assert.equal(members.title.provisional, true);
  assert.doesNotMatch(members.title.text, /확정 해석/);
  assert.match(members.lede.text, /비워 두었습니다/);
  assert.deepEqual(model.provisional, ['analysis']);
  const margin = model.kpis.find((k) => k.label === '중력 조합 부재 검정 여유');
  assert.equal(margin.value, '—');
  assert.equal(margin.note, '확정 해석 뒤에 채웁니다');
  const html = renderJigReport(model, { project: '합성', instance: '작업본', version: '0.1.0' });
  assert.match(html, /확정 전 미리보기/);
});

test('confirmed analysis and schedule fill 03·04 and the headline', () => {
  const model = withoutEmptyBlocks(
    resolveReport(
      frame(),
      context({
        analysis: analysisPreview(0.82, 0),
        analysisConfirmed: analysisConfirmed(0.82, 0),
        schedule: scheduleOutput,
      }),
    ),
  );
  gatesOk(model);
  assert.equal(
    section(model, 'members').title.text,
    '확정 해석에서 부재 10개의 최대 검정비는 0.82입니다.',
  );
  assert.equal(section(model, 'members').title.provisional, undefined);
  assert.equal(section(model, 'schedule').title.text, '부호 2종, 부재 10개, 강재 13.4 t입니다.');
  assert.equal(section(model, 'schedule').blocks[0].kind, 'ledger');
  assert.equal(model.headline.text, '확정 해석에서 최대 검정비 0.82로 부재 검정을 통과합니다.');
  assert.deepEqual(model.provisional, ['analysis']);
  const kpi = Object.fromEntries(model.kpis.map((k) => [k.label, k.value]));
  assert.equal(kpi['중력 조합 부재 검정 여유'], '0.18');
  assert.equal(kpi['강재 합계'], '13.4');
});

test('exported page: no script, first page caveats, VIDE line; frames found without a manifest entry', () => {
  const model = resolveReport(frame(), context({ girders: girdersOutput() }));
  const html = renderJigReport(model, {
    project: '합성',
    instance: '작업본 A',
    version: 'S-06 0.1.0',
  });
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /default-src 'none'/);
  assert.ok(html.indexOf('검토하지 않은 항목') < html.indexOf('id="placement"'));
  assert.match(html, /VIDE에서 열기: 합성 · 작업본 A · S-06 0\.1\.0/);
  assert.deepEqual(
    reportFrames({
      manifest: {},
      files: ['jig.json', 'reports/frame-study.json', 'reports/x/y.json'],
    }),
    [{ id: 'frame-study', title: 'frame-study', file: 'reports/frame-study.json' }],
  );
  assert.deepEqual(
    reportFrames({
      manifest: { reports: [{ id: 'study', file: 'reports/frame-study.json', title: '골조' }] },
      files: [],
    }),
    [{ id: 'study', file: 'reports/frame-study.json', title: '골조' }],
  );
  assert.equal(outputIsFinal({ mode: 'preview' }), false);
  assert.equal(outputIsFinal({ summary: { confirmed: false } }), false);
  assert.equal(outputIsFinal({ summary: { confirmed: true } }), true);
});
