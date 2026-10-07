// Keyed smoke of vide/site-data against one non-project public site (서울특별시청, PLAN-45 T-205).
// Runs only when this PC has keys (environment variables or <data>/public-data.env). Prints key
// names with present/absent, statuses, counts and the CRS — never key values, never responses.
// Nothing is saved. Usage: node tests/integration/site-data-live.mjs
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PublicDataKeyStore } from '../../src/server/public-data-keys.ts';
import { collectSite, lookupParcel } from '../../src/jigs/official/site-data/index.ts';

const directory = process.env.VIDE_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'VIDE');
const store = new PublicDataKeyStore(directory);
for (const key of store.view().keys)
  console.log(`${key.name}: ${key.present ? `present (${key.from})` : 'absent'}`);
const keys = store.read();
if (!keys.VWORLD_KEY && !keys.JUSO_KEY) {
  console.log('skipped: no VWORLD_KEY or JUSO_KEY on this PC');
  process.exit(0);
}

const started = Date.now();
const lookup = await lookupParcel({ keys }, '서울특별시 중구 태평로1가 31');
console.log(
  `lookup: ${lookup.status} · candidates ${lookup.candidates.length} · proposal ${lookup.proposal ? 'yes' : 'no'}${lookup.reason ? ` · ${lookup.reason}` : ''}`,
);
if (!lookup.proposal) process.exit(1);
const site = await collectSite({ keys }, { pnus: [lookup.proposal], radius: 50 });
console.log(`collect: crs ${site.crs} · blocked ${site.blocked}`);
for (const name of [
  'target',
  'landCharacteristics',
  'landUse',
  'parcels',
  'buildings',
  'buildingInfo',
  'register',
]) {
  const copy = site[name];
  console.log(
    `  ${name}: ${copy.status} · ${copy.items.length} items · ${copy.provenance.requests.length} calls · ${copy.checks.length} checks${copy.reason ? ` · ${copy.reason}${copy.detail ? `/${copy.detail}` : ''}` : ''}`,
  );
}
const heights = site.buildings.items.reduce((count, b) => {
  count[b.heightSource ?? 'none'] = (count[b.heightSource ?? 'none'] ?? 0) + 1;
  return count;
}, {});
console.log(`  building heights by source: ${JSON.stringify(heights)}`);
const use = site.landUse.items[0];
if (use)
  console.log(
    `  land use: ${use.entries.length} entries · ${use.entries.filter((e) => e.notices.length).length} with 고시 번호 · ${use.districtPlans.length} 지구단위계획`,
  );
console.log(`${Date.now() - started} ms`);
process.exit(site.blocked ? 1 : 0);
