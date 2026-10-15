// 작업 폴더 manifest and template (PLAN-52 T-307, SPEC-01.13 7~10, ARCH-01 「작업 폴더(PLAN-52)」):
// both schemas, the 규모검토 role mapping, missing roles, UNC-shaped roots, junction and `..`
// escapes refused, server memory, atomic writes, template fallback. Synthetic folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  findWorkspaceRoot,
  insideWorkspace,
  layoutOf,
  promoteConfig,
  readWorkspaceConfig,
  resolveRolePath,
  updateServerMemory,
  workspaceOf,
  writeWorkspaceConfig,
} from '../../src/core/workspace-config.ts';
import {
  defaultTemplate,
  loadTemplate,
  templateToPaths,
  WORKSPACE_ROLES,
} from '../../src/core/workspace-template.ts';

const windows = process.platform === 'win32';
const PROJECT = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-9999-aaaaaaaaaaaa';

// A 규모검토 manifest in the shape of the 논현동 folder (written here, not read from it).
const architectureSample = {
  schema: 'architecture-workspace/1',
  project_id: 'nonhyeon-164-7-3',
  title: '논현동 164·7-3 규모검토',
  paths: {
    engine: '00_engine',
    project_data: '05_analysis/project_data',
    raw: '01_raw',
    rhino: '02_rhino',
    rcp: '03_rcp',
    analysis: '05_analysis',
    law_review: '05_analysis/law_review',
    site_modeling: '05_analysis/site_modeling',
    references: '06_references',
    presentation: '07_presentation',
    output: '08_output',
    archive: '99_archive',
  },
  authority: { model_config: '05_analysis/project_data/model.json', facts: 'facts.md' },
  git: { mode: 'project-local', root: '.', branch: 'main', remote: null },
  notes: '사람이 덧쓴 키',
};

const videSample = () => ({
  schema: 'vide-workspace/1',
  project_id: 'najin-2601',
  title: '나진상가 공공기여',
  paths: templateToPaths(defaultTemplate()),
  server: {
    root: '\\\\fileserver\\share\\PROJECTS\\2601-나진상가',
    paths: { raw: '02 자료', cad: '05 도면' },
    targets: { output: '05 보고서\\VIDE', snapshots: null },
    checkout: { rhino: 'local', cad: 'server' },
    proposedAt: '2026-10-15T01:00:00.000Z',
    confirmedBy: 'user',
    confirmedAt: '2026-10-15T01:05:00.000Z',
  },
  template: { name: 'vide-default', version: 1 },
  authority: {},
  git: { mode: 'project-local', root: '.', branch: 'main', remote: null },
  vide: { projectId: PROJECT, createdBy: 'user', createdAt: '2026-10-15T00:00:00.000Z' },
  extra: { kept: true },
});

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vide-workspace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const put = (dir, value) =>
  writeFile(
    join(dir, 'project.config.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
  );

test('vide-workspace/1 reads with its fields and keeps unknown keys', async (t) => {
  const dir = await folder(t);
  await put(dir, videSample());
  const cfg = await readWorkspaceConfig(dir);
  assert.equal(cfg.schema, 'vide-workspace/1');
  assert.equal(cfg.vide.projectId, PROJECT);
  assert.equal(cfg.server.root, '\\\\fileserver\\share\\PROJECTS\\2601-나진상가');
  assert.equal(cfg.server.targets.snapshots, null);
  assert.deepEqual(cfg.extra, { kept: true });
  assert.deepEqual(Object.keys(layoutOf(cfg).roles).sort(), [...WORKSPACE_ROLES].sort());
});

test('architecture-workspace/1 (논현동 shape) maps roles, review parts and other paths', async (t) => {
  const dir = await folder(t);
  await put(dir, architectureSample);
  const cfg = await readWorkspaceConfig(dir);
  assert.equal(cfg.schema, 'architecture-workspace/1');
  const layout = layoutOf(cfg);
  assert.deepEqual(layout.roles, {
    raw: '01_raw',
    rhino: '02_rhino',
    review: '05_analysis',
    output: '08_output',
    references: '06_references',
    archive: '99_archive',
  });
  assert.deepEqual(Object.keys(layout.reviewParts).sort(), [
    'law_review',
    'project_data',
    'site_modeling',
  ]);
  assert.deepEqual(Object.keys(layout.otherPaths).sort(), ['engine', 'presentation', 'rcp']);
  // Roles it does not have are simply absent.
  assert.equal(resolveRolePath(dir, cfg, 'cad'), null);
  assert.equal(resolveRolePath(dir, cfg, 'ops'), null);
  assert.equal(resolveRolePath(dir, cfg, 'review'), win32.resolve(dir, '05_analysis'));
  // Never rewritten as it is; promoted it becomes a vide manifest with the same meaning.
  await assert.rejects(writeWorkspaceConfig(dir, cfg), { code: 'WORKSPACE_READ_ONLY' });
  assert.throws(() => updateServerMemory(cfg, { root: 'C:\\x' }), {
    code: 'WORKSPACE_READ_ONLY',
  });
  const promoted = promoteConfig(cfg, { projectId: PROJECT, createdBy: 'user' });
  assert.equal(promoted.schema, 'vide-workspace/1');
  assert.equal(promoted.paths.review, '05_analysis');
  assert.equal(promoted.paths.law_review, '05_analysis/law_review');
  assert.equal(promoted.notes, '사람이 덧쓴 키');
  assert.equal(promoted.vide.projectId, PROJECT);
  assert.deepEqual(layoutOf(promoted).roles, layout.roles);
});

test('broken manifests are WORKSPACE_CONFIG_INVALID; no manifest is null', async (t) => {
  const dir = await folder(t);
  assert.equal(await readWorkspaceConfig(dir), null);
  for (const bad of [
    '{ not json',
    { schema: 'other/1', paths: {} },
    { paths: {} },
    { schema: 'vide-workspace/1', paths: { ops: 3 } },
    { schema: 'vide-workspace/1', paths: {}, vide: { projectId: 'not-a-uuid' } },
    { schema: 'vide-workspace/1', paths: {}, server: { root: '' } },
    [],
  ]) {
    await put(dir, bad);
    await assert.rejects(readWorkspaceConfig(dir), { code: 'WORKSPACE_CONFIG_INVALID' }, bad);
  }
  // A BOM is accepted.
  await put(dir, '\uFEFF' + JSON.stringify({ schema: 'vide-workspace/1', paths: {} }));
  assert.equal((await readWorkspaceConfig(dir)).schema, 'vide-workspace/1');
});

test('a manifest of another project on this PC conflicts', async (t) => {
  const dir = await folder(t);
  await put(dir, { ...videSample(), vide: { projectId: OTHER } });
  const isProject = (id) => id === OTHER || id === PROJECT;
  await assert.rejects(readWorkspaceConfig(dir, { projectId: PROJECT, isProject }), {
    code: 'WORKSPACE_PROJECT_CONFLICT',
  });
  // Not a project here: read, and `findWorkspaceRoot` flags it as not matched.
  assert.ok(await readWorkspaceConfig(dir, { projectId: PROJECT, isProject: () => false }));
  const found = await findWorkspaceRoot([dir], PROJECT, { isProject: () => false });
  assert.equal(found.matched, false);
  await assert.rejects(findWorkspaceRoot([dir], PROJECT, { isProject }), {
    code: 'WORKSPACE_PROJECT_CONFLICT',
  });
});

test('findWorkspaceRoot prefers the matching manifest and skips read folders', async (t) => {
  const base = await folder(t);
  const [plain, arch, mine, read, broken] = ['plain', 'arch', 'mine', 'read', 'broken'].map(
    (name) => join(base, name),
  );
  for (const dir of [plain, arch, mine, read, broken]) await mkdir(dir);
  await put(arch, architectureSample);
  await put(mine, videSample());
  await put(read, videSample());
  await put(broken, '{');
  const folders = [
    { path: read, kind: 'read', addedAt: '' },
    { path: plain, kind: 'project', addedAt: '' },
    { path: broken, kind: 'project', addedAt: '' },
    { path: arch, kind: 'project', addedAt: '' },
    { path: mine, kind: 'project', addedAt: '' },
  ];
  const found = await findWorkspaceRoot(folders, PROJECT);
  assert.deepEqual([found.root, found.matched], [mine, true]);
  // Without the matching one: the first readable manifest, flagged.
  const fallback = await findWorkspaceRoot(folders.slice(0, 4), PROJECT);
  assert.deepEqual([fallback.root, fallback.matched], [arch, false]);
  // Only a broken one: its error. None: null.
  await assert.rejects(findWorkspaceRoot(folders.slice(0, 3), PROJECT), {
    code: 'WORKSPACE_CONFIG_INVALID',
  });
  assert.equal(await findWorkspaceRoot(folders.slice(0, 2), PROJECT), null);
  // workspaceOf over a folder store resolves every role to an absolute path under the root.
  const ws = await workspaceOf({ list: () => folders }, PROJECT);
  assert.equal(ws.root, mine);
  assert.equal(ws.readOnly, false);
  assert.equal(ws.paths.review, win32.resolve(mine, '05_검토'));
  assert.equal(Object.keys(ws.paths).length, 10);
  assert.deepEqual(ws.outside, []);
});

test('role paths that leave the root are refused (.., another drive, absolute)', async (t) => {
  const dir = await folder(t);
  const cfg = {
    schema: 'vide-workspace/1',
    paths: {
      ops: '../elsewhere',
      raw: 'D:\\outside',
      rhino: '03_모델\\..\\..\\x',
      cad: join(dir, '04_도면'),
      output: '.',
    },
  };
  assert.throws(() => resolveRolePath(dir, cfg, 'ops'), { code: 'OUTSIDE_WORKSPACE' });
  assert.throws(() => resolveRolePath(dir, cfg, 'raw'), { code: 'OUTSIDE_WORKSPACE' });
  assert.throws(() => resolveRolePath(dir, cfg, 'rhino'), { code: 'OUTSIDE_WORKSPACE' });
  assert.equal(resolveRolePath(dir, cfg, 'cad'), win32.resolve(dir, '04_도면'));
  assert.equal(resolveRolePath(dir, cfg, 'output'), win32.resolve(dir));
  await put(dir, cfg);
  const ws = await workspaceOf(
    { list: () => [{ path: dir, kind: 'project', addedAt: '' }] },
    PROJECT,
  );
  assert.deepEqual(ws.outside.sort(), ['ops', 'raw', 'rhino']);
  assert.deepEqual(Object.keys(ws.paths).sort(), ['cad', 'output']);
});

test(
  'UNC-shaped roots keep their written spelling (an unreachable share falls back to it)',
  { skip: !windows },
  () => {
    const root = '\\\\fileserver\\share\\PROJECTS\\2601 공공기여';
    const cfg = { schema: 'vide-workspace/1', paths: { raw: '02 자료', ops: '..\\other' } };
    assert.equal(resolveRolePath(root, cfg, 'raw'), root + '\\02 자료');
    assert.throws(() => resolveRolePath(root, cfg, 'ops'), { code: 'OUTSIDE_WORKSPACE' });
    assert.equal(insideWorkspace(root, '\\\\fileserver\\share\\PROJECTS\\2601 공공기여\\a'), true);
    assert.equal(insideWorkspace(root, '\\\\fileserver\\share\\PROJECTS\\2601 공공기여2'), false);
  },
);

test('a junction inside the root that leads outside is refused', { skip: !windows }, async (t) => {
  const base = await folder(t);
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  try {
    await symlink(outside, join(root, '03_모델'), 'junction');
  } catch {
    // Junction creation unavailable here: try mklink, else skip.
    try {
      execFileSync('cmd', ['/c', 'mklink', '/J', join(root, '03_모델'), outside]);
    } catch {
      t.skip('junctions unavailable');
      return;
    }
  }
  const cfg = { schema: 'vide-workspace/1', paths: { rhino: '03_모델', raw: '02_자료' } };
  assert.throws(() => resolveRolePath(root, cfg, 'rhino'), { code: 'OUTSIDE_WORKSPACE' });
  assert.equal(resolveRolePath(root, cfg, 'raw'), win32.resolve(root, '02_자료'));
  // A file not yet written below the junction is judged by its nearest existing folder.
  assert.equal(insideWorkspace(root, '03_모델\\new\\a.3dm'), false);
});

test('writes are atomic, keep unknown keys and stamp vide.updatedAt', async (t) => {
  const dir = await folder(t);
  const now = new Date('2026-10-15T09:00:00.000Z');
  const written = await writeWorkspaceConfig(dir, videSample(), now);
  assert.equal(written.vide.updatedAt, now.toISOString());
  const text = await readFile(join(dir, 'project.config.json'), 'utf8');
  assert.ok(text.endsWith('\n'));
  const back = await readWorkspaceConfig(dir);
  assert.deepEqual(back, written);
  assert.deepEqual(back.extra, { kept: true });
  // Overwriting leaves no temporary file behind.
  await writeWorkspaceConfig(dir, { ...back, title: '바뀐 제목' });
  assert.deepEqual(await readdir(dir), ['project.config.json']);
  assert.equal((await readWorkspaceConfig(dir)).title, '바뀐 제목');
  // An invalid manifest is not written.
  await assert.rejects(writeWorkspaceConfig(dir, { ...back, vide: { projectId: 'x' } }), {
    code: 'WORKSPACE_CONFIG_INVALID',
  });
  assert.equal((await readWorkspaceConfig(dir)).title, '바뀐 제목');
});

test('server memory: confirmed values only, null forgets a path and remembers no target', () => {
  const start = { schema: 'vide-workspace/1', paths: {} };
  assert.throws(() => updateServerMemory(start, { paths: { raw: '02 자료' } }), {
    code: 'INVALID_INPUT',
  });
  const first = updateServerMemory(start, {
    root: '\\\\fileserver\\share\\PROJECTS\\2601',
    paths: { raw: '02 자료', cad: '05 도면' },
    confirmedBy: 'user',
  });
  assert.deepEqual(first.server.checkout, { rhino: 'local', cad: 'server' });
  assert.equal(start.server, undefined, 'pure');
  const second = updateServerMemory(first, {
    paths: { raw: null },
    targets: { output: '05 보고서\\VIDE', snapshots: null },
    checkout: { cad: 'local' },
  });
  assert.deepEqual(second.server.paths, { cad: '05 도면' });
  assert.deepEqual(second.server.targets, { output: '05 보고서\\VIDE', snapshots: null });
  assert.equal(second.server.checkout.cad, 'local');
  assert.equal(second.server.confirmedBy, 'user');
  for (const bad of [
    { paths: { raw: '..\\x' } },
    { paths: { raw: 'C:\\x' } },
    { paths: { nope: 'a' } },
    { targets: { output: '\\\\other\\share' } },
    { root: 'relative' },
  ])
    assert.throws(() => updateServerMemory(first, bad), { code: 'INVALID_INPUT' }, bad);
});

test('template: default, renamed file, partial file filled, bad file falls back', async (t) => {
  const dir = await folder(t);
  const none = await loadTemplate(dir);
  assert.equal(none.source, 'default');
  assert.equal(none.template.folders.ops, '01_운영');
  assert.equal(none.template.folders.archive, '10_아카이브');
  assert.equal((await loadTemplate(undefined)).source, 'default');
  const file = join(dir, 'workspace-template.json');
  await writeFile(
    file,
    JSON.stringify({
      name: '회사',
      version: 2,
      folders: { ops: 'A_운영', raw: '../밖', rhino: 'B_모델', unknown: 'x' },
      readme: '# 안내',
    }),
  );
  const partial = await loadTemplate(dir);
  assert.equal(partial.source, 'file');
  assert.equal(partial.template.name, '회사');
  assert.equal(partial.template.version, 2);
  assert.equal(partial.template.folders.ops, 'A_운영');
  assert.equal(partial.template.folders.rhino, 'B_모델');
  assert.equal(partial.template.folders.raw, '02_자료');
  assert.equal(partial.template.readme, '# 안내');
  assert.ok(partial.filled.includes('raw') && partial.filled.includes('cad'));
  assert.deepEqual(Object.keys(templateToPaths(partial.template)), [...WORKSPACE_ROLES]);
  for (const bad of ['{', '[]', JSON.stringify({ folders: { ops: '02_자료' } })]) {
    await writeFile(file, bad);
    const fallback = await loadTemplate(dir);
    assert.deepEqual(
      [fallback.source, fallback.error, fallback.template.folders.ops],
      ['default', 'WORKSPACE_TEMPLATE_INVALID', '01_운영'],
      bad,
    );
  }
});
