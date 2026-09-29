// Stage 10: status brief (PLAN-08 K0-T2). What is decided, what is blocked, what changed recently —
// per discipline from its issue notes, then one project page from the discipline briefs. Cites are
// kept only when the source issue note already cites them.
import { logRun, tx } from './db.mjs';
import { DISCIPLINES } from './issues.mjs';
import { claude, pool, usage } from './llm.mjs';

const RECENT_DAYS = 30;
const ints = (list) => (Array.isArray(list) ? list.map(Number).filter(Number.isInteger) : []);

export async function brief(db) {
  const started = performance.now();
  const meter = usage();
  db.exec(`create table if not exists brief(scope text primary key, body text, built_at text);`);
  const issues = db.prepare('select id, discipline, title, status, summary, note from issue').all();
  const cited = new Map(
    issues.map((i) => {
      const note = JSON.parse(i.note);
      const ids = ['conclusions', 'conditions', 'open', 'history'].flatMap((k) =>
        (note[k] ?? []).flatMap((x) => x.cite ?? []),
      );
      return [i.id, new Set(ids)];
    }),
  );
  const last = db
    .prepare("select max(said_on) as d from statement where said_on like '20%'")
    .get().d;
  const since = new Date(Date.parse(last) - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  // Only keep issue ids that exist in the scope and cites that the issue itself used.
  const clean = (items, allowed) =>
    (Array.isArray(items) ? items : [])
      .map((x) => {
        const issue = Number(x.issue);
        if (!allowed.has(issue)) return undefined;
        return {
          ...x,
          text: String(x.text ?? '').trim(),
          issue,
          cite: ints(x.cite).filter((c) => cited.get(issue)?.has(c)),
        };
      })
      .filter((x) => x && x.text);
  const rules =
    `기준일: 자료의 마지막 날짜 ${last}. "바뀐 것"은 ${since} 이후 변경만, 날짜 오름차순.\n` +
    `규칙: 주어진 내용만. 수치·날짜·주체는 그대로. 측정값·일반 기준처럼 설계 판단을 바꾸지 않는 세부는 빼고, 설계를 묶는 결정·조건만 "정해진 것"에 둔다. ` +
    `"막힌 것"은 무엇을 누구에게서 기다리는지와 그 시작 날짜를 쓴다. 각 항목은 한 문장. issue는 근거 이슈 번호, cite는 그 이슈에 적힌 근거 번호.\n`;

  const scopes = Object.keys(DISCIPLINES).filter((d) => issues.some((i) => i.discipline === d));
  const briefs = {};
  await pool(scopes, 6, async (d) => {
    const own = issues.filter((i) => i.discipline === d);
    const text = own
      .map((i) => `## 이슈 ${i.id} · ${i.title} (${i.status})\n요약: ${i.summary}\n${i.note}`)
      .join('\n\n');
    const reply = await claude(
      meter,
      `건축 프로젝트의 "${DISCIPLINES[d]}" 분야 이슈 노트들이다. 이 분야의 현황을 설계자가 1분 안에 읽도록 요약하라.\n${rules}` +
        `JSON으로만: {"state":"현재 상태 한 문장","decided":[{"text":"","issue":0,"cite":[],"date":"YYYY-MM-DD"}],` +
        `"blocked":[{"text":"","waiting":"기다리는 주체","since":"YYYY-MM-DD","issue":0,"cite":[]}],"changed":[{"date":"YYYY-MM-DD","text":"","issue":0,"cite":[]}]}\n` +
        `decided·blocked·changed는 각각 중요한 순서로 5개 이하.\n\n${text}`,
    ).catch(() => undefined);
    if (!reply) return;
    const allowed = new Set(own.map((i) => i.id));
    briefs[d] = {
      label: DISCIPLINES[d],
      state: String(reply.state ?? ''),
      decided: clean(reply.decided, allowed).slice(0, 5),
      blocked: clean(reply.blocked, allowed).slice(0, 5),
      changed: clean(reply.changed, allowed)
        .filter((x) => !x.date || x.date >= since)
        .slice(0, 5),
    };
  });
  const allIssues = new Set(issues.map((i) => i.id));
  const name = db.prepare("select value from meta where key = 'project_name'").get()?.value ?? '';
  const project = await claude(
    meter,
    `건축 프로젝트 "${name}"의 분야별 현황 요약이다. 이것으로 프로젝트 전체를 처음 보는 설계자가 1분 안에 맥락을 잡는 한 장을 만들라.\n${rules}` +
      `JSON으로만: {"overview":"무엇을·어디에·규모·현재 단계를 2~3문장","decided":[{"text":"","discipline":"분야키","issue":0,"cite":[],"date":""}],` +
      `"blocked":[{"text":"","waiting":"","since":"","discipline":"","issue":0,"cite":[]}],"changed":[{"date":"","text":"","discipline":"","issue":0,"cite":[]}]}\n` +
      `decided·blocked·changed는 분야를 가로질러 가장 중요한 것 각각 7개 이하. 분야키: ${JSON.stringify(DISCIPLINES)}\n\n${JSON.stringify(briefs)}`,
    { model: 'opus' },
  ).catch(() => undefined);
  const withDiscipline = (items) =>
    clean(items, allIssues).map((x) => ({
      ...x,
      discipline: issues.find((i) => i.id === x.issue).discipline,
    }));
  const page = project && {
    overview: String(project.overview ?? ''),
    decided: withDiscipline(project.decided).slice(0, 7),
    blocked: withDiscipline(project.blocked).slice(0, 7),
    changed: withDiscipline(project.changed)
      .filter((x) => !x.date || x.date >= since)
      .slice(0, 7),
  };
  const at = new Date().toISOString();
  const put = db.prepare('insert or replace into brief(scope, body, built_at) values(?, ?, ?)');
  tx(db, () => {
    db.exec('delete from brief');
    if (page) put.run('project', JSON.stringify({ ...page, asOf: last, since }), at);
    for (const [d, body] of Object.entries(briefs)) put.run(d, JSON.stringify(body), at);
  });
  const result = {
    asOf: last,
    since,
    disciplines: Object.keys(briefs).length,
    project: !!page,
    claude: { calls: meter.llmCalls, in: meter.llmIn, out: meter.llmOut },
  };
  result.ms = logRun(db, 'brief', started, {
    items: issues.length,
    llmCalls: meter.llmCalls,
    llmIn: meter.llmIn,
    llmOut: meter.llmOut,
    note: JSON.stringify(result),
  });
  return result;
}
