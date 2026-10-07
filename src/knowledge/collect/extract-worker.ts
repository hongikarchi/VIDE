// The worker thread that reads documents for the collector (SPEC-08.9 2): one file at a time, so
// the engine can stop a file that runs past its time limit by ending this worker.
import { parentPort } from 'node:worker_threads';
import { extractFile } from './documents.ts';

parentPort?.on('message', (job: { id: number; path: string; ext: string }) => {
  void extractFile(job.path, job.ext).then((result) =>
    parentPort?.postMessage({ id: job.id, result }),
  );
});
