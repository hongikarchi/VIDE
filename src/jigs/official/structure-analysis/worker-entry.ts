// Worker thread body: loads the core in this thread and runs the analysis pipeline per message.
// Started by worker.ts; keeps the geometry cache for the stability probe across requests.

import { parentPort } from 'node:worker_threads';
import { runAnalysis, type AnalyzeOptions } from './run.ts';
import type { MemberMap } from './frame-plan.ts';
import type { StructureModelInput } from '../../../contracts/structure-model.ts';

export interface WorkerRequest {
  id: number;
  payload: { input: StructureModelInput; map?: MemberMap; options: AnalyzeOptions };
}
type Request = WorkerRequest;

const geometryCache = new Map<string, string>();
const port = parentPort;
if (!port) throw new Error('worker-entry must run in a worker thread');

port.on('message', (request: Request) => {
  try {
    const { input, map, options } = request.payload;
    const value = runAnalysis(input, map, options, geometryCache);
    port.postMessage({ id: request.id, ok: true, value });
  } catch (error) {
    const e = error as { message?: string; code?: string };
    port.postMessage({
      id: request.id,
      ok: false,
      error: { message: e?.message ?? String(error), code: e?.code },
    });
  }
});
