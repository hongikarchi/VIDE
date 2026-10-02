// Breadcrumbs for engine deaths that run no exit code (PLAN-27 §0): the heavy steps note
// themselves in the diagnostic log synchronously before they start, so the last line written
// before a native crash names the step that was running. IDs and sizes only, never content.
import { AsyncLocalStorage } from 'node:async_hooks';

/** Results and responses at least this large are noted (bytes of JSON text). */
export const BIG_JSON = 5_000_000;

type Sink = (step: string, fields: Record<string, unknown>) => void;
let sink: Sink | undefined;

/** The server points breadcrumbs at its diagnostic log; tests and tools leave it unset. */
export function setBreadcrumbSink(next: Sink | undefined) {
  sink = next;
}

export function breadcrumb(step: string, fields: Record<string, unknown> = {}) {
  try {
    sink?.(step, fields);
  } catch {
    /* Breadcrumbs never break the engine. */
  }
}

// --- Diagnostic events (T-126) -------------------------------------------------------------------
// Modules without a diagnostics handle (the AI providers, the agent tools) note events through one
// sink the server points at its log. Lines carry the running request's id when the event happens
// inside a request's run (`withTrace`). IDs, codes, timings and sizes only — never content.

export interface Trace {
  requestId: string;
  projectId?: string;
}
const traces = new AsyncLocalStorage<Trace>();
/** Runs `run` so that diagnostic lines written inside it name this request. */
export function withTrace<T>(trace: Trace, run: () => T): T {
  return traces.run(trace, run);
}
export function currentTrace(): Trace | undefined {
  return traces.getStore();
}

let events: Sink | undefined;
/**
 * The server points diagnostic events at its log; tests and tools leave it unset. With `only`, the
 * sink changes only while it is still `only` (a closing server leaves a newer server's sink).
 */
export function setDiagnosticSink(next: Sink | undefined, only?: Sink) {
  if (only === undefined || events === only) events = next;
}
export function diagnostic(event: string, fields: Record<string, unknown> = {}) {
  try {
    events?.(event, fields);
  } catch {
    /* Diagnostics never break the engine. */
  }
}

/**
 * Text from outside (a CLI's error output, a page's error message) with keys, tokens and the
 * Windows user name taken out, cut to its last `limit` characters.
 */
export function scrub(text: string, limit = 2048) {
  const cleaned = String(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+)?/g, '***jwt***')
    .replace(
      /\b([A-Za-z_]*(?:api[_-]?key|token|secret|password|passwd|cookie|authorization)[A-Za-z_]*)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
      '$1$2***',
    )
    .replace(/\b[a-f0-9]{32,}\b/gi, '***')
    .replace(/([\\/]Users[\\/]{1,2})[^\\/\s"']+/gi, '$1~');
  return cleaned.length > limit ? cleaned.slice(-limit) : cleaned;
}
