import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.ts';
import { DomainError } from '../contracts/errors.ts';
import {
  RECORD_SOURCES,
  RECORD_STATES,
  RECORD_TYPES,
  milestoneInputSchema,
  partInputSchema,
  partPatchSchema,
  recordCorrectSchema,
  recordDateSchema,
  recordInputSchema,
  recordPatchSchema,
  type MilestoneRow,
  type PartMapping,
  type PartRow,
  type RecordAttachments,
  type RecordChain,
  type RecordCounts,
  type RecordFilters,
  type RecordListResponse,
  type RecordRow,
  type RecordSource,
  type RecordState,
  type RecordType,
} from '../contracts/records.ts';

/**
 * 프로젝트 기록 (SPEC-17, ARCH-01 §5 「프로젝트 기록(PLAN-53, SPEC-17)」, schema 19): records, their
 * parts and follows links, the 부위 사전 and milestones of one project. Data access and the rules
 * of SPEC-17.2·17.7 (append only, corrections, cycles, the AI's limits); routes are
 * `src/server/records-routes.ts`. Records only point at requests, notes and reviews — never change
 * them.
 */

/** A refusal with fields the client needs (`existingId`, `expected`/`got`). */
export class RecordRefusal extends DomainError {
  details: Record<string, unknown>;
  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.details = details;
  }
}

/** The AI's records are `by: 'ai'` (SPEC-17.7): it makes candidates only. */
export const AI_AUTHOR = 'ai';

export interface RecordsOptions {
  /** Whether a request's executions are all undone (read time; default: never). */
  undoneResolver?: (projectId: string, requestId: string) => boolean;
  now?: () => Date;
}

export interface RecordAddOptions {
  /** 'ai' or the account's display name. */
  by: string;
  /** Default 'candidate' for the AI, 'kept' for a person. */
  state?: RecordState;
  /** Default 'manual'. */
  source?: RecordSource;
  sourceKey?: string;
}

const invalid = (): never => {
  throw new DomainError('INVALID_INPUT');
};
const parse = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> => {
  const result = schema.safeParse(value);
  return result.success ? result.data : invalid();
};
const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const str = (value: unknown) => (value === null || value === undefined ? null : String(value));
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return value === null || value === undefined ? fallback : (JSON.parse(String(value)) as T);
  } catch {
    return fallback;
  }
};
const changeListeners = new WeakMap<object, Set<(projectId: string) => void>>();
/**
 * Calls `listener` after any successful write (records, links, states, 부위 사전, milestones)
 * through any `Records` of `source` — the routes, the AI tool and the automatic candidates share
 * the store. The work-folder copy (PLAN-53 T-331, `src/server/records-mirror.ts`) listens here.
 * Listener errors are swallowed. Returns the unsubscribe.
 */
export function onRecordsChanged(
  source: DatabaseSync | Store,
  listener: (projectId: string) => void,
): () => void {
  let set = changeListeners.get(source);
  if (!set) changeListeners.set(source, (set = new Set()));
  set.add(listener);
  return () => void set.delete(listener);
}

const MARK_OF: Record<RecordState, string> = { kept: 'o', dropped: 'x', candidate: '.' };
const STATE_OF: Record<string, RecordState> = { o: 'kept', x: 'dropped', '.': 'candidate' };

export class Records {
  private readonly source: DatabaseSync | Store;
  private readonly undoneResolver: (projectId: string, requestId: string) => boolean;
  private readonly now: () => Date;
  /** One DB (tests, a single file), or a Store: each project's rows live in its own DB. */
  constructor(source: DatabaseSync | Store, options: RecordsOptions = {}) {
    this.source = source;
    this.undoneResolver = options.undoneResolver ?? (() => false);
    this.now = options.now ?? (() => new Date());
  }
  private of(projectId: string) {
    return this.source instanceof DatabaseSync ? this.source : this.source.db(projectId);
  }
  /** A savepoint, so a caller's own transaction may hold it. */
  private tx<T>(projectId: string, fn: (db: DatabaseSync) => T): T {
    const db = this.of(projectId);
    const name = 'records_' + randomUUID().replaceAll('-', '');
    db.exec(`SAVEPOINT ${name}`);
    try {
      const value = fn(db);
      db.exec(`RELEASE ${name}`);
      return value;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }
  private stamp() {
    return this.now().toISOString();
  }
  /** Tells the change listeners (never throws), then gives `value` back. */
  private changed<T>(projectId: string, value: T): T {
    for (const listener of changeListeners.get(this.source) ?? [])
      try {
        listener(projectId);
      } catch {
        /* a listener never fails the write */
      }
    return value;
  }

  // ---- Reading ----

  private rowsOf(projectId: string, raw: Record<string, unknown>[]): RecordRow[] {
    if (!raw.length) return [];
    const db = this.of(projectId);
    const ids = new Set(raw.map((row) => String(row.id)));
    const parts = new Map<string, string[]>();
    const follows = new Map<string, string[]>();
    const followedBy = new Map<string, string[]>();
    const push = (map: Map<string, string[]>, key: string, value: string) => {
      if (!ids.has(key)) return;
      const list = map.get(key);
      if (list) list.push(value);
      else map.set(key, [value]);
    };
    for (const row of db
      .prepare('SELECT recordId, partId FROM record_parts WHERE projectId=? ORDER BY partId')
      .all(projectId))
      push(parts, String(row.recordId), String(row.partId));
    for (const row of db
      .prepare('SELECT fromId, toId FROM record_links WHERE projectId=? ORDER BY fromId, toId')
      .all(projectId)) {
      push(follows, String(row.fromId), String(row.toId));
      push(followedBy, String(row.toId), String(row.fromId));
    }
    return raw.map((row) => {
      const id = String(row.id);
      const attachments = json<RecordAttachments>(row.attachments, {});
      const record: RecordRow = {
        id,
        date: String(row.date),
        time: str(row.time),
        source: String(row.source) as RecordSource,
        type: String(row.type) as RecordType,
        text: String(row.text),
        state: String(row.state) as RecordState,
        by: String(row.by),
        chapter: str(row.chapter),
        parts: parts.get(id) ?? [],
        follows: follows.get(id) ?? [],
        followedBy: followedBy.get(id) ?? [],
        attachments,
        undone: attachments.requestId ? this.safeUndone(projectId, attachments.requestId) : false,
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
      };
      if (row.sourceKey !== null && row.sourceKey !== undefined)
        record.sourceKey = String(row.sourceKey);
      if (row.supersededBy !== null && row.supersededBy !== undefined)
        record.supersededBy = String(row.supersededBy);
      if (row.updatedBy !== null && row.updatedBy !== undefined)
        record.updatedBy = String(row.updatedBy);
      return record;
    });
  }
  private safeUndone(projectId: string, requestId: string) {
    try {
      return this.undoneResolver(projectId, requestId);
    } catch {
      return false;
    }
  }
  private raw(projectId: string, id: string) {
    return this.of(projectId)
      .prepare('SELECT * FROM records WHERE projectId=? AND id=?')
      .get(projectId, id) as Record<string, unknown> | undefined;
  }
  get(projectId: string, id: string): RecordRow {
    const row = this.raw(projectId, id);
    if (!row) throw new DomainError('RECORD_NOT_FOUND');
    return this.rowsOf(projectId, [row])[0]!;
  }
  /** The record holding a source key, if any. */
  bySourceKey(projectId: string, sourceKey: string): RecordRow | null {
    const row = this.of(projectId)
      .prepare('SELECT * FROM records WHERE projectId=? AND sourceKey=?')
      .get(projectId, sourceKey) as Record<string, unknown> | undefined;
    return row ? this.rowsOf(projectId, [row])[0]! : null;
  }

  private where(projectId: string, filters: RecordFilters) {
    const clauses = ['r.projectId=?'];
    const args: (string | number)[] = [projectId];
    const list = <T extends string>(
      key: string,
      values: T[] | undefined,
      allowed: readonly T[],
    ) => {
      if (!values?.length) return;
      for (const value of values) if (!allowed.includes(value)) invalid();
      clauses.push(`r.${key} IN (${values.map(() => '?').join(',')})`);
      args.push(...values);
    };
    list('state', filters.state, RECORD_STATES);
    list('type', filters.type, RECORD_TYPES);
    list('source', filters.source, RECORD_SOURCES);
    if (filters.part === '-')
      clauses.push(
        'NOT EXISTS (SELECT 1 FROM record_parts p WHERE p.projectId=r.projectId AND p.recordId=r.id)',
      );
    else if (filters.part) {
      clauses.push(
        'EXISTS (SELECT 1 FROM record_parts p WHERE p.projectId=r.projectId AND p.recordId=r.id AND p.partId=?)',
      );
      args.push(filters.part);
    }
    if (filters.chapter === '-') clauses.push('r.chapter IS NULL');
    else if (filters.chapter) {
      clauses.push('r.chapter=?');
      args.push(filters.chapter);
    }
    if (filters.from) {
      parse(recordDateSchema, filters.from);
      clauses.push('r.date>=?');
      args.push(filters.from);
    }
    if (filters.to) {
      parse(recordDateSchema, filters.to);
      clauses.push('r.date<=?');
      args.push(filters.to);
    }
    if (filters.q?.trim()) {
      clauses.push("r.text LIKE ? ESCAPE '\\'");
      args.push('%' + filters.q.trim().replace(/[\\%_]/g, (c) => '\\' + c) + '%');
    }
    return { sql: clauses.join(' AND '), args };
  }
  private ordered(projectId: string, filters: RecordFilters) {
    const { sql, args } = this.where(projectId, filters);
    return this.of(projectId)
      .prepare(`SELECT r.* FROM records r WHERE ${sql} ORDER BY r.date, r.time, r.createdAt, r.id`)
      .all(...args) as Record<string, unknown>[];
  }
  /** Counts over the whole project (before filters). */
  counts(projectId: string): RecordCounts {
    const db = this.of(projectId);
    const counts: RecordCounts = { state: {}, type: {}, source: {}, chapter: {} };
    for (const key of ['state', 'type', 'source', 'chapter'] as const)
      for (const row of db
        .prepare(`SELECT ${key} AS k, count(*) AS n FROM records WHERE projectId=? GROUP BY ${key}`)
        .all(projectId))
        counts[key][row.k === null ? '' : String(row.k)] = Number(row.n);
    return counts;
  }
  /** Ordered by date, time, createdAt (ARCH-01). `limit`/`offset` page the matching rows. */
  list(projectId: string, filters: RecordFilters = {}): RecordListResponse {
    const all = this.ordered(projectId, filters);
    const offset = Math.max(0, Math.floor(filters.offset ?? 0));
    const limit = filters.limit === undefined ? all.length : Math.max(0, Math.floor(filters.limit));
    return {
      records: this.rowsOf(projectId, all.slice(offset, offset + limit)),
      total: all.length,
      counts: this.counts(projectId),
    };
  }

  // ---- Writing ----

  private checkParts(db: DatabaseSync, projectId: string, parts: string[]) {
    const known = db.prepare('SELECT 1 FROM parts WHERE projectId=? AND id=?');
    for (const part of parts)
      if (!known.get(projectId, part)) throw new DomainError('PART_NOT_FOUND');
  }
  private setParts(db: DatabaseSync, projectId: string, recordId: string, parts: string[]) {
    this.checkParts(db, projectId, parts);
    db.prepare('DELETE FROM record_parts WHERE projectId=? AND recordId=?').run(
      projectId,
      recordId,
    );
    const insert = db.prepare('INSERT OR IGNORE INTO record_parts VALUES(?,?,?)');
    for (const part of parts) insert.run(projectId, recordId, part);
  }
  private exists(db: DatabaseSync, projectId: string, id: string) {
    return Boolean(
      db.prepare('SELECT 1 FROM records WHERE projectId=? AND id=?').get(projectId, id),
    );
  }

  /**
   * A new record. The AI (`by: 'ai'`) only makes candidates (RECORD_AI_FORBIDDEN otherwise). A
   * `sourceKey` already held is RECORD_SOURCE_DUPLICATE with `existingId`.
   */
  add(projectId: string, input: unknown, options: RecordAddOptions): RecordRow {
    const data = parse(recordInputSchema, input);
    const ai = options.by === AI_AUTHOR;
    const state = options.state ?? (ai ? 'candidate' : 'kept');
    if (!RECORD_STATES.includes(state)) invalid();
    if (ai && state !== 'candidate') throw new DomainError('RECORD_AI_FORBIDDEN');
    const source = options.source ?? 'manual';
    if (!RECORD_SOURCES.includes(source)) invalid();
    if (!options.by.trim()) invalid();
    const sourceKey = options.sourceKey?.trim() || null;
    const now = this.now();
    const at = now.toISOString();
    const id = randomUUID();
    const row = this.tx(projectId, (db) => {
      if (sourceKey) {
        const held = db
          .prepare('SELECT id FROM records WHERE projectId=? AND sourceKey=?')
          .get(projectId, sourceKey);
        if (held)
          throw new RecordRefusal('RECORD_SOURCE_DUPLICATE', { existingId: String(held.id) });
      }
      for (const to of data.follows ?? [])
        if (!this.exists(db, projectId, to)) throw new DomainError('RECORD_NOT_FOUND');
      db.prepare(
        `INSERT INTO records(projectId, id, date, time, source, type, text, state, by, chapter,
          attachments, sourceKey, supersededBy, createdAt, updatedAt, updatedBy)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL)`,
      ).run(
        projectId,
        id,
        data.date ?? localDay(now),
        data.time ?? null,
        source,
        data.type ?? '?',
        data.text,
        state,
        options.by,
        data.chapter ?? null,
        JSON.stringify(data.attachments ?? {}),
        sourceKey,
        at,
        at,
      );
      this.setParts(db, projectId, id, data.parts ?? []);
      const link = db.prepare('INSERT OR IGNORE INTO record_links VALUES(?,?,?)');
      for (const to of data.follows ?? []) link.run(projectId, id, to);
      return this.get(projectId, id);
    });
    return this.changed(projectId, row);
  }

  /**
   * Many new records in one transaction (가져오기, PLAN-53 T-329·T-330): the rules of `add`, but
   * no row is read back (`add` in a loop reads every link per record). A `sourceKey` already held
   * — before or earlier in the batch — is skipped with its `existingId`. Any invalid input refuses
   * the whole batch (INVALID_INPUT).
   */
  addMany(
    projectId: string,
    items: readonly { input: unknown; sourceKey?: string }[],
    options: Omit<RecordAddOptions, 'sourceKey'>,
  ): { added: string[]; skipped: { sourceKey: string; existingId: string }[] } {
    const ai = options.by === AI_AUTHOR;
    const state = options.state ?? (ai ? 'candidate' : 'kept');
    if (!RECORD_STATES.includes(state)) invalid();
    if (ai && state !== 'candidate') throw new DomainError('RECORD_AI_FORBIDDEN');
    const source = options.source ?? 'manual';
    if (!RECORD_SOURCES.includes(source)) invalid();
    if (!options.by.trim()) invalid();
    const inputs = items.map((item) => ({
      data: parse(recordInputSchema, item.input),
      sourceKey: item.sourceKey?.trim() || null,
    }));
    const now = this.now();
    const at = now.toISOString();
    const result = this.tx(projectId, (db) => {
      const added: string[] = [];
      const skipped: { sourceKey: string; existingId: string }[] = [];
      const held = db.prepare('SELECT id FROM records WHERE projectId=? AND sourceKey=?');
      const insert = db.prepare(
        `INSERT INTO records(projectId, id, date, time, source, type, text, state, by, chapter,
          attachments, sourceKey, supersededBy, createdAt, updatedAt, updatedBy)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL)`,
      );
      const link = db.prepare('INSERT OR IGNORE INTO record_links VALUES(?,?,?)');
      for (const { data, sourceKey } of inputs) {
        if (sourceKey) {
          const existing = held.get(projectId, sourceKey);
          if (existing) {
            skipped.push({ sourceKey, existingId: String(existing.id) });
            continue;
          }
        }
        for (const to of data.follows ?? [])
          if (!this.exists(db, projectId, to)) throw new DomainError('RECORD_NOT_FOUND');
        const id = randomUUID();
        insert.run(
          projectId,
          id,
          data.date ?? localDay(now),
          data.time ?? null,
          source,
          data.type ?? '?',
          data.text,
          state,
          options.by,
          data.chapter ?? null,
          JSON.stringify(data.attachments ?? {}),
          sourceKey,
          at,
          at,
        );
        if (data.parts?.length) this.setParts(db, projectId, id, data.parts);
        for (const to of data.follows ?? []) link.run(projectId, id, to);
        added.push(id);
      }
      return { added, skipped };
    });
    return result.added.length ? this.changed(projectId, result) : result;
  }
  /** Which of `keys` are held, and by which record (one query per 500 keys). */
  heldSourceKeys(projectId: string, keys: readonly string[]): Map<string, string> {
    const db = this.of(projectId);
    const held = new Map<string, string>();
    const unique = [...new Set(keys.filter(Boolean))];
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const rows = db
        .prepare(
          `SELECT sourceKey, id FROM records WHERE projectId=? AND sourceKey IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(projectId, ...chunk) as { sourceKey: string; id: string }[];
      for (const row of rows) held.set(String(row.sourceKey), String(row.id));
    }
    return held;
  }

  /** Text, type, parts, chapter, date, time; keeps who and when. The AI may not change a kept text. */
  patch(projectId: string, id: string, input: unknown, by: string): RecordRow {
    const data = parse(recordPatchSchema, input);
    const row = this.tx(projectId, (db) => {
      const row = this.raw(projectId, id);
      if (!row) throw new DomainError('RECORD_NOT_FOUND');
      if (row.supersededBy !== null && row.supersededBy !== undefined)
        throw new DomainError('RECORD_SUPERSEDED');
      if (by === AI_AUTHOR && data.text !== undefined && row.state === 'kept')
        throw new DomainError('RECORD_AI_FORBIDDEN');
      const sets: string[] = [];
      const args: (string | null)[] = [];
      for (const key of ['text', 'type', 'chapter', 'date', 'time'] as const)
        if (data[key] !== undefined) {
          sets.push(`${key}=?`);
          args.push(data[key] ?? null);
        }
      sets.push('updatedAt=?', 'updatedBy=?');
      args.push(this.stamp(), by);
      db.prepare(`UPDATE records SET ${sets.join(', ')} WHERE projectId=? AND id=?`).run(
        ...args,
        projectId,
        id,
      );
      if (data.parts) this.setParts(db, projectId, id, data.parts);
      return this.get(projectId, id);
    });
    return this.changed(projectId, row);
  }

  /**
   * A correction that changes the meaning (SPEC-17.2): a new kept record (same parts, chapter and
   * date, source 'manual') replaces the old one, which points at it (`supersededBy` and a link).
   */
  correct(projectId: string, id: string, input: unknown, by: string): RecordRow {
    const data = parse(recordCorrectSchema, input);
    if (by === AI_AUTHOR) throw new DomainError('RECORD_AI_FORBIDDEN');
    const row = this.tx(projectId, () => {
      const old = this.get(projectId, id);
      if (old.supersededBy) throw new DomainError('RECORD_SUPERSEDED');
      const now = this.now();
      const created = this.add(
        projectId,
        {
          date: localDay(now),
          time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
          type: data.type ?? old.type,
          text: data.text,
          parts: old.parts,
          ...(old.chapter ? { chapter: old.chapter } : {}),
          attachments: old.attachments,
        },
        { by, state: 'kept', source: 'manual' },
      );
      const db = this.of(projectId);
      db.prepare(
        'UPDATE records SET supersededBy=?, updatedAt=?, updatedBy=? WHERE projectId=? AND id=?',
      ).run(created.id, this.stamp(), by, projectId, id);
      db.prepare('INSERT OR IGNORE INTO record_links VALUES(?,?,?)').run(projectId, id, created.id);
      return this.get(projectId, created.id);
    });
    return this.changed(projectId, row);
  }

  /** O · X · 지움 (back to candidate). The AI may only leave a record a candidate. */
  setState(projectId: string, id: string, state: RecordState, by: string): RecordRow {
    this.setStates(projectId, [id], state, by);
    return this.get(projectId, id);
  }
  /** One state for many records (보이는 것 전체 O/X); all or nothing. Returns the count changed. */
  setStates(projectId: string, ids: string[], state: RecordState, by: string): number {
    if (!RECORD_STATES.includes(state)) invalid();
    if (by === AI_AUTHOR && state !== 'candidate') throw new DomainError('RECORD_AI_FORBIDDEN');
    const changed = this.tx(projectId, (db) => {
      const update = db.prepare(
        'UPDATE records SET state=?, updatedAt=?, updatedBy=? WHERE projectId=? AND id=? AND state<>?',
      );
      const at = this.stamp();
      let changed = 0;
      for (const id of new Set(ids)) {
        if (!this.exists(db, projectId, id)) throw new DomainError('RECORD_NOT_FOUND');
        changed += Number(update.run(state, at, by, projectId, id, state).changes);
      }
      return changed;
    });
    return changed ? this.changed(projectId, changed) : changed;
  }

  /** `from` led to `to`. Refused when `to` already reaches `from` (or they are the same). */
  link(projectId: string, from: string, to: string): RecordRow {
    const row = this.tx(projectId, (db) => {
      if (!this.exists(db, projectId, from) || !this.exists(db, projectId, to))
        throw new DomainError('RECORD_NOT_FOUND');
      if (from === to || this.reaches(db, projectId, to, from))
        throw new DomainError('RECORD_LINK_CYCLE');
      db.prepare('INSERT OR IGNORE INTO record_links VALUES(?,?,?)').run(projectId, from, to);
      return this.get(projectId, from);
    });
    return this.changed(projectId, row);
  }
  unlink(projectId: string, from: string, to: string): RecordRow {
    const row = this.tx(projectId, (db) => {
      if (!this.exists(db, projectId, from)) throw new DomainError('RECORD_NOT_FOUND');
      db.prepare('DELETE FROM record_links WHERE projectId=? AND fromId=? AND toId=?').run(
        projectId,
        from,
        to,
      );
      return this.get(projectId, from);
    });
    return this.changed(projectId, row);
  }
  private reaches(db: DatabaseSync, projectId: string, start: string, goal: string) {
    const row = db
      .prepare(
        `WITH RECURSIVE reach(id) AS (SELECT ? UNION
          SELECT l.toId FROM record_links l JOIN reach ON l.fromId=reach.id WHERE l.projectId=?)
          SELECT 1 FROM reach WHERE id=? LIMIT 1`,
      )
      .get(start, projectId, goal);
    return Boolean(row);
  }

  /**
   * Each root (a record with no incoming link among the chosen records, and at least one outgoing)
   * with every record it reaches, in list order. A record may sit in several chains.
   */
  chains(projectId: string, filters: { state?: RecordState[] } = {}): RecordChain[] {
    const rows = this.ordered(projectId, filters.state ? { state: filters.state } : {});
    const order = new Map(rows.map((row, i) => [String(row.id), i]));
    const out = new Map<string, string[]>();
    const incoming = new Set<string>();
    for (const row of this.of(projectId)
      .prepare('SELECT fromId, toId FROM record_links WHERE projectId=?')
      .all(projectId)) {
      const from = String(row.fromId),
        to = String(row.toId);
      if (!order.has(from) || !order.has(to)) continue;
      const list = out.get(from);
      if (list) list.push(to);
      else out.set(from, [to]);
      incoming.add(to);
    }
    const chains: RecordChain[] = [];
    for (const row of rows) {
      const root = String(row.id);
      if (incoming.has(root) || !out.has(root)) continue;
      const seen = new Set([root]);
      const stack = [root];
      while (stack.length)
        for (const next of out.get(stack.pop()!) ?? [])
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
      chains.push({ root, ids: [...seen].sort((a, b) => order.get(a)! - order.get(b)!) });
    }
    return chains;
  }

  /** One letter per record in list order: o kept, x dropped, . candidate. */
  exportMarks(projectId: string, filters: RecordFilters = {}): { marks: string; ids: string[] } {
    const rows = this.ordered(projectId, filters);
    return {
      marks: rows.map((row) => MARK_OF[String(row.state) as RecordState] ?? '.').join(''),
      ids: rows.map((row) => String(row.id)),
    };
  }
  /** The marks back onto the same records; lengths must match (RECORD_MARKS_MISMATCH). */
  importMarks(projectId: string, ids: string[], marks: string, by: string): number {
    const letters = [...marks];
    if (letters.length !== ids.length)
      throw new RecordRefusal('RECORD_MARKS_MISMATCH', {
        expected: ids.length,
        got: letters.length,
      });
    if (letters.some((letter) => !(letter in STATE_OF))) invalid();
    if (by === AI_AUTHOR) throw new DomainError('RECORD_AI_FORBIDDEN');
    return this.tx(projectId, () => {
      let changed = 0;
      for (const state of RECORD_STATES) {
        const chosen = ids.filter((_, i) => STATE_OF[letters[i]!] === state);
        if (chosen.length) changed += this.setStates(projectId, chosen, state, by);
      }
      return changed;
    });
  }
  /** One record row (API shape) per line. */
  toJsonl(projectId: string, filters: RecordFilters = {}): string {
    return this.rowsOf(projectId, this.ordered(projectId, filters))
      .map((row) => JSON.stringify(row) + '\n')
      .join('');
  }

  // ---- 부위 사전 ----

  private partOf(row: Record<string, unknown>): PartRow {
    return {
      id: String(row.id),
      name: String(row.name),
      grp: str(row.grp),
      roleFrom: str(row.roleFrom),
      roleTo: str(row.roleTo),
      chapter: str(row.chapter),
      mapping: json<PartMapping[]>(row.mapping, []),
      seenAt: str(row.seenAt),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
  }
  parts(projectId: string): PartRow[] {
    return this.of(projectId)
      .prepare('SELECT * FROM parts WHERE projectId=? ORDER BY grp, name, createdAt, id')
      .all(projectId)
      .map((row) => this.partOf(row));
  }
  part(projectId: string, id: string): PartRow {
    const row = this.of(projectId)
      .prepare('SELECT * FROM parts WHERE projectId=? AND id=?')
      .get(projectId, id);
    if (!row) throw new DomainError('PART_NOT_FOUND');
    return this.partOf(row);
  }
  addPart(projectId: string, input: unknown): PartRow {
    const data = parse(partInputSchema, input);
    const id = randomUUID();
    const at = this.stamp();
    this.of(projectId)
      .prepare('INSERT INTO parts VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        projectId,
        id,
        data.name,
        data.grp || null,
        data.roleFrom || null,
        data.roleTo || null,
        data.chapter || null,
        JSON.stringify(data.mapping ?? []),
        data.seenAt ?? null,
        at,
        at,
      );
    return this.changed(projectId, this.part(projectId, id));
  }
  /** Changes the given fields only. */
  setPart(projectId: string, id: string, input: unknown): PartRow {
    const data = parse(partPatchSchema, input);
    const old = this.part(projectId, id);
    const next = {
      name: data.name ?? old.name,
      grp: data.grp === undefined ? old.grp : data.grp || null,
      roleFrom: data.roleFrom === undefined ? old.roleFrom : data.roleFrom || null,
      roleTo: data.roleTo === undefined ? old.roleTo : data.roleTo || null,
      chapter: data.chapter === undefined ? old.chapter : data.chapter || null,
      mapping: data.mapping ?? old.mapping,
      seenAt: data.seenAt === undefined ? old.seenAt : data.seenAt,
    };
    this.of(projectId)
      .prepare(
        `UPDATE parts SET name=?, grp=?, roleFrom=?, roleTo=?, chapter=?, mapping=?, seenAt=?,
          updatedAt=? WHERE projectId=? AND id=?`,
      )
      .run(
        next.name,
        next.grp,
        next.roleFrom,
        next.roleTo,
        next.chapter,
        JSON.stringify(next.mapping),
        next.seenAt,
        this.stamp(),
        projectId,
        id,
      );
    return this.changed(projectId, this.part(projectId, id));
  }
  /** The part goes; its records stay, only unattached from it. */
  removePart(projectId: string, id: string): { id: string } {
    const removed = this.tx(projectId, (db) => {
      this.part(projectId, id);
      db.prepare('DELETE FROM record_parts WHERE projectId=? AND partId=?').run(projectId, id);
      db.prepare('DELETE FROM parts WHERE projectId=? AND id=?').run(projectId, id);
      return { id };
    });
    return this.changed(projectId, removed);
  }

  // ---- 마일스톤 ----

  milestones(projectId: string): MilestoneRow[] {
    return this.of(projectId)
      .prepare('SELECT id, label, date FROM milestones WHERE projectId=? ORDER BY date, label, id')
      .all(projectId)
      .map((row) => ({ id: String(row.id), label: String(row.label), date: String(row.date) }));
  }
  addMilestone(projectId: string, input: unknown): MilestoneRow {
    const data = parse(milestoneInputSchema, input);
    const row = { id: randomUUID(), label: data.label, date: data.date };
    this.of(projectId)
      .prepare('INSERT INTO milestones VALUES(?,?,?,?)')
      .run(projectId, row.id, row.label, row.date);
    return this.changed(projectId, row);
  }
  removeMilestone(projectId: string, id: string): { id: string } {
    const result = this.of(projectId)
      .prepare('DELETE FROM milestones WHERE projectId=? AND id=?')
      .run(projectId, id);
    if (!Number(result.changes)) throw new DomainError('MILESTONE_NOT_FOUND');
    return this.changed(projectId, { id });
  }
}
