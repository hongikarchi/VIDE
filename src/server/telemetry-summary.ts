// What an opt-in error/performance report may carry (ADR-036, SPEC-05.9, PLAN-34 T-155): a summary
// built from the T-126 diagnostic logs. Each event type has an allowlist of fields with a kind; a
// field that is not listed, or does not fit its kind, is left out. Free text (error messages, stack
// frames, a CLI's error tail) passes `reportText`, which removes paths, addresses, quoted text,
// non-ASCII text (names, project and file names, request text), ids and the words the caller names
// (the Windows user name, the PC name, project names). IDs of requests, projects, links and
// conversations are never taken. Numbers only for timings.
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { scrub } from '../core/breadcrumbs.ts';
import { routeOf } from './diagnostics.ts';

// --- text -----------------------------------------------------------------------------------------

const QUOTES: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['\u201C', '\u201D'],
  ['\u2018', '\u2019'],
  ['\u300C', '\u300D'],
  ['\u300E', '\u300F'],
  ['\u00AB', '\u00BB'],
];
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** File extensions of user documents and data (a word ending in one is a file name). */
const FILE_EXT =
  /[^\s<>"'|()]*\.(?:3dm|3dmbak|dwg|dxf|dwl|bak|gh|ghx|rvt|rfa|ifc|skp|pdf|png|jpe?g|gif|bmp|tiff?|webp|svg|txt|md|csv|tsv|xlsx?|xlsm|docx?|pptx?|hwpx?|json|jsonl|xml|zip|7z|rar|sqlite|db|log|dmp|obj|stl|fbx|step|stp|igs|iges|mgt|mgb)\b/gi;
const SOURCE_ROOT = /(?:^|[\\/])(?:src|hosts|node_modules)[\\/]/g;
const SOURCE_TAIL =
  /^(?:src|hosts|node_modules)\/[A-Za-z0-9_.@/-]{1,160}\.(?:ts|tsx|mts|js|mjs|cjs|cs)$/;
/** VIDE's own source file in a path (from its last src/, hosts/ or node_modules/ on), else undefined. */
export function sourceTail(path: string): string | undefined {
  let at = -1;
  for (const match of path.matchAll(SOURCE_ROOT))
    at = match.index + (/^[\\/]/.test(match[0]) ? 1 : 0);
  if (at < 0) return undefined;
  const tail = path.slice(at).replace(/\\/g, '/');
  return SOURCE_TAIL.test(tail) ? tail : undefined;
}
const pathOut = (path: string) => sourceTail(path) ?? '<path>';
// A path's middle parts may hold spaces (C:\Users\Kim Lee\My Docs\…); its last part ends at a space.
const MIDDLE = String.raw`(?:[\\/]+[^\\/"'<>|*?\r\n]*(?=[\\/]))*`;
const LAST = String.raw`[\\/]+[^\s\\/"'<>|*?:,;)]*`;
const UNC_PATH = new RegExp(String.raw`\\\\[^\\/\s"'<>|]+` + MIDDLE + `(?:${LAST})?`, 'g');
const DRIVE_PATH = new RegExp(String.raw`\b[A-Za-z]:` + MIDDLE + LAST, 'g');
const POSIX_PATH = /(^|[\s(=[,:])((?:~|\.{1,2})?(?:\/[^\s/"'<>()]+){2,}\/?)/g;

/**
 * Text for a report: keys and tokens out (`scrub`), then every path, address, e-mail, quoted text,
 * non-ASCII run, long id and named word replaced by a placeholder, cut to `limit` characters.
 */
export function reportText(text: unknown, limit = 300, sensitive: readonly string[] = []): string {
  let value = scrub(String(text ?? ''), 20_000);
  value = value
    // Addresses (http, file, a tunnel's name) and e-mail.
    .replace(/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>)\]]*/gi, '<url>')
    .replace(/[^\s@"'<>()]+@[^\s@"'<>()]+\.[a-z]{2,}/gi, '<email>')
    // Paths: VIDE's own source files keep their tail (src/server/x.ts); others are <path>.
    .replace(UNC_PATH, pathOut)
    .replace(DRIVE_PATH, pathOut)
    .replace(POSIX_PATH, (_, lead: string, path: string) => lead + pathOut(path))
    // A backslash path left after the cuts above.
    .replace(/[^\s"'<>]*\\[^\s"'<>]+/g, pathOut);
  // Named words (user name, PC name, project names), longest first, ignoring case.
  for (const word of [...new Set(sensitive.map((w) => String(w).trim()))]
    .filter((word) => word.length >= 2)
    .sort((a, b) => b.length - a.length))
    value = value.replace(new RegExp(escapeRegExp(word), 'gi'), '<name>');
  // Quoted text (names, file names, request text) is kept as a placeholder: first quotes that open
  // after a space or bracket and close before one, then any pair left (unbalanced quotes).
  // Placeholders hold no quote character until the end, so a later pair never starts on one.
  const held = (index: number) => `\u0002${index}\u0003`;
  QUOTES.forEach(([open, close], index) => {
    const [o, c] = [escapeRegExp(open), escapeRegExp(close)];
    value = value.replace(
      new RegExp(`(^|[^A-Za-z0-9])${o}[^${c}\\r\\n]{1,400}${c}(?=$|[^A-Za-z0-9])`, 'g'),
      `$1${held(index)}`,
    );
  });
  QUOTES.forEach(([open, close], index) => {
    const [o, c] = [escapeRegExp(open), escapeRegExp(close)];
    value = value.replace(new RegExp(`${o}[^${c}\\r\\n]{1,400}${c}`, 'g'), held(index));
  });
  value = value.replace(/\u0002(\d)\u0003/g, (_, index: string) => {
    const [open, close] = QUOTES[Number(index)]!;
    return `${open}...${close}`;
  });
  value = value
    // File names of user documents (VIDE's own sources stay).
    .replace(FILE_EXT, (m) => (SOURCE_TAIL.test(m) ? m : '<file>'))
    // Text outside ASCII (Korean names, project and file names, request text): one placeholder.
    .replace(/[^\x00-\x7F]+(?:[\s\x21-\x2F]+[^\x00-\x7F]+)*/g, '<text>')
    // Ids: UUIDs, long hex, long runs mixing letters and digits.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<id>' : m))
    // Control characters and runs of space.
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return value.length > limit ? value.slice(0, limit - 3) + '...' : value;
}

/** A stack for a report: frames only (`at fn (src/…/file.ts:1:2)`), at most `frames` of them. */
export function reportStack(text: unknown, frames = 8, sensitive: readonly string[] = []): string {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^at\s/.test(line))
    .slice(0, frames)
    .map((line) => {
      const body = line.replace(/^at\s+/, '');
      // C# frames: "at Vide.X.Y(Int32 a) in C:\…\File.cs:line 12" or without a place.
      const sharp = /^([\w$.<>[\]`,]+\([^()]*\))(?: in (.*?)(?::line (\d+))?)?$/.exec(body);
      if (sharp) {
        const place = sharp[2] ? (sourceTail(sharp[2]) ?? '<path>') : '';
        return reportText(
          `at ${sharp[1]}${place ? ` (${place}${sharp[3] ? ':' + sharp[3] : ''})` : ''}`,
          240,
          sensitive,
        );
      }
      // JavaScript frames: "at fn (place:1:2)" or "at place:1:2".
      const js = /^(?:(.*?)\s+\()?(.*?)(?::(\d+))?(?::(\d+))?\)?$/.exec(body)!;
      const fn = js[1] && /^[\w$.<>[\] ]{1,80}$/.test(js[1]) ? js[1] : js[1] ? '<fn>' : '';
      const place = js[2] ?? '';
      const where =
        sourceTail(place.replace(/^file:\/+/, '')) ??
        (/^node:[\w/.-]{1,80}$/.test(place) || place === 'native' || place === '<anonymous>'
          ? place
          : /^[\w$.<>[\] ]{1,80}$/.test(place) && !js[3]
            ? place
            : '<path>');
      const lineCol = js[3] ? `:${js[3]}${js[4] ? ':' + js[4] : ''}` : '';
      return reportText(
        fn ? `at ${fn} (${where}${lineCol})` : `at ${where}${lineCol}`,
        240,
        sensitive,
      );
    })
    .join('\n');
}

// --- the allowlist --------------------------------------------------------------------------------

type Kind =
  | 'code'
  | 'word'
  | 'int'
  | 'num'
  | 'bool'
  | 'version'
  | 'route'
  | 'asset'
  | 'hex'
  | 'text'
  | 'stack';
type Fields = Record<string, Kind>;

const ERROR_TEXT: Fields = {
  name: 'word',
  type: 'word',
  code: 'code',
  message: 'text',
  stack: 'stack',
};
/** Event → the fields a report may take from its line. Anything else is counted only. */
export const ALLOWED_FIELDS: Record<string, Fields> = {
  // engine
  'api-error': { method: 'word', path: 'route', status: 'int', code: 'code', repeated: 'int' },
  'server-error': { ...ERROR_TEXT, method: 'word', path: 'route', status: 'int' },
  'sync-failed': { code: 'code', name: 'word', ms: 'int' },
  'live-sync-failed': { code: 'code', name: 'word', ms: 'int' },
  sync: { code: 'code', phase: 'word', host: 'word', state: 'word', ms: 'int' },
  'host-refused': { code: 'code', final: 'bool' },
  'client-error': {
    kind: 'word',
    message: 'text',
    stack: 'stack',
    source: 'asset',
    line: 'int',
    column: 'int',
    route: 'route',
    pageVersion: 'version',
    repeated: 'int',
  },
  'cli-exit': {
    provider: 'word',
    cliVersion: 'version',
    model: 'word',
    effort: 'word',
    kind: 'word',
    code: 'int',
    signal: 'word',
    ms: 'int',
    stderrTail: 'text',
  },
  'cli-error': { provider: 'word', cliVersion: 'version', kind: 'word', code: 'code' },
  'tool-call': { tool: 'word', code: 'code', ms: 'int', ok: 'bool' },
  'request-end': { state: 'word', code: 'code', ms: 'int', mode: 'word', provider: 'word' },
  'request-crash': ERROR_TEXT,
  'engine-crash': ERROR_TEXT,
  'engine-unhandled': ERROR_TEXT,
  'engine-exit': { code: 'int', hex: 'hex', uptimeSec: 'int', asked: 'bool' },
  'conversation-turn-failed': ERROR_TEXT,
  'conversation-ledger-failed': ERROR_TEXT,
  'model-move-failed': ERROR_TEXT,
  'model-retain-failed': ERROR_TEXT,
  'copies-sweep-failed': ERROR_TEXT,
  'sync-scheduler-failed': ERROR_TEXT,
  'queue-failed': ERROR_TEXT,
  'transcript-remove-failed': ERROR_TEXT,
  'host-project-tools-failed': ERROR_TEXT,
  'log-cap': { capBytes: 'int' },
  // PC program
  'engine-restart': { code: 'hex', attempt: 'int', late: 'bool', givenUp: 'bool' },
  'engine-start-failed': { ...ERROR_TEXT, code: 'code' },
  'shell-unhandled': ERROR_TEXT,
  'webview-init-failed': ERROR_TEXT,
  'webview-failed': { reason: 'word', kind: 'word', code: 'code' },
  'webview-given-up': { reason: 'word' },
  'procdump-attach-failed': ERROR_TEXT,
  'update-apply': { state: 'word', version: 'version' },
  // host plugins
  call: { method: 'word', code: 'code', ms: 'int', ok: 'bool', ...ERROR_TEXT },
  unhandled: ERROR_TEXT,
  'unobserved-task': ERROR_TEXT,
};

const CODE = /^[A-Za-z0-9_.:-]{1,80}$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,60}$/;
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,40}$/;
const EVENT = /^[a-z][a-z0-9-]{0,40}$/;
const ROUTE_WORD = /^[a-z][a-z0-9-]{0,40}$/;

/** An API or page path with every part that is not a route word replaced by `:id`. */
export function routePattern(value: string) {
  return routeOf(value.split(/[?#]/)[0]!)
    .path.split('/')
    .map((part) => (!part || part === ':id' || ROUTE_WORD.test(part) ? part : ':id'))
    .join('/')
    .slice(0, 160);
}

function field(kind: Kind, value: unknown, sensitive: readonly string[]): unknown {
  switch (kind) {
    case 'code':
      return typeof value === 'string' && CODE.test(value) ? value : undefined;
    case 'word':
      return typeof value === 'string' && WORD.test(value) ? value : undefined;
    case 'version':
      return typeof value === 'string' && VERSION.test(value) ? value : undefined;
    case 'hex':
      return typeof value === 'string' && /^0x[0-9A-F]{8}$/i.test(value) ? value : undefined;
    case 'int':
      return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
    case 'num':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
    case 'route':
      return typeof value === 'string' ? routePattern(value) : undefined;
    case 'asset': {
      // A page script: its built file name only (index-AbC123.js).
      const name = typeof value === 'string' ? value.split(/[?#]/)[0]!.split(/[\\/]/).pop() : '';
      return name && /^[A-Za-z0-9_.-]{1,80}\.(?:js|mjs|css)$/.test(name) ? name : undefined;
    }
    case 'text':
      return typeof value === 'string' && value ? reportText(value, 300, sensitive) : undefined;
    case 'stack':
      return typeof value === 'string' && value ? reportStack(value, 8, sensitive) : undefined;
  }
}

/** The fields of one log line a report may carry (an event without a list gives none). */
export function allowedFields(
  event: string,
  line: Record<string, unknown>,
  sensitive: readonly string[] = [],
): Record<string, unknown> {
  const fields = ALLOWED_FIELDS[event];
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(fields)) {
    const value = field(kind, line[name], sensitive);
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

// --- the summary ----------------------------------------------------------------------------------

export type Part = 'engine' | 'shell' | 'rhino' | 'zwcad';
const LOG_FILE = /^(engine|shell|rhino|zwcad)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const FAILED_EVENT = /fail|error|crash|unhandled|refused|given-up|exception|unobserved/;
const FAILED_STATE = new Set(['failed', 'unknown', 'interrupted']);
/** Exit codes that are not crashes: a clean end, a console close (0xC000013A), a kill (-1). */
export const BENIGN_EXITS = new Set([0, -1073741510, -1]);

export interface SummaryOptions {
  /** The VIDE data folder (logs in its `logs`). */
  directory: string;
  /** Lines after this time (ISO) … */
  since: string;
  /** … up to this time (ISO). */
  until: string;
  /** Words removed from free text (user name, PC name, project names). */
  sensitive?: readonly string[];
  /** Upper bound of the report's JSON (bytes, default 32 KB): above it, details are left out. */
  maxBytes?: number;
}

export interface ReportError {
  part: Part;
  event: string;
  count: number;
  first: string;
  last: string;
  fields: Record<string, unknown>;
}
export interface Timing {
  n: number;
  p50: number;
  p90: number;
  max: number;
}
export interface Summary {
  from: string;
  to: string;
  /** Versions each part wrote in the period (the engine's, the shell's, the plugins'). */
  versions: Partial<Record<Part, string[]>>;
  /** Host programs' versions the plugins reported (`plugin-load`). */
  hosts: { rhino?: string[]; zwcad?: string[] };
  /** Lines per part and event name. */
  counts: Record<string, number>;
  /** Failures, the same kind merged (part, event and fields), most frequent first. */
  errors: ReportError[];
  /** Engine exits the PC program recorded that it did not ask for. */
  exits: { at: string; code: number; hex?: string; uptimeSec?: number }[];
  /** Timings (ms) and health samples. */
  timings: Record<string, Timing>;
  /** Present when the cap left details out. */
  truncated?: { errors: number; timings: number; stacks: boolean };
}

const SAMPLE_CAP = 2000;
function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** Reads the logs between `since` and `until` and builds the report summary (allowlisted). */
export async function summarizeLogs(options: SummaryOptions): Promise<Summary> {
  const sensitive = options.sensitive ?? [];
  const folder = join(options.directory, 'logs');
  const fromDay = options.since.slice(0, 10);
  const toDay = options.until.slice(0, 10);
  const counts = new Map<string, number>();
  const errors = new Map<string, ReportError>();
  const samples = new Map<string, number[]>();
  const versions: Partial<Record<Part, Set<string>>> = {};
  const hosts: { rhino: Set<string>; zwcad: Set<string> } = { rhino: new Set(), zwcad: new Set() };
  const exits: Summary['exits'] = [];
  const sample = (key: string, value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) return;
    let list = samples.get(key);
    if (!list) {
      if (samples.size >= 80) return;
      samples.set(key, (list = []));
    }
    if (list.length < SAMPLE_CAP) list.push(value);
    // Past the cap, a random place keeps the sample representative.
    else list[Math.floor(Math.random() * SAMPLE_CAP)] = value;
  };
  const files = existsSync(folder)
    ? readdirSync(folder)
        .map((name) => ({ name, match: LOG_FILE.exec(name) }))
        .filter((file) => file.match && file.match[2]! >= fromDay && file.match[2]! <= toDay)
    : [];
  for (const file of files) {
    const part = file.match![1] as Part;
    const lines = createInterface({
      input: createReadStream(join(folder, file.name), { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const text of lines) {
      if (!text) continue;
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue;
      }
      const at = typeof line.at === 'string' ? line.at : '';
      if (!(at > options.since && at <= options.until)) continue;
      const event = typeof line.event === 'string' && EVENT.test(line.event) ? line.event : 'other';
      const key = `${part}:${event}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (typeof line.v === 'string' && VERSION.test(line.v))
        (versions[part] ??= new Set()).add(line.v);
      if (event === 'plugin-load') {
        for (const host of ['rhino', 'zwcad'] as const) {
          const value = line[host];
          if (typeof value === 'string' && VERSION.test(value)) hosts[host].add(value);
        }
      }
      // Timings: numbers only.
      if (part === 'engine') {
        if (event === 'request-stages')
          for (const name of [
            'totalMs',
            'queuedMs',
            'contextMs',
            'providerMs',
            'spawnMs',
            'firstOutputMs',
            'firstToolMs',
            'answerMs',
          ])
            sample(`request.${name}`, line[name]);
        else if (event === 'request-end') sample('request.endMs', line.ms);
        else if (event === 'tool-call' && typeof line.tool === 'string' && WORD.test(line.tool))
          sample(`tool.${line.tool}.ms`, line.ms);
        else if (event === 'sync') {
          sample('sync.ms', line.ms);
          sample('sync.hostMs', line.hostMs);
        } else if (event === 'live-sync') sample('live-sync.ms', line.ms);
        else if (
          event === 'cli-exit' &&
          typeof line.provider === 'string' &&
          WORD.test(line.provider)
        )
          sample(`cli.${line.provider}.ms`, line.ms);
        else if (event === 'health')
          for (const name of ['rssMB', 'heapMB', 'loopMaxMs', 'loopP99Ms'])
            sample(`health.${name}`, line[name]);
      } else if ((part === 'rhino' || part === 'zwcad') && event === 'call') {
        if (typeof line.method === 'string' && WORD.test(line.method))
          sample(`${part}.${line.method}.ms`, line.ms);
      }
      // Failures: the allowlisted fields, the same kind merged.
      const failed =
        FAILED_EVENT.test(event) ||
        line.ok === false ||
        (event === 'request-end' && FAILED_STATE.has(String(line.state))) ||
        (event === 'cli-exit' && (line.code !== 0 || line.signal != null)) ||
        (event === 'sync' && typeof line.code === 'string') ||
        (event === 'engine-exit' &&
          part === 'shell' &&
          line.asked === false &&
          !BENIGN_EXITS.has(Number(line.code))) ||
        event === 'engine-restart' ||
        event === 'log-cap';
      if (!failed) continue;
      const fields = allowedFields(event, line, sensitive);
      const id = `${key}|${JSON.stringify({ ...fields, stack: undefined, repeated: undefined, ms: undefined, uptimeSec: undefined })}`;
      const entry = errors.get(id);
      const repeats = 1 + (typeof line.repeated === 'number' ? line.repeated : 0);
      if (entry) {
        entry.count += repeats;
        if (at < entry.first) entry.first = at;
        if (at > entry.last) entry.last = at;
      } else if (errors.size < 400)
        errors.set(id, { part, event, count: repeats, first: at, last: at, fields });
    }
  }
  // The PC program's record of every engine exit (engine-exits.jsonl): the ones it did not ask for.
  const exitFile = join(folder, 'engine-exits.jsonl');
  if (existsSync(exitFile)) {
    const lines = createInterface({
      input: createReadStream(exitFile, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const text of lines) {
      try {
        const line = JSON.parse(text) as Record<string, unknown>;
        const at = typeof line.at === 'string' ? line.at : '';
        if (!(at > options.since && at <= options.until)) continue;
        if (line.asked !== false || typeof line.code !== 'number' || BENIGN_EXITS.has(line.code))
          continue;
        exits.push({
          at,
          code: line.code,
          ...(typeof line.hex === 'string' && /^0x[0-9A-F]{8}$/i.test(line.hex)
            ? { hex: line.hex }
            : {}),
          ...(typeof line.uptimeSec === 'number' ? { uptimeSec: Math.round(line.uptimeSec) } : {}),
        });
      } catch {
        /* A damaged line is skipped. */
      }
    }
  }
  const timings: Record<string, Timing> = {};
  for (const [key, list] of [...samples].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...list].sort((a, b) => a - b);
    timings[key] = {
      n: list.length,
      p50: Math.round(percentile(sorted, 50)),
      p90: Math.round(percentile(sorted, 90)),
      max: Math.round(sorted.at(-1) ?? 0),
    };
  }
  const summary: Summary = {
    from: options.since,
    to: options.until,
    versions: Object.fromEntries(
      Object.entries(versions).map(([part, set]) => [part, [...set].slice(0, 5)]),
    ),
    hosts: {
      ...(hosts.rhino.size ? { rhino: [...hosts.rhino].slice(0, 5) } : {}),
      ...(hosts.zwcad.size ? { zwcad: [...hosts.zwcad].slice(0, 5) } : {}),
    },
    counts: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)).slice(0, 300)),
    errors: [...errors.values()].sort(
      (a, b) => b.count - a.count || a.first.localeCompare(b.first),
    ),
    exits: exits.slice(-20),
    timings,
  };
  return capSummary(summary, options.maxBytes ?? 32 * 1024);
}

/** Leaves details out until the summary's JSON fits `maxBytes`: stacks, then errors, then timings. */
export function capSummary(summary: Summary, maxBytes: number): Summary {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  if (size(summary) <= maxBytes) return summary;
  const total = { errors: summary.errors.length, timings: Object.keys(summary.timings).length };
  const out: Summary = {
    ...summary,
    errors: summary.errors.map((error) => {
      const { stack: _stack, ...fields } = error.fields;
      return { ...error, fields };
    }),
    truncated: { errors: 0, timings: 0, stacks: true },
  };
  while (size(out) > maxBytes && out.errors.length > 5)
    out.errors = out.errors.slice(0, Math.floor(out.errors.length * 0.7));
  const keys = Object.keys(out.timings);
  while (size(out) > maxBytes && keys.length > 10) {
    keys.splice(Math.floor(keys.length * 0.7));
    out.timings = Object.fromEntries(keys.map((key) => [key, summary.timings[key]!]));
  }
  while (size(out) > maxBytes && Object.keys(out.counts).length > 20)
    out.counts = Object.fromEntries(
      Object.entries(out.counts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, Math.floor(Object.keys(out.counts).length * 0.7)),
    );
  if (size(out) > maxBytes) {
    out.errors = out.errors.slice(0, 1).map((error) => ({ ...error, fields: {} }));
    out.exits = out.exits.slice(-3);
  }
  out.truncated = {
    errors: total.errors - out.errors.length,
    timings: total.timings - Object.keys(out.timings).length,
    stacks: true,
  };
  return out;
}
