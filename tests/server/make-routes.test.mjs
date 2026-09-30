import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import { makeRoutes } from '../../src/server/make-routes.ts';
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
import { codexArguments } from '../../src/ai/codex-cli.ts';

// T-063 part 1 (PLAN-22): the jig-drafts routes, the make-conversation and its turn's tools and
// CLI arguments. Synthetic drafts only; no provider runs, no host.

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'vide-make-'));
  const store = new Store(join(root, 'vide.sqlite'));
  const workspace = new Workspace(store);
  const project = store.createProject('만들기 시험');
  const removed = [];
  const conversations = new ConversationService(store, {
    removeTranscript: async (provider, directory, sessionId) => {
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
        chooseAccount: async () => 'default',
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
