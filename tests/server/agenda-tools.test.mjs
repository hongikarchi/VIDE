// 대시보드의 할 일 (SPEC-01.14 6, PLAN-26 T-098): the AI tools agenda_list / agenda_add /
// agenda_set as T1 writes recorded in the ledger, and [되돌리기] after a real conversation turn.
// Synthetic project and provider only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../../src/core/store.ts';
import { Agenda } from '../../src/core/agenda.ts';
import { conversationHandlers, PLAN_MODE_TOOLS } from '../../src/server/agent-tools.ts';
import { agentConnection, agentToolNames, instructionFor } from '../../src/ai/agent-connection.ts';
import { startServer } from '../../src/server/server.ts';

async function storeOf(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-agenda-'));
  const store = new Store(join(directory, 'data.sqlite'));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

test('agenda_add and agenda_set are T1 writes in the ledger; revert takes back only what is unchanged', async (t) => {
  const store = await storeOf(t);
  const agenda = new Agenda(store);
  const project = store.createProject('도구');
  const ledger = [];
  const handlers = conversationHandlers({
    projectId: project.id,
    conversationId: 'c1',
    openInstanceId: null,
    requestId: 'r1',
    workspace: { list: () => [], get: () => undefined },
    agenda,
    ledger: (item) => {
      ledger.push(item);
      return { id: `l${ledger.length}` };
    },
  });
  assert.ok(['agenda_list', 'agenda_add', 'agenda_set'].every((name) => handlers[name]));
  assert.ok(agentToolNames.includes('agenda_add'));
  // Plan mode reads only.
  assert.ok(PLAN_MODE_TOOLS.has('agenda_list'));
  assert.ok(!PLAN_MODE_TOOLS.has('agenda_add') && !PLAN_MODE_TOOLS.has('agenda_set'));
  // A host (modeling) turn's rules name them beside query/execute.
  const hostRules = instructionFor({
    url: 'http://127.0.0.1:1/mcp',
    token: 't',
    tools: ['query', 'execute', 'agenda_list', 'agenda_add', 'agenda_set'],
  });
  assert.match(hostRules, /Use query to observe/);
  assert.match(hostRules, /agenda_add and agenda_set/);

  const kept = agenda.add(project.id, { text: '기존 할 일' });
  const added = await handlers.agenda_add({
    items: [{ text: '구조 회의', date: '2026-10-02', time: '15:00' }, { text: '회의록 정리' }],
  });
  assert.deepEqual(
    added.added.map((item) => [item.text, item.date, item.time, item.by]),
    [
      ['구조 회의', '2026-10-02', '15:00', 'ai'],
      ['회의록 정리', null, null, 'ai'],
    ],
  );
  assert.equal(ledger[0].kind, 'result-ref');
  assert.equal(ledger[0].requestId, 'r1');
  assert.equal(ledger[0].body.appAction, 'agenda');
  assert.deepEqual(
    ledger[0].body.changes.map((change) => change.op),
    ['add', 'add'],
  );
  const listed = await handlers.agenda_list({});
  assert.equal(listed.total, 3);
  assert.match(listed.today, /^\d{4}-\d{2}-\d{2}$/);

  const set = await handlers.agenda_set({
    items: [{ id: kept.id, done: true, text: '기존 할 일 끝' }],
  });
  assert.deepEqual([set.changed[0].done, set.changed[0].text], [true, '기존 할 일 끝']);
  assert.equal((await handlers.agenda_list({})).total, 2);
  assert.equal((await handlers.agenda_list({ done: true })).total, 3);

  // [되돌리기] of the add: both added items go; the set is taken back to the earlier text.
  const one = agenda.revert(project.id, ledger[0].body.changes);
  assert.deepEqual([one.reverted, one.skipped], [2, 0]);
  const two = agenda.revert(project.id, ledger[1].body.changes);
  assert.deepEqual([two.reverted, two.skipped], [1, 0]);
  const back = agenda.get(project.id, kept.id);
  assert.deepEqual([back.text, back.done], ['기존 할 일', false]);
  // A set the user changed again afterwards is left alone.
  await handlers.agenda_set({ items: [{ id: kept.id, text: 'AI가 바꿈' }] });
  const now = agenda.get(project.id, kept.id);
  agenda.set(project.id, kept.id, { revision: now.revision, text: '사용자가 다시 바꿈' });
  const three = agenda.revert(project.id, ledger[2].body.changes);
  assert.deepEqual([three.reverted, three.skipped], [0, 1]);
  assert.equal(agenda.get(project.id, kept.id).text, '사용자가 다시 바꿈');

  // Without a ledger (no undo to offer) only the read tool is given.
  const bare = conversationHandlers({
    projectId: project.id,
    conversationId: 'c1',
    openInstanceId: null,
    workspace: { list: () => [], get: () => undefined },
    agenda,
  });
  assert.ok(bare.agenda_list && !bare.agenda_add && !bare.agenda_set);
});

test('[되돌리기] of an add leaves an item the user changed or finished since (SPEC-01.14 6)', async (t) => {
  const store = await storeOf(t);
  const agenda = new Agenda(store);
  const project = store.createProject('되돌리기');
  const ledger = [];
  const handlers = conversationHandlers({
    projectId: project.id,
    conversationId: 'c1',
    openInstanceId: null,
    requestId: 'r1',
    workspace: { list: () => [], get: () => undefined },
    agenda,
    ledger: (item) => {
      ledger.push(item);
      return { id: `l${ledger.length}` };
    },
  });
  const { added } = await handlers.agenda_add({
    items: [{ text: '구조 회의', date: '2026-10-02' }, { text: '회의록 정리' }],
  });
  // The add records the revision it left, like a set.
  assert.deepEqual(
    ledger[0].body.changes.map((change) => change.revision),
    [1, 1],
  );
  // On another screen the user edits and finishes the first one.
  agenda.set(project.id, added[0].id, { revision: 1, text: '사용자가 고친 내용', done: true });
  const undo = agenda.revert(project.id, ledger[0].body.changes);
  assert.deepEqual([undo.reverted, undo.skipped], [1, 1]);
  assert.deepEqual(
    agenda.list(project.id).map((item) => [item.text, item.done]),
    [['사용자가 고친 내용', true]],
  );
  // One turn adds an item and then changes it: undoing the turn (both writes) removes it.
  const turn = ledger.length;
  const { added: made } = await handlers.agenda_add({ items: [{ text: '도면 제출' }] });
  await handlers.agenda_set({ items: [{ id: made[0].id, date: '2026-10-09' }] });
  const both = agenda.revert(
    project.id,
    ledger.slice(turn).flatMap((item) => item.body.changes),
  );
  assert.deepEqual([both.reverted, both.skipped], [2, 0]);
  assert.ok(!agenda.list(project.id).some((item) => item.id === made[0].id));
});

// The 기본 대화 runs as a host (modeling) turn: it gets the agenda tools too, beside the host's.
for (const [name, turnInput] of [
  ['a conversation turn without the host', { hostUse: 'none' }],
  ['a 기본 대화 host turn', {}],
])
  test(`${name} adds 할 일 with agenda_add; [되돌리기] removes them`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'vide-agenda-turn-'));
    let given = [],
      rules = '';
    const app = await startServer({
      filename: join(directory, 'store.sqlite'),
      host: { status: async () => ({ available: true }) },
      providerFactory: (options) => ({
        run: async () => {
          const agent = agentConnection(options.agent);
          given = agent.tools;
          rules = instructionFor(agent);
          const client = new Client({ name: 'synthetic-agent', version: '1.0.0' });
          await client.connect(
            new StreamableHTTPClientTransport(new URL(agent.url), {
              requestInit: { headers: { Authorization: `Bearer ${agent.token}` } },
            }),
          );
          const call = async (name, args) => {
            const out = await client.callTool({ name, arguments: args });
            return JSON.parse(out.content[0].text);
          };
          await call('agenda_add', {
            items: [{ text: '구조 회의', date: '2026-10-02', time: '15:00' }],
          });
          await client.close();
          return { text: JSON.stringify({ message: '할 일 1개를 넣었습니다.', operations: [] }) };
        },
        status: async () => ({ available: true }),
      }),
    });
    t.after(async () => {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    });
    const login = await fetch(app.origin + '/api/v1/session', {
      method: 'POST',
      headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
    });
    const headers = {
      Origin: app.origin,
      'Content-Type': 'application/json',
      Cookie: login.headers.get('set-cookie').split(';')[0],
    };
    const api = async (path, method = 'GET', data) => {
      const response = await fetch(app.origin + '/api/v1' + path, {
        method,
        headers,
        body: data ? JSON.stringify(data) : undefined,
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    };
    const project = (await api('/projects', 'POST', { name: '할 일' })).json;
    const base = `/projects/${project.id}/agenda`;
    // A conversation turn: the AI adds one 할 일, recorded in the conversation's ledger.
    const conversation = (
      await api(`/projects/${project.id}/conversations`, 'POST', {
        kind: 'general',
        title: '일정',
        provider: 'codex-cli',
      })
    ).json;
    const sent = await api(`/projects/${project.id}/requests`, 'POST', {
      id: 'turn-a',
      body: '내일 3시 구조 회의 넣어줘',
      provider: 'codex-cli',
      // Auto mode: a plan-mode turn gets agenda_list only.
      mode: 'auto',
      permission: 'review',
      pins: [],
      sketches: [],
      files: [],
      conversationId: conversation.id,
      ...turnInput,
    });
    assert.ok(sent.status < 300, JSON.stringify(sent.json));
    let done;
    for (let i = 0; i < 400 && !done; i++) {
      const row = (await api(`/projects/${project.id}/requests/turn-a`)).json;
      if (row.state !== 'running' && row.state !== 'queued') done = row;
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(done?.state, 'succeeded', JSON.stringify(done?.result));
    assert.ok(['agenda_list', 'agenda_add', 'agenda_set'].every((tool) => given.includes(tool)));
    assert.match(rules, /agenda_add and agenda_set/);
    const items = (await api(base)).json.items;
    assert.deepEqual(
      items.map((item) => [item.text, item.date, item.time, item.source]),
      [['구조 회의', '2026-10-02', '15:00', 'ai']],
    );
    const detail = (await api(`/projects/${project.id}/conversations/${conversation.id}`)).json;
    const record = detail.ledger.find((item) => item.body?.appAction === 'agenda');
    assert.equal(record.requestId, 'turn-a');
    const undo = await api(`${base}/undo`, 'POST', {
      conversationId: conversation.id,
      ledgerId: record.id,
    });
    assert.deepEqual([undo.status, undo.json.reverted, undo.json.items.length], [200, 1, 0]);
    // Taken back once; the record is superseded by the undo and a second press is refused.
    const again = await api(`${base}/undo`, 'POST', {
      conversationId: conversation.id,
      ledgerId: record.id,
    });
    assert.deepEqual([again.status, again.json.code], [409, 'AGENDA_UNDONE']);
    const after = (await api(`/projects/${project.id}/conversations/${conversation.id}`)).json;
    assert.ok(!after.ledger.some((item) => item.id === record.id));
    assert.ok(after.ledger.some((item) => item.body?.appAction === 'agenda-undo'));
  });
