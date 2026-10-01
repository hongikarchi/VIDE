// Node child process runner (ARCH-03 §6.4, SPEC-07.9): `code` steps of a jig written in the
// repository and signed on this PC run outside the engine, under Node's permission model with
// read access to the package folder and this runner only, an environment of `PATH` and
// `SystemRoot`, worker-thread and addon permission (the structure library runs the Node-API
// core in a worker), no write or child-process permission. The engine kills it when a
// step passes its budget and after five idle minutes; a dead child is started again on the next
// step and the instance is unaffected (SPEC-07.17).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadedJig } from './loader.ts';
import type { JigSource } from './manifest.ts';
import type { RunRequest, RunnerIn, RunnerOut, StepRunner } from './runner.ts';

export const IDLE_MS = 5 * 60_000;
const here = dirname(fileURLToPath(import.meta.url));
/** The child's entry script beside this file (`.ts` in a checkout, `.js` in the built server). */
export function childEntryPath() {
  const ts = join(here, 'child-entry.ts');
  return existsSync(ts) ? ts : join(here, 'child-entry.js');
}

export interface ChildRunnerOptions {
  idleMs?: number;
  /** Folders the child may read besides the package and the runner (repository sources in dev). */
  extraReadPaths?: string[];
  execPath?: string;
}

export class ChildRunner implements StepRunner {
  readonly source: JigSource;
  private jig: LoadedJig | undefined;
  private child: ChildProcess | undefined;
  private loaded = false;
  private readonly waiting = new Map<
    string,
    { resolve: (out: RunnerOut) => void; timer: NodeJS.Timeout; child: ChildProcess }
  >();
  private idle: NodeJS.Timeout | undefined;
  private readonly options: Required<ChildRunnerOptions>;
  readonly logs: string[] = [];
  spawned = 0;

  constructor(source: JigSource = 'dev-pack', options: ChildRunnerOptions = {}) {
    this.source = source;
    this.options = {
      idleMs: options.idleMs ?? IDLE_MS,
      extraReadPaths: options.extraReadPaths ?? [],
      execPath: options.execPath ?? process.execPath,
    };
  }

  async load(jig: LoadedJig) {
    if (this.jig && (this.jig.dir !== jig.dir || this.jig.digest !== jig.digest))
      await this.close();
    this.jig = jig;
  }

  /** The exact spawn arguments (also for the boot test, ARCH-03 §6.6). */
  spawnArgs(): string[] {
    const jig = this.jig;
    if (!jig) throw new Error('NOT_LOADED');
    const entry = childEntryPath();
    const reads = [jig.dir, dirname(entry), ...this.options.extraReadPaths].map((p) => resolve(p));
    return [
      '--permission',
      '--allow-worker',
      '--allow-addons',
      ...reads.map((p) => `--allow-fs-read=${p}`),
      entry,
    ];
  }

  private ensure(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const jig = this.jig;
    if (!jig) throw new Error('NOT_LOADED');
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (systemRoot) env.SystemRoot = systemRoot;
    const child = spawn(this.options.execPath, this.spawnArgs(), {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.spawned++;
    this.loaded = false;
    this.child = child;
    // The child never keeps the engine alive on its own; a running step holds its budget timer.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr])
      (stream as { unref?: () => void } | null)?.unref?.();
    createInterface({ input: child.stdout! }).on('line', (line) => this.receive(line));
    createInterface({ input: child.stderr! }).on('line', (line) => this.log(line));
    const ended = (reason: string) => {
      if (this.child === child) this.child = undefined;
      // Only the steps sent to this child fail; a replacement child may already hold new ones.
      for (const [runId, entry] of [...this.waiting]) {
        if (entry.child !== child) continue;
        clearTimeout(entry.timer);
        this.waiting.delete(runId);
        entry.resolve({
          t: 'fail',
          runId,
          code: 'THROW',
          message: `실행 프로세스가 끝났습니다(${reason})`,
        });
      }
    };
    child.on('exit', (code, signal) => ended(String(code ?? signal)));
    // A start that fails (ENOENT, EACCES) or a write to a child that is exiting must not end the
    // engine (an 'error' without a listener does): its steps fail as on an exit (RESEARCH-13 §5).
    child.on('error', (error) => {
      this.log(String(error));
      ended(error.message);
    });
    child.stdin?.on('error', (error) => this.log(String(error)));
    this.send({
      t: 'load',
      jig: jig.id,
      version: jig.version,
      dir: jig.dir,
      digest: jig.digest,
      bundled: jig.bundled,
    });
    this.loaded = true;
    return child;
  }
  /** The child's output, newest 500 lines (it could otherwise grow for the engine's lifetime). */
  private log(line: string) {
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
  }
  private send(message: RunnerIn) {
    this.child?.stdin?.write(JSON.stringify(message) + '\n');
  }
  private receive(line: string) {
    let message: RunnerOut;
    try {
      message = JSON.parse(line) as RunnerOut;
    } catch {
      this.log(line);
      return;
    }
    if (message.t === 'log') {
      this.log(`${message.runId}: ${message.text}`);
      return;
    }
    const entry = this.waiting.get(message.runId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.waiting.delete(message.runId);
    entry.resolve(message);
  }
  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.stop(), this.options.idleMs);
    this.idle.unref?.();
  }

  run(request: RunRequest): Promise<RunnerOut> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.ensure();
      } catch (error) {
        resolve({
          t: 'fail',
          runId: request.runId,
          code: 'THROW',
          message: String((error as Error).message),
        });
        return;
      }
      const timer = setTimeout(() => {
        // Over budget: the step is cut off with its process; the next step starts a new one.
        this.waiting.delete(request.runId);
        child.kill('SIGKILL');
        resolve({
          t: 'fail',
          runId: request.runId,
          code: 'BUDGET',
          message: `${request.budgetMs} ms를 넘겨 끊었습니다`,
        });
      }, request.budgetMs);
      this.waiting.set(request.runId, { resolve, timer, child });
      this.touch();
      this.send({
        t: 'run',
        runId: request.runId,
        step: request.step.id,
        entry: request.step.entry,
        input: request.input,
        params: request.params,
        overrides: request.overrides,
        budgetMs: request.budgetMs,
      });
    });
  }
  cancel(runId: string) {
    const entry = this.waiting.get(runId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.waiting.delete(runId);
    this.child?.kill('SIGKILL');
    entry.resolve({ t: 'fail', runId, code: 'THROW', message: 'CANCELLED' });
  }
  get alive() {
    return !!this.child && this.child.exitCode === null && !this.child.killed && this.loaded;
  }
  private async stop() {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    if (child.exitCode === null) {
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      child.stdin?.end();
      child.kill();
      await Promise.race([exited, new Promise((done) => setTimeout(done, 2000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  async close() {
    if (this.idle) clearTimeout(this.idle);
    await this.stop();
  }
}
