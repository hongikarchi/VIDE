import test from 'node:test';
import assert from 'node:assert/strict';
import {
  continueSkill,
  revertSkill,
  leftSteps,
  skillChecklist,
  skillTurnStatus,
  startSkill,
} from '../../src/ui/skill-start.ts';

// startSkill (RESEARCH-12 §6.3, ADR-026 4, SPEC-07.18 3): one sequence for the router's fast path,
// the JIG list and the AI's jig_open; the screen's parts are mocked, the engine is a fake API.
const s06 = {
  id: 'project/s06-frame',
  name: 'S-06 골조 배치',
  kind: 'instance',
  scope: 'project',
  version: '0.3.0',
  invocation: 'auto',
  open: { reuse: 'last' },
  fromRequest: ['spanMax'],
  autorun: { until: 'first-hard', step: 'confirmAnalysis' },
};
const legacy = {
  id: 'structure',
  name: '구조 분석',
  kind: 'legacy',
  scope: 'official',
  invocation: 'auto',
  open: { reuse: 'last' },
  fromRequest: [],
  autorun: { until: 'first-hard' },
};
const hidden = { ...s06, id: 'project/hidden', name: '숨은 jig', invocation: 'user-only' };
const view = (id) => ({
  id,
  title: '작업본 1',
  jig: { id: 's06', name: 'S-06 골조 배치' },
  params: [
    {
      key: 'spanMax',
      title: '경간 상한',
      type: 'length',
      unit: 'm',
      displayUnit: 'm',
      range: { min: 8, max: 20, step: 0.5 },
      value: 12,
    },
  ],
  steps: [
    { id: 'analysis', title: '해석', kind: 'code' },
    { id: 'confirmAnalysis', title: '해석 확정', kind: 'human' },
  ],
});
const report = {
  steps: [
    { id: 'analysis', kind: 'code', status: 'done' },
    { id: 'confirmAnalysis', kind: 'human', status: 'waiting' },
  ],
  blocked: true,
};

function harness({ instances = [], conversations = [], active = null, panelRuns = true } = {}) {
  const calls = [];
  const events = [];
  const rows = [...instances];
  let selected = active;
  const api = async (path, method = 'GET', data) => {
    calls.push([method, path.replace('/projects/p1', ''), data]);
    const rest = path.replace('/projects/p1', '');
    if (rest === '/jig-instances' && method === 'GET') return { instances: rows };
    if (rest === '/jig-instances' && method === 'POST') {
      const row = { id: 'new-1', jigId: data.jig, title: data.title, updatedAt: 'z' };
      rows.push(row);
      return view(row.id);
    }
    if (/^\/jig-instances\/[^/]+$/.test(rest)) return view(rest.split('/').at(-1));
    if (rest.endsWith('/params') && method === 'PUT') return { seqs: [7] };
    if (rest.endsWith('/run')) return report;
    if (rest === '/conversations' && method === 'GET') return conversations;
    if (rest === '/conversations' && method === 'POST') return { id: 'c-new' };
    return { ok: true };
  };
  const deps = {
    api,
    projectId: () => 'p1',
    catalog: async () => [s06, legacy, hidden],
    openTab: (tab) => events.push(['open', tab.instanceId]),
    closeTab: (id) => events.push(['close', id]),
    isTabOpen: (id) => events.some(([kind, value]) => kind === 'open' && value === id),
    legacyTab: (id) =>
      id === 'structure' ? { instanceId: 'legacy:structure', label: '구조' } : undefined,
    preferRun: (id, preference) => events.push(['prefer', id, preference?.mode, preference?.until]),
    paramsChanged: (id) => events.push(['changed', id]),
    waitForRun: async (id) => {
      events.push(['wait', id]);
      return panelRuns ? report : undefined;
    },
    conversations: {
      active: () => selected,
      select: (id) => {
        selected = id;
        events.push(['select', id]);
      },
      refresh: async () => {},
    },
  };
  return { deps, calls, events, selected: () => selected };
}

test('자동: reuse the latest instance, bind a new jig conversation, apply the request value, compute to the checkpoint, record', async () => {
  const h = harness({
    instances: [
      { id: 'old', jigId: 'project/s06-frame', title: '작업본 1', updatedAt: '2026-09-01' },
      { id: 'last', jigId: 'project/s06-frame', title: '작업본 2', updatedAt: '2026-09-30' },
      { id: 'other', jigId: 'project/example-grid', title: 'x', updatedAt: '2026-10-01' },
    ],
  });
  const start = await startSkill(h.deps, 'project/s06-frame', {
    mode: 'auto',
    request: '경간 11로 해서 구조 분석 해줘',
    by: 'rules',
  });
  assert.equal(start.instanceId, 'last');
  assert.equal(start.created, false);
  assert.equal(start.pending, false);
  assert.equal(start.conversationId, 'c-new');
  assert.equal(start.conversationCreated, true);
  assert.deepEqual(start.seqs, [7]);
  assert.deepEqual(
    start.values.map((v) => [v.key, v.value]),
    [['spanMax', 11]],
  );
  assert.deepEqual(start.summary, { done: 1, waiting: ['해석 확정'], failed: [] });
  // No instance was made; the conversation is made with the jig bound and the request text.
  assert.ok(!h.calls.some(([m, p]) => m === 'POST' && p === '/jig-instances'));
  const made = h.calls.find(([m, p]) => m === 'POST' && p === '/conversations');
  assert.deepEqual([made[2].kind, made[2].jigInstanceId], ['jig-run', 'last']);
  // Order: conversation selected → preference → tab → value → the panel's run.
  const order = h.events.map((e) => e[0]);
  assert.ok(order.indexOf('select') < order.indexOf('open'));
  assert.ok(order.indexOf('prefer') < order.indexOf('open'));
  assert.deepEqual(h.events.find((e) => e[0] === 'prefer').slice(2), [
    'confirmed',
    'confirmAnalysis',
  ]);
  const put = h.calls.find(([m, p]) => m === 'PUT' && p.endsWith('/params'));
  assert.deepEqual(put[2].values, [{ key: 'spanMax', value: 11 }]);
  // The panel ran it; the engine's run was not called again.
  assert.ok(!h.calls.some(([, p]) => p.endsWith('/run')));
  const ledger = h.calls.filter(([, p]) => p.endsWith('/ledger')).map(([, , d]) => d.body);
  assert.equal(ledger.at(-1).appAction, 'skill_start');
  assert.deepEqual(
    ledger.at(-1).applied.map((a) => a.key),
    ['spanMax'],
  );
});

test('자동 without an instance: one is made without an output layer; no panel run → the start runs it', async () => {
  const h = harness({ panelRuns: false });
  const start = await startSkill(h.deps, 'project/s06-frame', {
    mode: 'auto',
    request: '구조 분석',
  });
  const post = h.calls.find(([m, p]) => m === 'POST' && p === '/jig-instances');
  assert.deepEqual(post[2], {
    jig: 'project/s06-frame',
    version: '0.3.0',
    title: '작업본 1',
    layerRootLater: true,
  });
  assert.equal(start.created, true);
  const run = h.calls.find(([, p]) => p.endsWith('/run'));
  assert.deepEqual(run[2], { mode: 'confirmed', until: 'confirmAnalysis' });
  assert.deepEqual(start.values, []);
});

test('계획: open and bind only; [진행] applies, computes and records', async () => {
  const h = harness({
    instances: [{ id: 'last', jigId: 'project/s06-frame', title: '작업본 2', updatedAt: 'b' }],
    conversations: [{ id: 'c1', kind: 'jig-run', state: 'open', jigInstanceId: 'last' }],
  });
  const start = await startSkill(h.deps, 'project/s06-frame', {
    mode: 'plan',
    request: '경간 11로 구조 분석',
  });
  assert.equal(start.pending, true);
  // The conversation already on the instance is reused, not rebound.
  assert.equal(start.conversationId, 'c1');
  assert.ok(!h.calls.some(([, p]) => p.endsWith('/bind')));
  assert.ok(h.events.some((e) => e[0] === 'open'));
  assert.ok(!h.events.some((e) => e[0] === 'prefer'), '계획 does not compute on open');
  assert.ok(!h.calls.some(([m]) => m === 'PUT'), 'no value applied yet');
  const list = skillChecklist(start);
  assert.deepEqual(
    list.map((i) => i.done),
    [true, true, false, false, false],
  );
  assert.match(list[2].text, /경간 상한 12 m → 11 m/);
  await continueSkill(h.deps, start, '경간 11로 구조 분석');
  assert.equal(start.pending, false);
  assert.ok(h.calls.some(([m]) => m === 'PUT'));
  // The tab showed already: its panel is told to run again.
  assert.ok(h.events.some((e) => e[0] === 'changed'));
  assert.equal(
    h.calls.filter(([, p]) => p.endsWith('/ledger')).at(-1)[2].body.appAction,
    'skill_start',
  );
});

test('계획 without an instance: nothing is made until [진행] (ADR-026)', async () => {
  const h = harness({
    active: 'c0',
    conversations: [{ id: 'c0', kind: 'general', state: 'open', requests: 0 }],
  });
  const start = await startSkill(h.deps, 'project/s06-frame', {
    mode: 'plan',
    request: '구조 분석',
  });
  assert.equal(start.needsInstance, true);
  assert.ok(!h.calls.some(([m, p]) => m === 'POST' && p === '/jig-instances'));
  assert.ok(!h.events.some((e) => e[0] === 'open'));
  assert.match(skillChecklist(start)[0].text, /작업본 만들기/);
  await continueSkill(h.deps, start, '구조 분석');
  assert.ok(h.calls.some(([m, p]) => m === 'POST' && p === '/jig-instances'));
  // The empty general conversation the composer had takes the jig.
  const bind = h.calls.find(([, p]) => p.endsWith('/bind'));
  assert.deepEqual([bind[1], bind[2]], ['/conversations/c0/bind', { jigInstanceId: 'new-1' }]);
  assert.equal(start.conversationCreated, false);
  assert.ok(h.events.some((e) => e[0] === 'open' && e[1] === 'new-1'));
});

test('user-only jigs are never opened by the router or the AI; legacy jigs only open', async () => {
  const h = harness();
  await assert.rejects(
    startSkill(h.deps, 'project/hidden', { mode: 'auto', by: 'rules' }),
    (error) => error.code === 'JIG_USER_ONLY',
  );
  await assert.rejects(
    startSkill(h.deps, 'project/hidden', { mode: 'auto', by: 'ai' }),
    (error) => error.code === 'JIG_USER_ONLY',
  );
  await assert.rejects(startSkill(h.deps, 'nope', { mode: 'auto' }), (e) => e.code === 'NOT_FOUND');
  const opened = await startSkill(h.deps, 'project/hidden', {
    mode: 'auto',
    by: 'user',
    openOnly: true,
  });
  assert.equal(opened.pending, false);
  assert.ok(!h.events.some((e) => e[0] === 'prefer'), 'the list [열기] does not compute');
  const old = await startSkill(h.deps, 'structure', { mode: 'auto', request: '구조 분석 해줘' });
  assert.equal(old.legacy, true);
  assert.ok(h.events.some((e) => e[0] === 'open' && e[1] === 'legacy:structure'));
});

test('[일반 대화로]: close the tab it opened, undo its values, close its new conversation, count the reversal', async () => {
  const h = harness({
    active: 'c-before',
    instances: [{ id: 'last', jigId: 'project/s06-frame', title: '작업본 2', updatedAt: 'b' }],
  });
  const start = await startSkill(h.deps, 'project/s06-frame', {
    mode: 'auto',
    request: '경간 11로 구조 분석',
    by: 'jev',
  });
  await revertSkill(h.deps, start);
  assert.ok(h.events.some((e) => e[0] === 'close' && e[1] === 'last'));
  assert.deepEqual(
    h.events
      .filter((e) => e[0] === 'prefer')
      .at(-1)
      .slice(2),
    [undefined, undefined],
  );
  const undo = h.calls.find(([, p]) => p.endsWith('/params/undo'));
  assert.deepEqual(undo[2], { seq: 7 });
  assert.ok(h.calls.some(([, p]) => p === '/conversations/c-new/close'));
  const revert = h.calls.find(([, p]) => p === '/route/revert');
  assert.deepEqual(revert[2], { target: 'jig', by: 'jev' });
  assert.equal(h.selected(), 'c-before');
});

test('[일반 대화로] after a start in the empty tab of [+]: that tab is unbound again, so the turn gets no jig tools', async () => {
  const h = harness({
    active: 'c-tab',
    conversations: [
      { id: 'c-tab', kind: 'general', state: 'open', requests: 0 },
      { id: 'c-bound', kind: 'jig-run', state: 'open', requests: 2, jigInstanceId: 'other' },
    ],
    instances: [{ id: 'last', jigId: 'project/s06-frame', title: '작업본 2', updatedAt: 'b' }],
  });
  const start = await startSkill(h.deps, 'project/s06-frame', {
    mode: 'auto',
    request: '구조 분석',
    by: 'rules',
  });
  // The empty tab took the jig (no second empty conversation).
  assert.equal(start.conversationId, 'c-tab');
  assert.equal(start.conversationCreated, false);
  assert.equal(start.boundExisting, true);
  await revertSkill(h.deps, start);
  const unbind = h.calls.find(([, p]) => p.endsWith('/unbind'));
  assert.deepEqual(
    [unbind?.[0], unbind?.[1], unbind?.[2]],
    ['POST', '/conversations/c-tab/unbind', { jigInstanceId: 'last' }],
  );
  // The tab is not closed (it was the person's), and it is the one the words go to.
  assert.ok(!h.calls.some(([, p]) => p === '/conversations/c-tab/close'));
  assert.equal(h.selected(), 'c-tab');
});

test('[일반 대화로] never unbinds a conversation that was already on the instance', async () => {
  const h = harness({
    active: 'c-jig',
    conversations: [
      { id: 'c-jig', kind: 'jig-run', state: 'open', requests: 3, jigInstanceId: 'last' },
    ],
    instances: [{ id: 'last', jigId: 'project/s06-frame', title: '작업본 2', updatedAt: 'b' }],
  });
  const start = await startSkill(h.deps, 'project/s06-frame', { mode: 'auto', by: 'rules' });
  assert.equal(start.conversationId, 'c-jig');
  assert.equal(start.boundExisting, false);
  await revertSkill(h.deps, start);
  assert.ok(!h.calls.some(([, p]) => p.endsWith('/unbind')));
});

test('skillTurnStatus (T-272, SPEC-02.17 2): the row settles when the AI turn ends', () => {
  const start = {
    legacy: false,
    instanceTitle: '작업본 1',
    left: ['법규 체크'],
  };
  // Still going: no change, the row keeps 'AI가 요약하는 중'.
  assert.equal(skillTurnStatus('queued', start), undefined);
  assert.equal(skillTurnStatus('running', start), undefined);
  assert.equal(
    skillTurnStatus('succeeded', start),
    "응답 완료 · 작업본 '작업본 1' 열림 · '법규 체크' 전",
  );
  assert.equal(
    skillTurnStatus('failed', { ...start, left: [] }),
    "응답 실패 · 작업본 '작업본 1' 열림",
  );
  assert.equal(skillTurnStatus('cancelled', start).startsWith('응답 중단'), true);
  assert.equal(skillTurnStatus('succeeded', undefined), '응답 완료 · 열림');
  for (const state of ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'])
    assert.doesNotMatch(skillTurnStatus(state, start), /요약하는 중/);
});

// SPEC-12.3의 6 (T-273): the site address — ① the request's words, ② the project's confirmed
// site address (the latest other workbook whose target a person confirmed), ③ ask in the panel.
const siteJig = {
  id: 'vide/site-model',
  name: '사이트 모델링',
  kind: 'instance',
  scope: 'official',
  version: '0.2.1',
  invocation: 'auto',
  open: { reuse: 'new' },
  fromRequest: [],
  autorun: { until: 'first-hard', step: 'confirmTarget' },
};
function siteHarness(stored = {}) {
  const calls = [];
  const rows = Object.keys(stored).map((id, i) => ({
    id,
    jigId: siteJig.id,
    title: `작업본 ${i + 1}`,
    updatedAt: stored[id].updatedAt,
  }));
  const siteView = (id) => ({
    id,
    title: id,
    jig: { id: siteJig.id, name: siteJig.name },
    params: [],
    inputs: [{ key: 'site', kind: 'site-data' }],
    steps: [
      { id: 'candidates', title: '필지 후보', kind: 'code', status: 'done' },
      {
        id: 'confirmTarget',
        title: '대상 필지 확정',
        kind: 'human',
        status: stored[id]?.confirmed ? 'confirmed' : 'waiting',
      },
    ],
    body: { siteData: stored[id]?.site ? { site: stored[id].site } : {} },
  });
  const api = async (path, method = 'GET', data) => {
    const rest = path.replace('/projects/p1', '');
    calls.push([method, rest, data]);
    if (rest === '/jig-instances' && method === 'GET') return { instances: rows };
    if (rest === '/jig-instances' && method === 'POST') {
      rows.push({ id: 'fresh', jigId: data.jig, title: data.title, updatedAt: 'z' });
      return siteView('fresh');
    }
    if (/^\/jig-instances\/[^/]+$/.test(rest)) return siteView(rest.split('/').at(-1));
    if (rest.endsWith('/run')) return report;
    if (rest === '/conversations' && method === 'GET') return [];
    if (rest === '/conversations' && method === 'POST') return { id: 'c-new' };
    return { ok: true };
  };
  const deps = {
    api,
    projectId: () => 'p1',
    catalog: async () => [siteJig],
    openTab: () => {},
    closeTab: () => {},
    isTabOpen: () => false,
    legacyTab: () => undefined,
    preferRun: () => {},
    paramsChanged: () => {},
    waitForRun: async () => report,
    conversations: { active: () => null, select: () => {}, refresh: async () => {} },
  };
  const lookups = () =>
    calls.filter(([method, rest]) => method === 'POST' && rest.endsWith('/site-data/site/lookup'));
  return { deps, calls, lookups };
}

test('site address ①: the address in the request wins over the project one', async () => {
  const h = siteHarness({
    old: {
      updatedAt: '2026-10-01',
      confirmed: true,
      site: { query: '합성동 1-1', targets: { pnus: ['1111010100100010001'], by: 'user' } },
    },
  });
  const start = await startSkill(h.deps, siteJig.id, {
    mode: 'auto',
    request: '가나동 12-3 대지 모델링해 줘',
  });
  assert.deepEqual(start.site, { key: 'site', query: '가나동 12-3', from: 'request' });
  assert.equal(start.siteAsk, undefined);
  assert.deepEqual(
    h.lookups().map(([, , data]) => data.query),
    ['가나동 12-3'],
  );
});

test('site address ②: no address in the words → the latest confirmed workbook of the project', async () => {
  const h = siteHarness({
    older: {
      updatedAt: '2026-09-01',
      confirmed: true,
      site: { query: '합성동 9-9', targets: { pnus: ['1111010100100090009'], by: 'user' } },
    },
    newer: {
      updatedAt: '2026-10-01',
      confirmed: true,
      site: { query: '합성동 1-1', targets: { pnus: ['1111010100100010001'], by: 'proposal' } },
    },
    // A later workbook with an address nobody confirmed is not the project's address.
    unconfirmed: {
      updatedAt: '2026-10-05',
      site: { query: '다른동 5', targets: { pnus: ['1111010100100050000'], by: 'proposal' } },
    },
  });
  const start = await startSkill(h.deps, siteJig.id, {
    mode: 'auto',
    request: '지금 우리 프로젝트 주변 사이트 모델링 해줘',
  });
  assert.equal(start.instanceId, 'fresh');
  assert.deepEqual(start.site, { key: 'site', query: '합성동 1-1', from: 'project' });
  assert.deepEqual(
    h.lookups().map(([, , data]) => data.query),
    ['합성동 1-1'],
  );
  assert.ok(
    skillChecklist(start).some((item) => /합성동 1-1.*프로젝트에서 확정한 주소/.test(item.text)),
  );
});

test('site address ③: no address anywhere → nothing looked up, the panel asks', async () => {
  const h = siteHarness({ draft: { updatedAt: '2026-10-01', site: { query: '가나동 3' } } });
  const start = await startSkill(h.deps, siteJig.id, {
    mode: 'auto',
    request: '지금 우리 프로젝트 주변 사이트 모델링 해줘',
  });
  assert.equal(start.site, undefined);
  assert.equal(start.siteAsk, 'site');
  assert.equal(h.lookups().length, 0);
  const ledger = h.calls.find(([, rest]) => rest.endsWith('/ledger'));
  assert.match(ledger[2].body.siteAsk, /대상 필지 칸/);
  const ask = skillChecklist(start).find((item) => /대지 주소 입력/.test(item.text));
  assert.equal(ask?.done, false);
});

test('leftSteps (SPEC-02.17 2): only steps a person presses — manual skips and due host steps', () => {
  const titles = new Map([
    ['confirmTarget', '대상 필지 확정'],
    ['collect', '수집'],
    ['check', '법규 체크'],
    ['bake', 'Rhino에 만들기'],
    ['roles', '역할 확정'],
  ]);
  // A confirmed human step and steps blocked behind a waiting one are not '전'.
  const report = {
    steps: [
      { id: 'confirmTarget', kind: 'human', status: 'confirmed' },
      { id: 'roles', kind: 'human', status: 'waiting' },
      { id: 'collect', kind: 'code', status: 'blocked' },
      { id: 'bake', kind: 'host', status: 'blocked' },
      { id: 'check', kind: 'code', status: 'skipped' },
    ],
  };
  assert.deepEqual(leftSteps(report, titles), ['법규 체크']);
  // A host step that is due is left for a press.
  assert.deepEqual(
    leftSteps(
      {
        steps: [
          { id: 'confirmTarget', kind: 'human', status: 'confirmed' },
          { id: 'collect', kind: 'code', status: 'done' },
          { id: 'bake', kind: 'host', status: 'waiting' },
        ],
      },
      titles,
    ),
    ['Rhino에 만들기'],
  );
  // A superseded run's skips are not presses.
  assert.deepEqual(
    leftSteps(
      { superseded: true, steps: [{ id: 'check', kind: 'code', status: 'skipped' }] },
      titles,
    ),
    [],
  );
  assert.equal(leftSteps(undefined, titles), undefined);
});
