// 역반영 적용 on COPIES of real drawings (PLAN-47 T-233, SPEC-14.6). Not part of any suite: run it by
// hand with VIDE_BACKFLOW_COPIES=<a folder under .vide/ holding copies the user provided>. Hidden
// ZWCADs read every mm drawing there, rewrite up to 20 supported model space entities each in place
// (moved 10 mm, the type kept), add one marked line, and write the results through output tokens
// into this run's folder; the preservation check must find nothing but those rows. The copies are
// never written (their hashes are compared). Output is counts only: no file, layer or block name.
// Run: VIDE_BACKFLOW_COPIES=.vide/<folder> node tests/integration/zwcad-drawing-backflow-copies.mjs
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { inspectorOptions } from '../../hosts/zwcad/inspector.ts';
import { applyDrawingCopies, readDrawingEntities } from '../../hosts/zwcad/drawing-backflow.ts';
import { zwcadCrashDumps } from '../../hosts/zwcad/hidden-run.ts';
import { OutputTokens, dwgVersionOf } from '../../src/core/drawing-output.ts';
import { dimensionsToCheck, preservation } from '../../src/core/drawing-backflow-apply.ts';
import { runDirectory } from './run-directory.mjs';

const options = inspectorOptions();
const folder = process.env.VIDE_BACKFLOW_COPIES && resolve(process.env.VIDE_BACKFLOW_COPIES);
if (!folder || !folder.includes(resolve('.vide'))) {
  console.log(JSON.stringify({ skipped: 'VIDE_BACKFLOW_COPIES must name a folder under .vide/' }));
  process.exit(0);
}
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
const files = [];
const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true }))
    if (entry.isDirectory()) await walk(join(dir, entry.name));
    else if (/\.dwg$/i.test(entry.name)) files.push(join(dir, entry.name));
};
await walk(folder);
const originals = await Promise.all(files.map(hash));
const run = runDirectory('zwcad-drawing-backflow-copies');
const work = join(run, 'work'),
  src = join(work, 'src');
await mkdir(src, { recursive: true });
const copies = [];
for (const [i, path] of files.entries()) {
  const copy = join(src, `d${i + 1}.dwg`);
  await copyFile(path, copy);
  copies.push({ id: i + 1, path: copy });
}
const dumps = new Set(await zwcadCrashDumps());
let at = Date.now();
const reads = await readDrawingEntities(copies, work, options);
const summary = {
  drawings: files.length,
  read: 0,
  readFailed: 0,
  notMm: 0,
  entities: 0,
  supported: 0,
  applied: 0,
  ops: 0,
  refusedOps: {},
  preserved: 0,
  notPreserved: 0,
  differences: 0,
  versionKept: 0,
  dimensionsToCheck: 0,
  readMs: Date.now() - at,
  applyMs: 0,
};
const move = (g) => {
  const shift = (p) => [p[0] + 10, p[1], p[2]];
  switch (g.kind) {
    case 'line':
      return { ...g, points: g.points.map(shift) };
    case 'polyline':
      return { ...g, points: g.points.map(shift) };
    case 'insert':
      return { ...g, position: shift(g.position) };
    default:
      return { ...g, center: shift(g.center) };
  }
};
const jobs = new Map();
for (const copy of copies) {
  const read = reads.get(copy.id);
  if (!read || read.error) {
    summary.readFailed++;
    continue;
  }
  summary.read++;
  summary.entities += read.entities.length;
  if (read.units !== 4 && read.units !== 0) {
    summary.notMm++;
    continue;
  }
  const supported = read.entities.filter(
    (e) => e.geometry && !e.dynamic && !e.xref && e.owner === 'model',
  );
  summary.supported += supported.length;
  if (!supported.length) continue;
  const chosen = supported
    .filter((_, i) => i % Math.ceil(supported.length / 20) === 0)
    .slice(0, 20);
  const ops = chosen.map((e, i) => ({
    id: `M${i + 1}`,
    op: 'modify',
    handle: e.handle,
    geometry: move(e.geometry),
    origin: `T:${i + 1}`,
  }));
  ops.push({
    id: 'A1',
    op: 'add',
    layer: chosen[0].layer,
    geometry: {
      kind: 'line',
      points: [
        chosen[0].geometry.kind === 'line' ? chosen[0].geometry.points[0] : [0, 0, 0],
        [1, 1, 0],
      ],
    },
    origin: 'T:add',
  });
  const version = await dwgVersionOf(copy.path);
  jobs.set(copy.id, { copy, ops, version, read });
}
const tokens = new OutputTokens({ workRoot: work });
at = Date.now();
for (const [id, job] of jobs) {
  const out = join(work, 'out' + id);
  await mkdir(out, { recursive: true });
  let ops = job.ops;
  for (let attempt = 0; attempt < 3 && ops.length; attempt++) {
    const token = tokens.issue({ folder: out, names: [`r${attempt}.dwg`], version: job.version });
    try {
      const [applied] = await applyDrawingCopies({
        tokens,
        token: token.id,
        jobs: [
          {
            id: String(id),
            source: job.copy.path,
            target: join(out, `r${attempt}.dwg`),
            ops,
            revision: 1,
          },
        ],
        work,
        options,
      });
      const handles = new Map(applied.results.map((r) => [r.id, r.handle]));
      const check = preservation(applied.before, applied.after, {
        modified: ops.filter((o) => o.op === 'modify').map((o) => o.handle),
        added: ops.filter((o) => o.op === 'add').map((o) => handles.get(o.id)),
        deleted: [],
      });
      const beforeOf = new Map(applied.before.entities.map((e) => [e.handle, e]));
      const afterOf = new Map(applied.after.entities.map((e) => [e.handle, e]));
      summary.dimensionsToCheck += dimensionsToCheck(
        applied.before.dims,
        applied.after.dims,
        ops
          .filter((o) => o.op === 'modify')
          .map((o) => ({
            handle: o.handle,
            before: beforeOf.get(o.handle)?.geometry ?? null,
            after: afterOf.get(o.handle)?.geometry ?? null,
          })),
      ).length;
      summary.applied++;
      summary.ops += ops.length;
      if (check.ok) summary.preserved++;
      else {
        summary.notPreserved++;
        summary.differences += check.differences;
        console.error(
          JSON.stringify({
            drawing: id,
            unexpected: check.unexpected.counts,
            entities: check.entities.length,
            tables: check.tables.filter((t) => t.added.length || t.removed.length).length,
          }),
        );
      }
      if (check.version.same && (await dwgVersionOf(applied.path)) === job.version)
        summary.versionKept++;
      break;
    } catch (error) {
      if (error.code !== 'APPLY_FAILED') throw error;
      const failed = new Set(error.jobs.flatMap((j) => j.failed.map((f) => f.id)));
      for (const j of error.jobs)
        for (const f of j.failed)
          summary.refusedOps[f.code] = (summary.refusedOps[f.code] ?? 0) + 1;
      ops = ops.filter((o) => !failed.has(o.id));
    }
  }
}
summary.applyMs = Date.now() - at;
const after = await Promise.all(files.map(hash));
assert.deepEqual(after, originals, 'the copies the user gave are never written');
summary.newCrashReports = (await zwcadCrashDumps()).filter((n) => !dumps.has(n)).length;
console.log(JSON.stringify(summary));
assert.equal(summary.notPreserved, 0);
