// Stage 8: query test — "conditions to consider in structural design", answered only from verified
// statements, each line citing statement IDs that resolve to file, location and quote.
import { writeFileSync } from 'node:fs';
import { logRun } from './db.mjs';
import { claude, usage } from './llm.mjs';

export async function query(db, _root, _args, dbPath) {
  const started = performance.now();
  const meter = usage();
  const rows = db
    .prepare(`select st.id, st.kind, coalesce(a.party, st.party) as party, st.subject, st.content, st.said_on
      from statement st left join party_alias a on a.alias = st.party
      where st.structural = 1 and st.quote_ok = 1 and coalesce(st.support_prob, 1) >= 0.5
      order by st.said_on, st.id`)
    .all();
  const lines = rows.map((r) => `S${r.id} | ${r.said_on ?? ''} | ${r.party || '?'} | ${r.kind} | ${r.subject} | ${r.content}`).join('\n');
  const answer = await claude(
    meter,
    `아래는 한 건축 프로젝트의 자료에서 뽑은 구조 관련 진술 목록이다(ID | 날짜 | 주체 | 종류 | 대상 | 내용).\n` +
      `질문: 구조 설계를 할 때 고려해야 할 조건은 무엇인가?\n` +
      `규칙: 목록에 있는 내용만 쓴다. 주제별로 묶고, 조건마다 근거 ID를 [S12, S40]처럼 붙인다. 날짜가 다른 진술이 서로 다르면 최신 것을 앞에 쓰고 이전 것과 다르다고 표시한다. ` +
      `수치는 진술에 있는 그대로 쓴다. 마지막에 자료에 근거가 부족하거나 서로 어긋나 확인이 필요한 항목을 따로 적는다.\n` +
      `JSON으로만 답하라: {"topics":[{"topic":"","conditions":[{"text":"","cite":["S12"],"note":""}]}],"open":[{"text":"","cite":[]}]}\n\n${lines}`,
    { timeoutMs: 900000 },
  );
  const byId = new Map(
    db.prepare(`select st.id, st.quote, st.said_on, s.rel_path, e.locator from statement st join excerpt e on e.id = st.excerpt_id
      join source s on s.id = e.source_id`).all().map((r) => [`S${r.id}`, r]),
  );
  const cites = new Set();
  let md = `# 구조 설계 고려 조건 (자동 정리 · AI 추정, 확정 전)\n\n근거 진술 ${rows.length}건에서 정리. 각 항목의 [S번호]는 아래 근거 목록의 파일·위치·원문 인용이다.\n`;
  for (const t of answer.topics ?? []) {
    md += `\n## ${t.topic}\n\n`;
    for (const c of t.conditions ?? []) {
      (c.cite ?? []).forEach((id) => cites.add(id));
      md += `- ${c.text} ${c.cite?.length ? '[' + c.cite.join(', ') + ']' : ''}${c.note ? ` — ${c.note}` : ''}\n`;
    }
  }
  md += `\n## 확인이 필요한 항목\n\n`;
  for (const o of answer.open ?? []) {
    (o.cite ?? []).forEach((id) => cites.add(id));
    md += `- ${o.text} ${o.cite?.length ? '[' + o.cite.join(', ') + ']' : ''}\n`;
  }
  md += `\n## 근거\n\n`;
  let unknown = 0;
  for (const id of [...cites].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
    const r = byId.get(id);
    if (!r) { unknown++; continue; }
    md += `- **${id}** ${r.said_on ?? ''} · \`${r.rel_path}\` · ${r.locator}\n  > ${r.quote.replace(/\s+/g, ' ')}\n`;
  }
  const out = dbPath.replace(/\.sqlite$/, '.structural-conditions.md');
  writeFileSync(out, md, 'utf8');
  const result = { statements: rows.length, topics: answer.topics?.length ?? 0, cited: cites.size, unknownCites: unknown, report: out,
    claude: { calls: meter.llmCalls, in: meter.llmIn, out: meter.llmOut } };
  result.ms = logRun(db, 'query', started, { items: rows.length, llmCalls: meter.llmCalls, llmIn: meter.llmIn, llmOut: meter.llmOut, note: JSON.stringify(result) });
  return result;
}
