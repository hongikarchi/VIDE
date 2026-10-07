// One run of a worker command in a hidden ZWCAD the engine starts and owns (PLAN-47 T-226,
// SPEC-14.13 실패 1). Every drawing job (xref read, backflow, new drawing, title blocks) goes
// through here so the time limit, the stop, the end check and crash dumps are handled once:
//  - the host is started by `launchHiddenZwcad` (the H-ZWCAD-13 crash-prompt watch included);
//  - the run ends when the worker's done marker appears, the caller's signal aborts, the whole
//    time limit passes, the host exits by itself, or nothing moves for `stallMs` (no new result
//    and no new worker step): ZWCAD 2023 does not exit after a native crash but writes its crash
//    report and idles (SPIKE-2026-10-07-drawing-backflow 결과 4), so this watch is what ends it;
//  - only side-database commands run here (`SIDE_DATABASE_COMMANDS`): the worker reads and writes
//    drawings with `Database.ReadDwgFile`/`SaveAs` and never opens a document, so no modal
//    dialog (missing xref, recovery) can hold the hidden host;
//  - only the process started here is stopped (`owner.stop` re-checks PID, start time and path),
//    never the user's ZWCAD; the run's folder and the drawings are left to the caller;
//  - a failed run carries its exit code/signal, the worker's last step (`VIDE_WORKER_STEP` file)
//    and the ZWCAD crash dumps that appeared during the run. Dumps are listed, never moved.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchHiddenZwcad } from './crash-prompt.ts';
import { diagnostic } from '../../src/core/breadcrumbs.ts';

export type HiddenRunFailure =
  | 'STOPPED'
  | 'HIDDEN_HOST_TIMEOUT'
  | 'HIDDEN_HOST_STALLED'
  | 'HIDDEN_HOST_EXITED';

export interface HiddenRunReport {
  /** `done`: the worker's marker; `stalled`: no new result for `stallMs` with `onStall: 'end'`. */
  ended: 'done' | 'stalled';
  ms: number;
  lastStep: string | null;
  newDumps: string[];
}

export interface HiddenRunDetails {
  ms: number;
  lastStep: string | null;
  newDumps: string[];
  exit?: { code: number | null; signal: string | null };
}
export class HiddenRunError extends Error {
  readonly code: HiddenRunFailure;
  readonly details: HiddenRunDetails;
  constructor(code: HiddenRunFailure, details: HiddenRunDetails) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

type Launch = typeof launchHiddenZwcad;

/**
 * Worker commands a hidden run may start, with the worker source that holds each. All of them work
 * on side databases only; tests/core/zwcad-hidden-run.test.mjs checks those sources never open a
 * document. A new command is added here together with that check.
 */
export const SIDE_DATABASE_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  VIDEXREFGRAPH: 'XrefGraph.cs',
  VIDEXREFFIXTURE: 'XrefGraph.cs',
  VIDEDRAWINGCOPY: 'DrawingOutput.cs',
  VIDEDRAWINGFIXTURE: 'DrawingOutput.cs',
  VIDEDRAWINGINSPECT: 'DrawingInspect.cs',
  VIDEKNOWLEDGEDWG: 'KnowledgeDwg.cs',
});

/** Default no-progress limit: a crashed ZWCAD shows no new step or result after this. */
export const STALL_MS = 120_000;

export interface HiddenRunOptions {
  /** Short name for the diagnostic log (`xref-graph`, `drawing-copy`, …). */
  label: string;
  executable: string;
  plugin: string;
  /** The worker's command (`VIDEXREFGRAPH`, `VIDEDRAWINGCOPY`, …). */
  command: string;
  /** This run's own folder: the start script and the step file go here. */
  folder: string;
  environment?: Record<string, string>;
  /** True once the worker's done marker is there. */
  finished: () => Promise<boolean>;
  /** Results so far; a change restarts the stall clock and ends the crash-prompt watch. */
  progress?: () => Promise<number>;
  timeoutMs?: number;
  /** No new result and no new worker step for this long: the host is stalled (default
   *  `STALL_MS`, at most `timeoutMs`). */
  stallMs?: number;
  onStall?: 'fail' | 'end';
  signal?: AbortSignal;
  intervalMs?: number;
  launch?: Launch;
  /** Names of the ZWCAD crash dumps now present (`zwcadCrashDumps`). */
  crashDumps?: () => Promise<string[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (fields: Record<string, unknown>) => void;
}

/** `%APPDATA%\ZWSOFT\ZWCAD\2023\<locale>\CrashReport\*`, as `<locale>/<name>`; read only. */
export async function zwcadCrashDumps(appData = process.env.APPDATA): Promise<string[]> {
  if (!appData) return [];
  const root = join(appData, 'ZWSOFT', 'ZWCAD', '2023');
  const names: string[] = [];
  let locales: string[] = [];
  try {
    locales = await readdir(root);
  } catch {
    return names;
  }
  for (const locale of locales)
    try {
      for (const name of await readdir(join(root, locale, 'CrashReport')))
        names.push(`${locale}/${name}`);
    } catch {
      /* No crash report folder for this locale. */
    }
  return names;
}

async function lastLine(file: string) {
  try {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/).filter((line) => line.trim());
    return lines.at(-1)?.trim().slice(0, 200) ?? null;
  } catch {
    return null;
  }
}

export async function runHiddenZwcad({
  label,
  executable,
  plugin,
  command,
  folder,
  environment = {},
  finished,
  progress,
  timeoutMs = 10 * 60_000,
  stallMs = Math.min(timeoutMs, STALL_MS),
  onStall = 'fail',
  signal,
  intervalMs = 500,
  launch = launchHiddenZwcad,
  crashDumps = zwcadCrashDumps,
  now = Date.now,
  sleep = (ms) => new Promise<void>((accept) => setTimeout(accept, ms)),
  log = (fields) => diagnostic('zwcad-hidden-run', fields),
}: HiddenRunOptions): Promise<HiddenRunReport> {
  if (!/^[A-Z][A-Z0-9]*$/.test(command) || !Object.hasOwn(SIDE_DATABASE_COMMANDS, command))
    throw new Error('INVALID_HOST_LAUNCH');
  if (signal?.aborted) throw new HiddenRunError('STOPPED', { ms: 0, lastStep: null, newDumps: [] });
  const stepFile = join(folder, 'step.txt');
  const script = join(folder, 'start.scr');
  await writeFile(
    script,
    `(command "_NETLOAD" ${JSON.stringify(plugin.replaceAll('\\', '/'))})\n${command}\n`,
  );
  const dumpsBefore = new Set(await crashDumps().catch(() => [] as string[]));
  const started = now();
  const owner = await launch({
    executable,
    args: ['/b', script],
    visible: false,
    environment: { ...process.env, ...environment, VIDE_WORKER_STEP: stepFile },
  });
  let outcome: HiddenRunFailure | HiddenRunReport['ended'] | undefined;
  let exit: { code: number | null; signal: string | null } | undefined;
  try {
    let seen = -1,
      steps = -1,
      last = started;
    while (!outcome) {
      if (signal?.aborted) outcome = 'STOPPED';
      else if (await finished()) outcome = 'done';
      else if ((exit = owner.exitStatus?.()))
        // One more look: the marker may have been written just before the host ended.
        outcome = (await finished()) ? 'done' : 'HIDDEN_HOST_EXITED';
      else if (now() - started > timeoutMs) outcome = 'HIDDEN_HOST_TIMEOUT';
      else {
        const count = progress ? await progress() : 0;
        // The step file only grows (one line per worker step): its size is the step progress.
        const stepped = await stat(stepFile).then(
          (info) => info.size,
          () => 0,
        );
        if (count !== seen) {
          if (seen >= 0 || count > 0) owner.settled();
          seen = count;
          last = now();
        }
        if (stepped !== steps) {
          steps = stepped;
          last = now();
        }
        if (now() - last > stallMs) outcome = onStall === 'end' ? 'stalled' : 'HIDDEN_HOST_STALLED';
        if (!outcome) await sleep(intervalMs);
      }
    }
  } finally {
    owner.settled();
    // Only the process launched above; stop() refuses a PID whose identity changed.
    // `exit` stays as seen before this stop: a host that was still running has none.
    await owner.stop().catch((error: Error) => log({ run: label, stop: error.message }));
  }
  const ms = now() - started;
  const newDumps = (await crashDumps().catch(() => [] as string[])).filter(
    (name) => !dumpsBefore.has(name),
  );
  const lastStep = await lastLine(stepFile);
  const failed = outcome !== 'done' && outcome !== 'stalled';
  log({
    run: label,
    outcome,
    ms,
    ...(failed ? { exitCode: exit?.code ?? null, exitSignal: exit?.signal ?? null } : {}),
    ...(failed || newDumps.length ? { lastStep } : {}),
    ...(newDumps.length ? { newDumps: newDumps.length } : {}),
  });
  if (failed)
    throw new HiddenRunError(outcome as HiddenRunFailure, { ms, lastStep, newDumps, exit });
  return { ended: outcome as HiddenRunReport['ended'], ms, lastStep, newDumps };
}
