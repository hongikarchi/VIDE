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
