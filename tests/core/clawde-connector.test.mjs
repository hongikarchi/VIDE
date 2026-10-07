// The engine's cLAWde connector, answer checks and cache (SPEC-13.5·13.9·13.12, PLAN-46 T-218)
// against the fake cLAWde server: answers are stored with numbers L1, L2…; the same question is a
// cache hit with no call; an '적용' without citations shows as '판단 불가'; a contract violation is not
// stored; 503 and a slow service refuse new questions and mark the cache offline; a changed
// profile value marks only the answers that used it; figures arrive as cleaned data URLs.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { SecretStore } from '../../src/services/secrets.ts';
import { ServiceSettings } from '../../src/services/settings.ts';
import { ClawdeClient } from '../../src/services/clawde.ts';
import { LegalService } from '../../src/services/legal.ts';
import { questionKey, sentHash } from '../../src/services/legal-answers.ts';
import { checkAnswer, sanitizeSvg } from '../../src/services/clawde-check.ts';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';

let fake;
before(async () => {
  fake = await startFakeClawde();
});
after(() => fake.close());
beforeEach(() => fake.reset());

const sent = (profile = {}, stage = 'scale-review') => ({
  stage,
  profile: {
    'site.zoning': { value: '제2종일반주거지역', source: 'user' },
    'site.area': { value: 420, unit: '㎡', source: 'model', version: 'site-3' },
    ...profile,
  },
});

async function setup({ timeoutMs = 2000 } = {}) {
  const store = new Store(':memory:');
  const project = store.createProject('법규 합성');
  const settings = new ServiceSettings({
    directory: undefined,
    secrets: new SecretStore(undefined),
  });
  await settings.update({ clawde: { baseUrl: fake.url, token: fake.token } });
  const client = new ClawdeClient({ settings, version: 'test', timeoutMs });
  const legal = new LegalService({ store, client, settings });
  const asks = () => fake.received.filter((r) => r.path === '/v1/ask').length;
  return { store, project, settings, client, legal, asks };
}

test('answers are stored with their numbers; the same question is a cache hit with no call', async () => {
  const { project, legal, asks } = await setup();
  const first = await legal.ask(project.id, '일조 사선 제한을 받나요?', sent());
  assert.equal(first.cached, false);
  assert.equal(first.answer.ref, 'L1');
  assert.equal(first.answer.verdict, 'applies');
  assert.equal(first.answer.answer.answerId, 'fake-applies-sunlight');
  assert.equal(asks(), 1);
  const call = fake.received.find((r) => r.path === '/v1/ask');
  assert.deepEqual(call.body.profile, sent().profile, 'sent as given');
  assert.equal(call.body.stage, 'scale-review');
  assert.equal(call.body.locale, 'ko');
  assert.equal(call.authorization, `Bearer ${fake.token}`);

  // Spacing, case and the question mark do not make a new question.
  const again = await legal.ask(project.id, '  일조 사선   제한을 받나요 ', sent());
  assert.equal(again.cached, true);
  assert.equal(again.answer.number, 1);
  assert.equal(asks(), 1, 'no call for a cache hit');

  // Another stage or other sent information is another key.
  const other = await legal.ask(project.id, '일조 사선 제한을 받나요?', sent({}, 'schematic'));
  assert.equal(other.answer.ref, 'L2');
  const changed = await legal.ask(
    project.id,
    '일조 사선 제한을 받나요?',
    sent({ 'site.area': { value: 500, unit: '㎡', source: 'user' } }),
  );
  assert.equal(changed.answer.ref, 'L3');
  // [다시 묻기]: a new answer on top; the old one stays.
  const refreshed = await legal.ask(project.id, '일조 사선 제한을 받나요?', sent(), {
    refresh: true,
  });
  assert.equal(refreshed.answer.ref, 'L4');
  assert.equal(asks(), 4);
  const { answers } = await legal.list(project.id);
  assert.deepEqual(
    answers.map((a) => a.ref),
    ['L4', 'L3', 'L2', 'L1'],
  );
  assert.equal((await legal.get(project.id, 1)).question, '일조 사선 제한을 받나요?');
  assert.equal(questionKey('일조 사선?'), questionKey('일조  사선'));
  assert.notEqual(sentHash(sent()), sentHash(sent({ x: { value: 1, source: 'user' } })));
});

test("an '적용' without citations shows as '판단 불가'; unverified refs and no-excerpt articles are marked", async () => {
  const { project, legal } = await setup();
  const bare = (await legal.ask(project.id, '근거 없음 시험', sent())).answer;
  assert.equal(bare.answer.verdict, 'applies', 'the service verdict is kept as received');
  assert.equal(bare.verdict, 'unknown');
  assert.equal(bare.downgraded, true);

  const loose = (await legal.ask(project.id, '조경 면적은?', sent())).answer;
  assert.deepEqual(loose.noExcerpt, ['law:건축법/제42조/①']);
  assert.ok(loose.unverifiedReasons.length >= 1);
  assert.ok(loose.answer.reasons[loose.unverifiedReasons[0]].refs.includes('law:건축법/제99조/①'));

  // Constraints: only the ones with every ref cited reach a jig.
  const checked = checkAnswer({
    ...loose.answer,
    constraints: [
      { key: 'ok', value: 1, unit: 'm', refs: ['law:건축법/제42조/①'] },
      { key: 'loose', value: 2, unit: 'm', refs: ['law:건축법/제99조/①'] },
      { key: 'none', value: 3, unit: 'm', refs: [] },
    ],
  });
  assert.deepEqual(
    checked.constraints.map((c) => c.key),
    ['ok'],
  );
  assert.deepEqual(checked.unverifiedConstraints, ['loose', 'none']);
  // A conditional answer is never raised to a conclusion.
  const parking = (await legal.ask(project.id, '부설주차장은 몇 대인가요?', sent())).answer;
  assert.equal(parking.verdict, 'conditional');
});

test('a contract violation is not stored: SERVICE_BAD_RESPONSE', async () => {
  const { project, legal, settings } = await setup();
  await assert.rejects(
    legal.ask(project.id, '계약 위반 시험', sent()),
    (error) => error.code === 'SERVICE_BAD_RESPONSE',
  );
  assert.deepEqual((await legal.list(project.id)).answers, []);
  assert.equal(settings.status, 'connected', 'the service answered; it is not offline');
});

test('503 and a slow service: new questions refused, cached answers shown offline, nothing queued', async () => {
  const { project, legal, asks } = await setup({ timeoutMs: 200 });
  await legal.ask(project.id, '일조 사선 제한을 받나요?', sent());
  fake.control({ failStatus: 503 });
  await assert.rejects(
    legal.ask(project.id, '대지 안의 공지를 띄워야 하나요?', sent()),
    (error) => error.code === 'SERVICE_UNAVAILABLE',
  );
  let list = await legal.list(project.id);
  assert.equal(list.offline, true);
  assert.equal(list.status, 'unreachable');
  assert.deepEqual(
    list.answers.map((a) => a.ref),
    ['L1'],
  );
  assert.ok(list.answers[0].fetchedAt, 'shown with its fetch time');
  // A cached question still answers offline, without a call.
  const before = asks();
  assert.equal((await legal.ask(project.id, '일조 사선 제한을 받나요?', sent())).cached, true);
  assert.equal(asks(), before);

  fake.control({ failStatus: null, delayMs: 1000 });
  const started = Date.now();
  await assert.rejects(
    legal.ask(project.id, '대지 안의 공지를 띄워야 하나요?', sent()),
    (error) => error.code === 'SERVICE_UNAVAILABLE',
  );
  assert.ok(Date.now() - started < 900, 'the time limit, not the slow answer');
  fake.control({ delayMs: 0 });
  // Back online: the refused question was not kept to send later.
  const sentAsks = asks();
  list = await legal.list(project.id);
  assert.equal(list.answers.length, 1);
  assert.equal(asks(), sentAsks);
  await legal.ask(project.id, '대지 안의 공지를 띄워야 하나요?', sent());
  assert.equal((await legal.list(project.id)).offline, false);
});

test('401 is 로그인 필요 and is not retried', async () => {
  const { project, legal, settings, asks } = await setup();
  fake.control({ failStatus: 401 });
  await assert.rejects(
    legal.ask(project.id, '일조', sent()),
    (error) => error.code === 'SERVICE_AUTH',
  );
  assert.equal(asks(), 1);
  assert.equal((await settings.view()).clawde.status, 'login-required');
});

test('a changed profile value marks only the answers that used it; a newer law DB date marks all', async () => {
  const { project, legal, client } = await setup();
  await legal.ask(project.id, '일조 사선 제한을 받나요?', sent()); // uses site.zoning
  await legal.ask(project.id, '건폐율은 얼마까지인가요?', sent()); // site.zoning, site.area
  await legal.ask(project.id, '조례로 정한 높이 제한은?', sent()); // uses nothing
  assert.deepEqual(legal.answers.profileChanged(project.id, ['site.area']), [2]);
  let byRef = Object.fromEntries((await legal.list(project.id)).answers.map((a) => [a.ref, a]));
  assert.deepEqual(byRef.L2.staleReasons, ['profile']);
  assert.equal(byRef.L1.stale, false);
  assert.equal(byRef.L3.stale, false);

  fake.control({ lawDbDate: '2026-10-01' });
  await client.meta();
  byRef = Object.fromEntries((await legal.list(project.id)).answers.map((a) => [a.ref, a]));
  for (const ref of ['L1', 'L2', 'L3']) assert.ok(byRef[ref].staleReasons.includes('law-db'), ref);
});

test('a project switched off or a service not connected sends nothing; the cache still shows', async () => {
  const { project, legal, settings, asks } = await setup();
  await legal.ask(project.id, '일조 사선 제한을 받나요?', sent());
  await settings.update({ clawde: { projectsOff: [project.id] } });
  await assert.rejects(
    legal.ask(project.id, '대지 안의 공지', sent()),
    (error) => error.code === 'LEGAL_PROJECT_OFF',
  );
  assert.equal((await legal.ask(project.id, '일조 사선 제한을 받나요?', sent())).cached, true);
  assert.equal((await legal.list(project.id)).projectOff, true);
  await settings.update({ clawde: { projectsOff: [] } });
  await settings.disconnect();
  await assert.rejects(
    legal.ask(project.id, '대지 안의 공지', sent()),
    (error) => error.code === 'SERVICE_NOT_CONNECTED',
  );
  assert.equal(asks(), 1);
});

test('figures come as data URLs; SVG scripts, handlers and outside links are removed', async () => {
  const { project, legal } = await setup();
  const { answer } = await legal.ask(project.id, '일조 사선 제한을 받나요?', sent());
  const [figure] = answer.answer.figures;
  assert.match(figure.url, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(figure.url.split(',')[1], 'base64').toString('utf8');
  assert.match(svg, /^<svg /);
  assert.ok(!/script|onload|example\.com/i.test(svg), svg);
  assert.match(svg, /<path /, 'the drawing stays');
  assert.equal(sanitizeSvg('<html><script>x</script></html>'), undefined);
  assert.equal(sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>'), undefined);
  assert.equal(
    sanitizeSvg('<svg><a href="javascript:alert(1)"><text>x</text></a></svg>'),
    '<svg><a><text>x</text></a></svg>',
  );
  assert.match(sanitizeSvg('<svg><use href="#a"/></svg>'), /href="#a"/);
});

test('the connector reads the other endpoints in contract form; recipes are cached by version', async () => {
  const { client } = await setup();
  const meta = await client.meta();
  assert.equal(meta.stages[0].id, 'scale-review');
  const list = await client.checklist({ stage: 'scale-review', profile: sent().profile });
  assert.ok(list.items.some((i) => i.permitPhases?.includes('permit')));
  assert.equal((await client.article('law:건축법/제61조/①')).lawName, '건축법');
  await assert.rejects(client.article('law:건축법/제999조'), (e) => e.code === 'NOT_FOUND');
  assert.ok((await client.search('일조', 1)).hits.length === 1);
  const recipe = await client.recipe('answer-prose', '1.1.0');
  const calls = fake.received.length;
  assert.equal(await client.recipe('answer-prose', '1.1.0'), recipe);
  assert.equal(fake.received.length, calls, 'cached by (id, version)');
  const verdict = await client.verify({
    answerId: 'fake-recipe-coverage',
    recipe: { id: 'answer-prose', version: '1.1.0' },
    writer: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
    output: { verdict: 'conditional', conclusion: 'x', reasons: [], interpretation: [] },
  });
  assert.deepEqual(
    verdict.failures.map((f) => f.code),
    ['VERDICT_CHANGED'],
  );
  assert.equal((await client.golden('answer-prose')).items.length, 3);
});
