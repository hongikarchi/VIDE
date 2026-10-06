// Opt-in error/performance reports from VIDE installs (ADR-036, PLAN-34 T-157): a public endpoint
// that takes small anonymous summaries into D1 with size and rate limits, a bundle endpoint behind
// a site switch (off until R2 is available), and the admin API that lists reports and gives a CSV.
// Admins are the accounts named in ADMIN_USERS or a caller with the TELEMETRY_ADMIN_TOKEN secret.
import type { Env } from './auth';
import { HttpError, body, digest, json } from './http';

/** The largest report body (bytes); the engine caps its summary at 32 KB. */
export const REPORT_MAX_BYTES = 48 * 1024;
const INSTALL = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,40}$/;
const KINDS = new Set(['summary']);
/** Text a report must never hold: a Windows or UNC path, a user folder, an e-mail address. */
const FORBIDDEN_TEXT =
  /[A-Za-z]:\\\\|[A-Za-z]:\/[^/]|\\\\\\\\[A-Za-z0-9]|[\\/]Users[\\/]{1,2}[^\\/~<"]|\/home\/[^/<"]|[^\s@"<>]+@[^\s@"<>]+\.[a-z]{2,}/i;

const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const limitOf = (value: string | undefined, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

/** One fixed-window counter (a day); answers the count after this call. */
async function count(env: Env, key: string, now: number) {
  const row = await env.DB.prepare(
    'INSERT INTO telemetry_limits(key,window_start,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',
  )
    .bind(key, now)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

async function limited(env: Env, request: Request, installId: string, kind: string, now: number) {
  const today = day(now);
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const perInstall = limitOf(env.TELEMETRY_INSTALL_DAILY, kind === 'bundle' ? 3 : 24);
  const perIp = limitOf(env.TELEMETRY_IP_DAILY, kind === 'bundle' ? 20 : 300);
  const [install, address] = await Promise.all([
    count(env, `${kind}:install:${installId}:${today}`, now),
    count(env, `${kind}:ip:${(await digest(ip)).slice(0, 32)}:${today}`, now),
  ]);
  return install > perInstall || address > perIp;
}

/** Old counters and reports go now and then (on about one write in fifty). */
async function prune(env: Env, now: number) {
  const keepDays = limitOf(env.TELEMETRY_KEEP_DAYS, 180);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM telemetry_limits WHERE window_start<?').bind(now - 2 * 86_400_000),
    env.DB.prepare('DELETE FROM telemetry_reports WHERE received_at<?').bind(
      now - keepDays * 86_400_000,
    ),
  ]);
}

/** POST /api/telemetry/reports — public; no account, no cookies. */
export async function receiveReport(request: Request, env: Env, ctx: ExecutionContext) {
  if (env.TELEMETRY_REPORTS_ENABLED === 'false') throw new HttpError(503, 'REPORTS_DISABLED');
  const input = await body(request, REPORT_MAX_BYTES);
  const installId = typeof input.installId === 'string' ? input.installId.toLowerCase() : '';
  const version = typeof input.version === 'string' ? input.version : '';
  const kind = typeof input.kind === 'string' ? input.kind : '';
  if (!INSTALL.test(installId) || !VERSION.test(version) || !KINDS.has(kind))
    throw new HttpError(400, 'INVALID_REPORT');
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload))
    throw new HttpError(400, 'INVALID_REPORT');
  const payload = JSON.stringify(input.payload);
  if (payload.length > REPORT_MAX_BYTES) throw new HttpError(413, 'INPUT_TOO_LARGE');
  // The engine removes these before sending; a report that still has one is not kept.
  if (FORBIDDEN_TEXT.test(payload)) throw new HttpError(422, 'REPORT_REJECTED');
  const now = Date.now();
  if (await limited(env, request, installId, 'report', now))
    throw new HttpError(429, 'RATE_LIMITED');
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO telemetry_reports(id,install_id,version,kind,received_at,day,size,payload) VALUES(?,?,?,?,?,?,?,?)',
  )
    .bind(id, installId, version, kind, now, day(now), payload.length, payload)
    .run();
  if (Math.random() < 0.02) ctx.waitUntil(prune(env, now).catch(() => {}));
  return json({ id }, 201);
}

/** POST /api/telemetry/bundles — a diagnostic bundle the user chose to send; off by default. */
export async function receiveBundle(request: Request, env: Env) {
  if (env.TELEMETRY_BUNDLES_ENABLED !== 'true') throw new HttpError(503, 'BUNDLES_DISABLED');
  const installId = (request.headers.get('X-Vide-Install') ?? '').toLowerCase();
  const version = request.headers.get('X-Vide-Version') ?? '';
  const dumps = request.headers.get('X-Vide-Dumps') === '1';
  if (!INSTALL.test(installId) || !VERSION.test(version))
    throw new HttpError(400, 'INVALID_BUNDLE');
  if (request.headers.get('Content-Type') !== 'application/zip')
    throw new HttpError(415, 'ZIP_REQUIRED');
  const max =
    limitOf(
      dumps ? env.TELEMETRY_BUNDLE_DUMP_MAX_MB : env.TELEMETRY_BUNDLE_MAX_MB,
      dumps ? 95 : 8,
    ) *
    1024 *
    1024;
  const declared = Number(request.headers.get('Content-Length'));
  if (!request.body || !Number.isFinite(declared) || declared <= 0 || declared > max)
    throw new HttpError(413, 'INPUT_TOO_LARGE');
  const now = Date.now();
  if (await limited(env, request, installId, 'bundle', now))
    throw new HttpError(429, 'RATE_LIMITED');
  const id = crypto.randomUUID();
  const key = `telemetry/bundles/${day(now)}/${installId}/${id}.zip`;
  const stored = await env.ASSETS.put(key, request.body, {
    httpMetadata: { contentType: 'application/zip' },
  });
  if (!stored || stored.size > max) {
    await env.ASSETS.delete(key);
    throw new HttpError(413, 'INPUT_TOO_LARGE');
  }
  await env.DB.prepare(
    'INSERT INTO telemetry_bundles(id,install_id,version,received_at,size,object_key,dumps) VALUES(?,?,?,?,?,?,?)',
  )
    .bind(id, installId, version, now, stored.size, key, dumps ? 1 : 0)
    .run();
  return json({ id }, 201);
}

// --- admin ----------------------------------------------------------------------------------------

/** The admin accounts' IDs (ADMIN_USERS, comma separated; an ID account or an e-mail). */
export function adminUsers(env: Env) {
  return new Set(
    (env.ADMIN_USERS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}
export function isAdminName(env: Env, username: string, email: string) {
  const admins = adminUsers(env);
  return admins.has(username.toLowerCase()) || admins.has(email.toLowerCase());
}
/** A caller with the admin token (developers' tools): compared as digests. */
export async function hasAdminToken(env: Env, request: Request) {
  const token = /^Bearer\s+(\S{32,})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token || !env.TELEMETRY_ADMIN_TOKEN || env.TELEMETRY_ADMIN_TOKEN.length < 32) return false;
  return (await digest(token)) === (await digest(env.TELEMETRY_ADMIN_TOKEN));
}

interface ReportRow {
  id: string;
  install_id: string;
  version: string;
  kind: string;
  received_at: number;
  day: string;
  size: number;
  payload: string;
}
function filters(url: URL) {
  const where: string[] = [];
  const values: (string | number)[] = [];
  const dayValue = url.searchParams.get('day');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const version = url.searchParams.get('version');
  const kind = url.searchParams.get('kind');
  const install = url.searchParams.get('install');
  const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (dayValue) {
    if (!isDay(dayValue)) throw new HttpError(400, 'INVALID_DAY');
    where.push('day=?');
    values.push(dayValue);
  }
  if (from) {
    if (!isDay(from)) throw new HttpError(400, 'INVALID_DAY');
    where.push('day>=?');
    values.push(from);
  }
  if (to) {
    if (!isDay(to)) throw new HttpError(400, 'INVALID_DAY');
    where.push('day<=?');
    values.push(to);
  }
  if (version) {
    if (!VERSION.test(version)) throw new HttpError(400, 'INVALID_VERSION');
    where.push('version=?');
    values.push(version);
  }
  if (kind) {
    where.push('kind=?');
    values.push(kind.slice(0, 20));
  }
  if (install) {
    if (!INSTALL.test(install)) throw new HttpError(400, 'INVALID_INSTALL');
    where.push('install_id=?');
    values.push(install.toLowerCase());
  }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', values };
}

/** A short line of a report for lists and the CSV: errors, top error, exits, OS. */
export function reportDigest(payload: string) {
  try {
    const value = JSON.parse(payload) as {
      os?: unknown;
      errors?: { event?: unknown; count?: unknown; fields?: { code?: unknown } }[];
      exits?: unknown[];
      truncated?: unknown;
    };
    const errors = Array.isArray(value.errors) ? value.errors : [];
    const top = errors[0];
    return {
      os: typeof value.os === 'string' ? value.os : '',
      errors: errors.reduce((sum, error) => sum + (Number(error.count) || 0), 0),
      topError: top
        ? `${String(top.event ?? '')}${top.fields?.code ? ' ' + String(top.fields.code) : ''}`
        : '',
      exits: Array.isArray(value.exits) ? value.exits.length : 0,
      truncated: !!value.truncated,
    };
  } catch {
    return { os: '', errors: 0, topError: '', exits: 0, truncated: false };
  }
}

/** One CSV cell: quoted, and a leading = + - @ made inert for spreadsheets. */
export function csvCell(value: unknown) {
  let text = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n']/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}
export function reportsCsv(rows: ReportRow[]) {
  const head = [
    'id',
    'received_at',
    'day',
    'install_id',
    'version',
    'kind',
    'size',
    'os',
    'errors',
    'top_error',
    'exits',
    'truncated',
    'payload',
  ];
  const lines = rows.map((row) => {
    const brief = reportDigest(row.payload);
    return [
      row.id,
      new Date(row.received_at).toISOString(),
      row.day,
      row.install_id,
      row.version,
      row.kind,
      row.size,
      brief.os,
      brief.errors,
      brief.topError,
      brief.exits,
      brief.truncated,
      row.payload,
    ]
      .map(csvCell)
      .join(',');
  });
  return '﻿' + [head.join(','), ...lines].join('\r\n') + '\r\n';
}

/** GET /api/admin/telemetry/… — the caller is checked by worker.ts (admin account or token). */
export async function adminTelemetryRoute(request: Request, env: Env, path: string[]) {
  if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
  const url = new URL(request.url);
  if (path[0] === 'summary' && path.length === 1) {
    const { sql, values } = filters(url);
    const { results } = await env.DB.prepare(
      `SELECT day,version,kind,COUNT(*) AS reports,COUNT(DISTINCT install_id) AS installs,SUM(size) AS bytes FROM telemetry_reports${sql} GROUP BY day,version,kind ORDER BY day DESC,version DESC LIMIT 500`,
    )
      .bind(...values)
      .all();
    return json({ rows: results });
  }
  if (path[0] === 'reports' && path.length === 1) {
    const { sql, values } = filters(url);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const before = Number(url.searchParams.get('before'));
    const where =
      Number.isFinite(before) && before > 0
        ? (sql ? sql + ' AND' : ' WHERE') + ' received_at<?'
        : sql;
    const { results } = await env.DB.prepare(
      `SELECT id,install_id,version,kind,received_at,day,size,payload FROM telemetry_reports${where} ORDER BY received_at DESC LIMIT ?`,
    )
      .bind(...values, ...(Number.isFinite(before) && before > 0 ? [before] : []), limit)
      .all<ReportRow>();
    return json({
      reports: results.map((row) => ({
        ...row,
        payload: JSON.parse(row.payload) as unknown,
        brief: reportDigest(row.payload),
      })),
      next: results.length === limit ? results.at(-1)!.received_at : null,
    });
  }
  if (path[0] === 'reports.csv' && path.length === 1) {
    const { sql, values } = filters(url);
    const { results } = await env.DB.prepare(
      `SELECT id,install_id,version,kind,received_at,day,size,payload FROM telemetry_reports${sql} ORDER BY received_at DESC LIMIT 5000`,
    )
      .bind(...values)
      .all<ReportRow>();
    return new Response(reportsCsv(results), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="vide-reports-${day(Date.now())}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  if (path[0] === 'bundles' && path.length === 1) {
    const { results } = await env.DB.prepare(
      'SELECT id,install_id,version,received_at,size,dumps FROM telemetry_bundles ORDER BY received_at DESC LIMIT 200',
    ).all();
    return json({ bundles: results, enabled: env.TELEMETRY_BUNDLES_ENABLED === 'true' });
  }
  if (path[0] === 'bundles' && path[1] && path.length === 2) {
    const row = await env.DB.prepare('SELECT object_key FROM telemetry_bundles WHERE id=?')
      .bind(path[1])
      .first<{ object_key: string }>();
    const object = row && (await env.ASSETS.get(row.object_key));
    if (!object) throw new HttpError(404, 'NOT_FOUND');
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${path[1].replace(/[^\w-]/g, '')}.zip"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  throw new HttpError(404, 'NOT_FOUND');
}
