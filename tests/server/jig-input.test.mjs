import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import { JigRegistry } from '../../src/jigs/runtime/loader.ts';
import { JigRuntime, rowsOfLayers } from '../../src/jigs/runtime/runtime.ts';
import {
  AgentTools,
  PLAN_MODE_TOOLS,
  conversationHandlers,
  jigInputDeps,
  personWordsOf,
} from '../../src/server/agent-tools.ts';
import { agentToolNames } from '../../src/ai/agent-connection.ts';
import {
  assignJigInput,
  CHAT_CONFIRMED_BY,
  inputRoles,
  resolveLayers,
} from '../../src/server/jig-input.ts';
import { ConversationService, conversationRoutes } from '../../src/server/conversations.ts';
import { setDiagnosticSink } from '../../src/core/breadcrumbs.ts';

// 대화로 정한 입력 역할 (SPEC-07.18 9, T-293/T-294): jig_set_input checks the role and the layers,
// sets the role the way [레이어 고르기] does (confirmed by the person in chat) and runs the steps up
// to the next human step; jig_ask_input makes a card whose answer the answer route applies at once,
// and the answer message carries the chosen words, never the option keys.
const EXT = join(import.meta.dirname, '..', '..', 'extensions', 'jigs');
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const row = (id, layer, line) => ({ id, nativeId: id, layer64: b64(layer), line });
const OUTLINE = [0, 0, 0, 30, 0, 0, 30, 20, 0, 0, 20, 0, 0, 0, 0];
const VOID = [12, 6, 0, 18, 6, 0, 18, 14, 0, 12, 14, 0, 12, 6, 0];
const model = () => ({
  scene: [
    row('o1', '구조::슬래브 외곽', OUTLINE),
    row('v1', '구조::보이드', VOID),
    row('x1', '구조::기타', [0, 0, 0, 1, 1, 0]),
  ],
  definitions: {},
  layers: [
    { fullPath: '구조::슬래브 외곽', objectCount: 1 },
    { fullPath: '구조::보이드', objectCount: 1 },
    { fullPath: '구조::기타', objectCount: 1 },
    { fullPath: '구조::빈 레이어', objectCount: 0 },
  ],
  sourceDocument: { name: 'synthetic.3dm', instance: 'rhino-1', documentId: 7, revision: 3 },
});

function rmrf(dir) {
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else chmodSync(full, 0o666);
    }
  };
  if (existsSync(dir)) {
    walk(dir);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vide-jig-input-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(root, 'workspace.sqlite'));
  const jigStore = new JigStore(store);
  const registry = new JigRegistry({ store: jigStore, dataDir, devRoots: [EXT] });
  const runtime = new JigRuntime({ store: jigStore, dataDir, registry, child: { idleMs: 60_000 } });
  const project = store.createProject('입력 역할');
  t.after(async () => {
    await runtime.close();
    store.close();
    rmrf(root);
  });
  const created = await runtime.createInstance(project.id, {
    jig: 'project/example-grid',
    title: '격자 대안 A',
    layerRoot: 'VIDE::격자',
  });
  const conversations = new ConversationService(store, { removeTranscript: async () => 0 });
  const conversation = conversations.create(project.id, {
    kind: 'jig-run',
    title: '격자',
    provider: 'claude-cli',
    jigInstanceId: created.id,
  });
  const ledger = [];
  const reads = [];
  // What the person said (SPEC-07.18 9): jig_set_input sets only layers named here.
  const words = [];
  // One stored Sync of one linked Rhino file (the conversation's stores, no host).
  const sources = {
    projectId: project.id,
    conversationId: conversation.id,
    openInstanceId: created.id,
    requestId: 'turn-1',
    workspace: {
      list: () => [{ id: 'sync-1', state: 'succeeded', input: { linkId: 'L1' } }],
      get: (pid, id) => ({ id, result: model() }),
    },
    links: {
      list: () => [{ id: 'L1', host: 'rhino', name: '구조 모델' }],
      get: () => ({ id: 'L1', host: 'rhino', name: '구조 모델' }),
    },
    jigs: runtime,
    readInput: async (document, layers) => {
      reads.push({ syncId: document.syncId, layers });
      const picked = rowsOfLayers(model(), layers);
      return {
        linkId: document.linkId,
        revisionKey: 'rhino-1|7|3',
        model: { scene: picked.rows, definitions: picked.definitions },
      };
    },
    ledger: (item) => {
      ledger.push(item);
      return conversations.addLedger(project.id, conversation.id, item);
    },
    personWords: () => words,
  };
  return {
    store,
    runtime,
    project,
    created,
    conversations,
    conversation,
    sources,
    ledger,
    reads,
    words,
  };
}

test('jig_set_input: declared roles and existing layers only; the role is confirmed in chat and the steps run to the human step', async (t) => {
  const f = await fixture(t);
  const handlers = conversationHandlers(f.sources);
  assert.equal(typeof handlers.jig_set_input, 'function');
  assert.ok(agentToolNames.includes('jig_set_input') && agentToolNames.includes('jig_ask_input'));
  // Asking changes nothing (Plan mode keeps it); setting is a write (Plan mode drops it).
  assert.ok(PLAN_MODE_TOOLS.has('jig_ask_input'));
  assert.ok(!PLAN_MODE_TOOLS.has('jig_set_input'));

  // A layer the person did not name is the AI's guess: refused, nothing read or set (SPEC-07.18 9).
  f.words.push('슬래브 외곽선 역할 정해 줘');
  const guessed = await handlers.jig_set_input({ input: 'voids', layers: ['구조::보이드'] });
  assert.equal(guessed.ok, false);
  assert.equal(guessed.error, 'NOT_NAMED');
  assert.deepEqual(guessed.layers, ['구조::보이드']);
  assert.equal(f.reads.length, 0);
  f.words.push('기존 기초는 구조::보이드', '외곽, 빈 레이어', '슬래브 외곽으로');

  // A role the jig does not declare: nothing changes, the declared roles come back.
  const unknownRole = await handlers.jig_set_input({
    input: '기존 기초',
    layers: ['구조::보이드'],
  });
  assert.equal(unknownRole.ok, false);
  assert.equal(unknownRole.error, 'UNKNOWN_INPUT');
  assert.deepEqual(
    unknownRole.inputs.map((i) => i.key),
    ['site.outline', 'site.voids'],
  );
  // A layer no linked file has: similar names; an empty layer is refused too.
  const unknownLayer = await handlers.jig_set_input({ input: 'outline', layers: ['외곽'] });
  assert.equal(unknownLayer.error, 'UNKNOWN_LAYER');
  assert.deepEqual(unknownLayer.problems[0].suggestions, ['구조::슬래브 외곽']);
  // A layer without objects is not offered (the Sync's layer table counts objects).
  const empty = await handlers.jig_set_input({ input: 'outline', layers: ['빈 레이어'] });
  assert.equal(empty.ok, false);
  assert.deepEqual((await f.runtime.view(f.project.id, f.created.id)).body.assembly, {});
  assert.equal(f.reads.length, 0);

  // The layer the person named (last name part is enough): read alone, confirmed, recalculated.
  const set = await handlers.jig_set_input({ input: 'outline', layers: ['슬래브 외곽'] });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.deepEqual(set.role, { key: 'site.outline', title: set.role.title });
  assert.deepEqual(
    set.layers.map((l) => [l.linkId, l.layer, l.objectCount]),
    [['L1', '구조::슬래브 외곽', 1]],
  );
  assert.equal(set.confirmedBy, CHAT_CONFIRMED_BY);
  assert.deepEqual(f.reads, [{ syncId: 'sync-1', layers: ['구조::슬래브 외곽'] }]);
  assert.deepEqual(set.waitingFor?.id, 'confirmInputs');
  assert.deepEqual(
    set.steps.map((s) => [s.id, s.status]),
    [
      ['grid', 'done'],
      ['confirmInputs', 'waiting'],
    ],
  );
  const view = await f.runtime.view(f.project.id, f.created.id);
  assert.equal(view.body.assembly['site.outline'].confirmed.by, 'user-chat');
  assert.equal(view.steps.find((s) => s.id === 'grid').status, 'done');
  // The screen follows the ledger item (role card, step rail).
  const recorded = f.ledger.find((item) => item.body.appAction === 'jig_input');
  assert.deepEqual(
    [recorded.body.by, recorded.body.instanceId, recorded.body.layers],
    ['ai', f.created.id, ['구조::슬래브 외곽']],
  );

  // Without an open jig the tools are not there.
  const closed = conversationHandlers({ ...f.sources, openInstanceId: null });
  assert.equal(closed.jig_set_input, undefined);
  assert.equal(closed.jig_ask_input, undefined);
});

test('jig_ask_input → answer: VIDE sets the role from the answer at once; the message shows the label, never the keys', async (t) => {
  const f = await fixture(t);
  const handlers = conversationHandlers(f.sources);
  // The outline the person wrote in chat; the voids are asked with a card.
  f.words.push('외곽선은 슬래브 외곽 레이어');
  const outline = await handlers.jig_set_input({ input: '슬래브 외곽선', layers: ['슬래브 외곽'] });
  assert.equal(outline.ok, true);
  const bad = await handlers.jig_ask_input({
    input: 'voids',
    options: [
      { layers: ['보이드'], recommended: true },
      { layers: ['없는 레이어'], recommended: false },
    ],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.option, 2);
  const asked = await handlers.jig_ask_input({
    input: 'voids',
    options: [
      { layers: ['구조::보이드'], recommended: true },
      { layers: ['기타'], label: '기타 레이어', recommended: false },
    ],
  });
  const card = asked.question;
  assert.match(card.id, /^input-voids-[0-9a-f]{4}$/);
  assert.deepEqual(
    card.options.map((o) => [o.id, o.label, o.recommended]),
    [
      ['layers-1', '구조::보이드', true],
      ['layers-2', '기타 레이어', false],
    ],
  );
  // The turn ended with this card (as conversations.ts records a finished turn's questions).
  f.conversations.addLedger(f.project.id, f.conversation.id, {
    kind: 'question',
    requestId: 'ask-1',
    body: card,
  });

  const submitted = [];
  let status, data;
  await conversationRoutes(
    new URL(`http://x/api/v1/projects/${f.project.id}/conversations/${f.conversation.id}/answer`),
    { method: 'POST' },
    {
      service: f.conversations,
      body: async () => ({
        requestId: 'ask-1',
        answers: [{ questionId: card.id, optionId: 'layers-1' }],
      }),
      send: (s, d) => ((status = s), (data = d)),
      chooseModel: async () => ({ provider: 'claude-cli' }),
      submit: async (projectId, input) => (submitted.push(input), { id: input.id, input }),
      applyInput: (projectId, conversation, request) =>
        assignJigInput(jigInputDeps(f.sources, f.runtime), projectId, request.instanceId, request),
    },
  );
  assert.equal(status, 201);
  assert.deepEqual(data.applied, [
    {
      questionId: card.id,
      ok: true,
      text: `${(await f.runtime.view(f.project.id, f.created.id)).inputs[0].roles[1].title} ← 구조::보이드`,
      instanceId: f.created.id,
    },
  ]);
  const view = await f.runtime.view(f.project.id, f.created.id);
  assert.equal(view.body.assembly['site.voids'].confirmed.by, 'user-chat');
  assert.deepEqual(view.body.assembly['site.voids'].sources[0].layers, ['구조::보이드']);
  assert.equal(view.steps.find((s) => s.id === 'confirmInputs').status, 'waiting');
  // The answer turn only reports: the message is the person's words, no `[id=option]` key.
  const [next] = submitted;
  assert.match(next.body, /→ 구조::보이드$/m);
  assert.match(next.body, /입력에 바로 넣고 다시 계산했습니다: .+ ← 구조::보이드/);
  assert.match(next.body, /요약하세요/);
  assert.doesNotMatch(next.body, /\[|layers-1|input-voids/);
});

/** POST …/answer through the route; `planTurn` says the asking turn was a Plan turn. */
async function answerRoute(f, input, { planTurn } = {}) {
  const submitted = [];
  let status, data;
  await conversationRoutes(
    new URL(`http://x/api/v1/projects/${f.project.id}/conversations/${f.conversation.id}/answer`),
    { method: 'POST' },
    {
      service: f.conversations,
      body: async () => input,
      send: (s, d) => ((status = s), (data = d)),
      chooseModel: async () => ({ provider: 'claude-cli' }),
      submit: async (projectId, request) => (
        submitted.push(request),
        { id: request.id, input: request }
      ),
      applyInput: (projectId, conversation, request) =>
        assignJigInput(jigInputDeps(f.sources, f.runtime), projectId, request.instanceId, request),
      ...(planTurn ? { planTurn } : {}),
    },
  );
  return { status, data, next: submitted[0] };
}
/** A jig_ask_input card for the voids, recorded as the turn `requestId` ended with `shown`. */
async function askVoids(f, requestId, shown = (card) => card) {
  const handlers = conversationHandlers(f.sources);
  const asked = await handlers.jig_ask_input({
    input: 'voids',
    options: [
      { layers: ['구조::보이드'], recommended: true },
      { layers: ['기타'], label: '기타 레이어', recommended: false },
    ],
  });
  f.conversations.addLedger(f.project.id, f.conversation.id, {
    kind: 'question',
    requestId,
    body: shown(asked.question),
  });
  return asked.question;
}

test('input card answers that are not the person confirming: another card, 권장값, a Plan turn — told, never set', async (t) => {
  const f = await fixture(t);
  const voids = async () =>
    (await f.runtime.view(f.project.id, f.created.id)).body.assembly['site.voids'];

  // The card shown is not the recorded card (the AI swapped the labels): nothing is set.
  const swapped = await askVoids(f, 'ask-swap', (card) => ({
    ...card,
    options: card.options.map((o, n) => ({ ...o, label: card.options[1 - n].label })),
  }));
  const a = await answerRoute(f, {
    requestId: 'ask-swap',
    answers: [{ questionId: swapped.id, optionId: 'layers-2' }],
  });
  assert.equal(a.status, 201);
  assert.deepEqual(
    a.data.applied.map((x) => [x.ok, x.held]),
    [[false, 'mismatch']],
  );
  assert.match(a.data.applied[0].text, /카드가 달라 넣지 않음: 구조::기타/);
  assert.equal(await voids(), undefined);
  assert.match(a.next.body, /입력에 넣지 않았습니다/);

  // [권장값으로 진행]: an assumption (SPEC-02.19 6), a proposed input only.
  const card = await askVoids(f, 'ask-rec');
  const b = await answerRoute(f, { requestId: 'ask-rec', recommended: true });
  assert.deepEqual(
    b.data.applied.map((x) => [x.questionId, x.ok, x.held]),
    [[card.id, false, 'recommended']],
  );
  assert.equal(await voids(), undefined);
  assert.doesNotMatch(b.next.body, /입력에 바로 넣고/);

  // A card asked in a Plan turn: kept as a proposed input until [진행] (SPEC-02.20 2).
  const planned = await askVoids(f, 'ask-plan');
  const c = await answerRoute(
    f,
    { requestId: 'ask-plan', answers: [{ questionId: planned.id, optionId: 'layers-1' }] },
    { planTurn: (projectId, requestId) => requestId === 'ask-plan' },
  );
  assert.deepEqual(
    c.data.applied.map((x) => [x.ok, x.held]),
    [[false, 'plan']],
  );
  assert.match(c.data.applied[0].text, /\[진행\] 뒤에/);
  assert.equal(await voids(), undefined);
  assert.equal(f.reads.length, 0);

  // The person's words for jig_set_input: their own answer counts (the option's layers), the
  // 권장값 answer does not; an answer turn's text is VIDE's, not the person's.
  const workspace = {
    store: f.store,
    brief: (projectId, id) => ({ input: { body: id === 'typed' ? '보이드는 구조::기타' : '' } }),
  };
  const said = personWordsOf(workspace, f.conversation, 'typed');
  assert.ok(said.includes('보이드는 구조::기타'));
  assert.ok(said.includes('구조::보이드'), JSON.stringify(said));
  const answerTurn = personWordsOf(workspace, f.conversation, c.next.id);
  assert.ok(!answerTurn.includes('보이드는 구조::기타'));
  const recommendedAnswer = f.conversations
    .get(f.project.id, f.conversation.id)
    .ledger.find((item) => item.kind === 'answer' && item.body.by === 'recommended');
  assert.ok(recommendedAnswer);
  const onlyRecommended = personWordsOf(
    { store: f.store, brief: () => ({ input: {} }) },
    f.conversation,
    b.next.id,
  );
  // The person's answers only: the swapped card's label (not its recorded layers, which the person
  // never saw) and the Plan turn's label with its layers; the 권장값 answer is not there.
  assert.deepEqual(onlyRecommended, ['구조::보이드', '구조::보이드', '구조::보이드']);
});

// T-293 follow-up (verify loop R5, request ad7be574): the AI called jig_set_input twice; the engine
// log said ok:true but the workbook never changed. The answers were NOT_NAMED refusals (the person
// had named a file, not a layer, and had picked 3D::S-Slab on the role card themselves) and the
// log line counted only transport errors. A refusal is logged as one, a no-op is UNCHANGED, and an
// applied answer names the workbook and the steps that changed (SPEC-07.18 9.6).
test('jig_set_input never reports ok without a change: R5 refusals logged as failures, a held role is UNCHANGED, ok names the workbook and changed steps', async (t) => {
  const f = await fixture(t);
  const events = [];
  const sink = (event, fields) => events.push({ event, ...fields });
  setDiagnosticSink(sink);
  t.after(() => setDiagnosticSink(undefined, sink));
  const tools = new AgentTools({ origin: 'http://127.0.0.1:47999' });
  const scope = tools.issueConversation(f.sources);
  t.after(() => scope.revoke());
  const call = async (name, args) => {
    const result = await tools.call(scope.connection.token, name, args);
    return JSON.parse(result.content[0].text);
  };
  const logged = () => events.filter((e) => e.event === 'tool-call').at(-1);

  // R5's words: the request names member kinds, the card answer names the file — no layer.
  f.words.push(
    '이 모델에서 구조 검토를 하고 싶습니다. 보, 기둥, 슬래브, 벽, 코어 같은 구조 부재가 어떤 레이어에 어떻게 들어 있는지 파악해 주세요.',
    '구조 모델',
  );
  // R5's call: the role by its title, a full layer path, the file's linkId, the AI's reason.
  const r5 = await call('jig_set_input', {
    input: 'outline',
    layers: ['구조::슬래브 외곽'],
    linkId: 'L1',
    reason: '사용자가 구조 모델을 이번 검토의 기준 파일로 선택',
  });
  assert.deepEqual([r5.ok, r5.error, r5.layers], [false, 'NOT_NAMED', ['구조::슬래브 외곽']]);
  assert.deepEqual(
    [logged().tool, logged().ok, logged().code],
    ['jig_set_input', false, 'NOT_NAMED'],
  );
  assert.deepEqual((await f.runtime.view(f.project.id, f.created.id)).body.assembly, {});
  assert.equal(f.reads.length, 0);

  // The person picks the layer on the role card / answers the card (no word check): applied, with
  // the workbook it changed and the steps whose status moved.
  const before = await f.runtime.view(f.project.id, f.created.id);
  const picked = await assignJigInput(
    jigInputDeps(f.sources, f.runtime),
    f.project.id,
    f.created.id,
    {
      input: 'outline',
      layers: ['구조::슬래브 외곽'],
    },
  );
  assert.equal(picked.ok, true, JSON.stringify(picked));
  assert.deepEqual(picked.workbook, { id: f.created.id, title: '격자 대안 A' });
  const grid = picked.changedSteps.find((s) => s.id === 'grid');
  assert.deepEqual(
    [grid.from, grid.to],
    [before.steps.find((s) => s.id === 'grid').status, 'done'],
  );
  assert.ok(picked.changedSteps.every((s) => typeof s.title === 'string'));
  assert.equal(f.reads.length, 1);

  // The AI sets the same role to what it already holds, now even named: nothing changes — told
  // UNCHANGED with what the role holds, nothing read again, logged as a failure.
  f.words.push('슬래브 외곽으로 해 줘');
  const again = await call('jig_set_input', { input: '슬래브 외곽선', layers: ['슬래브 외곽'] });
  assert.deepEqual([again.ok, again.error], [false, 'UNCHANGED']);
  assert.deepEqual(again.role.layers, ['구조::슬래브 외곽']);
  assert.match(again.message, /이미/);
  assert.deepEqual([logged().ok, logged().code], [false, 'UNCHANGED']);
  assert.equal(f.reads.length, 1);
  // Unchanged even when the layers were never named: the held state is the useful answer.
  f.words.length = 0;
  const unnamedHeld = await call('jig_set_input', {
    input: 'outline',
    layers: ['구조::슬래브 외곽'],
  });
  assert.equal(unnamedHeld.error, 'UNCHANGED');

  // A real change through the tool: ok names the workbook and the changed steps; the log says ok.
  f.words.push('보이드는 구조::보이드');
  const voids = await call('jig_set_input', { input: 'voids', layers: ['구조::보이드'] });
  assert.equal(voids.ok, true, JSON.stringify(voids));
  assert.equal(voids.workbook.id, f.created.id);
  assert.ok(Array.isArray(voids.changedSteps));
  assert.deepEqual([logged().ok, logged().code], [true, undefined]);
});

// T-293 follow-up (review of wave 5): R5's real path — the person picked the layer on the role
// card first. The card's read goes through `POST …/reads {syncId, layers}` without a linkId, so the
// role holds `sync:<syncId>`; jig_set_input with the file's linkId and the same layer is UNCHANGED
// (SPEC-07.18 9.6), for the file's latest Sync and for an older Sync of the same file.
test('a role picked on the role card (held as sync:<id>) is UNCHANGED for the same file and layer', async (t) => {
  const f = await fixture(t);
  f.sources.workspace = {
    list: () => [
      { id: 'sync-0', state: 'succeeded', input: { linkId: 'L1' } },
      { id: 'sync-1', state: 'succeeded', input: { linkId: 'L1' } },
    ],
    get: (pid, id) => ({ id, result: model() }),
  };
  const tools = new AgentTools({ origin: 'http://127.0.0.1:47999' });
  const scope = tools.issueConversation(f.sources);
  t.after(() => scope.revoke());
  const call = async (name, args) =>
    JSON.parse((await tools.call(scope.connection.token, name, args)).content[0].text);
  const roleKey = inputRoles(await f.runtime.view(f.project.id, f.created.id)).find((r) =>
    r.key.endsWith('.outline'),
  ).key;
  // The role card's [레이어 고르기] (src/server/jig-routes.ts): the read keeps `sync:<syncId>`.
  const pick = async (syncId) => {
    const picked = rowsOfLayers(model(), ['구조::슬래브 외곽']);
    const read = f.runtime.recordRead(f.project.id, f.created.id, {
      linkId: `sync:${syncId}`,
      revisionKey: 'rhino-1|7|3',
      layers: ['구조::슬래브 외곽'],
      includeHidden: false,
      purpose: 'assembly',
      model: { scene: picked.rows, definitions: picked.definitions },
    });
    await f.runtime.setAssembly(f.project.id, f.created.id, roleKey, {
      sources: [{ readId: read.id, layers: ['구조::슬래브 외곽'] }],
      confirm: true,
      by: 'user',
    });
  };
  for (const syncId of ['sync-1', 'sync-0']) {
    await pick(syncId);
    // R5's call exactly: the file's linkId, the full path, words that never name the layer.
    const again = await call('jig_set_input', {
      input: 'outline',
      layers: ['구조::슬래브 외곽'],
      linkId: 'L1',
      reason: '사용자가 구조 모델을 이번 검토의 기준 파일로 선택',
    });
    assert.deepEqual([again.ok, again.error], [false, 'UNCHANGED'], syncId);
    assert.deepEqual(again.role.layers, ['구조::슬래브 외곽']);
  }
  assert.equal(f.reads.length, 0);
});

// T-298 (SPEC-07.5 7): the AI path reads an open file's last Sync first; a closed file's only for a
// layer no open file holds, and says so. links_layers lists the open files first.
test('jig inputs and links_layers: open files first, a closed file only as a marked fallback', async (t) => {
  const f = await fixture(t);
  const links = [
    { id: 'L-closed', host: 'rhino', name: '1차 모델', instance: 'rhino-1' },
    { id: 'L-open', host: 'rhino', name: '구조 모델', instance: 'rhino-2' },
    { id: 'L-file', host: 'rhino', name: '배치.3dm', instance: 'file:c:/a/배치.3dm' },
  ];
  const onlyClosed = {
    ...model(),
    scene: [...model().scene, row('o2', '옛::대지', OUTLINE)],
    layers: [...model().layers, { fullPath: '옛::대지', objectCount: 1 }],
  };
  f.sources.workspace = {
    list: () => [
      { id: 's-closed', state: 'succeeded', input: { linkId: 'L-closed' } },
      { id: 's-open', state: 'succeeded', input: { linkId: 'L-open' } },
    ],
    get: (pid, id) => ({ id, result: id === 's-closed' ? onlyClosed : model() }),
  };
  f.sources.links = { list: () => links, get: (pid, id) => links.find((l) => l.id === id) };
  f.sources.openLinks = async () => new Set(['L-open']);
  const deps = jigInputDeps(f.sources, f.runtime);
  const documents = await deps.documents();
  assert.deepEqual(
    documents.map((d) => [d.linkId, !!d.closed]),
    [
      ['L-open', false],
      ['L-closed', true],
    ],
  );
  // The same layer in the open and the closed file: the open file, no "which file" question.
  const both = resolveLayers(documents, ['구조::슬래브 외곽']);
  assert.deepEqual(both.problems, []);
  assert.deepEqual(
    both.picks.map((p) => p.document.linkId),
    ['L-open'],
  );
  // Only in the closed file: read from it, and the result says so.
  const fallback = await assignJigInput(deps, f.project.id, f.created.id, {
    input: 'outline',
    layers: ['옛::대지'],
  });
  assert.equal(fallback.ok, true, JSON.stringify(fallback));
  assert.deepEqual(
    fallback.layers.map((l) => [l.linkId, l.closed, l.note]),
    [['L-closed', true, '닫힌 연결 기준']],
  );
  // links_layers: open first, the closed file marked; a file entry is never closed.
  const handlers = conversationHandlers(f.sources);
  const listed = await handlers.links_layers({});
  assert.deepEqual(
    listed.links.map((l) => [l.linkId, l.closed ?? false]),
    [
      ['L-open', false],
      ['L-file', false],
      ['L-closed', true],
    ],
  );
  // No host connection to ask: every link counts as open (unchanged order).
  const unknown = jigInputDeps({ ...f.sources, openLinks: async () => null }, f.runtime);
  assert.ok((await unknown.documents()).every((d) => !d.closed));
});
