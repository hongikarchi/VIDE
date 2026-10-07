// jig submissions (ADR-041, SPEC-04.13, ARCH-01 §6 「jig 관리자 제출」): a signed-in work PC sends a
// jig pack (`.vjig`, gzip JSON) with a note; the site computes its SHA-256, checks that it is a
// pack of the declared id and version, keeps the bytes in R2 and the row in D1. The PC's account
// lists only its own submissions; the admins (ADMIN_USERS or the admin token) list all, download
// a pack, set the status (received → reviewing → applied | rejected with a reason) or delete one.
// The site never runs anything inside a pack.
import type { Env } from './auth';
import type { HostRow } from './hosts';
import { HttpError, body, json } from './http';
import { displayName } from './accounts';

const STATUSES = ['received', 'reviewing', 'applied', 'rejected'] as const;
type Status = (typeof STATUSES)[number];
const JIG_ID = /^(vide|project)\/[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const PACK_FORMAT = 'vide.jig.pack/1';
/** Received (not yet looked at) submissions one account may have at once. */
export const PENDING_LIMIT = 20;
const NOTE_MAX = 2000;
const UNPACKED_MAX = 64 * 1024 * 1024;

interface SubmissionRow {
  id: string;
  user_id: string;
  host_id: string | null;
  host_name: string | null;
  jig_id: string;
  version: string;
  name: string;
  note: string;
  size: number;
  sha256: string;
  pack_digest: string;
  object_key: string;
  status: Status;
  reason: string | null;
  reviewed_by: string | null;
  created_at: number;
  updated_at: number;
  email?: string | null;
  user_name?: string | null;
}

const maxBytes = (env: Env) => {
  const mb = Number(env.JIG_SUBMISSION_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 8) * 1024 * 1024;
};
const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (n) => n.toString(16).padStart(2, '0')).join('');

function view(row: SubmissionRow, admin = false) {
  return {
    id: row.id,
    jigId: row.jig_id,
    version: row.version,
    name: row.name,
    note: row.note,
    size: row.size,
    sha256: row.sha256,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pc: row.host_name,
    ...(admin
      ? {
          packDigest: row.pack_digest,
          submitter:
            row.email != null
              ? displayName(row.email, row.user_name ?? '')
              : row.user_id.slice(0, 8),
        }
      : {}),
  };
}

/** The whole body, at most `limit` bytes (413 past it). */
async function readAll(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new HttpError(413, 'JIG_SUBMISSION_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The pack's header fields, after un-gzipping with a cap; undefined when it is not a pack. */
async function packHeader(bytes: Uint8Array) {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return undefined;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > UNPACKED_MAX) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(
      chunks.reduce((all, chunk) => {
        const next = new Uint8Array(all.length + chunk.length);
        next.set(all);
        next.set(chunk, all.length);
        return next;
      }, new Uint8Array()),
    );
    const pack = JSON.parse(text) as Record<string, unknown>;
    if (
      pack?.format !== PACK_FORMAT ||
      typeof pack.id !== 'string' ||
      typeof pack.version !== 'string' ||
      typeof pack.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(pack.digest) ||
      !pack.files ||
      typeof pack.files !== 'object' ||
      Array.isArray(pack.files)
    )
      return undefined;
    return { id: pack.id, version: pack.version, digest: pack.digest };
  } catch {
    return undefined;
  }
}

function decodeNote(value: string | null) {
  if (!value) return '';
  let note: string;
  try {
    note = decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'INVALID_INPUT');
  }
  if (note.length > NOTE_MAX) throw new HttpError(400, 'INVALID_INPUT');
  return note.trim();
}

/** `/api/hosts/device/jig-submissions` — the PC's account sends one or lists its own. */
export async function jigSubmissionDeviceRoute(request: Request, env: Env, row: HostRow) {
  const db = env.DB;
  if (request.method === 'GET') {
    const { results } = await db
      .prepare('SELECT * FROM jig_submissions WHERE user_id=? ORDER BY created_at DESC LIMIT 100')
      .bind(row.user_id)
      .all<SubmissionRow>();
    return json({ submissions: results.map((r) => view(r)) });
  }
  if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
  if (env.UPLOADS_ENABLED === 'false') throw new HttpError(503, 'UPLOADS_DISABLED');
  const url = new URL(request.url);
  const jigId = url.searchParams.get('jig') ?? '',
    version = url.searchParams.get('version') ?? '',
    name = (url.searchParams.get('name') ?? '').trim();
  if (!JIG_ID.test(jigId) || jigId.length > 200 || !VERSION.test(version) || version.length > 50)
    throw new HttpError(400, 'INVALID_INPUT');
  if (name.length > 200) throw new HttpError(400, 'INVALID_INPUT');
  const note = decodeNote(request.headers.get('X-Vide-Note'));
  const max = maxBytes(env);
  const declared = Number(request.headers.get('Content-Length'));
  if (!request.body || !Number.isSafeInteger(declared) || declared <= 0)
    throw new HttpError(411, 'LENGTH_REQUIRED');
  if (declared > max) throw new HttpError(413, 'JIG_SUBMISSION_TOO_LARGE');
  const pending = await db
    .prepare("SELECT COUNT(*) AS n FROM jig_submissions WHERE user_id=? AND status='received'")
    .bind(row.user_id)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= PENDING_LIMIT) throw new HttpError(429, 'JIG_SUBMISSIONS_FULL');
  const bytes = await readAll(request, max);
  const header = await packHeader(bytes);
  if (!header || header.id !== jigId || header.version !== version)
    throw new HttpError(422, 'JIG_PACK_INVALID');
  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
  const id = crypto.randomUUID();
  const key = `jig-submissions/${id}.vjig`;
  await env.ASSETS.put(key, bytes, { httpMetadata: { contentType: 'application/gzip' } });
  const now = Date.now();
  const submission: SubmissionRow = {
    id,
    user_id: row.user_id,
    host_id: row.id,
    host_name: row.name,
    jig_id: jigId,
    version,
    name: name || jigId.split('/')[1],
    note,
    size: bytes.length,
    sha256,
    pack_digest: header.digest,
    object_key: key,
    status: 'received',
    reason: null,
    reviewed_by: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        `INSERT INTO jig_submissions(id,user_id,host_id,host_name,jig_id,version,name,note,size,sha256,pack_digest,object_key,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'received',?,?)`,
      )
      .bind(
        id,
        submission.user_id,
        submission.host_id,
        submission.host_name,
        jigId,
        version,
        submission.name,
        note,
        submission.size,
        sha256,
        header.digest,
        key,
        now,
        now,
      )
      .run();
  } catch (error) {
    await env.ASSETS.delete(key);
    throw error;
  }
  return json({ submission: view(submission) }, 201);
}

const SELECT_ADMIN = `SELECT s.*, u.email AS email, u.name AS user_name FROM jig_submissions s LEFT JOIN "user" u ON u.id=s.user_id`;

/** `/api/admin/jigs…` — worker.ts has checked the caller is an admin (and the Origin of writes). */
export async function adminJigRoute(request: Request, env: Env, path: string[], admin: string) {
  const db = env.DB;
  if (path.length === 0) {
    if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const status = new URL(request.url).searchParams.get('status');
    if (status && !STATUSES.includes(status as Status)) throw new HttpError(400, 'INVALID_INPUT');
    const { results } = await db
      .prepare(
        `${SELECT_ADMIN}${status ? ' WHERE s.status=?' : ''} ORDER BY s.created_at DESC LIMIT 200`,
      )
      .bind(...(status ? [status] : []))
      .all<SubmissionRow>();
    return json({ submissions: results.map((r) => view(r, true)) });
  }
  const row = await db.prepare(`${SELECT_ADMIN} WHERE s.id=?`).bind(path[0]).first<SubmissionRow>();
  if (!row) throw new HttpError(404, 'NOT_FOUND');
  if (path.length === 1 && request.method === 'DELETE') {
    await env.ASSETS.delete(row.object_key);
    await db.prepare('DELETE FROM jig_submissions WHERE id=?').bind(row.id).run();
    return json({ removed: true });
  }
  if (path.length === 2 && path[1] === 'pack') {
    if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const object = await env.ASSETS.get(row.object_key);
    if (!object) throw new HttpError(404, 'NOT_FOUND');
    const file = `${row.jig_id.split('/')[1]}@${row.version}-${row.sha256.slice(0, 8)}.vjig`;
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${file.replace(/[^\w.@-]/g, '')}"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  if (path.length === 2 && path[1] === 'status') {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const input = await body(request);
    const status = input.status;
    if (typeof status !== 'string' || !STATUSES.includes(status as Status))
      throw new HttpError(400, 'INVALID_INPUT');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length > 500) throw new HttpError(400, 'INVALID_INPUT');
    if (status === 'rejected' && !reason) throw new HttpError(400, 'REASON_REQUIRED');
    const now = Date.now();
    await db
      .prepare('UPDATE jig_submissions SET status=?,reason=?,reviewed_by=?,updated_at=? WHERE id=?')
      .bind(status, reason || null, admin, now, row.id)
      .run();
    return json({
      submission: view(
        { ...row, status: status as Status, reason: reason || null, updated_at: now },
        true,
      ),
    });
  }
  throw new HttpError(404, 'NOT_FOUND');
}
