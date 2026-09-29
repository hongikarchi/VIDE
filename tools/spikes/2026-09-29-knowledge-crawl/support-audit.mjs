// One-off audit (node support-audit.mjs <knowledge.sqlite>): does Jev's quote-support check agree with Claude?
import { DatabaseSync } from 'node:sqlite';
import { claude, usage } from './llm.mjs';
const db = new DatabaseSync(process.argv[2]);
const pick = (where) => db.prepare(`select id, content, quote, support_prob from statement where quote_ok=1 and ${where} order by random() limit 40`).all();
const rows = [...pick('support_prob < 0.5'), ...pick('support_prob >= 0.5')];
const meter = usage();
const reply = await claude(meter, `각 항목에서 인용(quote)이 요약(content)을 뒷받침하는지 판정하라. 요약이 인용의 내용을 바꿔 말한 것이면 true, 인용에 없는 내용을 덧붙였거나 다르면 false.\nJSON 배열로만: [{"i":번호,"supported":true|false}]\n\n` +
  rows.map((r, i) => `### ${i}\ncontent: ${r.content}\nquote: ${r.quote}`).join('\n\n'));
const m = new Map(reply.map((x) => [Number(x.i), x.supported]));
const weak = rows.slice(0, 40), strong = rows.slice(40);
const res = { weakN: weak.length, weakClaudeSupported: weak.filter((_, i) => m.get(i)).length, strongN: strong.length, strongClaudeSupported: strong.filter((_, i) => m.get(i + 40)).length, meter };
db.prepare("insert or replace into meta(key, value) values('support_audit', ?)").run(JSON.stringify(res));
console.log(JSON.stringify(res));
