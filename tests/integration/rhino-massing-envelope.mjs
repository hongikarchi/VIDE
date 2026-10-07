// T-210 (PLAN-45) in a VIDE-owned hidden Rhino 8 worker: the envelopes `vide/massing-kit` computes
// for the synthetic sites of SPIKE-2026-10-07-envelope (and the star-16 stress site) are made with
// the T-208 template `vide.bake.brep-faces@1` exactly as the jig's bake declaration extracts them,
// then measured in Rhino: one closed, valid, outward solid per envelope, one Brep face per merged
// engine face, and the Rhino volume within 0.1 % (in practice 1e-6) of the engine volume. A
// reversed copy of an envelope must come back in failed[] (never flipped, SPEC-12.9 4).
// Synthetic document only; no user document is opened. Without Rhino 8 or the worker plugin the
// test is skipped. Only the Rhino process this test launched is stopped.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { extractItems } from '../../src/jigs/bake/plan.ts';
import { renderChunks } from '../../src/jigs/bake/templates.ts';
import {
  envelopeStep,
  limitStep,
  planStep,
  regulationStep,
  siteStep,
} from '../../src/jigs/official/massing-kit/index.ts';
import { SITES, SLANTED, paramsOf, star } from '../fixtures/massing-sites.mjs';
import { runDirectory } from './run-directory.mjs';

const probe = sdkOptions('.');
if (process.env.VIDE_TEST_RHINO_PLUGIN) probe.plugin = resolve(process.env.VIDE_TEST_RHINO_PLUGIN);
if (!existsSync(probe.executable) || !existsSync(probe.plugin)) {
  console.log(
    `skipped: Rhino 8 (${probe.executable}) or the worker plugin (${probe.plugin}) is not available`,
  );
  process.exit(0);
}

const directory = runDirectory('rhino-massing-envelope');
const options = { ...sdkOptions(directory), plugin: probe.plugin };
const manifest = JSON.parse(readFileSync('src/jigs/official/jigs/buildable-mass/jig.json', 'utf8'));
const decl = manifest.bake.find((b) => b.id === 'envelopes');

function envelopeOf(site) {
  const params = paramsOf(site);
  const own = site.inputs.site;
  const s = siteStep({ site: own }, params);
  const regulations = regulationStep({}, params);
  const plan = planStep({}, params);
  const limits = limitStep({ site: own, steps: { site: s, regulations } });
  return envelopeStep({ steps: { site: s, regulations, plan, limits } });
}

const measure = (ids) => `
var ids = new[] { ${ids.map((id) => JSON.stringify(id)).join(', ')} };
var rows = new System.Collections.Generic.List<object>();
foreach (var s in ids)
{
    var b = doc.Objects.FindId(Guid.Parse(s)).Geometry as Brep;
    var m = VolumeMassProperties.Compute(b, true, false, false, false);
    rows.Add(new { id = s, solid = b.IsSolid, valid = b.IsValid, orientation = b.SolidOrientation.ToString(), volume = m == null ? 0.0 : m.Volume, faces = b.Faces.Count });
}
return rows;`;

let worker,
  revision = 0;
/** Run C# in the worker document at its current revision. */
const execute = async (code) => {
  const receipt = await worker.execute(randomUUID(), revision, code);
  if (receipt.ok) revision = receipt.revision;
  return receipt;
};
const result = { directory, sites: [] };
try {
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'bake') });
  const sites = [...SITES, SLANTED, star(16)];
  for (const site of sites) {
    const out = envelopeOf(site);
    const { items, problems } = extractItems(decl, out);
    assert.deepEqual(problems, [], site.id);
    // A reversed copy of the maximum envelope must not be made.
    const max = items.find((i) => i.key.endsWith(':max'));
    const bad = {
      ...max,
      key: `${max.key}:reversed`,
      faces: max.faces.map((face) => face.map((ring) => [...ring].reverse())),
    };
    const header = {
      template: decl.template,
      jigId: 'vide/buildable-mass',
      instanceId: randomUUID(),
      bakeId: decl.id,
      runId: randomUUID(),
      layerPath: `VIDE::매스 시험::${site.id}`,
      deleteIds: [],
    };
    const started = performance.now();
    const made = { keys: [], ids: [], failed: [] };
    const chunks = renderChunks(header, [...items, bad]);
    for (const chunk of chunks) {
      const receipt = await execute(chunk.code);
      assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 600));
      made.keys.push(...receipt.value.keys);
      made.ids.push(...receipt.value.ids);
      made.failed.push(...receipt.value.failed);
    }
    const bakeMs = Math.round(performance.now() - started);
    assert.deepEqual(made.failed, [bad.key], `${site.id}: only the reversed copy fails`);
    assert.deepEqual(
      made.keys,
      items.map((i) => i.key),
      site.id,
    );
    const measured = await execute(measure(made.ids));
    assert.equal(measured.ok, true, JSON.stringify(measured).slice(0, 600));
    let worst = 0;
    const rows = measured.value.map((row, k) => {
      const item = items[k];
      assert.ok(
        row.solid && row.valid && row.orientation === 'Outward',
        `${site.id} ${item.key}: ${JSON.stringify(row)}`,
      );
      const relative = Math.abs(row.volume - item.volume) / item.volume;
      worst = Math.max(worst, relative);
      assert.ok(relative <= 1e-3, `${site.id} ${item.key}: ${row.volume} vs ${item.volume}`);
      assert.equal(
        row.faces,
        item.faces.length,
        `${site.id} ${item.key}: one Brep face per merged face`,
      );
      return { key: item.key, faces: row.faces, engine: item.volume, rhino: row.volume, relative };
    });
    result.sites.push({ id: site.id, bakeMs, chunks: chunks.length, worst, rows });
    console.log(
      `${site.id.padEnd(14)} ${rows.length} envelopes made, reversed refused, worst relative volume ${worst.toExponential(2)}, ${bakeMs} ms`,
    );
  }
  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
} finally {
  await worker?.stop();
}
