// T-204 spike: cost growth of the BSP pipeline with boundary size. A synthetic star-like site with
// n edges (every edge gets a 0.5 m setback) and the northern third of its edges as sky-exposure
// datums. Prints time, polygon count and the closed-solid gate per n and per arc side count.
// Also writes rhino-input-stress.json (32 sides) for `rhino.mjs stress`.
// Usage: node tools/spikes/2026-10-07-envelope/stress.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  weldSolid as weld,
  type Solid,
  type SolidMesh as Mesh,
} from '../../../src/jigs/official/geometry-kit/solid.ts';
import { envelope, type P2, type SiteCase } from './rules.ts';

function star(n: number): SiteCase {
  const site: P2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const r = 25 + (i % 2 ? 3 : 0) + 2 * Math.sin(3 * t);
    site.push([30 + r * Math.cos(t), 30 + r * Math.sin(t)]);
  }
  const edges = site.map((a, i) => ({ a, b: site[(i + 1) % n] }));
  const north = edges.filter((e) => (e.a[1] + e.b[1]) / 2 > 45 && e.b[0] < e.a[0]);
  return {
    id: `star-${n}`,
    title: `${n}각형`,
    site,
    heightCap: 40,
    setbacks: edges.map((edge) => ({ rule: '민법 이격', edge, distance: 0.5 })),
    chamfers: [],
    sunlight: [{ datum: north, baseHeight: 10, nearDistance: 1.5, ratio: 0.5 }],
  };
}

const polys = (s: Solid) => {
  const m = weld(s);
  return m.f.map((loop) => loop.map((i) => m.v[i]));
};
const mesh = (m: Mesh) => ({ v: m.v, f: m.f });
const rhino: unknown[] = [];
for (const sides of [32, 64])
  for (const n of [8, 16, 32, 64]) {
    const c = star(n);
    const r = envelope(c, { arcSides: sides });
    console.log(
      `sides ${sides} n ${String(n).padStart(2)} datums ${c.sunlight[0].datum.length}  ${r.ms.total.toFixed(0).padStart(5)} ms  max polygons ${r.max.check.polygons}  faces ${r.max.check.planarFaces}  ok ${r.max.check.ok} ${r.max.check.reasons.join(',')}`,
    );
    if (sides === 32)
      rhino.push({
        id: c.id,
        heightCap: c.heightCap,
        site: c.site,
        envelopes: { extrude: mesh(r.extrude.mesh), sun: mesh(r.sun.mesh), max: mesh(r.max.mesh) },
        engineVolume: {
          extrude: r.extrude.check.volume,
          sun: r.sun.check.volume,
          max: r.max.check.volume,
        },
        engineMs: { extrude: r.extrude.ms, sun: r.sun.ms, max: r.max.ms, total: r.ms.total },
        operands: {
          setbacks: r.operands.setbacks.map(polys),
          chamfers: [],
          sunWall: r.operands.sunWall.map(polys),
          sunSlope: r.operands.sunSlope.map(polys),
        },
      });
  }
const work = resolve('.vide/spikes/envelope');
mkdirSync(work, { recursive: true });
writeFileSync(resolve(work, 'rhino-input-stress.json'), JSON.stringify(rhino));
