// One worker thread for the napi core (ARCH-03 §6.3): the engine thread never calls the core
// synchronously, so `/links` and the rest of the server keep answering while a model is analysed.
// Latest request wins: while one request runs, only the newest request per key stays queued; an
// older queued request for the same key is rejected with `STRUCTURE_SUPERSEDED`.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { corePath } from '../../structure/core.ts';

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

let worker: Worker | undefined;
let running: Job | undefined;
const queued = new Map<string, Job>();
let sequence = 0;
const stats = { started: 0, completed: 0, failed: 0, superseded: 0, restarts: 0 };

const fail = (message: string, code: string) => Object.assign(new Error(message), { code });

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

function dropWorker(reason: Error) {
  const current = running;
  running = undefined;
  worker?.removeAllListeners();
  worker = undefined;
  settle(current, reason);
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(entryPath(), { name: 'vide-structure-analysis' });
  created.on('message', (reply: Reply) => {
    if (running?.id !== reply.id) return;
    const job = running;
    running = undefined;
    settle(job, reply);
    pump();
  });
  created.on('error', (error) => {
    stats.restarts++;
    dropWorker(fail(`structure analysis worker failed: ${error.message}`, 'STRUCTURE_WORKER'));
    pump();
  });
  created.on('exit', (code) => {
    if (worker !== created) return;
    stats.restarts++;
    dropWorker(fail(`structure analysis worker exited (${code})`, 'STRUCTURE_WORKER'));
    pump();
  });
  worker = created;
  return created;
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
export function submitAnalysis<T>(key: string, payload: unknown): Promise<T> {
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
  return { ...stats, queued: queued.size, running: !!running, alive: !!worker };
}

/** Stop the worker (tests, shutdown). Queued and running requests are rejected. */
export async function closeAnalysisWorker(): Promise<void> {
  for (const job of queued.values())
    job.reject(fail('structure analysis worker closed', 'STRUCTURE_WORKER_CLOSED'));
  queued.clear();
  const current = worker;
  dropWorker(fail('structure analysis worker closed', 'STRUCTURE_WORKER_CLOSED'));
  await current?.terminate();
}
