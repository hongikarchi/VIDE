// Breadcrumbs for engine deaths that run no exit code (PLAN-27 §0): the heavy steps note
// themselves in the diagnostic log synchronously before they start, so the last line written
// before a native crash names the step that was running. IDs and sizes only, never content.

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
