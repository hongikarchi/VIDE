// A conversation turn with the legal tools (SPEC-13.2·13.3·13.5·13.9, PLAN-46 T-223), with a fake
// agent that calls its tools in-process as the CLI does over MCP and the fake cLAWde server: the
// tools are in the turn only while the service is connected and the project on; legal_ask shows
// the '보낼 정보' card on the running request and waits for [보내기]; the reply's [L<n>] and articles
// pass the citation gate; a legal reply without the tools is 'AI 추정'. Jev's legal route lands in
// the project's legal conversation (`legal` key), opened when there is none.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution, LEGAL_SEND_CARD } from '../../src/server/execution.ts';
import { AgentTools } from '../../src/server/agent-tools.ts';
import { ConversationService, LEGAL_KEY } from '../../src/server/conversations.ts';
import { SecretStore } from '../../src/services/secrets.ts';
import { ServiceSettings } from '../../src/services/settings.ts';
import { ClawdeClient } from '../../src/services/clawde.ts';
import { LegalService } from '../../src/services/legal.ts';
import { jevRoute, routeAnswer } from '../../src/ui/request-route.ts';
import { routePayload } from '../../src/ai/request-router.ts';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';

let fake;
before(async () => {
  fake = await startFakeClawde();
});
after(() => fake.close());
beforeEach(() => fake.reset());

async function setup(t, script) {
  const store = new Store(':memory:');
  const workspace = new Workspace(store);
  const project = store.createProject('법규 대화');
  const conversations = new ConversationService(store, { removeTranscript: async () => 0 });
  const settings = new ServiceSettings({
    directory: undefined,
    secrets: new SecretStore(undefined),
  });
  await settings.update({ clawde: { baseUrl: fake.url, token: fake.token } });
  const client = new ClawdeClient({ settings, version: 'test', timeoutMs: 2000 });
  await client.meta();
  const legal = new LegalService({ store, client, settings });
  legal.updateProfile(project.id, { values: { 'site.zoning': { value: '제2종일반주거지역' } } });
  const tools = new AgentTools({ origin: 'http://127.0.0.1:9' });
  const seen = [];
  const providerFactory = ({ agent }) => ({
    async run() {
      seen.push(agent?.tools ?? []);
      const call = async (name, args = {}) => {
        const result = await tools.call(agent.token, name, args);
        return JSON.parse(result.content.at(-1).text);
      };
      return { text: await script(call, agent) };
    },
    async status() {
      return { available: true };
    },
  });
  const execution = new Execution(workspace, { tools, providerFactory, conversations, legal });
  t.after(async () => {
    await execution.close();
    tools.close();
    store.close();
  });
  const conversation = conversations.create(project.id, {
    kind: 'legal',
    title: '법규',
    provider: 'claude-cli',
  });
  const send = (id, body) => {
    const input = {
      id,
      body,
      provider: 'claude-cli',
      permission: 'review',
      hostUse: 'none',
      conversationId: conversation.id,
      pins: [],
      sketches: [],
      files: [],
    };
    conversations.fix(project.id, input);
    execution.start(workspace.submit(project.id, input).request);
  };
  const settled = async () => {
    while (execution.active.size)
      await Promise.all([...execution.active.values()].map((entry) => entry.completion));
  };
  const until = async (check) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(check(), 'waited too long');
  };
  return {
    store,
    workspace,
    project,
    conversations,
    settings,
    execution,
    seen,
    send,
    settled,
    until,
  };
}

test('legal_ask waits on the 보낼 정보 card; the answer passes the gate and lists its cards', async (t) => {
  const ctx = await setup(t, async (call) => {
    const answer = await call('legal_ask', { question: '일조 사선 봐야 해?' });
    assert.equal(answer.ref, 'L1');
    return `일조 사선 제한을 받습니다 [L1]. 건축법 제61조가 근거입니다. 참고로 [L9]와 건축법 제99조도.`;
  });
  ctx.send('r1', '일조 사선 봐야 해?');
  await ctx.until(() => ctx.workspace.get(ctx.project.id, 'r1').result?.phase === 'question');
  const card = ctx.workspace.get(ctx.project.id, 'r1').result.questions[0];
  assert.equal(card.id, LEGAL_SEND_CARD);
  assert.match(card.title, /용도지역|site\.zoning/);
  assert.equal(fake.received.filter((r) => r.path === '/v1/ask').length, 0, 'nothing before');
  ctx.execution.answerQuestions(ctx.project.id, 'r1', [{ id: LEGAL_SEND_CARD, option: 'send' }]);
  await ctx.settled();
  const done = ctx.workspace.get(ctx.project.id, 'r1');
  assert.equal(done.state, 'succeeded');
  assert.ok(ctx.seen[0].includes('legal_ask'), 'the turn had the legal tools');
  assert.deepEqual(done.result.legalCheck, {
    cited: ['L1', 'L9'],
    unknown: ['L9', '건축법 제99조'],
    estimate: false,
    answers: [1],
  });
  assert.match(done.result.text, /⚠ 확인되지 않은 인용: L9, 건축법 제99조/);
});

test('a closed card sends nothing: the tool says SEND_NOT_CONFIRMED', async (t) => {
  let code;
  const ctx = await setup(t, async (call) => {
    code = (await call('legal_ask', { question: '주차 대수?' })).code;
    return '서비스 근거 없이 답할 수 없습니다.';
  });
  ctx.send('r1', '주차 대수?');
  await ctx.until(() => ctx.workspace.get(ctx.project.id, 'r1').result?.phase === 'question');
  ctx.execution.answerQuestions(ctx.project.id, 'r1', [{ id: LEGAL_SEND_CARD, option: 'cancel' }]);
  await ctx.settled();
  assert.equal(code, 'SEND_NOT_CONFIRMED');
  assert.equal(fake.received.filter((r) => r.path === '/v1/ask').length, 0);
});

test('without the service the turn has no legal tools and a legal reply is AI 추정', async (t) => {
  const ctx = await setup(t, async () => '건축법 제61조에 따라 정북 사선을 받습니다.');
  await ctx.settings.update({ clawde: { projectsOff: [ctx.project.id] } });
  ctx.send('r1', '일조?');
  await ctx.settled();
  assert.ok(!(ctx.seen[0] ?? []).some((name) => name.startsWith('legal_')));
  const done = ctx.workspace.get(ctx.project.id, 'r1');
  assert.equal(done.result.legalCheck.estimate, true);
  assert.match(done.result.text, /AI 추정 · 서비스 근거 없음/);
});

test("Jev's legal route goes to the project's legal conversation, opened when there is none", async (t) => {
  const ctx = await setup(t, async () => 'ok');
  // Jev may answer 'legal'; the screen turns it into a legal route.
  const payload = routePayload({ body: '용적률 한도가 얼마야?', subjects: [] });
  assert.ok('legal' in payload.questions.target.criteria);
  assert.equal(jevRoute(routeAnswer({ target: 'legal', by: 'jev' }), []).target, 'legal');

  const deps = { route: async () => ({ provider: 'claude-cli', effort: 'default' }) };
  const existing = ctx.conversations.list(ctx.project.id).find((entry) => entry.kind === 'legal');
  const input = { conversationId: LEGAL_KEY, body: '용적률?', provider: 'claude-cli' };
  const placed = await ctx.conversations.place(ctx.project.id, input, deps);
  assert.equal(placed.conversation.kind, 'legal');
  assert.equal(input.conversationId, existing.id, 'the open legal conversation');

  // A project with no legal conversation: one opens, and the next legal question joins it.
  const fresh = new Store(':memory:');
  t.after(() => fresh.close());
  const other = fresh.createProject('새 프로젝트');
  const service = new ConversationService(fresh, { removeTranscript: async () => 0 });
  const second = { conversationId: LEGAL_KEY, body: '건폐율?', provider: 'claude-cli' };
  const opened = await service.place(other.id, second, deps);
  assert.equal(opened.conversation.kind, 'legal');
  assert.equal(opened.conversation.title, '법규');
  const again = { conversationId: LEGAL_KEY, body: '일조?', provider: 'claude-cli' };
  assert.equal(
    (await service.place(other.id, again, deps)).conversation.id,
    opened.conversation.id,
  );
});
