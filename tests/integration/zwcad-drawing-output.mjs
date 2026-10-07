// Output-token writes with the real ZWCAD 2023 (PLAN-47 T-226, SPEC-14.7, H-ZWCAD-14). Skipped when
// ZWCAD 2023 or the built worker is missing. Hidden ZWCADs this test starts write SYNTHETIC drawings
// (VIDEDRAWINGFIXTURE, 2013 and 2018) into a new folder under .vide/, then VIDEDRAWINGCOPY writes
// copies through output tokens. Only the processes started here are stopped; no user drawing is
// opened and the user's own ZWCAD is never touched.
// Run: node tests/integration/zwcad-drawing-output.mjs
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { inspectorOptions } from '../../hosts/zwcad/inspector.ts';
import { writeDrawingCopy, writeDrawingFixture } from '../../hosts/zwcad/drawing-output.ts';
import { OutputTokens, dwgVersionOf } from '../../src/core/drawing-output.ts';
import { runDirectory } from './run-directory.mjs';

const options = inspectorOptions();
try {
  await Promise.all([access(options.executable), access(options.plugin)]);
} catch {
  console.log(JSON.stringify({ skipped: 'ZWCAD 2023 or the built worker is not available' }));
  process.exit(0);
}
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const run = runDirectory('zwcad-drawing-output');
const fixtures = join(run, 'fixtures'),
  work = join(run, 'work'),
  out = join(work, 'out');
await mkdir(fixtures, { recursive: true });
await mkdir(out, { recursive: true });
let at = Date.now();
await writeDrawingFixture(fixtures, options);
const timings = { fixtureMs: Date.now() - at };
assert.equal(await dwgVersionOf(join(fixtures, 'v2013.dwg')), 'AC1027');
const v2018 = await dwgVersionOf(join(fixtures, 'v2018.dwg'));

// The engine's copies of the "originals".
const src2013 = join(work, 'src-2013.dwg'),
  src2018 = join(work, 'src-2018.dwg');
await copyFile(join(fixtures, 'v2013.dwg'), src2013);
await copyFile(join(fixtures, 'v2018.dwg'), src2018);
const before = { 2013: await hash(src2013), 2018: await hash(src2018) };

const tokens = new OutputTokens({ workRoot: work });
// 1. Normal: a token path, the original version, read back with the same handles and layers.
const t1 = tokens.issue({ folder: out, names: ['a-2013.dwg'], version: 'AC1027' });
at = Date.now();
const first = await writeDrawingCopy({
  tokens,
  token: t1.id,
  source: src2013,
  target: join(out, 'a-2013.dwg'),
  work,
  options,
});
timings.copyMs = Date.now() - at;
assert.equal(first.version, 'AC1027');
assert.deepEqual(first.written.handles, first.source.handles);
assert.deepEqual(first.written.layers, first.source.layers);
assert.ok(first.source.layers.includes('벽'));
// 2. The same file again: refused by the engine before any host starts.
await assert.rejects(
  writeDrawingCopy({
    tokens,
    token: t1.id,
    source: src2013,
    target: join(out, 'a-2013.dwg'),
    work,
    options,
  }),
  /OUTPUT_PATH_USED/,
);
// 3. 2018 drawing keeps 2018.
const t2 = tokens.issue({ folder: out, names: ['b-2018.dwg'], version: v2018 });
const second = await writeDrawingCopy({
  tokens,
  token: t2.id,
  source: src2018,
  target: join(out, 'b-2018.dwg'),
  work,
  options,
});
assert.equal(second.version, v2018);
assert.equal(await dwgVersionOf(join(out, 'b-2018.dwg')), v2018);
// 4. A token for 2013 cannot write the 2018 source (no version conversion).
const t3 = tokens.issue({ folder: out, names: ['c.dwg'], version: 'AC1027' });
await assert.rejects(
  writeDrawingCopy({
    tokens,
    token: t3.id,
    source: src2018,
    target: join(out, 'c.dwg'),
    work,
    options,
  }),
  /OUTPUT_VERSION_MISMATCH/,
);

// 5. The worker checks again on its own: an engine that passed a path outside the grant, or a file
// that appeared after the engine's check, is still refused in ZWCAD.
const t4 = tokens.issue({ folder: out, names: ['d.dwg', 'e.dwg'], version: 'AC1027' });
const lying = (path) => ({
  authorize: () => ({ path, version: 'AC1027' }),
  grant: (id) => tokens.grant(id),
  written: () => {},
});
await assert.rejects(
  writeDrawingCopy({
    tokens: lying(join(work, 'outside.dwg')),
    token: t4.id,
    source: src2013,
    target: 'x',
    work,
    options,
  }),
  /OUTPUT_PATH_DENIED/,
);
assert.ok(!existsSync(join(work, 'outside.dwg')));
await writeFile(join(out, 'e.dwg'), 'someone else');
await assert.rejects(
  writeDrawingCopy({
    tokens: lying(join(out, 'e.dwg')),
    token: t4.id,
    source: src2013,
    target: 'x',
    work,
    options,
  }),
  /OUTPUT_EXISTS/,
);
assert.equal(await readFile(join(out, 'e.dwg'), 'utf8'), 'someone else');

// 6. The hidden host stopped mid-run: the write fails, no file, the source unchanged.
const t5 = tokens.issue({ folder: out, names: ['f.dwg'], version: 'AC1027' });
await assert.rejects(
  writeDrawingCopy({
    tokens,
    token: t5.id,
    source: src2013,
    target: join(out, 'f.dwg'),
    work,
    options,
    timeoutMs: 1500,
  }),
  /HIDDEN_HOST_TIMEOUT/,
);
assert.ok(!existsSync(join(out, 'f.dwg')));
assert.equal(await hash(src2013), before[2013]);
assert.equal(await hash(src2018), before[2018]);
console.log(JSON.stringify({ ok: true, v2018, timings }));
