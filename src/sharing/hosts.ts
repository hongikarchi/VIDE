import { HttpError, body, digest, json, text } from './http';
import type { Env } from './auth';
import type { Actor } from './projects';
import { signIn } from './accounts';

// Work PCs: a desktop VIDE (with Rhino/CAD attached) signs in once with the account's ID and
// password and receives a host key. It then reports by heartbeat that it is on, its local address
// (for a browser on the same PC) and, when remote access is on, its temporary tunnel address.
// Opening a project hands the browser a one-minute token signed with that PC's key, which only
// that PC can verify. The PC does all the work; this Worker keeps the project list and presence.
const ONLINE_MS = 45_000;
const TOKEN_MS = 60_000;
const THUMBNAIL_BYTES = 160_000;

export interface HostRow {
  id: string;
  user_id: string;
  name: string;
  secret: string;
  url: string | null;
  local_url: string | null;
  status: string | null;
  last_seen: number;
}
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
const random = (length: number) => hex(crypto.getRandomValues(new Uint8Array(length)));
const base64url = (value: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}
/** Only Cloudflare quick-tunnel addresses may be advertised, so the list cannot redirect elsewhere. */
function tunnelUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const url = parseUrl(value);
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname) ||
    url.port
  )
    throw new HttpError(400, 'INVALID_URL');
  return url.origin;
}
/** The local address is loopback only: a browser on another device can never be sent there. */
function localUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const url = parseUrl(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port)
    throw new HttpError(400, 'INVALID_URL');
  return url.origin;
}
function parseUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 200) throw new HttpError(400, 'INVALID_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'INVALID_URL');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new HttpError(400, 'INVALID_URL');
  return url;
}
export const online = (row: HostRow, now = Date.now()) => now - row.last_seen < ONLINE_MS;
const projectId = (value: unknown) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(value))
    throw new HttpError(400, 'INVALID_INPUT');
  return value;
};

/** A one-minute token for the host's workspace, opening `project` there. */
export async function openLinks(row: HostRow, project: string) {
  const link = async (base: string | null) => {
    if (!base) return null;
    const payload = base64url(
      JSON.stringify({ h: row.id, n: random(16), e: Date.now() + TOKEN_MS }),
    );
    const token = payload + '.' + (await hmac(row.secret, payload));
    return `${base}/?project=${encodeURIComponent(project)}#r=${token}`;
  };
  return { hostId: row.id, remote: await link(row.url), local: await link(row.local_url) };
}

async function authenticateHost(request: Request, db: D1Database) {
  const [id, secret] = (request.headers.get('Authorization') ?? '')
    .replace(/^Bearer /, '')
    .split('.');
  const row = id
    ? await db.prepare('SELECT * FROM remote_hosts WHERE id=?').bind(id).first<HostRow>()
    : null;
  // Compare digests so the check does not depend on where the strings first differ.
  if (!row || !secret || (await digest(secret)) !== (await digest(row.secret)))
    throw new HttpError(401, 'HOST_UNAUTHORIZED');
  return row;
}

interface AuthHandler {
  handler: (request: Request) => Promise<Response>;
}
/** Desktop-to-Worker calls: account login, then the host key. No browser session. */
export async function hostDeviceRoute(
  request: Request,
  env: Env,
  auth: AuthHandler,
  path: string[],
) {
  const db = env.DB;
  if (path[0] === 'login' && path.length === 1 && request.method === 'POST') {
    const input = await body(request);
    const name = text(input.name, 80);
    const response = await signIn(auth, request, env, input.username, input.password);
    if (!response.ok) throw new HttpError(401, 'INVALID_LOGIN');
    const reply = (await response.json()) as { token?: string; user?: { id?: string } };
    const userId = reply.user?.id;
    if (!userId) throw new HttpError(401, 'INVALID_LOGIN');
    // The PC keeps only its host key; the browser session made by the check is discarded.
    if (reply.token) await db.prepare('DELETE FROM session WHERE token=?').bind(reply.token).run();
    const id = crypto.randomUUID(),
      secret = random(32);
    await db
      .prepare('INSERT INTO remote_hosts(id,user_id,name,secret,created_at) VALUES(?,?,?,?,?)')
      .bind(id, userId, name, secret, Date.now())
      .run();
    return json({ hostId: id, secret }, 201);
  }
  const row = await authenticateHost(request, db);
  if (path[0] === 'heartbeat' && path.length === 1 && request.method === 'POST') {
    const input = await body(request, 65536);
    const offline = input.offline === true;
    const url = offline ? null : tunnelUrl(input.url),
      local = offline ? null : localUrl(input.local);
    const status = JSON.stringify(input.status ?? {});
    if (status.length > 8192) throw new HttpError(413, 'INPUT_TOO_LARGE');
    const now = Date.now();
    const statements = [
      db
        .prepare('UPDATE remote_hosts SET url=?,local_url=?,status=?,last_seen=? WHERE id=?')
        .bind(url, local, status, offline ? 0 : now, row.id),
    ];
    // Last work time per project, so the list shows recent work first.
    const activity = input.activity;
    if (activity && typeof activity === 'object' && !Array.isArray(activity))
      for (const [id, at] of Object.entries(activity).slice(0, 200))
        if (typeof at === 'number' && at > 0 && at <= now + 60_000)
          statements.push(
            db
              .prepare(
                `UPDATE projects SET updated_at=MAX(COALESCE(updated_at,0),?) WHERE id=? AND host_id=?`,
              )
              .bind(Math.floor(at), id, row.id),
          );
    await db.batch(statements);
    const projects = await db
      .prepare(
        'SELECT id,name,deleted_at FROM projects WHERE host_id=? AND created_by=? ORDER BY created_at LIMIT 500',
      )
      .bind(row.id, row.user_id)
      .all<{ id: string; name: string; deleted_at: number | null }>();
    return json({
      ok: true,
      projects: projects.results.map((p) => ({ id: p.id, name: p.name, deleted: !!p.deleted_at })),
    });
  }
  if (path[0] === 'projects' && path.length === 1 && request.method === 'POST') {
    // A project created or renamed on the PC joins the account's list, keeping the PC's id.
    const input = await body(request);
    const id = projectId(input.id),
      name = text(input.name, 200),
      now = Date.now();
    const existing = await db
      .prepare('SELECT created_by,deleted_at FROM projects WHERE id=?')
      .bind(id)
      .first<{ created_by: string; deleted_at: number | null }>();
    if (existing) {
      if (existing.created_by !== row.user_id) throw new HttpError(409, 'PROJECT_CONFLICT');
      await db
        .prepare('UPDATE projects SET name=?,host_id=COALESCE(host_id,?) WHERE id=?')
        .bind(name, row.id, id)
        .run();
      return json({ id, name, deleted: !!existing.deleted_at });
    }
    await db.batch([
      db
        .prepare(
          'INSERT INTO projects(id,name,created_by,created_at,updated_at,host_id) VALUES(?,?,?,?,?,?)',
        )
        .bind(id, name, row.user_id, now, now, row.id),
      db
        .prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'owner')")
        .bind(id, row.user_id),
    ]);
    return json({ id, name, deleted: false }, 201);
  }
  if (path[0] === 'projects' && path[2] === 'thumbnail' && path.length === 3) {
    const id = projectId(path[1]);
    if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const input = await body(request, THUMBNAIL_BYTES + 1024);
    const image = input.image;
    if (
      typeof image !== 'string' ||
      image.length > THUMBNAIL_BYTES ||
      !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)
    )
      throw new HttpError(400, 'INVALID_INPUT');
    const result = await db
      .prepare('UPDATE projects SET thumbnail=? WHERE id=? AND host_id=? AND created_by=?')
      .bind(image, id, row.id, row.user_id)
      .run();
    if (!result.meta.changes) throw new HttpError(404, 'PROJECT_NOT_FOUND');
    return json({ ok: true });
  }
  if (path[0] === 'self' && path.length === 1 && request.method === 'DELETE') {
    await db.prepare('DELETE FROM remote_hosts WHERE id=?').bind(row.id).run();
    return json({ removed: true });
  }
  throw new HttpError(404, 'NOT_FOUND');
}

export function hostView(row: HostRow, now = Date.now()) {
  let status: unknown = {};
  try {
    status = JSON.parse(row.status ?? '{}');
  } catch {
    /* Status is advisory display data. */
  }
  const on = online(row, now);
  return {
    id: row.id,
    name: row.name,
    online: on,
    remote: on && !!row.url,
    local: on ? row.local_url : null,
    lastSeen: row.last_seen || null,
    status,
  };
}

/** Owner calls from a signed-in browser: list PCs, open one, remove one. */
export async function hostRoute(request: Request, env: Env, actor: Actor, path: string[]) {
  const db = env.DB;
  if (path.length === 0 && request.method === 'GET') {
    const rows = await db
      .prepare('SELECT * FROM remote_hosts WHERE user_id=? ORDER BY created_at LIMIT 20')
      .bind(actor.id)
      .all<HostRow>();
    const now = Date.now();
    return json({ hosts: rows.results.map((row) => hostView(row, now)) });
  }
  const row = path[0]
    ? await db
        .prepare('SELECT * FROM remote_hosts WHERE id=? AND user_id=?')
        .bind(path[0], actor.id)
        .first<HostRow>()
    : null;
  if (!row) throw new HttpError(404, 'HOST_NOT_FOUND');
  if (path.length === 1 && request.method === 'DELETE') {
    await db.batch([
      db.prepare('UPDATE projects SET host_id=NULL WHERE host_id=?').bind(row.id),
      db.prepare('DELETE FROM remote_hosts WHERE id=?').bind(row.id),
    ]);
    return json({ removed: true });
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED');
}
