import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../../src/core/store.ts';
import { ProjectFolders } from '../../src/core/project-folders.ts';
import { FileAccess, checkFolder, deniedPath, turnGrants } from '../../src/server/project-files.ts';
import { AgentTools, PLAN_MODE_TOOLS, fileHandlers } from '../../src/server/agent-tools.ts';
import { agentConnection, agentToolNames, instructionFor } from '../../src/ai/agent-connection.ts';
import { Execution, FILE_PERMISSION_CARD } from '../../src/server/execution.ts';
import { startServer } from '../../src/server/server.ts';

// Project folders and the AI's file tools (SPEC-01.13, ARCH-01 §3 「프로젝트 폴더와 파일 읽기
// 도구」, PLAN-26 T-091). Synthetic files in a temporary folder only.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
async function tree(t) {
  const root = await mkdtemp(join(tmpdir(), 'vide-project-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, '로컬 2601-합성 프로젝트');
  const outside = join(root, 'outside');
  const data = join(root, 'data');
  const other = join(root, 'other');
  for (const folder of [
    project,
    join(project, '도면'),
    outside,
    join(outside, 'more'),
    data,
    other,
  ])
    await mkdir(folder, { recursive: true });
  await writeFile(join(project, 'notes.txt'), '첫 줄\n둘째 줄\n');
  await writeFile(join(project, '도면', 'plan.png'), PNG);
  await writeFile(join(project, 'model.3dm'), '3D Geometry File Format  ');
  await writeFile(join(project, '.env'), 'KEY=secret');
  await writeFile(join(project, 'id_rsa'), 'private');
  await writeFile(join(outside, 'a.txt'), '밖 A');
  await writeFile(join(outside, 'b.txt'), '밖 B');
  await writeFile(join(outside, 'more', 'c.txt'), '밖 C');
  await writeFile(join(data, 'store.sqlite'), 'db');
  await writeFile(join(other, 'd.txt'), '다른 D');
  // A junction inside the project folder that leads out of it.
  await symlink(outside, join(project, 'escape'), 'junction');
  return { root, project, outside, data, other };
}
function db(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.ensureProject('p1', '합성');
  return new ProjectFolders(store.db);
}

test('a project folder is an existing folder that is not a drive root, VIDE data or a key folder', async (t) => {
  const { project, outside, data, root } = await tree(t);
  const context = { dataDirectory: data, home: root };
  assert.equal(await checkFolder(project, context), project);
  // Quotes from Explorer's "경로로 복사" are accepted.
  assert.equal(await checkFolder(`"${outside}"`, context), outside);
  await assert.rejects(checkFolder(join(root, 'none'), context), { code: 'FOLDER_NOT_FOUND' });
  await assert.rejects(checkFolder(join(project, 'notes.txt'), context), {
    code: 'FOLDER_NOT_FOUND',
  });
  await assert.rejects(checkFolder(parse(project).root, context), { code: 'FOLDER_NOT_ALLOWED' });
  await assert.rejects(checkFolder(data, context), { code: 'FOLDER_NOT_ALLOWED' });
  await mkdir(join(root, '.ssh'));
  await assert.rejects(checkFolder(join(root, '.ssh'), context), { code: 'FOLDER_NOT_ALLOWED' });
  await assert.rejects(checkFolder('relative\\folder', context), { code: 'INVALID_INPUT' });
  await assert.rejects(checkFolder('\\\\?\\C:\\x', context), { code: 'INVALID_INPUT' });
  // The deny-list: data, key folders anywhere, secret names and extensions.
  for (const path of [
    join(data, 'store.sqlite'),
    join(root, '.claude', 'x.json'),
    join(project, 'sub', '.ssh', 'config'),
    join(project, '.env.local'),
    join(project, 'server.pem'),
    join(project, '.git-credentials'),
  ])
    assert.equal(deniedPath(path, context), true, path);
  for (const path of [join(project, 'notes.txt'), join(project, 'id_rsa.pub'), join(root, 'env')])
    assert.equal(deniedPath(path, context), false, path);
  // The store keeps one row per path; a project row wins over a read row.
  const folders = db(t);
  folders.add('p1', outside, 'read');
  folders.add('p1', project, 'project');
  folders.add('p1', outside, 'project');
  folders.add('p1', project, 'read');
  assert.deepEqual(
    folders.list('p1').map((f) => [f.path, f.kind]),
    [
      [outside, 'project'],
      [project, 'project'],
    ],
  );
  assert.deepEqual(folders.remove('p1', outside.toUpperCase()).length, 1);
});

test('inside the folders files are read at once: lists page, text pages, images; no question', async (t) => {
  const { project, data, root } = await tree(t);
  const folders = db(t);
  folders.add('p1', project, 'project');
  const asked = [];
  const used = [];
  const access = new FileAccess({
    folders,
    projectId: 'p1',
    context: { dataDirectory: data, home: root },
    ask: async (folder) => {
      asked.push(folder);
      return 'deny';
    },
    onUse: (text) => used.push(text),
  });
  const roots = await access.list({});
  assert.deepEqual(roots.folders, [{ path: project, kind: 'project', exists: true }]);
  const listed = await access.list({ path: project });
  // Folders first; secret files are never listed.
  assert.deepEqual(
    listed.entries.map((e) => [e.name, e.kind]),
    [
      ['도면', 'dir'],
      ['escape', 'dir'],
      ['model.3dm', 'file'],
      ['notes.txt', 'file'],
    ],
  );
  const page = await access.list({ path: project, limit: 1, offset: 1 });
  assert.deepEqual([page.entries[0].name, page.nextOffset, page.total], ['escape', 2, 4]);
  assert.deepEqual(
    (await access.list({ path: project, pattern: '*.TXT' })).entries.map((e) => e.name),
    ['notes.txt'],
  );
  // Relative paths are under the first project folder; text comes in byte pages.
  const first = await access.read({ path: 'notes.txt', limit: 8 });
  assert.deepEqual([first.text, first.nextOffset], ['첫 줄\n', 8]);
  const rest = await access.read({ path: join(project, 'notes.txt'), offset: 8 });
  assert.deepEqual([rest.text, rest.nextOffset], ['둘째 줄\n', null]);
  assert.match((await access.read({ path: 'model.3dm' })).note, /Rhino model file/);
  // Through the tool: an image comes back as image content.
  const tools = new AgentTools({ origin: 'http://127.0.0.1:47999' });
  const scope = tools.issue({
    targetRef: 'files:t',
    isCurrent: () => true,
    handlers: fileHandlers(access),
  });
  const image = await tools.call(scope.token, 'file_read', { path: join('도면', 'plan.png') });
  assert.deepEqual(
    [image.content[0].type, image.content[0].mimeType, JSON.parse(image.content[1].text).name],
    ['image', 'image/png', 'plan.png'],
  );
  const missing = await tools.call(scope.token, 'file_read', { path: 'none.txt' });
  assert.deepEqual(JSON.parse(missing.content[0].text), { code: 'FILE_NOT_FOUND' });
  // Never: a secret file inside the folder, or a junction that leads out (no question either).
  for (const path of ['.env', 'id_rsa', join('escape', 'a.txt')]) {
    const refused = await tools.call(scope.token, 'file_read', { path });
    assert.deepEqual(JSON.parse(refused.content[0].text), { code: 'FILE_FORBIDDEN' }, path);
  }
  assert.deepEqual(asked, []);
  assert.ok(used.includes(`파일 읽기 · ${join(project, 'notes.txt')}`));
  assert.ok(used.includes(`파일 읽기 거절 · ${join(project, '.env')}`));
  // Registry: both tools exist, Plan mode keeps them, and the rules say how to use them.
  assert.ok(agentToolNames.includes('file_read') && agentToolNames.includes('file_list'));
  assert.ok(PLAN_MODE_TOOLS.has('file_read') && PLAN_MODE_TOOLS.has('file_list'));
  const rules = instructionFor({ url: 'x', token: 'x', tools: ['file_list', 'file_read'] });
  assert.match(rules, /file_list\(\) names this project's folders/);
  assert.match(rules, /FILE_ACCESS_DENIED do not ask again/);
});

test('file_read shows images up to 1 MB each and 16 MB per turn; a large image is never loaded', async (t) => {
  const { project, data, root } = await tree(t);
  const folders = db(t);
  folders.add('p1', project, 'project');
  const photos = join(project, '레퍼런스');
  await mkdir(photos);
  // Synthetic JPEGs (the type is sniffed from the first bytes): 20 of 0.9 MB and 6 of 25 MB.
  const jpeg = (size) =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, 7)]);
  for (let i = 0; i < 20; i++) await writeFile(join(photos, `small-${i}.jpg`), jpeg(900_000));
  for (let i = 0; i < 6; i++) await writeFile(join(photos, `large-${i}.jpg`), jpeg(25_000_000));
  const access = new FileAccess({
    folders,
    projectId: 'p1',
    context: { dataDirectory: data, home: root },
    ask: async () => 'deny',
  });
  const tools = new AgentTools({ origin: 'http://127.0.0.1:47999' });
  const scope = tools.issue({
    targetRef: 'files:t',
    isCurrent: () => true,
    maxCalls: 100,
    handlers: fileHandlers(access),
  });
  const read = (name) => tools.call(scope.token, 'file_read', { path: join('레퍼런스', name) });
  globalThis.gc?.();
  const before = process.memoryUsage();
  for (let i = 0; i < 6; i++) {
    const large = await read(`large-${i}.jpg`);
    assert.equal(large.content.length, 1);
    assert.match(JSON.parse(large.content[0].text).note, /larger than 1000000 bytes/);
  }
  // Six 25 MB files cost what their 64 KB heads cost, not 150 MB.
  const grown = process.memoryUsage().arrayBuffers - before.arrayBuffers;
  assert.ok(grown < 20_000_000, `array buffers grew ${grown} bytes`);
  const shown = [];
  for (let i = 0; i < 20; i++) shown.push((await read(`small-${i}.jpg`)).content[0].type);
  // 17 × 0.9 MB fit in 16 MB; the rest come back as a note the model can act on.
  assert.deepEqual([shown.filter((type) => type === 'image').length, shown.at(-1)], [17, 'text']);
  const over = await read('small-0.jpg');
  assert.match(JSON.parse(over.content[0].text).note, /already been shown its 16 MB of images/);
});

test('outside the folders: the question, and once / always / deny each as the user answered', async (t) => {
  const { project, outside, data, root } = await tree(t);
  const folders = db(t);
  folders.add('p1', project, 'project');
  const answers = ['once', 'deny', 'always'];
  const asked = [];
  const grants = turnGrants();
  const access = new FileAccess({
    folders,
    projectId: 'p1',
    context: { dataDirectory: data, home: root },
    grants,
    ask: async (folder, path) => {
      asked.push([folder, path]);
      return answers.shift();
    },
  });
  // once: this folder for the rest of the request, without asking again.
  assert.equal((await access.read({ path: join(outside, 'a.txt') })).text, '밖 A');
  assert.equal((await access.read({ path: join(outside, 'b.txt') })).text, '밖 B');
  assert.deepEqual(asked, [[outside, join(outside, 'a.txt')]]);
  assert.deepEqual(grants.allowed, [outside]);
  // A new request (new grants) asks again; deny refuses and is not asked again in that request.
  const second = new FileAccess({
    folders,
    projectId: 'p1',
    context: { dataDirectory: data, home: root },
    ask: async (folder, path) => {
      asked.push([folder, path]);
      return answers.shift();
    },
  });
  await assert.rejects(second.read({ path: join(outside, 'a.txt') }), {
    code: 'FILE_ACCESS_DENIED',
  });
  await assert.rejects(second.list({ path: join(outside, 'more') }), {
    code: 'FILE_ACCESS_DENIED',
  });
  assert.equal(asked.length, 2);
  // always: the folder becomes a read folder of the project (a list asks for the folder itself).
  const third = new FileAccess({
    folders,
    projectId: 'p1',
    context: { dataDirectory: data, home: root },
    ask: async (folder, path) => {
      asked.push([folder, path]);
      return answers.shift();
    },
  });
  const more = await third.list({ path: join(outside, 'more') });
  assert.deepEqual(asked.at(-1), [join(outside, 'more'), join(outside, 'more')]);
  assert.deepEqual(
    more.entries.map((e) => e.name),
    ['c.txt'],
  );
  assert.deepEqual(
    folders.list('p1').map((f) => [f.path, f.kind]),
    [
      [project, 'project'],
      [join(outside, 'more'), 'read'],
    ],
  );
  // Without a question (no card can be shown) a path outside is refused; a read folder is read.
  const silent = new FileAccess({
    folders,
    projectId: 'p1',
    context: { dataDirectory: data, home: root },
  });
  await assert.rejects(silent.read({ path: join(outside, 'a.txt') }), {
    code: 'FILE_ACCESS_DENIED',
  });
  assert.equal((await silent.read({ path: join(outside, 'more', 'c.txt') })).text, '밖 C');
  // VIDE's data folder is never read, even when asked.
  await assert.rejects(silent.read({ path: join(data, 'store.sqlite') }), {
    code: 'FILE_FORBIDDEN',
  });
});

test('the engine asks on the request cards: answers, a remote "always" is once, no answer refuses', async () => {
  const states = [];
  let current = { state: 'running', result: { phase: 'model', hostExecuted: false } };
  const workspace = {
    get: () => current,
    update: (_p, _id, state, result) => {
      current = { state, result };
      states.push(result.phase);
      return current;
    },
    list: () => [],
  };
  const execution = new Execution(workspace, {});
  const ask = (waitMs = 5000) =>
    execution['askFilePermission'](
      'p1',
      'r1',
      'C:\\밖',
      'C:\\밖\\a.txt',
      new AbortController().signal,
      waitMs,
    );
  const pending = ask();
  assert.equal(current.result.phase, 'question');
  assert.equal(current.result.questions[0].id, FILE_PERMISSION_CARD);
  assert.match(current.result.questions[0].title, /C:\\밖\\a\.txt/);
  assert.deepEqual(
    current.result.questions[0].options.map((o) => [o.id, o.label, !!o.recommended]),
    [
      ['once', '이번만', false],
      ['always', '이 폴더는 항상', false],
      ['deny', '거절', true],
    ],
  );
  execution.answerQuestions('p1', 'r1', [{ id: FILE_PERMISSION_CARD, option: 'always' }]);
  assert.equal(await pending, 'always');
  assert.equal(current.result.phase, 'model');
  const remote = ask();
  execution.answerQuestions('p1', 'r1', [{ id: FILE_PERMISSION_CARD, option: 'always' }], true);
  assert.equal(await remote, 'once');
  const refused = ask();
  execution.answerQuestions('p1', 'r1', [{ id: FILE_PERMISSION_CARD, option: 'deny' }]);
  assert.equal(await refused, 'deny');
  // Nobody answers: the card goes and the read is refused.
  assert.equal(await ask(30), null);
  assert.equal(current.result.phase, 'model');
  assert.throws(() => execution.answerQuestions('p1', 'r1', []), { code: 'NOT_FOUND' });
});

test('over HTTP: dashboard folders, and a turn reads inside, asks outside and logs the paths', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-project-files-http-'));
  const files = await tree(t);
  const results = [];
  const app = await startServer({
    filename: join(directory, 'store.sqlite'),
    host: { status: async () => ({ available: true }) },
    providerFactory: (options) => ({
      run: async () => {
        const agent = agentConnection(options.agent);
        const client = new Client({ name: 'synthetic-agent', version: '1.0.0' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(agent.url), {
            requestInit: { headers: { Authorization: `Bearer ${agent.token}` } },
          }),
        );
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        results.push(names.includes('file_read') && names.includes('file_list'));
        const call = async (name, args) => {
          const out = await client.callTool({ name, arguments: args });
          return out.content[0].type === 'text' ? JSON.parse(out.content[0].text) : out.content[0];
        };
        results.push((await call('file_list', {})).folders.length);
        results.push((await call('file_read', { path: 'notes.txt' })).text);
        results.push((await call('file_read', { path: join(files.outside, 'a.txt') })).text);
        results.push((await call('file_read', { path: join(files.other, 'd.txt') })).code);
        await client.close();
        return { text: JSON.stringify({ message: '읽었습니다', operations: [] }) };
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
  const project = (await api('/projects', 'POST', { name: '폴더' })).json;
  const base = `/projects/${project.id}`;
  assert.deepEqual((await api(`${base}/folders`)).json, { folders: [] });
  const added = await api(`${base}/folders`, 'POST', { path: files.project });
  assert.deepEqual(
    [added.status, added.json.folders.map((f) => [f.path, f.kind, f.exists])],
    [200, [[files.project, 'project', true]]],
  );
  assert.equal(
    (await api(`${base}/folders`, 'POST', { path: directory })).json.code,
    'FOLDER_NOT_ALLOWED',
  );
  assert.equal((await api(`${base}/folders`, 'POST', { path: join(directory, 'x') })).status, 400);
  const conversation = (
    await api(`${base}/conversations`, 'POST', {
      kind: 'general',
      title: '파일',
      provider: 'codex-cli',
    })
  ).json;
  const sent = await api(`${base}/requests`, 'POST', {
    id: 'turn-f',
    body: '프로젝트 파일 읽어줘',
    provider: 'codex-cli',
    permission: 'review',
    pins: [],
    sketches: [],
    files: [],
    conversationId: conversation.id,
    hostUse: 'none',
  });
  assert.ok(sent.status < 300, JSON.stringify(sent.json));
  // The first question (a.txt) is answered once; the second (other/d.txt) is refused.
  const answers = ['once', 'deny'];
  let done;
  for (let i = 0; i < 400 && !done; i++) {
    const row = (await api(`${base}/requests/turn-f`)).json;
    if (row.state === 'running' && row.result?.phase === 'question' && answers.length) {
      assert.equal(row.result.questions[0].id, 'file-access');
      await api(`${base}/requests/turn-f/questions`, 'POST', {
        answers: [{ id: 'file-access', option: answers.shift() }],
      });
    } else if (row.state !== 'running' && row.state !== 'queued') done = row;
    else await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(done?.state, 'succeeded', JSON.stringify(done?.result));
  assert.deepEqual(results, [true, 1, '첫 줄\n둘째 줄\n', '밖 A', 'FILE_ACCESS_DENIED']);
  const lines = done.result.activity.map((entry) => entry.text);
  for (const line of [
    '폴더 목록 · 프로젝트 폴더',
    `파일 읽기 · ${join(files.project, 'notes.txt')}`,
    `파일 읽기 · ${join(files.outside, 'a.txt')}`,
    `파일 읽기 거절 · ${join(files.other, 'd.txt')}`,
  ])
    assert.ok(lines.includes(line), line);
  // Removing the folder; deleting the project removes its rows.
  assert.deepEqual((await api(`${base}/folders/remove`, 'POST', { path: files.project })).json, {
    folders: [],
  });
});
