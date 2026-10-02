// Diagnostic log for finding causes after the fact: one JSON line per event in
// <data>/logs/engine-YYYY-MM-DD.jsonl, kept for 14 days. IDs, codes, timings and error stacks only —
// never request text, file contents or credentials (those stay in the workspace DB or nowhere).
// Logs are never sent to the AI (ADR-031 9).
//
// Lines are gathered in memory and appended together (every second or 64 KB), so writing a line
// costs the caller no disk access. Breadcrumbs and crash lines are written at once (`sync`), and
// whatever is gathered is written synchronously when the process exits, so the last lines before
// an end are not lost. Each line carries the program version (`v`) and this process's session id
// (`sid`); a day's file stops at `dayCapBytes` with one notice line and a count of the dropped lines.
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { currentTrace } from '../core/breadcrumbs.ts';
import { appVersion } from './sdk-options.ts';

export interface DiagnosticsOptions {
  /** The data folder; logs go to its `logs` subfolder. Undefined: nothing is written. */
  directory?: string;
  keepDays?: number;
  now?: () => Date;
  /** Program version on every line (default: the PC program's or package.json's). */
  version?: string;
  /** Gathered lines are written after this many milliseconds (default 1000). */
  flushMs?: number;
  /** ... or once this many bytes are gathered (default 64 KB). */
  flushBytes?: number;
  /** A day's file takes at most this many bytes (default 64 MB); later lines are counted, not written. */
  dayCapBytes?: number;
}

/** This engine process's id on every line: lines of one run of the engine belong together. */
export const SESSION_ID = randomBytes(4).toString('hex');
/** Log files of every VIDE part in <data>/logs, pruned together after the keep period. */
const DATED_LOG = /^(?:engine|engine-stderr|rhino|zwcad|shell)-(\d{4}-\d{2}-\d{2})\.(?:jsonl|log)$/;

const open = new Set<Diagnostics>();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  // The last gathered lines reach the file on any exit Node still runs code for.
  process.on('exit', () => {
    for (const log of open) log.flush();
  });
}

export class Diagnostics {
  private readonly options: DiagnosticsOptions;
  private day = '';
  private size = 0;
  private dropped = 0;
  private capped = false;
  private pending: string[] = [];
  private pendingBytes = 0;
  private pendingDay = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private version: string | undefined;
  constructor(options: DiagnosticsOptions) {
    this.options = options;
    if (options.directory) {
      open.add(this);
      hookExit();
    }
  }
  get folder() {
    return this.options.directory ? join(this.options.directory, 'logs') : undefined;
  }
  /**
   * Adds one line. `sync`: written now together with what is gathered (breadcrumbs before a heavy
   * step, crash lines), so it is on disk even if the process dies next.
   */
  write(event: string, fields: Record<string, unknown> = {}, sync = false) {
    const folder = this.folder;
    if (!folder) return;
    try {
      const now = (this.options.now ?? (() => new Date()))();
      const day = now.toISOString().slice(0, 10);
      if (day !== this.day) this.startDay(folder, day, now);
      const trace = currentTrace();
      const line =
        JSON.stringify({
          at: now.toISOString(),
          v: (this.version ??= this.options.version ?? safeVersion()),
          sid: SESSION_ID,
          event,
          ...(trace && fields.requestId === undefined ? { requestId: trace.requestId } : {}),
          ...fields,
        }) + '\n';
      const bytes = Buffer.byteLength(line);
      if (this.size + bytes > (this.options.dayCapBytes ?? 64 * 1024 * 1024)) {
        this.dropped++;
        if (!this.capped) {
          this.capped = true;
          this.push(
            day,
            JSON.stringify({
              at: now.toISOString(),
              v: this.version,
              sid: SESSION_ID,
              event: 'log-cap',
              capBytes: this.options.dayCapBytes ?? 64 * 1024 * 1024,
            }) + '\n',
          );
        }
        if (sync) this.flush();
        return;
      }
      this.size += bytes;
      this.push(day, line);
      if (sync || this.pendingBytes >= (this.options.flushBytes ?? 65536)) this.flush();
      else this.timer ??= setTimeout(() => this.flush(), this.options.flushMs ?? 1000).unref();
    } catch {
      /* Diagnostics never break the engine. */
    }
  }
  /** Writes the gathered lines now (one append). */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.length) return;
    const text = this.pending.join('');
    const day = this.pendingDay;
    this.pending = [];
    this.pendingBytes = 0;
    try {
      appendFileSync(join(this.folder!, `engine-${day}.jsonl`), text, 'utf8');
    } catch {
      /* Diagnostics never break the engine. */
    }
  }
  /** Writes every open log's gathered lines now (a crash is about to end the process). */
  static flushAll() {
    for (const log of open) log.flush();
  }
  /** Writes what is gathered (with the count of lines the day's cap dropped) and stops. */
  close() {
    this.noteDropped();
    this.flush();
    open.delete(this);
  }
  private push(day: string, line: string) {
    if (this.pendingDay !== day && this.pending.length) this.flush();
    this.pendingDay = day;
    this.pending.push(line);
    this.pendingBytes += line.length;
  }
  private noteDropped() {
    if (!this.dropped || !this.day) return;
    this.pending.push(
      JSON.stringify({
        at: new Date().toISOString(),
        v: this.version,
        sid: SESSION_ID,
        event: 'log-cap-dropped',
        dropped: this.dropped,
      }) + '\n',
    );
    this.pendingDay ||= this.day;
    this.dropped = 0;
  }
  private startDay(folder: string, day: string, now: Date) {
    this.noteDropped();
    this.flush();
    mkdirSync(folder, { recursive: true });
    this.day = day;
    this.capped = false;
    try {
      this.size = statSync(join(folder, `engine-${day}.jsonl`)).size;
    } catch {
      this.size = 0;
    }
    this.prune(now);
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
      const day = DATED_LOG.exec(name)?.[1];
      if (day && day < oldest)
        try {
          unlinkSync(join(folder, name));
        } catch {
          /* Open in another process (a host writing its own log): next day. */
        }
    }
  }
}

/**
 * One line per key and window: `note` answers undefined while the key was written less than
 * `windowMs` ago, else the number of repeats left out since its last line (0 the first time).
 */
export class RepeatGate {
  private readonly seen = new Map<string, { at: number; repeats: number }>();
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(windowMs = 10_000, now = () => Date.now()) {
    this.windowMs = windowMs;
    this.now = now;
  }
  note(...key: unknown[]) {
    const id = key.map(String).join('|');
    const at = this.now();
    const entry = this.seen.get(id);
    if (entry && at - entry.at < this.windowMs) {
      entry.repeats++;
      return undefined;
    }
    if (this.seen.size > 500) this.seen.clear();
    this.seen.set(id, { at, repeats: 0 });
    return entry?.repeats ?? 0;
  }
}

/** Path segments after these name one item (an id, a name): they are logged as `:id`. */
const ITEM_PARENTS = new Set([
  'projects',
  'requests',
  'conversations',
  'links',
  'inbox',
  'reviews',
  'extensions',
  'imports',
  'jigs',
  'jig-drafts',
  'steps',
  'reports',
  'bakes',
  'assembly',
  'inputs',
  'attachments',
  'images',
  'agenda',
  'boards',
  'instances',
  'documents',
  'statements',
  'sources',
]);
/**
 * An API path for the log: ids replaced by `:id` (route words stay), plus the project, request and
 * conversation ids it names, so a failure can be found with its request.
 */
export function routeOf(path: string) {
  const parts = path.split('?')[0].split('/');
  const ids: Record<string, string> = {};
  const pattern = parts.map((part, index) => {
    const parent = parts[index - 1];
    const item =
      (parent && ITEM_PARENTS.has(parent)) || (part && !/^[a-z][a-z0-9-]{0,40}$/.test(part));
    if (!item) return part;
    if (parent === 'projects') ids.projectId = part.slice(0, 80);
    if (parent === 'requests') ids.request = part.slice(0, 80);
    if (parent === 'conversations') ids.conversation = part.slice(0, 80);
    return ':id';
  });
  return { path: pattern.join('/').slice(0, 200), ...ids };
}

function safeVersion() {
  try {
    return appVersion();
  } catch {
    return 'unknown';
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
  provider?: {
    authMs?: number;
    authCached?: boolean;
    spawnAt?: number;
    firstOutputAt?: number;
    /** The turn ran in a kept Claude process (ADR-028): spawnAt is when the turn was written. */
    processReused?: boolean;
  };
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
    processReused: marks.provider?.processReused,
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
