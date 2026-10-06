import type { Env } from './auth';
import { HttpError, body, json } from './http';
import { membership } from './projects';
import { offlineRoute } from './offline';
import { online, type HostRow } from './hosts';
import {
  KNOWLEDGE_EXCERPT_MAX,
  KNOWLEDGE_ROWS_PER_REQUEST,
  KNOWLEDGE_TABLES,
  SHARED_INSTRUCTIONS_MAX_BYTES,
  knowledgeRow,
  type KnowledgeTableName,
} from '../contracts/knowledge-pack.ts';

// PLAN-35 (ADR-037 1-3, SPEC-04.11): the team's shared project layer. Every project member (any
// role) reads and writes the project's AI instructions and the people's reviews and source rules
// of its organized knowledge; the crawler's result arrives from a member's PC as one numbered set
// of rows that becomes visible when committed. The same routes serve a signed-in browser
// (`/api/projects/:id/…`) and a work PC with its host key (`/api/hosts/device/projects/:id/…`,
// acting as the PC's account); only a PC uploads a knowledge set.

const REVIEW_TEXT_MAX = 4000;
const RULES_MAX = 500;
const REVIEWS_PER_REQUEST = 500;
const ROWS_PAGE_MAX = 500;
const VERDICTS = ['confirmed', 'rejected', 'contaminated', 'superseded', 'corrected'] as const;

const invalid = (): never => {
  throw new HttpError(400, 'INVALID_INPUT');
};
const optionalText = (value: unknown, max = REVIEW_TEXT_MAX) =>
  value === undefined || value === null
    ? null
    : typeof value === 'string' && value.length <= max
      ? value
      : invalid();
const time = (value: unknown, fallback: number) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) invalid();
  // A PC clock far ahead cannot win every later edit.
  return Math.min(value as number, fallback + 60_000);
};

interface InstructionRow {
  text: string;
  revision: number;
  edited_at: number;
  updated_at: number;
  updated_by_name: string | null;
}
const instructionView = (row: InstructionRow | null) => ({
  text: row?.text ?? '',
  revision: row?.revision ?? 0,
  updatedAt: row?.updated_at ?? null,
  updatedByName: row?.updated_by_name ?? null,
});
async function instructionRow(db: D1Database, project: string) {
  return db
    .prepare(
      `SELECT i.text,i.revision,i.edited_at,i.updated_at,u.name AS updated_by_name
       FROM project_instructions i LEFT JOIN user u ON u.id=i.updated_by WHERE i.project_id=?`,
    )
    .bind(project)
    .first<InstructionRow>();
}

async function instructions(request: Request, db: D1Database, user: string, project: string) {
  const current = await instructionRow(db, project);
  if (request.method === 'GET') return json(instructionView(current));
  if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
  const input = await body(request, SHARED_INSTRUCTIONS_MAX_BYTES * 4 + 1024);
  if (typeof input.text !== 'string') invalid();
  const text = (input.text as string).replace(/\r\n?/g, '\n');
  if (new TextEncoder().encode(text).length > SHARED_INSTRUCTIONS_MAX_BYTES) invalid();
  const base = input.baseRevision ?? 0;
  if (typeof base !== 'number' || !Number.isSafeInteger(base) || base < 0) invalid();
  const now = Date.now();
  const editedAt = time(input.editedAt, now);
  // The revision the editor saw decides; an edit made on a stale copy wins only when it is later.
  const stale = !!current && base !== current.revision;
  if (stale && editedAt < current.edited_at)
    return json({ applied: false, ...instructionView(current) });
  const revision = (current?.revision ?? 0) + 1;
  // The write holds only if nobody wrote in between (the revision is still the one read).
  const result = current
    ? await db
        .prepare(
          'UPDATE project_instructions SET text=?,revision=?,edited_at=?,updated_at=?,updated_by=? WHERE project_id=? AND revision=?',
        )
        .bind(text, revision, editedAt, now, user, project, current.revision)
        .run()
    : await db
        .prepare(
          'INSERT INTO project_instructions(project_id,text,revision,edited_at,updated_at,updated_by) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
        )
        .bind(project, text, revision, editedAt, now, user)
        .run();
  if (!result.meta.changes) throw new HttpError(409, 'INSTRUCTIONS_CHANGED');
  return json({
    applied: true,
    ...instructionView(await instructionRow(db, project)),
    ...(stale && current.text !== text ? { conflict: instructionView(current) } : {}),
  });
}

interface SetRow {
  revision: number;
  pending_revision: number | null;
  built_at: string | null;
  counts: string;
  updated_at: number;
}
async function knowledgeSet(db: D1Database, project: string) {
  return db
    .prepare(
      'SELECT revision,pending_revision,built_at,counts,updated_at FROM knowledge_sets WHERE project_id=?',
    )
    .bind(project)
    .first<SetRow>();
}
async function changedAt(db: D1Database, project: string) {
  const row = await db
    .prepare(
      `SELECT MAX(at) AS at FROM (SELECT MAX(updated_at) AS at FROM knowledge_reviews WHERE project_id=?
       UNION ALL SELECT MAX(updated_at) FROM knowledge_rules WHERE project_id=?)`,
    )
    .bind(project, project)
    .first<{ at: number | null }>();
  return row?.at ?? null;
}
const tableOf = (value: unknown): KnowledgeTableName =>
  typeof value === 'string' && Object.hasOwn(KNOWLEDGE_TABLES, value)
    ? (value as KnowledgeTableName)
    : invalid();

interface ReviewRow {
  statement_id: number;
  verdict: string | null;
  correction: string | null;
  superseded_by: number | null;
  reason: string | null;
  by_name: string;
  edited_at: number;
  updated_at: number;
}
interface RuleRow {
  pattern: string;
  reason: string | null;
  removed: number;
  edited_at: number;
  updated_at: number;
}
async function changes(db: D1Database, project: string, since: number) {
  const [reviews, rules] = await Promise.all([
    db
      .prepare(
        'SELECT * FROM knowledge_reviews WHERE project_id=? AND updated_at>? ORDER BY updated_at LIMIT 5000',
      )
      .bind(project, since)
      .all<ReviewRow>(),
    db
      .prepare(
        'SELECT * FROM knowledge_rules WHERE project_id=? AND updated_at>? ORDER BY updated_at LIMIT 1000',
      )
      .bind(project, since)
      .all<RuleRow>(),
  ]);
  return {
    reviews: reviews.results.map((row) => ({
      statementId: row.statement_id,
      verdict: row.verdict,
      correction: row.correction,
      supersededBy: row.superseded_by,
      reason: row.reason,
      by: row.by_name,
      editedAt: row.edited_at,
      updatedAt: row.updated_at,
    })),
    rules: rules.results.map((row) => ({
      pattern: row.pattern,
      reason: row.reason,
      removed: !!row.removed,
      editedAt: row.edited_at,
      updatedAt: row.updated_at,
    })),
  };
}

async function knowledge(
  request: Request,
  env: Env,
  user: string,
  project: string,
  path: string[],
  host: HostRow | undefined,
) {
  const db = env.DB;
  const method = request.method;
  const url = new URL(request.url);
  if (path.length === 0 && method === 'GET') {
    const set = await knowledgeSet(db, project);
    return json({
      revision: set?.revision ?? 0,
      builtAt: set?.revision ? set.built_at : null,
      counts: set?.revision ? (JSON.parse(set.counts) as Record<string, number>) : {},
      updatedAt: set?.revision ? set.updated_at : null,
      changedAt: await changedAt(db, project),
    });
  }
  if (path[0] === 'rows' && path.length === 1 && method === 'GET') {
    const table = tableOf(url.searchParams.get('table'));
    const after = url.searchParams.get('after') ?? '';
    const limit = Math.min(
      Math.max(Number(url.searchParams.get('limit')) || ROWS_PAGE_MAX, 1),
      ROWS_PAGE_MAX,
    );
    const set = await knowledgeSet(db, project);
    if (!set?.revision) return json({ revision: 0, rows: [], next: null });
    const rows = await db
      .prepare(
        'SELECT row_key,body FROM knowledge_rows WHERE project_id=? AND revision=? AND tbl=? AND row_key>? ORDER BY row_key LIMIT ?',
      )
      .bind(project, set.revision, table, after, limit)
      .all<{ row_key: string; body: string }>();
    const list = rows.results;
    return json({
      revision: set.revision,
      rows: list.map((row) => JSON.parse(row.body) as unknown),
      next: list.length === limit ? list[list.length - 1].row_key : null,
    });
  }
  if (path[0] === 'reviews' && path.length === 1) {
    if (method === 'GET') {
      const since = Number(url.searchParams.get('since')) || 0;
      const now = Date.now();
      return json({ ...(await changes(db, project, since)), at: now });
    }
    if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const input = await body(request, 2 * 1024 * 1024);
    const reviews = input.reviews ?? [];
    const rules = input.rules ?? [];
    if (
      !Array.isArray(reviews) ||
      reviews.length > REVIEWS_PER_REQUEST ||
      !Array.isArray(rules) ||
      rules.length > RULES_MAX
    )
      invalid();
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    for (const item of reviews as Record<string, unknown>[]) {
      if (!item || typeof item !== 'object') invalid();
      const statement = item.statementId;
      if (typeof statement !== 'number' || !Number.isSafeInteger(statement) || statement < 0)
        invalid();
      const verdict = item.verdict ?? null;
      if (verdict !== null && !VERDICTS.includes(verdict as (typeof VERDICTS)[number])) invalid();
      const superseded = item.supersededBy ?? null;
      if (
        superseded !== null &&
        (typeof superseded !== 'number' || !Number.isSafeInteger(superseded))
      )
        invalid();
      const by = optionalText(item.by, 200) ?? 'user';
      // A later edit replaces the row; an earlier one (made offline) loses.
      statements.push(
        db
          .prepare(
            `INSERT INTO knowledge_reviews(project_id,statement_id,verdict,correction,superseded_by,reason,by_name,edited_at,updated_at,updated_by)
             VALUES(?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(project_id,statement_id) DO UPDATE SET verdict=excluded.verdict,correction=excluded.correction,
               superseded_by=excluded.superseded_by,reason=excluded.reason,by_name=excluded.by_name,
               edited_at=excluded.edited_at,updated_at=excluded.updated_at,updated_by=excluded.updated_by
             WHERE excluded.edited_at>=knowledge_reviews.edited_at`,
          )
          .bind(
            project,
            statement,
            verdict,
            optionalText(item.correction),
            superseded,
            optionalText(item.reason),
            by,
            time(item.editedAt, now),
            now,
            user,
          ),
      );
    }
    for (const item of rules as Record<string, unknown>[]) {
      if (!item || typeof item !== 'object') invalid();
      const pattern = item.pattern;
      if (typeof pattern !== 'string' || !pattern || pattern.length > REVIEW_TEXT_MAX) invalid();
      statements.push(
        db
          .prepare(
            `INSERT INTO knowledge_rules(project_id,pattern,reason,removed,edited_at,updated_at,updated_by)
             VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(project_id,pattern) DO UPDATE SET reason=excluded.reason,removed=excluded.removed,
               edited_at=excluded.edited_at,updated_at=excluded.updated_at,updated_by=excluded.updated_by
             WHERE excluded.edited_at>=knowledge_rules.edited_at`,
          )
          .bind(
            project,
            pattern,
            optionalText(item.reason),
            item.removed === true ? 1 : 0,
            time(item.editedAt, now),
            now,
            user,
          ),
      );
    }
    if (statements.length) await db.batch(statements);
    const since = typeof input.since === 'number' && input.since > 0 ? input.since : 0;
    return json({ ...(await changes(db, project, since)), at: now });
  }
  // Uploading the crawler's result: a member's work PC only.
  if (!host) throw new HttpError(403, 'DEVICE_ONLY');
  if (path[0] === 'begin' && path.length === 1 && method === 'POST') {
    await body(request);
    const now = Date.now();
    const set = await knowledgeSet(db, project);
    const revision = (set?.revision ?? 0) + 1;
    await db.batch([
      // Rows of an upload that never finished are dropped first.
      db
        .prepare('DELETE FROM knowledge_rows WHERE project_id=? AND revision>=?')
        .bind(project, revision),
      db
        .prepare(
          `INSERT INTO knowledge_sets(project_id,revision,pending_revision,host_id,updated_at,updated_by)
           VALUES(?,0,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET
           pending_revision=excluded.pending_revision,host_id=excluded.host_id`,
        )
        .bind(project, revision, host.id, now, user),
    ]);
    return json({ revision });
  }
  if (path[0] === 'rows' && path.length === 1 && method === 'PUT') {
    const input = await body(request, 2 * 1024 * 1024);
    const table = tableOf(input.table);
    const set = await knowledgeSet(db, project);
    if (!set?.pending_revision || input.revision !== set.pending_revision)
      throw new HttpError(409, 'KNOWLEDGE_UPLOAD_STALE');
    const list = input.rows;
    if (!Array.isArray(list) || list.length > KNOWLEDGE_ROWS_PER_REQUEST) invalid();
    const key = KNOWLEDGE_TABLES[table].key;
    const statements = (list as unknown[]).map((value) => {
      const row = knowledgeRow(table, value) ?? invalid();
      if (table === 'excerpt' && typeof row.text === 'string')
        row.text = row.text.slice(0, KNOWLEDGE_EXCERPT_MAX);
      return db
        .prepare(
          'INSERT OR REPLACE INTO knowledge_rows(project_id,revision,tbl,row_key,body) VALUES(?,?,?,?,?)',
        )
        .bind(project, set.pending_revision, table, String(row[key]), JSON.stringify(row));
    });
    if (statements.length) await db.batch(statements);
    return json({ stored: statements.length });
  }
  if (path[0] === 'commit' && path.length === 1 && method === 'POST') {
    const input = await body(request);
    const set = await knowledgeSet(db, project);
    if (!set?.pending_revision || input.revision !== set.pending_revision)
      throw new HttpError(409, 'KNOWLEDGE_UPLOAD_STALE');
    const counts: Record<string, number> = {};
    const given = input.counts;
    if (given && typeof given === 'object' && !Array.isArray(given))
      for (const [name, value] of Object.entries(given).slice(0, 20))
        if (/^[a-z]{1,20}$/.test(name) && Number.isSafeInteger(value) && (value as number) >= 0)
          counts[name] = value as number;
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          'UPDATE knowledge_sets SET revision=pending_revision,pending_revision=NULL,built_at=?,counts=?,updated_at=?,updated_by=? WHERE project_id=? AND pending_revision=?',
        )
        .bind(
          optionalText(input.builtAt, 40) ?? set.built_at,
          JSON.stringify(counts),
          now,
          user,
          project,
          set.pending_revision,
        ),
      db
        .prepare('DELETE FROM knowledge_rows WHERE project_id=? AND revision<?')
        .bind(project, set.pending_revision),
    ]);
    return json({ revision: set.pending_revision });
  }
  throw new HttpError(404, 'NOT_FOUND');
}

/**
 * `…/projects/:id/(instructions|knowledge…)` for `user` (a browser's account, or a work PC's
 * account with `host`). Undefined when the path is not one of these.
 */
export async function sharedLayerRoute(
  request: Request,
  env: Env,
  user: string,
  project: string,
  path: string[],
  host?: HostRow,
): Promise<Response | undefined> {
  if (path[0] !== 'instructions' && path[0] !== 'knowledge') return undefined;
  await membership(env.DB, project, user);
  if (path[0] === 'instructions') {
    if (path.length !== 1) throw new HttpError(404, 'NOT_FOUND');
    return instructions(request, env.DB, user, project);
  }
  return knowledge(request, env, user, project, path.slice(1), host);
}

/**
 * `GET /api/hosts/device/projects`: every project the PC's account is a member of, with its owner,
 * the PC that runs it and the revisions the PC compares with its copies.
 */
export async function memberProjects(env: Env, row: HostRow) {
  const rows = await env.DB.prepare(
    `SELECT p.id,p.name,m.role,p.host_id,COALESCE(p.updated_at,p.created_at) AS updated_at,
       o.name AS owner_name,h.name AS host_name,h.last_seen,
       COALESCE(i.revision,0) AS instructions_revision,COALESCE(k.revision,0) AS knowledge_revision,
       (SELECT MAX(at) FROM (SELECT MAX(updated_at) AS at FROM knowledge_reviews WHERE project_id=p.id
         UNION ALL SELECT MAX(updated_at) FROM knowledge_rules WHERE project_id=p.id)) AS knowledge_changed_at
     FROM project_members m JOIN projects p ON p.id=m.project_id
     LEFT JOIN user o ON o.id=p.created_by LEFT JOIN remote_hosts h ON h.id=p.host_id
     LEFT JOIN project_instructions i ON i.project_id=p.id LEFT JOIN knowledge_sets k ON k.project_id=p.id
     WHERE m.user_id=? AND p.deleted_at IS NULL
     ORDER BY COALESCE(p.updated_at,p.created_at) DESC,p.id LIMIT 500`,
  )
    .bind(row.user_id)
    .all<{
      id: string;
      name: string;
      role: string;
      host_id: string | null;
      updated_at: number;
      owner_name: string | null;
      host_name: string | null;
      last_seen: number | null;
      instructions_revision: number;
      knowledge_revision: number;
      knowledge_changed_at: number | null;
    }>();
  const now = Date.now();
  return json({
    projects: rows.results.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      ownerName: p.owner_name,
      hostId: p.host_id,
      hostName: p.host_name,
      hostOnline:
        !!p.host_id && p.last_seen !== null && online({ last_seen: p.last_seen } as HostRow, now),
      here: p.host_id === row.id,
      updatedAt: p.updated_at,
      instructionsRevision: p.instructions_revision,
      knowledgeRevision: p.knowledge_revision,
      knowledgeChangedAt: p.knowledge_changed_at,
    })),
  });
}

/** `GET /api/hosts/device/projects/:id/member/(agenda|history|snapshots)`: SPEC-04.10's view. */
export async function memberView(
  request: Request,
  env: Env,
  row: HostRow,
  project: string,
  path: string[],
) {
  if (
    request.method !== 'GET' ||
    !['agenda', 'history', 'snapshots'].includes(path[0]) ||
    path.length !== 1
  )
    throw new HttpError(404, 'NOT_FOUND');
  return offlineRoute(request, env, { id: row.user_id, email: '' }, project, path);
}
