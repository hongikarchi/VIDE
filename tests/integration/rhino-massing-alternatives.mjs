// T-211·T-212 (PLAN-45) in a VIDE-owned hidden Rhino 8 worker: the floor masses of every
// alternative `vide/massing-kit` makes on the synthetic sites (최대 · 기준 용적률 · 인센티브 ·
// 공개공지 · 사람 수정, 위층 축소 included) and the estimated parking basements are made with the
// T-208 template `vide.bake.extrude-polygon@1` exactly as the jig's bake declarations extract them,
// and the 주차·공지 curves with `vide.bake.curves@1`. Measured in Rhino: one closed, valid, outward
// solid per floor region whose volume is the engine's area × floor height (1e-6 relative), its
// bottom at the floor level. Synthetic document only; no user document is opened. Without Rhino 8
// or the worker plugin the test is skipped. Only the Rhino process this test launched is stopped.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { extractItems } from '../../src/jigs/bake/plan.ts';
import { renderChunks } from '../../src/jigs/bake/templates.ts';
import { regionsArea } from '../../src/jigs/official/massing-kit/index.ts';
import { SITES, override, row, runMass } from '../fixtures/massing-sites.mjs';
import { runDirectory } from './run-directory.mjs';

const probe = sdkOptions('.');
if (process.env.VIDE_TEST_RHINO_PLUGIN) probe.plugin = resolve(process.env.VIDE_TEST_RHINO_PLUGIN);
if (!existsSync(probe.executable) || !existsSync(probe.plugin)) {
  console.log(
    `skipped: Rhino 8 (${probe.executable}) or the worker plugin (${probe.plugin}) is not available`,
  );
  process.exit(0);
}

const directory = runDirectory('rhino-massing-alternatives');
const options = { ...sdkOptions(directory), plugin: probe.plugin };
const manifest = JSON.parse(readFileSync('src/jigs/official/jigs/buildable-mass/jig.json', 'utf8'));
const declOf = (id) => manifest.bake.find((b) => b.id === id);

// Test inputs a person would type (not a legal reading).
const PARAMS = {
  farBaseState: 'apply',
  farBase: 3,
  incentiveState: 'apply',
  incentiveFar: 0.4,
  publicOpenSpaceState: 'apply',
  publicOpenSpace: 0.08,
  openSpaceIncentiveState: 'apply',
  openSpaceIncentiveFar: 0.2,
  parkingState: 'apply',
  parkingRounding: 'ceil',
  parkingRoundScope: 'sum',
  parkingAreaBasis: 'gross',
  parkingAreaUnder: 30,
  basementFloors: 1,
  basementFloorHeight: 3.5,
  basementSetback: 1,
  parkingAlternative: 'max',
};
const CASES = [
  {
    site: SITES[0],
    overrides: [
      override(
        'regulation',
        { id: 'parkingRule', target: '업무시설' },
        { value: 100, applies: '적용' },
      ),
      override(
        'mass-floor',
        { alternative: 'human-1', floor: '3F' },
        {
          outline: [
            [2, 3],
            [18, 3],
            [18, 18],
            [2, 18],
          ],
          holes: [
            [
              [8, 8],
              [8, 12],
              [12, 12],
              [12, 8],
            ],
          ],
        },
      ),
      override('mass-floor', { alternative: 'human-1', floor: '8F' }, {}, 'remove'),
    ],
    drawn: {
      openSpaceZones: {
        rows: [
          row('zone-1', [
            [0, 0],
            [9, 0],
            [9, 6],
            [0, 6],
          ]),
        ],
      },
    },
  },
  {
    site: SITES[1],
    overrides: [
      override(
        'regulation',
        { id: 'parkingRule', target: '업무시설' },
        { value: 100, applies: '적용' },
      ),
    ],
    drawn: {},
  },
];

const measure = (ids) => `
var ids = new[] { ${ids.map((id) => JSON.stringify(id)).join(', ')} };
var rows = new System.Collections.Generic.List<object>();
foreach (var s in ids)
{
    var o = doc.Objects.FindId(Guid.Parse(s));
    var b = o.Geometry as Brep;
    if (b == null && o.Geometry is Extrusion e) b = e.ToBrep(true);
    if (b == null) { rows.Add(new { id = s, solid = false, valid = false, orientation = "none", volume = 0.0, zmin = 0.0, zmax = 0.0 }); continue; }
    var m = VolumeMassProperties.Compute(b, true, false, false, false);
    var box = b.GetBoundingBox(true);
    rows.Add(new { id = s, solid = b.IsSolid, valid = b.IsValid, orientation = b.SolidOrientation.ToString(), volume = m == null ? 0.0 : m.Volume, zmin = box.Min.Z, zmax = box.Max.Z });
}
return rows;`;

let worker,
  revision = 0;
const execute = async (code) => {
  const receipt = await worker.execute(randomUUID(), revision, code);
  if (receipt.ok) revision = receipt.revision;
  return receipt;
};
const bake = async (decl, items, layerPath) => {
  const header = {
    template: decl.template,
    jigId: 'vide/buildable-mass',
    instanceId: randomUUID(),
    bakeId: decl.id,
    runId: randomUUID(),
    layerPath,
    deleteIds: [],
  };
  const made = { keys: [], ids: [], failed: [] };
  for (const chunk of renderChunks(header, items)) {
    const receipt = await execute(chunk.code);
    assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 600));
    made.keys.push(...receipt.value.keys);
    made.ids.push(...receipt.value.ids);
    made.failed.push(...receipt.value.failed);
  }
  return made;
};
const result = { directory, sites: [] };
try {
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'bake') });
  for (const c of CASES) {
    const out = await runMass(c.site, PARAMS, c.overrides, c.drawn);
    const alts = out.steps.alternatives;
    // The expected engine volume of each item: its region's area × the floor height.
    const masses = extractItems(declOf('alternativeMasses'), out.steps.useMix);
    assert.deepEqual(masses.problems, [], c.site.id);
    const parking = extractItems(declOf('parkingMasses'), out.steps.parking);
    assert.deepEqual(parking.problems, [], c.site.id);
    const curves = extractItems(declOf('groundZones'), out.steps.parking);
    assert.deepEqual(curves.problems, [], c.site.id);
    const solids = [...masses.items, ...parking.items];
    const expected = new Map(
      solids.map((i) => {
        const area = regionsArea([
          {
            outer: i.rings[0].map((p) => [p[0], p[1]]),
            holes: i.rings.slice(1).map((h) => h.map((p) => [p[0], p[1]])),
          },
        ]);
        return [
          i.key,
          { volume: area * i.height, bottom: i.rings[0][0][2], top: i.rings[0][0][2] + i.height },
        ];
      }),
    );
    const started = performance.now();
    const madeMass = await bake(
      declOf('alternativeMasses'),
      masses.items,
      `VIDE::대안 시험::${c.site.id}`,
    );
    const madePark = await bake(
      declOf('parkingMasses'),
      parking.items,
      `VIDE::주차 시험::${c.site.id}`,
    );
    const madeCurves = await bake(
      declOf('groundZones'),
      curves.items,
      `VIDE::공지 시험::${c.site.id}`,
    );
    const bakeMs = Math.round(performance.now() - started);
    assert.deepEqual([...madeMass.failed, ...madePark.failed, ...madeCurves.failed], [], c.site.id);
    assert.equal(madeCurves.keys.length, curves.items.length);
    const ids = [...madeMass.ids, ...madePark.ids];
    const keys = [...madeMass.keys, ...madePark.keys];
    const measured = await execute(measure(ids));
    assert.equal(measured.ok, true, JSON.stringify(measured).slice(0, 600));
    let worst = 0;
    measured.value.forEach((r, k) => {
      const e = expected.get(keys[k]);
      assert.ok(
        r.solid && r.valid && r.orientation === 'Outward',
        `${c.site.id} ${keys[k]}: ${JSON.stringify(r)}`,
      );
      const rel = Math.abs(r.volume - e.volume) / e.volume;
      worst = Math.max(worst, rel);
      assert.ok(rel <= 1e-6, `${c.site.id} ${keys[k]}: ${r.volume} vs ${e.volume}`);
      assert.ok(
        Math.abs(r.zmin - e.bottom) <= 1e-5 && Math.abs(r.zmax - e.top) <= 1e-5,
        `${keys[k]} levels`,
      );
    });
    const summary = {
      id: c.site.id,
      alternatives: alts.rows.map((r) => `${r.id} ${r.floorsAbove}F ${r.farArea}`),
      masses: madeMass.keys.length,
      parking: madePark.keys.length,
      curves: madeCurves.keys.length,
      worst,
      bakeMs,
    };
    result.sites.push(summary);
    console.log(
      `${c.site.id.padEnd(10)} ${alts.rows.length} alternatives, ${summary.masses} floor masses + ${summary.parking} basement estimates solid/outward, ${summary.curves} curves, worst relative volume ${worst.toExponential(2)}, ${bakeMs} ms`,
    );
  }
  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
} finally {
  await worker?.stop();
}
