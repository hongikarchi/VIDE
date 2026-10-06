import type { Env } from './auth';
import { HttpError, body, json } from './http';
import { membership } from './projects';
import { isDate, journalTitle, NOTE_KINDS, type NoteKind } from '../contracts/note-doc.ts';

// SPEC-10, ADR-034: shared project notes. Every project member (any role) reads and edits; the
// creator or the project owner deletes. The same routes serve a signed-in browser
// (`/api/projects/:id/notes…`) and a linked work PC with its host key
// (`/api/hosts/device/projects/:id/notes…`, acting as the PC's account). Live editing goes through
// `GET /api/notes/socket?t=<ticket>` to the note's Durable Object; the ticket is a one-minute
// HMAC (site secret) naming the account, project and note, issued after the membership check, so
// the socket needs neither a cookie nor a header (a PC's WebSocket cannot send one).
const TICKET_MS = 60_000;
const TITLE_MAX = 200;
const APPEND_MAX = 4000;

interface NoteRow {
  id: string;
  project_id: string;
  title: string;
  kind: NoteKind;
  journal_date: string | null;
  snapshot?: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  updated_by: string | null;
  updated_by_name?: string | null;
  revision: number;
  deleted_at: number | null;
}
const view = (row: NoteRow, full = false) => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  kind: row.kind,
  journalDate: row.journal_date,
  createdAt: row.created_at,
  createdBy: row.created_by,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
  updatedByName: row.updated_by_name ?? null,
  revision: row.revision,
  ...(row.deleted_at ? { deleted: true } : {}),
  ...(full
    ? { snapshot: row.snapshot ?? '' }
    : { excerpt: (row.snapshot ?? '').replace(/\s+/g, ' ').slice(0, 160) }),
});

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
async function sign(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('note:' + value)));
}
const b64url = (value: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const unb64url = (value: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
  );

export async function noteTicket(env: Env, user: string, project: string, note: string) {
  const payload = b64url(
    JSON.stringify({ u: user, p: project, n: note, e: Date.now() + TICKET_MS }),
  );
  return payload + '.' + (await sign(env.AUTH_SECRET, payload));
}
async function readTicket(env: Env, ticket: string | null) {
  const [payload, signature] = (ticket ?? '').split('.');
  if (!payload || !signature || signature !== (await sign(env.AUTH_SECRET, payload)))
    throw new HttpError(401, 'TICKET_INVALID');
  let value: { u?: unknown; p?: unknown; n?: unknown; e?: unknown };
  try {
    value = JSON.parse(unb64url(payload));
  } catch {
    throw new HttpError(401, 'TICKET_INVALID');
  }
  if (
    typeof value.u !== 'string' ||
    typeof value.p !== 'string' ||
    typeof value.n !== 'string' ||
    typeof value.e !== 'number' ||
    value.e < Date.now()
  )
    throw new HttpError(401, 'TICKET_INVALID');
  return { user: value.u, project: value.p, note: value.n };
}

const room = (env: Env, project: string, note: string, user = '') => {
  if (!env.NOTES) throw new HttpError(503, 'NOTES_NOT_CONFIGURED');
  const stub = env.NOTES.get(env.NOTES.idFromName(`${project}:${note}`));
  const headers = { 'X-Note-Project': project, 'X-Note-Id': note, 'X-Note-User': user };
  return { stub, headers };
};

/** `GET /api/notes/socket?t=<ticket>`: the live editing socket of one note. */
export async function noteSocket(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') throw new HttpError(426, 'UPGRADE_REQUIRED');
  const ticket = await readTicket(env, new URL(request.url).searchParams.get('t'));
  // Membership and the note are checked again: a removed member's old ticket opens nothing.
  await membership(env.DB, ticket.project, ticket.user);
  await note(env.DB, ticket.project, ticket.note);
  const { stub, headers } = room(env, ticket.project, ticket.note, ticket.user);
  const forwarded = new Headers(request.headers);
  for (const [key, value] of Object.entries(headers)) forwarded.set(key, value);
  return stub.fetch('https://note/socket', { headers: forwarded });
}

async function note(db: D1Database, project: string, id: string) {
  const row = await db
    .prepare(
      'SELECT n.*,u.name AS updated_by_name FROM notes n LEFT JOIN user u ON u.id=n.updated_by WHERE n.id=? AND n.project_id=? AND n.deleted_at IS NULL',
    )
    .bind(id, project)
    .first<NoteRow>();
  if (!row) throw new HttpError(404, 'NOTE_NOT_FOUND');
  return row;
}
function kindOf(value: unknown, fallback: NoteKind = 'note'): NoteKind {
  if (value === undefined) return fallback;
  if (value === 'journal' || !NOTE_KINDS.includes(value as NoteKind))
    throw new HttpError(400, 'INVALID_KIND');
  return value as NoteKind;
}
function titleOf(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > TITLE_MAX)
    throw new HttpError(400, 'INVALID_INPUT');
  return value.trim() || fallback;
}

async function journal(env: Env, user: string, project: string, date: unknown) {
  if (!isDate(date)) throw new HttpError(400, 'INVALID_DATE');
  const now = Date.now();
  // The partial unique index keeps one entry a day when two members press 오늘 together.
  await env.DB.prepare(
    `INSERT INTO notes(id,project_id,title,kind,journal_date,created_by,created_at,updated_at,updated_by)
     VALUES(?,?,?,'journal',?,?,?,?,?) ON CONFLICT DO NOTHING`,
  )
    .bind(crypto.randomUUID(), project, journalTitle(date), date, user, now, now, user)
    .run();
  const row = await env.DB.prepare(
    "SELECT * FROM notes WHERE project_id=? AND kind='journal' AND journal_date=? AND deleted_at IS NULL",
  )
    .bind(project, date)
    .first<NoteRow>();
  if (!row) throw new HttpError(409, 'JOURNAL_CONFLICT');
  return row;
}
async function append(env: Env, user: string, row: NoteRow, text: unknown) {
  if (typeof text !== 'string' || !text.trim() || text.length > APPEND_MAX)
    throw new HttpError(400, 'INVALID_INPUT');
  const { stub, headers } = room(env, row.project_id, row.id, user);
  const response = await stub.fetch('https://note/append', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, user }),
  });
  if (!response.ok) throw new HttpError(500, 'NOTE_APPEND_FAILED');
  return (await response.json()) as { lines: number };
}

/**
 * `…/projects/:id/notes[/…]` for `user` (a browser's account or a work PC's account). `path` is
 * what follows `notes`.
 */
export async function notesRoute(
  request: Request,
  env: Env,
  user: string,
  project: string,
  path: string[],
): Promise<Response> {
  const db = env.DB;
  const role = await membership(db, project, user);
  const method = request.method;
  if (path.length === 0 && method === 'GET') {
    const url = new URL(request.url);
    const since = Number(url.searchParams.get('since') ?? '');
    const full = url.searchParams.get('full') === '1';
    const query = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
    const kind = url.searchParams.get('kind');
    const where = ['n.project_id=?'];
    const binds: unknown[] = [project];
    // A PC refreshing its copy asks for changes since its last look, deletions included.
    if (Number.isFinite(since) && since > 0) {
      where.push('n.updated_at>?');
      binds.push(since);
    } else where.push('n.deleted_at IS NULL');
    if (kind && NOTE_KINDS.includes(kind as NoteKind)) {
      where.push('n.kind=?');
      binds.push(kind);
    }
    if (query) {
      where.push("(n.title LIKE ? ESCAPE '\\' OR n.snapshot LIKE ? ESCAPE '\\')");
      const like = '%' + query.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      binds.push(like, like);
    }
    const rows = await db
      .prepare(
        `SELECT n.*,u.name AS updated_by_name FROM notes n LEFT JOIN user u ON u.id=n.updated_by
         WHERE ${where.join(' AND ')} ORDER BY n.updated_at DESC,n.id LIMIT 1000`,
      )
      .bind(...binds)
      .all<NoteRow>();
    return json({ notes: rows.results.map((row) => view(row, full)), at: Date.now() });
  }
  if (path.length === 0 && method === 'POST') {
    const input = await body(request);
    const now = Date.now(),
      id = crypto.randomUUID(),
      kind = kindOf(input.kind),
      title = titleOf(input.title, kind === 'discussion' ? '협의 사항' : '제목 없음');
    await db
      .prepare(
        'INSERT INTO notes(id,project_id,title,kind,created_by,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(id, project, title, kind, user, now, now, user)
      .run();
    return json(view(await note(db, project, id), true), 201);
  }
  if (path[0] === 'journal' && path.length === 1 && method === 'POST') {
    const input = await body(request);
    return json(view(await journal(env, user, project, input.date), true));
  }
  if (path[0] === 'journal' && path[1] === 'append' && path.length === 2 && method === 'POST') {
    // The day's summary from VIDE's [퇴근하기] goes to that day's entry (made if missing).
    const input = await body(request, APPEND_MAX * 4 + 1024);
    const row = await journal(env, user, project, input.date);
    const result = await append(env, user, row, input.text);
    return json({ id: row.id, ...result });
  }
  const row = await note(db, project, path[0]);
  if (path.length === 1 && method === 'GET') return json(view(row, true));
  if (path.length === 1 && method === 'PATCH') {
    const input = await body(request);
    const title = titleOf(input.title, row.title);
    const kind = row.kind === 'journal' ? 'journal' : kindOf(input.kind, row.kind);
    await db
      .prepare('UPDATE notes SET title=?,kind=?,updated_at=?,updated_by=? WHERE id=?')
      .bind(title, kind, Date.now(), user, row.id)
      .run();
    return json(view(await note(db, project, row.id), true));
  }
  if (path.length === 1 && method === 'DELETE') {
    if (row.created_by !== user && role !== 'owner')
      throw new HttpError(403, 'NOTE_OWNER_REQUIRED');
    await db
      .prepare('UPDATE notes SET deleted_at=?,updated_at=? WHERE id=?')
      .bind(Date.now(), Date.now(), row.id)
      .run();
    return json({ deleted: true });
  }
  if (path[1] === 'ticket' && path.length === 2 && method === 'POST') {
    if (!env.NOTES) throw new HttpError(503, 'NOTES_NOT_CONFIGURED');
    const ticket = await noteTicket(env, user, project, row.id);
    return json({ ticket, url: '/api/notes/socket?t=' + encodeURIComponent(ticket) });
  }
  if (path[1] === 'append' && path.length === 2 && method === 'POST') {
    const input = await body(request, APPEND_MAX * 4 + 1024);
    return json(await append(env, user, row, input.text));
  }
  throw new HttpError(404, 'NOT_FOUND');
}
