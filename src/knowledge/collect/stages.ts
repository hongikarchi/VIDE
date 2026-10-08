// AI stages of the collector (SPEC-08.9 3): filtering unique excerpt texts (Haiku), statements
// with exact quotes (Sonnet, in parallel) and issue notes (Opus). Prompts follow the knowledge-crawl
// spike (select.mjs, statements.mjs, issues.mjs). Only new or changed texts are sent: a text keeps
// its selection, an excerpt its statements, a statement its issue.
import { tx, VISIBLE, type KnowledgeDb } from './schema.ts';
import { Meter, batches, pool, type CollectRunner, type ModelPlan } from './ai.ts';
import { DATED } from './proposals.ts';
import { RULE_DATA, RULE_SHORT, ruleOf } from './filters.ts';

export interface StageContext {
  db: KnowledgeDb;
  runner: CollectRunner;
  plan: ModelPlan;
  signal?: AbortSignal;
  progress: (done: number, total: number) => void;
}

export const LABELS = {
  decision: 'A decision or agreement that was made (확정·합의 사항)',
  request: 'A request, instruction or demand addressed to someone (요청·지시)',
  condition:
    'A design condition, constraint, requirement or criterion, e.g. loads, dimensions, regulations (조건·제약·기준)',
  opinion: 'A review comment, concern, objection or proposal (검토 의견·우려·제안)',
  info: 'Factual information, schedule, status or data with no decision or request (정보·일정·현황)',
  none: 'No substantive content: greetings, signatures, titles, labels, contents, boilerplate, bare numbers (내용 없음)',
};
const STRUCTURAL =
  'The text is relevant to structural design: loads, columns, beams, slabs, spans, foundations, soil, structural safety or review, steel members, reinforcement, deflection, vibration.';
export const DISCIPLINES: Record<string, string> = {
  structure: '구조',
  civil: '토목·유수지',
  landscape: '조경',
  facade: '파사드·외장',
  mep: '조명·전기·설비',
  fire: '소방·피난·안전',
  permit: '인허가·심의·법규',
  design: '건축 계획·디자인',
  cost: '공사비·계약·업무 범위',
  schedule: '일정·진행',
  other: '기타',
};

// A data file (T-261) counts for the parts with a sentence in it; its first lines (excerpt kind
// 'data') are never sent.
const live = "s.skip is null and coalesce(s.status, 'done') in ('done', 'data')";

/**
 * Haiku labels each new unique text. Very short texts (under 8 letters) and number or data
 * fragments (filters.ts `isDataFragment`) are 'none' by rule without a call, their reason on
 * `selection.reason`.
 */
export async function selectExcerpts({ db, runner, plan, signal, progress }: StageContext) {
  const rows = db
    .prepare(
      `select e.id, e.text, e.text_sha, e.locator, s.rel_path from excerpt e join source s on s.id = e.source_id
        where e.id in (select min(e2.id) from excerpt e2 join source s on s.id = e2.source_id where ${live} and e2.kind <> 'data' group by e2.text_sha)
        and e.text_sha not in (select text_sha from selection) order by e.id`,
    )
    .all() as { id: number; text: string; text_sha: string; locator: string; rel_path: string }[];
  const put =
    db.prepare(`insert or replace into selection(text_sha, excerpt_id, route, llm_label, final_label)
    values(?, ?, ?, ?, ?)`);
  const ruled = rows.map((r) => ({ row: r, reason: ruleOf(r.text) }));
  const byRule =
    db.prepare(`insert or replace into selection(text_sha, excerpt_id, route, llm_label, final_label, reason)
    values(?, ?, 'rule', null, 'none', ?)`);
  tx(db, () => {
    for (const { row, reason } of ruled) if (reason) byRule.run(row.text_sha, row.id, reason);
  });
  const short = ruled.filter((r) => r.reason === RULE_SHORT).length;
  const data = ruled.filter((r) => r.reason === RULE_DATA).length;
  const ask = ruled.filter((r) => !r.reason).map((r) => r.row);
  const meter = new Meter();
  let done = 0;
  progress(0, ask.length);
  await pool(
    batches(ask, 40),
    4,
    async (batch) => {
      const items = batch
        .map(
          (r, i) =>
            `### ${i}\nSource: ${r.rel_path.split('/').slice(-3).join('/')} · ${r.locator}\n\n${r.text.slice(0, 1500)}`,
        )
        .join('\n\n');
      try {
        const reply = await meter.ask<{ i: number; label: string; structural?: boolean }[]>(
          runner,
          {
            role: 'filter',
            choice: plan.filter,
            signal,
            prompt:
              `아래 건축 프로젝트 문서 발췌마다 주된 내용 종류 하나와 구조 설계 관련 여부를 판정하라.\n종류: ${JSON.stringify(LABELS)}\n구조 설계 관련: ${STRUCTURAL}\n` +
              `JSON 배열로만 답하라: [{"i":번호,"label":"키","structural":true|false}]\n\n${items}`,
          },
        );
        const byIndex = new Map(reply.map((x) => [Number(x.i), x]));
        tx(db, () =>
          batch.forEach((row, i) => {
            const x = byIndex.get(i);
            const label = x && x.label in LABELS ? x.label : null;
            if (!label) return; // Unanswered: asked again next time.
            put.run(row.text_sha, row.id, 'llm', label, label);
            if (x?.structural)
              db.prepare('update selection set jev_structural = 1 where text_sha = ?').run(
                row.text_sha,
              );
          }),
        );
      } catch {
        /* A failed batch is asked again next time. */
      }
      progress((done += batch.length), ask.length);
    },
    signal,
  );
  return {
    texts: rows.length,
    short,
    data,
    asked: ask.length,
    ...meter.usage(),
    failed: meter.failed,
  };
}

const squash = (text: string) => text.replace(/\s+/g, '');

/** Sonnet turns selected excerpts into statements with an exact quote (batches of 12, 6 at once). */
export async function extractStatements({ db, runner, plan, signal, progress }: StageContext) {
  const all = db
    .prepare(
      `select e.id, e.source_id, e.text, e.locator, s.rel_path, x.final_label as label,
        x.jev_structural as structural,
        (select value from source_meta m where m.source_id = s.id and m.key = 'type') as type
        from selection x join excerpt e on e.id = x.excerpt_id join source s on s.id = e.source_id
        where ${live} and x.final_label in ('decision','request','condition','opinion','info')
        and e.id not in (select excerpt_id from statement_done) and e.id not in (select excerpt_id from statement)
        order by e.id`,
    )
    .all() as {
    id: number;
    source_id: number;
    text: string;
    locator: string;
    rel_path: string;
    label: string;
    structural: number | null;
    type: string | null;
  }[];
  // Plain information counts when it is structural, from minutes, schedules or mail, or dated
  // (dated information feeds the 할 일·일정 proposals).
  const rows = all.filter(
    (r) =>
      r.label !== 'info' ||
      (r.structural ?? 0) >= 0.5 ||
      ['minutes', 'schedule', 'mail'].includes(r.type ?? '') ||
      DATED.test(r.text),
  );
  const metaOf = db.prepare('select key, value from source_meta where source_id = ?');
  const mailOf = db.prepare(
    'select sent_at, from_name, from_addr, subject from mail where source_id = ?',
  );
  const describe = (row: (typeof rows)[number]) => {
    const meta = Object.fromEntries(
      (metaOf.all(row.source_id) as { key: string; value: string }[]).map((m) => [m.key, m.value]),
    );
    const mail = mailOf.get(row.source_id) as Record<string, string> | undefined;
    const head = [`파일: ${row.rel_path}`, `위치: ${row.locator}`];
    if (meta.day) head.push(`폴더 날짜: ${meta.day}`);
    if (mail)
      head.push(
        `메일: ${mail.sent_at} · 보낸 사람 ${mail.from_name} <${mail.from_addr}> · 제목 ${mail.subject}`,
      );
    return { text: head.join('\n'), day: mail?.sent_at?.slice(0, 10) ?? meta.day ?? null };
  };
  const add =
    db.prepare(`insert into statement(excerpt_id, kind, party, subject, content, quote, said_on, structural, quote_ok, status)
    values(?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai')`);
  const markDone = db.prepare('insert or ignore into statement_done(excerpt_id) values(?)');
  const meter = new Meter();
  let done = 0;
  progress(0, rows.length);
  await pool(
    batches(rows, 12),
    6,
    async (batch) => {
      const described = batch.map(describe);
      const items = batch
        .map((r, k) => `### ${k}\n${described[k].text}\n---\n${r.text.slice(0, 3000)}`)
        .join('\n\n');
      try {
        const reply = await meter.ask<Record<string, unknown>[]>(runner, {
          role: 'extract',
          choice: plan.extract,
          signal,
          prompt:
            `건축 설계 프로젝트 문서 발췌다. 각 발췌에서 누가 무엇을 결정·요청·요구·제시했는지 진술을 뽑아라.\n` +
            `규칙: 발췌에 실제로 있는 내용만. 인사·서명·목차·단순 수치 나열은 제외. 진술이 없으면 뽑지 않는다.\n` +
            `kind: decision(확정·합의) | request(요청·지시) | condition(설계 조건·제약·기준, 하중·치수·법규 포함) | opinion(검토 의견·우려·제안) | info(구조 설계·일정에 쓰일 사실·데이터)\n` +
            `party: 그 말을 한 주체(기관·회사·사람). 파일 경로·메일 정보로 추정할 수 있으면 쓰고, 모르면 빈 문자열.\n` +
            `subject: 무엇에 관한 것인지. content: 한 문장 한국어 요약(날짜·시각·장소가 있으면 그대로 넣는다). quote: 발췌 원문에서 그대로 복사한 연속 구간(200자 이하).\n` +
            `structural: 구조 설계에 관계되면 true.\n` +
            `JSON 배열로만 답하라: [{"i":발췌번호,"kind":"","party":"","subject":"","content":"","quote":"","structural":false}]\n\n${items}`,
        });
        tx(db, () => {
          for (const s of Array.isArray(reply) ? reply : []) {
            const k = Number(s.i);
            const row = batch[k];
            if (!row || typeof s.content !== 'string' || !s.content.trim()) continue;
            const quote = typeof s.quote === 'string' ? s.quote : '';
            const ok = quote && squash(row.text).includes(squash(quote)) ? 1 : 0;
            add.run(
              row.id,
              String(s.kind ?? 'info'),
              String(s.party ?? ''),
              String(s.subject ?? ''),
              s.content,
              quote,
              described[k].day,
              s.structural ? 1 : 0,
              ok,
            );
          }
          for (const row of batch) markDone.run(row.id);
        });
      } catch {
        /* A failed batch is asked again next time. */
      }
      progress((done += batch.length), rows.length);
    },
    signal,
  );
  return { excerpts: rows.length, ...meter.usage(), failed: meter.failed };
}

interface Line {
  id: number;
  kind: string;
  party: string;
  subject: string;
  content: string;
  said_on: string | null;
}
const line = (r: Line) =>
  `S${r.id} | ${r.said_on ?? ''} | ${r.party || '?'} | ${r.kind} | ${r.subject} | ${r.content}`;
const cites = (list: unknown, known: (id: number) => boolean) =>
  Array.isArray(list)
    ? list
        .map((c) => Number(String(c).replace(/^S/, '')))
        .filter((c) => Number.isInteger(c) && known(c))
    : [];

/**
 * Issue notes, incrementally: new visible statements get a discipline and an issue title (existing
 * titles are offered first); every issue whose visible members changed gets its note written again;
 * an issue with no visible member left is removed.
 */
export async function updateIssues({ db, runner, plan, signal, progress }: StageContext) {
  const statementSql = `select st.id, st.kind, coalesce(a.party, st.party) as party, st.subject, st.content, st.said_on
    from statement st left join party_alias a on a.alias = st.party where ${VISIBLE}`;
  const fresh = db
    .prepare(
      `${statementSql} and st.id not in (select statement_id from statement_issue) order by st.id`,
    )
    .all() as unknown as Line[];
  const existing = db.prepare('select id, discipline, title from issue').all() as {
    id: number;
    discipline: string;
    title: string;
  }[];
  const meter = new Meter();
  const touched = new Set<number>();
  // Issues whose visible member count no longer matches (statements removed, hidden or back).
  for (const row of db
    .prepare(
      `select i.id from issue i where coalesce(i.statements, 0) <> (select count(*) from statement_issue si
        join statement st on st.id = si.statement_id where si.issue_id = i.id and ${VISIBLE})`,
    )
    .all() as { id: number }[])
    touched.add(row.id);
  if (!fresh.length && !touched.size) return { statements: 0, issues: 0 };
  const titles = (d: string) => existing.filter((i) => i.discipline === d).map((i) => i.title);
  const known = existing.length
    ? `기존 이슈(분야: 제목들): ${JSON.stringify(
        Object.fromEntries(
          Object.keys(DISCIPLINES)
            .map((d) => [d, titles(d)])
            .filter(([, t]) => t.length),
        ),
      )}\n같은 쟁점이면 기존 제목을 그대로 쓴다.\n`
    : '';
  const labelled = new Map<number, { d: string; t: string }>();
  const work = batches(fresh, 120);
  let done = 0;
  progress(0, work.length);
  await pool(
    work,
    4,
    async (batch) => {
      try {
        const reply = await meter.ask<{ id: number; d: string; t: string }[]>(runner, {
          role: 'issues',
          choice: plan.issues,
          signal,
          prompt:
            `건축 프로젝트 진술 목록이다(ID | 날짜 | 주체 | 종류 | 대상 | 내용). 각 진술의 분야 하나와 이슈 제목을 정하라.\n` +
            `분야: ${JSON.stringify(DISCIPLINES)}\n이슈 제목: 무엇에 관한 쟁점인지 20자 이내 명사구. 같은 쟁점이면 같은 제목을 쓴다.\n${known}` +
            `JSON 배열로만: [{"id":12,"d":"분야키","t":"이슈 제목"}]\n\n${batch.map(line).join('\n')}`,
        });
        const ids = new Set(batch.map((r) => r.id));
        for (const x of Array.isArray(reply) ? reply : [])
          if (ids.has(Number(x.id)))
            labelled.set(Number(x.id), {
              d: x.d in DISCIPLINES ? x.d : 'other',
              t:
                String(x.t ?? '')
                  .trim()
                  .slice(0, 60) || '기타',
            });
      } catch {
        /* Unlabelled statements are asked again next time. */
      }
      progress(++done, work.length);
    },
    signal,
  );
  // Members join an existing issue of the same discipline and title, or a new one.
  const issueId = new Map(existing.map((i) => [`${i.discipline}\u0000${i.title}`, i.id]));
  const addIssue = db.prepare(
    "insert into issue(discipline, title, status, summary, note, statements) values(?, ?, 'open', '', '{}', 0)",
  );
  const link = db.prepare(
    'insert or replace into statement_issue(statement_id, issue_id, discipline, raw_title) values(?, ?, ?, ?)',
  );
  tx(db, () => {
    for (const [id, l] of labelled) {
      const key = `${l.d}\u0000${l.t}`;
      let issue = issueId.get(key);
      if (issue === undefined) {
        issue = Number(addIssue.run(l.d, l.t).lastInsertRowid);
        issueId.set(key, issue);
      }
      link.run(id, issue, l.d, l.t);
      touched.add(issue);
    }
  });
  // Notes of the touched issues, from their visible members.
  const membersOf = db.prepare(
    `${statementSql} and st.id in (select statement_id from statement_issue where issue_id = ?)
      order by coalesce(st.said_on, '9'), st.id`,
  );
  const issueOf = db.prepare('select discipline, title from issue where id = ?');
  const save = db.prepare(
    'update issue set status = ?, summary = ?, note = ?, statements = ? where id = ?',
  );
  const dropIssue = db.prepare('delete from issue where id = ?');
  const unlink = db.prepare('delete from statement_issue where issue_id = ?');
  const list = [...touched];
  let written = 0,
    removed = 0;
  progress(0, list.length);
  await pool(
    list,
    4,
    async (id) => {
      const members = (membersOf.all(id) as unknown as Line[]).slice(-300);
      const issue = issueOf.get(id) as { discipline: string; title: string } | undefined;
      if (!issue) return;
      if (!members.length) {
        tx(db, () => {
          unlink.run(id);
          dropIssue.run(id);
        });
        removed++;
        return;
      }
      const ids = new Set(members.map((m) => m.id));
      try {
        const note = await meter.ask<Record<string, unknown>>(runner, {
          role: 'issues',
          choice: plan.issues,
          signal,
          prompt:
            `건축 프로젝트의 "${DISCIPLINES[issue.discipline] ?? issue.discipline} · ${issue.title}" 이슈에 관한 진술 목록이다(ID | 날짜 | 주체 | 종류 | 대상 | 내용). 회의록처럼 핵심만 정리하라.\n` +
            `규칙: 목록에 있는 내용만. 수치는 그대로. 날짜가 다른 진술이 서로 다르면 최신을 결론으로 두고 open에 차이를 적는다. 근거 ID를 cite에 넣는다.\n` +
            `JSON으로만: {"status":"open|settled","summary":"한 문장 현재 상태","conclusions":[{"text":"","cite":[12]}],"conditions":[{"text":"","cite":[]}],` +
            `"open":[{"text":"","cite":[]}],"history":[{"date":"YYYY-MM-DD","party":"","text":"","cite":[]}]}\n` +
            `history는 결정·입장이 바뀐 핵심 순간만 8개 이하.\n\n${members.map(line).join('\n')}`,
        });
        for (const part of ['conclusions', 'conditions', 'open', 'history'])
          note[part] = (Array.isArray(note[part]) ? (note[part] as Record<string, unknown>[]) : [])
            .filter((x) => x && typeof x === 'object')
            .map((x) => ({ ...x, cite: cites(x.cite, (c) => ids.has(c)) }));
        save.run(
          note.status === 'settled' ? 'settled' : 'open',
          String(note.summary ?? ''),
          JSON.stringify(note),
          members.length,
          id,
        );
        written++;
      } catch {
        /* The note stays as it was; the count mismatch brings it back next time. */
      }
      progress(written + removed, list.length);
    },
    signal,
  );
  // A status brief written by the spike for a changed discipline would be out of date.
  const hasBrief = !!db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'brief'")
    .get();
  if (hasBrief && (written || removed)) db.exec('delete from brief');
  return {
    statements: fresh.length,
    labelled: labelled.size,
    written,
    removed,
    ...meter.usage(),
    failed: meter.failed,
  };
}
