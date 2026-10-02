// Diagnostic lines of the AI CLI processes (T-126, ADR-031 9): which CLI and version ran, how it
// ended (exit code, signal, run time) and, when it failed, the last 2 KB of its error output with
// keys and tokens taken out. Never the arguments, the input or the answer. The lines go to the
// engine log only (never to the AI).
import type { spawn } from 'node:child_process';
import { currentTrace, diagnostic, scrub } from '../core/breadcrumbs.ts';

export interface CliDescription {
  provider: string;
  version?: string;
  model?: string;
  effort?: string;
}

/** What kind of run the arguments start: the subcommand word, never the arguments themselves. */
function kindOf(args: unknown) {
  const list = Array.isArray(args) ? args.map(String) : [];
  if (list.includes('--version')) return 'version';
  const word = list.find((arg) => /^[a-z][a-z-]{1,30}$/.test(arg));
  if (word === 'auth' || word === 'login') return 'auth';
  if (word === 'exec' || word === 'app-server') return word;
  return list.includes('--input-format') ? 'session' : 'run';
}

/**
 * Wraps a spawn function so every CLI process it starts is logged (start of runs, every failed end,
 * every end of a run). Logging never changes the process or the caller.
 */
export function watchedSpawn<T extends typeof spawn>(base: T, describe: () => CliDescription): T {
  return ((command: string, args: string[], options: unknown) => {
    const child = (base as unknown as (...values: unknown[]) => ReturnType<typeof spawn>)(
      command,
      args,
      options,
    );
    try {
      watch(child, kindOf(args), args, describe);
    } catch {
      /* Diagnostics never change the run. */
    }
    return child;
  }) as unknown as T;
}

function watch(
  child: ReturnType<typeof spawn>,
  kind: string,
  args: unknown,
  describe: () => CliDescription,
) {
  if (!child || typeof child.once !== 'function') return;
  const began = performance.now();
  const trace = currentTrace();
  const base = () => {
    const about = describe();
    const list = Array.isArray(args) ? args.map(String) : [];
    return {
      ...(trace ? { requestId: trace.requestId } : {}),
      provider: about.provider,
      ...(about.version ? { cliVersion: about.version } : {}),
      ...(about.model ? { model: about.model } : {}),
      ...(about.effort ? { effort: about.effort } : {}),
      kind,
      ...(list.includes('--resume') || list.includes('resume') ? { resume: true } : {}),
      pid: child.pid,
    };
  };
  const quiet = kind === 'version' || kind === 'auth';
  if (!quiet) diagnostic('cli-start', base());
  let tail = '';
  child.stderr?.on?.('data', (chunk: Buffer | string) => {
    tail = (tail + chunk.toString()).slice(-8192);
  });
  child.once('error', (error: Error & { code?: unknown }) => {
    diagnostic('cli-error', {
      ...base(),
      code: typeof error?.code === 'string' ? error.code : 'SPAWN_FAILED',
    });
  });
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    const failed = code !== 0 || signal !== null;
    if (quiet && !failed) return;
    diagnostic('cli-exit', {
      ...base(),
      code,
      ...(signal ? { signal } : {}),
      ms: Math.round(performance.now() - began),
      ...(failed && tail.trim() ? { stderrTail: scrub(tail, 2048) } : {}),
    });
  });
}
