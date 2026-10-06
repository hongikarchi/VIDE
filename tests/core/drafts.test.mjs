import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/core/store.ts';
import {
  JigDrafts,
  draftsRoot,
  failureReason,
  forkable,
  nextPatch,
  scanDraft,
} from '../../src/jigs/runtime/drafts.ts';
import { draftPathRefusal } from '../../src/ai/agent-connection.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import { listPackageFiles } from '../../src/jigs/runtime/loader.ts';
import { outsideBoxImports } from '../../src/jigs/runtime/compute-box.ts';

const repository = fileURLToPath(new URL('../..', import.meta.url));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'vide-drafts-'));
  const store = new Store(join(dir, 'vide.sqlite'));
  const project = store.createProject('합성 프로젝트');
  const drafts = new JigDrafts({ db: store, dataDir: dir });
  return {
    dir,
    store,
    projectId: project.id,
    drafts,
    close: () => {
      store.close?.();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the path rule refuses outside paths, agent files, manifests and module folders', () => {
  const root = join(tmpdir(), 'draft-root');
  assert.equal(draftPathRefusal(root, 'steps/a.ts'), undefined);
  assert.equal(draftPathRefusal(root, join(root, 'fixtures', 'basic', 'input.json')), undefined);
  assert.equal(draftPathRefusal(root, '../x.ts'), 'DRAFT_OUTSIDE');
  assert.equal(draftPathRefusal(root, join(tmpdir(), 'other', 'x.ts')), 'DRAFT_OUTSIDE');
  assert.equal(draftPathRefusal(root, '.'), 'DRAFT_OUTSIDE');
  for (const bad of [
    'CLAUDE.md',
    'steps/claude.md',
    'AGENTS.md',
    'GEMINI.md',
    '.claude/settings.json',
    '.codex/config.toml',
    '.mcp.json',
    'package.json',
    'node_modules/x/index.js',
    'CLAUDE.md.',
  ])
    assert.equal(draftPathRefusal(root, bad), 'DRAFT_FORBIDDEN_FILE', bad);
  assert.equal(draftPathRefusal(root, 'steps/a.ts:stream'), 'DRAFT_PATH_INVALID');
});

test('drafts of a development engine inside a repository live outside it', () => {
  const inRepo = draftsRoot(join(import.meta.dirname, '..', '..', '.vide', 'dev-data'));
  assert.ok(!inRepo.startsWith(join(import.meta.dirname, '..', '..')), inRepo);
  const plain = mkdtempSync(join(tmpdir(), 'vide-plain-'));
  assert.equal(draftsRoot(plain), join(plain, 'jigs', 'drafts'));
  rmSync(plain, { recursive: true, force: true });
});

test('a draft from the grid example validates, tests and previews in the compute box', async () => {
  const t = setup();
  try {
    const draft = t.drafts.create(t.projectId, { name: 'grid study', from: 'example-grid' });
    assert.equal(draft.state, 'open');
    assert.equal(draft.path, join(t.dir, 'jigs', 'drafts', draft.id));
    assert.equal(draft.manifest.id, 'project/grid-study');
    assert.ok(draft.files.some((f) => f.path === 'steps/grid.ts'));
    const validation = await t.drafts.validate(t.projectId, draft.id);
    assert.ok(validation.ok, JSON.stringify(validation.issues));
    const selftest = await t.drafts.test(t.projectId, draft.id);
    assert.ok(selftest.ok, JSON.stringify(selftest.cases.map((c) => c.error ?? c.mismatches)));
    const preview = await t.drafts.preview(t.projectId, draft.id);
    assert.equal(preview.fixture, 'basic');
    assert.equal(preview.panel.layout, 'jig-run');
    assert.ok(preview.outputs.grid.columns.length > 0);
    const again = t.drafts.get(t.projectId, draft.id);
    assert.ok(again.validate.ok && again.test.ok && again.preview.ok);
    assert.equal(t.drafts.list(t.projectId).length, 1);
  } finally {
    t.close();
  }
});

test('a blank draft works and step code that breaks out fails in the box', async () => {
  const t = setup();
  try {
    const draft = t.drafts.create(t.projectId, { name: '빈 초안', from: 'blank' });
    assert.match(draft.manifest.id, /^project\/draft-[0-9a-f]{8}$/);
    assert.ok((await t.drafts.validate(t.projectId, draft.id)).ok);
    assert.ok((await t.drafts.test(t.projectId, draft.id)).ok);
    t.drafts.writeFile(
      t.projectId,
      draft.id,
      'steps/main.ts',
      "export function main() { return { items: [], total: typeof process === 'undefined' ? require('fs') : 0 }; }\n",
    );
    const failed = await t.drafts.test(t.projectId, draft.id);
    assert.equal(failed.ok, false);
    assert.match(failed.cases[0].error, /require/);
  } finally {
    t.close();
  }
});

test('forbidden files and outside writes are refused', async () => {
  const t = setup();
  try {
    const draft = t.drafts.create(t.projectId, { name: 'guard', from: 'blank' });
    for (const path of [
      'CLAUDE.md',
      '.claude/settings.json',
      'package.json',
      '../escape.ts',
      'node_modules/a.js',
    ])
      assert.throws(() => t.drafts.writeFile(t.projectId, draft.id, path, 'x'), /DRAFT_/, path);
    assert.ok(!existsSync(join(t.dir, 'jigs', 'drafts', 'escape.ts')));
    // A file written behind the store's back (the CLI file tools) fails validation.
    writeFileSync(join(draft.path, 'AGENTS.md'), '# instructions');
    mkdirSync(join(draft.path, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(draft.path, 'node_modules', 'x', 'index.js'), '');
    const report = await t.drafts.validate(t.projectId, draft.id);
    assert.equal(report.ok, false);
    const paths = report.issues.map((i) => i.path);
    assert.ok(paths.includes('AGENTS.md') && paths.includes('node_modules'), JSON.stringify(paths));
    await assert.rejects(t.drafts.pin(t.projectId, draft.id, {}), /JIG_INVALID/);
    rmSync(join(draft.path, 'AGENTS.md'));
    rmSync(join(draft.path, 'node_modules'), { recursive: true });
    // A symbolic link or junction is refused.
    let linked = true;
    try {
      symlinkSync(tmpdir(), join(draft.path, 'link'), 'junction');
    } catch {
      linked = false;
    }
    if (linked) {
      assert.ok(scanDraft(draft.path).some((i) => i.path === 'link'));
      rmSync(join(draft.path, 'link'), { recursive: false, force: true });
    }
    assert.ok((await t.drafts.validate(t.projectId, draft.id)).ok);
  } finally {
    t.close();
  }
});

test('pinning installs a read-only ai-draft package and pins it; discarding removes the folder', async () => {
  const t = setup();
  try {
    const draft = t.drafts.create(t.projectId, { name: 'pin me', from: 'blank' });
    const pinned = await t.drafts.pin(t.projectId, draft.id, { version: '0.2.0' });
    assert.equal(pinned.id, 'project/pin-me');
    assert.equal(pinned.version, '0.2.0');
    assert.equal(pinned.installed, true);
    const jigs = new JigStore(t.store);
    const row = jigs.package('project/pin-me', '0.2.0');
    assert.equal(row.source, 'ai-draft');
    assert.equal(row.signer, null);
    assert.equal(JSON.parse(readFileSync(join(row.path, 'jig.json'), 'utf8')).version, '0.2.0');
    assert.deepEqual(
      jigs.pinned(t.projectId).map((p) => [p.jigId, p.version]),
      [['project/pin-me', '0.2.0']],
    );
    assert.equal(t.drafts.get(t.projectId, draft.id).state, 'pinned');
    await assert.rejects(t.drafts.pin(t.projectId, draft.id, {}), /DRAFT_NOT_OPEN/);
    // Another draft with the same id and version but different content is refused.
    const other = t.drafts.create(t.projectId, { name: 'pin me', from: 'blank' });
    t.drafts.writeFile(t.projectId, other.id, 'skill.md', '---\nname: x\n---\n\n다름\n');
    await assert.rejects(
      t.drafts.pin(t.projectId, other.id, { version: '0.2.0' }),
      /JIG_VERSION_EXISTS/,
    );
    const discarded = t.drafts.discard(t.projectId, other.id);
    assert.equal(discarded.state, 'discarded');
    assert.ok(!existsSync(other.path));
    assert.equal(t.drafts.list(t.projectId).length, 1);
  } finally {
    t.close();
  }
});

test('[수정하기] copies a pinned jig into a writable draft with the same id and the next patch version (T-101)', async () => {
  const t = setup();
  try {
    const first = t.drafts.create(t.projectId, { name: 'fork me', from: 'blank' });
    const pinned = await t.drafts.pin(t.projectId, first.id);
    assert.equal(pinned.version, '0.1.0');
    const jigs = new JigStore(t.store);
    const installed = jigs.package('project/fork-me', '0.1.0');
    const source = {
      dir: installed.path,
      id: 'project/fork-me',
      version: '0.1.0',
      name: 'fork me',
    };
    const fork = t.drafts.fork(t.projectId, source);
    assert.equal(fork.state, 'open');
    assert.equal(fork.manifest.id, 'project/fork-me');
    assert.equal(fork.version, '0.1.1');
    assert.deepEqual(fork.origin && [fork.origin.jigId, fork.origin.version, fork.origin.name], [
      'project/fork-me',
      '0.1.0',
      'fork me',
    ]);
    assert.ok(!existsSync(join(fork.path, '.results')), 'the origin is kept outside the folder');
    assert.deepEqual(fork.files.map((file) => file.path).sort(), listPackageFiles(installed.path));
    // The copy is writable (the install is read-only) and the install did not change.
    t.drafts.writeFile(
      t.projectId,
      fork.id,
      'steps/main.ts',
      'export const main = () => ({ items: [], total: 6 });\n',
    );
    assert.equal(
      JSON.parse(readFileSync(join(installed.path, 'jig.json'), 'utf8')).version,
      '0.1.0',
    );
    // A second open copy goes one patch further; a library or official id is refused.
    assert.equal(t.drafts.fork(t.projectId, source).version, '0.1.2');
    assert.throws(
      () => t.drafts.fork(t.projectId, { ...source, id: 'vide/fork-me' }),
      /INVALID_INPUT/,
    );
    // Pinning the copy re-pins the same jig at the new version: one row per jig in the project.
    const repinned = await t.drafts.pin(t.projectId, fork.id);
    assert.deepEqual([repinned.id, repinned.version], ['project/fork-me', '0.1.1']);
    assert.deepEqual(
      jigs.pinned(t.projectId).map((row) => [row.jigId, row.version]),
      [['project/fork-me', '0.1.1']],
    );
    assert.equal(jigs.packages('project/fork-me').length, 2, 'the older version stays installed');
    assert.equal(nextPatch(['0.3.1', '0.10.0', '0.9.9', 'x']), '0.10.1');
  } finally {
    t.close();
  }
});

test('[수정하기] refuses a jig whose steps import outside it; its copy could never pass the box (T-101)', async () => {
  const t = setup();
  try {
    // S-06 is written in this checkout against the repository's modules and node:crypto.
    const s06 = join(repository, 'extensions', 'jigs', 's06-frame');
    const outside = outsideBoxImports(s06, listPackageFiles(s06));
    assert.ok(outside.some((line) => line.endsWith('geometry-kit/index.ts')));
    assert.ok(outside.includes('steps/model.ts → node:crypto'));
    assert.equal(forkable(s06), false);
    assert.throws(
      () =>
        t.drafts.fork(t.projectId, {
          dir: s06,
          id: 'project/s06-frame',
          version: '0.3.1',
          name: 'S-06',
        }),
      /JIG_NOT_FORKABLE/,
    );
    assert.equal(t.drafts.list(t.projectId).length, 0, 'no draft is left behind');
    // The grid example imports only its own files: its copy validates, tests and pins.
    const grid = join(repository, 'extensions', 'jigs', 'example-grid');
    assert.equal(forkable(grid), true);
    const copy = t.drafts.fork(t.projectId, {
      dir: grid,
      id: 'project/example-grid',
      version: '0.1.0',
      name: 'grid',
    });
    assert.equal((await t.drafts.test(t.projectId, copy.id)).ok, true);
    assert.equal((await t.drafts.pin(t.projectId, copy.id)).version, copy.version);

    // The rule on a synthetic package: type-only imports and comments are no imports; a library id
    // and the package's own files are allowed; a path that leaves the package, a bare name or a
    // node: module is not.
    const dir = join(t.dir, 'pkg');
    mkdirSync(join(dir, 'steps'), { recursive: true });
    writeFileSync(join(dir, 'steps', 'own.ts'), 'export const one = 1;\n');
    writeFileSync(
      join(dir, 'steps', 'main.ts'),
      [
        "import type { Thing } from '../../outside/types.ts';",
        "// import { gone } from '../../commented.ts';",
        "/* import x from 'node:fs'; */",
        "import { offsetPolygon } from 'vide/geometry-kit';",
        "import { one } from './own.ts';",
        "export { one as two } from './own.ts';",
        'export const main = (i: Thing) => [offsetPolygon, one, i];',
      ].join('\n'),
    );
    assert.deepEqual(outsideBoxImports(dir, ['steps/main.ts', 'steps/own.ts']), []);
    writeFileSync(
      join(dir, 'steps', 'bad.ts'),
      [
        "import { a } from '../../outside.ts';",
        "import 'zod';",
        "const fs = await import('node:fs');",
        'export const bad = [a, fs];',
      ].join('\n'),
    );
    assert.deepEqual(outsideBoxImports(dir, ['steps/main.ts', 'steps/own.ts', 'steps/bad.ts']), [
      'steps/bad.ts → ../../outside.ts',
      'steps/bad.ts → zod',
      'steps/bad.ts → node:fs',
    ]);
  } finally {
    t.close();
  }
});

test('a draft file is deleted inside the folder only; empty folders go with it', async () => {
  const t = setup();
  try {
    const draft = t.drafts.create(t.projectId, { name: 'delete me', from: 'blank' });
    t.drafts.writeFile(t.projectId, draft.id, 'steps/extra/old.ts', 'export const x = 1;\n');
    assert.deepEqual(t.drafts.deleteFile(t.projectId, draft.id, 'steps/extra/old.ts'), {
      path: 'steps/extra/old.ts',
      deleted: true,
    });
    assert.ok(!existsSync(join(draft.path, 'steps', 'extra')));
    assert.ok(existsSync(join(draft.path, 'steps', 'main.ts')));
    const refused = (path, code) =>
      assert.throws(
        () => t.drafts.deleteFile(t.projectId, draft.id, path),
        (error) => error.code === code,
      );
    refused('jig.json', 'DRAFT_PATH_INVALID');
    refused('JIG.JSON', 'DRAFT_PATH_INVALID');
    refused('steps', 'DRAFT_PATH_INVALID');
    refused('steps/none.ts', 'NOT_FOUND');
    refused('../outside.ts', 'DRAFT_OUTSIDE');
    refused(join(t.dir, 'vide.sqlite'), 'DRAFT_OUTSIDE');
    refused('CLAUDE.md', 'DRAFT_FORBIDDEN_FILE');
    refused('node_modules/x/index.js', 'DRAFT_FORBIDDEN_FILE');
    assert.ok(existsSync(join(t.dir, 'vide.sqlite')));
    // A pinned draft is closed to changes.
    await t.drafts.pin(t.projectId, draft.id, {});
    refused('skill.md', 'DRAFT_NOT_OPEN');
  } finally {
    t.close();
  }
});

test('the pin drops step files left empty and named by no step', async () => {
  const t = setup();
  try {
    const draft = t.drafts.create(t.projectId, { name: 'empty steps', from: 'blank' });
    t.drafts.writeFile(t.projectId, draft.id, 'steps/old.ts', '  \n');
    t.drafts.writeFile(t.projectId, draft.id, 'steps/kept.ts', 'export const k = 1;\n');
    assert.equal((await t.drafts.validate(t.projectId, draft.id)).ok, true);
    const pinned = await t.drafts.pin(t.projectId, draft.id, {});
    assert.ok(!existsSync(join(pinned.path, 'steps', 'old.ts')));
    assert.ok(existsSync(join(pinned.path, 'steps', 'kept.ts')));
    assert.ok(existsSync(join(pinned.path, 'steps', 'main.ts')));
    assert.ok(existsSync(join(draft.path, 'steps', 'old.ts')));
  } finally {
    t.close();
  }
});

test('failure reasons name the issues or the failing cases; a pass has none', () => {
  assert.equal(failureReason({ ok: true, issues: [] }), undefined);
  const issues = [
    { code: 'JIG_SCHEMA', path: 'jig.json', message: 'x', level: 'error' },
    { code: 'JIG_PANEL', path: 'panel.json', message: 'y', level: 'warn' },
  ];
  assert.equal(failureReason({ ok: false, issues }), 'JIG_SCHEMA jig.json');
  assert.equal(
    failureReason({
      ok: false,
      cases: [
        { name: 'basic', ok: false, steps: [], mismatches: [{ path: 'steps.main.total' }] },
        { name: 'other', ok: true, steps: [], mismatches: [] },
      ],
    }),
    'basic steps.main.total',
  );
  assert.equal(failureReason({ ok: false, cases: [] }), '시험 사례 없음');
});
