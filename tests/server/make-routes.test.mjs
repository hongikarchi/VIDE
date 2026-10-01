import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import {
  MAKE_LIMITS,
  MAKE_TURN_CAP,
  MakeTurnGuard,
  makeRoutes,
  makeTurnResult,
} from '../../src/server/make-routes.ts';
import {
  TURN_OUTPUT_JSON_SCHEMA,
  turnOutputResult,
  turnOutputSchema,
} from '../../src/server/turn-output.ts';
import { closeJigRuntime } from '../../src/server/jig-routes.ts';
import { ConversationService, conversationRoutes } from '../../src/server/conversations.ts';
import {
  AgentTools,
  conversationHandlers,
  conversationSources,
  conversationTarget,
} from '../../src/server/agent-tools.ts';
import {
  agentConnection,
  allowedAgentEvent,
  configureAgentArguments,
  instructionFor,
} from '../../src/ai/agent-connection.ts';
import { cliArguments, sessionArguments } from '../../src/ai/claude-cli.ts';
import {
  CodexCli,
  codexArguments,
  makeOutputSchema,
  withDraftFiles,
} from '../../src/ai/codex-cli.ts';

// T-063 part 1 (PLAN-22): the jig-drafts routes, the make-conversation and its turn's tools and
// CLI arguments. Synthetic drafts only; no provider runs, no host.

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'vide-make-'));
  const store = new Store(join(root, 'vide.sqlite'));
  const workspace = new Workspace(store);
  const project = store.createProject('만들기 시험');
  const removed = [];
  const conversations = new ConversationService(store, {
    removeTranscript: async (provider, sessionId) => {
      removed.push(sessionId);
      return 1;
    },
  });
  const call = async (method, path, payload, { remote = false } = {}) => {
    let last;
    const request = Object.assign(Readable.from([]), { method, headers: {} });
    const handled = await makeRoutes(new URL(path, 'http://127.0.0.1'), request, {
      workspace,
      body: async () => payload ?? {},
      send: (status, data) => (last = { status, data }),
      dataDirectory: root,
      remote,
      conversations,
    });
    return handled ? last : { status: 0 };
  };
  const conversation = async (payload) => {
    let last;
    await conversationRoutes(
      new URL(`http://127.0.0.1/api/v1/projects/${project.id}/conversations`),
      Object.assign(Readable.from([]), { method: 'POST', headers: {} }),
      {
        service: conversations,
        body: async () => payload,
        send: (status, data) => (last = { status, data }),
        chooseModel: async () => ({ provider: 'claude-cli', model: 'sonnet', effort: 'default' }),
      },
    );
    return last;
  };
  t.after(async () => {
    await closeJigRuntime(workspace);
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const base = `/api/v1/projects/${project.id}/jig-drafts`;
  return { root, store, workspace, project, conversations, removed, call, conversation, base };
}

test('drafts are created, checked in the compute box, previewed and pinned by confirmation', async (t) => {
  const { call, base, store, project, root } = setup(t);
  assert.equal((await call('GET', '/api/v1/projects/x/other')).status, 0);
  const created = await call('POST', base, { name: 'grid make', from: 'example-grid' });
  assert.equal(created.status, 201);
  const draft = created.data;
  assert.equal(draft.path, join(root, 'jigs', 'drafts', draft.id));
  assert.equal(draft.manifest.id, 'project/grid-make');
  assert.equal(draft.name, 'grid make');
  assert.ok(draft.skill.includes('격자'));
  assert.ok(draft.files.some((file) => file.path === 'steps/grid.ts' && file.size > 0));
  assert.equal((await call('GET', base)).data.drafts.length, 1);

  const validated = await call('POST', `${base}/${draft.id}/validate`);
  assert.equal(validated.status, 200);
  assert.ok(validated.data.ok, JSON.stringify(validated.data.issues));
  const tested = await call('POST', `${base}/${draft.id}/test`);
  assert.ok(tested.data.ok, JSON.stringify(tested.data.cases));
  const preview = await call('POST', `${base}/${draft.id}/preview`, {});
  assert.equal(preview.data.fixture, 'basic');
  assert.ok(preview.data.panel);
  assert.ok(preview.data.outputs.grid.columns.length > 0);
  const view = (await call('GET', `${base}/${draft.id}`)).data;
  assert.ok(view.validate.ok && view.test.ok && view.preview.ok);

  // Pinning is confirmed and refused to remote sessions.
  await assert.rejects(call('POST', `${base}/${draft.id}/pin`, {}), /CONFIRMATION_REQUIRED/);
  await assert.rejects(
    call('POST', `${base}/${draft.id}/pin`, { confirm: true }, { remote: true }),
    /FORBIDDEN/,
  );
  // A forbidden file written into the folder refuses the pin with the issues.
  writeFileSync(join(draft.path, 'CLAUDE.md'), '# not allowed');
  const refused = await call('POST', `${base}/${draft.id}/pin`, { confirm: true });
  assert.equal(refused.status, 422);
  assert.equal(refused.data.code, 'JIG_INVALID');
  assert.ok(refused.data.issues.some((issue) => issue.path === 'CLAUDE.md'));
  rmSync(join(draft.path, 'CLAUDE.md'));

  const pinned = await call('POST', `${base}/${draft.id}/pin`, { confirm: true });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.data.id, 'project/grid-make');
  const jigs = new JigStore(store.db);
  assert.equal(jigs.package('project/grid-make', '0.1.0').source, 'ai-draft');
  assert.deepEqual(
    jigs.pinned(project.id).map((row) => row.jigId),
    ['project/grid-make'],
  );
  await assert.rejects(
    call('POST', `${base}/${draft.id}/pin`, { confirm: true }),
    /DRAFT_NOT_OPEN/,
  );
});

test('a make-conversation is tied to an open draft; deleting the draft removes its transcripts', async (t) => {
  const { call, base, conversation, conversations, removed, project } = setup(t);
  const draft = (await call('POST', base, { name: '빈 초안', from: 'blank' })).data;
  await assert.rejects(conversation({ mode: 'make' }), /Invalid|ZodError|too_small|custom/i);
  const made = await conversation({ mode: 'make', draftId: draft.id });
  assert.equal(made.status, 201);
  assert.equal(made.data.kind, 'jig-make');
  assert.equal(made.data.draftId, draft.id);
  assert.equal(made.data.title, 'jig 만들기');
  assert.equal((await call('GET', `${base}/${draft.id}`)).data.conversationId, made.data.id);
  await assert.rejects(conversation({ mode: 'make', draftId: 'no-such-draft' }), /NOT_FOUND/);
  const key = {
    conversationId: made.data.id,
    provider: 'claude-cli',
    accountProfileId: 'default',
    sessionId: '11111111-2222-4333-8444-555555555555',
  };
  conversations.store.addSession({ ...key, promptMode: 'neutral', cliVersion: '2.1.284' });

  const deleted = await call('DELETE', `${base}/${draft.id}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.draft.state, 'discarded');
  assert.equal(deleted.data.transcriptsRemoved, 1);
  assert.deepEqual(removed, [key.sessionId]);
  assert.ok(!existsSync(draft.path));
  assert.equal(conversations.get(project.id, made.data.id).state, 'closed');
  assert.equal((await call('GET', base)).data.drafts.length, 0);
  await assert.rejects(conversation({ mode: 'make', draftId: draft.id }), /DRAFT_NOT_OPEN/);
});

test("a make turn's tools check the draft; its connection carries the draft folder", async (t) => {
  const { call, base, conversation, workspace, project } = setup(t);
  const draft = (await call('POST', base, { name: 'tools', from: 'blank' })).data;
  const made = (await conversation({ mode: 'make', draftId: draft.id })).data;
  const sources = conversationSources(workspace, made);
  assert.equal(sources.draft.dir, draft.path);
  const handlers = conversationHandlers(sources);
  for (const name of ['jig_validate', 'jig_test', 'jig_preview', 'ask_user'])
    assert.equal(typeof handlers[name], 'function', name);
  assert.equal((await handlers.jig_validate({ targetRef: 'x' })).ok, true);
  assert.equal((await handlers.jig_test({ targetRef: 'x' })).ok, true);
  const preview = await handlers.jig_preview({ targetRef: 'x' });
  assert.equal(preview.ok, true);
  assert.ok(preview.outputs.main);
  const asked = handlers.ask_user({
    targetRef: 'x',
    question: {
      id: 'pair-gap',
      title: '쌍기둥 간격 기준을 어떻게 볼까요?',
      options: [
        { id: 'center', label: '중심 간격', recommended: true },
        { id: 'clear', label: '순 간격', recommended: false },
      ],
    },
  });
  assert.equal(asked.question.id, 'pair-gap');
  assert.equal(asked.question.options[0].label, '중심 간격');
  assert.throws(
    () =>
      handlers.ask_user({
        targetRef: 'x',
        question: {
          ...asked.question,
          options: asked.question.options.map((o) => ({ ...o, recommended: false })),
        },
      }),
    /INVALID_INPUT/,
  );

  // An ordinary conversation of the same project gets no make tools.
  const plain = conversationSources(workspace, { ...made, kind: 'general', draftId: null });
  assert.equal(plain.draft, undefined);
  assert.equal(conversationHandlers(plain).jig_validate, undefined);

  const tools = new AgentTools({ origin: 'http://127.0.0.1:47999' });
  const scope = tools.issueConversation(sources);
  assert.equal(scope.connection.draftDir, draft.path);
  assert.ok(scope.connection.tools.includes('jig_validate'));
  const called = await tools.call(scope.connection.token, 'jig_validate', {
    targetRef: conversationTarget(made.id),
  });
  assert.equal(JSON.parse(called.content[0].text).ok, true);
  scope.revoke();
  tools.close();
  assert.equal(project.id, made.projectId);
});

test('Claude make turns get file tools on the draft folder only; Codex gets none', () => {
  const draftDir = join(tmpdir(), 'vide-draft-args');
  const connection = agentConnection({
    url: 'http://127.0.0.1:47999/mcp',
    token: 'a'.repeat(64),
    tools: ['jig_validate', 'jig_test', 'jig_preview', 'ask_user'],
    draftDir,
  });
  assert.equal(connection.draftDir, draftDir);
  assert.throws(() => agentConnection({ ...connection, draftDir: 'relative/dir' }), /INVALID/);
  const args = configureAgentArguments(
    sessionArguments(cliArguments(), { id: '11111111-2222-4333-8444-555555555555', resume: false }),
    'claude',
    connection,
    { neutral: true },
  );
  assert.ok(args.includes('--restricted') && !args.includes('--safe-mode'));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Edit,Write,Glob,Grep');
  assert.equal(args[args.indexOf('--add-dir') + 1], draftDir);
  assert.equal(
    args[args.indexOf('--allowedTools') + 1],
    'mcp__vide__jig_validate,mcp__vide__jig_test,mcp__vide__jig_preview,mcp__vide__ask_user,Read,Edit,Write,Glob,Grep',
  );
  assert.match(instructionFor(connection), /jig draft/);
  const codex = configureAgentArguments(codexArguments('gpt-5'), 'codex', connection);
  assert.ok(!codex.includes('--add-dir'));
  assert.ok(!codex.some((value) => /Read,Edit/.test(value)));
  assert.equal(allowedAgentEvent({ name: 'Write' }, 'codex', connection), false);

  // Tool calls: inside the folder only, never a forbidden file.
  const use = (name, input) =>
    allowedAgentEvent({ type: 'tool_use', name, input }, 'claude', connection);
  assert.ok(allowedAgentEvent({ name: 'Read' }, 'claude', connection));
  assert.ok(use('Write', { file_path: join(draftDir, 'steps', 'pair.ts'), content: '' }));
  assert.ok(use('Edit', { file_path: join(draftDir, 'jig.json') }));
  assert.ok(use('Read', { file_path: join(draftDir, 'fixtures', 'basic', 'input.json') }));
  assert.ok(!use('Write', { file_path: join(draftDir, 'CLAUDE.md'), content: '' }));
  assert.ok(!use('Write', { file_path: join(draftDir, '.claude', 'settings.json') }));
  assert.ok(!use('Edit', { file_path: join(draftDir, 'package.json') }));
  assert.ok(!use('Write', { file_path: join(draftDir, '..', 'escape.ts') }));
  assert.ok(!use('Read', { file_path: join(tmpdir(), 'secret.txt') }));
  assert.ok(use('Glob', { pattern: 'steps/**/*.ts', path: draftDir }));
  assert.ok(!use('Glob', { pattern: '../**/*' }));
  assert.ok(!use('Glob', { pattern: 'C:/Users/**' }));
  assert.ok(!use('Grep', { pattern: 'x', path: tmpdir() }));
  assert.ok(!use('Grep', { pattern: 'x', path: join(draftDir, 'jig.json:stream') }));
  assert.ok(use('Grep', { pattern: 'x', path: join(draftDir, 'steps') }));
  // A tool call without input is not the init event's tool list.
  assert.ok(!allowedAgentEvent({ type: 'tool_use', name: 'Write' }, 'claude', connection));
  assert.ok(!use('Bash', { command: 'dir' }));
  // Without a draft folder the file tools stay refused.
  const plain = agentConnection({ ...connection, draftDir: undefined });
  assert.equal(allowedAgentEvent({ name: 'Read' }, 'claude', plain), false);
});

test('jig_delete_file deletes in the draft only and is a registered make tool', async (t) => {
  const { call, base, conversation, workspace } = setup(t);
  const draft = (await call('POST', base, { name: 'delete', from: 'blank' })).data;
  const made = (await conversation({ mode: 'make', draftId: draft.id })).data;
  const sources = conversationSources(workspace, made);
  const tools = new AgentTools({ origin: 'http://127.0.0.1:47999' });
  const scope = tools.issueConversation(sources);
  assert.ok(scope.connection.tools.includes('jig_delete_file'));
  writeFileSync(join(draft.path, 'steps', 'old.ts'), 'export const x = 1;\n');
  const run = async (path) =>
    JSON.parse(
      (await tools.call(scope.connection.token, 'jig_delete_file', { path })).content[0].text,
    );
  assert.deepEqual(await run('steps/old.ts'), { path: 'steps/old.ts', deleted: true });
  assert.equal(existsSync(join(draft.path, 'steps', 'old.ts')), false);
  assert.deepEqual(await run('jig.json'), { code: 'DRAFT_PATH_INVALID' });
  assert.deepEqual(await run('../other.ts'), { code: 'DRAFT_OUTSIDE' });
  assert.deepEqual(await run('.claude/settings.json'), { code: 'DRAFT_FORBIDDEN_FILE' });
  assert.deepEqual(await run('steps/none.ts'), { code: 'NOT_FOUND' });
  scope.revoke();
  tools.close();
  assert.match(instructionFor(scope.connection), /jig_delete_file/);
});

test('three failures for the same reason stop the make turn with a question card', async (t) => {
  const { call, base, conversation, workspace, project } = setup(t);
  const draft = (await call('POST', base, { name: 'stop', from: 'blank' })).data;
  const made = (await conversation({ mode: 'make', draftId: draft.id })).data;
  const sources = conversationSources(workspace, made);
  assert.equal(sources.draft.guard.turns, 1);
  assert.equal(sources.draft.guard.stop, undefined);
  const handlers = conversationHandlers(sources);
  const expect = join(draft.path, 'fixtures', 'basic', 'expect.json');
  writeFileSync(expect, JSON.stringify({ steps: { main: { total: 999 } } }));
  assert.equal((await handlers.jig_test({})).stop, undefined);
  // A pass in between starts the count again.
  assert.equal((await handlers.jig_validate({})).ok, true);
  assert.equal((await handlers.jig_test({})).stop, undefined);
  assert.equal((await handlers.jig_test({})).stop, undefined);
  const third = await handlers.jig_test({});
  assert.equal(third.ok, false);
  assert.equal(third.stop, 'failures');
  assert.match(third.next, /Stop now/);
  // After the stop the make tools refuse.
  for (const name of ['jig_validate', 'jig_test', 'jig_preview'])
    await assert.rejects(async () => handlers[name]({}), /MAKE_STOPPED/);
  assert.throws(() => handlers.jig_delete_file({ path: 'skill.md' }), /MAKE_STOPPED/);

  const patch = await makeTurnResult(
    project.id,
    sources.draft,
    { text: '{"status":"progress","text":"x","questions":[]}' },
    { text: '합계 시험이 계속 다릅니다.' },
  );
  assert.equal(patch.turnOutput.status, 'question');
  assert.equal(patch.turnOutput.stop.reason, 'failures');
  assert.equal(patch.turnOutput.questions[0].id, 'make-stop-1');
  assert.match(patch.text, /^합계 시험이 계속 다릅니다\.\n\n멈춘 이유/);
  assert.match(patch.text, /basic/);
  // The card is a valid question card: the answer flow reads it back from the ledger.
  const parsed = turnOutputSchema.safeParse({
    status: 'question',
    text: '',
    questions: patch.turnOutput.questions,
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

test('the turn cap stops every twentieth turn past the cap', async () => {
  assert.equal(new MakeTurnGuard(20).stop, undefined);
  assert.deepEqual(new MakeTurnGuard(21).stop, { reason: 'turn-cap', turns: 21 });
  assert.equal(new MakeTurnGuard(22).stop, undefined);
  assert.equal(new MakeTurnGuard(41).stop?.reason, 'turn-cap');
  assert.equal(MAKE_TURN_CAP, 20);
  const guard = new MakeTurnGuard(21);
  assert.throws(() => guard.check(), /MAKE_STOPPED/);
  const patch = await makeTurnResult('p', { draftId: 'd', drafts: {}, guard }, {}, { text: '' });
  assert.equal(patch.turnOutput.questions[0].id, 'make-turn-cap-21');
  assert.equal(patch.turnOutput.questions[0].options[0].id, 'new-conversation');
  assert.match(patch.text, /^멈춘 이유: 20턴 초과/);
});

test('a Codex make turn returns its files in the output; VIDE writes, checks and refuses', async (t) => {
  const { call, base, conversation, conversations, workspace, project } = setup(t);
  const draft = (await call('POST', base, { name: 'codex make', from: 'blank' })).data;
  // A Codex make-conversation runs the ledger method.
  const made = (
    await conversation({ mode: 'make', draftId: draft.id, provider: 'codex-cli', model: 'gpt-5' })
  ).data;
  assert.equal(made.provider, 'codex-cli');
  assert.equal(conversations.store.get(project.id, made.id).mode, 'ledger');
  // Every make turn (an answer turn too) takes the make budgets.
  const input = { conversationId: made.id };
  conversations.fix(project.id, input);
  assert.deepEqual(input.executionLimits, MAKE_LIMITS);
  assert.equal(input.hostUse, 'none');

  writeFileSync(join(draft.path, 'steps', 'gone.ts'), 'export {};\n');
  const main = `export function main(_i: unknown, params: { count: number }) {
  const items = Array.from({ length: params.count }, (_, i) => ({ key: 'item:' + (i + 1), value: 2 }));
  return { items, total: items.length * 2 };
}
`;
  const output = {
    status: 'done',
    text: '두 배로 바꿨습니다.',
    questions: [],
    files: [
      { path: 'steps/main.ts', content: main },
      { path: 'fixtures/basic/expect.json', content: '{"steps":{"main":{"total":6}}}\n' },
      { path: 'steps/gone.ts', content: null },
      { path: 'CLAUDE.md', content: '# no' },
      { path: '../escape.ts', content: 'x' },
    ],
  };
  const result = { text: JSON.stringify(output) };
  // The checked turn output keeps text and questions; the files never go into the result.
  const checked = turnOutputResult({ structured: true }, result);
  assert.equal(checked.turnOutputError, undefined);
  assert.equal(checked.text, '두 배로 바꿨습니다.');
  assert.equal('files' in checked, false);

  const sources = conversationSources(workspace, made);
  const patch = await makeTurnResult(project.id, sources.draft, result, checked);
  assert.deepEqual(patch.makeFiles.written, ['steps/main.ts', 'fixtures/basic/expect.json']);
  assert.deepEqual(patch.makeFiles.deleted, ['steps/gone.ts']);
  assert.deepEqual(patch.makeFiles.refused, [
    { path: 'CLAUDE.md', code: 'DRAFT_FORBIDDEN_FILE' },
    { path: '../escape.ts', code: 'DRAFT_OUTSIDE' },
  ]);
  assert.deepEqual(patch.makeFiles.validate, { ok: true, issues: 0 });
  assert.deepEqual(patch.makeFiles.test, { ok: true, failed: 0 });
  assert.equal(patch.turnOutput, undefined);
  assert.equal(readFileSync(join(draft.path, 'steps', 'main.ts'), 'utf8'), main);
  assert.equal(existsSync(join(draft.path, 'steps', 'gone.ts')), false);
  assert.equal(existsSync(join(draft.path, 'CLAUDE.md')), false);
  // Invalid files are not guessed at: nothing is written and the reason goes back.
  const none = await makeTurnResult(
    project.id,
    sources.draft,
    { text: JSON.stringify({ ...output, files: [{ path: 'x.ts' }] }) },
    {},
  );
  assert.deepEqual(none.makeFiles, {
    written: [],
    deleted: [],
    refused: [{ path: '', code: 'MAKE_FILES_INVALID' }],
  });
  assert.equal(existsSync(join(draft.path, 'x.ts')), false);
  // No files in the output: nothing to report.
  const quiet = await makeTurnResult(project.id, sources.draft, { text: '{"status":"done"}' }, {});
  assert.equal(quiet.makeFiles, undefined);
});

test('Codex make turns get the draft files in the packet and a files output schema', async (t) => {
  const { call, base } = setup(t);
  const draft = (await call('POST', base, { name: 'codex packet', from: 'blank' })).data;
  writeFileSync(join(draft.path, 'AGENTS.md'), '# not for the packet');
  const connection = agentConnection({
    url: 'http://127.0.0.1:47999/mcp',
    token: 'a'.repeat(64),
    tools: ['jig_validate', 'jig_test', 'jig_preview', 'jig_delete_file', 'ask_user'],
    draftDir: draft.path,
  });
  const args = configureAgentArguments(codexArguments('gpt-5'), 'codex', connection);
  const instructions = args.find((value) => value.startsWith('developer_instructions='));
  assert.match(instructions, /no file tools/);
  assert.match(instructions, /draft-files/);
  assert.doesNotMatch(instructionFor(connection), /draft-files/);

  const schema = JSON.parse(makeOutputSchema(JSON.stringify(TURN_OUTPUT_JSON_SCHEMA)));
  assert.deepEqual(schema.required, ['status', 'text', 'questions', 'files']);
  assert.deepEqual(schema.properties.files.items.required, ['path', 'content']);
  const cli = new CodexCli({ executable: process.execPath, agent: connection });
  const folder = mkdtempSync(join(tmpdir(), 'vide-codex-schema-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const withSchema = await cli.withOutputSchema(
    ['exec', '-'],
    JSON.stringify(TURN_OUTPUT_JSON_SCHEMA),
    folder,
  );
  const file = withSchema[withSchema.indexOf('--output-schema') + 1];
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).properties.files);

  const packet = await withDraftFiles(
    { goal: 'x', revision: 1, items: [{ id: 'a', type: 'note', data: 1 }], includedIds: ['a'] },
    draft.path,
  );
  assert.deepEqual(packet.includedIds, ['a', 'draft-files']);
  const files = packet.items.at(-1).data.files;
  const paths = files.map((entry) => entry.path);
  assert.ok(paths.includes('jig.json') && paths.includes('steps/main.ts'));
  assert.ok(!paths.includes('AGENTS.md'));
  assert.match(
    files.find((entry) => entry.path === 'steps/main.ts').content,
    /export function main/,
  );
});

test('a stopped make-conversation keeps no file tools until the stop card is answered with a way on', async (t) => {
  const { call, base, conversation, conversations, project } = setup(t);
  const draft = (await call('POST', base, { name: 'stopped', from: 'blank' })).data;
  const made = (await conversation({ mode: 'make', draftId: draft.id })).data;
  const stopped = () => conversations.makeStopped(project.id, made.id);
  assert.equal(stopped(), false);
  const card = (id) =>
    conversations.store.addLedgerItem(made.id, {
      kind: 'question',
      requestId: 'r-' + id,
      body: { id, title: '멈춤', options: [], blocks: '초안 작성', allowFree: true },
    });
  const answer = (questionId, body) =>
    conversations.store.addLedgerItem(made.id, {
      kind: 'answer',
      requestId: 'next-' + questionId,
      body: { questionId, ...body },
    });
  card('make-stop-3');
  assert.equal(stopped(), true);
  answer('make-stop-3', { optionId: 'stop-here' });
  assert.equal(stopped(), true);
  card('make-stop-5');
  answer('make-stop-5', { optionId: 'retry-other' });
  assert.equal(stopped(), false);
  card('make-turn-cap-21');
  answer('make-turn-cap-21', { text: '보 단면만 고쳐 주세요' });
  assert.equal(stopped(), false);
  card('make-turn-cap-41');
  answer('make-turn-cap-41', { optionId: 'new-conversation' });
  assert.equal(stopped(), true);

  // The connection of a stopped turn: no --add-dir, no file tools, file events refused.
  const draftDir = join(tmpdir(), 'vide-draft-stopped');
  const connection = agentConnection({
    url: 'http://127.0.0.1:47999/mcp',
    token: 'b'.repeat(64),
    tools: ['jig_validate', 'jig_test', 'jig_preview', 'ask_user'],
    draftDir,
    makeStopped: true,
  });
  assert.equal(connection.makeStopped, true);
  const args = configureAgentArguments(
    sessionArguments(cliArguments(), { id: '11111111-2222-4333-8444-555555555556', resume: false }),
    'claude',
    connection,
    { neutral: true },
  );
  assert.ok(!args.includes('--add-dir'));
  assert.ok(!args[args.indexOf('--tools') + 1].includes('Write'));
  assert.equal(
    args[args.indexOf('--allowedTools') + 1],
    'mcp__vide__jig_validate,mcp__vide__jig_test,mcp__vide__jig_preview,mcp__vide__ask_user',
  );
  const use = (name, input) =>
    allowedAgentEvent({ type: 'tool_use', name, input }, 'claude', connection);
  assert.ok(!use('Write', { file_path: join(draftDir, 'steps', 'a.ts'), content: '' }));
  assert.ok(!use('Read', { file_path: join(draftDir, 'jig.json') }));
  assert.equal(allowedAgentEvent({ name: 'Edit' }, 'claude', connection), false);
  assert.equal(allowedAgentEvent({ name: 'StructuredOutput' }, 'claude', connection), false);
  assert.ok(allowedAgentEvent({ name: 'mcp__vide__ask_user' }, 'claude', connection));
  assert.match(instructionFor(connection), /stopped/);
  assert.doesNotMatch(instructionFor(connection), /file tools Read, Edit, Write/);
  // makeStopped means nothing without a draft folder.
  assert.equal(agentConnection({ ...connection, draftDir: undefined }).makeStopped, undefined);
});
