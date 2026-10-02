import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  autorunUntil,
  openingOf,
  orderSkills,
  parseFrontMatter,
  skillFront,
  skillRouteJigs,
} from '../../src/ui/skill-catalog.ts';
import {
  decisiveRoute,
  instanceRouteContext,
  officialRouteJigs,
  paramsFor,
  requestValues,
  routeCard,
  routeRequest,
} from '../../src/ui/request-route.ts';

const s06Skill = readFileSync(
  new URL('../../extensions/jigs/s06-frame/skill.md', import.meta.url),
  'utf8',
);
const s06 = JSON.parse(
  readFileSync(new URL('../../extensions/jigs/s06-frame/jig.json', import.meta.url), 'utf8'),
);

// RESEARCH-12 §6.3 / ADR-026: jig = skill, read from skill.md front matter and jig.json.
test('skill.md front matter: flow lists, quoted commas, block lists and block text', () => {
  const raw = parseFrontMatter(
    [
      '---',
      'name: 예제',
      'examples: ["구조 분석 해줘", \'경간 11, 작은보 2.2\', 검정비]',
      'words:',
      '  - 골조',
      '  - "구조 해석"',
      'description: >',
      '  첫 줄',
      '  둘째 줄',
      'invocation: user-only',
      '---',
      '# 본문',
      'words: [본문은 읽지 않음]',
    ].join('\r\n'),
  );
  assert.equal(raw.name, '예제');
  assert.deepEqual(raw.examples, ['구조 분석 해줘', '경간 11, 작은보 2.2', '검정비']);
  assert.deepEqual(raw.words, ['골조', '구조 해석']);
  assert.equal(raw.description, '첫 줄 둘째 줄');
  assert.deepEqual(parseFrontMatter('# 앞머리 없음'), {});
  const front = skillFront(['---', 'invocation: user-only', '---'].join('\n'));
  assert.equal(front.invocation, 'user-only');
  // Anything but user-only is auto (the default for official and project jigs).
  assert.equal(skillFront('---\ninvocation: sometimes\n---').invocation, 'auto');
});

test('the S-06 frame jig declares its skill: description, examples, words, opening fields', () => {
  const front = skillFront(s06Skill);
  assert.equal(front.name, 'S-06 골조 배치');
  assert.equal(front.invocation, 'auto');
  assert.ok(front.description && front.description.length <= 500);
  assert.ok(front.examples?.includes('구조 분석 해줘'));
  for (const word of ['구조 분석', '구조 검토', '검정비'])
    assert.ok(front.words?.includes(word), word);
  assert.ok(front.not_for?.includes('확정 구조 검토'));
  const opening = openingOf(s06);
  assert.equal(opening.open.reuse, 'last');
  assert.equal(opening.open.layerRoot, undefined, 'no default output layer (ADR-026)');
  assert.ok(opening.fromRequest.includes('spanMax'));
  // first-hard: the first human step that blocks others (해석 확정), not the input check.
  assert.deepEqual(opening.autorun, { until: 'first-hard', step: 'confirmAnalysis' });
  assert.equal(autorunUntil('girders', s06.steps), 'girders');
  assert.equal(autorunUntil('nope', s06.steps), undefined);
});

const entry = (id, scope, extra = {}) => ({
  id,
  name: id,
  kind: 'instance',
  scope,
  invocation: 'auto',
  open: { reuse: 'last' },
  fromRequest: [],
  autorun: { until: 'first-hard' },
  ...extra,
});

test('catalog order: this project first, then other available jigs, the official list last; user-only never routed', () => {
  const ordered = orderSkills([
    entry('structure', 'official', { kind: 'legacy', words: ['구조 분석'] }),
    entry('project/other', 'available'),
    entry('project/s06-frame', 'project', { words: ['구조 분석'] }),
    entry('project/hidden', 'project', { invocation: 'user-only', words: ['구조 분석'] }),
  ]);
  assert.deepEqual(
    ordered.map((skill) => skill.id),
    ['project/s06-frame', 'project/hidden', 'project/other', 'structure'],
  );
  const jigs = skillRouteJigs(ordered);
  assert.deepEqual(
    jigs.map((jig) => [jig.id, jig.source]),
    [
      ['project/s06-frame', 'skill'],
      ['project/other', 'skill'],
      ['structure', 'legacy'],
    ],
  );
});

const s06Front = skillFront(s06Skill);
const catalogJigs = skillRouteJigs([
  entry('project/s06-frame', 'project', {
    name: s06Front.name,
    words: s06Front.words,
    notFor: s06Front.not_for,
  }),
  ...officialRouteJigs().map((jig) => entry(jig.id, 'official', { ...jig, kind: 'legacy' })),
]);

test('routing candidates: the project jig wins the same words; skill words are guarded', () => {
  const context = { jigs: catalogJigs };
  const structure = decisiveRoute('구조 분석 해줘', context);
  assert.deepEqual([structure.target, structure.jig.id], ['jig', 'project/s06-frame']);
  assert.equal(structure.reason, 'jig 열기');
  // Without the project jig the official one still opens (the fallback list).
  assert.equal(decisiveRoute('구조 분석 해줘', { jigs: officialRouteJigs() }).jig.id, 'structure');
  // A single word never opens a jig by rule (2026-10-02): Jev judges it, and without Jev the
  // request goes to the conversation as a file turn.
  assert.equal(decisiveRoute('진단 돌려줘', context), undefined);
  const grid = {
    jigs: [
      {
        id: 'project/example-grid',
        name: '격자 골조 배치 예제',
        words: ['격자', '기둥 배치', '보 연결', '경간', '예제'],
        source: 'skill',
      },
    ],
  };
  const sentence = '06-사선격자형이 좋아. 디벨롭해보자';
  assert.equal(decisiveRoute(sentence, grid), undefined);
  assert.equal(routeRequest(sentence, [], [], grid).target, 'document');
  // A phrase still opens it.
  assert.equal(decisiveRoute('기둥 배치 해보자', grid)?.jig?.id, 'project/example-grid');
  assert.equal(decisiveRoute('기둥 숨겨', context), undefined);
  assert.equal(routeRequest('기둥 숨겨', [], [], context).target, 'view');
  assert.notEqual(decisiveRoute('기둥 몇 개야?', context)?.target, 'jig');
  // not_for rules the jig out.
  assert.notEqual(decisiveRoute('확정 구조 검토 해줘', context)?.jig?.id, 'project/s06-frame');
  // The route row, not a proposal card.
  assert.deepEqual(routeCard(structure), {
    text: 'S-06 골조 배치로 진행',
    tier: 'auto',
    toAi: true,
  });
});

const params = instanceRouteContext([
  {
    key: 'spanMax',
    title: '경간 상한',
    type: 'length',
    unit: 'm',
    displayUnit: 'm',
    range: { min: 8, max: 20, step: 0.5 },
    value: 12,
  },
  {
    key: 'beamSpacing_m',
    title: '작은보 간격',
    type: 'length',
    unit: 'm',
    displayUnit: 'm',
    range: { min: 2, max: 3, step: 0.1 },
    value: 2.5,
  },
]);

test("the open jig's own words change its settings; several settings in one request", () => {
  const context = { jigs: catalogJigs, ...params, openJig: 'project/s06-frame' };
  const one = decisiveRoute('경간 11로', context);
  assert.deepEqual([one.target, one.param.key, one.param.change.value], ['param', 'spanMax', 11]);
  const several = decisiveRoute('경간 11로, 작은보 간격 2.2로', context);
  assert.equal(several.target, 'param');
  assert.deepEqual(
    several.params.map((entry) => [entry.key, entry.change.value]),
    [
      ['spanMax', 11],
      ['beamSpacing_m', 2.2],
    ],
  );
  assert.match(routeCard(several).text, /경간 상한 12 m → 11 m · 작은보 간격 2.5 m → 2.2 m/);
  assert.equal(paramsFor('경간 11로', context.params), undefined);
  // A phrase naming the jig reopens it (and recomputes) even while it is open.
  assert.equal(decisiveRoute('구조 분석 다시 해줘', context).target, 'jig');
});

test('values a starting request gives for from_request settings', () => {
  const values = requestValues('경간 11로 해서 구조 분석 해줘', params.params, params.values, [
    'spanMax',
    'beamSpacing_m',
  ]);
  assert.deepEqual(
    values.map((entry) => [entry.key, entry.change.ok, entry.change.value]),
    [['spanMax', true, 11]],
  );
  // Settings outside from_request are not read; out-of-range values say why.
  assert.deepEqual(requestValues('작은보 간격 2.2', params.params, params.values, ['spanMax']), []);
  const wrong = requestValues('경간 30으로 구조 분석', params.params, params.values, ['spanMax']);
  assert.deepEqual([wrong[0].change.ok, wrong[0].change.code], [false, 'OUT_OF_RANGE']);
  assert.deepEqual(requestValues('구조 분석 해줘', params.params, params.values), []);
});
