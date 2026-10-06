import type { Env } from './auth';
import { HttpError, body, json } from './http';
import type { HostRow } from './hosts';
import { membership } from './projects';
import { displayName } from './accounts';
import {
  chunkText,
  MIRROR_PREVIEW_CHARS,
  mirrorConversationSchema,
  mirrorDocSchema,
  mirrorUploadSchema,
  type MirrorDoc,
} from '../contracts/conversation-mirror.ts';

// PLAN-36 (ADR-037 4, SPEC-04.12): conversation records mirrored from the PC that ran them. The
// origin PC uploads its hostless requests (request text, full answer, activity lines, executed
// code, file names) as text with its host key; every project member reads them on the site and
// through their own PC. A PC replaces and removes only its own rows. A request's document is
// stored in chunks under D1's row limit and never cut short (ADR-031).

/** One upload call: the PC sends its batches well below this (conversation-mirror.ts sends about 1 MB and 8 requests a call). */
const UPLOAD_BYTES = 24 * 1024 * 1024;
const UPLOAD_REQUESTS_MAX = 200;
const SEARCH_MAX = 200;

const invalid = (): never => {
  throw new HttpError(400, 'INVALID_INPUT');
};
const projectIdOf = (value: string) => (/^[A-Za-z0-9-]{8,64}$/.test(value) ? value : invalid());
const segment = (value: string | undefined) =>
  value && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : invalid();

interface ConversationRow {
  project_id: string;
  origin_host: string;
  id: string;
  title: string;
  kind: string;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  user_email: string | null;
  user_name: string | null;
  host_name: string | null;
  requests: number;
  last_at: string | null;
}
interface RequestRow {
  id: string;
  origin_host: string;
  conversation_id: string;
  state: string;
  created_at: string;
  ended_at: string | null;
  files: string;
  preview: string;
  revision: number;
  stored_at: number;
}
const originName = (row: { user_email: string | null; user_name: string | null }) =>
  row.user_email ? displayName(row.user_email, row.user_name ?? '') : '알 수 없는 계정';
const conversationView = (row: ConversationRow) => ({
  id: row.id,
  title: row.title,
  kind: row.kind,
  provider: row.provider,
  model: row.model,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  originHost: row.origin_host,
  originName: originName(row),
  originPc: row.host_name,
  requests: row.requests,
  lastAt: row.last_at,
});

/** Conversations of the project with their origin (a hostless request at least, or a row). */
async function conversations(db: D1Database, project: string, exceptHost?: string) {
  const rows = await db
    .prepare(
      `SELECT c.*,u.email AS user_email,u.name AS user_name,h.name AS host_name,
        (SELECT COUNT(*) FROM shared_requests r WHERE r.project_id=c.project_id AND r.origin_host=c.origin_host AND r.conversation_id=c.id) AS requests,
        (SELECT MAX(created_at) FROM shared_requests r WHERE r.project_id=c.project_id AND r.origin_host=c.origin_host AND r.conversation_id=c.id) AS last_at
       FROM shared_conversations c LEFT JOIN user u ON u.id=c.origin_user
       LEFT JOIN remote_hosts h ON h.id=c.origin_host
       WHERE c.project_id=? AND c.origin_host!=? ORDER BY COALESCE(last_at,c.updated_at) DESC LIMIT 2000`,
    )
    .bind(project, exceptHost ?? '')
    .all<ConversationRow>();
  return rows.results.map(conversationView);
}
/** The documents of these requests, joined from their chunks. */
async function documents(db: D1Database, project: string, ids: string[]) {
  const docs = new Map<string, MirrorDoc>();
  // A bounded IN list per query (D1 binds at most 100 values).
  for (let at = 0; at < ids.length; at += 90) {
    const part = ids.slice(at, at + 90);
    const rows = await db
      .prepare(
        `SELECT request_id,seq,text FROM shared_request_chunks WHERE project_id=? AND request_id IN (${part.map(() => '?').join(',')}) ORDER BY request_id,seq`,
      )
      .bind(project, ...part)
      .all<{ request_id: string; seq: number; text: string }>();
    const texts = new Map<string, string[]>();
    for (const row of rows.results) {
      const list = texts.get(row.request_id) ?? [];
      list.push(row.text);
      texts.set(row.request_id, list);
    }
    for (const [id, list] of texts) {
      try {
        const parsed = mirrorDocSchema.safeParse(JSON.parse(list.join('')));
        if (parsed.success) docs.set(id, parsed.data);
      } catch {
        /* A document whose chunks are being replaced reads on the next call. */
      }
    }
  }
  return docs;
}
const requestMeta = (row: RequestRow) => ({
  id: row.id,
  conversationId: row.conversation_id,
  originHost: row.origin_host,
  state: row.state,
  createdAt: row.created_at,
  endedAt: row.ended_at,
  revision: row.revision,
  files: JSON.parse(row.files) as string[],
  preview: row.preview,
  storedAt: row.stored_at,
});
async function thread(db: D1Database, project: string, host: string, conversation: string) {
  const list = await conversations(db, project);
  const found = list.find((row) => row.originHost === host && row.id === conversation);
  if (!found) throw new HttpError(404, 'CONVERSATION_NOT_FOUND');
  const rows = await db
    .prepare(
      'SELECT * FROM shared_requests WHERE project_id=? AND origin_host=? AND conversation_id=? ORDER BY created_at,id',
    )
    .bind(project, host, conversation)
    .all<RequestRow>();
  const docs = await documents(
    db,
    project,
    rows.results.map((row) => row.id),
  );
  return {
    conversation: found,
    requests: rows.results.map((row) => {
      const { preview: _preview, storedAt: _storedAt, ...meta } = requestMeta(row);
      const doc = docs.get(row.id) ?? {
        body: row.preview,
        answer: null,
        activity: [],
        executions: [],
        files: meta.files,
      };
      return { ...meta, ...doc };
    }),
  };
}

/**
 * Member calls (browser `…/projects/:id/conversations…`): the list (`?q=` searches the text), and
 * one conversation (`…/conversations/:originHost/:conversationId`) with every request in full.
 */
export async function conversationsRoute(
  request: Request,
  env: Env,
  user: string,
  project: string,
  path: string[],
): Promise<Response> {
  const db = env.DB;
  await membership(db, project, user);
  if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
  if (path.length === 0) {
    const query = (new URL(request.url).searchParams.get('q') ?? '').trim().slice(0, 200);
    const list = await conversations(db, project);
    if (!query) return json({ conversations: list });
    const like = '%' + query.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    // A match inside a request's text (its chunks) or a conversation's title.
    const rows = await db
      .prepare(
        `SELECT r.* FROM shared_requests r WHERE r.project_id=? AND (
          r.id IN (SELECT DISTINCT request_id FROM shared_request_chunks WHERE project_id=? AND text LIKE ? ESCAPE '\\')
          OR EXISTS(SELECT 1 FROM shared_conversations c WHERE c.project_id=r.project_id AND c.origin_host=r.origin_host AND c.id=r.conversation_id AND c.title LIKE ? ESCAPE '\\'))
         ORDER BY r.created_at DESC LIMIT ${SEARCH_MAX}`,
      )
      .bind(project, project, like, like)
      .all<RequestRow>();
    return json({
      conversations: list,
      query,
      matches: rows.results.map((row) => {
        const { storedAt: _storedAt, ...meta } = requestMeta(row);
        return meta;
      }),
    });
  }
  if (path.length === 2) return json(await thread(db, project, segment(path[0]), segment(path[1])));
  throw new HttpError(404, 'NOT_FOUND');
}

/**
 * PC calls (`/api/hosts/device/projects/:id/conversations`): PUT stores this PC's conversations
 * and requests (and removes the ones it names), DELETE removes all of this PC's rows of the
 * project (its switch turned off), GET reads the other PCs' records changed since `since`.
 */
export async function conversationsDeviceRoute(
  request: Request,
  env: Env,
  row: HostRow,
  projectParam: string,
): Promise<Response> {
  const db = env.DB;
  const project = projectIdOf(projectParam);
  await membership(db, project, row.user_id);
  const now = Date.now();
  if (request.method === 'DELETE') {
    await db.batch([
      db
        .prepare(
          `DELETE FROM shared_request_chunks WHERE project_id=? AND request_id IN
           (SELECT id FROM shared_requests WHERE project_id=? AND origin_host=?)`,
        )
        .bind(project, project, row.id),
      db
        .prepare('DELETE FROM shared_requests WHERE project_id=? AND origin_host=?')
        .bind(project, row.id),
      db
        .prepare('DELETE FROM shared_conversations WHERE project_id=? AND origin_host=?')
        .bind(project, row.id),
    ]);
    return json({ removed: true });
  }
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const since = Number(url.searchParams.get('since') ?? '0');
    const list = await conversations(db, project, row.id);
    const rows = await db
      .prepare(
        'SELECT * FROM shared_requests WHERE project_id=? AND origin_host!=? ORDER BY created_at,id LIMIT 20000',
      )
      .bind(project, row.id)
      .all<RequestRow>();
    // Every request's metadata (so removed ones leave the PC's copy), documents only when newer.
    const changed = rows.results
      .filter((r) => !(Number.isFinite(since) && since > 0) || r.stored_at > since)
      .map((r) => r.id);
    const docs = await documents(db, project, changed);
    return json({
      at: now,
      conversations: list,
      requests: rows.results.map((r) => {
        const meta = requestMeta(r);
        const doc = docs.get(r.id);
        return doc ? { ...meta, ...doc } : meta;
      }),
    });
  }
  if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
  const input = await body(request, UPLOAD_BYTES);
  const conversationList = Array.isArray(input.conversations) ? input.conversations : invalid();
  const requestList = Array.isArray(input.requests) ? input.requests : invalid();
  const removedInput = input.removed === undefined ? [] : input.removed;
  if (!Array.isArray(removedInput)) invalid();
  const removed = removedInput as unknown[];
  if (
    conversationList.length > UPLOAD_REQUESTS_MAX * 5 ||
    requestList.length > UPLOAD_REQUESTS_MAX ||
    removed.length > 5000
  )
    invalid();
  const convs = conversationList.map(
    (value) => mirrorConversationSchema.safeParse(value).data ?? invalid(),
  );
  const statements: D1PreparedStatement[] = [];
  for (const conversation of convs)
    statements.push(
      db
        .prepare(
          `INSERT INTO shared_conversations(project_id,origin_host,id,origin_user,title,kind,provider,model,created_at,updated_at,stored_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(project_id,origin_host,id) DO UPDATE SET title=excluded.title,kind=excluded.kind,
             provider=excluded.provider,model=excluded.model,updated_at=excluded.updated_at,stored_at=excluded.stored_at`,
        )
        .bind(
          project,
          row.id,
          conversation.id,
          row.user_id,
          conversation.title,
          conversation.kind,
          conversation.provider,
          conversation.model,
          conversation.createdAt,
          conversation.updatedAt,
          now,
        ),
    );
  // Another PC's row with the same id is never replaced.
  const ids = [
    ...requestList.map((value) => (value as { id?: unknown })?.id),
    ...(removed as unknown[]),
  ].map((id) => (typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : invalid()));
  const foreign = new Set<string>();
  for (let at = 0; at < ids.length; at += 90) {
    const part = ids.slice(at, at + 90);
    const rows = await db
      .prepare(
        `SELECT id FROM shared_requests WHERE project_id=? AND origin_host!=? AND id IN (${part.map(() => '?').join(',')})`,
      )
      .bind(project, row.id, ...part)
      .all<{ id: string }>();
    for (const r of rows.results) foreign.add(r.id);
  }
  if (foreign.size) throw new HttpError(409, 'REQUEST_CONFLICT');
  let stored = 0;
  for (const value of requestList) {
    const upload = mirrorUploadSchema.safeParse(value).data ?? invalid();
    let doc: MirrorDoc;
    try {
      // Only the document's own fields are kept (ADR-037 4: no geometry, attachments or pins).
      doc = mirrorDocSchema.parse(JSON.parse(upload.doc));
    } catch {
      return invalid();
    }
    const text = JSON.stringify(doc);
    const chunks = chunkText(text);
    const files = JSON.stringify(doc.files);
    statements.push(
      db
        .prepare('DELETE FROM shared_request_chunks WHERE project_id=? AND request_id=?')
        .bind(project, upload.id),
      db
        .prepare(
          `INSERT INTO shared_requests(project_id,id,origin_host,origin_user,conversation_id,state,created_at,ended_at,files,preview,revision,chunks,size,stored_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(project_id,id) DO UPDATE SET conversation_id=excluded.conversation_id,state=excluded.state,
             ended_at=excluded.ended_at,files=excluded.files,preview=excluded.preview,revision=excluded.revision,
             chunks=excluded.chunks,size=excluded.size,stored_at=excluded.stored_at
           WHERE shared_requests.origin_host=excluded.origin_host`,
        )
        .bind(
          project,
          upload.id,
          row.id,
          row.user_id,
          upload.conversationId,
          upload.state,
          upload.createdAt,
          upload.endedAt,
          files,
          doc.body.slice(0, MIRROR_PREVIEW_CHARS),
          upload.revision,
          chunks.length,
          text.length,
          now,
        ),
      ...chunks.map((part, seq) =>
        db
          .prepare(
            'INSERT INTO shared_request_chunks(project_id,request_id,seq,text) VALUES(?,?,?,?)',
          )
          .bind(project, upload.id, seq, part),
      ),
    );
    stored++;
  }
  for (const id of removed as string[])
    statements.push(
      db
        .prepare('DELETE FROM shared_request_chunks WHERE project_id=? AND request_id=?')
        .bind(project, id),
      db
        .prepare('DELETE FROM shared_requests WHERE project_id=? AND id=? AND origin_host=?')
        .bind(project, id, row.id),
    );
  // Conversations left without a shared request and not named again leave too.
  statements.push(
    db
      .prepare(
        `DELETE FROM shared_conversations WHERE project_id=? AND origin_host=? AND id NOT IN
         (SELECT conversation_id FROM shared_requests WHERE project_id=? AND origin_host=?)
         AND stored_at<?`,
      )
      .bind(project, row.id, project, row.id, now),
  );
  if (statements.length) await db.batch(statements);
  return json({ stored, removed: removed.length, at: now });
}
