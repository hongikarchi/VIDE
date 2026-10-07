import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveValues,
  forbiddenFiles,
  manifestSchema,
  satisfies,
  validateManifest,
} from '../../src/jigs/runtime/manifest.ts';
import { buildGraph, parseRead } from '../../src/jigs/runtime/graph.ts';
import { GATES, GATE_NAMES, runGates } from '../../src/jigs/runtime/gates.ts';
import {
  applyChanges,
  initialParams,
  toDisplay,
  toStorage,
  undoChange,
} from '../../src/jigs/runtime/params.ts';
import { JigRegistry, listPackageFiles, loadJig } from '../../src/jigs/runtime/loader.ts';
import { JIG_ICONS, LEGACY_JIG_ICONS } from '../../src/contracts/jig-icons.ts';

// jig.json v3 (ARCH-03 §3, SPEC-07.15): the synthetic example jig is the base; each case mutates a
// copy and expects one issue code. No S-06 values anywhere.
const EXAMPLE = join(import.meta.dirname, '..', '..', 'extensions', 'jigs', 'example-grid');
const base = () => JSON.parse(readFileSync(join(EXAMPLE, 'jig.json'), 'utf8'));
const files = listPackageFiles(EXAMPLE);
const codes = (result) => result.issues.filter((i) => i.level === 'error').map((i) => i.code);
const libraries = {
  'vide/geometry-kit': { version: '0.2.0' },
  'vide/structure-analysis': { version: '0.1.0' },
};

test('the example manifest validates with its files and derives ai/runtime values', () => {
  const result = validateManifest(base(), { files, libraries });
  assert.deepEqual(codes(result), []);
  assert.equal(result.manifest.id, 'project/example-grid');
  assert.deepEqual(result.derived.ai, { required: false, steps: [] });
  assert.equal(result.derived.runtimes.grid, 'child');
  assert.equal(
    validateManifest(base(), { files, source: 'builtin' }).derived.runtimes.grid,
    'engine',
  );
  assert.equal(
    validateManifest(base(), { files, source: 'ai-draft' }).derived.runtimes.grid,
    'box',
  );
  assert.equal(result.derived.runtimes.confirmInputs, 'screen');
});

test('unknown fields, bad ids and wrong contract versions are schema errors', () => {
  const extra = base();
  extra.unexpected = 1;
  assert.deepEqual(codes(validateManifest(extra)), ['JIG_SCHEMA']);
  const badId = base();
  badId.id = 'Example Grid';
  assert.deepEqual(codes(validateManifest(badId)), ['JIG_SCHEMA']);
  const badVersion = base();
  badVersion.contractVersion = 2;
  assert.equal(manifestSchema.safeParse(badVersion).success, false);
});

test('icon: optional, a name from the fixed list only (PLAN-26 T-100)', async () => {
  assert.equal(base().icon, 'grid', 'the grid example names its icon');
  const none = base();
  delete none.icon;
  assert.deepEqual(codes(validateManifest(none, { files, libraries })), []);
  for (const icon of JIG_ICONS) {
    const named = base();
    named.icon = icon;
    assert.deepEqual(codes(validateManifest(named, { files, libraries })), [], icon);
  }
  for (const icon of ['Wrench', 'rocket', '', 3]) {
    const other = base();
    other.icon = icon;
    assert.deepEqual(codes(validateManifest(other, { files, libraries })), ['JIG_SCHEMA'], icon);
  }
  // The registry lists the icon; a built-in screen jig has a fixed one.
  const registry = new JigRegistry({ dataDir: EXAMPLE, devRoots: [join(EXAMPLE, '..')] });
  const listed = (await registry.list()).find((entry) => entry.id === 'project/example-grid');
  assert.equal(listed.icon, 'grid');
  assert.ok(Object.values(LEGACY_JIG_ICONS).every((icon) => JIG_ICONS.includes(icon)));
});

test('references: missing settings, steps, inputs and roles; duplicate ids; cycles', () => {
  const missingParam = base();
  missingParam.steps[0].reads.push('param.nothing');
  assert.ok(codes(validateManifest(missingParam)).includes('JIG_REF_MISSING'));
  const missingRole = base();
  missingRole.steps[0].reads.push('input.site.nothing');
  assert.ok(codes(validateManifest(missingRole)).includes('JIG_REF_MISSING'));
  const affectsMissing = base();
  affectsMissing.params[0].affects = ['nothing'];
  assert.ok(codes(validateManifest(affectsMissing)).includes('JIG_REF_MISSING'));
  const duplicate = base();
  duplicate.steps.push({ ...duplicate.steps[3], writes: 'again' });
  assert.ok(codes(validateManifest(duplicate)).includes('JIG_DUPLICATE'));
  const cycle = base();
  cycle.steps[0].reads.push('step.summary');
  assert.ok(codes(validateManifest(cycle)).includes('JIG_CYCLE'));
  const { cycle: left } = buildGraph(cycle);
  assert.ok(left.includes('grid') && left.includes('summary'));
});

test('gates: unknown names, wrong timing, AI steps need an after-ai gate, pending gates warn', () => {
  const unknown = base();
  unknown.steps[0].gates.push({ use: 'made-up' });
  assert.ok(codes(validateManifest(unknown)).includes('JIG_GATE_UNKNOWN'));
  const timing = base();
  timing.steps[0].gates.push({ use: 'hidden-target' });
  assert.ok(codes(validateManifest(timing)).includes('JIG_GATE_TIMING'));
  const ai = base();
  ai.capabilities.push({ name: 'ai.once', reason: '역할 제안' });
  ai.steps.push({
    id: 'suggest',
    title: '제안',
    kind: 'ai',
    prompt: 'prompts/suggest.md',
    authority: 'draft-only',
    reads: ['input.site'],
    writes: 'suggest',
    speed: 'button',
  });
  assert.ok(codes(validateManifest(ai)).includes('JIG_AI_GATE_REQUIRED'));
  ai.steps.at(-1).gates = [{ use: 'ref-whitelist' }];
  const withGate = validateManifest(ai);
  assert.ok(!codes(withGate).includes('JIG_AI_GATE_REQUIRED'));
  assert.ok(withGate.issues.some((i) => i.code === 'JIG_GATE_PENDING' && i.level === 'warn'));
  assert.deepEqual(withGate.derived.ai, { required: true, steps: ['suggest'] });
  for (const name of GATE_NAMES) assert.ok(GATES[name].timing && GATES[name].level, name);
});

test('capabilities: closed vocabulary, official-only names, reserved names, required declarations', () => {
  const outside = base();
  outside.capabilities.push({ name: 'fs.write', reason: '파일' });
  assert.ok(codes(validateManifest(outside)).includes('JIG_CAPABILITY'));
  const official = base();
  official.capabilities.push({ name: 'net.fetch', reason: '외부' });
  assert.ok(codes(validateManifest(official)).includes('JIG_CAPABILITY'));
  official.id = 'vide/example-grid';
  assert.ok(!codes(validateManifest(official)).includes('JIG_CAPABILITY'));
  const reserved = base();
  reserved.capabilities.push({ name: 'host.ops', reason: '조작' });
  assert.ok(codes(validateManifest(reserved)).includes('JIG_CAPABILITY'));
  const missing = base();
  missing.capabilities = [];
  assert.ok(codes(validateManifest(missing)).includes('JIG_CAPABILITY_MISSING'));
  const library = base();
  library.steps.push({
    id: 'lib',
    title: '라이브러리',
    kind: 'library',
    use: 'vide/geometry-kit#polygonArea',
    reads: ['step.grid'],
    writes: 'lib',
    speed: 'release',
  });
  assert.ok(codes(validateManifest(library)).includes('JIG_CAPABILITY_MISSING'));
  library.capabilities.push({ name: 'library.call', reason: '기하' });
  assert.deepEqual(codes(validateManifest(library, { libraries })), []);
  library.steps.at(-1).use = 'vide/nothing#fn';
  assert.ok(codes(validateManifest(library, { libraries })).includes('JIG_LIBRARY_UNKNOWN'));
  const uses = base();
  uses.uses = [{ id: 'vide/geometry-kit', range: '^1.0.0' }];
  assert.ok(codes(validateManifest(uses, { libraries })).includes('JIG_LIBRARY_UNKNOWN'));
  uses.uses = [{ id: 'vide/geometry-kit', range: '^0.2.0' }];
  assert.deepEqual(codes(validateManifest(uses, { libraries })), []);
});

test('service.clawde: official built-in jigs only; project, dev and AI-draft jigs are refused', () => {
  // ARCH-01 「jig 능력」, PLAN-46 T-218: the engine gives the service's read results to the official
  // 법규 jig only. Sending back is no capability at all.
  const withService = (id) => {
    const manifest = base();
    manifest.id = id;
    manifest.capabilities.push({ name: 'service.clawde', reason: '법규 답 읽기' });
    return manifest;
  };
  for (const source of ['dev-source', 'dev-pack', 'ai-draft'])
    assert.ok(
      codes(validateManifest(withService('vide/example-grid'), { source })).includes(
        'JIG_CAPABILITY',
      ),
      `vide/* from ${source}`,
    );
  assert.ok(
    codes(validateManifest(withService(base().id), { source: 'builtin' })).includes(
      'JIG_CAPABILITY',
    ),
    'a project jig id, even as built in',
  );
  assert.deepEqual(
    codes(validateManifest(withService('vide/example-grid'), { source: 'builtin' })),
    [],
  );
  const send = base();
  send.id = 'vide/example-grid';
  send.capabilities.push({ name: 'service.clawde.contribute', reason: '역전송' });
  assert.ok(codes(validateManifest(send, { source: 'builtin' })).includes('JIG_CAPABILITY'));
});

test('settings: units by type, ranges, defaults and choices', () => {
  const unit = base();
  unit.params[0].unit = 'kN';
  assert.ok(codes(validateManifest(unit)).includes('JIG_PARAM'));
  const range = base();
  range.params[0].default = 100;
  assert.ok(codes(validateManifest(range)).includes('JIG_PARAM'));
  const choice = base();
  choice.params[5].default = 'Z';
  assert.ok(codes(validateManifest(choice)).includes('JIG_PARAM'));
  const count = base();
  count.params.push({
    key: 'bays',
    title: '칸 수',
    group: '격자',
    type: 'count',
    unit: 'EA',
    default: 2.5,
    affects: [],
  });
  assert.ok(codes(validateManifest(count)).includes('JIG_PARAM'));
});

test('files: declared files must exist, forbidden agent files fail, fixtures are required', () => {
  const result = validateManifest(base(), { files: files.filter((f) => f !== 'panel.json') });
  assert.ok(codes(result).includes('JIG_FILE_MISSING'));
  const forbidden = validateManifest(base(), {
    files: [...files, 'CLAUDE.md', '.claude/settings.json', 'sub/AGENTS.md', '.mcp.json'],
  });
  assert.equal(codes(forbidden).filter((c) => c === 'JIG_FORBIDDEN_FILE').length, 4);
  assert.deepEqual(forbiddenFiles(['a/b.ts', '.codex/x', 'GEMINI.md', 'docs/GEMINI.md.txt']), [
    '.codex/x',
    'GEMINI.md',
  ]);
  const noFixtures = validateManifest(base(), {
    files: files.filter((f) => !f.startsWith('fixtures/')),
  });
  assert.ok(codes(noFixtures).includes('JIG_FILE_MISSING'));
});

test('derived values declared in the manifest must match the recomputation', () => {
  const declared = base();
  declared.derived = { ai: { required: true, steps: ['grid'] } };
  assert.ok(codes(validateManifest(declared)).includes('JIG_DERIVED_MISMATCH'));
  declared.derived = { ai: { required: false, steps: [] }, runtimes: { grid: 'engine' } };
  assert.ok(
    codes(validateManifest(declared, { source: 'dev-pack' })).includes('JIG_DERIVED_MISMATCH'),
  );
  assert.deepEqual(codes(validateManifest(declared, { source: 'builtin' })), []);
  const manifest = validateManifest(base()).manifest;
  assert.equal(deriveValues(manifest, 'dev-pack').runtimes.beams, 'child');
});

test('semver ranges and read parsing', () => {
  assert.ok(satisfies('0.2.3', '^0.2.0') && !satisfies('0.3.0', '^0.2.0'));
  assert.ok(satisfies('1.4.0', '^1.2.0') && !satisfies('2.0.0', '^1.2.0'));
  assert.ok(satisfies('1.2.9', '~1.2.0') && !satisfies('1.3.0', '~1.2.0'));
  assert.ok(
    satisfies('1.0.0', '>=0.9.0 <2.0.0') && satisfies('9.9.9', '*') && satisfies('1.0.0', '1.0.0'),
  );
  assert.deepEqual(parseRead('input.site.outline'), {
    kind: 'input',
    key: 'site',
    role: 'outline',
    text: 'input.site.outline',
  });
  assert.deepEqual(parseRead('param.spacingX'), {
    kind: 'param',
    key: 'spacingX',
    text: 'param.spacingX',
  });
  assert.equal(parseRead('nothing.here'), null);
});

test('the step graph orders steps and finds what a setting or input change touches', () => {
  const manifest = validateManifest(base()).manifest;
  const { graph, cycle } = buildGraph(manifest);
  assert.deepEqual(cycle, []);
  assert.deepEqual(graph.order, ['grid', 'confirmInputs', 'beams', 'summary']);
  assert.deepEqual(graph.affectedByParams(['spacingX']), [
    'grid',
    'confirmInputs',
    'beams',
    'summary',
  ]);
  assert.deepEqual(graph.affectedByParams(['columnSize']), ['beams', 'summary']);
  assert.deepEqual(graph.affectedByInputs(['keepOut']), [
    'grid',
    'confirmInputs',
    'beams',
    'summary',
  ]);
  assert.deepEqual(graph.affectedByInputs(['site.voids']), [
    'grid',
    'confirmInputs',
    'beams',
    'summary',
  ]);
});

test('settings: SI storage, display units, ranges, fixedAtPin, provenance and undo', () => {
  const manifest = validateManifest(base()).manifest;
  const column = manifest.params.find((p) => p.key === 'columnSize');
  assert.equal(toStorage(column, 600, 'mm'), 0.6);
  assert.equal(toDisplay(column, 0.6), 600);
  const ratio = manifest.params.find((p) => p.key === 'beamDepthRatio');
  assert.equal(toDisplay(ratio, 0.07), 7);
  assert.equal(toStorage(ratio, 7, '%'), 0.07);
  const initial = initialParams(manifest, '2026-09-30T00:00:00.000Z');
  assert.equal(initial.spacingX.by, 'default');
  const { next, entries, keys } = applyChanges(
    manifest,
    initial,
    [
      { key: 'spacingX', value: 9 },
      { key: 'columnSize', value: 700, unit: 'mm' },
    ],
    { by: 'user', at: 't1' },
  );
  assert.deepEqual(keys, ['spacingX', 'columnSize']);
  assert.equal(next.spacingX.value, 9);
  assert.equal(next.columnSize.value, 0.7);
  assert.equal(entries[0].old.value, 8);
  assert.throws(
    () => applyChanges(manifest, next, [{ key: 'spacingX', value: 99 }], { by: 'user' }),
    { code: 'OUT_OF_RANGE' },
  );
  assert.throws(
    () => applyChanges(manifest, next, [{ key: 'markPrefix', value: 'P' }], { by: 'user' }),
    { code: 'PARAM_FIXED' },
  );
  assert.throws(
    () => applyChanges(manifest, next, [{ key: 'markPrefix', value: 'P' }], { by: 'ai' }),
    { code: 'PARAM_FIXED' },
  );
  assert.equal(
    applyChanges(manifest, next, [{ key: 'markPrefix', value: 'P' }], { by: 'user', atPin: true })
      .next.markPrefix.value,
    'P',
  );
  assert.throws(
    () =>
      applyChanges(manifest, next, [{ key: 'markPrefix', value: 'Q' }], {
        by: 'user',
        atPin: true,
      }),
    { code: 'INVALID_INPUT' },
  );
  assert.throws(
    () => applyChanges(manifest, next, [{ key: 'nothing', value: 1 }], { by: 'user' }),
    { code: 'NOT_FOUND' },
  );
  assert.throws(
    () => applyChanges(manifest, next, [{ key: 'spacingX', value: 'nine' }], { by: 'user' }),
    { code: 'INVALID_INPUT' },
  );
  const fact = applyChanges(
    manifest,
    next,
    [{ key: 'spacingY', value: 7, ref: 'kdb:S1', status: 'ai' }],
    { by: 'fact' },
  ).next.spacingY;
  assert.deepEqual(
    { by: fact.by, ref: fact.ref, status: fact.status },
    { by: 'fact', ref: 'kdb:S1', status: 'ai' },
  );
  const undo = undoChange(manifest, { key: 'spacingX', old: entries[0].old, new: entries[0].new });
  assert.equal(undo.value, 8);
});

test('gates: polygon-valid, ring-orientation, no-nan, ids-stable, inside-boundary isolate, basis-required, hidden-target, analysis-confirmed', () => {
  const manifest = validateManifest(base()).manifest;
  const ctx = (extra) => ({
    manifest,
    stepId: 'grid',
    inputs: {},
    params: initialParams(manifest),
    ...extra,
  });
  const square = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ];
  const bow = [
    [0, 0],
    [4, 0],
    [1, 3],
    [3, -1],
  ];
  const output = {
    items: [
      { key: 'a', shape: square },
      { key: 'b', shape: bow },
      { key: 'c', shape: [...square].reverse() },
    ],
  };
  const valid = runGates(
    [{ use: 'polygon-valid', args: { items: 'items' } }],
    'after-run',
    ctx({ output }),
  );
  assert.deepEqual(valid.blocked, ['polygon-valid']);
  assert.deepEqual(valid.results[0].failed, ['b:self-intersection']);
  const isolated = runGates(
    [{ use: 'polygon-valid', level: 'isolate', args: { items: 'items' } }],
    'after-run',
    ctx({ output }),
  );
  assert.deepEqual(isolated.blocked, []);
  assert.equal(isolated.output.items.length, 2);
  assert.equal(isolated.results[0].isolated, 1);
  const orientation = runGates(
    [{ use: 'ring-orientation', args: { items: 'items' } }],
    'after-run',
    ctx({ output: { items: [output.items[0], output.items[2]] } }),
  );
  assert.deepEqual(orientation.results[0].failed, ['c']);
  const nan = runGates(
    [{ use: 'no-nan' }],
    'after-run',
    ctx({ output: { a: [1, { b: Number.NaN }] } }),
  );
  assert.deepEqual(nan.results[0].failed, ['a[1].b']);
  const ids = runGates(
    [{ use: 'ids-stable', args: { items: 'columns' } }],
    'after-run',
    ctx({ output: { columns: [{ key: 'x' }, { key: 'x' }, { at: 1 }] } }),
  );
  assert.deepEqual(ids.results[0].failed, ['x', '#2']);
  const drift = runGates(
    [{ use: 'ids-stable', args: { items: 'columns' } }],
    'after-run',
    ctx({
      output: { columns: [{ key: 'x' }] },
      inputHash: 'h',
      previous: { inputHash: 'h', output: { columns: [{ key: 'y' }] } },
    }),
  );
  assert.equal(drift.results[0].ok, false);
  const boundary = runGates(
    [
      {
        use: 'inside-boundary',
        level: 'isolate',
        args: { items: 'columns', field: 'at', boundary: 'site.outline' },
      },
    ],
    'after-run',
    ctx({
      inputs: { site: { outline: square } },
      output: {
        columns: [
          { key: 'in', at: [1, 1] },
          { key: 'out', at: [9, 9] },
        ],
      },
    }),
  );
  assert.deepEqual(boundary.results[0].failed, ['out']);
  assert.deepEqual(
    boundary.output.columns.map((c) => c.key),
    ['in'],
  );
  const params = initialParams(manifest);
  const toAsk = {
    ...manifest,
    params: manifest.params.map((p) =>
      p.key === 'angle' ? { ...p, basis: { status: 'to-ask', question: '각도?' } } : p,
    ),
  };
  const basis = runGates([{ use: 'basis-required' }], 'before-run', {
    ...ctx({}),
    manifest: toAsk,
    params,
  });
  assert.deepEqual(basis.results[0].failed, ['angle']);
  assert.deepEqual(basis.blocked, []);
  assert.deepEqual(
    runGates([{ use: 'basis-required', level: 'block' }], 'before-run', {
      ...ctx({}),
      manifest: toAsk,
      params,
    }).blocked,
    ['basis-required'],
  );
  const hidden = runGates(
    [{ use: 'hidden-target' }, { use: 'layer-scope' }],
    'before-bake',
    ctx({
      layerRoot: 'A',
      bake: {
        targets: [
          { key: 'k1', layer: 'A::x', visible: false, locked: false },
          { key: 'k2', layer: 'A::x', visible: true, locked: false },
        ],
        layers: ['A::x', 'B'],
      },
    }),
  );
  assert.deepEqual(hidden.results[0].failed, ['k1']);
  assert.deepEqual(hidden.results[1].failed, ['B']);
  const analysis = runGates(
    [{ use: 'analysis-confirmed' }],
    'before-bake',
    ctx({ inputHash: 'abc', hooks: { analysisConfirmed: (hash) => hash === 'abc' } }),
  );
  assert.equal(analysis.results[0].ok, true);
  assert.deepEqual(
    runGates([{ use: 'analysis-confirmed' }], 'before-bake', ctx({ inputHash: 'abc' })).blocked,
    ['analysis-confirmed'],
  );
  const fact = runGates(
    [{ use: 'fact-valid' }],
    'before-run',
    ctx({
      params: { ...params, spacingX: { value: 8, by: 'fact', status: 'contaminated', at: 't' } },
    }),
  );
  assert.deepEqual(fact.results[0].failed, ['spacingX']);
  const pending = runGates([{ use: 'no-overlap' }], 'after-run', ctx({ output: {} }));
  assert.deepEqual(pending.blocked, ['no-overlap']);
});

test('loadJig reads the example package, lists its files and digests them', async () => {
  const jig = await loadJig(EXAMPLE);
  assert.equal(jig.id, 'project/example-grid');
  assert.equal(jig.source, 'dev-source');
  assert.match(jig.digest, /^[a-f0-9]{64}$/);
  assert.ok(
    jig.files.includes('steps/grid.ts') && jig.files.includes('fixtures/basic/expect.json'),
  );
  assert.equal(jig.bundled, false);
  await assert.rejects(loadJig(join(EXAMPLE, 'steps')), { code: 'JIG_INVALID' });
});
