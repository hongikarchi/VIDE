// Stage 5: which excerpts carry a decision, request, condition or opinion — Jev with a confidence
// cascade. Confident Jev answers are kept; uncertain ones go to Claude. Unique texts only.
import { logRun, tx } from './db.mjs';
import { jev, claude, pool, usage } from './llm.mjs';

export const LABELS = {
  decision: 'A decision or agreement that was made (확정·합의 사항)',
  request: 'A request, instruction or demand addressed to someone (요청·지시)',
  condition: 'A design condition, constraint, requirement or criterion, e.g. loads, dimensions, regulations (조건·제약·기준)',
  opinion: 'A review comment, concern, objection or proposal (검토 의견·우려·제안)',
  info: 'Factual information, schedule, status or data with no decision or request (정보·일정·현황)',
  none: 'No substantive content: greetings, signatures, titles, labels, contents, boilerplate, bare numbers (내용 없음)',
};
const STRUCTURAL =
  'The text is relevant to structural design: loads, columns, beams, slabs, spans, foundations, soil, structural safety or review, steel members, reinforcement, deflection, vibration.';

export const context = (row) =>
  `Architecture project document. Source: ${row.rel_path.split('/').slice(-3).join('/')} · ${row.locator}\n\n${row.text.slice(0, 6000)}`;

async function jevLabel(meter, row) {
  const answers = await jev(meter, context(row), {
    label: { type: 'choice', instructions: 'What kind of content does this excerpt mainly contain?', criteria: LABELS },
    structural: { type: 'noul', instructions: STRUCTURAL, criteria: { true: 'relevant to structural design', false: 'not relevant to structural design' } },
  });
  return { label: answers.label?.choice, prob: answers.label?.confidence ?? 0, structural: answers.structural?.noul ?? 0 };
}

/** Claude labels a batch; used for uncertain excerpts and for the audit sample. */
export async function claudeLabels(meter, rows) {
  const items = rows.map((r, i) => `### ${i}\n${context(r).slice(0, 1500)}`).join('\n\n');
  const reply = await claude(
    meter,
    `아래 건축 프로젝트 문서 발췌마다 주된 내용 종류 하나와 구조 설계 관련 여부를 판정하라.\n종류: ${JSON.stringify(LABELS)}\n구조 설계 관련: ${STRUCTURAL}\n` +
      `JSON 배열로만 답하라: [{"i":번호,"label":"키","structural":true|false}]\n\n${items}`,
  );
  return new Map(reply.map((x) => [Number(x.i), x]));
}

const batches = (rows, size) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, i * size + size));

export async function select(db, _root, args) {
  const started = performance.now();
  const i = args.indexOf('--threshold');
  const threshold = i >= 0 ? Number(args[i + 1]) : 0.8;
  const rows = db
    .prepare(`select e.id, e.text, e.text_sha, e.locator, s.rel_path from excerpt e join source s on s.id = e.source_id
      where e.id in (select min(id) from excerpt group by text_sha) and e.text_sha not in (select text_sha from selection)`)
    .all();
  const jevMeter = usage(),
    llmMeter = usage();
  let t = performance.now();
  const labels = await pool(rows, 16, (row) => jevLabel(jevMeter, row).catch((error) => ({ error: error.message })));
  const jevMs = Math.round(performance.now() - t);
  const put = db.prepare(`insert or replace into selection(text_sha, excerpt_id, jev_label, jev_prob, jev_structural, route, llm_label, final_label)
    values(?, ?, ?, ?, ?, ?, ?, ?)`);
  const route = (l) => (l.error || l.prob < threshold ? 'llm' : l.label === 'none' ? 'reject' : 'accept');
  const uncertain = rows.filter((_, k) => route(labels[k]) === 'llm');
  t = performance.now();
  const llm = new Map();
  await pool(batches(uncertain, 40), 3, async (batch) => {
    const result = await claudeLabels(llmMeter, batch);
    batch.forEach((row, k) => llm.set(row.id, result.get(k)));
  });
  const llmMs = Math.round(performance.now() - t);
  tx(db, () =>
    rows.forEach((row, k) => {
      const l = labels[k], r = route(l), c = llm.get(row.id);
      put.run(row.text_sha, row.id, l.label ?? null, l.prob ?? 0, c ? (c.structural ? 1 : 0) : l.structural ?? 0, r, c?.label ?? null, r === 'llm' ? c?.label ?? null : l.label);
    }),
  );
  const result = {
    excerpts: rows.length, threshold,
    accept: labels.filter((l) => route(l) === 'accept').length,
    reject: labels.filter((l) => route(l) === 'reject').length,
    llm: uncertain.length, jevErrors: labels.filter((l) => l.error).length,
    jev: { ms: jevMs, calls: jevMeter.jevCalls, tokens: jevMeter.jevTokens },
    claude: { ms: llmMs, calls: llmMeter.llmCalls, in: llmMeter.llmIn, out: llmMeter.llmOut },
  };
  result.ms = logRun(db, 'select', started, { items: rows.length, jevCalls: jevMeter.jevCalls, jevTokens: jevMeter.jevTokens, llmCalls: llmMeter.llmCalls, llmIn: llmMeter.llmIn, llmOut: llmMeter.llmOut, note: JSON.stringify(result) });
  return result;
}
