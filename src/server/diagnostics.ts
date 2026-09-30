// Diagnostic log for finding causes after the fact: one JSON line per event in
// <data>/logs/engine-YYYY-MM-DD.jsonl, kept for 14 days. IDs, codes, timings and error stacks only —
// never request text, file contents or credentials (those stay in the workspace DB or nowhere).
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface DiagnosticsOptions {
  /** The data folder; logs go to its `logs` subfolder. Undefined: nothing is written. */
  directory?: string;
  keepDays?: number;
  now?: () => Date;
}

export class Diagnostics {
  private readonly options: DiagnosticsOptions;
  private day = '';
  constructor(options: DiagnosticsOptions) {
    this.options = options;
  }
  get folder() {
    return this.options.directory ? join(this.options.directory, 'logs') : undefined;
  }
  write(event: string, fields: Record<string, unknown> = {}) {
    const folder = this.folder;
    if (!folder) return;
    try {
      const now = (this.options.now ?? (() => new Date()))();
      const day = now.toISOString().slice(0, 10);
      if (day !== this.day) {
        mkdirSync(folder, { recursive: true });
        this.day = day;
        this.prune(now);
      }
      appendFileSync(
        join(folder, `engine-${day}.jsonl`),
        JSON.stringify({ at: now.toISOString(), event, ...fields }) + '\n',
        'utf8',
      );
    } catch {
      /* Diagnostics never break the engine. */
    }
  }
  /** Error details for the log: name, message, code and a bounded stack. */
  static error(error: unknown) {
    if (!(error instanceof Error)) return { message: String(error).slice(0, 500) };
    return {
      name: error.name,
      message: error.message.slice(0, 1000),
      code: (error as { code?: unknown }).code,
      stack: error.stack?.split('\n').slice(0, 20).join('\n'),
    };
  }
  private prune(now: Date) {
    const folder = this.folder!;
    const oldest = new Date(now.getTime() - (this.options.keepDays ?? 14) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (const name of readdirSync(folder)) {
      const day = /^engine(?:-stderr)?-(\d{4}-\d{2}-\d{2})\.(?:jsonl|log)$/.exec(name)?.[1];
      if (day && day < oldest) unlinkSync(join(folder, name));
    }
  }
}

/** When one run's steps happened (epoch ms), as the execution records them. */
export interface RunMarks {
  /** The request was received (its createdAt). */
  receivedAt?: number;
  /** The run started (the request left the queue). */
  runAt: number;
  /** The earlier-exchange selection took this long (0: no Jev call). */
  contextMs?: number;
  /** The provider was made for the run (the engine's own preparation ends here). */
  providerAt?: number;
  /** What the provider measured: its login check and when the CLI started and first answered. */
  provider?: { authMs?: number; authCached?: boolean; spawnAt?: number; firstOutputAt?: number };
}
const MODEL_NOTES = new Set(['thinking', 'message', 'model']);
const TOOL_EVENTS = new Set(['query', 'execute', 'result', 'error']);
/**
 * The `request-stages` line: milliseconds from the run's start to each step, then the time from the
 * last host event to the end (the model's final answer and recording it). Numbers only.
 */
export function requestStages(
  marks: RunMarks,
  activity: unknown,
  endedAt: number,
): Record<string, number | boolean> {
  const since = (at: number | undefined) =>
    at === undefined || !Number.isFinite(at)
      ? undefined
      : Math.max(0, Math.round(at - marks.runAt));
  const entries = (Array.isArray(activity) ? activity : [])
    .map((entry) => entry as { kind?: unknown; at?: unknown })
    .map((entry) => ({
      kind: String(entry.kind),
      at: typeof entry.at === 'string' ? Date.parse(entry.at) : NaN,
    }))
    .filter((entry) => Number.isFinite(entry.at));
  const tools = entries.filter((entry) => TOOL_EVENTS.has(entry.kind));
  const firstNote = entries.find((entry) => MODEL_NOTES.has(entry.kind))?.at;
  const lastTool = tools.at(-1)?.at;
  const fields: Record<string, number | boolean | undefined> = {
    queuedMs:
      marks.receivedAt !== undefined
        ? Math.max(0, Math.round(marks.runAt - marks.receivedAt))
        : undefined,
    contextMs: marks.contextMs,
    providerMs: since(marks.providerAt),
    authMs: marks.provider?.authMs,
    authCached: marks.provider?.authCached,
    spawnMs: since(marks.provider?.spawnAt),
    firstOutputMs: since(marks.provider?.firstOutputAt),
    firstNoteMs: since(firstNote),
    firstToolMs: since(tools[0]?.at),
    lastToolMs: since(lastTool),
    answerMs: lastTool !== undefined ? Math.max(0, Math.round(endedAt - lastTool)) : undefined,
    totalMs: since(endedAt),
    queries: entries.filter((entry) => entry.kind === 'query').length,
    executes: entries.filter((entry) => entry.kind === 'execute').length,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, number | boolean] => entry[1] !== undefined,
    ),
  );
}
