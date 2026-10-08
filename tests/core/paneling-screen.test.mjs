// 패널링 화면의 순수 부분 (PLAN-49 T-253, SPEC-16.4·16.5·16.8·16.11, Design SCR-33): the panel.json
// passes the part check against the steps PLAN-49 fixes (`preview` · `members` · `optimize`); a
// mesh overlay layer draws outlines and `{v, f}` triangles; settings fall to their stage and carry
// '물어볼 것' before a result and '가정' after; members and types cannot be made while an assumed
// value remains (the contract's `makeAllowed`), while the preview can; the head numbers, 색 기준
// tones and legend, schedule rows and the CSV of `SCHEDULE_COLUMNS` come from the step outputs;
// question cards ask only the missing values of a stage with the recommended value first; and the
// routing words open the jig from "이 면 패널로 나눠 줘".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  memberSetSchema,
  panelLayoutSchema,
  panelTypingSchema,
  SCHEDULE_COLUMNS,
} from '../../src/contracts/paneling.ts';
import { validatePanel } from '../../src/ui/jig-panel/spec.ts';
import { layerItems, meshOf } from '../../src/ui/jig-panel/bindings.ts';
import { PART_PROPS } from '../../src/ui/kit/registry.ts';
import {
  answerValue,
  assumedOf,
  headCells,
  headNotices,
  legendOf,
  makeGate,
  panelItems,
  panelRows,
  plateHint,
  readLayout,
  scheduleCsv,
  settingInUse,
  settingsOfStage,
  sourceOf,
  stageOf,
  stageQuestions,
  tagOf,
  toneOf,
} from '../../src/ui/paneling/model.ts';
import { jigFor, OFFICIAL_TOOL_ROUTING } from '../../src/ui/request-route.ts';
import { panelingFixture, panelingParams } from '../fixtures/paneling-result.mjs';

const PANEL = join(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'jigs',
  'official',
  'jigs',
  'paneling',
  'panel.json',
);
const panel = JSON.parse(readFileSync(PANEL, 'utf8'));
const scope = {
  steps: ['preview', 'members', 'optimize'],
  params: panelingParams().map((p) => p.key),
  inputs: ['surface'],
};
const values = (params) => Object.fromEntries(params.map((p) => [p.key, p.value]));
const results = (fixture = panelingFixture()) => ({
  layout: panelLayoutSchema.parse(fixture.preview),
  members: memberSetSchema.parse(fixture.members),
  typing: panelTypingSchema.parse(fixture.optimize),
});

test('the 패널링 panel uses only registered parts in their places', () => {
  const checked = validatePanel(panel, scope);
  assert.deepEqual(checked.issues, []);
  assert.deepEqual(
    checked.spec.left.map((p) => p.part),
    ['paneling-stages', 'paneling-surface', 'paneling-settings', 'paneling-make'],
  );
  assert.equal(checked.spec.center.kpis.part, 'paneling-summary');
  assert.equal(checked.spec.drawer.part, 'paneling-result');
  // It names no step, setting or input, so another jig.json's names cannot break it.
  assert.doesNotMatch(JSON.stringify(panel), /step\.|inputs\.|\$/);
  const placed = structuredClone(panel);
  placed.left.push({ part: 'paneling-result' });
  assert.deepEqual(
    validatePanel(placed, scope).issues.map((i) => i.code),
    ['PANEL_PART_PLACE'],
  );
});

test('a mesh overlay layer draws an outline fan or the given triangles', () => {
  assert.ok(
    PART_PROPS['viewport-overlay'].safeParse({
      layers: [
        { key: 'faces', from: 'step.preview.panels', shape: 'mesh', at: 'corners', id: 'id' },
      ],
    }).success,
  );
  const data = {
    outputs: { preview: panelingFixture().preview },
    params: [],
  };
  const items = layerItems(
    { key: 'faces', from: 'step.preview.panels', shape: 'mesh', at: 'corners', id: 'id' },
    data,
    { verdict: false },
  );
  assert.equal(items.length, 8);
  assert.equal(items[0].kind, 'mesh');
  assert.equal(items[0].id, 'P-1-1');
  // Four corners + the centre, four triangles around it.
  assert.equal(items[0].v.length, 15);
  assert.deepEqual(items[0].f, [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]);
  const box = panelingFixture().members.members[0].solid;
  assert.deepEqual(meshOf(box), box);
  assert.equal(meshOf({ v: [0, 0, 0, 1, 0, 0, 0, 1, 0], f: [0, 1, 7] }), undefined);
  assert.equal(
    meshOf([
      [0, 0, 0],
      [1, 0, 0],
    ]),
    undefined,
  );
});

test('settings fall to their stage and carry 물어볼 것 · 가정 by their source', () => {
  const params = panelingParams({
    pattern: 'user',
    width: 'user',
    height: 'user',
    joint: 'decision',
  });
  assert.deepEqual(
    settingsOfStage(params, 'members').map((s) => s.key),
    ['thickness', 'thicknessSide', 'joint', 'boundaryJoint'],
  );
  assert.equal(stageOf({ key: 'somethingElse', group: '2 부재' }), 'members');
  assert.equal(stageOf({ key: 'other', group: '보기' }), undefined);
  const thickness = params.find((s) => s.key === 'thickness');
  assert.equal(sourceOf(thickness), 'assumed');
  assert.equal(tagOf(thickness, false), 'ask');
  assert.equal(tagOf(thickness, true), 'assumed');
  assert.equal(sourceOf(params.find((s) => s.key === 'joint')), 'question');
  assert.equal(
    tagOf(
      params.find((s) => s.key === 'pattern'),
      true,
    ),
    undefined,
  );
  // 합치기 기준 is read only with 합치기, 투영 평면 only with 투영.
  const v = values(params);
  assert.equal(settingInUse({ key: 'mergeBelow' }, v), false);
  assert.equal(settingInUse({ key: 'mergeBelow' }, { ...v, boundary: 'merge' }), true);
  assert.deepEqual(
    assumedOf(params, ['preview'], v).map((s) => s.key),
    ['measure', 'axis', 'startCorner', 'flip', 'boundary'],
  );
  assert.equal(plateHint(v), '판 1,190 × 590 mm = 크기 − 줄눈');
});

test('members and types are made only with confirmed values; the preview always', () => {
  const params = panelingParams({ pattern: 'user', width: 'user', height: 'user' });
  const v = values(params);
  const fresh = { computed: true, stale: false };
  assert.deepEqual(makeGate('preview', params, v, fresh), { allowed: true, assumed: 0 });
  const members = makeGate('members', params, v, fresh);
  assert.equal(members.allowed, false);
  assert.equal(members.assumed, 9);
  assert.equal(members.reason, '가정 값 9개를 확인하면 만들 수 있습니다');
  assert.match(
    makeGate('preview', params, v, { computed: true, stale: true }).reason,
    /다시 계산 필요/,
  );
  assert.match(
    makeGate('preview', params, v, { computed: false, stale: false }).reason,
    /계산한 뒤/,
  );
  // Every value of stages 1–2 given by a person or a card: members open, types still closed.
  const all = Object.fromEntries(params.map((p) => [p.key, 'user']));
  for (const key of [
    'flatnessTol',
    'planarize',
    'typeTol',
    'maxTypes',
    'flatRadius',
    'nodeAngleStep',
  ])
    delete all[key];
  const confirmed = panelingParams({ ...all, thickness: 'decision' });
  assert.equal(makeGate('members', confirmed, v, fresh).allowed, true);
  assert.equal(makeGate('optimize', confirmed, v, fresh).allowed, false);
  // An unused 합치기 기준 on the default does not hold the make.
  assert.equal(confirmed.find((p) => p.key === 'mergeBelow').by, 'user');
});

test('head numbers, notices, tones, legend and rows come from the step outputs', () => {
  const r = results();
  const head = Object.fromEntries(headCells('preview', r).map((c) => [c.label, c]));
  assert.equal(head['패널'].value, '8');
  assert.equal(head['경계'].value, '2');
  assert.equal(head['목표와 다름'].value, '2');
  assert.equal(head['크기'].value, '0.3~1.2 × 0.6~0.6');
  assert.equal(head['실패'].value, '1');
  assert.equal(head['실패'].bad, true);
  const two = Object.fromEntries(headCells('members', r).map((c) => [c.label, c.value]));
  assert.deepEqual(two, { 부재: '7', '판재 초과': '1', '줄눈 고르지 않음': '1', 실패: '1' });
  const three = Object.fromEntries(headCells('optimize', r).map((c) => [c.label, c.value]));
  assert.deepEqual(three, {
    타입: '3',
    '노드 타입': '2',
    '줄눈 타입': '1',
    '평면도 최대': '4.2',
    '허용 오차 넘음': '1',
  });
  assert.deepEqual(
    headCells('preview', {}).map((c) => c.value),
    [undefined, undefined, undefined, undefined, undefined],
  );
  assert.deepEqual(headNotices(r, [1.2, 0.6]), []);
  const coarse = structuredClone(panelingFixture().preview);
  coarse.coarseSample = true;
  coarse.module = [1.25, 0.6];
  assert.deepEqual(headNotices({ layout: coarse }, [1.2, 0.6]), [
    '표본이 거칩니다 · 촘촘하게 다시 읽기',
    '닫힌 면에 맞춰 크기를 1,250 × 600 mm로 바꿨습니다',
  ]);

  const byId = Object.fromEntries(r.layout.panels.map((p) => [p.id, p]));
  assert.equal(toneOf(byId['P-2-4'], r, 'type'), 'ov-clash', 'a failure is always --ov-clash');
  assert.equal(toneOf(byId['P-1-3'], r, 'deviation'), 'warn');
  assert.equal(toneOf(byId['P-1-4'], r, 'deviation'), 'ov-grid');
  assert.equal(toneOf(byId['P-1-1'], r, 'type'), 'ov-cat-1');
  assert.equal(toneOf(byId['P-1-3'], r, 'type'), 'ov-cat-2');
  assert.equal(toneOf(byId['P-1-1'], r, 'failure'), 'warn', 'over the stock sheet');
  assert.equal(toneOf(byId['P-2-2'], r, 'flatness', { flatnessTol: 0.003 }), 'warn');
  assert.equal(toneOf(byId['P-1-1'], r, 'flatness', { flatnessTol: 0.003 }), 'ok');
  assert.deepEqual(
    legendOf(r, 'type').map((row) => `${row.text} ${row.count}`),
    ['T-01 4', 'T-02 2', 'T-03 1', '실패 1'],
  );
  const items = panelItems(r, 'type', { stage: 'members' });
  assert.equal(items.length, 8);
  assert.equal(items[0].v.length, 24, 'stage 2 draws the closed member');
  assert.equal(panelItems(r, 'type', { stage: 'preview' })[0].v.length, 15);

  const rows = Object.fromEntries(panelRows(r).map((row) => [row.id, row]));
  assert.equal(rows['P-2-4'].status, '실패');
  assert.equal(rows['P-2-4'].reason, '넓이 0 · 패널이 너무 작습니다');
  assert.equal(rows['P-1-1'].status, '판재 초과');
  assert.equal(rows['P-2-3'].status, '허용 오차 넘음');
  assert.equal(rows['P-1-2'].status, '줄눈 고르지 않음');
  assert.deepEqual(rows['P-1-1'].size, [1.19, 0.59]);
  // A result that is not the contract's shape is not drawn.
  assert.equal(readLayout({ schema: 'vide.paneling.layout@1' }).kind, 'invalid');
  assert.equal(readLayout(undefined).kind, 'none');
});

test('the CSV carries the contract head, every panel and mm/m² text', () => {
  const r = results();
  const csv = scheduleCsv('panels', r);
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(lines[0], SCHEDULE_COLUMNS.panels.map(([, label]) => label).join(','));
  assert.equal(lines.length, 9);
  assert.equal(
    lines[1],
    'P-1-1,0,1,1,,T-01,평면,1200.0,600.0,1190.0,590.0,50.0,0.720,0.4,0.0,0.0,10.0,10.0,,판재 초과,판재 한도를 넘습니다',
  );
  assert.match(
    lines.find((l) => l.startsWith('P-2-4')),
    /실패,넓이 0 · 패널이 너무 작습니다$/,
  );
  const types = scheduleCsv('types', r).slice(1).trimEnd().split('\r\n');
  assert.equal(
    types[0],
    '타입,수,등급,꼭짓점 수,대표 패널,판 가로(mm),판 세로(mm),최대 편차(mm),거울상 짝',
  );
  assert.equal(types[1], 'T-01,4,평면,4,P-1-1,1190.0,590.0,0.0,');
  assert.match(scheduleCsv('nodes', r), /N-01,3,4,90\.0 \/ 90\.0 \/ 90\.0 \/ 90\.0/);
  assert.match(scheduleCsv('joints', r), /J-01,10,-0\.5~0\.5,600\.0,6\.000/);
  // Only the layout yet: the later columns are empty.
  const early = scheduleCsv('panels', { layout: r.layout }).slice(1).split('\r\n')[1];
  assert.equal(early, 'P-1-1,0,1,1,,,,1200.0,600.0,,,,0.720,,,,,,,정상,');
});

test('question cards ask the stage’s missing values, recommended first', () => {
  const params = panelingParams({
    pattern: 'user',
    width: 'user',
    height: 'user',
    thickness: 'user',
  });
  const v = values(params);
  const cards = stageQuestions(params, 'members', v);
  assert.deepEqual(
    cards.map((c) => c.id),
    ['thicknessSide', 'joint', 'boundaryJoint'],
  );
  const side = cards[0];
  assert.deepEqual(side.options[0], {
    id: 'v:outside',
    label: '바깥',
    recommended: true,
    hint: '추천값',
  });
  assert.equal(side.allowFree, false);
  const joint = cards[1];
  assert.equal(joint.title, '줄눈을(를) 정해 주세요');
  assert.deepEqual(joint.options, [
    { id: 'recommended', label: '10 mm', hint: '추천값', recommended: true },
  ]);
  assert.equal(joint.allowFree, true);
  const jointSetting = params.find((p) => p.key === 'joint');
  assert.deepEqual(answerValue(jointSetting, { text: '12' }), { value: 0.012 });
  assert.deepEqual(answerValue(jointSetting, { optionId: 'recommended' }), { value: 0.01 });
  assert.match(answerValue(jointSetting, { text: '900' }).error, /0 mm~200 mm 안에서/);
  assert.match(answerValue(jointSetting, { text: '열' }).error, /숫자를 적어/);
  assert.deepEqual(
    answerValue(
      params.find((p) => p.key === 'boundaryJoint'),
      { optionId: 'v:half' },
    ),
    {
      value: 'half',
    },
  );
  const pattern = stageQuestions(panelingParams(), 'preview', values(panelingParams()))[0];
  assert.equal(pattern.title, '패턴은 무엇으로 할까요?');
  assert.equal(pattern.options[0].label, '사각 격자');
});

test('routing words open 패널링 from a request', () => {
  const jigs = [
    {
      id: 'vide/paneling',
      name: '패널링',
      source: 'skill',
      ...OFFICIAL_TOOL_ROUTING['vide/paneling'],
    },
  ];
  for (const body of ['이 면 패널로 나눠 줘', '곡면 분할해서 패널 타입 보자', '패널 분할 해줘']) {
    const found = jigFor(body, jigs);
    assert.equal(found?.jig.id, 'vide/paneling', body);
    assert.equal(found?.score, 2, body);
  }
  // One word alone is left to Jev.
  assert.equal(jigFor('패널링', jigs)?.score, 1);
  assert.equal(jigFor('창호 일람표 만들어', jigs), undefined);
});
