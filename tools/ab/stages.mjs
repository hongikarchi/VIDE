// Joins one scenario run with the engine's diagnostic log (PLAN-51 T-264): the `request-stages`
// and `request-end` lines of a request (src/server/execution.ts, written when the run ends) and the
// desktop shell's unasked engine exits (engine-exits.jsonl, src/desktop/shell/Engine.cs).
//
// Line shapes (src/server/diagnostics.ts Diagnostics.write):
//   {"at","v","sid","event":"request-stages","requestId","projectId", queuedMs?, contextMs?,
//    providerMs?, authMs?, authCached?, spawnMs?, firstOutputMs?, processReused?, firstNoteMs?,
//    firstToolMs?, lastToolMs?, answerMs?, totalMs, queries, executes}
//   {"at","v","sid","event":"request-end","requestId","projectId","state","code","ms"}
//   engine-exits.jsonl: {"at","event":"engine-exit","pid","code","hex","uptimeSec","asked"}
// Parsing follows tools/diagnostics/view.mjs: files by UTC day, unreadable lines skipped and counted.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

const ENVELOPE = new Set(['at', 'v', 'sid', 'event', 'requestId', 'projectId']);
const DAY_FILE = /^engine-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** Exits are written by another process a moment after the engine ends. */
const EXIT_GRACE_MS = 5000;

const msOf = (value) =>
  value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;

/** Parsed JSON lines of one file; unreadable lines are counted, never fatal. */
function readLines(file) {
  const out = { lines: [], unreadable: 0 };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const row of text.split('\n')) {
    if (!row.trim()) continue;
    try {
      out.lines.push(JSON.parse(row));
    } catch {
      out.unreadable++;
    }
  }
  return out;
}

/** UTC days from the day before `from` to the day after `to` (a run near midnight, clock skew). */
function daysCovering(from, to) {
  const start = Number.isFinite(from) ? from : Date.now();
  const end = Number.isFinite(to) ? to : start;
  const days = new Set();
  for (let t = start - 86400000; t <= end + 86400000; t += 86400000)
    days.add(new Date(t).toISOString().slice(0, 10));
  days.add(new Date(end + 86400000).toISOString().slice(0, 10));
  return days;
}

/**
 * The request's stage times and end from the engine log.
 * @returns {{ stages: object|null, end: {state, code, ms?}|null, lines: object[], unreadable: number }}
 */
export function readStages({ logsDir, requestId, startedAt, endedAt }) {
  const result = { stages: null, end: null, lines: [], unreadable: 0 };
  if (!logsDir || !requestId || !existsSync(logsDir)) return result;
  const days = daysCovering(msOf(startedAt), msOf(endedAt));
  const files = readdirSync(logsDir)
    .filter((file) => DAY_FILE.test(file) && days.has(DAY_FILE.exec(file)[1]))
    .sort();
  for (const file of files) {
    const { lines, unreadable } = readLines(join(logsDir, file));
    result.unreadable += unreadable;
    for (const line of lines) {
      if (line?.requestId !== requestId && line?.request !== requestId) continue;
      result.lines.push(line);
      if (line.event === 'request-stages')
        result.stages = Object.fromEntries(
          Object.entries(line).filter(([key]) => !ENVELOPE.has(key)),
        );
      else if (line.event === 'request-end')
        result.end = {
          state: line.state ?? null,
          code: line.code ?? null,
          ...(Number.isFinite(line.ms) ? { ms: line.ms } : {}),
        };
    }
  }
  result.lines.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return result;
}

/** Engine exits the shell did not ask for between startedAt and endedAt (+5 s). */
export function countCrashes({ logsDir, startedAt, endedAt }) {
  if (!logsDir) return 0;
  const file = join(logsDir, 'engine-exits.jsonl');
  if (!existsSync(file)) return 0;
  const from = msOf(startedAt);
  const to = msOf(endedAt ?? startedAt) + EXIT_GRACE_MS;
  return readLines(file).lines.filter((line) => {
    if (line?.asked !== false) return false;
    const at = Date.parse(line.at);
    return Number.isFinite(at) && (!Number.isFinite(from) || at >= from) && at <= to;
  }).length;
}

/**
 * The engine's last `route` line in the window (server.ts /route: by, target, jig?, reason?, ms; no
 * request text and no request id), for the reason a Jev decision is missing.
 */
export function readRouteLine({ logsDir, startedAt, endedAt }) {
  if (!logsDir || !existsSync(logsDir)) return null;
  const from = msOf(startedAt) - 1000;
  const to = msOf(endedAt ?? startedAt) + 2000;
  const days = daysCovering(from, to);
  let found = null;
  for (const file of readdirSync(logsDir).sort()) {
    const day = DAY_FILE.exec(file);
    if (!day || !days.has(day[1])) continue;
    for (const line of readLines(join(logsDir, file)).lines) {
      if (line?.event !== 'route') continue;
      const at = Date.parse(line.at);
      if (at >= from && at <= to && (!found || String(line.at) >= String(found.at))) found = line;
    }
  }
  return found;
}

/** engine-*.jsonl lines whose `at` falls in the window: 0 means the logs dir is not this engine's. */
export function countLogLines({ logsDir, startedAt, endedAt }) {
  if (!logsDir || !existsSync(logsDir)) return 0;
  const from = msOf(startedAt) - 1000;
  const to = msOf(endedAt ?? startedAt) + 2000;
  const days = daysCovering(from, to);
  let count = 0;
  for (const file of readdirSync(logsDir)) {
    const day = DAY_FILE.exec(file);
    if (!day || !days.has(day[1])) continue;
    for (const line of readLines(join(logsDir, file)).lines) {
      const at = Date.parse(line?.at);
      if (Number.isFinite(at) && at >= from && at <= to) count++;
    }
  }
  return count;
}

// --- engine guard (PLAN-51 §1: the loop never drives the person's engines) ------------------------
// A port alone does not tell: src/server/main.ts falls back to a random port on EADDRINUSE, so the
// installed engine (data %LOCALAPPDATA%\VIDE, 47821) or the person's `npm run dev` engine (data
// .vide/dev-data, 47831) may sit on any port. An engine is theirs when its port is theirs, its
// origin equals the URL in their launch.json, or the launch file / logs dir lies in their data folder.
export const INSTALLED_PORT = '47821';
export const DEV_PORT = '47831';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const hostKey = (url) => {
  try {
    const u = new URL(url);
    return `${LOOPBACK.has(u.hostname) ? 'loopback' : u.hostname}:${u.port}`;
  } catch {
    return null;
  }
};
const inside = (path, dir) => {
  if (!path || !dir) return false;
  const norm = (p) => resolvePath(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const p = norm(path);
  const d = norm(dir);
  return p === d || p.startsWith(d + '/');
};
function launchUrlOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'launch.json'), 'utf8')).url ?? null;
  } catch {
    return null;
  }
}

/**
 * The person's two engines: their data folders and current launch URLs (when readable).
 * @param env process.env-like; `root` the repository root (for .vide/dev-data)
 */
export function personEngines({ env = process.env, root = process.cwd(), home } = {}) {
  const localAppData = env.LOCALAPPDATA || (home ? join(home, 'AppData', 'Local') : null);
  const installed = localAppData ? join(localAppData, 'VIDE') : null;
  const dev = join(root, '.vide', 'dev-data');
  return [
    { kind: 'installed', dir: installed, port: INSTALLED_PORT, url: installed && launchUrlOf(installed) },
    { kind: 'dev', dir: dev, port: DEV_PORT, url: launchUrlOf(dev) },
  ];
}

/**
 * Which of the person's engines a launch points at: 'installed', 'dev' (their `npm run dev`) or
 * null (a loop engine). Pure over its inputs. `why` says what matched.
 */
export function identifyEngine({ origin, launchFile, logsDir, engines }) {
  const key = hostKey(origin);
  for (const engine of engines) {
    const why = [];
    if (key && key.endsWith(':' + engine.port)) why.push(`port ${engine.port}`);
    if (key && engine.url && hostKey(engine.url) === key) why.push(`origin in ${join(engine.dir, 'launch.json')}`);
    if (inside(launchFile, engine.dir)) why.push(`launch file in ${engine.dir}`);
    if (inside(logsDir, engine.dir)) why.push(`logs in ${engine.dir}`);
    if (why.length) return { kind: engine.kind, why: why.join(', ') };
  }
  return { kind: null, why: null };
}
