import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReportTemplate, resolveReport } from '../../src/jigs/runtime/report-format.ts';
import { jigReportInputs, renderJigReport } from '../../src/server/report.ts';
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
  schema: 'vide.structure.summary/1',
  statusCodes: ['ok', 'warn', 'ng', 'na', 'err'],
  clauses: ['휨', '전단'],
  combos: [
    { id: 'LC1', limitState: 'strength', terms: { D: 1.2, L: 1.6 } },
    { id: 'LC2', limitState: 'service', terms: { D: 1, L: 1 } },
  ],
  members: [
    ['SG-1', ng ? 2 : 0, ratio, 0, 20, 40, []],
    ['SG-2', 0, 0.45, 1, 12, 40, []],
    ['SC-1', 0, 0.6, 0, null, null, []],
  ],
  reactions: {
    sumZ_kN: {},
    lateral_kN: {},
    perColumn: [
      ['c-1', 0, 0, 3, 4],
      ['c-2', 0, 1, 1, 0],
    ],
    maxLateral_kN: 5,
  },
  assumptions: ['합성 해석 가정'],
  unchecked: ['합성 미검토 항목'],
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
// M3 contracts (PLAN-23 T-054~T-056): sizing, schedule, heights, bakePlan.
const scheduleOutput = {
  schema: 'vide.s06.schedule/1',
  prefix: '',
  marks: [],
  rows: [
    {
      mark: 'SC1',
      role: 'column',
      roleLabel: '기둥',
      section: 'H-400x400x13x21',
      count: 6,
      totalLength_m: 36,
      kgpm: 170,
      t: 6.12,
      maxRatio: 0.7,
    },
    {
      mark: 'SG1',
      role: 'girder',
      roleLabel: '거더',
      section: 'H-600x200x11x17',
      count: 4,
      totalLength_m: 48,
      kgpm: 152,
      t: 7.3,
      maxRatio: 0.8,
    },
  ],
  totals: { count: 10, t: 13.42 },
  csv: 'mark,section',
  unlisted: [],
};
const sizingOutput = (previewOnly) => ({
  schema: 'vide.s06.sizing/1',
  previewOnly,
  groups: [
    {
      id: 'G1',
      role: 'girder',
      band: '9–12 m',
      memberIds: ['SG-1', 'SG-2'],
      sectionId: 'h600',
      sectionName: 'H-600x200x11x17',
      maxRatio: 0.82,
      status: 'ok',
      judgement: '선정',
    },
  ],
  sectionsById: {},
  iterations: 2,
  notes: ['합성 크기 메모'],
  summary: { groups: 1, ok: 1, noCandidate: 0, unchecked: 0, maxRatio: 0.82, steel_t: 13.42 },
});
const heightsOutput = {
  schema: 'vide.s06.heights/1',
  rows: [{ columnId: 'col:c-1', drawnLength_m: 6.4, length_m: 6, gap_m: 0.4, topZ: 6, bottomZ: 0 }],
  summary: { columns: 1, floored: 1, short: 0, maxGap_m: 0.4, depthFinishOver: 0, heightStep: 1 },
  notes: [],
};
const bakePlanOutput = {
  schema: 'vide.s06.bakePlan/1',
  lines: [],
  members: [],
  summary: { lines: 12, members: 10, steel_t: 13.42 },
};
const bakeMembersOutput = {
  ...bakePlanOutput,
  previewOnly: false,
  members: Array.from({ length: 10 }, (_, k) => ({ key: `girder:G${k + 1}` })),
  summary: { lines: 0, members: 10, steel_t: 13.42 },
};
const paramRows = [
  {
    key: 'spanMax',
    title: '경간 상한',
    value: 12,
    displayValue: 12,
    displayUnit: 'm',
    by: 'default',
    basis: { status: 'assumed', note: '일반 기본값' },
  },
  {
    key: 'steelGrade',
    title: '강종',
    value: 'SM355',
    by: 'decision',
    basis: { status: 'assumed', question: '구조사무소: 강종 확인' },
  },
  { key: 'beamSpacing_m', title: '작은보 간격', value: 2.5, displayUnit: 'm', by: 'user' },
];
const ledgerRows = [
  { kind: 'question', body: { id: 'q-ej', title: '신설 E.J. 폭을 정할까요?', blocks: '거더' } },
  { kind: 'question', body: { id: 'q-cap', title: '파일캡 크기를 확인할까요?' } },
  { kind: 'answer', body: { questionId: 'q-cap', optionId: 'yes' } },
];
const context = (outputs, inputs) => ({
  outputs,
  params,
  ...(inputs ? { inputs } : {}),
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
      ['06', 'appendix'],
    ],
  );
  for (const id of ['placement', 'spans', 'members', 'schedule', 'appendix'])
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
  assert.match(section(model, 'schedule').lede.text, /Rhino로 보내기: 아직 없음/);
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
  // Sizing, schedule and bake plans made from a preview are never final.
  assert.equal(outputIsFinal({ previewOnly: true }), false);
  assert.equal(outputIsFinal({ previewOnly: false }), true);
});

test('report inputs: settings ledger, open items and the shown structure summary', () => {
  const outputs = { analysis: analysisConfirmed(0.82, 0), sizing: sizingOutput(true) };
  const inputs = jigReportInputs({ params: paramRows, ledger: ledgerRows, outputs });
  assert.deepEqual(inputs.counts, { settings: 3, assumed: 1, questions: 1, open: 2, notFinal: 0 });
  assert.deepEqual(inputs.settings[0], {
    key: 'spanMax',
    title: '경간 상한',
    value: '12 m',
    by: '기본값',
    basis: '가정',
    note: '일반 기본값',
  });
  // A decided setting is not open, even when its declared basis is 'assumed'.
  assert.deepEqual(
    inputs.open.map((o) => o.kind + ':' + o.text),
    ['가정한 설정값:경간 상한: 12 m', '답하지 않은 질문:신설 E.J. 폭을 정할까요?'],
  );
  assert.deepEqual(inputs.preview, { sizing: 1 });
  const s = inputs.structure;
  assert.equal(s.mode, '확정 결과');
  assert.deepEqual(
    s.combos.map((c) => `${c.id} ${c.limitState} ${c.text}`),
    ['LC1 강도 1.2D + 1.6L', 'LC2 사용성 1D + 1L'],
  );
  assert.deepEqual(
    s.bins.map((b) => b.count),
    [1, 1, 1, 0, 0],
  );
  assert.deepEqual(
    s.governing.map((g) => [g.key, g.judgement, g.ratio, g.clause]),
    [
      ['SG-1', '통과', 0.82, '휨'],
      ['SC-1', '통과', 0.6, '휨'],
      ['SG-2', '통과', 0.45, '전단'],
    ],
  );
  assert.deepEqual(
    s.deflections.map((d) => [d.key, d.ratio]),
    [
      ['SG-1', 0.5],
      ['SG-2', 0.3],
    ],
  );
  assert.deepEqual(
    s.reactions.map((r) => [r.column, r.combo, r.R_kN]),
    [
      ['c-1', 'LC1', 5],
      ['c-2', 'LC2', 1],
    ],
  );
  // A preview only: the view says so.
  const preview = jigReportInputs({ outputs: { analysis: analysisPreview(1.2, 1) } });
  assert.equal(preview.structure.mode, '미확정 미리보기');
  assert.equal(preview.structure.bins[4].count, 1);
  // A confirmed result that is not final (stale, re-confirm) is not shown as 확정.
  const stale = jigReportInputs({
    outputs: { analysis: analysisPreview(1.2, 1), analysisConfirmed: analysisConfirmed(0.5, 0) },
    final: { analysis: false, analysisConfirmed: false },
  });
  assert.equal(stale.structure.mode, '미확정 미리보기');
  assert.equal(stale.structure.step, 'analysis');
  assert.equal(stale.counts.notFinal, 2, 'results not final are counted (패널링 다시 계산 필요)');
  // Members a bake may make: only a member plan that is not a preview.
  assert.deepEqual(jigReportInputs({ outputs: { bakePlan: bakePlanOutput } }).bake, { members: 0 });
  assert.deepEqual(
    jigReportInputs({ outputs: { bakePlan: bakePlanOutput, bakeMembers: bakeMembersOutput } }).bake,
    { members: 10 },
  );
  assert.deepEqual(jigReportInputs({}).counts, {
    settings: 0,
    assumed: 0,
    questions: 0,
    open: 0,
    notFinal: 0,
  });
});

test('full flow: 01–05 and the appendix filled, gates pass, exported page in order', () => {
  const outputs = {
    diagnose: diagnoseOutput(),
    girders: girdersOutput(),
    heights: heightsOutput,
    analysis: analysisPreview(0.82, 0),
    analysisConfirmed: analysisConfirmed(0.82, 0),
    sizing: sizingOutput(false),
    schedule: scheduleOutput,
    bakePlan: bakePlanOutput,
    bakeMembers: bakeMembersOutput,
  };
  const inputs = jigReportInputs({ params: paramRows, ledger: ledgerRows, outputs });
  const model = withoutEmptyBlocks(resolveReport(frame(), context(outputs, inputs)));
  gatesOk(model);
  for (const s of model.sections) assert.doesNotMatch(s.title.text, /아직 없음/, s.id);
  const placement = section(model, 'placement');
  assert.match(placement.lede.text, /기둥 1개는 층고 단위 1 m로 내려 잘랐고/);
  assert.ok(placement.blocks.some((b) => b.title === '기둥 길이 (층고 단위로 내림)'));
  const spans = section(model, 'spans');
  const drawnBars = spans.blocks.find((b) => b.title === '거더 경간과 상한');
  assert.equal(drawnBars.rows.length, outputs.girders.spans.length);
  assert.equal(drawnBars.limit.value, 12);

  const members = section(model, 'members');
  assert.match(members.lede.text, /하중 조합 2개를 해석한 그대로/);
  assert.deepEqual(
    members.blocks.map((b) => b.title),
    [
      '하중 조합 (해석한 그대로)',
      '해석 가정',
      '검토하지 않은 항목',
      '검정비 분포',
      '지배 부재 (검정비 상위 10)',
      '참고 처짐 (판정에 넣지 않음)',
      '기둥별 수평 반력',
      '해석 점검 메모',
    ],
  );
  assert.deepEqual(members.blocks[0].rows[0], ['LC1', '강도', '1.2D + 1.6L']);
  assert.deepEqual(members.blocks[2].items, ['합성 미검토 항목']);
  const histogram = members.blocks[3];
  assert.deepEqual(
    histogram.rows.map((r) => [r.label, r.value, r.shade]),
    [
      ['0.5 미만', 1, 'base'],
      ['0.5–0.7', 1, 'base'],
      ['0.7–0.9', 1, 'alt'],
      ['0.9–1.0', 0, 'alt'],
      ['1.0 초과', 0, 'strong'],
    ],
  );

  const schedule = section(model, 'schedule');
  assert.equal(schedule.title.text, '부호 2종, 부재 10개, 강재 13.4 t입니다.');
  assert.equal(schedule.lede.text, 'Rhino로 보낼 부재 10개와 선 12개가 준비되어 있습니다.');
  const ledger = schedule.blocks.find((b) => b.kind === 'ledger');
  assert.deepEqual(
    ledger.groups.map((g) => g.name),
    ['기둥', '거더'],
  );
  const share = schedule.blocks.find((b) => b.kind === 'compare-bars');
  assert.deepEqual(
    share.rows.map((r) => [r.label, r.text]),
    [
      ['SC1', '6.12'],
      ['SG1', '7.30'],
    ],
  );
  assert.ok(schedule.blocks.some((b) => b.title === '부재 크기 그룹' && b.rows[0][2] === '2개'));

  const open = section(model, 'open');
  assert.equal(
    open.title.text,
    '남은 조건 2개: 가정으로 둔 설정값 1개, 답하지 않은 질문 1개입니다.',
  );
  assert.deepEqual(open.blocks[0].rows[1], [
    '답하지 않은 질문',
    '신설 E.J. 폭을 정할까요?',
    '거더',
  ]);
  const appendix = section(model, 'appendix');
  assert.equal(appendix.title.text, '설정값 원장: 3개 중 가정으로 둔 기본값 1개가 남아 있습니다.');
  assert.equal(appendix.blocks[0].rows.length, 3);
  const kpi = Object.fromEntries(model.kpis.map((k) => [k.label, k.value]));
  assert.equal(kpi['강재 합계'], '13.4');
  assert.equal(kpi['남은 조건'], '2');

  const html = renderJigReport(model, { project: '합성', instance: '작업본', version: '0.2.0' });
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /<span class="no">부록<\/span>/);
  const at = (text) => html.indexOf(text);
  assert.ok(at('하중 조합 (해석한 그대로)') < at('검정비 분포'));
  assert.ok(at('id="members"') < at('합성 미검토 항목'));
  assert.ok(at('id="open"') < at('id="appendix"'));
});

test('previews: sizing from an unconfirmed analysis gives a 예비 schedule; no inputs still pass', () => {
  const outputs = {
    analysis: analysisPreview(0.95, 0),
    sizing: sizingOutput(true),
    schedule: scheduleOutput,
    bakePlan: { ...bakePlanOutput, previewOnly: true },
  };
  const inputs = jigReportInputs({ outputs });
  const model = withoutEmptyBlocks(resolveReport(frame(), context(outputs, inputs)));
  gatesOk(model);
  // Sections chosen by a preview are marked, the steel KPI too.
  assert.ok(model.provisional.includes('sizing'));
  // Members planned from preview sections are not offered as ready to send.
  assert.equal(
    section(model, 'schedule').lede.text,
    'Rhino로 보낼 선 12개가 준비되어 있고, 부재는 확정 해석 뒤에 보냅니다.',
  );
  assert.equal(
    section(model, 'schedule').title.text,
    '미확정 해석으로 고른 예비 일람표입니다. 부호 2종, 부재 10개, 강재 13.4 t입니다.',
  );
  assert.equal(section(model, 'schedule').title.tone, 'warn');
  assert.match(section(model, 'members').title.text, /^미확정 미리보기의 최대 검정비는 0\.95/);
  assert.equal(section(model, 'members').blocks[0].rows.length, 2);
  // Sizing alone: groups written, schedule 아직 없음.
  const only = withoutEmptyBlocks(
    resolveReport(frame(), context({ sizing: sizingOutput(false) }, jigReportInputs({}))),
  );
  gatesOk(only);
  assert.equal(
    section(only, 'schedule').title.text,
    '부재 크기 그룹 1개를 정했습니다. 일람표는 아직 없음.',
  );
  assert.equal(
    section(only, 'open').title.text,
    '가정으로 둔 설정값과 답하지 않은 질문이 없습니다. 남은 조건은 첫 쪽의 검토하지 않은 항목입니다.',
  );
  assert.equal(section(only, 'appendix').title.text, '설정값 원장: 아직 없음.');
});
