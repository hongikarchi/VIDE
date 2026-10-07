// The conversation's legal tools (SPEC-13.9, PLAN-46 T-223) against the fake cLAWde server, through
// the agent tool registry as the CLI calls them: tool results and error codes, the '보낼 정보' card
// before anything is sent, the tools only while the service is connected and the project is on,
// the verified prose with the deterministic answer, and the turn record the citation gate reads.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { SecretStore } from '../../src/services/secrets.ts';
import { ServiceSettings } from '../../src/services/settings.ts';
import { ClawdeClient } from '../../src/services/clawde.ts';
import { LegalService } from '../../src/services/legal.ts';
import {
  AgentTools,
  LEGAL_TOOLS,
  PLAN_MODE_TOOLS,
  conversationHandlers,
} from '../../src/server/agent-tools.ts';
import { legalTurn } from '../../src/server/legal-tools.ts';
import { agentToolNames, instructionFor } from '../../src/ai/agent-connection.ts';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';

let fake;
before(async () => {
  fake = await startFakeClawde();
});
after(() => fake.close());
beforeEach(() => fake.reset());

const sent = (path) => fake.received.filter((r) => r.path.startsWith(path));

async function setup(t, { connect = true, writer } = {}) {
  const store = new Store(':memory:');
  const workspace = new Workspace(store);
  const project = store.createProject('합성 법규 도구');
  const settings = new ServiceSettings({
    directory: undefined,
    secrets: new SecretStore(undefined),
  });
  if (connect) await settings.update({ clawde: { baseUrl: fake.url, token: fake.token } });
  const client = new ClawdeClient({ settings, version: 'test', timeoutMs: 2000 });
  if (connect) await client.meta();
  const legal = new LegalService({ store, client, settings, writer });
  legal.updateProfile(project.id, { values: { 'site.zoning': { value: '제2종일반주거지역' } } });
  const tools = new AgentTools({ origin: 'http://127.0.0.1:9' });
  t.after(() => {
    tools.close();
    store.close();
  });
  const cards = [];
  let answer = true;
  const turn = legalTurn();
  const source = {
    service: legal,
    turn,
    confirm: async (items) => {
      cards.push(items);
      return answer;
    },
  };
  const sources = (withLegal = true) => ({
    projectId: project.id,
    conversationId: 'c1',
    openInstanceId: null,
    workspace,
    ...(withLegal ? { legal: source } : {}),
  });
  const scope = tools.issueConversation(sources());
  const call = async (name, args = {}) => {
    const result = await tools.call(scope.connection.token, name, args);
    return { error: result.isError === true, value: JSON.parse(result.content.at(-1).text) };
  };
  return {
    store,
    project,
    legal,
    settings,
    tools,
    scope,
    call,
    cards,
    turn,
    sources,
    decline: () => (answer = false),
  };
}

test('one registry: the four legal tools are VIDE MCP tools, reads in Plan mode too', () => {
  for (const name of LEGAL_TOOLS) {
    assert.ok(agentToolNames.includes(name), name);
    assert.ok(PLAN_MODE_TOOLS.has(name), name);
  }
});

test('the tools are in the turn only with the legal source; their rule joins the instruction', async (t) => {
  const ctx = await setup(t);
  assert.deepEqual(
    LEGAL_TOOLS.filter((name) => ctx.scope.connection.tools.includes(name)),
    [...LEGAL_TOOLS],
  );
  assert.match(instructionFor(ctx.scope.connection), /legal_ask .*AI 해석/);
  const without = Object.keys(conversationHandlers(ctx.sources(false)));
  assert.ok(!without.some((name) => name.startsWith('legal_')));
  // The engine gives the source only while connected and on (execution.ts asks toolsOn).
  assert.equal(await ctx.legal.toolsOn(ctx.project.id), true);
  await ctx.settings.update({ clawde: { projectsOff: [ctx.project.id] } });
  assert.equal(await ctx.legal.toolsOn(ctx.project.id), false);
  const off = await setup(t, { connect: false });
  assert.equal(await off.legal.toolsOn(off.project.id), false);
});

test('legal_ask: the card first, nothing sent before [보내기]; the answer card comes back as given', async (t) => {
  const ctx = await setup(t);
  const { error, value } = await ctx.call('legal_ask', { question: '일조 사선 봐야 해?' });
  assert.equal(error, false);
  assert.equal(ctx.cards.length, 1, 'the send card was shown once');
  assert.deepEqual(
    ctx.cards[0].map((item) => [item.key, item.selectable]),
    [['site.zoning', true]],
  );
  assert.equal(sent('/v1/ask').length, 1);
  assert.deepEqual(Object.keys(sent('/v1/ask')[0].body.profile), ['site.zoning']);
  assert.equal(value.ref, 'L1');
  assert.equal(value.verdict, 'applies');
  assert.equal(value.verdictLabel, '적용');
  assert.equal(value.conclusion, '[시험 문구] 정북 일조 사선 제한을 받습니다.');
  assert.equal(value.prose, null, 'no writer: no prose');
  assert.equal(value.proseStatus, 'none');
  assert.equal(value.citations.length, 2);
  assert.match(value.rule, /AI 해석/);
  assert.deepEqual([...ctx.turn.answers.entries()], [[1, 'applies']]);
  assert.ok(ctx.turn.articles.has('law:건축법/제61조/①'));

  // Same question: the cached answer, no card, no call.
  const again = await ctx.call('legal_ask', { question: '일조 사선 봐야 해' });
  assert.equal(again.value.ref, 'L1');
  assert.equal(again.value.cached, true);
  assert.equal(ctx.cards.length, 1);
  assert.equal(sent('/v1/ask').length, 1);
});

test('legal_ask: a declined card is SEND_NOT_CONFIRMED and nothing goes', async (t) => {
  const ctx = await setup(t);
  ctx.decline();
  const { error, value } = await ctx.call('legal_ask', { question: '주차 대수는?' });
  assert.equal(error, true);
  assert.equal(value.code, 'SEND_NOT_CONFIRMED');
  assert.match(value.next, /nothing was sent/);
  assert.equal(sent('/v1/ask').length, 0);
  assert.equal(ctx.turn.used, false);
});

test('legal_ask: a turn without a card refuses; the service down is SERVICE_UNAVAILABLE, cached answers offline', async (t) => {
  const ctx = await setup(t);
  const scope = ctx.tools.issueConversation({
    ...ctx.sources(false),
    legal: { service: ctx.legal, turn: legalTurn() },
  });
  const raw = await ctx.tools.call(scope.connection.token, 'legal_ask', { question: '일조?' });
  assert.equal(JSON.parse(raw.content.at(-1).text).code, 'SEND_NOT_CONFIRMED');

  await ctx.call('legal_ask', { question: '일조 사선 봐야 해?' });
  fake.control({ failStatus: 503 });
  const down = await ctx.call('legal_ask', { question: '대지 안의 공지?' });
  assert.equal(down.value.code, 'SERVICE_UNAVAILABLE');
  const cached = await ctx.call('legal_ask', { question: '일조 사선 봐야 해?' });
  assert.equal(cached.value.cached, true);
  assert.equal(cached.value.offline, true);
  fake.control({ failStatus: 401 });
  assert.equal((await ctx.call('legal_ask', { question: '조경?' })).value.code, 'SERVICE_AUTH');
});

test('legal_ask returns the verified prose (T-236) next to the deterministic fields', async (t) => {
  const prose = {
    verdict: 'applies',
    conclusion: '검증된 결론 문장',
    reasons: [{ text: '이유', refs: [] }],
    interpretation: [],
  };
  const writer = {
    write: async () => ({
      status: 'verified',
      output: prose,
      recipe: { id: 'answer-prose', version: '1.1.0' },
      writer: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      failures: [],
      server: { pass: true, recipeCurrent: true },
      at: new Date().toISOString(),
    }),
  };
  const ctx = await setup(t, { writer });
  const { value } = await ctx.call('legal_ask', { question: '건폐율 한도는?' });
  assert.equal(value.proseStatus, 'verified');
  assert.equal(value.prose.label, 'AI 문장(검증됨)');
  assert.equal(value.prose.conclusion, '검증된 결론 문장');
  assert.equal(value.prose.recipe, 'answer-prose@1.1.0');
  assert.notEqual(value.conclusion, value.prose.conclusion, 'the service sentence stays too');
});

test('legal_checklist, legal_article and legal_answers read this project only', async (t) => {
  const ctx = await setup(t);
  const list = await ctx.call('legal_checklist', { stage: 'scale-review' });
  assert.equal(list.error, false);
  assert.equal(ctx.cards.length, 1, 'the checklist carries the profile: the card first');
  assert.equal(list.value.stage, 'scale-review');
  assert.ok(list.value.items.every((item) => typeof item.statusLabel === 'string'));
  assert.equal(typeof list.value.otherStages, 'number');

  const article = await ctx.call('legal_article', { ref: 'law:건축법/제58조' });
  assert.equal(article.value.lawName, '건축법');
  assert.equal(article.value.article, '제58조');
  assert.ok(ctx.turn.articles.has('law:건축법/제58조'));
  const calls = sent('/v1/articles').length;
  await ctx.call('legal_article', { ref: 'law:건축법/제58조' });
  assert.equal(sent('/v1/articles').length, calls, 'kept for the project');
  assert.equal(
    (await ctx.call('legal_article', { ref: 'law:건축법/제999조' })).value.code,
    'NOT_FOUND',
  );

  await ctx.call('legal_ask', { question: '일조 사선 봐야 해?' });
  const answers = await ctx.call('legal_answers');
  assert.deepEqual(
    answers.value.answers.map((a) => [a.ref, a.verdict]),
    [['L1', 'applies']],
  );
  const one = await ctx.call('legal_answers', { number: 1 });
  assert.equal(one.value.ref, 'L1');
  assert.equal((await ctx.call('legal_answers', { number: 7 })).value.code, 'NOT_FOUND');
});
