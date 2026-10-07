import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clawdeAnswerSchema,
  clawdeArticleSchema,
  clawdeChecklistSchema,
  clawdeContributionReceiptSchema,
  clawdeErrorSchema,
  clawdeGoldenSchema,
  clawdeMetaSchema,
  clawdeRecipeSchema,
  clawdeSearchSchema,
  clawdeVerifyResultSchema,
  CLAWDE_STAGES,
} from '../../src/contracts/clawde.ts';
import { ARTICLES, CASES, buildAnswer, startFakeClawde } from '../fixtures/fake-clawde/server.mjs';

// PLAN-46 T-216: the fake cLAWde server answers in the ARCH-01 contract, its scripted cases cover
// every verdict and the cases the engine must catch, and the contract schemas reject violations.

let fake;
before(async () => {
  fake = await startFakeClawde();
});
after(() => fake.close());
beforeEach(() => fake.reset());

const profile = {
  'site.zoning': { value: '제2종일반주거지역', source: 'user' },
  'site.area': { value: 420, unit: '㎡', source: 'model', version: 'site-3' },
};

async function call(path, { method = 'GET', body, token = fake.token, signal } = {}) {
  const headers = { 'x-vide-version': 'test' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(fake.url + path, {
    method,
    headers,
    body: body && JSON.stringify(body),
    signal,
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, json: type.includes('json') ? await res.json() : await res.text() };
}
const ask = (question, extra = {}) =>
  call('/v1/ask', {
    method: 'POST',
    body: { question, stage: 'scale-review', profile, locale: 'ko', ...extra },
  });

/** What the engine check (T-218) must find in an answer; the schema itself lets these through. */
function engineFindings(answer) {
  const cited = new Set(answer.citations.map((c) => c.ref));
  const refs = [...answer.reasons, ...(answer.constraints ?? [])].flatMap((r) => r.refs);
  return {
    downgrade: answer.verdict !== 'unknown' && answer.citations.length === 0,
    unverifiedRefs: [...new Set(refs.filter((ref) => !cited.has(ref)))],
    noExcerpt: answer.citations.filter((c) => !c.excerpt || !c.sourceUrl).map((c) => c.ref),
  };
}

test('every fixture case passes or fails the answer schema as declared, with its engine findings', () => {
  const verdicts = new Set();
  for (const caseDef of CASES) {
    const answer = buildAnswer(caseDef, { base: 'http://127.0.0.1:1' });
    const parsed = clawdeAnswerSchema.safeParse(answer);
    if (caseDef.expect === 'invalid') {
      assert.equal(parsed.success, false, caseDef.name);
      assert.ok(
        parsed.error.issues.some((issue) => issue.path[0] === caseDef.invalidPath),
        `${caseDef.name}: fails on ${caseDef.invalidPath}`,
      );
      continue;
    }
    assert.equal(parsed.success, true, `${caseDef.name}: ${parsed.error?.message}`);
    verdicts.add(answer.verdict);
    const found = engineFindings(answer);
    assert.equal(found.downgrade, Boolean(caseDef.engine.downgrade), `${caseDef.name} downgrade`);
    assert.deepEqual(found.unverifiedRefs, caseDef.engine.unverifiedRefs ?? [], caseDef.name);
    assert.deepEqual(found.noExcerpt, caseDef.engine.noExcerpt ?? [], caseDef.name);
  }
  assert.deepEqual([...verdicts].sort(), ['applies', 'conditional', 'not-applies', 'unknown']);
  for (const article of ARTICLES) {
    assert.ok(clawdeArticleSchema.safeParse(article).success, article.ref);
    assert.match(article.excerpt, /^\[시험 문구\]/, 'fixture text stays marked');
  }
});

test('the schemas ignore unknown fields and reject a missing required field', () => {
  const answer = buildAnswer(
    CASES.find((c) => c.name === 'applies-sunlight'),
    { base: fake.url },
  );
  const extended = clawdeAnswerSchema.parse({ ...answer, futureField: 1 });
  assert.equal('futureField' in extended, false);
  const { lawDbDate, ...noDate } = answer;
  assert.ok(lawDbDate);
  assert.equal(clawdeAnswerSchema.safeParse(noDate).success, false);
  assert.equal(clawdeAnswerSchema.safeParse({ ...answer, verdict: 'maybe' }).success, false);
  const badRef = { ...answer, reasons: [{ text: 'x', refs: ['건축법 제61조'] }] };
  assert.equal(clawdeAnswerSchema.safeParse(badRef).success, false);
});

test('meta announces the law DB date, stages, permit phases, answer models, recipes and the profile key vocabulary', async () => {
  const { status, json } = await call('/v1/meta');
  assert.equal(status, 200);
  const meta = clawdeMetaSchema.parse(json);
  assert.equal(meta.lawDbDate, '2026-09-01');
  assert.deepEqual(
    meta.stages.map((s) => s.id),
    [...CLAWDE_STAGES],
  );
  assert.ok(meta.stages.some((s) => s.id === 'scale-review' && s.label === '규모검토'));
  assert.deepEqual(
    meta.permitPhases.map((p) => p.label),
    ['심의', '허가', '착공', '사용승인'],
  );
  assert.ok(meta.answerModels.some((m) => m.provider === 'codex' && m.models.length));
  assert.deepEqual(meta.recipes, [{ id: 'answer-prose', version: '1.1.0' }]);
  assert.ok(meta.profileKeys.some((k) => k.key === 'plan.mainUse'));
  assert.equal(fake.received[0].videVersion, 'test');
  // An older service without the later fields still parses (they default to empty).
  const { permitPhases, answerModels, recipes, ...older } = json;
  assert.ok(permitPhases && answerModels && recipes);
  const parsedOlder = clawdeMetaSchema.parse(older);
  assert.deepEqual([parsedOlder.permitPhases, parsedOlder.recipes], [[], []]);
  // Stage ids are the four fixed values.
  assert.equal(
    clawdeMetaSchema.safeParse({ ...json, stages: [{ id: 'feasibility', label: 'x' }] }).success,
    false,
  );
});

test('ask answers each verdict in contract form, with constraints and a figure', async () => {
  const expected = {
    '일조 사선 제한을 받나요?': 'applies',
    '대지 안의 공지를 띄워야 하나요?': 'not-applies',
    '조례로 정한 높이 제한은?': 'unknown',
    '무엇이든 모르는 질문': 'unknown',
  };
  for (const [question, verdict] of Object.entries(expected)) {
    const { status, json } = await ask(question);
    assert.equal(status, 200, question);
    assert.equal(clawdeAnswerSchema.parse(json).verdict, verdict, question);
  }
  const sunlight = clawdeAnswerSchema.parse((await ask('일조 사선 제한을 받나요?')).json);
  assert.ok(sunlight.constraints.every((c) => c.refs.length));
  const [figure] = sunlight.figures;
  assert.equal(figure.mime, 'image/svg+xml');
  assert.ok(figure.url.startsWith(fake.url));
  const svg = await call(new URL(figure.url).pathname);
  assert.equal(svg.status, 200);
  assert.match(svg.json, /^<svg /);
  assert.deepEqual(fake.received[0].body.profile, profile, 'the server sees what was sent');
});

test('a needed profile value comes back as a question, then the answer is conditional', async () => {
  const first = clawdeAnswerSchema.parse((await ask('부설주차장은 몇 대인가요?')).json);
  assert.equal(first.verdict, 'conditional');
  assert.deepEqual(
    first.needs.map((n) => n.key),
    ['plan.mainUse'],
  );
  assert.equal(first.needs[0].recommended, '업무시설');
  const withUse = {
    ...profile,
    'plan.mainUse': { value: first.needs[0].recommended, source: 'assumed' },
  };
  const second = clawdeAnswerSchema.parse(
    (await ask('부설주차장은 몇 대인가요?', { profile: withUse })).json,
  );
  assert.equal(second.verdict, 'conditional');
  assert.deepEqual(second.needs, []);
  assert.deepEqual(second.checks[0].dependsOn, ['plan.gfa']);
  assert.ok(second.usedProfile.includes('plan.mainUse'));
});

test('engine cases arrive valid: no citations, refs outside citations, an article with no excerpt', async () => {
  const bare = clawdeAnswerSchema.parse((await ask('근거 없음 시험')).json);
  assert.deepEqual(engineFindings(bare), { downgrade: true, unverifiedRefs: [], noExcerpt: [] });
  const loose = clawdeAnswerSchema.parse((await ask('조경 면적은?')).json);
  assert.deepEqual(engineFindings(loose), {
    downgrade: false,
    unverifiedRefs: ['law:건축법/제99조/①'],
    noExcerpt: ['law:건축법/제42조/①'],
  });
});

test('a contract violation is served as is and fails the schema', async () => {
  const { status, json } = await ask('계약 위반 시험');
  assert.equal(status, 200);
  assert.equal(clawdeAnswerSchema.safeParse(json).success, false);
});

test('a bad request body is 400 in the error shape', async () => {
  const { status, json } = await call('/v1/ask', { method: 'POST', body: { question: '일조' } });
  assert.equal(status, 400);
  assert.equal(clawdeErrorSchema.parse(json).error.code, 'BAD_REQUEST');
});

test('checklist returns every stage with permit phases; BF 인증 is in 기본설계, not 규모검토', async () => {
  const { status, json } = await call('/v1/checklist', {
    method: 'POST',
    body: { stage: 'scale-review', profile },
  });
  assert.equal(status, 200);
  const list = clawdeChecklistSchema.parse(json);
  const bf = list.items.find((item) => item.topic === 'BF 인증');
  assert.equal(bf.stage, 'design-development');
  assert.deepEqual(bf.permitPhases, ['permit', 'occupancy']);
  assert.ok(list.items.some((item) => item.stage === 'scale-review'));
  assert.ok(
    list.items.some((item) => !item.permitPhases),
    'permit phases are optional',
  );
  const unknownStage = await call('/v1/checklist', {
    method: 'POST',
    body: { stage: 'nope', profile },
  });
  assert.equal(unknownStage.status, 400);
});

test('articles by ref and search return contract shapes; an unknown ref is 404', async () => {
  const ref = 'law:건축법/제61조/①';
  const { status, json } = await call(`/v1/articles/${encodeURIComponent(ref)}`);
  assert.equal(status, 200);
  assert.equal(clawdeArticleSchema.parse(json).ref, ref);
  const missing = await call(`/v1/articles/${encodeURIComponent('law:건축법/제999조')}`);
  assert.equal(missing.status, 404);
  assert.equal(clawdeErrorSchema.parse(missing.json).error.code, 'NOT_FOUND');
  const search = clawdeSearchSchema.parse(
    (await call(`/v1/search?q=${encodeURIComponent('일조')}&limit=1`)).json,
  );
  assert.equal(search.hits.length, 1);
  assert.match(search.hits[0].title, /일조/);
});

test('a missing or wrong token is 401 on every endpoint', async () => {
  for (const token of [null, 'wrong']) {
    for (const path of ['/v1/meta', '/v1/search?q=x', '/v1/articles/x']) {
      const { status, json } = await call(path, { token });
      assert.equal(status, 401, `${path} ${token}`);
      assert.equal(clawdeErrorSchema.parse(json).error.code, 'UNAUTHORIZED');
    }
    assert.equal((await call('/v1/ask', { method: 'POST', body: {}, token })).status, 401);
  }
});

test('scripted failures: expired token 401, 503 and 500, then recovery', async () => {
  for (const failStatus of [401, 503, 500]) {
    fake.control({ failStatus });
    const { status, json } = await ask('일조');
    assert.equal(status, failStatus);
    clawdeErrorSchema.parse(json);
  }
  fake.control({ failStatus: null });
  assert.equal((await ask('일조')).status, 200);
});

test('a slow answer runs past the client time limit', async () => {
  fake.control({ delayMs: 2000 });
  const started = Date.now();
  await assert.rejects(
    call('/v1/meta', { signal: AbortSignal.timeout(50) }),
    (error) => error.name === 'TimeoutError',
  );
  assert.ok(Date.now() - started < 1500);
});

test('a newer law DB date shows in meta while an earlier answer keeps its own date', async () => {
  const old = clawdeAnswerSchema.parse((await ask('일조')).json);
  fake.control({ lawDbDate: '2026-10-01' });
  const meta = clawdeMetaSchema.parse((await call('/v1/meta')).json);
  assert.equal(old.lawDbDate, '2026-09-01');
  assert.ok(meta.lawDbDate > old.lawDbDate, 'the earlier answer is now stale');
  assert.equal(clawdeAnswerSchema.parse((await ask('일조')).json).lawDbDate, '2026-10-01');
});

test('contributions: idempotent by key, partial rejection with reasons', async () => {
  fake.control({ rejectKeys: ['plan.gfa'] });
  const confirmedAt = '2026-10-07T09:00:00+09:00';
  const body = {
    projectRef: 'project-fixture',
    idempotencyKey: 'key-1',
    items: [
      { key: 'plan.mainUse', value: '업무시설', basis: 'user', confirmedAt },
      { key: 'plan.gfa', value: 1200, unit: '㎡', basis: 'user', confirmedAt },
      { key: 'plan.height', value: 20, unit: 'm', basis: 'assumed', confirmedAt },
      { key: 'owner.name', value: 'x', basis: 'user', confirmedAt },
    ],
  };
  const first = await call('/v1/contributions', { method: 'POST', body });
  assert.equal(first.status, 200);
  const receipt = clawdeContributionReceiptSchema.parse(first.json);
  assert.deepEqual(receipt.accepted, ['plan.mainUse']);
  assert.deepEqual(
    receipt.rejected.map((r) => r.key),
    ['plan.gfa', 'plan.height', 'owner.name'],
  );
  assert.ok(receipt.rejected.every((r) => r.reason));
  const again = await call('/v1/contributions', { method: 'POST', body });
  assert.deepEqual(again.json, receipt, 'the same key returns the first receipt');
  assert.equal(fake.stored.length, 1, 'accepted once');
  const other = await call('/v1/contributions', {
    method: 'POST',
    body: { ...body, idempotencyKey: 'key-2' },
  });
  assert.notEqual(other.json.receiptId, receipt.receiptId);
  const empty = await call('/v1/contributions', {
    method: 'POST',
    body: { ...body, idempotencyKey: 'key-3', items: [] },
  });
  assert.equal(empty.status, 400);
});

test('the control endpoint scripts an out-of-process server and needs the token', async () => {
  const denied = await call('/__control', {
    method: 'POST',
    body: { failStatus: 503 },
    token: 'x',
  });
  assert.equal(denied.status, 401);
  const { status } = await call('/__control', { method: 'POST', body: { failStatus: 503 } });
  assert.equal(status, 200);
  assert.equal((await call('/v1/meta')).status, 503);
});

test('an answer with evidence, computed values and a recipe; old answers parse without them', async () => {
  const answer = clawdeAnswerSchema.parse((await ask('건폐율은 얼마까지인가요?')).json);
  assert.equal(answer.recipe.id, 'answer-prose');
  assert.deepEqual(
    answer.recipe.allowedRefs,
    answer.evidence.map((e) => e.ref),
  );
  assert.deepEqual(answer.computed[0], {
    key: 'coverage.maxArea',
    value: 252,
    unit: '㎡',
    refs: ['law:국토계획법 시행령/제84조/①/4'],
  });
  for (const number of answer.recipe.numbers)
    assert.ok(
      number.from.startsWith('computed:') || answer.recipe.allowedRefs.includes(number.from),
      number.from,
    );
  const old = clawdeAnswerSchema.parse((await ask('일조 사선 제한을 받나요?')).json);
  assert.equal(old.recipe, undefined);
  assert.equal(old.evidence, undefined);
  assert.equal(
    clawdeAnswerSchema.safeParse({ ...answer, recipe: { ...answer.recipe, models: [] } }).success,
    false,
    'a recipe names at least one writer',
  );
  assert.ok(
    clawdeAnswerSchema.safeParse({
      ...old,
      citations: [],
      reasons: [{ text: 'x', refs: ['ordin:서울특별시 건축 조례/제30조'] }],
    }).success,
    'ordinance refs',
  );
});

test('recipes by id and version; an unknown one is 404', async () => {
  const current = clawdeRecipeSchema.parse((await call('/v1/recipes/answer-prose')).json);
  assert.equal(current.version, '1.1.0');
  assert.match(current.promptTemplate, /\{\{evidence\}\}/);
  assert.deepEqual(current.rules, {
    refs: 'evidence-only',
    numbers: 'evidence-or-computed',
    verdictLock: true,
  });
  const old = clawdeRecipeSchema.parse((await call('/v1/recipes/answer-prose?version=1.0.0')).json);
  assert.equal(old.version, '1.0.0');
  assert.equal((await call('/v1/recipes/answer-prose?version=9.9.9')).status, 404);
  assert.equal((await call('/v1/recipes/nothing')).status, 404);
});

test('verify passes a faithful prose and names each failure', async () => {
  const writer = { provider: 'claude', model: 'claude-opus-5', effort: 'high' };
  const refs = ['law:건축법/제55조', 'law:국토계획법 시행령/제84조/①/4'];
  const good = {
    verdict: 'applies',
    conclusion: '건폐율은 60% 이하입니다.',
    reasons: [{ text: '제2종일반주거지역입니다.', refs: [refs[1]] }],
    interpretation: [{ text: '건축면적은 252㎡까지입니다.', refs: [refs[0]] }],
  };
  const verify = async (output, extra = {}) =>
    clawdeVerifyResultSchema.parse(
      (
        await call('/v1/verify', {
          method: 'POST',
          body: {
            answerId: 'fake-recipe-coverage',
            recipe: { id: 'answer-prose', version: '1.1.0' },
            writer,
            output,
            ...extra,
          },
        })
      ).json,
    );
  assert.deepEqual(await verify(good), { pass: true, recipeCurrent: true, failures: [] });
  const codes = async (output, extra) => (await verify(output, extra)).failures.map((f) => f.code);
  assert.deepEqual(
    await codes({ ...good, reasons: [{ text: '이유', refs: ['law:건축법/제61조/①'] }] }),
    ['REF_OUTSIDE'],
  );
  assert.deepEqual(await codes({ ...good, conclusion: '건폐율은 70% 이하입니다.' }), [
    'NUMBER_UNSUPPORTED',
  ]);
  assert.deepEqual(await codes({ ...good, verdict: 'not-applies' }), ['VERDICT_CHANGED']);
  assert.deepEqual(await codes({ verdict: 'applies' }), ['SCHEMA']);
  assert.deepEqual(await codes(good, { recipe: { id: 'answer-prose', version: '1.0.0' } }), [
    'RECIPE_STALE',
  ]);
  const stale = await verify(good, { recipe: { id: 'answer-prose', version: '1.0.0' } });
  assert.equal(stale.recipeCurrent, false);
  assert.deepEqual(
    await codes(good, { writer: { provider: 'codex', model: 'gpt-4', effort: 'low' } }),
    ['MODEL_NOT_QUALIFIED'],
  );
  const bad = await call('/v1/verify', { method: 'POST', body: { answerId: 'x' } });
  assert.equal(bad.status, 400);
});

test('the golden set has three questions with expected verdicts and required refs', async () => {
  const golden = clawdeGoldenSchema.parse((await call('/v1/golden?recipe=answer-prose')).json);
  assert.equal(golden.items.length, 3);
  assert.deepEqual(golden.recipe, { id: 'answer-prose', version: '1.1.0' });
  for (const item of golden.items) {
    assert.ok(item.requiredRefs.length, item.goldenId);
    // Each golden question is answered by the fake with the expected verdict and cites its refs.
    const answer = clawdeAnswerSchema.parse(
      (await ask(item.question, { stage: item.stage, profile: item.profile })).json,
    );
    assert.equal(answer.verdict, item.expectVerdict, item.goldenId);
    const cited = new Set(answer.citations.map((c) => c.ref));
    assert.ok(
      item.requiredRefs.every((ref) => cited.has(ref)),
      item.goldenId,
    );
  }
  assert.equal((await call('/v1/golden?recipe=nothing')).status, 404);
});
