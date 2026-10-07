// Keyed smoke of the site modeling jig (PLAN-45 T-207) on one non-project public site
// (서울특별시청): the real read-copies of vide/site-data run through vide/site-model's steps in the
// engine runner. Runs only when this PC has keys (environment variables or <data>/public-data.env).
// Prints key names with present/absent, step statuses, counts and computed values — never key
// values, never responses. Nothing is saved. Usage: node tests/integration/site-model-live.mjs
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PublicDataKeyStore } from '../../src/server/public-data-keys.ts';
import { collectSite, lookupParcel } from '../../src/jigs/official/site-data/index.ts';
import { loadJig, officialJigRoot } from '../../src/jigs/runtime/loader.ts';
import { EngineRunner, MemoryCache, executeSteps } from '../../src/jigs/runtime/runner.ts';
import { initialParams } from '../../src/jigs/runtime/params.ts';

const directory = process.env.VIDE_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'VIDE');
const store = new PublicDataKeyStore(directory);
for (const key of store.view().keys)
  console.log(`${key.name}: ${key.present ? `present (${key.from})` : 'absent'}`);
const keys = store.read();
if (!keys.VWORLD_KEY) {
  console.log('skipped: no VWORLD_KEY on this PC');
  process.exit(0);
}

const started = Date.now();
const query = '서울특별시 중구 태평로1가 31';
const lookup = await lookupParcel({ keys }, query);
console.log(`lookup: ${lookup.status} · candidates ${lookup.candidates.length}`);
if (!lookup.proposal) process.exit(1);
const radius = 100;
const collection = await collectSite({ keys }, { pnus: [lookup.proposal], radius });
const jig = await loadJig(join(officialJigRoot(), 'site-model'), { source: 'builtin' });
const report = await executeSteps({
  jig,
  runner: new EngineRunner(),
  cache: new MemoryCache(),
  mode: 'preview',
  inputs: {
    site: {
      query,
      lookup,
      targets: { pnus: [lookup.proposal], by: 'proposal' },
      collection: { ...collection, radius },
      shp: null,
    },
  },
  params: initialParams(jig.manifest),
});
console.log(report.steps.map((s) => `${s.id}:${s.status}`).join(' '));
const o = report.outputs;
if (o.collect)
  console.log(
    `collect: ${o.collect.sources.map((s) => `${s.key}=${s.status}:${s.count}`).join(' ')}`,
  );
if (o.frame)
  console.log(
    `frame: site ${o.frame.site.area} m² · pieces ${o.frame.site.pieces} · convergence ${o.frame.convergenceDeg}° · surrounding parcels ${o.frame.parcels.length}`,
  );
if (o.roads)
  console.log(`roads: ${o.roads.roads.length} touching · contact ${o.roads.contact_m} m`);
if (o.buildings)
  console.log(
    `buildings: ${o.buildings.count} masses · estimated ${o.buildings.estimated} · not made ${o.buildings.unmade.length} · highest ${o.buildings.maxHeight_m} m`,
  );
if (o.summary)
  console.log(
    `summary: official ${o.summary.officialArea_m2} m² · computed ${o.summary.computedArea_m2} m² · gap ${o.summary.areaGap_pct}% · checks ${o.summary.checks}`,
  );
console.log(`${Date.now() - started} ms`);
process.exit(
  report.steps.every((s) => s.id === 'make' || s.status === 'done' || s.status === 'confirmed')
    ? 0
    : 1,
);
