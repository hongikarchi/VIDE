// 작업 폴더의 산출물 사본 (PLAN-52 T-313, SPEC-01.13 7, ARCH-01 「작업 폴더(PLAN-52)」 산출물 경로):
// jig 결과(data.json)·검토용 보고서(report.html)·일지·회의록·검토본·프로젝트 jig 설명서가 역할 폴더로 가고,
// 사본 표시 줄이 붙고, 사람이 만든 같은 이름 파일은 덮어쓰지 않으며(-2), 작업 폴더가 없는 프로젝트는
// 아무것도 쓰지 않는다. 합성 폴더만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTemplate, templateToPaths } from '../../src/core/workspace-template.ts';
import { copyProjectJig, minuteOf, WorkspaceOutputs } from '../../src/server/workspace-outputs.ts';
import { SharedNotes } from '../../src/server/shared-notes.ts';
import { Store } from '../../src/core/store.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import { JigRegistry } from '../../src/jigs/runtime/loader.ts';
import { JigRuntime } from '../../src/jigs/runtime/runtime.ts';

const PROJECT = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const INSTANCE = 'abcdef12-3456-4789-8abc-def012345678';
const NOW = new Date(2026, 9, 15, 14, 5, 0);

async function temp(t, prefix = 'vide-outputs-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
/** A work folder with a vide-workspace/1 manifest naming `projectId`. */
async function workFolder(t, projectId = PROJECT, paths = templateToPaths(defaultTemplate())) {
  const root = await temp(t);
  await writeFile(
    join(root, 'project.config.json'),
    JSON.stringify({
      schema: 'vide-workspace/1',
      project_id: 'test-2601',
      title: '시험 프로젝트',
      paths,
      vide: { projectId, createdBy: 'user', createdAt: '2026-10-15T00:00:00.000Z' },
    }),
  );
  return root;
}
const foldersOf = (byProject) => ({
  list: (projectId) =>
    (byProject[projectId] ?? []).map((path) => ({ path, kind: 'project', addedAt: '' })),
});
function writer(byProject, now = () => NOW) {
  const logged = [];
  const outputs = new WorkspaceOutputs({
    folders: foldersOf(byProject),
    isProject: (id) => id === PROJECT || id === OTHER,
    now,
    log: (event, fields) => logged.push({ event, ...fields }),
  });
  return { outputs, logged };
}
const run = (outputs, over = {}) => ({
  jigId: 'vide/massing',
  instanceId: INSTANCE,
  title: '대안 A',
  status: 'computed',
  mode: 'geometry',
  outputs,
  ...over,
});
const firstLine = async (path) => (await readFile(path, 'utf8')).split('\n')[0];

test('jig results go to <review>/<jig>/<회차>/data.json; same outputs write no new 회차', async (t) => {
  const root = await workFolder(t);
  let clock = NOW;
  const { outputs } = writer({ [PROJECT]: [root] }, () => clock);
  const dir = await outputs.writeJigResult(PROJECT, run({ grid: { columns: 3 } }));
  const expected = join(root, '05_검토', 'massing', `${minuteOf(NOW)}-abcdef12`);
  assert.equal(dir, expected);
  const data = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'));
  assert.deepEqual(data.outputs, { grid: { columns: 3 } });
  assert.match(data.vide.copy, /^VIDE 사본 · 정본은 VIDE 데이터\(jig 결과\) · vide-copy:jig-run:/);
  assert.equal(data.vide.instanceId, INSTANCE);

  // The same outputs a minute later: still the same 회차.
  clock = new Date(2026, 9, 15, 14, 6, 0);
  assert.equal(await outputs.writeJigResult(PROJECT, run({ grid: { columns: 3 } })), dir);
  // Changed outputs: a new 회차 folder.
  const next = await outputs.writeJigResult(PROJECT, run({ grid: { columns: 4 } }));
  assert.equal(next, join(root, '05_검토', 'massing', `${minuteOf(clock)}-abcdef12`));
  assert.equal((await readdir(join(root, '05_검토', 'massing'))).length, 2);

  // A fresh writer (engine restart) finds the last 회차 on disk and does not repeat it.
  const again = writer({ [PROJECT]: [root] }, () => new Date(2026, 9, 15, 15, 0, 0)).outputs;
  assert.equal(await again.writeJigResult(PROJECT, run({ grid: { columns: 4 } })), next);
});

test('a report lands as report.html in the run folder with the copy line after the doctype', async (t) => {
  const root = await workFolder(t);
  const { outputs } = writer({ [PROJECT]: [root] });
  const dir = await outputs.writeJigResult(PROJECT, run({ a: 1 }));
  const html = '<!doctype html>\n<html><body>보고서</body></html>\n';
  const path = await outputs.writeJigReport(PROJECT, run({ a: 1 }), {
    reportId: 'summary',
    title: '규모 요약',
    html,
    single: true,
  });
  assert.equal(path, join(dir, 'report.html'));
  const text = await readFile(path, 'utf8');
  assert.ok(text.startsWith('<!doctype html>\n<!-- VIDE 사본 · 정본은 VIDE jig 보고서(규모 요약)'));
  assert.match(text, /vide-copy:jig-report:abcdef12-3456-4789-8abc-def012345678:summary -->/);
  assert.ok(text.includes('<body>보고서</body>'));
  // A jig with several reports names the file by report id.
  const second = await outputs.writeJigReport(PROJECT, run({ a: 1 }), {
    reportId: 'law',
    title: '법규',
    html: '<p>법규</p>',
    single: false,
  });
  assert.equal(second, join(dir, 'report-law.html'));
  assert.match(await firstLine(second), /^<!-- VIDE 사본 · 정본은 VIDE jig 보고서\(법규\)/);
  // An export-refused report (no page) writes nothing.
  assert.equal(
    await outputs.writeJigReport(PROJECT, run({ a: 1 }), {
      reportId: 'x',
      title: 'x',
      html: '',
      single: false,
    }),
    null,
  );
});

test('a file a person made under the same name is kept; the copy takes -2', async (t) => {
  const root = await workFolder(t);
  const { outputs } = writer({ [PROJECT]: [root] });
  const journalDir = join(root, '01_운영', '일지');
  await mkdir(journalDir, { recursive: true });
  await writeFile(join(journalDir, '2026-10-15.md'), '내가 쓴 일지\n');
  const path = await outputs.writeNote(
    PROJECT,
    { id: 'n1', kind: 'journal', title: '일지', journalDate: '2026-10-15' },
    '# 2026-10-15\n\n오늘 한 일',
  );
  assert.equal(path, join(journalDir, '2026-10-15-2.md'));
  assert.equal(await readFile(join(journalDir, '2026-10-15.md'), 'utf8'), '내가 쓴 일지\n');
  // The next copy of the same note rewrites its own file.
  assert.equal(
    await outputs.writeNote(
      PROJECT,
      { id: 'n1', kind: 'journal', title: '일지', journalDate: '2026-10-15' },
      '# 2026-10-15\n\n더 한 일',
    ),
    path,
  );
  assert.match(await readFile(path, 'utf8'), /더 한 일/);

  // A person's folder with the run folder's name: the 회차 takes -2.
  const taken = join(root, '05_검토', 'massing', `${minuteOf(NOW)}-abcdef12`);
  await mkdir(taken, { recursive: true });
  await writeFile(join(taken, 'memo.txt'), '사람 파일');
  const dir = await outputs.writeJigResult(PROJECT, run({ b: 2 }));
  assert.equal(dir, taken + '-2');
  assert.deepEqual(await readdir(taken), ['memo.txt']);
});

test('notes: 일지 and 회의록 under 운영 marked with the site as the source; a renamed note moves', async (t) => {
  const root = await workFolder(t);
  const { outputs } = writer({ [PROJECT]: [root] });
  const created = Date.parse('2026-10-14T03:00:00Z');
  const first = await outputs.writeNote(
    PROJECT,
    { id: 'n2', kind: 'meeting', title: '구조 협의', createdAt: created },
    '# 구조 협의\n\n철골 보 춤',
  );
  const day = minuteOf(new Date(created)).slice(0, 10);
  assert.equal(first, join(root, '01_운영', '회의록', `${day}-구조 협의.md`));
  assert.equal(
    await firstLine(first),
    '<!-- VIDE 사본 · 정본은 계정 사이트의 공유 노트 · 직접 고쳐도 반영되지 않고 VIDE가 다시 쓴다 · vide-copy:note:n2 -->',
  );
  const renamed = await outputs.writeNote(
    PROJECT,
    { id: 'n2', kind: 'meeting', title: '구조/설비 협의', createdAt: created },
    '# 구조 협의\n\n철골 보 춤',
  );
  assert.equal(renamed, join(root, '01_운영', '회의록', `${day}-구조_설비 협의.md`));
  assert.deepEqual(await readdir(join(root, '01_운영', '회의록')), [`${day}-구조_설비 협의.md`]);
  // A plain note or 협의 사항 gets no folder copy (SPEC-10.10 표, T-356).
  for (const kind of ['note', 'discussion'])
    assert.equal(
      await outputs.writeNote(
        PROJECT,
        { id: `x-${kind}`, kind, title: '메모', createdAt: created },
        '본문',
      ),
      null,
    );
  assert.equal((await readdir(join(root, '01_운영', '회의록'))).length, 1);
  // Operations Markdown of another kind (할 일 내보내기) goes to its own sub-folder.
  const todo = await outputs.writeOpsMarkdown(
    PROJECT,
    { sub: '할일', name: '2026-10-15', key: 'todo:2026-10-15', source: 'VIDE 할 일' },
    '- [ ] 구조 검토',
  );
  assert.equal(todo, join(root, '01_운영', '할일', '2026-10-15.md'));
});

test('SharedNotes hands every note copy to the work folder writer', async (t) => {
  const data = await temp(t, 'vide-notes-');
  const root = await workFolder(t);
  const { outputs } = writer({ [PROJECT]: [root] });
  const notes = new SharedNotes({
    remote: {
      site: 'https://site.example',
      deviceFetch: async (path, method = 'GET') =>
        method === 'GET' && path.startsWith(`/projects/${PROJECT}/notes`)
          ? Response.json({
              notes: [
                {
                  id: '1c9e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6',
                  projectId: PROJECT,
                  title: '',
                  kind: 'journal',
                  journalDate: '2026-10-15',
                  createdAt: 1,
                  updatedAt: Date.parse('2026-10-15T09:00:00Z'),
                  updatedBy: 'u1',
                  revision: 1,
                  snapshot: '오늘 한 일',
                },
              ],
            })
          : Response.json({ error: 'NOT_FOUND' }, { status: 404 }),
    },
    dataDirectory: data,
    agenda: { list: () => [], add: () => ({}) },
    onCopy: (projectId, note, markdown) => void outputs.writeNote(projectId, note, markdown),
  });
  t.after(() => notes.close());
  await notes.list(PROJECT);
  await outputs.idle();
  const copy = await readFile(join(root, '01_운영', '일지', '2026-10-15.md'), 'utf8');
  assert.match(copy, /^<!-- VIDE 사본 · 정본은 계정 사이트의 공유 노트/);
  assert.match(copy, /오늘 한 일/);
  // The data-folder copy is unchanged.
  assert.ok(existsSync(join(data, 'projects', PROJECT, 'notes', 'journal-2026-10-15.md')));
});

test('검토본 → <snapshots>/<시각>-<id 8자>/검토본.html; project jig → <tools>/<jig>/', async (t) => {
  const root = await workFolder(t);
  const { outputs } = writer({ [PROJECT]: [root] });
  const snapshot = await outputs.writeSnapshot(
    PROJECT,
    { id: '0b8f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4', title: '1차 검토', createdAt: NOW.toISOString() },
    '<!doctype html><html><body>검토</body></html>',
  );
  assert.equal(snapshot, join(root, '07_검토본', `${minuteOf(NOW)}-0b8f1d2e`, '검토본.html'));
  assert.match(
    (await readFile(snapshot, 'utf8')).split('\n')[1],
    /^<!-- VIDE 사본 · 정본은 VIDE 검토본\(1차 검토\)/,
  );

  const pkg = await temp(t, 'vide-jigpkg-');
  await writeFile(
    join(pkg, 'jig.json'),
    JSON.stringify({ id: 'project/grid-check', version: '0.1.0', name: '격자 점검' }),
  );
  const jigDir = await copyProjectJig(outputs, PROJECT, {
    id: 'project/grid-check',
    version: '0.1.0',
    dir: pkg,
  });
  assert.equal(jigDir, join(root, '09_도구', 'grid-check'));
  const readme = await readFile(join(jigDir, 'README.md'), 'utf8');
  assert.match(
    readme,
    /^<!-- VIDE 사본 · 정본은 VIDE에 설치된 프로젝트 jig\(project\/grid-check 0\.1\.0\)/,
  );
  assert.match(readme, /# 격자 점검/);
  assert.equal(
    await readFile(join(jigDir, 'jig.json'), 'utf8'),
    await readFile(join(pkg, 'jig.json'), 'utf8'),
  );
  // A README the jig ships is used as it is (under the copy line).
  await writeFile(join(pkg, 'README.md'), '# 격자 점검\n\n쓰는 법');
  await copyProjectJig(outputs, PROJECT, { id: 'project/grid-check', version: '0.1.1', dir: pkg });
  assert.match(await readFile(join(jigDir, 'README.md'), 'utf8'), /쓰는 법/);
  assert.deepEqual(await readdir(join(root, '09_도구')), ['grid-check']);
});

test('no work folder, another project’s folder, or a missing role: nothing is written', async (t) => {
  const plain = await temp(t);
  const others = await workFolder(t, OTHER);
  const noOps = await workFolder(t, PROJECT, { review: '05_검토' });
  const { outputs: none } = writer({ [PROJECT]: [plain] });
  assert.equal(await none.writeJigResult(PROJECT, run({ a: 1 })), null);
  assert.equal(
    await none.writeNote(
      PROJECT,
      { id: 'n', kind: 'journal', title: '', journalDate: '2026-10-15' },
      'x',
    ),
    null,
  );
  assert.equal(await none.writeSnapshot(PROJECT, { id: 'r', title: 't' }, '<p>'), null);
  assert.deepEqual(await readdir(plain), []);

  const { outputs: foreign } = writer({ [PROJECT]: [others] });
  assert.equal(await foreign.writeJigResult(PROJECT, run({ a: 1 })), null);
  assert.deepEqual((await readdir(others)).sort(), ['project.config.json']);

  const { outputs: partial } = writer({ [PROJECT]: [noOps] });
  assert.equal(
    await partial.writeNote(
      PROJECT,
      { id: 'n', kind: 'journal', title: '', journalDate: '2026-10-15' },
      'x',
    ),
    null,
  );
  assert.equal(await partial.writeProjectJig(PROJECT, { id: 'project/a', manifest: '{}' }), null);
  assert.ok(await partial.writeJigResult(PROJECT, run({ a: 1 })));

  // A broken manifest: no copy, no throw.
  const broken = await temp(t);
  await writeFile(join(broken, 'project.config.json'), '{ not json');
  const { outputs: bad } = writer({ [PROJECT]: [broken] });
  assert.equal(await bad.writeJigResult(PROJECT, run({ a: 1 })), null);
});

test('a role path that leaves the work folder is not written to (OUTSIDE_WORKSPACE logged)', async (t) => {
  const root = await workFolder(t, PROJECT, { review: '05_검토', ops: '01_운영' });
  const { outputs, logged } = writer({ [PROJECT]: [root] });
  // A role folder replaced by a junction to elsewhere after the manifest was read.
  const elsewhere = await temp(t, 'vide-elsewhere-');
  const { symlinkSync } = await import('node:fs');
  if (process.platform === 'win32') {
    symlinkSync(elsewhere, join(root, '01_운영'), 'junction');
    assert.equal(
      await outputs.writeNote(
        PROJECT,
        { id: 'n', kind: 'journal', title: '', journalDate: '2026-10-15' },
        'x',
      ),
      null,
    );
    assert.deepEqual(await readdir(elsewhere), []);
  }
  assert.ok(logged.every((entry) => entry.event === 'workspace-output-failed'));
});

// The runtime hook: a kept run calls onRun with the outputs; a preview does not.
test('JigRuntime calls onRun after a kept run, not after a preview', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'vide-outputs-jig-'));
  const dataDir = join(base, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(base, 'workspace.sqlite'));
  const jigStore = new JigStore(store);
  const EXT = join(import.meta.dirname, '..', '..', 'extensions', 'jigs');
  const registry = new JigRegistry({ store: jigStore, dataDir, devRoots: [EXT] });
  const events = [];
  const runtime = new JigRuntime({
    store: jigStore,
    dataDir,
    registry,
    child: { idleMs: 60_000 },
    onRun: (event) => events.push(event),
  });
  t.after(async () => {
    await runtime.close();
    store.close();
    const walk = (folder) => {
      for (const entry of readdirSync(folder, { withFileTypes: true }))
        if (entry.isDirectory()) walk(join(folder, entry.name));
        else chmodSync(join(folder, entry.name), 0o666);
    };
    if (existsSync(base)) walk(base);
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  });
  const project = store.createProject('예제');
  const created = await runtime.createInstance(project.id, {
    jig: 'project/example-grid',
    title: '격자 대안 A',
    layerRoot: 'VIDE::격자',
    params: [],
  });
  await runtime.run(project.id, created.id, { mode: 'preview' });
  assert.equal(events.length, 0);
  await runtime.run(project.id, created.id, { mode: 'geometry' });
  assert.equal(events.length, 1);
  assert.equal(events[0].projectId, project.id);
  assert.equal(events[0].instanceId, created.id);
  assert.equal(events[0].jigId, 'project/example-grid');
  assert.equal(events[0].title, '격자 대안 A');
  assert.equal(typeof events[0].outputs, 'object');
});
