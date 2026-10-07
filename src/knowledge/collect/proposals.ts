// 할 일·일정 proposals from collected material (SPEC-01.14 11, PLAN-42 T-196): after a collection,
// Opus reads the new dated statements (decisions, requests, conditions, schedules — from minutes,
// schedules and mail especially) and proposes agenda items with their evidence. Nothing is added
// to the agenda here: the dashboard shows the proposals and the person adds the ones they pick.
// Proposals already on the agenda, already proposed, or dismissed before are not proposed again;
// past dates are not proposed.
import {
  agendaCreateSchema,
  agendaDateSchema,
  agendaKindSchema,
  agendaTimeSchema,
  type AgendaItem,
} from '../../contracts/agenda.ts';
import { tx, VISIBLE, type KnowledgeDb } from './schema.ts';
import { Meter, batches, pool, type CollectRunner, type ModelPlan } from './ai.ts';

export interface AgendaProposal {
  id: number;
  text: string;
  kind: 'task' | 'meeting' | 'receipt' | 'deadline';
  date: string;
  time: string | null;
  endDate: string | null;
  endTime: string | null;
  location: string | null;
  attendees: string | null;
  evidence: { id: number; content: string; path: string }[];
  createdAt: string;
}

const squash = (text: string) =>
  text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
/** The same item: text without spaces and punctuation, lower case, plus its date. */
export const proposalKey = (text: string, date: string | null) => `${squash(text)}|${date ?? ''}`;

/** Items already known, by date: one is the same as another when one text contains the other. */
export class Taken {
  private readonly byDate = new Map<string, string[]>();
  add(text: string, date: string | null) {
    const list = this.byDate.get(date ?? '') ?? [];
    list.push(squash(text));
    this.byDate.set(date ?? '', list);
  }
  has(text: string, date: string | null) {
    const t = squash(text);
    return (this.byDate.get(date ?? '') ?? []).some(
      (k) => k === t || k.includes(t) || t.includes(k),
    );
  }
}

export const DATED =
  /\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}\s*[./월]\s*\d{1,2}|요일|까지|마감|회의|협의|미팅|제출|접수|일정/;

/** Candidates: statements of this run (id above `after`) that carry a date or a schedule word. */
function candidates(db: KnowledgeDb, after: number) {
  return (
    db
      .prepare(
        `select st.id, st.kind, st.party, st.subject, st.content, st.quote, st.said_on, s.rel_path as path,
          (select value from source_meta m where m.source_id = s.id and m.key = 'type') as type
          from statement st join excerpt e on e.id = st.excerpt_id join source s on s.id = e.source_id
          where st.id > ? and ${VISIBLE} and st.kind in ('decision','request','condition','info','opinion')
          order by st.id`,
      )
      .all(after) as {
      id: number;
      kind: string;
      party: string;
      subject: string;
      content: string;
      quote: string;
      said_on: string | null;
      path: string;
      type: string | null;
    }[]
  ).filter(
    (r) =>
      ['minutes', 'schedule', 'mail'].includes(r.type ?? '') ||
      DATED.test(r.content) ||
      DATED.test(r.quote),
  );
}

/**
 * Asks for proposals from the statements made after statement `after` and keeps the new ones.
 * `agenda` is the project's current list; `today` the PC's local date (YYYY-MM-DD).
 */
export async function proposeAgenda(
  {
    db,
    runner,
    plan,
    signal,
  }: { db: KnowledgeDb; runner: CollectRunner; plan: ModelPlan; signal?: AbortSignal },
  after: number,
  agenda: readonly AgendaItem[],
  today: string,
) {
  const rows = candidates(db, after);
  if (!rows.length) return { statements: 0, proposed: 0 };
  const byId = new Map(rows.map((r) => [r.id, r]));
  const taken = new Taken();
  for (const item of agenda) taken.add(item.text, item.date);
  const earlier = db.prepare('select key, text, date, status from agenda_proposal').all() as {
    key: string;
    text: string;
    date: string;
    status: string;
  }[];
  for (const p of earlier) taken.add(p.text, p.date);
  const known = [
    ...agenda.filter((i) => i.date && i.date >= today).map((i) => `${i.date} ${i.text}`),
    ...earlier.map((p) => `${p.date} ${p.text} (${p.status === 'dismissed' ? '버림' : '제안됨'})`),
  ].slice(-200);
  const meter = new Meter();
  const add =
    db.prepare(`insert into agenda_proposal(key, text, kind, date, time, end_date, end_time, location, attendees, evidence, status, created)
    values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`);
  let proposed = 0;
  await pool(
    batches(rows, 80),
    2,
    async (batch) => {
      let reply: Record<string, unknown>[];
      try {
        reply = await meter.ask<Record<string, unknown>[]>(runner, {
          role: 'propose',
          choice: plan.propose,
          signal,
          prompt:
            `오늘은 ${today}이다. 아래는 건축 프로젝트 자료(회의록·일정표·메일 등)에서 새로 뽑은 진술이다(ID | 말한 날짜 | 주체 | 종류 | 대상 | 내용 | 파일).\n` +
            `이 프로젝트 담당자가 대시보드의 할 일·일정에 넣을 만한 항목을 제안하라. 날짜가 정해진 회의·협의, 제출·접수, 마감, 기한이 있는 요청만.\n` +
            `규칙: 진술에 적힌 날짜만 쓴다(말한 날짜 기준으로 '다음 주 화요일' 같은 말을 실제 날짜로 바꿔도 된다). 오늘 이전 날짜는 넣지 않는다. 날짜를 알 수 없으면 넣지 않는다.\n` +
            `이미 있는 항목과 같은 일은 넣지 않는다:\n${known.join('\n') || '(없음)'}\n` +
            `kind: task(할 일) | meeting(협의·회의) | receipt(제출·접수) | deadline(마감). text는 80자 이내 한국어. time·endTime은 HH:MM, 없으면 null.\n` +
            `JSON 배열로만: [{"text":"","kind":"meeting","date":"YYYY-MM-DD","time":null,"endDate":null,"endTime":null,"location":null,"attendees":null,"cite":[12]}]\n\n` +
            batch
              .map(
                (r) =>
                  `S${r.id} | ${r.said_on ?? ''} | ${r.party || '?'} | ${r.kind} | ${r.subject} | ${r.content} | ${r.path.split('/').slice(-2).join('/')}`,
              )
              .join('\n'),
        });
      } catch {
        return;
      }
      tx(db, () => {
        for (const x of Array.isArray(reply) ? reply : []) {
          const item = proposalOf(x, today);
          if (!item) continue;
          if (taken.has(item.text, item.date)) continue;
          const cite = (Array.isArray(x.cite) ? x.cite : [])
            .map((c) => Number(String(c).replace(/^S/, '')))
            .filter((c) => byId.has(c));
          if (!cite.length) continue; // A proposal always has its evidence.
          taken.add(item.text, item.date);
          add.run(
            proposalKey(item.text, item.date),
            item.text,
            item.kind,
            item.date,
            item.time,
            item.endDate,
            item.endTime,
            item.location,
            item.attendees,
            JSON.stringify(cite),
            new Date().toISOString(),
          );
          proposed++;
        }
      });
    },
    signal,
  );
  return { statements: rows.length, proposed, ...meter.usage(), failed: meter.failed };
}

/** A valid future-dated agenda item from an AI answer, or undefined. */
export function proposalOf(x: Record<string, unknown>, today: string) {
  const text = typeof x.text === 'string' ? x.text.trim().slice(0, 200) : '';
  const date = agendaDateSchema.safeParse(x.date);
  if (!text || !date.success || date.data < today) return undefined;
  const optional = <T>(
    schema: { safeParse(v: unknown): { success: boolean; data?: T } },
    v: unknown,
  ) => {
    const parsed = schema.safeParse(v);
    return parsed.success ? (parsed.data as T) : null;
  };
  const kind = agendaKindSchema.safeParse(x.kind);
  const time = optional<string>(agendaTimeSchema, x.time);
  let endDate = optional<string>(agendaDateSchema, x.endDate);
  if (endDate && endDate <= date.data) endDate = null;
  let endTime = time ? optional<string>(agendaTimeSchema, x.endTime) : null;
  if (endTime && !endDate && time && endTime <= time) endTime = null;
  const value = {
    text,
    kind: kind.success ? kind.data : 'task',
    date: date.data,
    time,
    endDate,
    endTime,
    location:
      typeof x.location === 'string' && x.location.trim() ? x.location.trim().slice(0, 200) : null,
    attendees:
      typeof x.attendees === 'string' && x.attendees.trim()
        ? x.attendees.trim().slice(0, 300)
        : null,
  };
  return agendaCreateSchema.safeParse(value).success ? value : undefined;
}

/** Pending proposals with their evidence statements, earliest date first. */
export function pendingProposals(db: KnowledgeDb, today: string): AgendaProposal[] {
  const rows = db
    .prepare(
      `select id, text, kind, date, time, end_date, end_time, location, attendees, evidence, created
        from agenda_proposal where status = 'pending' and date >= ? order by date, coalesce(time, ''), id`,
    )
    .all(today) as Record<string, string | number | null>[];
  const statement = db.prepare(
    `select st.id, st.content, s.rel_path as path from statement st join excerpt e on e.id = st.excerpt_id
      join source s on s.id = e.source_id where st.id = ?`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    text: String(r.text),
    kind: agendaKindSchema.catch('task').parse(r.kind),
    date: String(r.date),
    time: (r.time as string | null) ?? null,
    endDate: (r.end_date as string | null) ?? null,
    endTime: (r.end_time as string | null) ?? null,
    location: (r.location as string | null) ?? null,
    attendees: (r.attendees as string | null) ?? null,
    evidence: (JSON.parse(String(r.evidence ?? '[]')) as number[])
      .map((id) => statement.get(id) as { id: number; content: string; path: string } | undefined)
      .filter((s): s is { id: number; content: string; path: string } => !!s),
    createdAt: String(r.created),
  }));
}

/** Marks proposals added (with the agenda item made) or dismissed. */
export function decideProposals(
  db: KnowledgeDb,
  decisions: readonly { id: number; status: 'added' | 'dismissed'; agendaId?: string }[],
) {
  const set = db.prepare(
    "update agenda_proposal set status = ?, decided = ?, agenda_id = ? where id = ? and status = 'pending'",
  );
  const at = new Date().toISOString();
  return tx(db, () =>
    decisions.reduce(
      (n, d) => n + Number(set.run(d.status, at, d.agendaId ?? null, d.id).changes),
      0,
    ),
  );
}
