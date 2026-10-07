// Document reading off the engine's main thread with a time limit per file (SPEC-08.9 2,
// RESEARCH-06 §7.7): a few worker threads; a file past its limit ends its worker (status
// `timeout`) and the next file gets a new one.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { extractFile, type Extracted } from './documents.ts';

/** Time allowed per file: 60 s plus 2 s per MB. */
export const fileTimeLimit = (size: number) => 60_000 + Math.round((size / 1e6) * 2000);

function entryPath() {
  for (const name of ['extract-worker.js', 'extract-worker.ts']) {
    const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (existsSync(path)) return path;
  }
  return undefined;
}

export interface ExtractJob {
  path: string;
  ext: string;
  size: number;
}
/**
 * Reads `jobs` with up to `size` workers; `done` gets each result as it comes. Where workers are
 * not available the files are read on this thread (no time limit).
 */
export async function extractAll(
  jobs: readonly ExtractJob[],
  done: (index: number, result: Extracted) => void,
  {
    size = 3,
    signal,
    limit = fileTimeLimit,
  }: { size?: number; signal?: AbortSignal; limit?: (size: number) => number } = {},
) {
  const entry = entryPath();
  let next = 0;
  const lane = async () => {
    let worker: Worker | undefined;
    try {
      while (next < jobs.length && !signal?.aborted) {
        const index = next++;
        const job = jobs[index];
        if (!entry) {
          done(index, await extractFile(job.path, job.ext));
          continue;
        }
        const current: Worker = (worker ??= new Worker(entry, {
          name: 'vide-knowledge-extract',
        }));
        const result = await new Promise<Extracted>((resolve) => {
          const cleanup = () => {
            clearTimeout(timer);
            current.off('message', message);
            current.off('error', failed);
          };
          const timer = setTimeout(() => {
            cleanup();
            worker = undefined;
            void current.terminate();
            resolve({ status: 'timeout', excerpts: [] });
          }, limit(job.size));
          const message = (reply: { id: number; result: Extracted }) => {
            if (reply.id !== index) return;
            cleanup();
            resolve(reply.result);
          };
          const failed = (error: Error) => {
            cleanup();
            worker = undefined;
            resolve({ status: 'error', excerpts: [], error: error.message });
          };
          current.on('message', message);
          current.on('error', failed);
          current.postMessage({ id: index, path: job.path, ext: job.ext });
        });
        done(index, result);
      }
    } finally {
      await worker?.terminate();
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, lane));
}
