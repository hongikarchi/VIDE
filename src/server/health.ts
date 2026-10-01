// Engine health samples for finding causes after the fact (PLAN-27 step 0, RESEARCH-13 §1):
// memory and the event loop's worst delay once a minute, so a later death or freeze can be read
// against what the engine was carrying and how long it stood still.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Diagnostics } from './diagnostics.ts';

const mb = (bytes: number) => Math.round(bytes / 1_048_576);

export function startHealthLog(log: Pick<Diagnostics, 'write'>, everyMs = 60_000) {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    log.write('health', {
      rssMB: mb(memory.rss),
      heapMB: mb(memory.heapUsed),
      externalMB: mb(memory.external),
      arrayBuffersMB: mb(memory.arrayBuffers),
      loopMaxMs: Math.round(delay.max / 1e6),
      loopP99Ms: Math.round(delay.percentile(99) / 1e6),
    });
    delay.reset();
  }, everyMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    delay.disable();
  };
}
