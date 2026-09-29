// One-off audit (node support-audit-excerpt.mjs <knowledge.sqlite>): are excerpt-level supports real (Claude check)?
import { DatabaseSync } from 'node:sqlite';
import { claude, usage } from './llm.mjs';
const db = new DatabaseSync(process.argv[2]);
const rows = db.prepare(`select st.content, e.text from statement st join excerpt e on e.id = st.excerpt_id where st.support_basis = 'excerpt' order by random() limit 40`).all();
const meter = usage();
const reply = await claude(meter, `각 항목에서 발췌(excerpt)가 요약(content)을 뒷받침하는지 판정하라. 요약이 발췌 내용을 바꿔 말한 것이면 true, 발췌에 없는 내용을 덧붙였거나 다르면 false.\nJSON 배열로만: [{"i":번호,"supported":true|false}]\n\n` +
  rows.map((r, i) => `### ${i}\ncontent: ${r.content}\nexcerpt: ${r.text.slice(0, 2000)}`).join('\n\n'));
const res = { n: rows.length, claudeSupported: reply.filter((x) => x.supported).length, meter };
db.prepare("insert or replace into meta(key, value) values('support_audit_excerpt', ?)").run(JSON.stringify(res));
console.log(JSON.stringify(res));
