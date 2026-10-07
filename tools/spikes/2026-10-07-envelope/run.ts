// T-204 spike driver (engine side). For each synthetic site: 2D buildable area, extrusion,
// sky-exposure and maximum envelopes as closed polyhedra; closed-solid gate; accuracy against the
// hand calculation and a fine-grid integration of the exact (true-circle) heights; timings; the
// survey-coordinate precision experiment; negative gate cases; and the input file for rhino.py.
// Usage: node tools/spikes/2026-10-07-envelope/run.ts [--quick]
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Vec3 as V3 } from '../../../src/jigs/official/geometry-kit/plan.ts';
import {
  checkSolid as check,
  reversedMesh as reversed,
  weldSolid as weld,
  type Solid,
  type SolidMesh as Mesh,
} from '../../../src/jigs/official/geometry-kit/solid.ts';
import { cases, SURVEY } from './fixtures.ts';
import { envelope, reference, type P2, type SiteCase } from './rules.ts';

const quick = process.argv.includes('--quick');
const work = resolve('.vide/spikes/envelope');
mkdirSync(work, { recursive: true });

const mv = (p: P2, d: P2): P2 => [p[0] + d[0], p[1] + d[1]];
function shifted(c: SiteCase, d: P2): SiteCase {
  const e = (x: { a: P2; b: P2 }) => ({ a: mv(x.a, d), b: mv(x.b, d) });
  return {
    ...c,
    site: c.site.map((p) => mv(p, d)),
    setbacks: c.setbacks.map((s) => ({ ...s, edge: e(s.edge) })),
    chamfers: c.chamfers.map((ch) => ({
      ...ch,
      corner: mv(ch.corner, d),
      along: [mv(ch.along[0], d), mv(ch.along[1], d)] as [P2, P2],
    })),
    sunlight: c.sunlight.map((s) => ({
      ...s,
      datum: s.datum.map(e),
      ...(s.zone ? { zone: s.zone.map((p) => mv(p, d)) } : {}),
    })),
  };
}
const rel = (a: number, b: number) => (a - b) / b;
const r6 = (x: number) => +x.toFixed(6);
// Operands go to Rhino welded and T-junction-free (a raw BSP union does not join there).
const polys = (s: Solid) => {
  const m = weld(s);
  return m.f.map((loop) => loop.map((i) => m.v[i]));
};

const report: Record<string, unknown>[] = [];
const rhinoInput: Record<string, unknown>[] = [];
for (const c of cases) {
  const row: Record<string, unknown> = { id: c.id, title: c.title };
  // Accuracy of the polygonal round ends: 32 and 64 sides.
  const r32 = envelope(c, { arcSides: 32 });
  const r64 = envelope(c, { arcSides: 64 });
  const zs = r32.sections.map((s) => s.z);
  const ref = reference(c, quick ? 0.05 : 0.01, zs);
  const refCoarse = reference(c, quick ? 0.1 : 0.02, zs);
  const pick = (r: typeof r32) => ({
    area: r6(r.area),
    extrude: r6(r.extrude.check.volume),
    sun: r6(r.sun.check.volume),
    max: r6(r.max.check.volume),
  });
  row.engine32 = pick(r32);
  row.engine64 = pick(r64);
  row.analytic = c.analytic ?? null;
  row.grid = {
    step: quick ? 0.05 : 0.01,
    area: r6(ref.area),
    extrude: r6(ref.extrude),
    sun: r6(ref.sun),
    max: r6(ref.max),
  };
  row.gridSpread = {
    area: r6(ref.area - refCoarse.area),
    max: r6(ref.max - refCoarse.max),
  };
  const truth = (k: 'area' | 'extrude' | 'sun' | 'max') =>
    c.analytic?.[k] ?? (k === 'area' ? ref.area : ref[k]);
  row.error32 = Object.fromEntries(
    (['area', 'extrude', 'sun', 'max'] as const).map((k) => [
      k,
      r6((k === 'area' ? r32.area : r32[k].check.volume) - truth(k)),
    ]),
  );
  row.error64 = Object.fromEntries(
    (['area', 'extrude', 'sun', 'max'] as const).map((k) => [
      k,
      r6((k === 'area' ? r64.area : r64[k].check.volume) - truth(k)),
    ]),
  );
  row.relError32 = Object.fromEntries(
    (['area', 'extrude', 'sun', 'max'] as const).map((k) => [
      k,
      +rel(k === 'area' ? r32.area : r32[k].check.volume, truth(k)).toExponential(2),
    ]),
  );
  row.sections = r32.sections.map((s, i) => ({
    z: s.z,
    engine: r6(s.area),
    grid: r6(ref.sections[i].area),
  }));
  row.reductions = r32.reductions.map((x) => ({ rule: x.rule, area: r6(x.area) }));
  row.checks = Object.fromEntries(
    (['extrude', 'sun', 'max'] as const).map((k) => [
      k,
      { ...r32[k].check, volume: r6(r32[k].check.volume), area: r6(r32[k].check.area) },
    ]),
  );
  row.ms = {
    buildable: +r32.ms.buildable.toFixed(1),
    extrude: +r32.extrude.ms.toFixed(1),
    sun: +r32.sun.ms.toFixed(1),
    max: +r32.max.ms.toFixed(1),
    total32: +r32.ms.total.toFixed(1),
    total64: +r64.ms.total.toFixed(1),
  };

  // Precision at survey scale (ARCH-03 §9.2 transfer: f64 origin + f32 differences).
  const g = shifted(c, SURVEY);
  const rg = envelope(g, { arcSides: 32 });
  const globalMesh = rg.max.mesh;
  const origin: V3 = [Math.floor(SURVEY[0]), Math.floor(SURVEY[1]), 0];
  const viaF32: Mesh = {
    v: globalMesh.v.map(
      (p): V3 => [
        origin[0] + Math.fround(p[0] - origin[0]),
        origin[1] + Math.fround(p[1] - origin[1]),
        origin[2] + Math.fround(p[2] - origin[2]),
      ],
    ),
    f: globalMesh.f,
  };
  const f32Abs: Mesh = {
    v: globalMesh.v.map((p): V3 => [Math.fround(p[0]), Math.fround(p[1]), Math.fround(p[2])]),
    f: globalMesh.f,
  };
  const maxErr = (a: Mesh, b: Mesh) =>
    Math.max(
      ...a.v.map((p, i) => Math.hypot(p[0] - b.v[i][0], p[1] - b.v[i][1], p[2] - b.v[i][2])),
    );
  // Local result moved to survey coordinates, as the same welded mesh, for a vertex-by-vertex reference.
  const localMoved: Mesh = {
    v: r32.max.mesh.v.map((p): V3 => [p[0] + SURVEY[0], p[1] + SURVEY[1], p[2]]),
    f: r32.max.mesh.f,
  };
  const cf = check(viaF32),
    ca = check(f32Abs),
    cg = rg.max.check;
  row.precision = {
    globalF64: {
      ok: cg.ok,
      reasons: cg.reasons,
      volume: r6(cg.volume),
      volumeDiff: +(cg.volume - r32.max.check.volume).toExponential(2),
      area2dDiff: +(rg.area - r32.area).toExponential(2),
      polygons: cg.polygons,
      ms: +rg.ms.total.toFixed(1),
    },
    originPlusF32: {
      ok: cf.ok,
      maxVertexError: +maxErr(viaF32, globalMesh).toExponential(2),
      planarity: +cf.planarity.toExponential(2),
      volumeDiff: +(cf.volume - cg.volume).toExponential(2),
    },
    f32Absolute: {
      ok: ca.ok,
      reasons: ca.reasons,
      maxVertexError: +maxErr(f32Abs, globalMesh).toExponential(2),
      planarity: +ca.planarity.toExponential(2),
      volumeDiff: +(ca.volume - cg.volume).toExponential(2),
    },
    localThenMoved: { volumeDiff: +(check(localMoved).volume - cg.volume).toExponential(2) },
  };

  // Negative gates: the inside-out solid (closed, wrong way) and an open one.
  const inside = check(reversed(r32.max.mesh));
  const open = check({ v: r32.max.mesh.v, f: r32.max.mesh.f.slice(1) });
  row.negative = {
    insideOut: { ok: inside.ok, reasons: inside.reasons, boundaryEdges: inside.boundaryEdges },
    open: { ok: open.ok, reasons: open.reasons },
  };
  report.push(row);

  const m = (x: Mesh) => ({ v: x.v.map((p) => p.map(r6)), f: x.f });
  rhinoInput.push({
    id: c.id,
    heightCap: c.heightCap,
    site: c.site,
    envelopes: { extrude: m(r32.extrude.mesh), sun: m(r32.sun.mesh), max: m(r32.max.mesh) },
    engineVolume: {
      extrude: r32.extrude.check.volume,
      sun: r32.sun.check.volume,
      max: r32.max.check.volume,
    },
    operands: {
      setbacks: r32.operands.setbacks.map(polys),
      chamfers: r32.operands.chamfers.map(polys),
      sunWall: r32.operands.sunWall.map(polys),
      sunSlope: r32.operands.sunSlope.map(polys),
    },
    survey: {
      origin,
      delta: viaF32.v.map((p) => [
        Math.fround(p[0] - origin[0]),
        Math.fround(p[1] - origin[1]),
        Math.fround(p[2]),
      ]),
      f: viaF32.f,
      volume: cg.volume,
    },
  });
  console.log(
    `${c.id.padEnd(13)} area ${r32.area.toFixed(4)} (err ${(row.error32 as Record<string, number>).area})  max ${r32.max.check.volume.toFixed(3)} (err ${(row.error32 as Record<string, number>).max})  closed ${r32.extrude.check.ok}/${r32.sun.check.ok}/${r32.max.check.ok}  faces ${r32.max.check.planarFaces}  ${r32.ms.total.toFixed(0)} ms  global ${cg.ok} f32 ${cf.ok}/${ca.ok}`,
  );
  if (!r32.max.check.ok) console.log('  max:', r32.max.check.reasons.join(', '));
}
writeFileSync(resolve(work, 'engine.json'), JSON.stringify(report, null, 1));
writeFileSync(resolve(work, 'rhino-input.json'), JSON.stringify(rhinoInput));
console.log('→', work);
