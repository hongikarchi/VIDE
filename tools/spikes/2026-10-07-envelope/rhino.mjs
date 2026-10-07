// T-204 spike: runs rhino.py in a hidden Rhino 8 this script starts itself (the same owned-process
// launch as hosts/rhino/worker-client.ts), waits for rhino.done and stops only that PID. Never
// attaches to or stops a Rhino the user started. Run run.ts first (it writes rhino-input.json).
// Usage: node tools/spikes/2026-10-07-envelope/rhino.mjs [main|stress] [diag]
//   stress: run stress.ts first. diag: rhino-diag.py instead of rhino.py (VIDE_SPIKE_ONLY=id,id).
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { launchOwnedHost } from '../../../hosts/common/owned-process.ts';

const here = resolve(import.meta.dirname);
const work = resolve('.vide/spikes/envelope');
const suffix = process.argv[2] === 'stress' ? '-stress' : '';
const script = process.argv[3] === 'diag' ? 'rhino-diag.py' : 'rhino.py';
const RHINO = process.env.VIDE_RHINO_EXE ?? 'C:\\Program Files\\Rhino 8\\System\\Rhino.exe';
if (!existsSync(join(work, `rhino-input${suffix}.json`))) throw new Error('run run.ts first');
const outputs =
  script === 'rhino.py'
    ? [`rhino-result${suffix}.json`, `rhino-envelope${suffix}.3dm`]
    : [`rhino-diag${suffix}.json`];
for (const f of ['rhino.done', ...outputs]) await rm(join(work, f), { force: true });

const t0 = Date.now();
const owner = await launchOwnedHost({
  executable: RHINO,
  args: [
    '/nosplash',
    '/notemplate',
    '/scheme=VIDE-Spike-Envelope',
    `/runscript="_-RunPythonScript (${join(here, script)})"`,
  ],
  environment: { ...process.env, VIDE_SPIKE_WORK: work, VIDE_SPIKE_SUFFIX: suffix },
  spawnProcess: (file, args, options) =>
    spawn(file, args, { ...options, windowsVerbatimArguments: true }),
});
console.log('rhino pid', owner.identity.pid);
const deadline = Date.now() + 15 * 60000;
while (!existsSync(join(work, 'rhino.done')) && Date.now() < deadline)
  await new Promise((r) => setTimeout(r, 1000));
const done = existsSync(join(work, 'rhino.done'));
await new Promise((r) => setTimeout(r, 3000));
await owner.stop().catch((e) => console.log('stop:', e.message));
console.log('done', done, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
