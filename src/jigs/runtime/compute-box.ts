// Compute box (ARCH-03 §6.5, SPEC-07.9): the runner for code an AI wrote — a JS interpreter
// compiled to wasm with no file, network, process or environment API, a memory limit and the
// step budget. It arrives with the make-conversation (PLAN-22 T-063, M5). Until then this stub
// keeps the runner contract and refuses every step, so an `ai-draft` jig can be registered and
// inspected but never computes.

import type { LoadedJig } from './loader.ts';
import type { JigSource } from './manifest.ts';
import type { RunRequest, RunnerOut, StepRunner } from './runner.ts';

export class ComputeBoxRunner implements StepRunner {
  readonly source: JigSource = 'ai-draft';
  async load(_jig: LoadedJig) {}
  async run(request: RunRequest): Promise<RunnerOut> {
    return {
      t: 'fail',
      runId: request.runId,
      code: 'THROW',
      message: 'COMPUTE_BOX_PENDING: 계산 상자는 T-063에서 들어옵니다',
    };
  }
  cancel() {}
  async close() {}
}
