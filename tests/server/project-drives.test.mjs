// Project folders on another drive or share (SPEC-08.9 1, SPEC-01.13 1): 자료 정리 walks every
// folder (a folder outside the common root is recorded by absolute path, nothing is left out), the
// original opens from either kind of record, and the drawing services take a drive-letter spelling
// of a file inside a folder stored by its real path, with the denied folders checked on both
// spellings. Path logic with drive-letter and UNC strings; then a real run on a `subst` drive made
// over a temporary folder (skipped where `subst` is unavailable). Synthetic folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as doc from '../fixtures/documents.mjs';
import {
  moveRoot,
  recordedPath,
  rootsOf,
  sourceFile,
} from '../../src/knowledge/collect/inventory.ts';
import { getMeta, openKnowledgeDb } from '../../src/knowledge/collect/schema.ts';
import { KnowledgeCollector } from '../../src/knowledge/collect/collector.ts';
import { modelPlan } from '../../src/knowledge/collect/ai.ts';
import { knowledgeSourceFile } from '../../src/jigs/knowledge.ts';
import { buildXrefGraph } from '../../src/core/xref-graph.ts';
import { projectPath, realPath, within } from '../../src/server/project-path.ts';

const windows = process.platform === 'win32';
const PROJECT = '11111111-2222-4333-8444-555555555555';

test(
  'rootsOf keeps every folder: another drive, a share, a sibling under a drive root',
  {
    skip: !windows,
  },
  () => {
    const share = rootsOf(['C:\\work\\2601 로컬', '\\\\server\\share\\PROJECTS\\2601']);
    assert.deepEqual(share, {
      root: 'C:\\work\\2601 로컬',
      folders: ['C:\\work\\2601 로컬', '\\\\server\\share\\PROJECTS\\2601'],
    });
    // Same drive, only the drive root in common: both kept, the first one stays the root.
    const sibling = rootsOf(['C:\\Users\\u\\Desktop\\p', 'C:\\Projects\\p']);
    assert.equal(sibling.root, 'C:\\Users\\u\\Desktop\\p');
    assert.equal(sibling.folders.length, 2);
    // A common folder below the drive root is still the root; the other drive is kept beside it.
    const mixed = rootsOf(['C:\\x\\a', 'D:\\y', 'C:\\x\\b']);
    assert.deepEqual(mixed, { root: 'C:\\x', folders: ['C:\\x\\a', 'D:\\y', 'C:\\x\\b'] });
    // The order of the folders no longer decides what is collected.
    assert.equal(rootsOf(['D:\\y', 'C:\\x\\a']).folders.length, 2);
  },
);

test(
  'recorded paths: relative under the root, absolute elsewhere, and back',
  { skip: !windows },
  () => {
    const root = 'C:\\x';
    assert.equal(recordedPath(root, 'C:\\x\\a\\회의록.docx'), 'a/회의록.docx');
    assert.equal(recordedPath(root, 'D:\\y\\공정표.xlsx'), 'D:/y/공정표.xlsx');
    assert.equal(recordedPath(root, 'C:\\Projects\\p\\메모.md'), 'C:/Projects/p/메모.md');
    assert.equal(recordedPath(root, '\\\\server\\share\\p\\설계.hwp'), '//server/share/p/설계.hwp');
    for (const path of [
      'C:\\x\\a\\회의록.docx',
      'D:\\y\\공정표.xlsx',
      '\\\\server\\share\\p\\설계.hwp',
    ])
      assert.equal(sourceFile(root, recordedPath(root, path)), path);
  },
);

test('moveRoot rewrites records both ways when the root changes', { skip: !windows }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-drives-move-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = openKnowledgeDb(join(directory, 'knowledge.sqlite'));
  const add = db.prepare(
    'insert into source(rel_path, ext, size, mtime, seen_run) values(?, ?, 0, ?, 1)',
  );
  add.run('a/회의록.docx', 'docx', '2026-10-08');
  add.run('D:/y/공정표.xlsx', 'xlsx', '2026-10-08');
  add.run('//server/share/p/설계.hwp', 'hwp', '2026-10-08');
  // The first folder changed to D:\y: the old relative record becomes absolute, D:\y's relative.
  moveRoot(db, 'C:\\x', 'D:\\y');
  const paths = db
    .prepare('select rel_path from source order by id')
    .all()
    .map((r) => r.rel_path);
  db.close();
  assert.deepEqual(paths, ['C:/x/a/회의록.docx', '공정표.xlsx', '//server/share/p/설계.hwp']);
});

test('xref graph: a drive-letter reference is the drawing listed under its share spelling', () => {
  const read = (xrefs = []) => ({
    units: 'mm',
    scale: 0.001,
    unitsAssumed: false,
    xrefs,
    inserts: xrefs.map((x) => ({ name: x.name, transform: [] })),
  });
  const reads = new Map([
    [
      '\\\\server\\share\\p\\배치도.dwg',
      read([{ name: 'base', path: 'Z:\\p\\기준.dwg', overlay: false, status: 'Resolved' }]),
    ],
    ['\\\\server\\share\\p\\기준.dwg', read()],
  ]);
  const real = (path) => path.replace(/^Z:\\/i, '\\\\server\\share\\');
  const graph = buildXrefGraph(reads, () => true, real);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges[0].child, '\\\\server\\share\\p\\기준.dwg');
  assert.deepEqual(graph.roots, ['\\\\server\\share\\p\\배치도.dwg']);
  // Without the real spelling the same file would be a third, unread node.
  assert.equal(buildXrefGraph(reads, () => true).nodes.length, 3);
});

test('xref graph: a library outside the folders is one node by drive letter and by share', () => {
  const read = (xrefs = []) => ({
    units: 'mm',
    scale: 0.001,
    unitsAssumed: false,
    xrefs,
    inserts: xrefs.map((x) => ({ name: x.name, transform: [] })),
  });
  const lib = (path) => [{ name: 'lib', path, overlay: false, status: 'Resolved' }];
  const real = (path) => path.replace(/^Z:\\/i, '\\\\server\\share\\');
  const byLetter = 'Z:\\lib\\L.dwg';
  const byShare = '\\\\server\\share\\lib\\L.dwg';
  // Read under the letter (the first reference's spelling), named by the share from another drawing.
  const reads = new Map([
    ['C:\\p\\A.dwg', read(lib(byLetter))],
    ['C:\\p\\B.dwg', read(lib(byShare))],
    [byLetter, read()],
  ]);
  const graph = buildXrefGraph(reads, () => true, real);
  assert.equal(graph.nodes.length, 3);
  assert.deepEqual(
    graph.edges.map((edge) => edge.child),
    [byLetter, byLetter],
  );
  assert.equal(graph.nodes.find((node) => node.name === 'L.dwg').read, true);
  // Read under the share, named by the letter: the same.
  const shared = new Map([...reads].map(([path, v]) => [path === byLetter ? byShare : path, v]));
  const second = buildXrefGraph(shared, () => true, real);
  assert.equal(second.nodes.length, 3);
  assert.deepEqual(
    second.edges.map((edge) => edge.child),
    [byShare, byShare],
  );
  // Not read yet: one unread node, so the next round reads it once.
  const unread = new Map([...reads].filter(([path]) => path !== byLetter));
  const third = buildXrefGraph(unread, () => true, real);
  assert.equal(third.nodes.length, 3);
  assert.equal(new Set(third.edges.map((edge) => edge.child)).size, 1);
  // A read set holding both spellings: one node, its relations once.
  const both = new Map([...reads, [byShare, read()]]);
  const fourth = buildXrefGraph(both, () => true, real);
  assert.equal(fourth.nodes.filter((node) => node.name === 'L.dwg').length, 1);
  assert.equal(fourth.edges.length, 2);
});

/** A free drive letter, or undefined. */
function freeLetter() {
  for (const letter of 'QRSTUVPONMLK') if (!existsSync(`${letter}:\\`)) return letter;
  return undefined;
}
/** `subst <letter>: <folder>` for the test, removed after it; undefined where unavailable. */
function substitute(t, folder) {
  if (!windows) return undefined;
  const letter = freeLetter();
  if (!letter) return undefined;
  try {
    execFileSync('subst', [`${letter}:`, folder], { stdio: 'ignore', windowsHide: true });
  } catch {
    return undefined;
  }
  t.after(() => {
    try {
      execFileSync('subst', [`${letter}:`, '/d'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* Already gone. */
    }
  });
  return existsSync(`${letter}:\\`) ? `${letter}:` : undefined;
}

test('on a subst drive: drawing paths by drive letter, denied folders on both spellings', async (t) => {
  const directory = realpathSync.native(await mkdtemp(join(tmpdir(), 'vide-drives-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, '2601 프로젝트');
  const secret = join(project, '비공개');
  await mkdir(join(project, '도면'), { recursive: true });
  await mkdir(secret, { recursive: true });
  await writeFile(join(project, '도면', '배치도.dwg'), 'AC1032 synthetic');
  const drive = substitute(t, directory);
  if (!drive) return t.skip('subst unavailable');

  const byLetter = `${drive}\\2601 프로젝트\\도면\\배치도.dwg`;
  assert.equal(realPath(byLetter).toLowerCase(), join(project, '도면', '배치도.dwg').toLowerCase());
  // A file not made yet keeps its tail on the real folder.
  assert.equal(
    realPath(`${drive}\\2601 프로젝트\\새 도면.dwg`).toLowerCase(),
    join(project, '새 도면.dwg').toLowerCase(),
  );
  assert.equal(within(project, byLetter), true);
  assert.equal(within(project, `${drive}\\다른 폴더\\a.dwg`), false);

  const denied = (path) => path.toLowerCase().startsWith(secret.toLowerCase() + '\\');
  // The project folder is stored by its real path; the drawing comes by the drive letter.
  assert.equal(
    projectPath([project], byLetter, denied).toLowerCase(),
    join(project, '도면', '배치도.dwg').toLowerCase(),
  );
  // As written it stays as written.
  const written = join(project, '도면', '배치도.dwg');
  assert.equal(projectPath([project], written, denied), written);
  // A folder stored by the drive letter takes the real spelling too.
  assert.ok(projectPath([`${drive}\\2601 프로젝트`], written, denied));
  // Denied by its real spelling, even when named by the drive letter.
  assert.equal(projectPath([project], `${drive}\\2601 프로젝트\\비공개\\a.dwg`, denied), null);
  assert.equal(projectPath([project], `${drive}\\밖\\a.dwg`, denied), null);

  // A library outside the folders, named by the drive letter from one drawing and by its real
  // folder from another: one drawing in the graph, read under one spelling.
  const library = join(directory, '라이브러리');
  await mkdir(library, { recursive: true });
  await writeFile(join(library, 'L.dwg'), 'AC1032 synthetic');
  const entry = (path) => ({
    units: 'mm',
    scale: 0.001,
    unitsAssumed: false,
    xrefs: path ? [{ name: 'lib', path, overlay: false, status: 'Resolved' }] : [],
    inserts: [],
  });
  const letterLib = `${drive}\\라이브러리\\L.dwg`;
  const reads = new Map([
    [join(project, 'A.dwg'), entry(letterLib)],
    [join(project, 'B.dwg'), entry(join(library, 'L.dwg'))],
    [letterLib, entry()],
  ]);
  const graph = buildXrefGraph(reads, existsSync, realPath);
  const libs = graph.nodes.filter((node) => node.name === 'L.dwg');
  assert.equal(libs.length, 1);
  assert.equal(libs[0].read, true);
  assert.deepEqual(
    graph.edges.map((edge) => edge.child),
    [letterLib, letterLib],
  );
  // Read under the real folder, named by the letter: the same one node.
  const real = new Map(
    [...reads].map(([path, v]) => [path === letterLib ? join(library, 'L.dwg') : path, v]),
  );
  const again = buildXrefGraph(real, existsSync, realPath);
  assert.equal(again.nodes.length, 3);
  assert.deepEqual(
    again.edges.map((edge) => edge.child),
    [join(library, 'L.dwg'), join(library, 'L.dwg')],
  );
});

test('a junction below a project folder that leads outside is not a project path', async (t) => {
  const directory = realpathSync.native(await mkdtemp(join(tmpdir(), 'vide-drives-link-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, '프로젝트');
  const outside = join(directory, '밖');
  await mkdir(join(project, '안'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'X.dwg'), 'AC1032 synthetic');
  await writeFile(join(project, '안', 'Y.dwg'), 'AC1032 synthetic');
  try {
    await symlink(outside, join(project, 'link'), 'junction');
    await symlink(join(project, '안'), join(project, 'inner'), 'junction');
  } catch {
    return t.skip('junctions unavailable');
  }
  const none = () => false;
  const linked = join(project, 'link', 'X.dwg');
  assert.equal(realPath(linked).toLowerCase(), join(outside, 'X.dwg').toLowerCase());
  assert.equal(projectPath([project], linked, none), null);
  // A junction that stays inside the folder is still taken as written.
  const inner = join(project, 'inner', 'Y.dwg');
  assert.equal(projectPath([project], inner, none), inner);
  assert.equal(
    projectPath([project], join(project, '안', 'Y.dwg'), none),
    join(project, '안', 'Y.dwg'),
  );
  // A file not made yet below the folder keeps its place.
  assert.equal(
    projectPath([project], join(project, '새 도면.dwg'), none),
    join(project, '새 도면.dwg'),
  );
});

test('자료 정리 collects a folder on another drive and opens its originals', async (t) => {
  const directory = realpathSync.native(await mkdtemp(join(tmpdir(), 'vide-drives-collect-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, 'data');
  const local = join(directory, '로컬 2601');
  const other = join(directory, 'other-drive');
  await mkdir(data, { recursive: true });
  await mkdir(join(local, '회의록'), { recursive: true });
  await mkdir(join(other, '2601 공유', '261005 협의'), { recursive: true });
  await writeFile(join(local, '회의록', '메모.md'), '옥상 조경 하중은 5kN/m2로 한다.');
  await writeFile(
    join(other, '2601 공유', '261005 협의', '설비 회의록.md'),
    '설비 협의는 10월 15일 오후 2시에 현장에서 한다.',
  );
  const drive = substitute(t, other);
  if (!drive) return t.skip('subst unavailable');
  const shared = `${drive}\\2601 공유`;

  const collector = new KnowledgeCollector({
    dataDirectory: data,
    folders: () => [local, shared],
    denied: (path) => /\.env$/.test(path),
    runner: doc.fakeRunner(),
    plan: async () => modelPlan(['claude-cli', 'codex-cli'], ['gpt-6.1-sol']),
    agenda: () => [],
    now: () => new Date(2026, 9, 8, 9, 0),
  });
  t.after(() => collector.close());
  await collector.start(PROJECT);
  await collector.idle(PROJECT);
  const state = collector.status(PROJECT);
  assert.equal(state.state, 'done', state.error ?? '');
  assert.equal('left' in state, false);

  const found = collector.file(PROJECT);
  const db = openKnowledgeDb(found);
  let rows, folders;
  try {
    assert.equal(getMeta(db, 'root'), local);
    folders = JSON.parse(getMeta(db, 'folders'));
    rows = db.prepare('select id, rel_path, top from source order by rel_path').all();
  } finally {
    db.close();
  }
  assert.deepEqual(folders, [local, shared]);
  const remote = rows.find((r) => r.rel_path.endsWith('설비 회의록.md'));
  assert.ok(remote, JSON.stringify(rows));
  assert.equal(remote.rel_path, `${drive}/2601 공유/261005 협의/설비 회의록.md`);
  assert.equal(remote.top, '261005 협의');
  const near = rows.find((r) => r.rel_path === '회의록/메모.md');
  assert.ok(near);
  // Both originals open; the other drive's one by its absolute record.
  const opened = knowledgeSourceFile(found, Number(remote.id));
  assert.equal(opened.name, '설비 회의록.md');
  assert.equal(knowledgeSourceFile(found, Number(near.id)).name, '메모.md');
});
