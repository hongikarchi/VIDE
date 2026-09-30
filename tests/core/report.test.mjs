// Report frame v0 (PLAN-22 T-057, SPEC-07.11, ARCH-03 §5.2): a frame's claims are chosen by closed
// conditions on the current result and filled with its values; `claim-consistent`,
// `numbers-in-source` and `unchecked-listed` hold on the chosen claims; a polished sentence that
// fails them falls back to the frame sentence with '확인 필요'; previews are marked; the exported
// page is self-contained, without scripts, printable on A3 landscape and carries only the
// "VIDE에서 열기" line. Synthetic values only.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateWhen,
  fillTemplate,
  numbersIn,
  parseReportTemplate,
  resolveBlock,
  resolveReport,
  unsourcedNumbers,
} from '../../src/jigs/runtime/report-format.ts';
import { renderJigReport } from '../../src/server/report.ts';
import { validatePanel } from '../../src/ui/jig-panel/spec.ts';

const ctx = (over = {}) => ({
  outputs: {
    spans: {
      rows: [
        { key: 'G:A1>A2', span: 7.2, shade: 'base' },
        { key: 'G:A2>A3', span: 9.6, shade: 'actual' },
        { key: 'G:B1>B2', span: 6.0, shade: 'alt' },
      ],
      over: 1,
      longest: 9.6,
    },
    summary: { columns: 12, girders: 18 },
  },
  params: { span_max: 8 },
  final: { spans: true, summary: true },
  source: { readAt: '2026-09-30 10:00', statements: { total: 5, confirmed: 3 } },
  ...over,
});

const frame = () => ({
  template: 'study',
  title: '골조 배치 검토',
  eyebrow: '구조 · 합성 예제',
  headline: {
    cases: [
      {
        when: 'step.spans.over > 0',
        template: '보 {step.spans.over}개가 한도 {$span_max} m를 넘습니다.',
        tone: 'ng',
      },
      { when: 'step.spans.over == 0', template: '모든 보가 한도 안에 있습니다.', tone: 'ok' },
    ],
  },
  kpis: [
    { label: '기둥', from: 'step.summary.columns', unit: '개' },
    { label: '최장 경간', from: 'step.spans.longest', unit: 'm', decimals: 1 },
  ],
  sections: [
    {
      id: 'spans',
      from: ['step.spans'],
      title: {
        cases: [
          {
            when: 'step.spans.longest > $span_max',
            template: '가장 긴 경간은 {step.spans.longest:1} m입니다',
          },
          { template: '경간은 모두 한도 안입니다' },
        ],
      },
      blocks: [
        {
          kind: 'compare-bars',
          from: 'step.spans.rows',
          label: 'key',
          value: 'span',
          shade: 'shade',
          unit: 'm',
          decimals: 1,
          limit: '$span_max',
          limitLabel: '한도',
        },
        {
          kind: 'table',
          from: 'step.spans.rows',
          columns: [
            { field: 'key', label: '보' },
            { field: 'span', label: '경간', unit: 'm', decimals: 2 },
          ],
        },
      ],
    },
  ],
  assumptions: ['고정하중은 합성 예제 값'],
  unchecked: ['지진하중', '처짐'],
});

test('frame check: closed conditions, result holes, sentence headline, known properties', () => {
  assert.ok(parseReportTemplate(frame()).template);
  const bad = (edit) => {
    const f = frame();
    edit(f);
    return parseReportTemplate(f).issues;
  };
  assert.ok(bad((f) => (f.headline.cases[0].when = 'Math.max(step.spans.over) > 0')).length);
  assert.ok(bad((f) => (f.headline.cases[0].when = 'step.spans.over > 0 || 1 > 0')).length);
  assert.ok(bad((f) => (f.headline.cases[0].template = '보 {process.env}개입니다.')).length);
  assert.ok(bad((f) => (f.headline.cases[1].template = '모든 보가 한도 안에 있습니다')).length);
  assert.ok(bad((f) => (f.script = 'x')).length);
  assert.ok(bad((f) => delete f.unchecked).length, 'a frame lists what it did not check');
});

test('closed conditions and holes read the result', () => {
  const c = ctx();
  assert.equal(evaluateWhen('step.spans.over > 0 && $span_max == 8', c), true);
  assert.equal(evaluateWhen('step.spans.rows.length >= 3', c), true);
  assert.equal(evaluateWhen('step.spans.missing > 0', c), false);
  assert.equal(fillTemplate('{step.spans.longest:2} m · {step.spans.rows}', c), '9.60 m · 3개');
  assert.deepEqual(
    numbersIn('C1 기둥 12개, 경간 1,234.5 m, S-06').map((n) => n.value),
    [12, 1234.5],
  );
  assert.deepEqual(unsourcedNumbers('보 2개가 9.6 m', [9.6, 1]), ['2']);
});

test('the claim follows the result status and the gates hold', () => {
  const over = resolveReport(parseReportTemplate(frame()).template, ctx());
  assert.equal(over.headline.text, '보 1개가 한도 8 m를 넘습니다.');
  assert.equal(over.headline.tone, 'ng');
  assert.equal(over.sections[0].no, '01');
  assert.equal(over.sections[0].title.text, '가장 긴 경간은 9.6 m입니다');
  assert.deepEqual(
    over.gates.map((g) => [g.id, g.ok]),
    [
      ['claim-consistent', true],
      ['numbers-in-source', true],
      ['unchecked-listed', true],
    ],
  );
  assert.deepEqual(over.unchecked, ['지진하중', '처짐']);
  assert.deepEqual(
    over.kpis.map((k) => k.value),
    ['12', '9.6'],
  );
  assert.ok(over.source[0].includes('2026-09-30 10:00'));

  const within = ctx();
  within.outputs.spans = { ...within.outputs.spans, over: 0, longest: 7.9 };
  const ok = resolveReport(parseReportTemplate(frame()).template, within);
  assert.equal(ok.headline.text, '모든 보가 한도 안에 있습니다.');
  assert.equal(ok.sections[0].title.text, '경간은 모두 한도 안입니다');
});

test('claim-consistent: a number not in the bound values fails; numbers-in-source: none anywhere', () => {
  const f = frame();
  // 12 is a value of the result (summary.columns) but not of what this section is bound to.
  f.sections[0].title.cases = [{ template: '기둥 12개 사이의 경간입니다' }];
  const m = resolveReport(parseReportTemplate(f).template, ctx());
  const gate = (id) => m.gates.find((g) => g.id === id);
  assert.equal(gate('claim-consistent').ok, false);
  assert.deepEqual(gate('claim-consistent').failed, ['spans.title']);
  assert.equal(gate('numbers-in-source').ok, true);

  f.sections[0].title.cases = [{ template: '경간 77개를 봤습니다' }];
  const n = resolveReport(parseReportTemplate(f).template, ctx());
  assert.equal(n.gates.find((g) => g.id === 'numbers-in-source').ok, false);

  // No case holds: the claim is empty and the gate fails.
  const g = frame();
  g.headline.cases = [{ when: 'step.spans.over > 5', template: '많이 넘습니다.' }];
  const none = resolveReport(parseReportTemplate(g).template, ctx());
  assert.equal(none.headline.case, -1);
  assert.equal(none.gates[0].ok, false);
});

test('an AI polish is kept only when it passes both gates', () => {
  const f = { ...frame(), polish: 'ai-once' };
  const t = parseReportTemplate(f).template;
  const good = resolveReport(t, ctx(), {
    polished: { headline: '한도 8 m를 넘는 보가 1개 있습니다.' },
  });
  assert.equal(good.headline.text, '한도 8 m를 넘는 보가 1개 있습니다.');
  assert.equal(good.headline.check, undefined);
  const bad = resolveReport(t, ctx(), { polished: { headline: '한도를 넘는 보가 5개 있습니다.' } });
  assert.equal(bad.headline.text, '보 1개가 한도 8 m를 넘습니다.');
  assert.equal(bad.headline.check, '확인 필요');
  // Without `polish: 'ai-once'` in the frame a polished sentence is ignored.
  const off = resolveReport(parseReportTemplate(frame()).template, ctx(), {
    polished: { headline: '한도 8 m를 넘는 보가 1개 있습니다.' },
  });
  assert.equal(off.headline.text, '보 1개가 한도 8 m를 넘습니다.');
});

test('a preview result is marked, never written as final', () => {
  const m = resolveReport(
    parseReportTemplate(frame()).template,
    ctx({ final: { spans: false, summary: true } }),
  );
  assert.equal(m.headline.provisional, true);
  assert.equal(m.sections[0].title.provisional, true);
  assert.deepEqual(m.provisional, ['spans']);
  assert.equal(m.kpis[0].provisional, undefined);
  assert.equal(m.kpis[1].provisional, true);
});

test('compare bars: shades, dashed limit, scale includes the limit', () => {
  const block = resolveBlock(frame().sections[0].blocks[0], ctx());
  assert.equal(block.kind, 'compare-bars');
  assert.deepEqual(
    block.rows.map((r) => [r.text, r.shade]),
    [
      ['7.2', 'base'],
      ['9.6', 'actual'],
      ['6.0', 'alt'],
    ],
  );
  assert.deepEqual(block.limit, { value: 8, text: '8.0', label: '한도' });
  assert.equal(block.max, 9.6);
  const ledger = resolveBlock(
    {
      kind: 'ledger',
      from: 'step.spans.rows',
      group: 'shade',
      columns: [{ field: 'key', label: '보' }],
    },
    ctx(),
  );
  assert.deepEqual(
    ledger.groups.map((g) => g.name),
    ['base', 'actual', 'alt'],
  );
});

test('exported page: self-contained, no scripts, A3 landscape, only the open line', () => {
  const f = frame();
  f.title = '검토 <b>&';
  const m = resolveReport(parseReportTemplate(f).template, ctx());
  const html = renderJigReport(m, {
    project: '합성 프로젝트',
    instance: '작업본 1',
    version: '0.1.0',
    at: '2026-09-30 10:05',
  });
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no event handlers');
  assert.doesNotMatch(html, /https?:\/\//, 'no external requests');
  assert.doesNotMatch(html, /<(?:link|iframe|form|input|button)\b/i);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.match(html, /@page\{size:A3 landscape/);
  assert.ok(html.includes('VIDE에서 열기: 합성 프로젝트 · 작업본 1 · 0.1.0'));
  assert.ok(!html.includes('조건 조정'));
  assert.ok(!html.includes('설정값으로 돌아가기'));
  assert.ok(html.includes('<title>검토 &lt;b&gt;&amp;</title>'));
  assert.ok(html.includes('보 1개가 한도 8 m를 넘습니다.'));
  assert.ok(html.includes('지진하중'));
  assert.ok(html.includes('class="limit"'));
  assert.ok(html.includes('class="fill s-actual"'));
});

test('panel: report, compare-bars and ledger are ready parts', () => {
  const panel = {
    layout: 'jig-run',
    left: [],
    center: { views: [{ part: 'report', report: 'study' }] },
    drawer: {
      part: 'result-tabs',
      tabs: [
        {
          title: '경간',
          part: 'compare-bars',
          from: 'step.spans.rows',
          label: 'key',
          value: 'span',
          limit: '$span_max',
        },
        { title: '원장', part: 'ledger', from: 'step.spans.rows', group: 'shade' },
      ],
    },
  };
  const scope = { steps: ['spans'], params: ['span_max'], inputs: [] };
  const checked = validatePanel(panel, scope);
  assert.deepEqual(checked.issues, []);
  const bad = validatePanel(
    { ...panel, center: { views: [{ part: 'report', report: 'study', tone: '#ff0000' }] } },
    scope,
  );
  assert.ok(bad.issues.length);
});
