import type { Env } from './auth';
import { HttpError, body, digest, json, text } from './http';
import { membership } from './projects';
import type { HostRow } from './hosts';
import { PROXIED } from './pc-proxy';

// 보고용 게시 — VIDE 공유 사이트의 비밀번호 링크 (SPEC-04.14, PLAN-54 T-343, SPEC-07.11 공유 경로).
// A work PC (host key) uploads a 보고용 folder's page and CSVs to R2 under
// `reports/<id>/<version>/<file>`; anyone with the link `/r/<id>/` sees a password form, and the
// right password gives a cookie for that publication only (the same HMAC cookie scheme as the
// Cloudflare template, src/sharing/deploy-templates/password-site/worker.js). The site keeps only
// a salted PBKDF2 hash of the password. [내리기] deletes the files and the link answers 404.
//
// Device routes (JSON, so the PC's `deviceFetch` carries them; big files go in parts):
//   POST   report-publications {projectId, title, password?, id?}   start (id = 다시 게시)
//   PUT    report-publications/:id/files {path, data(base64), part?, parts?, uploadId?, etags?}
//   POST   report-publications/:id/finish                          switch the link to the upload
//   GET    report-publications/:id                                  state
//   DELETE report-publications/:id                                  [내리기]

const SESSION_SECONDS = 8 * 60 * 60;
const PBKDF2_ITERATIONS = 100_000;
/** One R2 part (all parts but the last must be ≥ 5 MiB); the PC sends files in these pieces. */
export const REPORT_PART_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_PARTS = 40;
const FILE_NAME = /^(?!\.{1,2}$)[^/\\<>:"|?*\u0000-\u001f]{1,120}$/;
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
const ID = /^[0-9a-f]{32}$/;

interface PublicationRow {
  id: string;
  project_id: string;
  user_id: string;
  title: string;
  password_hash: string;
  password_salt: string;
  session_secret: string;
  r2_prefix: string | null;
  pending_prefix: string | null;
  file_count: number;
  created_at: number;
  published_at: number | null;
  revoked_at: number | null;
  published_by_host: string;
}

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
const random = (length: number) => hex(crypto.getRandomValues(new Uint8Array(length)));
async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password.normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return hex(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: encoder.encode(salt),
        iterations: PBKDF2_ITERATIONS,
      },
      key,
      256,
    ),
  );
}
function equalText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function password(value: unknown) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128)
    throw new HttpError(400, 'INVALID_PASSWORD');
  return value;
}
function fileName(value: unknown) {
  if (typeof value !== 'string' || !FILE_NAME.test(value)) throw new HttpError(400, 'INVALID_FILE');
  const ext = /\.([A-Za-z0-9]+)$/.exec(value)?.[1]?.toLowerCase();
  if (!ext || !TYPES[ext]) throw new HttpError(400, 'INVALID_FILE');
  return value;
}
const typeOf = (name: string) =>
  TYPES[/\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''] ?? 'application/octet-stream';
const decode = (value: unknown) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new HttpError(400, 'INVALID_INPUT');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
const linkOf = (env: Env, id: string) => `${env.AUTH_ORIGIN}/r/${id}/`;

async function deleteAll(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function ownedRow(env: Env, host: HostRow, id: string) {
  if (!ID.test(id)) throw new HttpError(404, 'PUBLICATION_NOT_FOUND');
  const row = await env.DB.prepare('SELECT * FROM report_publications WHERE id=?')
    .bind(id)
    .first<PublicationRow>();
  if (!row || row.user_id !== host.user_id) throw new HttpError(404, 'PUBLICATION_NOT_FOUND');
  return row;
}
const view = (env: Env, row: PublicationRow) => ({
  id: row.id,
  url: linkOf(env, row.id),
  title: row.title,
  publishedAt: row.published_at,
  revokedAt: row.revoked_at,
  fileCount: row.file_count,
});

/** The work PC's host key (`Bearer <hostId>.<secret>`), checked as hosts.ts does. */
async function deviceHost(request: Request, db: D1Database) {
  const [id, secret] = (request.headers.get('Authorization') ?? '')
    .replace(/^Bearer /, '')
    .split('.');
  const row = id
    ? await db.prepare('SELECT * FROM remote_hosts WHERE id=?').bind(id).first<HostRow>()
    : null;
  if (!row || !secret || (await digest(secret)) !== (await digest(row.secret)))
    throw new HttpError(401, 'HOST_UNAUTHORIZED');
  return row;
}

/** `/api/hosts/device/report-publications…` for a work PC; `path` is after that prefix. */
export async function reportPublicationDeviceRoute(
  request: Request,
  env: Env,
  path: string[],
): Promise<Response> {
  const db = env.DB;
  const host = await deviceHost(request, db);
  const uploadsPaused = env.UPLOADS_ENABLED === 'false';
  if (path.length === 0 && request.method === 'POST') {
    if (uploadsPaused) throw new HttpError(503, 'UPLOADS_DISABLED');
    const input = await body(request);
    const projectId = text(input.projectId, 64);
    // Only the project's owner account publishes (SPEC-04.14 2).
    if ((await membership(db, projectId, host.user_id)) !== 'owner')
      throw new HttpError(403, 'OWNER_REQUIRED');
    const title = text(input.title, 200);
    const version = random(8);
    if (input.id !== undefined && input.id !== null) {
      // 다시 게시: the same link; the old files stay open until finish; password kept if omitted.
      const row = await ownedRow(env, host, String(input.id));
      if (row.project_id !== projectId || row.revoked_at)
        throw new HttpError(404, 'PUBLICATION_NOT_FOUND');
      if (row.pending_prefix && row.pending_prefix !== row.r2_prefix)
        await deleteAll(env.ASSETS, row.pending_prefix + '/');
      const pending = `reports/${row.id}/${version}`;
      if (input.password !== undefined) {
        const salt = random(16);
        await db
          .prepare(
            'UPDATE report_publications SET title=?,pending_prefix=?,password_hash=?,password_salt=?,session_secret=?,published_by_host=? WHERE id=?',
          )
          .bind(
            title,
            pending,
            await passwordHash(password(input.password), salt),
            salt,
            random(32),
            host.id,
            row.id,
          )
          .run();
      } else
        await db
          .prepare(
            'UPDATE report_publications SET title=?,pending_prefix=?,published_by_host=? WHERE id=?',
          )
          .bind(title, pending, host.id, row.id)
          .run();
      return json({ id: row.id, url: linkOf(env, row.id), partBytes: REPORT_PART_BYTES });
    }
    const typed = password(input.password);
    const id = random(16),
      salt = random(16);
    await db
      .prepare(
        `INSERT INTO report_publications(id,project_id,user_id,title,password_hash,password_salt,
        session_secret,pending_prefix,created_at,published_by_host) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        id,
        projectId,
        host.user_id,
        title,
        await passwordHash(typed, salt),
        salt,
        random(32),
        `reports/${id}/${version}`,
        Date.now(),
        host.id,
      )
      .run();
    return json({ id, url: linkOf(env, id), partBytes: REPORT_PART_BYTES }, 201);
  }
  const row = await ownedRow(env, host, path[0] ?? '');
  if (path.length === 1 && request.method === 'GET') return json(view(env, row));
  if (path.length === 1 && request.method === 'DELETE') {
    if (row.revoked_at) return json({ removed: false, ...view(env, row) });
    await deleteAll(env.ASSETS, `reports/${row.id}/`);
    const now = Date.now();
    await db
      .prepare(
        'UPDATE report_publications SET revoked_at=?,r2_prefix=NULL,pending_prefix=NULL,file_count=0 WHERE id=?',
      )
      .bind(now, row.id)
      .run();
    return json({ removed: true, ...view(env, { ...row, revoked_at: now, file_count: 0 }) });
  }
  if (row.revoked_at || !row.pending_prefix) throw new HttpError(409, 'PUBLICATION_NOT_UPLOADING');
  if (uploadsPaused) throw new HttpError(503, 'UPLOADS_DISABLED');
  if (path[1] === 'files' && path.length === 2 && request.method === 'PUT') {
    // A part in base64 is 4/3 of its size, plus the JSON around it.
    const input = await body(request, Math.ceil((REPORT_PART_BYTES * 4) / 3) + 64 * 1024);
    const name = fileName(input.path);
    const bytes = decode(input.data);
    const parts = input.parts === undefined ? 1 : Number(input.parts);
    const part = input.part === undefined ? 1 : Number(input.part);
    if (
      !Number.isInteger(parts) ||
      !Number.isInteger(part) ||
      parts < 1 ||
      parts > MAX_PARTS ||
      part < 1 ||
      part > parts ||
      bytes.byteLength > REPORT_PART_BYTES
    )
      throw new HttpError(400, 'INVALID_INPUT');
    const key = `${row.pending_prefix}/${name}`;
    const metadata = { httpMetadata: { contentType: typeOf(name) } };
    if (parts === 1) {
      await env.ASSETS.put(key, bytes, metadata);
      return json({ stored: true });
    }
    if (part === 1) {
      const upload = await env.ASSETS.createMultipartUpload(key, metadata);
      const uploaded = await upload.uploadPart(1, bytes);
      return json({ uploadId: upload.uploadId, etag: uploaded.etag });
    }
    if (typeof input.uploadId !== 'string' || input.uploadId.length > 1024)
      throw new HttpError(400, 'INVALID_INPUT');
    const upload = env.ASSETS.resumeMultipartUpload(key, input.uploadId);
    const uploaded = await upload.uploadPart(part, bytes);
    if (part < parts) return json({ etag: uploaded.etag });
    // The last part: the PC sends the earlier parts' etags in order.
    const earlier = input.etags;
    if (
      !Array.isArray(earlier) ||
      earlier.length !== parts - 1 ||
      earlier.some((e) => typeof e !== 'string' || e.length > 256)
    )
      throw new HttpError(400, 'INVALID_INPUT');
    await upload.complete([
      ...(earlier as string[]).map((etag, i) => ({ partNumber: i + 1, etag })),
      { partNumber: part, etag: uploaded.etag },
    ]);
    return json({ stored: true });
  }
  if (path[1] === 'finish' && path.length === 2 && request.method === 'POST') {
    const pending = row.pending_prefix;
    const listed = await env.ASSETS.list({ prefix: pending + '/', limit: MAX_FILES + 1 });
    const total = listed.objects.reduce((sum, o) => sum + o.size, 0);
    if (listed.objects.length > MAX_FILES || listed.truncated || total > MAX_TOTAL_BYTES) {
      await deleteAll(env.ASSETS, pending + '/');
      throw new HttpError(413, 'PUBLICATION_LIMIT');
    }
    if (!listed.objects.some((o) => o.key === `${pending}/index.html`))
      throw new HttpError(400, 'INDEX_REQUIRED');
    const now = Date.now();
    await db
      .prepare(
        'UPDATE report_publications SET r2_prefix=?,pending_prefix=NULL,file_count=?,published_at=? WHERE id=?',
      )
      .bind(pending, listed.objects.length, now, row.id)
      .run();
    // The previous version of a 다시 게시 goes once the link points at the new one.
    if (row.r2_prefix && row.r2_prefix !== pending)
      await deleteAll(env.ASSETS, row.r2_prefix + '/');
    return json(
      view(env, {
        ...row,
        r2_prefix: pending,
        pending_prefix: null,
        file_count: listed.objects.length,
        published_at: now,
      }),
    );
  }
  throw new HttpError(404, 'NOT_FOUND');
}

// --- the public link -------------------------------------------------------------------------

const cookieName = (id: string) => `__Host-vr-${id}`;
function privateHeaders(headers: Headers) {
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  // The page is the 보고용 report itself (inline styles, data images, no scripts); the site's own
  // policy (worker.ts) would block its styles, so these answers keep this one.
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  headers.set(PROXIED, '1');
  return headers;
}
function plain(status: number, message: string) {
  return new Response(message, {
    status,
    headers: privateHeaders(new Headers({ 'Content-Type': 'text/plain; charset=utf-8' })),
  });
}
const notFound = () => plain(404, '이 주소에는 게시된 보고서가 없습니다.');
function redirect(location: string, cookie?: string) {
  const headers = privateHeaders(new Headers({ Location: location }));
  if (cookie) headers.set('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
function loginPage(row: PublicationRow, status: number, message: string) {
  const notice = message ? `<p class="error" role="alert">${message}</p>` : '';
  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>비밀번호 확인</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f5f2;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1f1f1f; }
  form { width: min(320px, calc(100vw - 32px)); display: grid; gap: 12px; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  .title { margin: 0; color: #5f5d58; font-size: 14px; }
  input { font: inherit; padding: 10px 12px; border: 1px solid #c9c6bf; border-radius: 6px; }
  button { font: inherit; padding: 10px 12px; border: 0; border-radius: 6px; background: #1f1f1f;
    color: #fff; cursor: pointer; }
  .error { margin: 0; color: #b42318; font-size: 14px; }
</style>
</head>
<body>
<form method="post" action="/r/${row.id}/login">
  <h1>비밀번호를 입력하세요</h1>
  <p class="title">${escapeHtml(row.title)}</p>
  ${notice}
  <input type="password" name="password" autocomplete="current-password" aria-label="비밀번호" required autofocus>
  <button type="submit">열기</button>
</form>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: privateHeaders(new Headers({ 'Content-Type': 'text/html; charset=utf-8' })),
  });
}
async function validSession(request: Request, row: PublicationRow) {
  const name = cookieName(row.id) + '=';
  const match = (request.headers.get('Cookie') ?? '')
    .split(/;\s*/)
    .find((part) => part.startsWith(name));
  if (!match) return false;
  const [expires, signature] = match.slice(name.length).split('.');
  if (!/^\d{1,16}$/.test(expires ?? '') || !/^[0-9a-f]{64}$/.test(signature ?? '')) return false;
  if (Number(expires) <= Date.now()) return false;
  return equalText(signature, await hmac(row.session_secret, `${row.id}.${expires}`));
}

/** `/r/<id>[/…]`: the password form, the login and the published files. Undefined = not ours. */
export async function reportPublicationPublicRoute(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | undefined> {
  const match = /^\/r\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return undefined;
  const [, id, rest] = match;
  if (!ID.test(id)) return notFound();
  const row = await env.DB.prepare('SELECT * FROM report_publications WHERE id=?')
    .bind(id)
    .first<PublicationRow>();
  if (!row || row.revoked_at || !row.r2_prefix) return notFound();
  if (rest === undefined) return redirect(`/r/${id}/`);
  if (rest === '/login') {
    if (request.method !== 'POST') return redirect(`/r/${id}/`);
    // Same-origin form posts only (a page elsewhere cannot try passwords through a visitor).
    const origin = request.headers.get('Origin');
    if (origin && origin !== env.AUTH_ORIGIN)
      return plain(403, '이 주소의 로그인 화면에서만 들어올 수 있습니다.');
    let typed = '';
    try {
      typed = String((await request.formData()).get('password') ?? '');
    } catch {
      return loginPage(row, 400, '다시 입력해 주세요.');
    }
    if (
      typed.length > 256 ||
      !equalText(await passwordHash(typed, row.password_salt), row.password_hash)
    )
      return loginPage(row, 401, '비밀번호가 맞지 않습니다.');
    const expires = String(Date.now() + SESSION_SECONDS * 1000);
    const signature = await hmac(row.session_secret, `${row.id}.${expires}`);
    return redirect(
      `/r/${id}/`,
      `${cookieName(id)}=${expires}.${signature}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
  }
  if (rest === '/logout')
    return redirect(
      `/r/${id}/`,
      `${cookieName(id)}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return plain(405, '읽기만 할 수 있습니다.');
  if (!(await validSession(request, row))) return loginPage(row, 401, '');
  let file: string;
  try {
    file = rest === '/' ? 'index.html' : decodeURIComponent(rest.slice(1));
  } catch {
    return notFound();
  }
  if (!FILE_NAME.test(file)) return notFound();
  const object = await env.ASSETS.get(`${row.r2_prefix}/${file}`);
  if (!object) return notFound();
  const headers = privateHeaders(new Headers({ 'Content-Type': typeOf(file) }));
  if (file.toLowerCase().endsWith('.csv'))
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file)}`);
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}
