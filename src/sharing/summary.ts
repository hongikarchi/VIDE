import { HttpError, body, json } from './http';
import type { Env } from './auth';
import type { HostRow } from './hosts';

// PLAN-33: a project opens on the site while its work PC is off (SPEC-04.10). The PC keeps a copy
// of the project's 할 일 here and a summary of its work history (ADR-035: request text, the
// answer's first lines, state, time, file names; never the model, attachments or the AI model).
// 할 일 edits made on the site wait in a queue, one pending edit per item, until the PC applies
// them (last write wins by time, a conflict is noted in the item) and uploads its list again.
// Every project member sees and edits these (SPEC-04.10 6, user decision 2026-10-06).

const AGENDA_TEXT_MAX = 500;
const AGENDA_ITEMS_MAX = 500;
const PENDING_EDITS_MAX = 200;
const HISTORY_ITEMS_MAX = 100;
const HISTORY_BODY_MAX = 600;
const HISTORY_ANSWER_MAX = 400;
const HISTORY_FILES_MAX = 10;
// 'meeting' shows as '협의' and 'receipt' (접수) came with PLAN-39 (SPEC-01.14 1).
const KINDS = ['task', 'meeting', 'receipt', 'deadline'] as const;
type Kind = (typeof KINDS)[number];
const AGENDA_LOCATION_MAX = 200;
const AGENDA_ATTENDEES_MAX = 300;

const invalid = (): never => {
  throw new HttpError(400, 'INVALID_INPUT');
};
const isDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};
const isTime = (value: unknown): value is string =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const isKind = (value: unknown): value is Kind => KINDS.includes(value as Kind);
const shortText = (value: unknown, max: number) =>
  typeof value === 'string' && value.length <= max ? value : invalid();
/** 위치 / 참석자 from a site edit: free text within its length; empty is none. */
const freeText = (value: unknown, max: number) => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > max) return invalid();
  return value.trim() || null;
};
/** The day `days` after a 'YYYY-MM-DD'. */
const shiftDate = (value: string, days: number) => {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const dayNumber = (value: string) => {
  const [y, m, d] = value.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};
const itemId = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(value) ? value : invalid();

/** The fields a site edit may carry (all optional on 'set'). */
export interface AgendaFields {
  text?: string;
  date?: string | null;
  time?: string | null;
  endDate?: string | null;
  endTime?: string | null;
  kind?: Kind;
  location?: string | null;
  attendees?: string | null;
  done?: boolean;
}
export function agendaFields(input: Record<string, unknown>, add: boolean): AgendaFields {
  const fields: AgendaFields = {};
  if (input.text !== undefined || add) {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > AGENDA_TEXT_MAX)
      invalid();
    fields.text = (input.text as string).trim();
  }
  if (input.date !== undefined) {
    if (input.date !== null && !isDate(input.date)) invalid();
    fields.date = input.date as string | null;
  }
  if (input.time !== undefined) {
    if (input.time !== null && !isTime(input.time)) invalid();
    fields.time = input.time as string | null;
  }
  if (input.endDate !== undefined) {
    if (input.endDate !== null && !isDate(input.endDate)) invalid();
    fields.endDate = input.endDate as string | null;
  }
  if (input.endTime !== undefined) {
    if (input.endTime !== null && !isTime(input.endTime)) invalid();
    fields.endTime = input.endTime as string | null;
  }
  if (input.kind !== undefined) fields.kind = isKind(input.kind) ? input.kind : invalid();
  if (input.location !== undefined) fields.location = freeText(input.location, AGENDA_LOCATION_MAX);
  if (input.attendees !== undefined)
    fields.attendees = freeText(input.attendees, AGENDA_ATTENDEES_MAX);
  if (input.done !== undefined) {
    if (typeof input.done !== 'boolean' || add) invalid();
    fields.done = input.done as boolean;
  }
  if (!add && !Object.keys(fields).length) invalid();
  return fields;
}

/** A VIDE account on a 할 일 (SPEC-01.14 12): its id (null: known by name only) and its ID. */
export interface AgendaActor {
  id: string | null;
  name: string;
}
const ACTOR_NAME_MAX = 254;
/** An account the PC sent with its list, taken leniently (anything else is none). */
const actorOf = (value: unknown): AgendaActor | null => {
  if (!value || typeof value !== 'object') return null;
  const { id, name } = value as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) return null;
  return {
    id: typeof id === 'string' && id && id.length <= 200 ? id : null,
    name: name.trim().slice(0, ACTOR_NAME_MAX),
  };
};
/** The stored account with the account's current ID when the site knows it. */
const storedActor = (id: string | null, stored: string | null, current: string | null) =>
  current ? { id, name: current } : stored ? { id, name: stored } : null;

/** One 할 일 as the site shows it: the PC's copy with the site's waiting edits laid over it. */
export interface AgendaView {
  id: string;
  text: string;
  date: string | null;
  time: string | null;
  endDate: string | null;
  endTime: string | null;
  kind: Kind;
  location: string | null;
  attendees: string | null;
  done: boolean;
  order: number;
  /** The PC's revision of the item (0: added on the site, not on the PC yet). */
  revision: number;
  updatedAt: string;
  /** A site edit the PC has not applied yet. */
  pending: boolean;
  /** Who made it and who changed it last (SPEC-04.10 2); null: not recorded (earlier items). */
  createdBy: AgendaActor | null;
  updatedBy: AgendaActor | null;
}
export interface PendingEdit {
  id: string;
  itemId: string;
  op: 'add' | 'set' | 'remove';
  fields: AgendaFields;
  baseRevision: number | null;
  editedAt: number;
  /** The account that made the edit (for an add, the author). */
  user: AgendaActor | null;
  /** An add changed by another member before the PC took it: the one that changed it last. */
  editor: AgendaActor | null;
}

/** Applies the waiting edits, oldest first, to the PC's copy (what the site shows). */
export function agendaView(mirror: AgendaView[], edits: PendingEdit[]): AgendaView[] {
  let items = mirror.map((item) => ({ ...item }));
  let last = items.reduce((max, item) => Math.max(max, item.order), 0);
  for (const edit of [...edits].sort((a, b) => a.editedAt - b.editedAt)) {
    const at = new Date(edit.editedAt).toISOString();
    if (edit.op === 'remove') {
      items = items.filter((item) => item.id !== edit.itemId);
      continue;
    }
    let item = items.find((row) => row.id === edit.itemId);
    if (edit.op === 'add' && !item) {
      item = {
        id: edit.itemId,
        text: '',
        date: null,
        time: null,
        endDate: null,
        endTime: null,
        kind: 'task',
        location: null,
        attendees: null,
        done: false,
        order: ++last,
        revision: 0,
        updatedAt: at,
        pending: true,
        createdBy: edit.user,
        updatedBy: edit.editor ?? edit.user,
      };
      items.push(item);
    }
    if (!item) continue;
    // A waiting change shows the account that made it (SPEC-04.10 2).
    if (edit.op === 'set' && edit.user) item.updatedBy = edit.user;
    const { text, date, time, endDate, endTime, kind, location, attendees, done } = edit.fields;
    if (text !== undefined) item.text = text;
    if (date !== undefined) {
      // A new start day alone moves the end day with it (the period is kept), as on the PC.
      if (date && item.date && item.endDate && endDate === undefined)
        item.endDate = shiftDate(item.endDate, dayNumber(date) - dayNumber(item.date));
      item.date = date;
      // Clearing the date clears the times and the end day, as on the PC.
      if (date === null) {
        if (time === undefined) item.time = null;
        item.endDate = null;
        item.endTime = null;
      }
    }
    if (time !== undefined) item.time = time;
    if (endDate !== undefined) item.endDate = endDate;
    if (endTime !== undefined) item.endTime = endTime;
    if (kind !== undefined) item.kind = kind;
    if (location !== undefined) item.location = location;
    if (attendees !== undefined) item.attendees = attendees;
    if (done !== undefined) item.done = done;
    item.updatedAt = at;
    item.pending = true;
  }
  return items.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

interface MirrorRow {
  item_id: string;
  text: string;
  date: string | null;
  time: string | null;
  end_date: string | null;
  end_time: string | null;
  kind: Kind;
  location: string | null;
  attendees: string | null;
  done_at: string | null;
  ord: number;
  revision: number;
  updated_at: string;
  created_by?: string | null;
  created_by_name?: string | null;
  updated_by?: string | null;
  updated_by_name?: string | null;
  created_by_now?: string | null;
  updated_by_now?: string | null;
}
interface EditRow {
  id: string;
  item_id: string;
  op: PendingEdit['op'];
  fields: string;
  base_revision: number | null;
  edited_at: number;
  user_id?: string | null;
  user_name?: string | null;
  editor_id?: string | null;
  editor_name?: string | null;
}
const pendingOf = (row: EditRow): PendingEdit => ({
  id: row.id,
  itemId: row.item_id,
  op: row.op,
  fields: JSON.parse(row.fields) as AgendaFields,
  baseRevision: row.base_revision,
  editedAt: row.edited_at,
  user: row.user_id && row.user_name ? { id: row.user_id, name: row.user_name } : null,
  editor: row.editor_id && row.editor_name ? { id: row.editor_id, name: row.editor_name } : null,
});
/** A waiting edit's columns with its accounts' current IDs. */
const EDIT_COLUMNS = `e.id,e.item_id,e.op,e.fields,e.base_revision,e.edited_at,e.user_id,e.editor_id,
  u.name AS user_name,ed.name AS editor_name`;
const EDIT_JOINS = 'LEFT JOIN user u ON u.id=e.user_id LEFT JOIN user ed ON ed.id=e.editor_id';

async function summaryState(db: D1Database, project: string) {
  return db
    .prepare(
      'SELECT agenda_revision,agenda_at,history_at FROM project_summaries WHERE project_id=?',
    )
    .bind(project)
    .first<{ agenda_revision: number; agenda_at: number | null; history_at: number | null }>();
}
async function mirror(db: D1Database, project: string): Promise<AgendaView[]> {
  const rows = await db
    .prepare(
      `SELECT a.*, cu.name AS created_by_now, uu.name AS updated_by_now FROM project_agenda a
       LEFT JOIN user cu ON cu.id=a.created_by LEFT JOIN user uu ON uu.id=a.updated_by
       WHERE a.project_id=? ORDER BY a.ord,a.item_id`,
    )
    .bind(project)
    .all<MirrorRow>();
  return rows.results.map((row) => ({
    id: row.item_id,
    text: row.text,
    date: row.date,
    time: row.time,
    endDate: row.end_date ?? null,
    endTime: row.end_time ?? null,
    kind: isKind(row.kind) ? row.kind : 'task',
    location: row.location ?? null,
    attendees: row.attendees ?? null,
    done: row.done_at !== null,
    order: row.ord,
    revision: row.revision,
    updatedAt: row.updated_at,
    pending: false,
    createdBy: storedActor(
      row.created_by ?? null,
      row.created_by_name ?? null,
      row.created_by_now ?? null,
    ),
    updatedBy: storedActor(
      row.updated_by ?? null,
      row.updated_by_name ?? null,
      row.updated_by_now ?? null,
    ),
  }));
}
async function pending(db: D1Database, project: string) {
  const rows = await db
    .prepare(
      `SELECT ${EDIT_COLUMNS} FROM agenda_edits e ${EDIT_JOINS}
       WHERE e.project_id=? AND e.applied_at IS NULL ORDER BY e.edited_at`,
    )
    .bind(project)
    .all<EditRow>();
  return rows.results.map(pendingOf);
}

/** Owner calls from the site: `…/agenda`, `…/agenda/:item`, `…/history`. */
export async function summaryRoute(
  request: Request,
  env: Env,
  actor: { id: string },
  project: string,
  path: string[],
): Promise<Response> {
  const db = env.DB;
  if (path[0] === 'history' && path.length === 1 && request.method === 'GET') {
    const state = await summaryState(db, project);
    const rows = await db
      .prepare(
        'SELECT request_id,body,answer,state,files,created_at FROM project_history WHERE project_id=? ORDER BY ord',
      )
      .bind(project)
      .all<{
        request_id: string;
        body: string;
        answer: string | null;
        state: string;
        files: string;
        created_at: string;
      }>();
    return json({
      sharedAt: state?.history_at ?? null,
      items: rows.results.map((row) => ({
        id: row.request_id,
        body: row.body,
        answer: row.answer,
        state: row.state,
        files: JSON.parse(row.files) as string[],
        createdAt: row.created_at,
      })),
    });
  }
  if (path[0] !== 'agenda') throw new HttpError(404, 'NOT_FOUND');
  const state = await summaryState(db, project);
  if (path.length === 1 && request.method === 'GET') {
    const edits = await pending(db, project);
    return json({
      sharedAt: state?.agenda_at ?? null,
      pending: edits.length,
      items: agendaView(await mirror(db, project), edits),
    });
  }
  // Edits need the PC's list on the site: a PC that never shared it (or stopped) cannot take them.
  if (!state?.agenda_at) throw new HttpError(409, 'AGENDA_NOT_SHARED');
  const now = Date.now();
  if (path.length === 1 && request.method === 'POST') {
    const fields = agendaFields(await body(request), true);
    const open = await db
      .prepare('SELECT COUNT(*) AS n FROM agenda_edits WHERE project_id=? AND applied_at IS NULL')
      .bind(project)
      .first<{ n: number }>();
    if ((open?.n ?? 0) >= PENDING_EDITS_MAX) throw new HttpError(429, 'AGENDA_EDITS_FULL');
    const id = crypto.randomUUID(),
      item = 'site-' + crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO agenda_edits(id,project_id,user_id,item_id,op,fields,base_revision,edited_at) VALUES(?,?,?,?,'add',?,NULL,?)",
      )
      .bind(id, project, actor.id, item, JSON.stringify(fields), now)
      .run();
    return json({ id: item }, 201);
  }
  if (path.length !== 2 || !['PATCH', 'DELETE'].includes(request.method))
    throw new HttpError(405, 'METHOD_NOT_ALLOWED');
  const target = itemId(path[1]);
  const input = request.method === 'PATCH' ? await body(request) : {};
  const fields = request.method === 'PATCH' ? agendaFields(input, false) : {};
  // At most one waiting edit per item: a later one on the same item folds into it.
  const waiting = await db
    .prepare(
      'SELECT id,item_id,op,fields,base_revision,edited_at,user_id FROM agenda_edits WHERE project_id=? AND item_id=? AND applied_at IS NULL',
    )
    .bind(project, target)
    .first<EditRow>();
  if (waiting) {
    const edit = pendingOf(waiting);
    if (edit.op === 'remove') throw new HttpError(404, 'AGENDA_ITEM_NOT_FOUND');
    if (request.method === 'DELETE' && edit.op === 'add') {
      // Added on the site and removed before the PC took it: nothing reaches the PC.
      await db.prepare('DELETE FROM agenda_edits WHERE id=?').bind(edit.id).run();
      return json({ removed: true });
    }
    const merged =
      request.method === 'DELETE'
        ? { op: 'remove' as const, fields: {} }
        : { op: edit.op, fields: { ...edit.fields, ...fields } };
    // A waiting add keeps its author and records the last editor; a waiting change belongs to the
    // member who changed it last (SPEC-04.10 2).
    const [author, editor] =
      merged.op === 'add' ? [waiting.user_id ?? actor.id, actor.id] : [actor.id, null];
    await db
      .prepare(
        'UPDATE agenda_edits SET op=?,fields=?,edited_at=?,user_id=?,editor_id=? WHERE id=? AND applied_at IS NULL',
      )
      .bind(
        merged.op,
        JSON.stringify(merged.fields),
        Math.max(now, edit.editedAt + 1),
        author,
        editor,
        edit.id,
      )
      .run();
    return json({ id: target, pending: true });
  }
  const row = await db
    .prepare('SELECT revision FROM project_agenda WHERE project_id=? AND item_id=?')
    .bind(project, target)
    .first<{ revision: number }>();
  if (!row) throw new HttpError(404, 'AGENDA_ITEM_NOT_FOUND');
  const open = await db
    .prepare('SELECT COUNT(*) AS n FROM agenda_edits WHERE project_id=? AND applied_at IS NULL')
    .bind(project)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= PENDING_EDITS_MAX) throw new HttpError(429, 'AGENDA_EDITS_FULL');
  // The revision the site showed; the PC compares it with its own to see a change made there since.
  const base =
    typeof input.revision === 'number' && Number.isSafeInteger(input.revision)
      ? input.revision
      : row.revision;
  await db
    .prepare(
      'INSERT INTO agenda_edits(id,project_id,user_id,item_id,op,fields,base_revision,edited_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .bind(
      crypto.randomUUID(),
      project,
      actor.id,
      target,
      request.method === 'DELETE' ? 'remove' : 'set',
      JSON.stringify(fields),
      base,
      now,
    )
    .run();
  return json({ id: target, pending: true });
}

/** Waiting 할 일 edits of this PC's projects, returned with its heartbeat. */
export async function pendingAgendaEdits(db: D1Database, row: HostRow) {
  const rows = await db
    .prepare(
      `SELECT ${EDIT_COLUMNS},e.project_id FROM agenda_edits e
       JOIN projects p ON p.id=e.project_id ${EDIT_JOINS}
       WHERE p.host_id=? AND p.created_by=? AND e.applied_at IS NULL
       ORDER BY e.edited_at LIMIT 100`,
    )
    .bind(row.id, row.user_id)
    .all<EditRow & { project_id: string }>();
  // Each edit names its author (and an add's last editor) for the PC to record (SPEC-01.14 12).
  return rows.results.map((r) => {
    const { user, editor, ...edit } = pendingOf(r);
    return { ...edit, projectId: r.project_id, user, ...(editor ? { editor } : {}) };
  });
}

const ownedByHost = async (db: D1Database, row: HostRow, id: string) => {
  const project = await db
    .prepare('SELECT id FROM projects WHERE id=? AND host_id=? AND created_by=?')
    .bind(id, row.id, row.user_id)
    .first();
  if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND');
};
const items = (input: Record<string, unknown>, max: number) => {
  const list = input.items;
  if (!Array.isArray(list) || list.length > max) invalid();
  return (list as unknown[]).map((item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : invalid(),
  );
};

/** PC calls: replace the 할 일 copy or the history summary, remove both, confirm applied edits. */
export async function summaryDeviceRoute(
  request: Request,
  env: Env,
  row: HostRow,
  path: string[],
): Promise<Response | undefined> {
  const db = env.DB;
  if (path[0] === 'agenda-edits' && path[1] === 'applied' && path.length === 2) {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    const results = items(await body(request), 100);
    const now = Date.now();
    const statements = results.map((result) => {
      const outcome = result.outcome;
      if (
        typeof result.id !== 'string' ||
        !Number.isSafeInteger(result.editedAt) ||
        !['applied', 'conflict', 'missing'].includes(outcome as string)
      )
        invalid();
      // Only the version the PC read: an edit changed on the site since stays waiting.
      return db
        .prepare(
          `UPDATE agenda_edits SET applied_at=?,outcome=? WHERE id=? AND edited_at=? AND applied_at IS NULL
           AND project_id IN (SELECT id FROM projects WHERE host_id=? AND created_by=?)`,
        )
        .bind(now, outcome, result.id, result.editedAt, row.id, row.user_id);
    });
    if (statements.length) await db.batch(statements);
    return json({ confirmed: statements.length });
  }
  if (path[0] !== 'projects' || path.length !== 3) return undefined;
  if (!['agenda', 'history', 'summary'].includes(path[2])) return undefined;
  const project = path[1];
  if (!/^[A-Za-z0-9-]{8,64}$/.test(project)) invalid();
  await ownedByHost(db, row, project);
  const now = Date.now();
  if (path[2] === 'summary') {
    if (request.method !== 'DELETE') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    // The owner turned sharing off on the PC: the copy and the summary leave the site.
    await db.batch([
      db.prepare('DELETE FROM project_agenda WHERE project_id=?').bind(project),
      db.prepare('DELETE FROM project_history WHERE project_id=?').bind(project),
      db.prepare('DELETE FROM project_summaries WHERE project_id=?').bind(project),
    ]);
    return json({ removed: true });
  }
  if (request.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
  const input = await body(request, 1024 * 1024);
  const upsert = (column: 'agenda_at' | 'history_at') =>
    db
      .prepare(
        `INSERT INTO project_summaries(project_id,agenda_revision,${column}) VALUES(?,1,?)
         ON CONFLICT(project_id) DO UPDATE SET ${column}=excluded.${column}${
           column === 'agenda_at' ? ',agenda_revision=agenda_revision+1' : ''
         }`,
      )
      .bind(project, now);
  if (path[2] === 'agenda') {
    const list = items(input, AGENDA_ITEMS_MAX).map((item) => {
      const date = item.date ?? null,
        time = item.time ?? null,
        doneAt = item.doneAt ?? null;
      // Newer fields are taken leniently: a kind this site does not know is a '할 일', and a
      // period, 위치 or 참석자 it cannot read is left out, so one item never refuses the list.
      const endDate = date !== null && isDate(item.endDate) ? item.endDate : null,
        endTime = time !== null && isTime(item.endTime) ? item.endTime : null;
      const clipped = (value: unknown, max: number) =>
        typeof value === 'string' && value.trim() ? value.slice(0, max) : null;
      if (
        (date !== null && !isDate(date)) ||
        (time !== null && !isTime(time)) ||
        typeof item.kind !== 'string' ||
        typeof item.order !== 'number' ||
        !Number.isFinite(item.order) ||
        !Number.isSafeInteger(item.revision) ||
        (doneAt !== null && typeof doneAt !== 'string')
      )
        invalid();
      return {
        id: itemId(item.id),
        text: shortText(item.text, AGENDA_TEXT_MAX),
        date,
        time,
        endDate,
        endTime,
        kind: isKind(item.kind) ? item.kind : 'task',
        location: clipped(item.location, AGENDA_LOCATION_MAX),
        attendees: clipped(item.attendees, AGENDA_ATTENDEES_MAX),
        doneAt: doneAt === null ? null : shortText(doneAt, 40),
        order: item.order as number,
        revision: item.revision as number,
        updatedAt: shortText(item.updatedAt, 40),
        // Kept as the PC sent them; anything else is none (SPEC-01.14 12).
        createdBy: actorOf(item.createdBy),
        updatedBy: actorOf(item.updatedBy),
      };
    });
    await db.batch([
      db.prepare('DELETE FROM project_agenda WHERE project_id=?').bind(project),
      ...list.map((item) =>
        db
          .prepare(
            'INSERT INTO project_agenda(project_id,item_id,text,date,time,kind,done_at,ord,revision,updated_at,end_date,end_time,location,attendees,created_by,created_by_name,updated_by,updated_by_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            project,
            item.id,
            item.text,
            item.date,
            item.time,
            item.kind,
            item.doneAt,
            item.order,
            item.revision,
            item.updatedAt,
            item.endDate,
            item.endTime,
            item.location,
            item.attendees,
            item.createdBy?.id ?? null,
            item.createdBy?.name ?? null,
            item.updatedBy?.id ?? null,
            item.updatedBy?.name ?? null,
          ),
      ),
      upsert('agenda_at'),
    ]);
    return json({ stored: list.length });
  }
  // History: only these fields are kept; anything else the PC sends is dropped (ADR-035).
  const list = items(input, HISTORY_ITEMS_MAX).map((item, index) => {
    const files = item.files ?? [];
    if (
      !Array.isArray(files) ||
      files.length > HISTORY_FILES_MAX ||
      typeof item.state !== 'string' ||
      !/^[a-z-]{1,20}$/.test(item.state)
    )
      invalid();
    return {
      id: itemId(item.id),
      order: index,
      body: shortText(item.body, HISTORY_BODY_MAX),
      answer:
        item.answer === null || item.answer === undefined
          ? null
          : shortText(item.answer, HISTORY_ANSWER_MAX),
      state: item.state as string,
      files: JSON.stringify((files as unknown[]).map((file) => shortText(file, 260))),
      createdAt: shortText(item.createdAt, 40),
    };
  });
  await db.batch([
    db.prepare('DELETE FROM project_history WHERE project_id=?').bind(project),
    ...list.map((item) =>
      db
        .prepare(
          'INSERT INTO project_history(project_id,request_id,ord,body,answer,state,files,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(
          project,
          item.id,
          item.order,
          item.body,
          item.answer,
          item.state,
          item.files,
          item.createdAt,
        ),
    ),
    upsert('history_at'),
  ]);
  return json({ stored: list.length });
}
