// Step execution (ARCH-03 §6, SPEC-07.7·07.9·07.17). A `StepRunner` runs one `code` step where its
// source allows — in the engine (`builtin`), in a Node child process (`dev-source`, `dev-pack`) or
// in the compute box (`ai-draft`, T-063). `executeSteps` walks the step graph in order: it builds
// each step's input from what it declared to read, hashes that input (package digest, step id,
// input hashes, read settings, overrides) to reuse a cached result, runs the before/after gates,
// checks the output against its schema, and stops the steps after a failure or a block. Library
// steps run in the engine; human steps wait for a confirmation with the same fingerprint; AI and
// host steps are not executed here (T-063, T-055).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runGates, type GateContext, type GateResult } from './gates.ts';
import { buildGraph, type StepGraph } from './graph.ts';
import { hashValue } from './hash.ts';
import type { AssembledRole, Override } from './instance.ts';
import { libraryFunction, type LoadedJig } from './loader.ts';
import type { JigSource, StepDecl } from './manifest.ts';
import { plainValues, type ParamValue } from './params.ts';
import { checkSchema } from './schema.ts';

export type RunnerIn =
  | { t: 'load'; jig: string; version: string; dir: string; digest: string; bundled: boolean }
  | {
      t: 'run';
      runId: string;
      step: string;
      entry: string;
      input: unknown;
      params: Record<string, unknown>;
      overrides: Override[];
      budgetMs: number;
    }
  | { t: 'cancel'; runId: string };
export type RunnerOut =
  | { t: 'done'; runId: string; output: unknown; ms: number }
  | { t: 'fail'; runId: string; code: 'BUDGET' | 'THROW' | 'SCHEMA'; message: string }
  | { t: 'log'; runId: string; text: string };

export interface RunRequest {
  runId: string;
  step: StepDecl & { kind: 'code' };
  input: unknown;
  params: Record<string, unknown>;
  overrides: Override[];
  budgetMs: number;
}
export interface StepRunner {
  readonly source: JigSource;
  load(jig: LoadedJig): Promise<void>;
  run(request: RunRequest): Promise<RunnerOut>;
  cancel(runId: string): void;
  close(): Promise<void>;
}

export type StepFunction = (
  inputs: unknown,
  params: Record<string, unknown>,
  overrides: Override[],
) => unknown;

/** Resolve a step's function from its package: the pack bundle when present, else the `.ts` file. */
export async function resolveStepFunction(
  dir: string,
  entry: string,
  bundled: boolean,
): Promise<StepFunction> {
  const [file, name] = entry.split('#');
  if (bundled) {
    const bundle = (await import(pathToFileURL(join(dir, 'dist', 'steps.mjs')).href)) as {
      steps?: Record<string, unknown>;
    };
    const fn = bundle.steps?.[entry];
    if (typeof fn !== 'function') throw new Error(`STEP_MISSING ${entry}`);
    return fn as StepFunction;
  }
  const module = (await import(pathToFileURL(join(dir, file)).href)) as Record<string, unknown>;
  const fn = module[name];
  if (typeof fn !== 'function') throw new Error(`STEP_MISSING ${entry}`);
  return fn as StepFunction;
}

/** Runs `code` steps in this process (official jigs, and the selftest of any source). */
export class EngineRunner implements StepRunner {
  readonly source: JigSource = 'builtin';
  private jig: LoadedJig | undefined;
  async load(jig: LoadedJig) {
    this.jig = jig;
  }
  async run(request: RunRequest): Promise<RunnerOut> {
    const jig = this.jig;
    if (!jig) return { t: 'fail', runId: request.runId, code: 'THROW', message: 'NOT_LOADED' };
    const start = performance.now();
    try {
      const fn = await resolveStepFunction(jig.dir, request.step.entry, jig.bundled);
      const output = await fn(request.input, request.params, request.overrides);
      const ms = Math.round(performance.now() - start);
      // A synchronous function cannot be interrupted here; over budget its result is still dropped.
      if (ms > request.budgetMs)
        return {
          t: 'fail',
          runId: request.runId,
          code: 'BUDGET',
          message: `${ms} ms > ${request.budgetMs} ms`,
        };
      return { t: 'done', runId: request.runId, output, ms };
    } catch (error) {
      return {
        t: 'fail',
        runId: request.runId,
        code: 'THROW',
        message: String((error as Error)?.message ?? error),
      };
    }
  }
  cancel() {}
  async close() {}
}

export const DEFAULT_BUDGET_MS = { code: 10_000, library: 60_000 } as const;
export const budgetOf = (step: StepDecl) =>
  step.budget?.wallClockMs ??
  (step.kind === 'library' ? DEFAULT_BUDGET_MS.library : DEFAULT_BUDGET_MS.code);

export type RunMode = 'geometry' | 'preview' | 'confirmed' | 'selftest';
export type ReportStatus =
  | 'done'
  | 'failed'
  | 'waiting'
  | 'confirmed'
  | 'reconfirm'
  | 'blocked'
  | 'skipped'
  | 'gate-failed';

export interface StepReport {
  id: string;
  kind: StepDecl['kind'];
  status: ReportStatus;
  inputHash: string;
  cached: boolean;
  ms: number | null;
  gates: GateResult[];
  error?: { code: string; message: string };
  outputRef?: string;
}
export interface ExecutionReport {
  mode: RunMode;
  steps: StepReport[];
  outputs: Record<string, unknown>;
  /** A block gate or failure stopped the steps after it. */
  blocked: boolean;
  /** Settings changed while running: the results are not the latest and were not kept. */
  superseded: boolean;
}

/** Where step results are kept between runs; the runtime backs this with files and `jig_runs`. */
export interface StepCache {
  get(stepId: string, inputHash: string): Promise<unknown | undefined>;
  put(stepId: string, inputHash: string, output: unknown): Promise<string | undefined>;
  /** The step's previous result, for `ids-stable`. */
  previous?(stepId: string): Promise<{ inputHash: string; output: unknown } | null>;
}
export class MemoryCache implements StepCache {
  readonly entries = new Map<string, unknown>();
  async get(stepId: string, hash: string) {
    return this.entries.get(`${stepId}:${hash}`);
  }
  async put(stepId: string, hash: string, output: unknown) {
    this.entries.set(`${stepId}:${hash}`, output);
    return undefined;
  }
}

export interface ExecutionInput {
  jig: LoadedJig;
  runner: StepRunner;
  cache: StepCache;
  mode: RunMode;
  /** Input values by key; an assembly input is `{ <role>: snapshot }`. */
  inputs: Record<string, unknown>;
  params: Record<string, ParamValue>;
  overrides?: Override[];
  /** Assembly roles by `<key>.<role>` (confirmation and revision keys for the gates). */
  assembly?: Record<string, AssembledRole>;
  currentRevisions?: Record<string, string>;
  layerRoot?: string;
  hooks?: GateContext['hooks'];
  /** Human steps confirmed: step id → the input fingerprint that was confirmed. */
  confirmations?: Record<string, string>;
  /** Stop after this step. */
  until?: string;
  /** False when a newer change made this run obsolete. */
  isCurrent?: () => boolean;
  graph?: StepGraph;
  log?: (line: string) => void;
}

function stepInput(
  step: StepDecl,
  graph: StepGraph,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
) {
  const input: Record<string, unknown> = {};
  const hashes: Record<string, unknown> = {};
  const paramKeys: string[] = [];
  for (const read of graph.readsOf(step.id)) {
    if (read.kind === 'input') {
      const whole = inputs[read.key];
      if (read.role === undefined) {
        input[read.key] = whole;
        hashes[read.text] = fingerprint(whole);
      } else {
        const role =
          whole && typeof whole === 'object'
            ? (whole as Record<string, unknown>)[read.role]
            : undefined;
        input[read.key] = {
          ...((input[read.key] as Record<string, unknown>) ?? {}),
          [read.role]: role,
        };
        hashes[read.text] = fingerprint(role);
      }
    } else if (read.kind === 'step') {
      input.steps = {
        ...((input.steps as Record<string, unknown>) ?? {}),
        [read.id]: outputs[read.id],
      };
    } else paramKeys.push(read.key);
  }
  return { input, hashes, paramKeys };
}
/** A role snapshot carries its hash; anything else is hashed here (memoised per value). */
const fingerprints = new WeakMap<object, string>();
function fingerprint(value: unknown): string {
  if (value && typeof value === 'object') {
    const snapshot = value as { snapshot?: { hash?: string } };
    if (typeof snapshot.snapshot?.hash === 'string') return snapshot.snapshot.hash;
    const known = fingerprints.get(value);
    if (known) return known;
    const hash = hashValue(value);
    fingerprints.set(value, hash);
    return hash;
  }
  return hashValue(value);
}

function outputSchema(jig: LoadedJig, step: StepDecl): unknown {
  const file = join(jig.dir, 'schemas', 'steps', `${step.writes}.json`);
  if (!jig.files.includes(`schemas/steps/${step.writes}.json`) || !existsSync(file))
    return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Run the steps of a jig in order (see the module comment). */
export async function executeSteps(input: ExecutionInput): Promise<ExecutionReport> {
  const { jig, runner, cache, mode } = input;
  const graph = input.graph ?? buildGraph(jig.manifest).graph;
  const overrides = input.overrides ?? [];
  const params = input.params;
  const plain = plainValues(params);
  const outputs: Record<string, unknown> = {};
  const inputHashes: Record<string, string> = {};
  const steps: StepReport[] = [];
  const stopped = new Set<string>(); // steps whose predecessors failed, blocked or wait
  let blocked = false;
  let superseded = false;
  await runner.load(jig);
  const contextFor = (
    step: StepDecl,
    stepInputs: Record<string, unknown>,
    extra: Partial<GateContext>,
  ): GateContext => ({
    manifest: jig.manifest,
    stepId: step.id,
    inputs: stepInputs,
    params,
    assembly: input.assembly,
    currentRevisions: input.currentRevisions,
    layerRoot: input.layerRoot,
    hooks: input.hooks,
    ...extra,
  });

  for (const id of graph.order) {
    const step = graph.steps.get(id)!;
    const { input: stepInputs, hashes, paramKeys } = stepInput(step, graph, input.inputs, outputs);
    const material = {
      digest: jig.digest,
      step: id,
      reads: hashes,
      steps: Object.fromEntries(
        (step.reads.filter((r) => r.startsWith('step.')) ?? []).map((r) => [
          r,
          inputHashes[r.slice(5)] ?? null,
        ]),
      ),
      params: Object.fromEntries(paramKeys.map((key) => [key, plain[key]])),
      // Overrides reach code and library steps; a person's confirmation is of what the step reads.
      overrides: step.kind === 'human' ? [] : overrides,
    };
    const inputHash = hashValue(material);
    inputHashes[id] = inputHash;
    const report: StepReport = {
      id,
      kind: step.kind,
      status: 'skipped',
      inputHash,
      cached: false,
      ms: null,
      gates: [],
    };
    steps.push(report);
    const before = [...(graph.needs.get(id) ?? [])];
    const stepParams = Object.fromEntries(paramKeys.map((key) => [key, plain[key]]));

    if (stopped.has(id) || before.some((n) => stopped.has(n))) {
      report.status = 'blocked';
      stopped.add(id);
      continue;
    }
    if (input.isCurrent && !input.isCurrent()) {
      superseded = true;
      report.status = 'skipped';
      stopped.add(id);
      continue;
    }
    // Human steps: confirmed with this fingerprint, confirmed with another, or waiting.
    if (step.kind === 'human') {
      const gates = runGates(
        step.gates ?? [],
        'before-run',
        contextFor(step, stepInputs, { inputHash }),
      );
      report.gates = gates.results;
      if (mode === 'selftest' || mode === 'preview') report.status = 'confirmed';
      else {
        const confirmed = input.confirmations?.[id];
        report.status = confirmed === inputHash ? 'confirmed' : confirmed ? 'reconfirm' : 'waiting';
      }
      if (report.status !== 'confirmed') {
        stopped.add(id);
        for (const other of step.blocks) stopped.add(other);
      }
      outputs[id] = { status: report.status };
      if (id === input.until) break;
      continue;
    }
    if (step.kind === 'host') {
      // Rhino에 만들기 is an explicit action (T-055); a host step only marks that it is due.
      report.status = 'waiting';
      if (id === input.until) break;
      continue;
    }
    if (step.kind === 'ai') {
      report.status = 'failed';
      report.error = { code: 'AI_UNAVAILABLE', message: 'AI 단계는 아직 실행되지 않습니다(T-063)' };
      stopped.add(id);
      continue;
    }
    if (mode === 'geometry' && step.kind === 'library') {
      report.status = 'skipped';
      stopped.add(id);
      continue;
    }

    // Before-run gates.
    const beforeGates = runGates(
      step.gates ?? [],
      'before-run',
      contextFor(step, stepInputs, { inputHash }),
    );
    report.gates = beforeGates.results;
    if (beforeGates.blocked.length) {
      report.status = 'gate-failed';
      blocked = true;
      stopped.add(id);
      continue;
    }

    // Cached result with the same fingerprint.
    const cached = await cache.get(id, inputHash);
    let output: unknown;
    if (cached !== undefined) {
      output = cached;
      report.cached = true;
      report.ms = 0;
    } else {
      const start = performance.now();
      let result: RunnerOut;
      if (step.kind === 'library') {
        try {
          const fn = await libraryFunction(step.use);
          const value = await fn(stepInputs, { ...stepParams, ...(step.args ?? {}) }, overrides);
          result = {
            t: 'done',
            runId: id,
            output: value,
            ms: Math.round(performance.now() - start),
          };
        } catch (error) {
          result = {
            t: 'fail',
            runId: id,
            code: 'THROW',
            message: String((error as Error)?.message ?? error),
          };
        }
      } else {
        result = await runner.run({
          runId: `${id}:${inputHash.slice(0, 12)}`,
          step,
          input: stepInputs,
          params: stepParams,
          overrides,
          budgetMs: budgetOf(step),
        });
      }
      if (result.t !== 'done') {
        report.status = 'failed';
        report.ms = Math.round(performance.now() - start);
        report.error =
          result.t === 'fail'
            ? { code: result.code, message: result.message }
            : { code: 'THROW', message: 'no result' };
        input.log?.(`${id}: ${report.error.code} ${report.error.message}`);
        stopped.add(id);
        blocked = true;
        continue;
      }
      output = result.output;
      report.ms = result.ms;
      const schema = outputSchema(jig, step);
      const problems = schema ? checkSchema(schema, output) : [];
      if (problems.length) {
        report.status = 'failed';
        report.error = {
          code: 'SCHEMA',
          message: problems
            .map((p) => `${p.path}: ${p.message}`)
            .slice(0, 3)
            .join('; '),
        };
        stopped.add(id);
        blocked = true;
        continue;
      }
    }

    // After-run gates (isolate gates may trim the output).
    const previous = (await cache.previous?.(id)) ?? null;
    const afterGates = runGates(
      step.gates ?? [],
      'after-run',
      contextFor(step, stepInputs, { inputHash, output, previous }),
    );
    report.gates = [...report.gates, ...afterGates.results];
    output = afterGates.output;
    if (afterGates.blocked.length) {
      report.status = 'gate-failed';
      blocked = true;
      stopped.add(id);
      outputs[id] = output;
      continue;
    }
    if (input.isCurrent && !input.isCurrent()) {
      superseded = true;
      report.status = 'skipped';
      stopped.add(id);
      continue;
    }
    outputs[id] = output;
    report.status = 'done';
    if (!report.cached && mode !== 'preview')
      report.outputRef = await cache.put(id, inputHash, output);
    if (id === input.until) break;
  }
  return { mode, steps, outputs, blocked, superseded };
}
