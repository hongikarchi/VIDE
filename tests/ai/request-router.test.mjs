import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRoute } from '../../src/ai/request-router.ts';

const subjects = [
  { id: 'kind:문자', label: '문자 (text annotations), 3 objects' },
  { id: 'layer:A-WALL', label: 'layer "A-WALL", 2 objects' },
];
const reply = (answers) => async (_url, init) => {
  reply.sent = JSON.parse(init.body);
  return Response.json({ answers });
};

test('Jev decides view actions and objects; the file words decide file work without a call', async () => {
  const view = await decideRoute(
    { body: '벽만 보여줘', subjects },
    {
      key: () => 'k',
      fetchImpl: reply({
        target: { choice: 'view', confidence: 0.99 },
        action: { choice: 'isolate', confidence: 0.9 },
        subject: { choice: 's1', confidence: 0.9 },
      }),
    },
  );
  assert.deepEqual([view.target, view.action, view.subject], ['view', 'isolate', 'layer:A-WALL']);
  assert.match(reply.sent.questions.subject.criteria.s0, /문자/);
  assert.ok(reply.sent.questions.subject.criteria.none);
  const file = await decideRoute(
    { body: '보 단면 바꿔줘', subjects },
    { key: () => 'k', fetchImpl: reply({ target: { choice: 'document', confidence: 0.95 } }) },
  );
  assert.equal(file.target, 'document');
  let called = false;
  const named = await decideRoute(
    { body: 'CAD에서 해치 숨겨줘', subjects },
    { key: () => 'k', fetchImpl: async () => ((called = true), Response.json({})) },
  );
  assert.equal(named.target, 'document');
  assert.equal(called, false);
});

test('no key, an unsure answer, an unknown action or a failure leaves it to the rules', async () => {
  assert.equal(await decideRoute({ body: '숨겨', subjects }, { key: () => '' }), undefined);
  assert.equal(
    await decideRoute(
      { body: '숨겨', subjects },
      { key: () => 'k', fetchImpl: reply({ target: { choice: 'view', confidence: 0.4 } }) },
    ),
    undefined,
  );
  assert.equal(
    await decideRoute(
      { body: '숨겨', subjects },
      {
        key: () => 'k',
        fetchImpl: reply({
          target: { choice: 'view', confidence: 0.9 },
          action: { choice: 'paint' },
        }),
      },
    ),
    undefined,
  );
  assert.equal(
    await decideRoute(
      { body: '숨겨', subjects },
      { key: () => 'k', fetchImpl: async () => new Response('x', { status: 500 }) },
    ),
    undefined,
  );
  assert.equal(
    await decideRoute(
      { body: '숨겨', subjects },
      {
        key: () => 'k',
        fetchImpl: async () => {
          throw new Error('offline');
        },
      },
    ),
    undefined,
  );
});

// ── T-049: seven routes in one call, the fixed payload, the FR-18 switch, input roles. ──
const params = [
  { key: 'spanMax', title: '경간 상한', help: '거더 경간의 상한' },
  { key: 'beamSpacing', title: '작은보 간격' },
];
const jigs = [
  {
    id: 'structure',
    name: '구조 분석',
    intent: 'Steel frame structural check',
    words: ['구조 검토'],
  },
  { id: 'sync', name: 'Sync', intent: 'Compare a Rhino model with a CAD drawing', words: [] },
];
const links = [
  { id: 'link-a', label: 'Rhino 모델 1' },
  { id: 'link-b', label: 'CAD 1' },
];
const query = (body, extra = {}) => ({ body, subjects, params, jigs, links, ...extra });
const never = async () => {
  throw new Error('Jev must not be called');
};

test('one call asks every route question and maps each answer; no-AI routes choose no model', async () => {
  const { judgeRoute } = await import('../../src/ai/request-router.ts');
  const param = await decideRoute(query('작은보 좀 더 빽빽하게'), {
    key: () => 'k',
    fetchImpl: reply({
      target: { choice: 'param', confidence: 0.9 },
      param: { choice: 'p1', confidence: 0.8 },
      task: { choice: 'complex', confidence: 0.9 },
    }),
  });
  assert.deepEqual(
    [param.target, param.by, param.param, param.ai, param.task],
    ['param', 'jev', 'beamSpacing', false, undefined],
  );
  const asked = reply.sent.questions;
  assert.deepEqual(Object.keys(asked.target.criteria), [
    'view',
    'param',
    'app',
    'jig',
    'ask',
    'document',
    'make',
  ]);
  assert.equal(asked.param.criteria.p0, '경간 상한 — 거더 경간의 상한');
  assert.equal(asked.jig.criteria.j0, 'Steel frame structural check');
  assert.equal(asked.jig_fit.type, 'noul');
  assert.equal(asked.link.criteria.l1, 'CAD 1');
  assert.ok(asked.app_action.criteria.sync_link && asked.provider.criteria['codex-cli']);
  // Task and area are asked only when a conversation opens, and used only for AI routes.
  assert.equal(asked.task, undefined);
  const opening = await decideRoute(query('이 보 옮겨 줘', { opening: true }), {
    key: () => 'k',
    fetchImpl: reply({
      target: { choice: 'document', confidence: 0.9 },
      task: { choice: 'simple_edit', confidence: 0.8 },
      domain: { choice: 'geometry', confidence: 0.7 },
    }),
  });
  assert.ok(reply.sent.questions.task && reply.sent.questions.domain);
  assert.deepEqual([opening.ai, opening.task, opening.domain], [true, 'simple_edit', 'geometry']);
  const app = await decideRoute(query('계정 바꿔 줘'), {
    key: () => 'k',
    fetchImpl: reply({
      target: { choice: 'app', confidence: 0.8 },
      app_action: { choice: 'switch_account', confidence: 0.8 },
      provider: { choice: 'claude-cli', confidence: 0.7 },
      link: { choice: 'none' },
    }),
  });
  assert.deepEqual(
    [app.target, app.app, app.provider, app.link, app.ai],
    ['app', 'switch_account', 'claude-cli', undefined, false],
  );
  const syncOther = await decideRoute(query('두 번째 거 다시 가져와'), {
    key: () => 'k',
    fetchImpl: reply({
      target: { choice: 'app', confidence: 0.8 },
      app_action: { choice: 'sync_link', confidence: 0.8 },
      link: { choice: 'l1', confidence: 0.8 },
    }),
  });
  assert.equal(syncOther.link, 'link-b');
  // A jig is proposed only when Jev thinks a listed tool fits (Noul ≥ 0.30).
  const fits = (noul) =>
    judgeRoute(query('도면이랑 모델 차이 봐 줘'), {
      key: () => 'k',
      fetchImpl: reply({
        target: { choice: 'jig', confidence: 0.9 },
        jig: { choice: 'j1', confidence: 0.9 },
        jig_fit: { noul },
      }),
    });
  const fit = (await fits(0.7)).decision;
  assert.deepEqual([fit.jig, fit.jigName, fit.ai], ['sync', 'Sync', false]);
  assert.deepEqual([(await fits(0.2)).decision, (await fits(0.2)).reason], [undefined, 'NO_JIG']);
  const ask = await decideRoute(query('보 춤 900 회신 왔어?'), {
    key: () => 'k',
    fetchImpl: reply({ target: { choice: 'ask', confidence: 0.9 } }),
  });
  assert.deepEqual([ask.target, ask.ai], ['ask', true]);
  // A setting target without open settings is not offered, so the answer counts as none.
  const closed = await judgeRoute(
    { body: '경간 줄여', subjects },
    { key: () => 'k', fetchImpl: reply({ target: { choice: 'param', confidence: 0.9 } }) },
  );
  assert.equal(reply.sent.questions.target.criteria.param, undefined);
  assert.deepEqual([closed.decision, closed.reason], [undefined, 'NO_ANSWER']);
});

test('words decided without Jev need no call and no key; no-AI routes choose no model', async () => {
  const options = { key: () => 'k', fetchImpl: never };
  const jig = await decideRoute(query('구조 검토하고 싶어'), options);
  assert.deepEqual(
    [jig.target, jig.by, jig.jig, jig.jigName, jig.ai],
    ['jig', 'rules', 'structure', '구조 분석', false],
  );
  const login = await decideRoute(query('codex 로그인해줘'), { key: () => '' });
  assert.deepEqual([login.target, login.app, login.provider], ['app', 'login', 'codex-cli']);
  // Sync words decide no app action (T-188): this question goes to the AI.
  const sync = await decideRoute(query('Sync 완료된 도면에서 원 개수 알려줘'), options);
  assert.deepEqual([sync.target, sync.app, sync.ai], ['document', undefined, true]);
  const param = await decideRoute(query('경간 11로'), options);
  assert.deepEqual([param.target, param.param, param.ai], ['param', 'spanMax', false]);
  const make = await decideRoute(query('이거 jig로 만들어 줘'), options);
  assert.deepEqual([make.target, make.ai], ['make', true]);
});

test('the switch off (FR-18), no key, a slow or failing Jev: no decision and the reason', async () => {
  const { judgeRoute } = await import('../../src/ai/request-router.ts');
  let calls = 0;
  const counted = async () => (calls++, Response.json({}));
  assert.equal(
    (await judgeRoute(query('숨겨'), { key: () => 'k', enabled: false, fetchImpl: counted }))
      .reason,
    'OFF',
  );
  assert.equal(calls, 0);
  assert.equal((await judgeRoute(query('숨겨'), { key: () => '' })).reason, 'NO_KEY');
  const slow = await judgeRoute(query('숨겨'), {
    key: () => 'k',
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason)),
      ),
  });
  assert.equal(slow.reason, 'TIMEOUT');
  assert.equal(
    (
      await judgeRoute(query('숨겨'), {
        key: () => 'k',
        fetchImpl: async () => new Response('', { status: 503 }),
      })
    ).reason,
    'HTTP_503',
  );
  assert.equal(
    (
      await judgeRoute(query('숨겨'), {
        key: () => 'k',
        fetchImpl: reply({ target: { choice: 'view', confidence: 0.3 } }),
      })
    ).reason,
    'LOW_CONFIDENCE',
  );
});

test('the Jev request carries only the fixed items: no file names, paths or folder names', async () => {
  const { routePayload } = await import('../../src/ai/request-router.ts');
  const payload = routePayload({
    body: 'C:\\work\\S-06\\S06-plan.dwg 에서 \\\\server\\share\\S-06 폴더의 기둥만 보여줘 (S06_frame.3dm)',
    subjects: [
      { id: 'layer:x', label: 'layer "S06-plan.dwg|A-WALL", 3 objects' },
      { id: 'layer:y', label: 'layer "D:\\cad\\xref\\A-COL", 2 objects' },
    ],
    params: [{ key: 'k', title: '경간 상한', help: '기준: /home/user/S-06/spec.pdf' }],
    links: [{ id: 'link-a', label: 'Rhino 모델 1' }],
  });
  const sent = JSON.stringify(payload);
  for (const secret of [
    'S06-plan',
    'S06_frame',
    'work\\\\',
    'server',
    'share',
    'spec.pdf',
    '/home',
    'D:',
  ])
    assert.ok(!sent.includes(secret), secret);
  assert.match(payload.state, /\[경로\]/);
  assert.match(payload.questions.subject.criteria.s0, /A-WALL/);
  assert.ok(payload.state.length < 2400);
});

test('the FR-18 switch is kept per data folder; an unreadable file counts as off', async () => {
  const { RouteSettings, routeSettingsFor } = await import('../../src/ai/request-router.ts');
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = await mkdtemp(join(tmpdir(), 'vide-route-settings-'));
  try {
    const file = join(folder, 'route-settings.json');
    const settings = new RouteSettings(file);
    assert.deepEqual(settings.get(), { jev: true });
    assert.deepEqual(settings.set({ jev: false }), { jev: false });
    assert.deepEqual(new RouteSettings(file).get(), { jev: false });
    await writeFile(file, '{not json');
    assert.deepEqual(new RouteSettings(file).get(), { jev: false });
    // In memory (tests, ':memory:' stores): one object per owner.
    const owner = {};
    routeSettingsFor(owner).set({ jev: false });
    assert.deepEqual(routeSettingsFor(owner).get(), { jev: false });
    assert.deepEqual(routeSettingsFor({}).get(), { jev: true });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('input roles: one AI step proposes open roles; the gate keeps only listed roles, files and layers', async () => {
  const { inputRolesRequest, checkInputRoles } = await import('../../src/ai/request-router.ts');
  const roles = [
    { role: 'columns', title: '신설 기둥', shape: 'footprint', many: true, required: true },
    { role: 'girders', title: '거더', shape: 'line', many: true, required: true },
    { role: 'existingFootings', title: '기존 기초', shape: 'footprint', many: true },
  ];
  const sources = [
    {
      id: 'read-1',
      label: 'Rhino 모델 1',
      layers: [
        { name: 'S-COL', count: 40, kinds: { block: 40 } },
        { name: 'S-GIRDER', count: 60, kinds: { curve: 60 } },
      ],
    },
    { id: 'read-2', label: 'CAD 1', layers: [{ name: 'EX-FTG', count: 12, kinds: { curve: 12 } }] },
  ];
  const picked = [{ role: 'columns', source: 'read-1', layers: ['S-COL'] }];
  const request = inputRolesRequest({ roles, sources, picked });
  assert.equal(request.jig.kind, 'input-roles');
  assert.deepEqual(request.jig.roles, ['girders', 'existingFootings']);
  assert.equal(request.permission, 'review');
  const attached = JSON.parse(request.files[0].text);
  assert.deepEqual(
    attached.roles.map((role) => role.role),
    ['girders', 'existingFootings'],
  );
  assert.deepEqual(attached.filled, picked);
  assert.equal(attached.sources[1].label, 'CAD 1');
  assert.match(request.body, /좌표·치수는 만들지 마/);
  const answer = [
    '제안입니다.',
    '```json',
    JSON.stringify({
      roles: [
        {
          role: 'girders',
          source: 'read-1',
          layers: ['S-GIRDER', 'S-BEAM'],
          reason: '거더\n레이어',
        },
        {
          role: 'existingFootings',
          source: 'read-2',
          layers: ['EX-FTG'],
          reason: '기존 기초 레이어',
        },
        { role: 'columns', source: 'read-1', layers: ['S-COL'], reason: '' },
        { role: 'roof', source: 'read-1', layers: ['S-COL'] },
        { role: 'girders', source: 'read-2', layers: ['EX-FTG'] },
      ],
    }),
    '```',
  ].join('\n');
  const checked = checkInputRoles(answer, { roles, sources, picked });
  assert.equal(checked.gate, 'ref-whitelist');
  assert.deepEqual(checked.proposals, [
    { role: 'girders', source: 'read-1', layers: ['S-GIRDER'], reason: '거더 레이어' },
    { role: 'existingFootings', source: 'read-2', layers: ['EX-FTG'], reason: '기존 기초 레이어' },
  ]);
  assert.deepEqual(
    checked.rejected.map((entry) => [entry.role, entry.layer ?? null, entry.why]),
    [
      ['girders', 'S-BEAM', 'UNKNOWN_LAYER'],
      ['columns', null, 'ALREADY_PICKED'],
      ['roof', null, 'UNKNOWN_ROLE'],
      ['girders', null, 'DUPLICATE_ROLE'],
    ],
  );
  const lost = checkInputRoles(
    '{"roles":[{"role":"girders","source":"read-9","layers":["S-GIRDER"]}]}',
    { roles, sources },
  );
  assert.deepEqual(lost.rejected, [{ role: 'girders', source: 'read-9', why: 'UNKNOWN_SOURCE' }]);
  assert.deepEqual(checkInputRoles('모르겠습니다', { roles, sources }).rejected, [
    { why: 'NOT_JSON' },
  ]);
});
