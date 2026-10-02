import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/core/store.ts';
import { ProjectFolders } from '../../src/core/project-folders.ts';
import {
  WorkFolderGate,
  checkFolder,
  commandPaths,
  deniedPath,
  turnGrants,
} from '../../src/server/project-files.ts';
import { Execution, FILE_PERMISSION_CARD } from '../../src/server/execution.ts';
import { startServer } from '../../src/server/server.ts';

// Project folders and the AI's work folder (SPEC-01.13, ARCH-01 §3 「프로젝트 폴더와 파일 도구」,
// PLAN-26 T-091, ADR-031 8 T-122). Synthetic files in a temporary folder only.
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

test('the work folder: inside it the CLI tools are allowed at once, attachments are read, no question', async (t) => {
  const { project, outside, data, root } = await tree(t);
  const folders = db(t);
  folders.add('p1', project, 'project');
  folders.add('p1', join(outside, 'more'), 'read');
  const attachment = join(data, 'attachments', 'p1', 'abc.png');
  const asked = [];
  const used = [];
  const gate = new WorkFolderGate({
    folders,
    projectId: 'p1',
    context: { dataDirectory: data, home: root },
    attachments: [attachment],
    ask: async (...args) => {
      asked.push(args);
      return 'deny';
    },
    onUse: (text) => used.push(text),
  });
  const signal = new AbortController().signal;
  assert.deepEqual(gate.scope(), { cwd: project, write: [project], read: [join(outside, 'more')] });
  const allow = { allow: true };
  for (const request of [
    { tool: 'Read', input: { file_path: join(project, 'notes.txt') } },
    { tool: 'Read', input: { file_path: 'notes.txt' } },
    { tool: 'Glob', input: { pattern: '**/*.png' } },
    { tool: 'Grep', input: { pattern: 'x', path: join(project, '도면') } },
    { tool: 'Write', input: { file_path: join(project, 'new', 'out.txt'), content: 'x' } },
    { tool: 'Edit', input: { file_path: join(project, 'notes.txt') } },
    { tool: 'Bash', input: { command: 'ls -la && cat notes.txt > copy.txt' } },
    { tool: 'Bash', input: { command: `type "${join(project, 'notes.txt')}"` } },
    // A read folder is read without asking; the attachment is read at its path.
    { tool: 'Read', input: { file_path: join(outside, 'more', 'c.txt') } },
    { tool: 'Read', input: { file_path: attachment } },
  ])
    assert.deepEqual(await gate.decide(request, signal), allow, JSON.stringify(request));
  assert.deepEqual(asked, []);
  // Keys, logins and VIDE data are never reached, inside the folder or not, and never asked.
  for (const request of [
    { tool: 'Read', input: { file_path: join(project, '.env') } },
    { tool: 'Read', input: { file_path: join(data, 'store.sqlite') } },
    { tool: 'Bash', input: { command: `cat ${join(root, '.ssh', 'id_rsa')}` } },
  ]) {
    const answer = await gate.decide(request, signal);
    assert.equal(answer.allow, false);
    assert.match(answer.message, /FILE_FORBIDDEN/);
  }
  // A junction inside the folder that leads out of it is outside (asked, here refused).
  const escaped = await gate.decide(
    { tool: 'Read', input: { file_path: join(project, 'escape', 'a.txt') } },
    signal,
  );
  assert.equal(escaped.allow, false);
  assert.deepEqual(asked.at(-1).slice(0, 2), [outside, join(project, 'escape', 'a.txt')]);
  // Tools that are not file or shell tools are refused, not asked.
  assert.equal(
    (await gate.decide({ tool: 'mcp__rhino__run_command', input: {} }, signal)).allow,
    false,
  );
  assert.ok(used.includes(`파일 거절 · ${join(project, '.env')}`));
});

test('outside the work folder each use asks: once / always / deny, write and run asked as such', async (t) => {
  const { project, outside, other, data, root } = await tree(t);
  const folders = db(t);
  folders.add('p1', project, 'project');
  const answers = ['once', 'deny', 'once', 'always'];
  const asked = [];
  const grants = turnGrants();
  const make = (extra = {}) =>
    new WorkFolderGate({
      folders,
      projectId: 'p1',
      context: { dataDirectory: data, home: root },
      grants,
      ask: async (folder, path, _signal, action) => {
        asked.push([folder, path, action]);
        return answers.shift();
      },
      ...extra,
    });
  const signal = new AbortController().signal;
  const gate = make();
  // once: reading this folder for the rest of the request, without asking again.
  assert.equal(
    (await gate.decide({ tool: 'Read', input: { file_path: join(outside, 'a.txt') } }, signal))
      .allow,
    true,
  );
  assert.equal(
    (await gate.decide({ tool: 'Grep', input: { pattern: 'x', path: outside } }, signal)).allow,
    true,
  );
  assert.deepEqual(asked, [[outside, join(outside, 'a.txt'), 'read']]);
  // Writing there is its own question (a read grant does not cover it): refused.
  const refused = await gate.decide(
    { tool: 'Write', input: { file_path: join(outside, 'w.txt'), content: 'x' } },
    signal,
  );
  assert.equal(refused.allow, false);
  assert.match(refused.message, /FILE_ACCESS_DENIED/);
  assert.deepEqual(asked.at(-1), [outside, join(outside, 'w.txt'), 'write']);
  // Refused once, not asked again in this request.
  assert.equal(
    (await gate.decide({ tool: 'Edit', input: { file_path: join(outside, 'b.txt') } }, signal))
      .allow,
    false,
  );
  assert.equal(asked.length, 2);
  // A shell command naming a path outside asks to run there.
  assert.equal(
    (await gate.decide({ tool: 'Bash', input: { command: `dir "${other}"` } }, signal)).allow,
    true,
  );
  assert.deepEqual(asked.at(-1), [other, other, 'run']);
  // always (reading): the folder becomes a read folder of the project.
  const more = join(outside, 'more');
  const fresh = make({ grants: turnGrants() });
  assert.equal(
    (await fresh.decide({ tool: 'Read', input: { file_path: join(more, 'c.txt') } }, signal)).allow,
    true,
  );
  assert.deepEqual(
    folders.list('p1').map((f) => [f.path, f.kind]),
    [
      [project, 'project'],
      [more, 'read'],
    ],
  );
  // Without a question (no card can be shown) a path outside is refused; a read folder is read.
  const silent = new WorkFolderGate({
    folders,
    projectId: 'p1',
    context: { dataDirectory: data, home: root },
  });
  assert.equal(
    (await silent.decide({ tool: 'Read', input: { file_path: join(outside, 'a.txt') } }, signal))
      .allow,
    false,
  );
  assert.equal(
    (await silent.decide({ tool: 'Read', input: { file_path: join(more, 'c.txt') } }, signal))
      .allow,
    true,
  );
  // A Plan turn writes no file, inside the folder either.
  const plan = new WorkFolderGate({ folders, projectId: 'p1', readOnly: true });
  assert.equal(
    (await plan.decide({ tool: 'Write', input: { file_path: join(project, 'x.txt') } }, signal))
      .allow,
    false,
  );
  // Codex's escalation of a command that names no path asks about the command itself.
  const escalations = [];
  const codex = new WorkFolderGate({
    folders,
    projectId: 'p1',
    ask: async (folder, path, _signal, action) => {
      escalations.push([path, action]);
      return 'once';
    },
  });
  const command = {
    tool: 'Bash',
    input: { command: 'npm install', cwd: project },
    escalation: true,
  };
  assert.equal((await codex.decide(command, signal)).allow, true);
  assert.equal((await codex.decide(command, signal)).allow, true);
  assert.deepEqual(escalations, [['npm install', 'run']]);
});

test('shell command paths: drive, quoted, Git Bash and home paths are found', () => {
  const home = 'C:\\Users\\me';
  assert.deepEqual(
    commandPaths('cp "C:\\A B\\x.txt" /d/out/ && cat ~/notes.md > D:\\y.txt', home).sort(),
    ['C:\\A B\\x.txt', 'D:\\out', 'D:\\y.txt', join(home, 'notes.md')].sort(),
  );
  assert.deepEqual(commandPaths('ls -la && grep -r foo src', home), []);
  // The program is not a path the command touches (Codex wraps every command in PowerShell).
  assert.deepEqual(
    commandPaths(
      `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'type a.txt'`,
      home,
    ),
    [],
  );
  // A script given to the shell is scanned too.
  assert.deepEqual(
    commandPaths(
      `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Set-Content -Path D:\\out\\d.txt -Value x'`,
      home,
    ),
    ['D:\\out\\d.txt'],
  );
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

test('over HTTP: dashboard folders, and a turn works in the folder, asks outside and logs the paths', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-project-files-http-'));
  const files = await tree(t);
  const results = [];
  const app = await startServer({
    filename: join(directory, 'store.sqlite'),
    host: { status: async () => ({ available: true }) },
    providerFactory: (options) => ({
      // The CLI's own tools (ADR-031 8): the provider gets the work folder and the gate.
      run: async () => {
        const work = options.builtinTools?.files;
        results.push(work?.cwd === files.project);
        const ask = (request) => options.toolPermission(request, new AbortController().signal);
        results.push(
          (await ask({ tool: 'Read', input: { file_path: join(files.project, 'notes.txt') } }))
            .allow,
        );
        results.push(
          (await ask({ tool: 'Read', input: { file_path: join(files.outside, 'a.txt') } })).allow,
        );
        results.push(
          (await ask({ tool: 'Bash', input: { command: `type "${join(files.other, 'd.txt')}"` } }))
            .allow,
        );
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
  assert.deepEqual(results, [true, true, true, false]);
  const lines = done.result.activity.map((entry) => entry.text);
  for (const line of [
    `파일 읽기 허용 · ${join(files.outside, 'a.txt')}`,
    `명령 실행 거절 · ${join(files.other, 'd.txt')}`,
  ])
    assert.ok(lines.includes(line), line + ' in ' + JSON.stringify(lines));
  // Removing the folder; deleting the project removes its rows.
  assert.deepEqual((await api(`${base}/folders/remove`, 'POST', { path: files.project })).json, {
    folders: [],
  });
});
