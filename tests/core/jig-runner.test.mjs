import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import { JigRegistry, loadJig } from '../../src/jigs/runtime/loader.ts';
import { JigRuntime } from '../../src/jigs/runtime/runtime.ts';
import { ChildRunner } from '../../src/jigs/runtime/child-runner.ts';
import { EngineRunner, MemoryCache, executeSteps } from '../../src/jigs/runtime/runner.ts';
import { initialParams } from '../../src/jigs/runtime/params.ts';
import {
  decodePack,
  encodePack,
  importPack,
  keyIdOf,
  packEntries,
  packJig,
  selftestJig,
  signDigest,
  signingKey,
  validateJig,
} from '../../src/jigs/runtime/pack.ts';
import { digestEntries } from '../../src/jigs/runtime/loader.ts';
import { closeJigRuntime, jigRoutes } from '../../src/server/jig-routes.ts';

// T-046 (PLAN-22): the synthetic example jig as an instance — compute, recompute only the changed
// steps, undo, restore after a restart — and the failure paths: budget, cycles, fixed settings,
// unsigned or foreign packs, same version with other content, forbidden files, remote sessions,
// and the child process boot test. No S-06 data.
const EXT = join(import.meta.dirname, '..', '..', 'extensions', 'jigs');
const EXAMPLE = join(EXT, 'example-grid');
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const row = (id, layer, line) => ({ id, nativeId: id, layer64: b64(layer), line });
const OUTLINE = [0, 0, 0, 30, 0, 0, 30, 20, 0, 0, 20, 0, 0, 0, 0];
const VOID = [12, 6, 0, 18, 6, 0, 18, 14, 0, 12, 14, 0, 12, 6, 0];
const model = () => ({
  scene: [
    row('o1', '슬래브 외곽', OUTLINE),
    row('v1', '보이드', VOID),
    row('x1', '기타', [0, 0, 0, 1, 1, 0]),
  ],
  definitions: {},
  sourceDocument: { name: 'synthetic.3dm', instance: 'rhino-1', documentId: 7, revision: 3 },
});

/** Delete a tree that may hold read-only files (installed packages). */
function rmrf(dir) {
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else chmodSync(full, 0o666);
    }
  };
  if (existsSync(dir)) {
    walk(dir);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

function fixture(t, { openStore = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vide-jig-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const filename = join(root, 'workspace.sqlite');
  const open = () => {
    const store = new Store(filename);
    const workspace = new Workspace(store);
    const jigStore = new JigStore(store.db);
    const registry = new JigRegistry({ store: jigStore, dataDir, devRoots: [EXT] });
    const runtime = new JigRuntime({
      store: jigStore,
      dataDir,
      registry,
      child: { idleMs: 60_000 },
    });
    return { store, workspace, jigStore, registry, runtime };
  };
  const state = openStore ? open() : {};
  const project = openStore ? state.store.createProject('예제 프로젝트') : undefined;
  t.after(async () => {
    await state.runtime?.close();
    if (state.workspace) await closeJigRuntime(state.workspace);
    state.store?.close();
    rmrf(root);
  });
  return {
    root,
    dataDir,
    filename,
    project,
    open,
    ...state,
    reopen: async () => {
      await state.runtime.close();
      state.store.close();
      Object.assign(state, open());
      return state;
    },
  };
}

test('an instance computes, reuses cached steps, recomputes only what a setting touches, undoes and restores after a restart', async (t) => {
  const f = fixture(t);
  const { runtime, project } = f;
  const created = await runtime.createInstance(project.id, {
    jig: 'project/example-grid',
    title: '격자 대안 A',
    layerRoot: 'VIDE::격자',
    params: [{ key: 'markPrefix', value: 'P' }],
  });
  assert.equal(created.status, 'new');
  assert.equal(created.jig.version, '0.1.0');
  assert.equal(created.params.find((p) => p.key === 'markPrefix').value, 'P');
  assert.equal(created.params.find((p) => p.key === 'columnSize').displayValue, 600);
  assert.deepEqual(
    created.steps.map((s) => s.status),
    ['pending', 'pending', 'pending', 'pending'],
  );

  // Input read → rule proposal → confirmed roles with snapshots.
  const read = runtime.recordRead(project.id, created.id, {
    linkId: 'link-1',
    revisionKey: 'rhino-1|7|3',
    layers: ['슬래브 외곽', '보이드', '기타'],
    includeHidden: false,
    purpose: 'assembly',
    model: model(),
  });
  assert.equal(read.objectCount, 3);
  const proposal = await runtime.proposeAssembly(project.id, created.id);
  assert.deepEqual(
    proposal.proposals['site.outline'].candidates.map((c) => c.layer),
    ['슬래브 외곽'],
  );
  assert.deepEqual(
    proposal.proposals['site.voids'].candidates.map((c) => c.layer),
    ['보이드'],
  );
  const outline = await runtime.setAssembly(project.id, created.id, 'site.outline', {
    sources: [{ readId: read.id, layers: ['슬래브 외곽'] }],
    confirm: true,
    by: 'user',
  });
  assert.ok(outline.confirmed && outline.snapshot.hash.length === 64);
  await runtime.setAssembly(project.id, created.id, 'site.voids', {
    sources: [{ readId: read.id, layers: ['보이드'] }],
    confirm: true,
    by: 'user',
  });
  await runtime.setParams(project.id, created.id, {
    values: [
      { key: 'spacingX', value: 6 },
      { key: 'spacingY', value: 5 },
    ],
    by: 'user',
  });

  // First run: the grid computes, the human step waits, the beams stay blocked.
  const first = await runtime.run(project.id, created.id, {
    mode: 'geometry',
    currentRevisions: { 'link-1': 'rhino-1|7|3' },
  });
  assert.deepEqual(
    first.steps.map((s) => [s.id, s.status, s.cached]),
    [
      ['grid', 'done', false],
      ['confirmInputs', 'waiting', false],
      ['beams', 'blocked', false],
      ['summary', 'blocked', false],
    ],
  );
  assert.equal(first.outputs.grid.columns.length, 18);
  assert.ok(first.outputs.grid.columns.every((c) => c.key.startsWith('col:P')));
  assert.ok(first.steps[0].gates.find((g) => g.name === 'stale-input').ok);

  // A document that moved on: stale-input blocks the grid step.
  const stale = await runtime.run(project.id, created.id, {
    mode: 'geometry',
    currentRevisions: { 'link-1': 'rhino-1|7|4' },
  });
  assert.equal(stale.steps[0].status, 'gate-failed');
  assert.equal(stale.status, 'gate-failed');
  assert.deepEqual(
    stale.steps[0].gates.filter((g) => !g.ok).map((g) => g.name),
    ['stale-input'],
  );

  // Confirmed inputs: the grid comes from the cache, beams and summary compute.
  const hash = first.steps[1].inputHash;
  await runtime.confirmStep(project.id, created.id, 'confirmInputs', hash);
  const second = await runtime.run(project.id, created.id, { mode: 'geometry' });
  assert.deepEqual(
    second.steps.map((s) => [s.id, s.status, s.cached]),
    [
      ['grid', 'done', true],
      ['confirmInputs', 'confirmed', false],
      ['beams', 'done', false],
      ['summary', 'done', false],
    ],
  );
  assert.equal(second.outputs.summary.columns, 18);
  assert.equal(second.outputs.summary.beams, 24);
  assert.equal(second.status, 'computed');

  // A member setting recomputes beams and summary only; grid stays cached.
  const change = await runtime.setParams(project.id, created.id, {
    values: [{ key: 'columnSize', value: 700, unit: 'mm' }],
    by: 'user',
    reason: '기둥 700',
  });
  assert.deepEqual(change.affected, ['beams', 'summary']);
  assert.equal(change.instance.status, 'stale');
  assert.deepEqual(
    change.instance.steps.map((s) => s.status),
    ['done', 'confirmed', 'stale', 'stale'],
  );
  const third = await runtime.run(project.id, created.id, { mode: 'geometry' });
  assert.deepEqual(
    third.steps.map((s) => [s.id, s.cached]),
    [
      ['grid', true],
      ['confirmInputs', false],
      ['beams', false],
      ['summary', false],
    ],
  );
  assert.equal(third.outputs.beams.beams[0].width_m, 0.7);

  // A grid setting changes the fingerprint the person confirmed: reconfirm, beams blocked.
  const wider = await runtime.setParams(project.id, created.id, {
    values: [{ key: 'spacingX', value: 9 }],
    by: 'user',
  });
  assert.deepEqual(wider.affected, ['grid', 'confirmInputs', 'beams', 'summary']);
  const fourth = await runtime.run(project.id, created.id, { mode: 'geometry' });
  assert.deepEqual(
    fourth.steps.map((s) => s.status),
    ['done', 'reconfirm', 'blocked', 'blocked'],
  );
  assert.equal(fourth.outputs.grid.columns.length, 10);
  assert.equal((await runtime.view(project.id, created.id)).steps[1].status, 'reconfirm');

  // Undo brings the old value back; the cached grid and the earlier confirmation apply again.
  const undone = await runtime.undo(project.id, created.id, wider.seqs[0]);
  assert.equal(undone.instance.params.find((p) => p.key === 'spacingX').value, 6);
  const log = runtime.paramLog(project.id, created.id);
  assert.equal(log.at(-1).reason, `undo:${wider.seqs[0]}`);
  const fifth = await runtime.run(project.id, created.id, { mode: 'geometry' });
  assert.deepEqual(
    fifth.steps.map((s) => [s.status, s.cached]),
    [
      ['done', true],
      ['confirmed', false],
      ['done', true],
      ['done', true],
    ],
  );

  // Fixed and out-of-range settings are refused with their codes; nothing changes.
  await assert.rejects(
    runtime.setParams(project.id, created.id, {
      values: [{ key: 'markPrefix', value: 'C' }],
      by: 'ai',
    }),
    { code: 'PARAM_FIXED' },
  );
  await assert.rejects(
    runtime.setParams(project.id, created.id, {
      values: [{ key: 'spacingX', value: 40 }],
      by: 'user',
    }),
    { code: 'OUT_OF_RANGE' },
  );

  // An override survives recomputation; the grid the person confirmed changed, so they confirm again.
  await runtime.setOverrides(project.id, created.id, {
    add: [
      {
        target: { kind: 'column', identity: { key: 'col:P1-1' } },
        op: 'remove',
        fields: {},
        origin: 'table',
        by: 'user',
      },
    ],
  });
  const sixth = await runtime.run(project.id, created.id, { mode: 'geometry' });
  assert.deepEqual(
    sixth.steps.map((s) => [s.status, s.cached]),
    [
      ['done', false],
      ['reconfirm', false],
      ['blocked', false],
      ['blocked', false],
    ],
  );
  assert.equal(
    sixth.outputs.grid.columns.some((c) => c.key === 'col:P1-1'),
    false,
  );
  await runtime.confirmStep(project.id, created.id, 'confirmInputs', sixth.steps[1].inputHash);
  const seventh = await runtime.run(project.id, created.id, { mode: 'geometry' });
  assert.deepEqual(
    seventh.steps.map((s) => [s.status, s.cached]),
    [
      ['done', true],
      ['confirmed', false],
      ['done', false],
      ['done', false],
    ],
  );
  assert.equal(seventh.outputs.summary.columns, 17);

  // Preview runs keep nothing; a zone changes the grid input.
  const before = runtime.paramLog(project.id, created.id).length;
  const preview = await runtime.run(project.id, created.id, { mode: 'preview' });
  assert.equal(preview.mode, 'preview');
  assert.equal(runtime.paramLog(project.id, created.id).length, before);
  await runtime.setZones(project.id, created.id, {
    keepOut: [
      {
        id: 'z1',
        shape: [
          [0, 0],
          [10, 0],
          [10, 20],
          [0, 20],
        ],
        source: { value: 'z1', by: 'sketch', at: 't' },
      },
    ],
  });
  const zoned = await runtime.run(project.id, created.id, { mode: 'geometry' });
  assert.equal(zoned.outputs.grid.columns.length, 10);
  assert.deepEqual(
    zoned.steps.map((s) => s.status),
    ['done', 'reconfirm', 'blocked', 'blocked'],
  );

  // Restart: the instance, its settings, assembly, step states and kept outputs come back.
  const { runtime: again } = await f.reopen();
  const restored = await again.view(project.id, created.id);
  assert.equal(restored.params.find((p) => p.key === 'columnSize').value, 0.7);
  assert.ok(restored.body.assembly['site.outline'].confirmed);
  assert.equal(restored.body.overrides.length, 1);
  assert.equal(restored.body.zones.keepOut.length, 1);
  assert.deepEqual(
    restored.steps.map((s) => s.status),
    ['done', 'reconfirm', 'stale', 'stale'],
  );
  assert.equal(again.output(project.id, created.id, 'summary').columns, 17);
  await again.confirmStep(project.id, created.id, 'confirmInputs', zoned.steps[1].inputHash);
  const afterRestart = await again.run(project.id, created.id, { mode: 'geometry' });
  assert.deepEqual(
    afterRestart.steps.map((s) => [s.status, s.cached]),
    [
      ['done', true],
      ['confirmed', false],
      ['done', false],
      ['done', false],
    ],
  );
  assert.equal(afterRestart.outputs.summary.columns, 10);
  assert.deepEqual(
    again.list(project.id).map((i) => i.title),
    ['격자 대안 A'],
  );
});

test('a setting change during a run supersedes it: later steps are skipped and nothing is kept', async () => {
  const jig = await loadJig(EXAMPLE);
  const cache = new MemoryCache();
  let checks = 0;
  const inputs = {
    site: { outline: { rows: [row('o1', '슬래브 외곽', OUTLINE)] }, voids: { rows: [] } },
    keepOut: [],
  };
  const report = await executeSteps({
    jig,
    runner: new EngineRunner(),
    cache,
    mode: 'preview',
    inputs,
    params: initialParams(jig.manifest),
    isCurrent: () => checks++ < 2,
  });
  assert.equal(report.superseded, true);
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['done', 'skipped', 'skipped', 'blocked'],
  );
  assert.equal(cache.entries.size, 0);
});

test('the child process runner: budget cuts a step off and restarts, reads outside the package are denied, the environment is PATH and SystemRoot only', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vide-jig-probe-'));
  t.after(() => rmrf(root));
  const pkg = join(root, 'probe');
  mkdirSync(join(pkg, 'steps'), { recursive: true });
  mkdirSync(join(pkg, 'fixtures', 'none'), { recursive: true });
  writeFileSync(join(root, 'secret.txt'), 'not for the child');
  writeFileSync(
    join(pkg, 'jig.json'),
    JSON.stringify({
      contractVersion: 3,
      id: 'project/probe',
      version: '0.0.1',
      kind: 'tool',
      name: '탐침',
      summary: '기동 시험용',
      inputs: [],
      params: [],
      steps: [
        {
          id: 'probe',
          title: '탐침',
          kind: 'code',
          entry: 'steps/probe.ts#probe',
          reads: [],
          writes: 'probe',
          speed: 'button',
        },
        {
          id: 'slow',
          title: '느림',
          kind: 'code',
          entry: 'steps/probe.ts#slow',
          reads: [],
          writes: 'slow',
          speed: 'button',
          budget: { wallClockMs: 300 },
        },
      ],
      panel: 'panel.json',
      capabilities: [],
      selftest: { fixtures: 'fixtures', requiresHost: false },
      skill: 'skill.md',
    }),
  );
  writeFileSync(join(pkg, 'panel.json'), '{ "layout": "jig-run", "center": { "views": [] } }');
  writeFileSync(join(pkg, 'skill.md'), '---\nname: 탐침\n---\n');
  writeFileSync(join(pkg, 'fixtures', 'none', 'input.json'), '{}');
  writeFileSync(
    join(pkg, 'steps', 'probe.ts'),
    [
      "import { readFileSync } from 'node:fs';",
      'export function probe(inputs: { outside: string }) {',
      "  let code = 'READ_OK';",
      "  try { readFileSync(inputs.outside, 'utf8'); } catch (error) { code = (error as { code: string }).code; }",
      '  return { code, env: Object.keys(process.env).sort() };',
      '}',
      'export function slow() { const t = performance.now(); while (performance.now() - t < 5000) {} return { done: true }; }',
      '',
    ].join('\n'),
  );
  const jig = await loadJig(pkg);
  const runner = new ChildRunner('dev-pack', { idleMs: 60_000 });
  t.after(() => runner.close());
  await runner.load(jig);
  assert.ok(
    runner.spawnArgs()[0] === '--permission' &&
      runner.spawnArgs().filter((a) => a.startsWith('--allow-fs-read=')).length === 2,
  );
  // A parent secret must not reach the child. On Windows libuv adds its fixed required set
  // (HOMEDRIVE, USERPROFILE, TEMP…) to any child environment; nothing else may appear.
  process.env.VIDE_TEST_SECRET = 'sk-test';
  t.after(() => delete process.env.VIDE_TEST_SECRET);
  const LIBUV_REQUIRED = [
    'HOMEDRIVE',
    'HOMEPATH',
    'LOGONSERVER',
    'PATH',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'USERDOMAIN',
    'USERNAME',
    'USERPROFILE',
    'WINDIR',
  ];
  const probe = await runner.run({
    runId: 'r1',
    step: jig.manifest.steps[0],
    input: { outside: join(root, 'secret.txt') },
    params: {},
    overrides: [],
    budgetMs: 10_000,
  });
  assert.equal(probe.t, 'done');
  assert.equal(probe.output.code, 'ERR_ACCESS_DENIED');
  assert.ok(!probe.output.env.includes('VIDE_TEST_SECRET'));
  assert.ok(
    probe.output.env.every((key) => LIBUV_REQUIRED.includes(key.toUpperCase())),
    probe.output.env.join(','),
  );
  const slow = await runner.run({
    runId: 'r2',
    step: jig.manifest.steps[1],
    input: {},
    params: {},
    overrides: [],
    budgetMs: 300,
  });
  assert.deepEqual([slow.t, slow.code], ['fail', 'BUDGET']);
  const again = await runner.run({
    runId: 'r3',
    step: jig.manifest.steps[0],
    input: { outside: join(pkg, 'jig.json') },
    params: {},
    overrides: [],
    budgetMs: 10_000,
  });
  assert.equal(again.output.code, 'READ_OK');
  assert.equal(runner.spawned, 2);
  // A runner that cannot start (missing or blocked program) fails the step; the engine lives on.
  // Before PLAN-27 step 0 the unheard 'error' ended the whole engine process.
  const broken = new ChildRunner('dev-pack', {
    idleMs: 60_000,
    execPath: join(root, 'missing', 'node.exe'),
  });
  t.after(() => broken.close());
  await broken.load(jig);
  const refused = await broken.run({
    runId: 'r4',
    step: jig.manifest.steps[0],
    input: {},
    params: {},
    overrides: [],
    budgetMs: 10_000,
  });
  assert.equal(refused.t, 'fail');
  assert.match(refused.message, /ENOENT|spawn/);
});

test('validation refuses cycles and missing inputs; the self-test runs without a host', async () => {
  const validation = await validateJig(EXAMPLE);
  assert.equal(validation.ok, true);
  const report = await selftestJig(EXAMPLE, { runner: 'child', child: { idleMs: 60_000 } });
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.cases.map((c) => c.name),
    ['basic'],
  );
  assert.ok(report.cases[0].steps.every((s) => s.status === 'done' || s.status === 'confirmed'));
});

test('pack, sign and import: this PC only, same version needs the same content, forbidden files refused; the installed copy runs', async (t) => {
  const f = fixture(t);
  const { dataDir, jigStore, registry } = f;
  const packed = await packJig(EXAMPLE, { dataDir, bundle: false, skipTests: true });
  assert.equal(packed.pack.sig.keyId, keyIdOf(signingKey(dataDir)));
  assert.ok(existsSync(join(dataDir, 'jig-signing.key')));

  const result = await importPack(packed.bytes, {
    store: jigStore,
    dataDir,
    onInstalled: (id, version) => registry.forget(id, version),
  });
  assert.deepEqual(
    [result.id, result.version, result.installed],
    ['project/example-grid', '0.1.0', true],
  );
  assert.ok(result.path.endsWith(join('jigs', 'installed', 'project~example-grid@0.1.0')));
  assert.equal(jigStore.package('project/example-grid', '0.1.0').source, 'dev-pack');
  assert.equal((await importPack(packed.bytes, { store: jigStore, dataDir })).installed, false);
  const installed = await registry.resolve('project/example-grid', '0.1.0');
  assert.equal(installed.source, 'dev-pack');
  assert.equal(installed.dir, result.path);
  assert.equal((await selftestJig(installed, { child: { idleMs: 60_000 } })).ok, true);
  assert.ok(
    (await registry.list()).some((e) => e.id === 'project/example-grid' && e.stage === 'project'),
  );

  // Unsigned.
  const unsigned = decodePack(packed.bytes);
  delete unsigned.sig;
  await assert.rejects(importPack(encodePack(unsigned), { store: jigStore, dataDir }), {
    code: 'JIG_SIGNATURE',
  });
  // Another PC's key.
  const foreign = decodePack(packed.bytes);
  foreign.sig = signDigest(randomBytes(32), foreign.id, foreign.version, foreign.digest);
  await assert.rejects(importPack(encodePack(foreign), { store: jigStore, dataDir }), {
    code: 'JIG_SIGNATURE',
  });
  // Content that no longer matches its digest.
  const tampered = decodePack(packed.bytes);
  tampered.files['skill.md'] = Buffer.from('tampered').toString('base64');
  await assert.rejects(importPack(encodePack(tampered), { store: jigStore, dataDir }), {
    code: 'JIG_SIGNATURE',
  });
  // Same id and version, different content, signed here.
  const other = decodePack(packed.bytes);
  other.files['skill.md'] = Buffer.from('---\nname: 다른 내용\n---\n').toString('base64');
  other.digest = digestEntries(packEntries(other));
  other.sig = signDigest(signingKey(dataDir), other.id, other.version, other.digest);
  await assert.rejects(importPack(encodePack(other), { store: jigStore, dataDir }), {
    code: 'JIG_VERSION_EXISTS',
  });
  // A forbidden agent file, even properly signed.
  const forbidden = decodePack(packed.bytes);
  forbidden.version = '0.1.1';
  forbidden.files['jig.json'] = Buffer.from(
    Buffer.from(forbidden.files['jig.json'], 'base64')
      .toString('utf8')
      .replace('"0.1.0"', '"0.1.1"'),
  ).toString('base64');
  forbidden.files['CLAUDE.md'] = Buffer.from('# instructions').toString('base64');
  forbidden.digest = digestEntries(packEntries(forbidden));
  forbidden.sig = signDigest(
    signingKey(dataDir),
    forbidden.id,
    forbidden.version,
    forbidden.digest,
  );
  await assert.rejects(
    importPack(encodePack(forbidden), { store: jigStore, dataDir }),
    (error) =>
      error.code === 'JIG_INVALID' && error.issues.some((i) => i.code === 'JIG_FORBIDDEN_FILE'),
  );
  assert.equal(jigStore.packages().length, 1);
  assert.ok(!existsSync(join(dataDir, 'jigs', 'installed', 'project~example-grid@0.1.1')));
  assert.equal(
    readdirSync(join(dataDir, 'jigs', 'installed')).filter((n) => n.startsWith('.unpack-')).length,
    0,
  );
});

test('jig:pack bundles the steps with Vite and the installed bundle runs in the child process', async (t) => {
  const f = fixture(t);
  const packed = await packJig(EXAMPLE, { dataDir: f.dataDir, bundle: true, skipTests: true });
  assert.ok('dist/steps.mjs' in packed.pack.files);
  const result = await importPack(packed.bytes, { store: f.jigStore, dataDir: f.dataDir });
  const jig = await loadJig(result.path, { source: 'dev-pack' });
  assert.equal(jig.bundled, true);
  const report = await selftestJig(jig, { child: { idleMs: 60_000 } });
  assert.equal(
    report.ok,
    true,
    JSON.stringify(report.cases[0]?.error ?? report.cases[0]?.mismatches),
  );
});

test('routes: remote sessions cannot import or pin; pin needs confirmation; instances flow through the URLs', async (t) => {
  const f = fixture(t);
  const { workspace, project, dataDir, jigStore } = f;
  let last;
  const call = async (method, path, { payload, remote = false, bytes } = {}) => {
    last = undefined;
    const request = Object.assign(Readable.from(bytes ? [bytes] : []), { method, headers: {} });
    const handled = await jigRoutes(new URL(path, 'http://127.0.0.1'), request, {
      workspace,
      body: async () => payload ?? {},
      send: (status, data) => (last = { status, data }),
      dataDirectory: dataDir,
      remote,
    });
    return handled ? last : { status: 0, data: undefined };
  };
  const packed = await packJig(EXAMPLE, { dataDir, bundle: false, skipTests: true });
  await assert.rejects(
    call('POST', '/api/v1/jigs/import?confirm=true', { remote: true, bytes: packed.bytes }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(call('POST', '/api/v1/jigs/import', { bytes: packed.bytes }), {
    code: 'CONFIRMATION_REQUIRED',
  });
  const imported = await call('POST', '/api/v1/jigs/import?confirm=true', { bytes: packed.bytes });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.installed, true);
  const pinPath = `/api/v1/projects/${project.id}/jigs/${encodeURIComponent('project/example-grid')}/pin`;
  await assert.rejects(
    call('POST', pinPath, { remote: true, payload: { version: '0.1.0', confirm: true } }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(call('POST', pinPath, { payload: { version: '0.1.0' } }), {
    code: 'CONFIRMATION_REQUIRED',
  });
  const pinned = await call('POST', pinPath, { payload: { version: '0.1.0', confirm: true } });
  assert.equal(pinned.data.pinned.version, '0.1.0');
  assert.deepEqual(
    (await call('GET', `/api/v1/projects/${project.id}/jigs`)).data.pinned.map((p) => p.jigId),
    ['project/example-grid'],
  );
  assert.ok(
    (await call('GET', '/api/v1/jigs/packages')).data.jigs.some(
      (j) => j.id === 'project/example-grid' && j.source === 'dev-pack',
    ),
  );
  // [삭제] takes the jig off the project's list (this PC only); the package stays installed.
  await assert.rejects(call('DELETE', pinPath, { remote: true }), { code: 'FORBIDDEN' });
  const unpinned = await call('DELETE', pinPath);
  assert.equal(unpinned.status, 200);
  assert.equal(unpinned.data.removed, 'project/example-grid');
  assert.deepEqual(unpinned.data.pinned, []);
  await assert.rejects(call('DELETE', pinPath), { code: 'NOT_FOUND' });
  assert.ok(
    (await call('GET', '/api/v1/jigs/packages')).data.jigs.some(
      (j) => j.id === 'project/example-grid',
    ),
  );
  await call('POST', pinPath, { payload: { version: '0.1.0', confirm: true } });

  // An instance from the pinned version, read by syncId, assembled and run through the routes.
  const base = `/api/v1/projects/${project.id}/jig-instances`;
  const created = await call('POST', base, {
    payload: { jig: 'project/example-grid', title: '경로 시험', layerRoot: 'VIDE::격자' },
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.jig.source, 'dev-pack');
  const iid = created.data.id;
  const syncInput = {
    id: 'sync-1',
    body: 'Sync',
    permission: 'review',
    provider: 'claude-cli',
    pins: [],
    sketches: [],
    files: [],
    host: 'rhino',
    linkId: 'link-1',
  };
  const syncResult = {
    ...model(),
    sourceDocument: { ...model().sourceDocument, capturedAt: '2026-09-30T00:00:00.000Z' },
  };
  workspace.store.db
    .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
    .run(
      'sync-1',
      project.id,
      JSON.stringify(syncInput),
      'succeeded',
      JSON.stringify(syncResult),
      'now',
    );
  const read = await call('POST', `${base}/${iid}/reads`, {
    payload: {
      syncId: 'sync-1',
      linkId: 'link-1',
      layers: ['슬래브 외곽', '보이드'],
      purpose: 'assembly',
    },
  });
  assert.equal(read.data.objectCount, 2);
  assert.equal(read.data.revisionKey, 'rhino-1|7|3');
  assert.deepEqual(
    read.data.layers.map((l) => l.fullPath),
    ['슬래브 외곽', '보이드'],
  );
  assert.equal(jigStore.reads(iid).length, 1);
  const proposed = await call('POST', `${base}/${iid}/assembly/propose`, { payload: {} });
  assert.equal(proposed.data.proposals['site.outline'].candidates[0].layer, '슬래브 외곽');
  await call('PUT', `${base}/${iid}/assembly/${encodeURIComponent('site.outline')}`, {
    payload: { sources: [{ readId: read.data.readId, layers: ['슬래브 외곽'] }], confirm: true },
  });
  const params = await call('PUT', `${base}/${iid}/params`, {
    payload: {
      values: [
        { key: 'spacingX', value: 6 },
        { key: 'spacingY', value: 5 },
      ],
      reason: '시험',
    },
  });
  assert.deepEqual(params.data.seqs, [1, 2]);
  await assert.rejects(
    call('PUT', `${base}/${iid}/params`, {
      payload: { values: [{ key: 'markPrefix', value: 'P' }] },
    }),
    { code: 'PARAM_FIXED' },
  );
  const run = await call('POST', `${base}/${iid}/run`, { payload: { mode: 'geometry' } });
  assert.equal(run.data.steps[0].status, 'done');
  assert.equal(run.data.outputs.grid.columns.length, 20);
  const confirmed = await call('POST', `${base}/${iid}/steps/confirmInputs/confirm`, {
    payload: { inputHash: run.data.steps[1].inputHash },
  });
  assert.equal(confirmed.data.steps[1].status, 'confirmed');
  const full = await call('POST', `${base}/${iid}/run`, { payload: {} });
  assert.deepEqual(
    full.data.steps.map((s) => s.status),
    ['done', 'confirmed', 'done', 'done'],
  );
  const output = await call('GET', `${base}/${iid}/steps/summary/output`);
  assert.equal(output.data.output.columns, 20);
  const undone = await call('POST', `${base}/${iid}/params/undo`, { payload: { seq: 1 } });
  assert.equal(undone.data.instance.params.find((p) => p.key === 'spacingX').value, 8);
  assert.equal((await call('GET', `${base}/${iid}/params/log`)).data.log.length, 3);
  assert.equal((await call('GET', `${base}/${iid}`)).data.status, 'stale');
  assert.equal((await call('GET', base)).data.instances.length, 1);
  await assert.rejects(
    call('POST', base, { payload: { jig: 'project/nothing', title: 'x', layerRoot: 'L' } }),
    { code: 'NOT_FOUND' },
  );
  assert.equal((await call('GET', '/api/v1/projects/p/jigs/sync')).status, 0);
});

// ARCH-03 §6.2·§6.3 (PLAN-23 T-056): a step that reads itself gets its previous kept output, also
// after a failed run and across a restart; a step output's `apply.overrides` is written into the
// instance once, which makes the confirmation that led to it wait again.
const PRIOR_STEPS = `
export function counter(inputs, params) {
  if (params.spacingX > 12) throw new Error('너무 넓음');
  const prior = inputs.steps.counter;
  return { runs: (prior?.runs ?? 0) + 1, sawPrior: prior !== null && prior !== undefined };
}
export function asker(inputs) {
  const n = inputs.steps.counter.runs;
  return {
    n,
    apply: {
      overrides: [
        { id: 'demo:k1', target: { kind: 'member', identity: { key: 'k1' } }, op: 'set',
          fields: { section: 'H-200x100x5.5x8', n }, origin: 'table', by: 'user' },
        { target: { kind: 'member', identity: { key: 'no-id' } }, op: 'set', fields: {},
          origin: 'table', by: 'user' },
      ],
    },
  };
}
`;
function priorJig(root) {
  const dir = join(root, 'jigs', 'prior-demo');
  mkdirSync(join(dir, 'steps'), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(EXAMPLE, 'jig.json'), 'utf8'));
  for (const name of ['panel.json', 'skill.md']) cpSync(join(EXAMPLE, name), join(dir, name));
  cpSync(join(EXAMPLE, 'steps'), join(dir, 'steps'), { recursive: true });
  cpSync(join(EXAMPLE, 'schemas'), join(dir, 'schemas'), { recursive: true });
  cpSync(join(EXAMPLE, 'fixtures'), join(dir, 'fixtures'), { recursive: true });
  cpSync(join(EXAMPLE, 'reports'), join(dir, 'reports'), { recursive: true });
  writeFileSync(join(dir, 'steps', 'prior.ts'), PRIOR_STEPS);
  manifest.id = 'project/prior-demo';
  manifest.steps.push(
    {
      id: 'counter',
      title: '횟수',
      kind: 'code',
      entry: 'steps/prior.ts#counter',
      reads: ['step.counter', 'param.spacingX'],
      writes: 'counter',
      speed: 'release',
    },
    {
      id: 'applyIt',
      title: '적용 확인',
      kind: 'human',
      slot: 'confirm-inputs',
      needs: ['counter'],
      reads: ['step.counter'],
      writes: 'applyIt',
      speed: 'confirm',
      blocks: ['asker'],
    },
    {
      id: 'asker',
      title: '적용',
      kind: 'code',
      entry: 'steps/prior.ts#asker',
      needs: ['applyIt'],
      reads: ['step.counter'],
      writes: 'asker',
      speed: 'button',
    },
  );
  writeFileSync(join(dir, 'jig.json'), JSON.stringify(manifest, null, 2));
  return join(root, 'jigs');
}

test('prior outputs and apply requests: kept across runs, failures and restarts; applied once', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vide-jig-prior-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const devRoot = priorJig(root);
  const filename = join(root, 'workspace.sqlite');
  let state;
  const open = () => {
    const store = new Store(filename);
    const jigStore = new JigStore(store.db);
    const registry = new JigRegistry({ store: jigStore, dataDir, devRoots: [devRoot] });
    const runtime = new JigRuntime({
      store: jigStore,
      dataDir,
      registry,
      child: { idleMs: 60_000 },
    });
    state = { store, jigStore, runtime };
    return state;
  };
  t.after(async () => {
    await state?.runtime.close();
    state?.store.close();
    rmrf(root);
  });
  let { store, jigStore, runtime } = open();
  const project = store.createProject('이전 출력');
  const created = await runtime.createInstance(project.id, {
    jig: 'project/prior-demo',
    title: '이전 출력 A',
    layerRoot: 'VIDE::이전',
  });
  const status = (r, id) => r.steps.find((s) => s.id === id).status;
  const out = (r) => r.outputs.counter;

  const first = await runtime.run(project.id, created.id, { mode: 'geometry' });
  assert.deepEqual(out(first), { runs: 1, sawPrior: false });
  assert.equal(status(first, 'applyIt'), 'waiting');
  // Same fingerprint: the cached result, whatever the prior was.
  const same = await runtime.run(project.id, created.id, { mode: 'geometry' });
  assert.equal(same.steps.find((s) => s.id === 'counter').cached, true);
  assert.equal(
    same.steps.find((s) => s.id === 'counter').inputHash,
    first.steps.find((s) => s.id === 'counter').inputHash,
  );
  // A setting change recomputes with the previous output.
  await runtime.setParams(project.id, created.id, {
    values: [{ key: 'spacingX', value: 9 }],
    by: 'user',
  });
  const second = await runtime.run(project.id, created.id, { mode: 'geometry' });
  assert.deepEqual(out(second), { runs: 2, sawPrior: true });
  // A failed run keeps the last kept result as the prior.
  await runtime.setParams(project.id, created.id, {
    values: [{ key: 'spacingX', value: 14 }],
    by: 'user',
  });
  const failed = await runtime.run(project.id, created.id, { mode: 'geometry' });
  assert.equal(status(failed, 'counter'), 'failed');
  assert.ok(jigStore.run(created.id, 'counter').outputRef);
  // …and across a restart.
  await state.runtime.close();
  state.store.close();
  ({ store, jigStore, runtime } = open());
  await runtime.setParams(project.id, created.id, {
    values: [{ key: 'spacingX', value: 10 }],
    by: 'user',
  });
  const third = await runtime.run(project.id, created.id, { mode: 'geometry' });
  assert.deepEqual(out(third), { runs: 3, sawPrior: true });

  // Confirmed: the action step asks for overrides; only the one with an id is written, once.
  await runtime.confirmStep(
    project.id,
    created.id,
    'applyIt',
    third.steps.find((s) => s.id === 'applyIt').inputHash,
  );
  const applied = await runtime.run(project.id, created.id, { mode: 'geometry' });
  const overrides = (await runtime.view(project.id, created.id)).body.overrides;
  assert.deepEqual(
    overrides.map((o) => [o.id, o.fields.n]),
    [['demo:k1', 3]],
  );
  // The overrides changed every fingerprint: the returned run is the one after writing them.
  assert.equal(status(applied, 'applyIt'), 'reconfirm');
  assert.equal(status(applied, 'asker'), 'blocked');
  assert.deepEqual(applied.applies, []);
  assert.deepEqual(out(applied), { runs: 4, sawPrior: true });
  // Confirmed again (the counter is cached at 4): the same id replaces the earlier override.
  await runtime.confirmStep(
    project.id,
    created.id,
    'applyIt',
    applied.steps.find((s) => s.id === 'applyIt').inputHash,
  );
  await runtime.run(project.id, created.id, { mode: 'geometry' });
  const replaced = (await runtime.view(project.id, created.id)).body.overrides;
  assert.deepEqual(
    replaced.map((o) => [o.id, o.fields.n]),
    [['demo:k1', 4]],
  );
});
