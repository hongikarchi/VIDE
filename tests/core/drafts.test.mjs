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
import { Store } from '../../src/core/store.ts';
import { JigDrafts, draftsRoot, scanDraft } from '../../src/jigs/runtime/drafts.ts';
import { draftPathRefusal } from '../../src/ai/agent-connection.ts';
import { JigStore } from '../../src/core/jig-store.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'vide-drafts-'));
  const store = new Store(join(dir, 'vide.sqlite'));
  const project = store.createProject('합성 프로젝트');
  const drafts = new JigDrafts({ db: store.db, dataDir: dir });
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
    const jigs = new JigStore(t.store.db);
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
