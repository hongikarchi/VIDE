import test from 'node:test';
import assert from 'node:assert/strict';
import { routeRequest } from '../../src/ui/request-route.ts';

const objects = [
  { id: 't1', type: 'MText', layer: 'A-ANNO', name: '실명' },
  { id: 't2', type: 'DBText', layer: 'A-ANNO' },
  { id: 'l1', type: 'Line', layer: 'S-BEAM' },
  { id: 'h1', type: 'Hatch', layer: 'A-HATCH' },
  { id: 'b1', type: 'Brep', layer: '구조::보', name: 'SG1-01' },
];

test('screen-only requests are resolved against kinds, layers and names', () => {
  const keep = routeRequest('텍스트만 남기고 숨겨줘', objects);
  assert.equal(keep.target, 'view');
  assert.deepEqual(keep.view, { action: 'isolate', ids: ['t1', 't2'], subject: '문자' });
  const hide = routeRequest('해치 숨겨줘', objects);
  assert.deepEqual(hide.view, { action: 'hide', ids: ['h1'], subject: '해치' });
  const layer = routeRequest('구조::보 레이어만 보여줘', objects);
  assert.deepEqual(layer.view?.ids, ['b1']);
  const named = routeRequest('SG1-01 선택해줘', objects);
  assert.deepEqual(named.view, { action: 'select', ids: ['b1'], subject: '이름이 맞는 객체' });
  assert.equal(routeRequest('숨긴 거 다시 다 보여줘', objects).view?.action, 'unhide');
  assert.deepEqual(routeRequest('이거 숨겨', objects, ['l1']).view?.ids, ['l1']);
  // A screen request whose objects cannot be found stays on the screen and says so.
  const unknown = routeRequest('창호 숨겨줘', objects);
  assert.equal(unknown.target, 'view');
  assert.deepEqual(unknown.view?.ids, []);
});

test('words that name or change the file send the request to the file', () => {
  assert.equal(routeRequest('CAD에서 텍스트 숨겨줘', objects).target, 'document');
  assert.equal(routeRequest('해치 지워줘', objects).target, 'document');
  assert.equal(routeRequest('텍스트 레이어 색 바꿔줘', objects).target, 'document');
});

test('short kind words do not match inside other words', () => {
  // "선택" is select, not "선" (lines); "도면" is not "면" (surfaces).
  assert.equal(routeRequest('SG1-01 선택해줘', objects).view?.subject, '이름이 맞는 객체');
  assert.equal(routeRequest('선만 남기고 숨겨', objects).view?.subject, '선');
  assert.equal(routeRequest('면 숨겨줘', objects).view?.subject, '면');
  assert.equal(routeRequest('평면에서 해치 숨겨줘', objects).view?.subject, '해치');
});

test('Jev answers map to view routes over kinds, layers and the selection', async () => {
  const { routeSubjects, jevRoute } = await import('../../src/ui/request-route.ts');
  const subjects = routeSubjects(objects, ['l1']);
  assert.deepEqual(
    subjects.map((subject) => subject.id),
    [
      'selection',
      'kind:문자',
      'kind:해치',
      'kind:면',
      'kind:선',
      'layer:A-ANNO',
      'layer:S-BEAM',
      'layer:A-HATCH',
      'layer:구조::보',
    ],
  );
  assert.deepEqual(
    jevRoute({ target: 'view', action: 'isolate', subject: 'kind:문자' }, subjects).view,
    {
      action: 'isolate',
      ids: ['t1', 't2'],
      subject: '문자',
    },
  );
  assert.equal(jevRoute({ target: 'document' }, subjects).target, 'document');
  assert.equal(jevRoute({ target: null }, subjects), undefined);
  // No objects named by Jev: the ones the rules found ("이거" → the selection).
  const rules = routeRequest('이거 숨겨', objects, ['l1']);
  assert.deepEqual(jevRoute({ target: 'view', action: 'hide' }, subjects, rules).view.ids, ['l1']);
});

// ── T-049: seven routes, values read by code, cards (SPEC-02.17, SPEC-07.6, SPEC-02.19 7). ──
const span = {
  key: 'spanMax',
  title: '경간 상한',
  help: '거더 경간의 상한',
  type: 'length',
  unit: 'm',
  display: { unit: 'm', decimals: 1 },
  default: 12,
  range: { min: 8, max: 20, step: 0.5 },
};
const beams = {
  key: 'beamSpacing',
  title: '작은보 간격',
  type: 'length',
  unit: 'm',
  display: { unit: 'mm', decimals: 0 },
  default: 2.5,
  range: { min: 0.6, max: 3, step: 0.25 },
  words: { more: ['촘촘히', '좁게'], less: ['넓게', '성기게'], sign: -1 },
};
const context = {
  params: [span, beams],
  values: { spanMax: 12, beamSpacing: 2.5 },
  jigs: [{ id: 'structure', name: '구조 분석', words: ['구조 검토', '구조 해석'] }],
};

test('numbers and units: the longest unit first, no letter after it, no digit or name around it', async () => {
  const { quantities, convert } = await import('../../src/ui/request-route.ts');
  const read = (text) => quantities(text).map((q) => [q.value, q.unit]);
  assert.deepEqual(read('900mm'), [[900, 'mm']]);
  assert.deepEqual(read('0.9 m'), [[0.9, 'm']]);
  assert.deepEqual(read('12m로'), [[12, 'm']]);
  assert.deepEqual(read('12 미터'), [[12, 'm']]);
  assert.deepEqual(read('2.5미터'), [[2.5, 'm']]);
  assert.deepEqual(read('90센티'), [[90, 'cm']]);
  assert.deepEqual(read('3 kN/㎡'), [[3, 'kN/m2']]);
  // Names and words are not values: "C12", "B-3", "12ms".
  assert.deepEqual(read('C12 기둥 B-3 12ms'), []);
  assert.equal(convert(900, 'mm', 'm'), 0.9);
  assert.equal(convert(90, 'cm', 'm'), 0.9);
  assert.equal(convert(0.9, 'm', 'mm'), 900);
  assert.equal(convert(3, 'kN', 'm'), undefined);
});

test('a setting changes from the words without the AI; out of range and fixed values are refused', async () => {
  const { paramChange } = await import('../../src/ui/request-route.ts');
  // "경간 11로": a bare number is in the display unit.
  const plain = routeRequest('경간 11로', [], [], context);
  assert.equal(plain.target, 'param');
  assert.equal(plain.param.key, 'spanMax');
  assert.deepEqual(plain.param.change, { ok: true, value: 11, text: '경간 상한 12 m → 11 m' });
  for (const [words, value] of [
    ['경간 상한 12m로', 12],
    ['경간 12 미터로 해줘', 12],
    ['경간 1250센티로', 12.5],
    ['경간을 10m에서 9.5m로', 9.5],
  ])
    assert.equal(routeRequest(words, [], [], context).param.change.value, value, words);
  // A setting shown in mm: "900mm", "0.9 m" and a bare "900" are all 0.9 m.
  for (const words of ['작은보 간격 900mm로', '작은보 간격 0.9 m로', '작은보 간격 900으로'])
    assert.equal(paramChange(words, beams).value, 0.9, words);
  // Relative words: the declaration gives the direction (spacing: denser = smaller) and one step.
  const denser = routeRequest('작은보 조금 더 촘촘히', [], [], context);
  assert.equal(denser.target, 'param');
  assert.equal(denser.param.change.value, 2.25);
  assert.equal(denser.param.change.text, '작은보 간격 2500 mm → 2250 mm');
  assert.equal(paramChange('작은보 넓게', beams, 2.5).value, 2.75);
  assert.equal(paramChange('작은보 두 배 촘촘히', beams, 2.5).value, 1.25);
  assert.equal(paramChange('경간 반으로', span, 16).value, 8);
  // No declared direction: not applied, asked instead.
  assert.equal(paramChange('경간 조금 더 촘촘히', span, 12).code, 'NO_DIRECTION');
  // Out of range: not applied, the range is said.
  assert.deepEqual(paramChange('경간 25로', span, 12), {
    ok: false,
    code: 'OUT_OF_RANGE',
    text: '경간 상한 25 m는 범위 8~20 m 밖이라 바꾸지 않았습니다.',
  });
  assert.equal(paramChange('작은보 간격 5 kN으로', beams, 2.5).code, 'UNIT_MISMATCH');
  const fixed = { key: 'layer', title: '출력 레이어', fixedAtPin: true };
  assert.equal(paramChange('출력 레이어 2로', fixed).code, 'PARAM_FIXED');
  // Two settings named alike, a question or no jig open: not a setting change by the rules.
  const twin = [span, { ...span, key: 'spanMin', title: '경간 하한' }];
  assert.notEqual(routeRequest('경간 11로', [], [], { params: twin }).target, 'param');
  assert.notEqual(routeRequest('보 간격 900 회신 왔어?', [], [], context).target, 'param');
  assert.equal(routeRequest('경간 11로', []).target, 'document');
  // Words that act on objects, the file or the screen: a number beside a setting's key word is
  // not a value for it (a setting change would run on the wrong intent).
  assert.equal(routeRequest('경간 12m 넘는 거더 숨겨', [], [], context).target, 'view');
  assert.equal(
    routeRequest('경간 12m 넘는 거더를 원본에서 지워', [], [], context).target,
    'document',
  );
  assert.equal(routeRequest('작은보 간격 900으로 그려줘', [], [], context).target, 'document');
});

test('words decided without Jev: login, Sync, jig words, making a jig, the file', async () => {
  const { routeCard } = await import('../../src/ui/request-route.ts');
  const login = routeRequest('codex 로그인해줘', [], [], context);
  assert.deepEqual(login.app, { action: 'login', tier: 'T2', provider: 'codex-cli' });
  // Signed in: a notice; not signed in: where to sign in (terminal or AccountSwitch, ADR-025).
  assert.equal(routeCard(login, { signedIn: { 'codex-cli': true } }).tier, 'R');
  const card = routeCard(login);
  assert.deepEqual([card.tier, card.run, card.toAi], ['R', undefined, true]);
  assert.match(card.text, /AccountSwitch/);
  assert.equal(routeRequest('클로드 로그아웃', []).app.action, 'logout');
  const sync = routeRequest('다른 파일 sync해줘', [], [], context);
  assert.deepEqual([sync.target, sync.app.action, sync.app.tier], ['app', 'sync_link', 'T1']);
  assert.equal(routeCard(sync).run, 'Sync 받기');
  const jig = routeRequest('구조 검토하고 싶어', [], [], context);
  assert.deepEqual([jig.target, jig.jig.id], ['jig', 'structure']);
  // A jig opens at once (ADR-026 4): the route row says so, no proposal button.
  assert.deepEqual([routeCard(jig).tier, routeCard(jig).run], ['auto', undefined]);
  assert.equal(routeRequest('구조검토 해 볼까', [], [], context).target, 'jig');
  assert.equal(routeRequest('이 확인을 도구로 만들어 줘', [], [], context).target, 'make');
  assert.equal(routeRequest('CAD에서 경간 표시 지워', []).target, 'document');
  // Setting changes are applied at once (a notice with the undo); refused ones only explain.
  assert.equal(routeCard(routeRequest('경간 11로', [], [], context)).tier, 'auto');
  assert.equal(routeCard(routeRequest('경간 25로', [], [], context)).tier, 'R');
  // AI routes have no card: they go to the conversation AI.
  assert.equal(routeCard(routeRequest('보 단면 바꿔줘', [])), undefined);
});

test('the server answer maps to routes for every target; malformed answers go to the rules', async () => {
  const { jevRoute, routeAnswer, routeSubjects } = await import('../../src/ui/request-route.ts');
  const subjects = routeSubjects(objects);
  assert.deepEqual(routeAnswer({ target: 'nonsense' }), { target: null });
  assert.deepEqual(routeAnswer(null), { target: null });
  const answer = routeAnswer({ target: 'param', by: 'jev', param: 'beamSpacing', extra: 1 });
  assert.deepEqual(answer, { target: 'param', by: 'jev', param: 'beamSpacing' });
  const param = jevRoute(answer, subjects, undefined, context, '작은보 조금 더 촘촘히');
  assert.equal(param.param.change.value, 2.25);
  assert.equal(param.reason, 'Jev · 설정값 변경');
  // A setting that is not open: the rules decide.
  assert.equal(
    jevRoute({ target: 'param', param: 'gone' }, subjects, undefined, context),
    undefined,
  );
  const app = jevRoute(
    routeAnswer({ target: 'app', app: 'switch_account', provider: 'claude-cli' }),
    subjects,
  );
  assert.deepEqual(app.app, { action: 'switch_account', tier: 'T2', provider: 'claude-cli' });
  const jig = jevRoute(
    routeAnswer({ target: 'jig', by: 'rules', jig: 'structure', jigName: '구조 분석' }),
    subjects,
  );
  assert.deepEqual([jig.jig.name, jig.reason], ['구조 분석', 'jig 열기']);
  assert.equal(jevRoute({ target: 'ask' }, subjects).target, 'ask');
  assert.equal(jevRoute({ target: 'make' }, subjects).target, 'make');
});

test('the open jig instance settings become routing context; the query carries title and help only', async () => {
  const { instanceRouteContext, routeQuery, routeRevert, goesToAi, officialRouteJigs } =
    await import('../../src/ui/request-route.ts');
  // The engine's ParamView rows (ARCH-03 §4) of the open instance.
  const { params, values } = instanceRouteContext([
    {
      key: 'spanMax',
      title: '경간 상한',
      help: '거더 경간의 상한',
      group: '배치',
      type: 'length',
      unit: 'm',
      displayUnit: 'm',
      decimals: 1,
      value: 12,
      displayValue: 12,
      by: 'default',
      range: { min: 3, max: 30, step: 0.5 },
    },
    {
      key: 'grade',
      title: '강종',
      type: 'choice',
      unit: '',
      displayUnit: '',
      value: 'SM355',
      choices: [
        { value: 'SM355', label: 'SM355' },
        { value: 'SS275', label: 'SS275' },
      ],
      fixedAtPin: true,
    },
    { title: 'no key' },
    null,
  ]);
  assert.deepEqual(
    params.map((p) => p.key),
    ['spanMax', 'grade'],
  );
  assert.deepEqual(values, { spanMax: 12, grade: 'SM355' });
  assert.deepEqual(params[0].display, { unit: 'm', decimals: 1 });
  assert.equal(params[1].fixedAtPin, true);
  const context = { params, values, jigs: officialRouteJigs() };
  const route = routeRequest('경간 11로', [], [], context);
  assert.equal(route.target, 'param');
  assert.deepEqual(route.param.change, { ok: true, value: 11, text: '경간 상한 12 m → 11 m' });
  // A fixed setting is not changed from words: the notice says why (sent to the AI only on request).
  const fixed = routeRequest('강종 SS275로', [], [], context);
  if (fixed.target === 'param') assert.equal(fixed.param.change.ok, false);
  // The official jigs' rule words open them.
  const jig = routeRequest('구조 검토 해줘', [], [], context);
  assert.deepEqual([jig.target, jig.jig.id, jig.jig.name], ['jig', 'structure', '구조 검토']);
  assert.equal(goesToAi(jig), false);
  // The /route query: settings by key, title and help; no values, units or ranges leave the screen.
  const query = routeQuery(
    '경간 11로',
    [{ id: 'kind:선', label: 'lines', ids: ['a'], subject: '선' }],
    context,
  );
  assert.deepEqual(query, {
    body: '경간 11로',
    subjects: [{ id: 'kind:선', label: 'lines' }],
    params: [
      { key: 'spanMax', title: '경간 상한', help: '거더 경간의 상한' },
      { key: 'grade', title: '강종' },
    ],
  });
  assert.deepEqual(routeQuery('숨겨', []), { body: '숨겨', subjects: [] });
  // 'AI 작업으로 보내기' records the route and who chose it, never the words.
  assert.deepEqual(routeRevert(route), { target: 'param', by: 'rules' });
  assert.equal(goesToAi({ target: 'document', reason: '' }), true);
  assert.equal(goesToAi({ target: 'ask', reason: '' }), true);
});
