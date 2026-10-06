import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { ProjectFolders } from '../../src/core/project-folders.ts';
import { AttachmentStore } from '../../src/server/attachments.ts';
import {
  attachFromPath,
  attachmentPathRoutes,
  pathKinds,
} from '../../src/server/attachment-paths.ts';
import { WorkFolderGate } from '../../src/server/project-files.ts';
import { pathSpans, pathToken, pathName } from '../../src/ui/path-tokens.ts';
import { folders } from '../../src/ui/model.ts';

// Pasted paths become chips (SPEC-01.12 6, SPEC-01.13 5, PLAN-31 T-142): the spans read as paths,
// what each path is, the copy of any file type and the turn's read grant for a pasted folder.
const longest = (text) => pathSpans(text).map((span) => span.candidates[0].path);
const readings = (text) => pathSpans(text).map((span) => span.candidates.map((c) => c.path));

test('paths in the words: drive, share, quoted, spaces, several lines, Korean names', () => {
  assert.deepEqual(longest('C:\\자료\\도면.dwg'), ['C:\\자료\\도면.dwg']);
  assert.deepEqual(longest('\\\\nas\\공유\\2601 자료'), ['\\\\nas\\공유\\2601 자료']);
  assert.deepEqual(longest('D:/work/plan.pdf'), ['D:/work/plan.pdf']);
  // Explorer's "경로로 복사": quoted, read whole (spaces kept), the span covers the quotes.
  const quoted = pathSpans('이거 "C:\\My Docs\\2601 자료\\평면 A.dwg" 봐줘');
  assert.equal(quoted.length, 1);
  assert.equal(quoted[0].quoted, true);
  assert.deepEqual(quoted[0].candidates, [{ path: 'C:\\My Docs\\2601 자료\\평면 A.dwg', end: 32 }]);
  assert.equal(quoted[0].start, 3);
  // Unquoted with spaces: every cut, longest first, punctuation and a particle taken off.
  const cuts = readings('C:\\로컬 2601 자료\\도면.dwg를 열어 줘.')[0];
  assert.equal(cuts[0], 'C:\\로컬 2601 자료\\도면.dwg를 열어 줘');
  assert.ok(cuts.includes('C:\\로컬 2601 자료\\도면.dwg'));
  assert.ok(cuts.includes('C:\\로컬 2601'));
  // Several lines (and two paths on one line) are separate spans.
  assert.deepEqual(longest('C:\\a\\one.txt\nD:\\b\\two 2.txt\r\n\\\\srv\\s\\x'), [
    'C:\\a\\one.txt',
    'D:\\b\\two 2.txt',
    '\\\\srv\\s\\x',
  ]);
  assert.deepEqual(longest('C:\\a\\one.txt C:\\b\\two.txt'), ['C:\\a\\one.txt', 'C:\\b\\two.txt']);
  // Not paths: relative, roots alone, a drive letter inside a word, text in a chip.
  assert.deepEqual(longest('docs\\a.txt'), []);
  assert.deepEqual(longest('C:\\ 와 \\\\srv\\share'), []);
  assert.deepEqual(longest('abcC:\\x'), []);
  assert.deepEqual(longest('[폴더 · C:\\x]'), []);
});

test('chip tokens are named by the last name and numbered for another path', () => {
  assert.equal(pathName('C:\\a\\2601 자료\\'), '2601 자료');
  assert.equal(pathToken('file', 'C:\\a\\도면.dwg', []), '[파일 · 도면.dwg]');
  const taken = [{ label: '[파일 · 도면.dwg]', kind: 'file', path: 'C:\\a\\도면.dwg' }];
  assert.equal(pathToken('file', 'C:\\a\\도면.dwg', taken), '[파일 · 도면.dwg]');
  assert.equal(pathToken('file', 'D:\\b\\도면.dwg', taken), '[파일 · 도면.dwg (2)]');
  assert.equal(pathToken('folder', 'C:\\a\\[old]', []), '[폴더 · old]');
  // The request names only the folder chips still in the words.
  const draft = {
    body: '[폴더 · 자료] 와 [파일 · a.txt]',
    instructions: [],
    paths: [
      { label: '[폴더 · 자료]', kind: 'folder', path: 'C:\\x\\자료' },
      { label: '[폴더 · 지움]', kind: 'folder', path: 'C:\\x\\지움' },
      { label: '[파일 · a.txt]', kind: 'file', path: 'C:\\x\\a.txt' },
    ],
  };
  assert.deepEqual(folders(draft), [{ name: '자료', path: 'C:\\x\\자료' }]);
});

test('what a pasted path is, and the copy of any file type', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vide-path-chips-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const folder = join(root, '2601 자료');
  await mkdir(data);
  await mkdir(folder);
  await writeFile(join(folder, '도면 A.dwg'), 'AC1032 synthetic');
  await writeFile(join(folder, '.env'), 'KEY=1');
  await writeFile(join(data, 'inside.txt'), 'x');
  const context = { dataDirectory: data, home: root };
  const items = await pathKinds(
    [
      join(folder, '도면 A.dwg'),
      `"${folder}"`,
      join(folder, '없음.txt'),
      join(folder, '.env'),
      join(data, 'inside.txt'),
      parse(root).root,
      'relative.txt',
    ],
    context,
  );
  assert.deepEqual(
    items.map((item) => [item.kind, item.name]),
    [
      ['file', '도면 A.dwg'],
      ['folder', '2601 자료'],
      [null, ''],
      [null, ''],
      [null, ''],
      [null, ''],
      [null, ''],
    ],
  );
  const store = new AttachmentStore(join(data, 'attachments'));
  const kept = await attachFromPath(store, 'p1', join(folder, '도면 A.dwg'), context);
  assert.equal(kept.name, '도면 A.dwg');
  assert.equal(store.get('p1', kept.id)?.name, '도면 A.dwg');
  await assert.rejects(attachFromPath(store, 'p1', folder, context), /INVALID_INPUT/);
  await assert.rejects(
    attachFromPath(store, 'p1', join(folder, '.env'), context),
    /FILE_FORBIDDEN/,
  );
});

test('a pasted folder is read without asking in its turn; writing there still asks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vide-path-grant-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const pasted = join(root, 'pasted');
  const other = join(root, 'other');
  for (const path of [project, pasted, join(pasted, 'sub'), join(pasted, '.ssh'), other])
    await mkdir(path, { recursive: true });
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.ensureProject('p1', '합성');
  const projectFolders = new ProjectFolders(store);
  projectFolders.add('p1', project, 'project');
  const asked = [];
  const gate = (granted) =>
    new WorkFolderGate({
      folders: projectFolders,
      projectId: 'p1',
      context: { dataDirectory: join(root, 'data'), home: root },
      granted,
      ask: async (folder, path, signal, action) => {
        asked.push([action, path]);
        return 'deny';
      },
    });
  const signal = new AbortController().signal;
  const read = (g, path) => g.decide({ tool: 'Read', input: { file_path: path } }, signal);
  const withGrant = gate([pasted]);
  assert.deepEqual(await read(withGrant, join(pasted, 'sub', 'a.txt')), { allow: true });
  assert.deepEqual(
    await withGrant.decide({ tool: 'Glob', input: { path: pasted, pattern: '*' } }, signal),
    { allow: true },
  );
  assert.deepEqual(asked, []);
  // Writing in it, or reading another folder, asks; a key folder inside it is refused at once.
  assert.equal(
    (await withGrant.decide({ tool: 'Write', input: { file_path: join(pasted, 'n.txt') } }, signal))
      .allow,
    false,
  );
  assert.equal((await read(withGrant, join(other, 'x.txt'))).allow, false);
  assert.deepEqual(
    asked.map(([action]) => action),
    ['write', 'read'],
  );
  assert.match((await read(withGrant, join(pasted, '.ssh', 'id'))).message, /FILE_FORBIDDEN/);
  // Another turn without the chip asks again.
  asked.length = 0;
  assert.equal((await read(gate([]), join(pasted, 'a.txt'))).allow, false);
  assert.equal(asked.length, 1);
});

test('a remote session checks and copies no path of this PC', async () => {
  for (const action of ['path-kinds', 'from-path'])
    await assert.rejects(
      attachmentPathRoutes(new URL(`http://x/api/v1/projects/p1/attachments/${action}`), 'POST', {
        attachments: {},
        context: {},
        project: () => ({}),
        body: async () => ({ paths: ['C:\\x'], path: 'C:\\x' }),
        send: () => assert.fail('nothing is sent'),
        remote: true,
      }),
      { code: 'FORBIDDEN' },
    );
});
