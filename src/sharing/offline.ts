import { HttpError, body, json, text } from './http';
import type { Env } from './auth';
import type { HostRow } from './hosts';
import type { Actor } from './projects';
import { membership } from './projects';
import { summaryRoute } from './summary';

// PLAN-20: the account site while the work PC is off. The PC uploads the last Sync of each linked
// file as a small view-only snapshot (geometry, no source file) when its owner turned that on for
// the project, and picks up requests left on the site when it comes back. One snapshot per linked
// file (replaced, never versioned), a per-account and a site-wide byte cap, and a per-snapshot
// size just under the platform's 100 MB request limit (ADR-031 7). The account's R2 is already past the free 10 GB, so
// every stored byte is billed: the site-wide cap defaults to 0 (off) until paying for storage is
// an approved decision (RESEARCH-10 §13.6, §16 C3). The upload pause is applied in worker.ts.
const SNAPSHOT_MAX_BYTES = 95 * 1024 * 1024;
const QUEUE_BODY = 4000;
const QUEUE_OPEN_PER_PROJECT = 20;
const MB = 1024 * 1024;

const limitMb = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * MB;
};
/** Site-wide snapshot bytes; unset or 0 means snapshots are off. */
const siteLimit = (env: Env) => limitMb(env.SNAPSHOT_TOTAL_MB, 0);
/** Whether this site stores snapshots at all (switch on and a site-wide cap set). */
export const snapshotsOn = (env: Env) => env.SNAPSHOTS_ENABLED !== 'false' && siteLimit(env) > 0;
const snapshotKey = (projectId: string, linkId: string) => `snapshots/${projectId}/${linkId}`;
const uuid = (value: unknown) => {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value))
    throw new HttpError(400, 'INVALID_INPUT');
  return value.toLowerCase();
};
const projectId = (value: unknown) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(value))
    throw new HttpError(400, 'INVALID_INPUT');
  return value;
};

async function ownedByHost(db: D1Database, row: HostRow, id: string) {
  const project = await db
    .prepare('SELECT id FROM projects WHERE id=? AND host_id=? AND created_by=?')
    .bind(id, row.id, row.user_id)
    .first();
  if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND');
}

/** Undelivered requests for this PC, returned with its heartbeat. */
export async function pendingQueue(db: D1Database, row: HostRow) {
  const rows = await db
    .prepare(
      `SELECT id,project_id,link_id,body,created_at FROM queued_requests
       WHERE host_id=? AND user_id=? AND delivered_at IS NULL AND canceled_at IS NULL
       ORDER BY created_at LIMIT 50`,
    )
    .bind(row.id, row.user_id)
    .all<{
      id: string;
      project_id: string;
      link_id: string | null;
      body: string;
      created_at: number;
    }>();
  return rows.results.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    linkId: r.link_id,
    body: r.body,
    createdAt: r.created_at,
  }));
}

/** PC calls: store or remove a linked file's snapshot, confirm received requests. */
export async function offlineDeviceRoute(
  request: Request,
  env: Env,
  row: HostRow,
  path: string[],
): Promise<Response | undefined> {
  const db = env.DB;
  if (path[0] === 'projects' && path[2] === 'snapshots' && path.length === 4) {
    const project = projectId(path[1]),
      link = uuid(path[3]);
    await ownedByHost(db, row, project);
    const key = snapshotKey(project, link);
    if (request.method === 'DELETE') {
      await env.ASSETS.delete(key);
      await db
        .prepare('DELETE FROM project_snapshots WHERE project_id=? AND link_id=?')
        .bind(project, link)
        .run();
      return json({ removed: true });
    }
    if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    if (!snapshotsOn(env)) throw new HttpError(503, 'SNAPSHOTS_DISABLED');
    const url = new URL(request.url);
    const name = text(url.searchParams.get('name'), 260),
      host = url.searchParams.get('host'),
      objects = Number(url.searchParams.get('objects')),
      captured = Number(url.searchParams.get('captured'));
    if (
      (host !== 'rhino' && host !== 'zwcad') ||
      !Number.isSafeInteger(objects) ||
      objects < 0 ||
      !Number.isSafeInteger(captured) ||
      captured <= 0
    )
      throw new HttpError(400, 'INVALID_INPUT');
    const size = Number(request.headers.get('Content-Length'));
    if (!Number.isSafeInteger(size) || size <= 0 || !request.body)
      throw new HttpError(411, 'LENGTH_REQUIRED');
    if (size > SNAPSHOT_MAX_BYTES) throw new HttpError(413, 'SNAPSHOT_TOO_LARGE');
    // Room is checked against what stays after this file's old snapshot is replaced.
    const usage = await db
      .prepare(
        `SELECT
          COALESCE(SUM(CASE WHEN user_id=? AND NOT (project_id=? AND link_id=?) THEN size END),0) AS mine,
          COALESCE(SUM(CASE WHEN NOT (project_id=? AND link_id=?) THEN size END),0) AS total
         FROM project_snapshots`,
      )
      .bind(row.user_id, project, link, project, link)
      .first<{ mine: number; total: number }>();
    if ((usage?.mine ?? 0) + size > limitMb(env.SNAPSHOT_QUOTA_MB, 500))
      throw new HttpError(507, 'SNAPSHOT_QUOTA');
    if ((usage?.total ?? 0) + size > siteLimit(env)) throw new HttpError(507, 'SNAPSHOT_SITE_FULL');
    let stored: R2Object | null;
    try {
      stored = await env.ASSETS.put(key, request.body, {
        httpMetadata: { contentType: 'application/octet-stream' },
      });
    } catch {
      throw new HttpError(422, 'SNAPSHOT_UPLOAD_FAILED');
    }
    if (!stored || stored.size !== size) {
      await env.ASSETS.delete(key);
      throw new HttpError(422, 'SNAPSHOT_UPLOAD_FAILED');
    }
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO project_snapshots(project_id,link_id,user_id,name,host,size,object_count,captured_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(project_id,link_id) DO UPDATE SET name=excluded.name,host=excluded.host,
           size=excluded.size,object_count=excluded.object_count,captured_at=excluded.captured_at,
           updated_at=excluded.updated_at`,
      )
      .bind(project, link, row.user_id, name, host, size, objects, captured, now)
      .run();
    return json({ stored: true, size });
  }
  if (path[0] === 'queue' && path[1] === 'delivered' && path.length === 2) {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const ids = (await body(request)).ids;
    if (!Array.isArray(ids) || ids.length > 50) throw new HttpError(400, 'INVALID_INPUT');
    const now = Date.now();
    if (ids.length)
      await db.batch(
        ids.map((id) =>
          db
            .prepare(
              'UPDATE queued_requests SET delivered_at=? WHERE id=? AND host_id=? AND delivered_at IS NULL',
            )
            .bind(now, uuid(id), row.id),
        ),
      );
    return json({ delivered: ids.length });
  }
  return undefined;
}

/** Owner calls from the site: saved views of linked files and requests for the PC. */
export async function offlineRoute(
  request: Request,
  env: Env,
  actor: Actor,
  project: string,
  path: string[],
): Promise<Response> {
  const db = env.DB;
  // The PC's model is the owner's own work; shared members see only what was published.
  if ((await membership(db, project, actor.id)) !== 'owner')
    throw new HttpError(403, 'OWNER_REQUIRED');
  // 할 일 and the work history summary (PLAN-33), under the same owner rule.
  if (path[0] === 'agenda' || path[0] === 'history')
    return summaryRoute(request, env, actor, project, path);
  if (path[0] === 'snapshots') {
    if (path.length === 1 && request.method === 'GET') {
      const rows = await db
        .prepare(
          `SELECT link_id AS linkId,name,host,size,object_count AS objectCount,captured_at AS capturedAt,
            updated_at AS updatedAt FROM project_snapshots WHERE project_id=? ORDER BY name LIMIT 100`,
        )
        .bind(project)
        .all();
      return json({ snapshots: rows.results });
    }
    if (path.length === 2 && request.method === 'GET') {
      const link = uuid(path[1]);
      const stored = await env.ASSETS.get(snapshotKey(project, link));
      if (!stored) throw new HttpError(404, 'SNAPSHOT_NOT_FOUND');
      return new Response(stored.body, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(stored.size),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
  }
  if (path[0] === 'queue') {
    if (path.length === 1 && request.method === 'GET') {
      const rows = await db
        .prepare(
          `SELECT id,link_id AS linkId,body,created_at AS createdAt,delivered_at AS deliveredAt,
            canceled_at AS canceledAt FROM queued_requests WHERE project_id=? AND user_id=?
            ORDER BY created_at DESC LIMIT 50`,
        )
        .bind(project, actor.id)
        .all();
      return json({ requests: rows.results });
    }
    if (path.length === 1 && request.method === 'POST') {
      const input = await body(request),
        requestBody = text(input.body, QUEUE_BODY),
        link = input.linkId === undefined || input.linkId === null ? null : uuid(input.linkId);
      const owner = await db
        .prepare('SELECT host_id FROM projects WHERE id=? AND deleted_at IS NULL')
        .bind(project)
        .first<{ host_id: string | null }>();
      if (!owner?.host_id) throw new HttpError(409, 'HOST_NOT_FOUND');
      const open = await db
        .prepare(
          'SELECT COUNT(*) AS n FROM queued_requests WHERE project_id=? AND delivered_at IS NULL AND canceled_at IS NULL',
        )
        .bind(project)
        .first<{ n: number }>();
      if ((open?.n ?? 0) >= QUEUE_OPEN_PER_PROJECT) throw new HttpError(429, 'QUEUE_FULL');
      const id = crypto.randomUUID(),
        now = Date.now();
      await db
        .prepare(
          'INSERT INTO queued_requests(id,project_id,user_id,host_id,link_id,body,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .bind(id, project, actor.id, owner.host_id, link, requestBody, now)
        .run();
      return json({ id, createdAt: now }, 201);
    }
    if (path.length === 2 && request.method === 'DELETE') {
      // Only requests the PC has not picked up yet can be taken back.
      const result = await db
        .prepare(
          'UPDATE queued_requests SET canceled_at=? WHERE id=? AND project_id=? AND user_id=? AND delivered_at IS NULL AND canceled_at IS NULL',
        )
        .bind(Date.now(), uuid(path[1]), project, actor.id)
        .run();
      if (!result.meta.changes) throw new HttpError(409, 'QUEUE_ITEM_DELIVERED');
      return json({ canceled: true });
    }
  }
  throw new HttpError(404, 'NOT_FOUND');
}
