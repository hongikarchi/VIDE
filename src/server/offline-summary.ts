import type { Agenda } from '../core/agenda.ts';
import { AGENDA_TEXT_MAX, type AgendaItem } from '../contracts/agenda.ts';
import type { DocumentLinks } from '../core/document-links.ts';
import { DomainError, type Store } from '../core/store.ts';
import type { AgendaEdit, AgendaEditResult } from './remote-access.ts';

// PLAN-33 (ADR-035): what of a project leaves this PC so it opens on the account site while the
// PC is off, and how 할 일 edits made there come back. The history summary is the request text,
// the answer's first lines, state, time and the linked file names; never the model, attachments,
// pins, sketches, the AI provider or model, or tool records. Each part has a cheap fingerprint so
// an unchanged project costs one small query per heartbeat.

const AGENDA_SHARED_MAX = 500;
const DONE_SHARED_MAX = 100;
const HISTORY_SHARED_MAX = 50;
const BODY_MAX = 600;
const ANSWER_LINES = 3;
const ANSWER_MAX = 400;

const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;

/** The 할 일 to share: every open item and the latest done ones, in the user's order. */
export function agendaShare(store: Store, agenda: Agenda, projectId: string) {
  const row = store
    .db(projectId)
    .prepare(
      `SELECT count(*) AS n, coalesce(max(updatedAt),'') AS u, total(revision) AS r, total(ord) AS o
       FROM agenda_items WHERE projectId=?`,
    )
    .get(projectId) as { n: number; u: string; r: number; o: number };
  return {
    key: `${row.n}|${row.u}|${row.r}|${row.o}`,
    items: () => {
      const all = agenda.list(projectId);
      const done = new Set(
        all
          .filter((item) => item.done)
          .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
          .slice(0, DONE_SHARED_MAX)
          .map((item) => item.id),
      );
      return all
        .filter((item) => !item.done || done.has(item.id))
        .slice(0, AGENDA_SHARED_MAX)
        .map((item) => ({
          id: item.id,
          text: item.text,
          date: item.date,
          time: item.time,
          kind: item.kind,
          doneAt: item.doneAt,
          order: item.order,
          revision: item.revision,
          updatedAt: item.updatedAt,
        }));
    },
  };
}

/** One shared history row: exactly these fields (the site keeps nothing else). */
export interface HistorySummaryItem {
  id: string;
  body: string;
  answer: string | null;
  state: string;
  createdAt: string;
  files: string[];
}

/** The answer's first lines (a summary, not the whole answer). */
export function answerLines(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, ANSWER_LINES);
  return lines.length ? clip(lines.join('\n'), ANSWER_MAX) : null;
}

/**
 * The latest requests of the project as the history list shows them: the user's requests, not
 * the Syncs of linked files, a multi-file request once (not its per-file parts), hidden ones out.
 */
export function historySummary(store: Store, links: DocumentLinks, projectId: string) {
  const db = store.db(projectId);
  const where = `w.projectId=? AND coalesce(json_extract(w.input,'$.source'),'')!='document'
    AND json_extract(w.input,'$.parentRequestId') IS NULL
    AND w.id NOT IN (SELECT requestId FROM hidden_requests WHERE projectId=?)`;
  const key = (
    db
      .prepare(
        `SELECT group_concat(k, ',') AS k FROM (SELECT w.id||':'||w.state AS k FROM workspace_requests w
         WHERE ${where} ORDER BY w.rowid DESC LIMIT ${HISTORY_SHARED_MAX})`,
      )
      .get(projectId, projectId) as { k: string | null }
  ).k;
  return {
    key: key ?? '',
    items: (): HistorySummaryItem[] => {
      const names = new Map<string, string>();
      try {
        for (const link of links.list(projectId)) names.set(link.id, link.name);
      } catch {
        /* No links table yet: no file names. */
      }
      const linkOf = db.prepare(
        "SELECT json_extract(input,'$.linkId') AS linkId FROM workspace_requests WHERE projectId=? AND id=?",
      );
      const rows = db
        .prepare(
          `SELECT w.id, w.state, w.createdAt,
            json_extract(w.input,'$.body') AS body,
            json_extract(w.input,'$.linkId') AS linkId,
            json_extract(w.input,'$.baseRequestId') AS baseRequestId,
            json_extract(w.input,'$.linkedTargets') AS targets,
            json_extract(w.result,'$.text') AS answer
           FROM workspace_requests w WHERE ${where} ORDER BY w.rowid DESC LIMIT ${HISTORY_SHARED_MAX}`,
        )
        .all(projectId, projectId) as {
        id: string;
        state: string;
        createdAt: string;
        body: unknown;
        linkId: unknown;
        baseRequestId: unknown;
        targets: unknown;
        answer: unknown;
      }[];
      const fileOf = (linkId: unknown, base: unknown) => {
        let id = typeof linkId === 'string' ? linkId : undefined;
        if (!id && typeof base === 'string') {
          const row = linkOf.get(projectId, base) as { linkId: unknown } | undefined;
          if (typeof row?.linkId === 'string') id = row.linkId;
        }
        return id ? names.get(id) : undefined;
      };
      return rows.map((row) => {
        const files = new Set<string>();
        const own = fileOf(row.linkId, row.baseRequestId);
        if (own) files.add(own);
        try {
          const targets = typeof row.targets === 'string' ? JSON.parse(row.targets) : [];
          if (Array.isArray(targets))
            for (const target of targets) {
              const name = fileOf(
                undefined,
                (target as { baseRequestId?: unknown })?.baseRequestId,
              );
              if (name) files.add(name);
            }
        } catch {
          /* An unreadable target list adds no names. */
        }
        return {
          id: row.id,
          body: clip(typeof row.body === 'string' ? row.body.trim() : '', BODY_MAX),
          answer: answerLines(row.answer),
          state: /^[a-z-]{1,20}$/.test(row.state) ? row.state : 'unknown',
          createdAt: row.createdAt,
          files: [...files].slice(0, 10).map((name) => clip(name, 260)),
        };
      });
    },
  };
}

const KIND_NAMES = { task: '할 일', meeting: '회의', deadline: '마감' } as const;
/** What a site edit wanted, in a few words (for the conflict note). */
function describe(fields: AgendaEdit['fields'], removed = false) {
  if (removed) return '삭제';
  const parts: string[] = [];
  if (fields.text !== undefined) parts.push(`내용 "${clip(fields.text, 60)}"`);
  if (fields.date !== undefined) parts.push(`날짜 ${fields.date ?? '없음'}`);
  if (fields.time !== undefined) parts.push(`시각 ${fields.time ?? '없음'}`);
  if (fields.kind !== undefined) parts.push(KIND_NAMES[fields.kind]);
  if (fields.done !== undefined) parts.push(fields.done ? '완료' : '미완료');
  return parts.join(', ') || '변경';
}
const stamp = (at: number) => {
  const date = new Date(at),
    pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
/** The item text with a conflict note at the end, within the item's length. */
function noted(text: string, note: string) {
  const suffix = ` [${note}]`;
  return (
    text.slice(0, Math.max(1, AGENDA_TEXT_MAX - suffix.length)) +
    suffix.slice(0, AGENDA_TEXT_MAX - 1)
  );
}
const fieldsOf = (fields: AgendaEdit['fields']) => {
  const { text, date, time, kind, done } = fields;
  return Object.fromEntries(
    Object.entries({ text, date, time, kind, done }).filter(([, value]) => value !== undefined),
  );
};

/**
 * Applies one site edit to the local 할 일. An item unchanged on this PC since the site read it
 * (same revision) takes the edit. Otherwise the later write wins (the site's edit time against the
 * item's last change here) and the item says so: "[사이트 수정 충돌 …]". `madeBy` is the item an
 * earlier version of the same add created (an add changed on the site before it was confirmed).
 */
export function applyAgendaEdit(
  agenda: Agenda,
  edit: AgendaEdit,
  madeBy?: string,
): { outcome: AgendaEditResult['outcome']; itemId?: string } {
  const { projectId } = edit;
  let item: AgendaItem;
  try {
    if (edit.op === 'add' && !madeBy) {
      const { done, ...create } = fieldsOf(edit.fields);
      const added = agenda.add(projectId, create, 'user');
      if (done === true) agenda.set(projectId, added.id, { revision: added.revision, done: true });
      return { outcome: 'applied', itemId: added.id };
    }
    item = agenda.get(projectId, madeBy ?? edit.itemId);
  } catch (error) {
    if (error instanceof DomainError) return { outcome: 'missing', itemId: madeBy };
    throw error;
  }
  const changedHere =
    edit.op !== 'add' && edit.baseRevision !== null && item.revision !== edit.baseRevision;
  const siteLater = edit.editedAt > Date.parse(item.updatedAt);
  try {
    if (!changedHere || siteLater) {
      if (edit.op === 'remove') {
        agenda.remove(projectId, item.id, item.revision);
        return { outcome: changedHere ? 'conflict' : 'applied', itemId: madeBy };
      }
      const fields = fieldsOf(edit.fields);
      if (changedHere)
        fields.text = noted(
          (fields.text as string | undefined) ?? item.text,
          `사이트 수정 충돌 ${stamp(edit.editedAt)}: PC에서 "${clip(item.text, 60)}"로 고친 뒤 사이트 수정(${describe(edit.fields)})이 더 늦어 반영함`,
        );
      agenda.set(projectId, item.id, { ...fields, revision: item.revision });
      return { outcome: changedHere ? 'conflict' : 'applied', itemId: madeBy };
    }
    // The change made here is later: it stays, and the item notes what the site wanted.
    agenda.set(projectId, item.id, {
      revision: item.revision,
      text: noted(
        item.text,
        `사이트 수정 충돌 ${stamp(edit.editedAt)}: 사이트의 ${describe(edit.fields, edit.op === 'remove')}은 PC 수정보다 먼저라 반영하지 않음`,
      ),
    });
    return { outcome: 'conflict', itemId: madeBy };
  } catch (error) {
    // Invalid fields (a date the PC rejects) leave the item as it is.
    if (error instanceof DomainError) return { outcome: 'missing', itemId: madeBy };
    throw error;
  }
}
