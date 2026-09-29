// Entry of the jig child process (ARCH-03 §6.2·§6.4): JSON lines in on stdin, JSON lines out on
// stdout. `load` names the package; `run` calls one step function `(inputs, params, overrides)`
// and answers `done` or `fail`. It imports only the package's own files (the pack bundle
// `dist/steps.mjs`, or the `.ts` step files through Node's type stripping) and never reads
// anything else — the permission flags the engine starts it with make that a hard limit.

import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Fn = (inputs: unknown, params: Record<string, unknown>, overrides: unknown[]) => unknown;
let dir = '';
let bundled = false;
const functions = new Map<string, Fn>();
const out = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');

async function resolveStep(entry: string): Promise<Fn> {
  const known = functions.get(entry);
  if (known) return known;
  const [file, name] = entry.split('#');
  let fn: unknown;
  if (bundled) {
    const bundle = (await import(pathToFileURL(join(dir, 'dist', 'steps.mjs')).href)) as {
      steps?: Record<string, unknown>;
    };
    fn = bundle.steps?.[entry];
  } else {
    const module = (await import(pathToFileURL(join(dir, file)).href)) as Record<string, unknown>;
    fn = module[name];
  }
  if (typeof fn !== 'function') throw new Error(`STEP_MISSING ${entry}`);
  functions.set(entry, fn as Fn);
  return fn as Fn;
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (message.t === 'load') {
    dir = String(message.dir);
    bundled = message.bundled === true;
    functions.clear();
    return;
  }
  if (message.t !== 'run') return;
  const runId = String(message.runId);
  void (async () => {
    try {
      const fn = await resolveStep(String(message.entry));
      const start = performance.now();
      const output = await fn(
        message.input,
        (message.params ?? {}) as Record<string, unknown>,
        (message.overrides ?? []) as unknown[],
      );
      JSON.stringify(output); // must be serialisable
      out({ t: 'done', runId, output, ms: Math.round(performance.now() - start) });
    } catch (error) {
      out({ t: 'fail', runId, code: 'THROW', message: String((error as Error)?.message ?? error) });
    }
  })();
});
process.stdin.on('end', () => process.exit(0));
