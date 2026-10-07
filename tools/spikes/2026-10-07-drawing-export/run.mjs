// T-199 spike driver. Starts its own hidden Rhino 8 (build-model.py: synthetic 3dm + DWG export per
// scheme) and then its own hidden ZWCAD 2023 (DrawingExportProbe.dll reads each DWG in a side
// database). Only the processes started here are stopped; the user's Rhino/ZWCAD are never touched.
// Usage: node tools/spikes/2026-10-07-drawing-export/run.mjs [rhino|zwcad|all] [--discover]
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { launchOwnedHost } from '../../../hosts/common/owned-process.ts';

const here = resolve(import.meta.dirname);
const work = resolve('.vide/spikes/drawing-export');
const RHINO = 'C:\\Program Files\\Rhino 8\\System\\Rhino.exe';
const ZWCAD = 'C:\\Program Files\\ZWSOFT\\ZWCAD 2023\\ZWCAD.exe';
const PROBE = resolve('.vide/build/drawing-export/VIDE.DrawingExportProbe.dll');
const SCHEMES = (process.env.VIDE_SPIKE_SCHEMES ?? '2018 Lines|2018 Natural|2018 Solids|Default').split('|');
const phase = process.argv[2] ?? 'all';
const discover = process.argv.includes('--discover');

async function waitFor(file, ms) {
  const deadline = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return true;
}

async function rhino() {
  await mkdir(work, { recursive: true });
  for (const f of await readdir(work)) if (/^(export-|discover|synthetic|linked-part|rhino)/.test(f)) await rm(join(work, f), { force: true });
  const owner = await launchOwnedHost({
    executable: RHINO,
    args: ['/nosplash', '/notemplate', '/scheme=VIDE-Spike-Export', `/runscript="_-RunPythonScript (${join(here, 'build-model.py')})"`],
    environment: { ...process.env, VIDE_SPIKE_WORK: work, VIDE_SPIKE_SCHEMES: SCHEMES.join('|'), VIDE_SPIKE_MODE: discover ? 'discover' : 'full' },
    spawnProcess: (file, args, options) => spawn(file, args, { ...options, windowsVerbatimArguments: true }),
  });
  console.log('rhino pid', owner.identity.pid);
  const done = await waitFor(join(work, 'rhino.done'), 5 * 60000);
  await new Promise((r) => setTimeout(r, 5000));
  await owner.stop().catch((e) => console.log('stop:', e.message));
  console.log('rhino done', done);
}

async function zwcad() {
  const control = join(work, 'control-zwcad.dwg');
  await rm(control, { force: true });
  const files = (await readdir(work)).filter((f) => f.startsWith('export-') && f.endsWith('.dwg')).map((f) => join(work, f));
  files.push(control);
  const manifest = join(work, 'manifest.tsv'), output = join(work, 'probe.jsonl'), script = join(work, 'start.scr');
  await rm(output + '.done', { force: true });
  await writeFile(manifest, files.join('\n'), 'utf8');
  await writeFile(script, `(command "_NETLOAD" ${JSON.stringify(PROBE.replaceAll('\\', '/'))})\nVIDEDRAWINGPROBE\n`);
  const owner = await launchOwnedHost({
    executable: ZWCAD,
    args: ['/b', script],
    environment: { ...process.env, VIDE_PROBE_MANIFEST: manifest, VIDE_PROBE_OUT: output, VIDE_PROBE_CONTROL: control },
  });
  console.log('zwcad pid', owner.identity.pid);
  // A crash in an earlier run leaves a "send report?" prompt that blocks the hidden start.
  const prompt = setInterval(() => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'dismiss-crash-prompt.ps1'), String(owner.identity.pid)], { windowsHide: true });
    ps.stdout.on('data', (d) => String(d).includes('dismissed') && console.log('crash prompt dismissed'));
  }, 5000);
  const done = await waitFor(output + '.done', 3 * 60000);
  clearInterval(prompt);
  await owner.stop().catch((e) => console.log('stop:', e.message));
  console.log('zwcad done', done);
}

if (phase === 'rhino' || phase === 'all') await rhino();
if (phase === 'zwcad' || phase === 'all') await zwcad();
