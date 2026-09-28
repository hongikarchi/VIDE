import { HttpError, body, digest, json, text } from './http';
import type { Env } from './auth';
import type { Actor } from './projects';

// Remote hosts: a desktop VIDE (with Rhino/CAD attached) pairs once, then reports its temporary
// tunnel address by heartbeat. The owner opens it from any device with a one-minute signed token
// that only that desktop can verify. The desktop does all work; this Worker only relays presence.
const ONLINE_MS = 45_000;
const TOKEN_MS = 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface HostRow {
  id: string;
  user_id: string;
  name: string;
  secret: string;
  url: string | null;
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
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 200) throw new HttpError(400, 'INVALID_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'INVALID_URL');
  }
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new HttpError(400, 'INVALID_URL');
  return url.origin;
}
const online = (row: HostRow, now = Date.now()) => !!row.url && now - row.last_seen < ONLINE_MS;

/** Desktop-to-Worker calls: pairing by one-time code, heartbeat by host key. No browser session. */
export async function hostDeviceRoute(request: Request, env: Env, pathname: string) {
  if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
  const db = env.DB;
  if (pathname === '/api/hosts/pair') {
    const input = await body(request);
    const code = text(input.code, 20)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, ''),
      name = text(input.name, 80);
    const pairing = await db
      .prepare('SELECT user_id,expires_at FROM remote_host_pairings WHERE code_hash=?')
      .bind(await digest(code))
      .first<{ user_id: string; expires_at: number }>();
    if (!pairing || pairing.expires_at < Date.now()) throw new HttpError(404, 'PAIRING_NOT_FOUND');
    const id = crypto.randomUUID(),
      secret = random(32);
    await db.batch([
      db.prepare('DELETE FROM remote_host_pairings WHERE code_hash=?').bind(await digest(code)),
      db
        .prepare('INSERT INTO remote_hosts(id,user_id,name,secret,created_at) VALUES(?,?,?,?,?)')
        .bind(id, pairing.user_id, name, secret, Date.now()),
    ]);
    return json({ hostId: id, secret }, 201);
  }
  if (pathname === '/api/hosts/heartbeat') {
    const [id, secret] = (request.headers.get('Authorization') ?? '')
      .replace(/^Bearer /, '')
      .split('.');
    const row = id
      ? await db.prepare('SELECT * FROM remote_hosts WHERE id=?').bind(id).first<HostRow>()
      : null;
    // Compare digests so the check does not depend on where the strings first differ.
    if (!row || !secret || (await digest(secret)) !== (await digest(row.secret)))
      throw new HttpError(401, 'HOST_UNAUTHORIZED');
    const input = await body(request),
      url = tunnelUrl(input.url);
    const status = JSON.stringify(input.status ?? {});
    if (status.length > 8192) throw new HttpError(413, 'INPUT_TOO_LARGE');
    await db
      .prepare('UPDATE remote_hosts SET url=?,status=?,last_seen=? WHERE id=?')
      .bind(url, status, url ? Date.now() : 0, id)
      .run();
    return json({ ok: true });
  }
  throw new HttpError(404, 'NOT_FOUND');
}

/** Owner calls from a signed-in browser: list hosts, create a pairing code, open, remove. */
export async function hostRoute(request: Request, env: Env, actor: Actor, path: string[]) {
  const db = env.DB;
  if (path.length === 0 && request.method === 'GET') {
    const rows = await db
      .prepare('SELECT * FROM remote_hosts WHERE user_id=? ORDER BY created_at LIMIT 20')
      .bind(actor.id)
      .all<HostRow>();
    const now = Date.now();
    return json({
      hosts: rows.results.map((row) => {
        let status: unknown = {};
        try {
          status = JSON.parse(row.status ?? '{}');
        } catch {
          /* Status is advisory display data. */
        }
        return {
          id: row.id,
          name: row.name,
          online: online(row, now),
          lastSeen: row.last_seen || null,
          status,
        };
      }),
    });
  }
  if (path.length === 1 && path[0] === 'pairings' && request.method === 'POST') {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const code = Array.from(bytes, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
    const expiresAt = Date.now() + 10 * 60_000;
    await db
      .prepare('INSERT INTO remote_host_pairings(code_hash,user_id,expires_at) VALUES(?,?,?)')
      .bind(await digest(code), actor.id, expiresAt)
      .run();
    return json({ code, expiresAt }, 201);
  }
  const row = path[0]
    ? await db
        .prepare('SELECT * FROM remote_hosts WHERE id=? AND user_id=?')
        .bind(path[0], actor.id)
        .first<HostRow>()
    : null;
  if (!row) throw new HttpError(404, 'HOST_NOT_FOUND');
  if (path.length === 2 && path[1] === 'open' && request.method === 'POST') {
    if (!online(row)) throw new HttpError(409, 'HOST_OFFLINE');
    const payload = base64url(
      JSON.stringify({ h: row.id, n: random(16), e: Date.now() + TOKEN_MS }),
    );
    const token = payload + '.' + (await hmac(row.secret, payload));
    return json({ url: `${row.url}/#r=${token}` });
  }
  if (path.length === 1 && request.method === 'DELETE') {
    await db.prepare('DELETE FROM remote_hosts WHERE id=?').bind(row.id).run();
    return json({ removed: true });
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED');
}
