// Compute box (ARCH-03 §6.5, SPEC-07.9, PLAN-22 T-063): the runner for code an AI wrote. Step
// files are stripped of their TypeScript types and run in QuickJS compiled to wasm
// (quickjs-emscripten, MIT) inside the engine. The interpreter has no file, network, process,
// timer or environment API — `fetch`, `require` and `process` are simply not defined — and every
// run gets a fresh runtime with a memory limit and an interrupt at `budgetMs`. Input and output
// cross the boundary as JSON text only. The official libraries are the one way out: an import of
// `vide/geometry-kit` or `vide/structure-analysis` resolves to a generated module whose functions
// call the engine's own implementation with JSON arguments and get a JSON result (the analysis
// runners that start workers or native code are left out). Relative imports resolve only to the
// package's own files.

import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join, posix } from 'node:path';
import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import { officialLibraries, type LoadedJig } from './loader.ts';
import type { JigSource } from './manifest.ts';
import type { RunRequest, RunnerOut, StepRunner } from './runner.ts';

/** Library functions that start workers or native code; a compute box step cannot call them. */
export const BOX_LIBRARY_EXCLUDED: Record<string, readonly string[]> = {
  'vide/structure-analysis': [
    'runAnalysis',
    'analyzeSummary',
    'submitAnalysis',
    'closeAnalysisWorker',
    'analysisWorkerStats',
  ],
};
export const BOX_MEMORY_BYTES = 128 * 1024 * 1024;
export const BOX_STACK_BYTES = 1024 * 1024;
export const BOX_OUTPUT_BYTES = 16 * 1024 * 1024;
const SOURCE = /\.(ts|mts|js|mjs)$/;
const ENTRY = '__vide_entry.js';

export interface BoxLibrary {
  functions: Record<string, (...args: unknown[]) => unknown>;
  /** JSON-serializable constants the module also exports. */
  values: Record<string, unknown>;
}
export interface ComputeBoxOptions {
  memoryBytes?: number;
  maxOutputBytes?: number;
  /** Test seam: the injected libraries (default: the official ones minus the excluded functions). */
  libraries?: () => Promise<Record<string, BoxLibrary>>;
}

let quickjs: Promise<QuickJSWASMModule> | undefined;
const engine = () => (quickjs ??= newQuickJSWASMModule());

let boxLibraries: Promise<Record<string, BoxLibrary>> | undefined;
/** The official libraries as the box sees them: functions by name and plain constants. */
export function officialBoxLibraries(): Promise<Record<string, BoxLibrary>> {
  boxLibraries ??= (async () => {
    const out: Record<string, BoxLibrary> = {};
    for (const [id, info] of Object.entries(await officialLibraries())) {
      const excluded = BOX_LIBRARY_EXCLUDED[id] ?? [];
      const library: BoxLibrary = { functions: {}, values: {} };
      for (const [name, value] of Object.entries(info.module)) {
        if (!/^[A-Za-z_$][\w$]*$/.test(name) || excluded.includes(name)) continue;
        if (typeof value === 'function')
          library.functions[name] = value as (...args: unknown[]) => unknown;
        else {
          try {
            if (JSON.stringify(value) !== undefined) library.values[name] = value;
          } catch {
            /* not plain data: not exported to the box */
          }
        }
      }
      out[id] = library;
    }
    return out;
  })();
  return boxLibraries;
}

/** Strip the TypeScript types of a step file (Node's strip-only mode: no enums or namespaces). */
export function boxSource(file: string, text: string): string {
  if (!/\.m?ts$/.test(file)) return text;
  const emit = process.emitWarning;
  // Node marks the stripper experimental; the warning says nothing to a VIDE user.
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try {
    return stripTypeScriptTypes(text, { mode: 'strip' });
  } finally {
    process.emitWarning = emit;
  }
}

function libraryModule(id: string, library: BoxLibrary) {
  const lines = [
    `const call = (name, args) => { const out = globalThis.__vide_lib(${JSON.stringify(id)} + '#' + name, JSON.stringify(args)); return out === undefined ? undefined : JSON.parse(out); };`,
  ];
  for (const name of Object.keys(library.functions))
    lines.push(`export const ${name} = (...args) => call(${JSON.stringify(name)}, args);`);
  for (const [name, value] of Object.entries(library.values))
    lines.push(`export const ${name} = Object.freeze(${JSON.stringify(value)});`);
  return lines.join('\n');
}

const errorText = (ctx: QuickJSContext, handle: QuickJSHandle) => {
  const value = ctx.dump(handle) as { name?: string; message?: string; stack?: string } | string;
  if (value && typeof value === 'object')
    return `${value.name ?? 'Error'}: ${value.message ?? ''}${value.stack ? '\n' + value.stack.slice(0, 1000) : ''}`;
  return String(value);
};

export class ComputeBoxRunner implements StepRunner {
  readonly source: JigSource = 'ai-draft';
  private jig: LoadedJig | undefined;
  private files = new Map<string, string | Error>();
  private cancelled = new Set<string>();
  private readonly options: ComputeBoxOptions;
  constructor(options: ComputeBoxOptions = {}) {
    this.options = options;
  }
  async load(jig: LoadedJig) {
    this.jig = jig;
    this.files = new Map();
    for (const file of jig.files) {
      if (!SOURCE.test(file) || file.startsWith('dist/')) continue;
      try {
        this.files.set(file, boxSource(file, readFileSync(join(jig.dir, file), 'utf8')));
      } catch (error) {
        this.files.set(file, error as Error);
      }
    }
  }
  async run(request: RunRequest): Promise<RunnerOut> {
    const { runId } = request;
    const fail = (code: 'BUDGET' | 'THROW' | 'SCHEMA', message: string): RunnerOut => ({
      t: 'fail',
      runId,
      code,
      message,
    });
    if (!this.jig) return fail('THROW', 'NOT_LOADED');
    const [file, name] = request.step.entry.split('#');
    const entry = this.files.get(file);
    if (entry === undefined) return fail('THROW', `STEP_MISSING ${request.step.entry}`);
    if (entry instanceof Error) return fail('THROW', `STEP_SOURCE ${file}: ${entry.message}`);
    let args: string;
    try {
      args = JSON.stringify({ i: request.input, p: request.params, o: request.overrides ?? [] });
    } catch {
      return fail('THROW', 'INPUT_NOT_JSON');
    }
    const [module, libraries] = await Promise.all([
      engine(),
      (this.options.libraries ?? officialBoxLibraries)(),
    ]);
    if (this.cancelled.delete(runId)) return fail('BUDGET', 'CANCELLED');
    const start = performance.now();
    const deadline = Date.now() + request.budgetMs;
    let cancelled = false;
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(this.options.memoryBytes ?? BOX_MEMORY_BYTES);
    runtime.setMaxStackSize(BOX_STACK_BYTES);
    runtime.setInterruptHandler(() => {
      if (this.cancelled.delete(runId)) cancelled = true;
      return cancelled || Date.now() > deadline;
    });
    const files = this.files;
    // Own entries only: a name like `constructor` never reaches an Object.prototype member.
    const libraryOf = (name: string) =>
      Object.hasOwn(libraries, name) ? libraries[name] : undefined;
    runtime.setModuleLoader(
      (moduleName) => {
        const library = libraryOf(moduleName);
        if (library) return libraryModule(moduleName, library);
        const text = files.get(moduleName);
        if (typeof text === 'string') return text;
        return { error: new Error(`MODULE_NOT_ALLOWED ${moduleName}`) };
      },
      (base, requested) => {
        if (libraryOf(requested)) return requested;
        if (base === ENTRY && files.has(requested)) return requested;
        if (requested.startsWith('./') || requested.startsWith('../')) {
          const path = posix.normalize(posix.join(posix.dirname(base), requested));
          if (!path.startsWith('../') && files.has(path)) return path;
        }
        throw new Error(`MODULE_NOT_ALLOWED ${requested}`);
      },
    );
    const ctx = runtime.newContext();
    const over = (message: string) =>
      cancelled
        ? fail('BUDGET', 'CANCELLED')
        : Date.now() > deadline
          ? fail('BUDGET', `${Math.round(performance.now() - start)} ms > ${request.budgetMs} ms`)
          : /out of memory/i.test(message)
            ? fail('BUDGET', 'MEMORY')
            : undefined;
    try {
      const bridge = ctx.newFunction('__vide_lib', (nameHandle, argsHandle) => {
        const [id, fn] = ctx.getString(nameHandle).split('#');
        const library = libraryOf(id);
        const call =
          library && Object.hasOwn(library.functions, fn) ? library.functions[fn] : undefined;
        if (!call) throw new Error(`LIBRARY_UNKNOWN ${id}#${fn}`);
        // A library call runs on the engine's thread where the interrupt cannot reach it: no new
        // call starts once the budget is spent.
        if (Date.now() > deadline) throw new Error('BUDGET');
        const result = call(...(JSON.parse(ctx.getString(argsHandle)) as unknown[]));
        if (result && typeof (result as { then?: unknown }).then === 'function')
          throw new Error(`LIBRARY_ASYNC ${id}#${fn}`);
        const text = JSON.stringify(result);
        return text === undefined ? ctx.undefined : ctx.newString(text);
      });
      ctx.setProp(ctx.global, '__vide_lib', bridge);
      bridge.dispose();
      const argsHandle = ctx.newString(args);
      ctx.setProp(ctx.global, '__vide_args', argsHandle);
      argsHandle.dispose();
      // The entry module: its namespace's function becomes the step.
      const loaded = ctx.evalCode(
        `import * as m from ${JSON.stringify(file)}; globalThis.__vide_step = m[${JSON.stringify(name)}];`,
        ENTRY,
        { type: 'module' },
      );
      if (loaded.error) {
        const message = errorText(ctx, loaded.error);
        loaded.error.dispose();
        return over(message) ?? fail('THROW', message);
      }
      loaded.value.dispose();
      runtime.executePendingJobs().dispose();
      const called = ctx.evalCode(
        `(() => {
          const step = globalThis.__vide_step;
          if (typeof step !== 'function') throw new Error('STEP_MISSING ${request.step.entry.replace(/[^\w./#-]/g, '')}');
          const a = JSON.parse(globalThis.__vide_args);
          delete globalThis.__vide_args;
          const out = step(a.i, a.p, a.o);
          const text = (v) => { const t = JSON.stringify(v === undefined ? null : v); return t; };
          if (out && typeof out.then === 'function') {
            out.then((v) => { globalThis.__vide_out = text(v); }, (e) => { globalThis.__vide_err = String(e && e.stack ? e.message + '\\n' + e.stack : e); });
            return undefined;
          }
          return text(out);
        })()`,
        '__vide_call.js',
      );
      if (called.error) {
        const message = errorText(ctx, called.error);
        called.error.dispose();
        return over(message) ?? fail('THROW', message);
      }
      let text = ctx.typeof(called.value) === 'string' ? ctx.getString(called.value) : undefined;
      called.value.dispose();
      if (text === undefined) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          const message = errorText(ctx, jobs.error);
          jobs.error.dispose();
          return over(message) ?? fail('THROW', message);
        }
        const out = ctx.getProp(ctx.global, '__vide_out');
        const err = ctx.getProp(ctx.global, '__vide_err');
        try {
          if (ctx.typeof(err) === 'string') return fail('THROW', ctx.getString(err));
          if (ctx.typeof(out) !== 'string') return fail('THROW', 'STEP_NOT_SETTLED');
          text = ctx.getString(out);
        } finally {
          out.dispose();
          err.dispose();
        }
      }
      const ms = Math.round(performance.now() - start);
      if (Date.now() > deadline) return fail('BUDGET', `${ms} ms > ${request.budgetMs} ms`);
      if (Buffer.byteLength(text) > (this.options.maxOutputBytes ?? BOX_OUTPUT_BYTES))
        return fail('SCHEMA', 'OUTPUT_TOO_LARGE');
      return { t: 'done', runId, output: JSON.parse(text) as unknown, ms };
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      return over(message) ?? fail('THROW', message);
    } finally {
      try {
        ctx.dispose();
        runtime.dispose();
      } catch {
        // A leaked handle aborts the wasm instance: start the next run on a fresh one.
        quickjs = undefined;
      }
    }
  }
  cancel(runId: string) {
    this.cancelled.add(runId);
  }
  async close() {
    this.jig = undefined;
    this.files.clear();
    this.cancelled.clear();
  }
}
