import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ComputeBoxRunner, officialBoxLibraries } from '../../src/jigs/runtime/compute-box.ts';
import { loadJig } from '../../src/jigs/runtime/loader.ts';
import { MemoryCache, executeSteps } from '../../src/jigs/runtime/runner.ts';
import { initialParams } from '../../src/jigs/runtime/params.ts';

// A package handle for the box: it reads only `dir` and `files`.
function fakeJig(files) {
  const dir = mkdtempSync(join(tmpdir(), 'vide-box-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { dir, files: Object.keys(files).sort(), source: 'ai-draft', bundled: false };
}
const request = (entry, input = {}, budgetMs = 2000) => ({
  runId: 'r1',
  step: { id: 's', kind: 'code', entry },
  input,
  params: { k: 2 },
  overrides: [],
  budgetMs,
});
async function run(files, entry, input, budgetMs, options) {
  const jig = fakeJig(files);
  const box = new ComputeBoxRunner(options);
  try {
    await box.load(jig);
    return await box.run(request(entry, input, budgetMs));
  } finally {
    await box.close();
    rmSync(jig.dir, { recursive: true, force: true });
  }
}

test('a typed step runs with JSON in and out and imports its own files', async () => {
  const out = await run(
    {
      'steps/a.ts': `import { twice } from './util.ts';
        import type { X } from './types.ts';
        export function a(inputs: { xs: number[] }, params: { k: number }): { sum: number } {
          return { sum: twice(inputs.xs.reduce((s, v) => s + v, 0)) * params.k };
        }`,
      'steps/util.ts': 'export const twice = (v: number): number => v * 2;',
    },
    'steps/a.ts#a',
    { xs: [1, 2, 3] },
  );
  assert.equal(out.t, 'done', JSON.stringify(out));
  assert.deepEqual(out.output, { sum: 24 });
});

test('fetch, require, process, timers and other host APIs are not defined', async () => {
  const out = await run(
    {
      'steps/probe.js': `export function probe() {
        return [typeof fetch, typeof require, typeof process, typeof setTimeout, typeof XMLHttpRequest,
          typeof WebAssembly, typeof std, typeof os, typeof Deno, typeof importScripts, typeof module];
      }`,
    },
    'steps/probe.js#probe',
  );
  assert.equal(out.t, 'done', JSON.stringify(out));
  assert.ok(
    out.output.every((kind) => kind === 'undefined'),
    JSON.stringify(out.output),
  );
});

test('imports of Node modules, other folders or unknown libraries are refused', async () => {
  for (const spec of ['node:fs', 'fs', 'child_process', '../outside.js', 'vide/unknown']) {
    const out = await run(
      { 'steps/x.js': `import * as m from '${spec}'; export const x = () => Object.keys(m);` },
      'steps/x.js#x',
    );
    assert.equal(out.t, 'fail', spec);
    assert.equal(out.code, 'THROW', spec);
  }
});

test('an endless loop is cut at the budget', async () => {
  const start = Date.now();
  const out = await run(
    { 'steps/loop.js': 'export const loop = () => { for (;;) {} };' },
    'steps/loop.js#loop',
    {},
    150,
  );
  assert.equal(out.t, 'fail');
  assert.equal(out.code, 'BUDGET');
  assert.ok(Date.now() - start < 3000);
});

test('memory beyond the limit is cut and the next run still works', async () => {
  const out = await run(
    {
      'steps/grow.js':
        'export const grow = () => { const a = []; for (;;) a.push("x".repeat(1024) + a.length); };',
    },
    'steps/grow.js#grow',
    {},
    10000,
    { memoryBytes: 8 * 1024 * 1024 },
  );
  assert.equal(out.t, 'fail');
  assert.equal(out.code, 'BUDGET');
  assert.equal(out.message, 'MEMORY');
  const again = await run({ 'steps/ok.js': 'export const ok = () => 1;' }, 'steps/ok.js#ok');
  assert.deepEqual(again.output, 1);
});

test('official libraries are injected; the analysis runners are not', async () => {
  const libraries = await officialBoxLibraries();
  assert.ok(Object.keys(libraries['vide/geometry-kit'].functions).length > 5);
  assert.equal(libraries['vide/structure-analysis'].functions.runAnalysis, undefined);
  const out = await run(
    {
      'steps/lib.ts': `import * as kit from 'vide/geometry-kit';
        import { stableMarks, library } from 'vide/structure-analysis';
        export function lib() {
          return { kit: Object.keys(kit).length, marks: typeof stableMarks, id: library.id };
        }`,
    },
    'steps/lib.ts#lib',
  );
  assert.equal(out.t, 'done', JSON.stringify(out));
  assert.ok(out.output.kit > 5);
  assert.equal(out.output.marks, 'function');
  assert.equal(out.output.id, 'vide/structure-analysis');
  const refused = await run(
    {
      'steps/r.js':
        "import { runAnalysis } from 'vide/structure-analysis'; export const r = () => typeof runAnalysis;",
    },
    'steps/r.js#r',
  );
  assert.equal(refused.t, 'fail');
});

test('a library call crosses the box as JSON', async () => {
  const out = await run(
    { 'steps/c.js': "import { twice } from 'lib/test'; export const c = () => twice({ v: 21 });" },
    'steps/c.js#c',
    {},
    2000,
    {
      libraries: async () => ({
        'lib/test': {
          functions: { twice: (arg) => ({ v: arg.v * 2, host: typeof arg }) },
          values: {},
        },
      }),
    },
  );
  assert.deepEqual(out.output, { v: 42, host: 'object' });
});

test('an async step, a thrown error and a missing entry', async () => {
  const done = await run(
    { 'steps/a.js': 'export async function a() { return { ok: true }; }' },
    'steps/a.js#a',
  );
  assert.deepEqual(done.output, { ok: true });
  const thrown = await run(
    { 'steps/t.js': 'export function t() { throw new Error("나쁜 입력"); }' },
    'steps/t.js#t',
  );
  assert.equal(thrown.code, 'THROW');
  assert.match(thrown.message, /나쁜 입력/);
  const missing = await run({ 'steps/t.js': 'export const t = 1;' }, 'steps/t.js#nope');
  assert.equal(missing.code, 'THROW');
  assert.match(missing.message, /STEP_MISSING/);
});

test('the example grid jig runs in the box through the step executor', async () => {
  const dir = join(import.meta.dirname, '..', '..', 'extensions', 'jigs', 'example-grid');
  const jig = await loadJig(dir, { source: 'ai-draft' });
  const box = new ComputeBoxRunner();
  const input = JSON.parse(readFileSync(join(dir, 'fixtures', 'basic', 'input.json'), 'utf8'));
  const report = await executeSteps({
    jig,
    runner: box,
    cache: new MemoryCache(),
    mode: 'selftest',
    inputs: input,
    params: initialParams(jig.manifest),
  });
  await box.close();
  const status = (id) => report.steps.find((s) => s.id === id)?.status;
  assert.equal(status('grid'), 'done', JSON.stringify(report.steps));
  assert.equal(status('beams'), 'done', JSON.stringify(report.steps));
  assert.ok(report.outputs.grid.columns.length > 0);
});

test('a 1,000-element combining step stays within 200 ms', async () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({
    key: `col:${i}`,
    at: [i % 40, Math.floor(i / 40)],
  }));
  const files = {
    'steps/pair.ts': `export function pair(inputs: { items: { key: string; at: number[] }[] }) {
      const byRow = new Map<number, { key: string; at: number[] }[]>();
      for (const item of inputs.items) { const row = byRow.get(item.at[1]) ?? []; row.push(item); byRow.set(item.at[1], row); }
      const pairs: { key: string; gap: number }[] = [];
      for (const row of byRow.values()) { row.sort((a, b) => a.at[0] - b.at[0]);
        for (let i = 1; i < row.length; i++) pairs.push({ key: row[i - 1].key + '>' + row[i].key, gap: row[i].at[0] - row[i - 1].at[0] }); }
      return { pairs, count: pairs.length };
    }`,
  };
  await run(files, 'steps/pair.ts#pair', { items: items.slice(0, 10) }); // warm the wasm module
  const out = await run(files, 'steps/pair.ts#pair', { items });
  assert.equal(out.t, 'done', JSON.stringify(out));
  assert.equal(out.output.count, 1000 - 25);
  assert.ok(out.ms <= 200, `${out.ms} ms`);
});

test('library and module names reach only the injected libraries, never Object members', async () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const imported = await run(
      { 'a.js': `import * as m from '${name}'; export const a = () => Object.keys(m);` },
      'a.js#a',
    );
    assert.equal(imported.t, 'fail', name);
    assert.match(imported.message, /MODULE_NOT_ALLOWED/, name);
    const called = await run(
      { 'a.js': `export const a = () => __vide_lib('vide/geometry-kit#${name}', '[5]');` },
      'a.js#a',
    );
    assert.equal(called.t, 'fail', name);
    assert.match(called.message, /LIBRARY_UNKNOWN/, name);
  }
});

test('no library call starts after the budget is spent', async () => {
  const out = await run(
    {
      'a.js': `import { polygonArea } from 'vide/geometry-kit';
        export const a = () => { for (;;) { try { polygonArea([[0, 0], [1, 0], [1, 1]]); } catch {} } };`,
    },
    'a.js#a',
    {},
    300,
  );
  assert.equal(out.t, 'fail');
  assert.equal(out.code, 'BUDGET');
});
