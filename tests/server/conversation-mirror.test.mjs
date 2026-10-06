// PLAN-36 (ADR-037 4): the PC side of the shared conversation records. Only hostless requests go
// up (modeling ones stay), incrementally and in batches, resuming after a restart; a hidden
// request leaves the site; the switch's removal is retried until the site answers; the other
// members' records come back as a local copy the AI reads and the read-only view shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { ConversationMirror } from '../../src/server/conversation-mirror.ts';
import { OfflineView } from '../../src/server/offline-view.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { chunkText, shareableRequest } from '../../src/contracts/conversation-mirror.ts';

const fakeRemote = () => {
  const calls = [];
  const remote = {
    hostId: 'host-a',
    fail: () => false,
    reply: undefined,
    async deviceFetch(path, method = 'GET', data) {
      calls.push({ path, method, data: data && JSON.parse(JSON.stringify(data)) });
      if (remote.fail(method, calls)) throw new TypeError('fetch failed');
      if (method === 'GET') return Response.json(remote.reply);
      return Response.json({ stored: data?.requests?.length ?? 0 });
    },
  };
  return { remote, calls };
};

test('shareable requests are the hostless ones; text is chunked without loss', () => {
  assert.equal(shareableRequest({ hostUse: 'none' }, { text: 'a' }), true);
  assert.equal(shareableRequest({ host: 'rhino' }, {}), false, 'no hostUse: a modeling request');
  assert.equal(shareableRequest({ hostUse: 'read' }, {}), false);
  assert.equal(shareableRequest({ hostUse: 'none', linkId: 'l' }, {}), false);
  assert.equal(shareableRequest({ hostUse: 'none', jig: { kind: 'x' } }, {}), false);
  assert.equal(shareableRequest({ hostUse: 'none' }, { executions: [{}] }), false);
  assert.equal(shareableRequest({ hostUse: 'none' }, { sourceDocument: { name: 'a' } }), false);
  const long = '가'.repeat(250_001) + '😀' + 'b'.repeat(10);
  const parts = chunkText(long, 100_000);
  assert.equal(parts.join(''), long);
  assert.ok(parts.every((part) => part.length <= 100_000));
  assert.deepEqual(chunkText(''), ['']);
  // A surrogate pair at the boundary stays in one piece.
  const pair = 'a'.repeat(9) + '😀' + 'b';
  assert.deepEqual(chunkText(pair, 10), ['a'.repeat(9), '😀b']);
});

test('the PC uploads hostless conversations incrementally, resumes, removes, and copies others', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-mirror-'));
  const app = await startServer({ filename: join(directory, 'test.sqlite') });
  try {
    const store = app.store;
    const project = store.createProject('Tower');
    const db = store.db(project.id);
    const now = new Date('2026-10-06T09:00:00Z').toISOString();
    db.prepare(
      `INSERT INTO conversations(id,projectId,kind,title,provider,model,state,createdAt,updatedAt)
       VALUES(?,?,?,?,?,?,'open',?,?)`,
    ).run('c-1', project.id, 'session', '구조 협의 정리', 'claude-cli', 'opus', now, now);
    let order = 0;
    const add = (id, input, result, state = 'succeeded') =>
      db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
        id,
        project.id,
        JSON.stringify({
          id,
          provider: 'claude-cli',
          permission: 'candidate',
          pins: [],
          sketches: [],
          files: [],
          ...input,
        }),
        state,
        JSON.stringify(result),
        new Date(Date.parse(now) + ++order * 1000).toISOString(),
      );
    const longAnswer = '긴 답 '.repeat(60_000); // 240k chars: several chunks on the site
    add(
      'r-1',
      {
        body: '어제 회의 메모에서 할 일 뽑아줘',
        hostUse: 'none',
        conversationId: 'c-1',
        files: [{ name: '회의록.pdf', attachmentId: 'a1' }],
      },
      {
        text: '할 일 3개를 넣었습니다.',
        activity: [
          { at: now, kind: 'thinking', text: '메모 읽는 중', detail: '생각한 내용' },
          { at: now, kind: 'query', text: '파일 검색', detail: '{"vertices":[1,2,3]}' },
          { at: now, kind: 'execute', text: 'Bash', detail: 'Get-Content 회의록.txt' },
        ],
      },
    );
    add(
      'r-2',
      { body: '기둥 옮겨줘', host: 'rhino', conversationId: 'c-1' },
      {
        text: '옮겼습니다',
        executions: [{ executionId: 'e', label: 'x', body: 'Move()' }],
        scene: [{ id: 'o', vertices: [0, 0, 0] }],
      },
    );
    add('r-3', { body: '긴 질문', hostUse: 'none' }, { text: longAnswer });
    add('r-4', { body: '이 파일 설명', hostUse: 'none', linkId: 'link-1' }, { text: 'no' });
    add('r-5', { body: '지울 요청', hostUse: 'none' }, { text: '곧 숨김' });

    const { remote, calls } = fakeRemote();
    const mirror = new ConversationMirror({
      directory,
      store,
      links: new DocumentLinks(store),
      remote,
      batchBytes: 50_000,
    });
    // The second batch fails: what the first batch sent is recorded, the rest waits.
    remote.fail = (method, list) =>
      method === 'PUT' && list.filter((call) => call.method === 'PUT').length === 2;
    assert.equal(await mirror.upload(project.id, true), 'SITE_UNREACHABLE');
    const firstPut = calls[0].data;
    assert.deepEqual(
      firstPut.requests.map((request) => request.id),
      ['r-1'],
      'a batch ends before ~50 KB; modeling (r-2) and linked (r-4) requests never go',
    );
    const doc = JSON.parse(firstPut.requests[0].doc);
    assert.equal(doc.body, '어제 회의 메모에서 할 일 뽑아줘');
    assert.equal(doc.answer, '할 일 3개를 넣었습니다.');
    assert.deepEqual(doc.files, ['회의록.pdf']);
    assert.equal(doc.activity.length, 3);
    assert.equal(doc.activity[0].detail, '생각한 내용');
    assert.equal(doc.activity[1].detail, undefined, 'query details (model data) stay here');
    assert.equal(doc.activity[2].detail, 'Get-Content 회의록.txt');
    assert.ok(!JSON.stringify(firstPut).includes('vertices'), 'no geometry leaves the PC');
    assert.deepEqual(
      firstPut.conversations.map((row) => [row.id, row.title, row.model]),
      [
        ['c-1', '구조 협의 정리', 'opus'],
        ['default', '기본 대화', null],
      ],
    );

    // Restart: a new instance reads the record and sends only what is left, in full.
    calls.length = 0;
    remote.fail = () => false;
    const restarted = new ConversationMirror({
      directory,
      store,
      links: new DocumentLinks(store),
      remote,
      batchBytes: 50_000,
    });
    assert.equal(await restarted.upload(project.id, true), undefined);
    const sent = calls.flatMap((call) => call.data.requests.map((request) => request.id));
    assert.deepEqual(sent.sort(), ['r-3', 'r-5']);
    const long = calls
      .flatMap((call) => call.data.requests)
      .find((request) => request.id === 'r-3');
    assert.equal(JSON.parse(long.doc).answer, longAnswer, 'the long answer goes in full');
    assert.ok(calls.every((call) => call.data.requests.every((r) => r.conversationId)));

    // Nothing changed: nothing is sent. A changed request is sent again, alone.
    calls.length = 0;
    assert.equal(await restarted.upload(project.id, true), undefined);
    assert.equal(calls.length, 0);
    db.prepare("UPDATE workspace_requests SET state='failed' WHERE id='r-1'").run();
    db.prepare("INSERT INTO hidden_requests(projectId,requestId,hiddenAt) VALUES(?,'r-5',?)").run(
      project.id,
      now,
    );
    await restarted.upload(project.id, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].data.requests.map((request) => [request.id, request.state]),
      [['r-1', 'failed']],
    );
    assert.deepEqual(calls[0].data.removed, ['r-5'], 'a hidden request leaves the site');
    assert.equal((await restarted.status(project.id)).shared, 2);

    // The switch off: removal waits while the site is unreachable, then goes on the next beat.
    calls.length = 0;
    remote.fail = () => true;
    await restarted.remove(project.id);
    assert.equal((await restarted.status(project.id)).removing, true);
    remote.fail = () => false;
    await restarted.pendingRemovals();
    assert.deepEqual(
      calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
      [`/projects/${project.id}/conversations`, `/projects/${project.id}/conversations`],
    );
    assert.deepEqual(await restarted.status(project.id), {
      shared: 0,
      at: null,
      error: null,
      removing: false,
    });

    // Other members' records: a local copy for the AI and the read-only view.
    const conversation = {
      id: 'c-9',
      title: '자재 검토',
      kind: 'session',
      provider: 'codex-cli',
      model: 'gpt',
      createdAt: now,
      updatedAt: now,
      originHost: 'host-b-123456',
      originName: 'bob',
      originPc: 'Bob PC',
      requests: 1,
      lastAt: now,
    };
    const otherDoc = {
      body: '마감재 단가 비교해줘',
      answer: '석재가 가장 비쌉니다.',
      activity: [{ at: now, kind: 'execute', text: 'Bash', detail: 'echo 단가' }],
      executions: [],
      files: ['단가표.xlsx'],
    };
    remote.reply = {
      at: 1000,
      conversations: [conversation],
      requests: [
        {
          id: 'o-1',
          conversationId: 'c-9',
          originHost: 'host-b-123456',
          state: 'succeeded',
          createdAt: now,
          endedAt: null,
          revision: 1,
          files: ['단가표.xlsx'],
          preview: '마감재',
          storedAt: 900,
          ...otherDoc,
        },
      ],
    };
    const listed = await restarted.list(project.id);
    assert.equal(listed.online, true);
    assert.equal(listed.conversations[0].originName, 'bob');
    const folder = join(directory, 'projects', project.id, 'history');
    const markdown = await readFile(join(folder, 'host-b-1-c-9.md'), 'utf8');
    assert.match(markdown, /마감재 단가 비교해줘/);
    assert.match(markdown, /석재가 가장 비쌉니다/);
    assert.match(markdown, /echo 단가/);
    assert.match(await readFile(join(folder, 'README.md'), 'utf8'), /bob · Bob PC/);
    // The next read asks only for what changed; an unchanged document stays from the copy.
    const {
      body: _b,
      answer: _a,
      activity: _ac,
      executions: _e,
      ...metaOnly
    } = remote.reply.requests[0];
    remote.reply = { ...remote.reply, at: 2000, requests: [metaOnly] };
    await restarted.list(project.id);
    assert.match(calls.at(-1).path, /\?since=1000$/);
    const thread = await restarted.thread(project.id, 'host-b-123456', 'c-9');
    assert.equal(thread.requests[0].answer, '석재가 가장 비쌉니다.');
    // The engine's route serves the view; offline, the last copy answers.
    remote.fail = () => true;
    const offline = await restarted.list(project.id);
    assert.equal(offline.online, false);
    assert.equal(offline.conversations.length, 1);
    // Removed on the site: the copy drops it.
    remote.fail = () => false;
    remote.reply = { at: 3000, conversations: [], requests: [] };
    await restarted.list(project.id);
    assert.deepEqual(
      (await readdir(folder)).filter((name) => name.endsWith('.md')),
      ['README.md'],
    );
    assert.ok(existsSync(join(folder, '.data', 'mirror.json')));
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('turning the 할 일·대화 기록 switch off removes the conversation text too', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-mirror-switch-'));
  const app = await startServer({ filename: join(directory, 'test.sqlite') });
  try {
    const store = app.store;
    const project = store.createProject('Tower');
    const { remote, calls } = fakeRemote();
    const links = new DocumentLinks(store);
    const mirror = new ConversationMirror({ directory, store, links, remote });
    const offline = new OfflineView({
      directory,
      store,
      workspace: new Workspace(store),
      links,
      remote: {
        hostId: 'host-a',
        uploadSnapshot: async () => undefined,
        deleteSnapshot: async () => true,
        uploadSummary: async () => undefined,
        deleteSummary: async () => true,
      },
      mirror,
    });
    store
      .db(project.id)
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        'q-1',
        project.id,
        JSON.stringify({ id: 'q-1', body: '질문', hostUse: 'none', files: [] }),
        'succeeded',
        JSON.stringify({ text: '답' }),
        new Date().toISOString(),
      );
    await offline.tick(true);
    assert.equal(calls.filter((call) => call.method === 'PUT').length, 1);
    assert.equal((await offline.status(project.id)).conversations.shared, 1);
    await offline.setSummary(project.id, false);
    assert.equal(calls.at(-1).method, 'DELETE');
    calls.length = 0;
    await offline.tick(true);
    assert.equal(calls.length, 0, 'nothing goes up while the switch is off');
    await offline.close();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
