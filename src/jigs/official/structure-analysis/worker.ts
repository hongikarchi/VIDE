// One worker thread for the napi core (ARCH-03 §6.3): the engine thread never calls the core
// synchronously, so `/links` and the rest of the server keep answering while a model is analysed.
// Latest request wins: while one request runs, only the newest request per key stays queued; an
// older queued request for the same key is rejected with `STRUCTURE_SUPERSEDED`.
//
// Lifecycle: before the first worker starts, the main thread pins the core (core.ts `pinCore`), so
// a worker that exits (closed, crashed or restarted) never unloads the library under the core's
// solver threads. Closing asks the worker to stop and waits for its exit, terminating it only
// after `CLOSE_GRACE_MS`; an idle worker still open when the event loop empties is closed then.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { corePath, pinCore } from '../../structure/core.ts';
// Type-only: keeps worker-entry.ts in the tsc server build (nothing imports it at run time).
import type { WorkerClose, WorkerRequest } from './worker-entry.ts';

interface Job {
  id: number;
  key: string;
  payload: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Reply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { message: string; code?: string };
}

/** How long a closing worker may take to answer its current request and exit before it is terminated. */
const CLOSE_GRACE_MS = 2000;

let worker: Worker | undefined;
let running: Job | undefined;
const queued = new Map<string, Job>();
/** Closes in progress: `closeAnalysisWorker` resolves once all of them have exited. */
const stopping = new Set<Promise<void>>();
let sequence = 0;
let exitHookInstalled = false;
const stats = {
  started: 0,
  completed: 0,
  failed: 0,
  superseded: 0,
  restarts: 0,
  closed: 0,
  forced: 0,
};

const fail = (message: string, code: string) => Object.assign(new Error(message), { code });
const closedError = () => fail('structure analysis worker closed', 'STRUCTURE_WORKER_CLOSED');

/** The worker entry next to this file: the built .js when it exists, else the .ts source. */
function entryPath(): string {
  for (const name of ['worker-entry.js', 'worker-entry.ts']) {
    const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw fail('structure analysis worker entry is missing', 'STRUCTURE_WORKER_MISSING');
}

function settle(job: Job | undefined, reply: Reply | Error) {
  if (!job) return;
  if (reply instanceof Error) {
    stats.failed++;
    job.reject(reply);
  } else if (reply.ok) {
    stats.completed++;
    job.resolve(reply.value);
  } else {
    stats.failed++;
    job.reject(
      fail(reply.error?.message ?? 'analysis failed', reply.error?.code ?? 'STRUCTURE_ANALYSIS'),
    );
  }
}

/** Forget the current worker; its running request fails with `reason`. */
function retire(reason: Error) {
  const current = running;
  running = undefined;
  worker = undefined;
  settle(current, reason);
}

function ensureWorker(): Worker {
  if (worker) return worker;
  // Created first: where workers are not allowed (the jig child process) this throws as before.
  const created = new Worker(entryPath(), { name: 'vide-structure-analysis' });
  // A retired worker keeps these listeners, but its events no longer change anything; the
  // 'error' listener also keeps a late error from turning into an uncaught exception.
  created.on('message', (reply: Reply) => {
    if (worker !== created || running?.id !== reply.id) return;
    const job = running;
    running = undefined;
    settle(job, reply);
    pump();
  });
  created.on('error', (error) => {
    if (worker !== created) return;
    stats.restarts++;
    retire(fail(`structure analysis worker failed: ${error.message}`, 'STRUCTURE_WORKER'));
    pump();
  });
  created.on('exit', (code) => {
    if (worker !== created) return;
    stats.restarts++;
    retire(fail(`structure analysis worker exited (${code})`, 'STRUCTURE_WORKER'));
    pump();
  });
  try {
    pinCore();
  } catch (error) {
    void created.terminate();
    throw error;
  }
  worker = created;
  installExitHook();
  return created;
}

/** Ask a retired worker to finish and exit; terminate it when it has not exited in time. */
function stopWorker(target: Worker): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      stats.forced++;
      void target.terminate();
    }, CLOSE_GRACE_MS);
    target.once('exit', () => {
      clearTimeout(timer);
      stats.closed++;
      resolve();
    });
    target.ref();
    try {
      target.postMessage({ type: 'close' } satisfies WorkerClose);
    } catch {
      void target.terminate();
    }
  });
}

/** An idle worker still open when the event loop empties is closed, so the process exits cleanly. */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('beforeExit', () => {
    if (worker && !running && queued.size === 0) void closeAnalysisWorker();
  });
}

function pump() {
  if (running) return;
  const next = queued.entries().next();
  if (next.done) {
    worker?.unref();
    return;
  }
  const [key, job] = next.value;
  queued.delete(key);
  running = job;
  stats.started++;
  try {
    const w = ensureWorker();
    w.ref();
    w.postMessage({ id: job.id, payload: job.payload });
  } catch (error) {
    running = undefined;
    settle(job, error instanceof Error ? error : new Error(String(error)));
    pump();
  }
}

/** Run one analysis task in the worker; `key` groups requests that supersede each other. */
export function submitAnalysis<T>(key: string, payload: WorkerRequest['payload']): Promise<T> {
  if (!corePath())
    return Promise.reject(
      fail('Structure core is not built (npm run build:structure)', 'STRUCTURE_CORE_MISSING'),
    );
  return new Promise<T>((resolve, reject) => {
    const previous = queued.get(key);
    if (previous) {
      stats.superseded++;
      previous.reject(
        fail('a newer request for the same key replaced this one', 'STRUCTURE_SUPERSEDED'),
      );
    }
    queued.set(key, {
      id: ++sequence,
      key,
      payload,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    pump();
  });
}

export function analysisWorkerStats() {
  return {
    ...stats,
    queued: queued.size,
    running: !!running,
    alive: !!worker,
    closing: stopping.size,
  };
}

/**
 * Stop the worker (tests, shutdown). Queued and running requests are rejected with
 * `STRUCTURE_WORKER_CLOSED`. Safe to call again or concurrently: it resolves once every worker
 * this module started has exited. A later request starts a new worker.
 */
export function closeAnalysisWorker(): Promise<void> {
  for (const job of queued.values()) job.reject(closedError());
  queued.clear();
  const current = worker;
  if (current) {
    retire(closedError());
    const stop: Promise<void> = stopWorker(current).finally(() => stopping.delete(stop));
    stopping.add(stop);
  }
  return Promise.all(stopping).then(() => undefined);
}
