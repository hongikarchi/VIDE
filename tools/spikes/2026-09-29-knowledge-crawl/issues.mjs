// Stage 9: issue notes. Verified statements are grouped by discipline and issue, and each issue gets
// a minutes-style note (current conclusion, conditions, open items, key history) citing statement IDs.
// Pass 1 labels statements in batches, pass 2 merges issue titles per discipline, pass 3 writes notes.
import { logRun, tx } from './db.mjs';
import { claude, pool, usage } from './llm.mjs';

export const DISCIPLINES = {
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
const line = (r) => `S${r.id} | ${r.said_on ?? ''} | ${r.party || '?'} | ${r.kind} | ${r.subject} | ${r.content}`;
const cites = (list) => (Array.isArray(list) ? list.map((c) => Number(String(c).replace(/^S/, ''))).filter(Number.isInteger) : []);

export async function issues(db) {
  const started = performance.now();
  const meter = usage();
  db.exec(`create table if not exists issue(id integer primary key, discipline text, title text, status text,
    summary text, note text, statements integer);
    create table if not exists statement_issue(statement_id integer primary key, issue_id integer, discipline text, raw_title text);
    delete from statement_issue; delete from issue;`);
  const rows = db
    .prepare(`select st.id, st.kind, coalesce(a.party, st.party) as party, st.subject, st.content, st.said_on
      from statement st left join party_alias a on a.alias = st.party
      where st.quote_ok = 1 and coalesce(st.support_prob, 1) >= 0.5 order by st.id`)
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Pass 1: discipline and a short issue title per statement.
  const batches = Array.from({ length: Math.ceil(rows.length / 120) }, (_, i) => rows.slice(i * 120, i * 120 + 120));
  const labelled = new Map();
  await pool(batches, 6, async (batch) => {
    const reply = await claude(
      meter,
      `건축 프로젝트 진술 목록이다(ID | 날짜 | 주체 | 종류 | 대상 | 내용). 각 진술의 분야 하나와 이슈 제목을 정하라.\n` +
        `분야: ${JSON.stringify(DISCIPLINES)}\n이슈 제목: 무엇에 관한 쟁점인지 20자 이내 명사구(예: "신설 기둥 기초", "옥상 조경 하중"). 같은 쟁점이면 같은 제목을 쓴다.\n` +
        `JSON 배열로만: [{"id":12,"d":"분야키","t":"이슈 제목"}]\n\n${batch.map(line).join('\n')}`,
    ).catch(() => []);
    for (const x of reply) if (byId.has(Number(x.id))) labelled.set(Number(x.id), { d: DISCIPLINES[x.d] ? x.d : 'other', t: String(x.t ?? '').trim() || '기타' });
  });
  // Pass 2: merge titles into at most a dozen issues per discipline.
  const groups = new Map();
  for (const [id, l] of labelled) {
    if (!groups.has(l.d)) groups.set(l.d, new Map());
    const titles = groups.get(l.d);
    titles.set(l.t, (titles.get(l.t) ?? 0) + 1);
  }
  const canonical = new Map();
  await pool([...groups], 6, async ([d, titles]) => {
    const list = [...titles].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} (${n})`).join('\n');
    const reply = await claude(
      meter,
      `분야 "${DISCIPLINES[d]}"의 이슈 제목 목록이다(괄호는 진술 수). 같은 쟁점을 하나로 합쳐 12개 이하의 이슈로 정리하라. 진술이 적은 잡다한 제목은 "기타"로 모은다.\n` +
        `JSON 객체로만: {"원래 제목":"합친 이슈 제목"}\n\n${list}`,
    ).catch(() => ({}));
    for (const t of titles.keys()) canonical.set(`${d}\u0000${t}`, String(reply[t] ?? t).trim() || '기타');
  });
  const members = new Map();
  for (const [id, l] of labelled) {
    const key = `${l.d}\u0000${canonical.get(`${l.d}\u0000${l.t}`) ?? l.t}`;
    if (!members.has(key)) members.set(key, []);
    members.get(key).push(id);
  }
  // Pass 3: one minutes-style note per issue.
  const addIssue = db.prepare('insert into issue(discipline, title, status, summary, note, statements) values(?, ?, ?, ?, ?, ?)');
  const link = db.prepare('insert or replace into statement_issue(statement_id, issue_id, discipline, raw_title) values(?, ?, ?, ?)');
  let failed = 0;
  await pool([...members], 8, async ([key, ids]) => {
    const [d, title] = key.split('\u0000');
    const list = ids.map((id) => byId.get(id)).sort((a, b) => String(a.said_on ?? '9').localeCompare(String(b.said_on ?? '9')) || a.id - b.id);
    let note;
    try {
      note = await claude(
        meter,
        `건축 프로젝트의 "${DISCIPLINES[d]} · ${title}" 이슈에 관한 진술 목록이다(ID | 날짜 | 주체 | 종류 | 대상 | 내용). 회의록처럼 핵심만 정리하라.\n` +
          `규칙: 목록에 있는 내용만. 수치는 그대로. 날짜가 다른 진술이 서로 다르면 최신을 결론으로 두고 open에 차이를 적는다. 근거 ID를 cite에 넣는다.\n` +
          `JSON으로만: {"status":"open|settled","summary":"한 문장 현재 상태","conclusions":[{"text":"","cite":[12]}],"conditions":[{"text":"","cite":[]}],` +
          `"open":[{"text":"","cite":[]}],"history":[{"date":"YYYY-MM-DD","party":"","text":"","cite":[]}]}\n` +
          `history는 결정·입장이 바뀐 핵심 순간만 8개 이하.\n\n${list.map(line).join('\n')}`,
      );
    } catch {
      failed++;
      note = { status: 'open', summary: '', conclusions: [], conditions: [], open: [], history: [] };
    }
    for (const part of ['conclusions', 'conditions', 'open', 'history'])
      note[part] = (Array.isArray(note[part]) ? note[part] : []).map((x) => ({ ...x, cite: cites(x.cite).filter((c) => byId.has(c)) }));
    tx(db, () => {
      const issueId = Number(addIssue.run(d, title, note.status === 'settled' ? 'settled' : 'open', String(note.summary ?? ''), JSON.stringify(note), ids.length).lastInsertRowid);
      for (const id of ids) link.run(id, issueId, d, labelled.get(id).t);
    });
  });
  const result = {
    statements: rows.length,
    labelled: labelled.size,
    issues: db.prepare('select count(*) as n from issue').get().n,
    byDiscipline: Object.fromEntries(db.prepare('select discipline, count(*) as n from issue group by discipline').all().map((r) => [r.discipline, r.n])),
    failedNotes: failed,
    claude: { calls: meter.llmCalls, in: meter.llmIn, out: meter.llmOut },
  };
  result.ms = logRun(db, 'issues', started, { items: rows.length, llmCalls: meter.llmCalls, llmIn: meter.llmIn, llmOut: meter.llmOut, note: JSON.stringify(result) });
  return result;
}
