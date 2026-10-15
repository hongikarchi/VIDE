// 연결 폴더 역할 제안 → 사람 확정 → 기억 (SPEC-01.13 8, PLAN-52 T-309): workspace_schema_propose
// reads and makes the card (nothing written), the card's answer route stores only what the person
// chose (workspace_schema_confirm is that path, never an AI tool), a [권장값으로 진행] answer stores
// nothing, and workspace_memory_set changes one remembered place the person named. Synthetic
// work and "server" folders (mkdtemp); no host, no real CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { ProjectFolders } from '../../src/core/project-folders.ts';
import { conversationHandlers, PLAN_MODE_TOOLS } from '../../src/server/agent-tools.ts';
import { agentToolNames, instructionFor } from '../../src/ai/agent-connection.ts';
import { ConversationService, conversationRoutes } from '../../src/server/conversations.ts';
import { schemaPending } from '../../src/server/workspace-schema.ts';

async function fixture(t, { manifest = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-schema-tools-'));
  const store = new Store(join(directory, 'data.sqlite'));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = store.createProject('나진상가');
  const work = join(directory, 'work');
  const server = join(directory, 'server', '2601-나진상가');
  await mkdir(work, { recursive: true });
  for (const file of [
    '05 도면/A-101.dwg',
    '05 도면/A-102.dwg',
    '05 도면/A-103.dwg',
    '05 도면/xref/X-base.dwg',
    '03 참고/a.jpg',
    '02 자료/법규.pdf',
    '06 도면 모델/',
  ]) {
    const path = join(server, ...file.split('/'));
    if (file.endsWith('/')) await mkdir(path, { recursive: true });
    else {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'x');
    }
  }
  if (manifest)
    await writeFile(
      join(work, 'project.config.json'),
      JSON.stringify({
        schema: 'vide-workspace/1',
        title: '나진상가',
        paths: { ops: '01_운영', cad: '04_도면' },
        custom: { kept: true },
        vide: { projectId: project.id },
      }),
    );
  const folders = new ProjectFolders(store);
  folders.add(project.id, work, 'project');
  folders.add(project.id, server, 'project');
  const conversations = new ConversationService(store, { removeTranscript: async () => 0 });
  const conversation = conversations.create(project.id, {
    kind: 'general',
    title: '폴더',
    provider: 'claude-cli',
  });
  const words = [];
  const workspaceFolders = {
    folders,
    isProject: (id) => store.listProjects().some((p) => p.id === id),
  };
  const sources = {
    projectId: project.id,
    conversationId: conversation.id,
    openInstanceId: null,
    requestId: 'ask-1',
    workspace: { list: () => [], get: () => undefined },
    ledger: (item) => conversations.addLedger(project.id, conversation.id, item),
    personWords: () => words,
    workspaceFolders,
  };
  const manifestText = () => readFile(join(work, 'project.config.json'), 'utf8');
  return {
    store,
    project,
    work,
    server,
    folders,
    conversations,
    conversation,
    sources,
    words,
    workspaceFolders,
    manifestText,
  };
}

/** POST …/answer through the route, as the question card sends it. */
async function answer(f, input, { remote } = {}) {
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
      ...(remote ? { remote } : {}),
    },
  );
  return { status, data, next: submitted[0] };
}
async function get(f, path) {
  let status, data;
  await conversationRoutes(
    new URL(`http://x/api/v1${path}`),
    { method: 'GET' },
    {
      service: f.conversations,
      body: async () => ({}),
      send: (s, d) => ((status = s), (data = d)),
      chooseModel: async () => ({ provider: 'claude-cli' }),
    },
  );
  return { status, data };
}
/** The AI proposes and the turn ends with its card (as a finished turn records its questions). */
async function propose(f, requestId) {
  const handlers = conversationHandlers({ ...f.sources, requestId });
  const result = await handlers.workspace_schema_propose({});
  f.conversations.addLedger(f.project.id, f.conversation.id, {
    kind: 'question',
    requestId,
    body: result.question,
  });
  return result;
}

test('the tools: propose for the AI (Plan too), memory_set for writes, confirm never an AI handler', async (t) => {
  const f = await fixture(t);
  for (const name of [
    'workspace_schema_propose',
    'workspace_schema_confirm',
    'workspace_memory_set',
  ])
    assert.ok(agentToolNames.includes(name), name);
  assert.ok(PLAN_MODE_TOOLS.has('workspace_schema_propose'));
  assert.ok(!PLAN_MODE_TOOLS.has('workspace_memory_set'));
  assert.ok(!PLAN_MODE_TOOLS.has('workspace_schema_confirm'));
  const handlers = conversationHandlers(f.sources);
  assert.ok(handlers.workspace_schema_propose && handlers.workspace_memory_set);
  assert.equal(handlers.workspace_schema_confirm, undefined);
  const rules = instructionFor({
    url: 'http://127.0.0.1:1/mcp',
    token: 't',
    tools: Object.keys(handlers),
  });
  assert.match(rules, /workspace_schema_propose/);
  assert.match(rules, /you have no confirm tool/);
});

test("propose → card + record, nothing written; the answer stores only the person's choice", async (t) => {
  const f = await fixture(t);
  const before = await f.manifestText();
  // The dashboard's trigger: the connected folder waits for a proposal.
  const waiting = await schemaPending(f.workspaceFolders, f.project.id);
  assert.deepEqual([waiting.pending, waiting.folder], [true, f.server]);

  const result = await propose(f, 'ask-1');
  const card = result.question;
  assert.match(card.id, /^workspace-schema-[0-9a-f]{6}$/);
  assert.deepEqual(
    card.options.map((o) => [o.id, o.label, o.recommended]),
    [
      ['remember', '이대로 기억', true],
      ['edit', '고쳐서 기억', false],
      ['later', '나중에', false],
    ],
  );
  assert.equal(result.status, 'ok');
  const rows = Object.fromEntries(result.folders.map((row) => [row.path, row]));
  assert.deepEqual([rows['05 도면'].guess, rows['05 도면'].reason], ['cad', 'DWG 4개 · xref 1']);
  assert.deepEqual(rows['06 도면 모델'].candidates, ['rhino', 'cad']);
  assert.ok(result.missing.includes('output'));
  const record = f.conversations.store
    .ledger(f.conversation.id, { current: true })
    .find((item) => item.kind === 'result-ref');
  assert.equal(record.body.appAction, 'workspace-schema');
  assert.equal(record.body.questionId, card.id);
  assert.equal(record.requestId, 'ask-1');
  // A guess is never stored: the manifest is byte for byte the same.
  assert.equal(await f.manifestText(), before);

  // The card's rows for the screen (Design SCR-36).
  const rowsRoute = await get(
    f,
    `/projects/${f.project.id}/conversations/${f.conversation.id}/workspace-schema/${card.id}`,
  );
  assert.equal(rowsRoute.status, 200);
  assert.equal(rowsRoute.data.roles.cad, '도면');
  assert.equal(rowsRoute.data.folders.length, result.folders.length);

  // [이대로 기억] with the competing row picked by the person.
  const done = await answer(f, {
    requestId: 'ask-1',
    answers: [{ questionId: card.id, optionId: 'remember', roles: { '06 도면 모델': 'rhino' } }],
  });
  assert.equal(done.status, 201);
  assert.equal(done.data.remembered.length, 1);
  assert.equal(done.data.remembered[0].ok, true);
  assert.match(
    done.data.remembered[0].text,
    /^폴더 역할 기억 · 자료=02 자료 · 모델=06 도면 모델 · 도면=05 도면 · 레퍼런스=03 참고/,
  );
  assert.match(done.data.remembered[0].text, /보고서=반영할 때 묻기/);
  assert.match(done.next.body, /폴더 역할 기억/);
  assert.doesNotMatch(done.next.body, /workspace-schema-|remember/);
  const saved = JSON.parse(await f.manifestText());
  assert.equal(saved.server.root.toLowerCase(), f.server.toLowerCase());
  assert.deepEqual(saved.server.paths, {
    raw: '02 자료',
    rhino: '06 도면 모델',
    cad: '05 도면',
    references: '03 참고',
  });
  assert.deepEqual(saved.server.targets, {});
  assert.equal(saved.server.proposedAt, record.body.proposedAt);
  assert.ok(saved.server.confirmedAt);
  // The rest of the manifest is kept; the work folder's own role paths are untouched.
  assert.deepEqual(saved.paths, { ops: '01_운영', cad: '04_도면' });
  assert.deepEqual(saved.custom, { kept: true });
  // The card now shows what was stored; the folder no longer waits.
  const after = await get(
    f,
    `/projects/${f.project.id}/conversations/${f.conversation.id}/workspace-schema/${card.id}`,
  );
  assert.equal(after.data.answer.option, 'remember');
  assert.match(after.data.stored.text, /폴더 역할 기억/);
  assert.equal((await schemaPending(f.workspaceFolders, f.project.id)).pending, false);
  const pendingRoute = await get(f, `/projects/${f.project.id}/workspace/schema-pending`);
  assert.equal(pendingRoute.data.pending, false);
});

test('assumptions, [나중에], a changed card and a remote session store nothing', async (t) => {
  const f = await fixture(t);
  const before = await f.manifestText();
  // [권장값으로 진행]: an assumption, not a confirmation.
  const first = (await propose(f, 'ask-1')).question;
  const assumed = await answer(f, { requestId: 'ask-1', answers: [], recommended: true });
  assert.equal(assumed.status, 201);
  assert.deepEqual(
    assumed.data.remembered.map((r) => [r.ok, r.held]),
    [[false, 'recommended']],
  );
  assert.match(assumed.next.body, /폴더 역할을 기억하지 않았습니다/);
  assert.equal(await f.manifestText(), before);
  // [나중에]: nothing stored, nothing to report.
  await propose(f, 'ask-2');
  const second = f.conversations.store
    .ledger(f.conversation.id, { current: true })
    .filter((item) => item.kind === 'question')
    .at(-1).body;
  const later = await answer(f, {
    requestId: 'ask-2',
    answers: [{ questionId: second.id, optionId: 'later' }],
  });
  assert.equal(later.status, 201);
  assert.equal(later.data.remembered, undefined);
  assert.equal(await f.manifestText(), before);
  // A card whose words differ from the record (the AI changed a label): held.
  const handlers = conversationHandlers({ ...f.sources, requestId: 'ask-3' });
  const made = await handlers.workspace_schema_propose({});
  const changed = {
    ...made.question,
    options: made.question.options.map((o) =>
      o.id === 'remember' ? { ...o, label: '모두 기억' } : o,
    ),
  };
  f.conversations.addLedger(f.project.id, f.conversation.id, {
    kind: 'question',
    requestId: 'ask-3',
    body: changed,
  });
  const mismatch = await answer(f, {
    requestId: 'ask-3',
    answers: [{ questionId: changed.id, optionId: 'remember' }],
  });
  assert.deepEqual(
    mismatch.data.remembered.map((r) => [r.ok, r.held]),
    [[false, 'mismatch']],
  );
  // A remote session: the person's choice, but the manifest changes only on this PC.
  await propose(f, 'ask-4');
  const fourth = f.conversations.store
    .ledger(f.conversation.id, { current: true })
    .filter((item) => item.kind === 'question')
    .at(-1).body;
  const remote = await answer(
    f,
    { requestId: 'ask-4', answers: [{ questionId: fourth.id, optionId: 'remember' }] },
    { remote: true },
  );
  assert.equal(remote.data.remembered[0].ok, false);
  assert.equal(await f.manifestText(), before);
  assert.ok(first.id);
});

test('memory_set: only a place the person named, written to server.targets/paths with a record', async (t) => {
  const f = await fixture(t);
  const handlers = conversationHandlers(f.sources);
  // No memory yet: nothing to change.
  const none = await handlers.workspace_memory_set({ role: 'output', target: '05 보고서\\VIDE' });
  assert.equal(none.ok, false);
  f.words.push('앞으로 보고서는 05 보고서\\VIDE에 둬');
  const missing = await handlers.workspace_memory_set({
    role: 'output',
    target: '05 보고서\\VIDE',
  });
  assert.deepEqual([missing.ok, missing.error], [false, 'NO_SERVER_MEMORY']);
  // Confirm first through the card.
  const card = (await propose(f, 'ask-1')).question;
  await answer(f, { requestId: 'ask-1', answers: [{ questionId: card.id, optionId: 'remember' }] });
  // A place the person did not name is refused.
  const guessed = await handlers.workspace_memory_set({ role: 'output', target: '99 산출' });
  assert.deepEqual([guessed.ok, guessed.error], [false, 'NOT_NAMED']);
  const set = await handlers.workspace_memory_set({ role: 'output', target: '05 보고서\\VIDE' });
  assert.equal(set.ok, true);
  assert.equal(set.line, '기억 바뀜 · 보고서 → 05 보고서\\VIDE');
  const saved = JSON.parse(await f.manifestText());
  assert.deepEqual(saved.server.targets, { output: '05 보고서\\VIDE' });
  assert.equal(saved.server.paths.cad, '05 도면');
  const record = f.conversations.store
    .ledger(f.conversation.id, { current: true })
    .filter((item) => item.kind === 'result-ref')
    .at(-1);
  assert.deepEqual(
    [record.body.appAction, record.body.role, record.body.before, record.body.after],
    ['workspace-memory', 'output', null, '05 보고서\\VIDE'],
  );
  // A server path, given absolute under the remembered folder, is kept relative.
  f.words.push(`도면은 ${join(f.server, '05 도면', 'xref')}에 있어`);
  const moved = await handlers.workspace_memory_set({
    role: 'cad',
    serverPath: join(f.server, '05 도면', 'xref'),
  });
  assert.equal(moved.ok, true);
  assert.equal(JSON.parse(await f.manifestText()).server.paths.cad, join('05 도면', 'xref'));
  // Outside the remembered folder: refused.
  f.words.push('C:\\다른곳');
  const outside = await handlers.workspace_memory_set({ role: 'cad', serverPath: 'C:\\다른곳' });
  assert.deepEqual([outside.ok, outside.error], [false, 'OUTSIDE_WORKSPACE']);
  await assert.rejects(() => handlers.workspace_memory_set({ role: 'cad' }), /INVALID_INPUT/);
});

test('without a work folder: no card, the reason in words; pending stays false', async (t) => {
  const f = await fixture(t, { manifest: false });
  const handlers = conversationHandlers(f.sources);
  const result = await handlers.workspace_schema_propose({});
  assert.deepEqual([result.ok, result.error], [false, 'NO_WORKSPACE']);
  assert.match(result.message, /작업 폴더가 없어/);
  assert.equal((await schemaPending(f.workspaceFolders, f.project.id)).pending, false);
});

test('a blocked folder: empty or gone gives the state, no card and no record', async (t) => {
  const f = await fixture(t);
  await rm(f.server, { recursive: true, force: true });
  const handlers = conversationHandlers(f.sources);
  const gone = await handlers.workspace_schema_propose({});
  assert.equal(gone.status, 'unreachable');
  assert.equal(gone.question, undefined);
  assert.match(gone.message, /닿지 않습니다/);
  await mkdir(f.server, { recursive: true });
  const empty = await handlers.workspace_schema_propose({ folder: f.server });
  assert.equal(empty.status, 'empty');
  assert.match(empty.message, /빈 폴더/);
  assert.equal(f.conversations.store.ledger(f.conversation.id, { current: true }).length, 0);
  // A folder that is not one of the project's folders is not read.
  const other = await handlers.workspace_schema_propose({ folder: tmpdir() });
  assert.deepEqual([other.ok, other.error], [false, 'NOT_FOUND']);
});
