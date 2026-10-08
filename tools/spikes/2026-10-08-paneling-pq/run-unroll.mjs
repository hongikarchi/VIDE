// SPIKE T-259 (PLAN-49): Rhino `Unroller` on panels of synthetic faces, in a VIDE-owned hidden Rhino 8
// worker (never a user document, never the user's Rhino). Work files only under
// .vide/spikes/paneling-pq/<run>/. Skips when Rhino 8 or the plugin is missing. Afterwards reads the
// installed engine's connectors and re-installs the Rhino plugin only when it is not current and no
// Rhino runs.
//
//   VIDE_TEST_RHINO_PLUGIN=<built VIDE.Worker.rhp> node tools/spikes/2026-10-08-paneling-pq/run-unroll.mjs
//     [--out result-unroll.json]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { sdkOptions } from '../../../src/server/sdk-options.ts';
import { launchRhinoWorker } from '../../../hosts/rhino/worker-client.ts';
import { installedConnectors } from '../2026-10-08-paneling/connectors.mjs';

const HERE = import.meta.dirname;
const probe = sdkOptions('.');
const plugin = process.env.VIDE_TEST_RHINO_PLUGIN
  ? resolve(process.env.VIDE_TEST_RHINO_PLUGIN)
  : probe.plugin;
if (!existsSync(probe.executable) || !existsSync(plugin)) {
  console.log(`skipped: Rhino 8 (${probe.executable}) or the plugin (${plugin}) is not available`);
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = resolve('.vide/spikes/paneling-pq', stamp);
await mkdir(directory, { recursive: true });
const body = readFileSync(join(HERE, 'unroll.cs'), 'utf8').replace(/\r\n/g, '\n');
const RUNS = [
  // Single curved (developable): quads along the rulings, triangles across them.
  { family: 'cylinder', nu: 100, nv: 50, tri: false, relTol: 0.01 },
  { family: 'cylinder', nu: 20, nv: 25, tri: true, relTol: 0.01 },
  { family: 'cone', nu: 40, nv: 25, tri: false, relTol: 0.01 },
  { family: 'cone', nu: 20, nv: 25, tri: true, relTol: 0.01 },
  { family: 'cone', nu: 100, nv: 50, tri: false, relTol: 0.001 },
  // Double curved: synclastic and anticlastic, small and large panels, three relative tolerances.
  { family: 'sphere', nu: 40, nv: 25, tri: false, relTol: 0.01 },
  { family: 'sphere', nu: 40, nv: 25, tri: false, relTol: 0.1 },
  { family: 'hypar', nu: 40, nv: 25, tri: false, relTol: 0.01 },
  { family: 'hypar', nu: 40, nv: 25, tri: false, relTol: 0.001 },
  { family: 'hypar', nu: 10, nv: 5, tri: false, relTol: 0.01 },
  { family: 'hypar', nu: 10, nv: 5, tri: false, relTol: 0.1 },
];
const result = { startedAt: new Date().toISOString(), runs: [] };
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
let worker;
try {
  let t = performance.now();
  worker = await launchRhinoWorker({
    ...sdkOptions(directory),
    plugin,
    directory: join(directory, 'worker'),
  });
  result.launchMs = Math.round(performance.now() - t);
  let revision = 0;
  for (const run of RUNS) {
    const head = `var FAMILY = ${JSON.stringify(run.family)}; var NU = ${run.nu}; var NV = ${run.nv}; var TRI = ${run.tri}; var RELTOL = ${run.relTol};\n`;
    t = performance.now();
    const r = await worker.execute(randomUUID(), revision, head + body);
    if (!r.ok) throw Error(JSON.stringify(r).slice(0, 2000));
    revision = r.revision;
    const row = { ...r.value, roundTripMs: Math.round(performance.now() - t) };
    result.runs.push(row);
    log(JSON.stringify(row));
  }
  result.passed = true;
} finally {
  await worker?.stop().catch(() => {});
  try {
    let running = false;
    try {
      running = /Rhino\.exe/i.test(
        execSync('tasklist /FI "IMAGENAME eq Rhino.exe" /NH', { encoding: 'utf8' }),
      );
    } catch {}
    let status = await installedConnectors();
    const rhino = status.connectors?.find((c) => c.id === 'rhino8');
    if (rhino && rhino.plugin !== 'current' && !running)
      status = await installedConnectors({ install: true });
    const after = status.connectors?.find((c) => c.id === 'rhino8');
    result.connectors = { rhino8: after?.plugin ?? null, rhinoRunning: running };
  } catch (error) {
    result.connectors = { error: String(error) };
  }
  result.finishedAt = new Date().toISOString();
  const text = JSON.stringify(result, null, 2);
  console.log(text);
  const i = process.argv.indexOf('--out');
  if (i > 0) writeFileSync(process.argv[i + 1], text + '\n');
}
