// Stage 6: Claude turns selected excerpts into statements (who, about what, what, when) with an
// exact quote. A quote that is not in the excerpt is kept but marked, and never shown as evidence.
import { logRun, tx } from './db.mjs';
import { claude, pool, usage } from './llm.mjs';

const squash = (text) => text.replace(/\s+/g, '');

function describe(db, row) {
  const meta = Object.fromEntries(
    db.prepare('select key, value from source_meta where source_id = ?').all(row.source_id).map((m) => [m.key, m.value]),
  );
  const mail = db.prepare('select sent_at, from_name, from_addr, subject from mail where source_id = ?').get(row.source_id);
  const head = [`파일: ${row.rel_path}`, `위치: ${row.locator}`];
  if (meta.day) head.push(`폴더 날짜: ${meta.day}`);
  if (meta.direction) head.push(`구분: ${meta.direction}${meta.party ? ' · 상대: ' + meta.party : ''}`);
  if (mail) head.push(`메일: ${mail.sent_at} · 보낸 사람 ${mail.from_name} <${mail.from_addr}> · 제목 ${mail.subject}`);
  return head.join('\n');
}

export async function statements(db, _root, args) {
  const started = performance.now();
  const i = args.indexOf('--limit');
  const limit = i >= 0 ? Number(args[i + 1]) : 1e9;
  const rows = db
    .prepare(`select e.id, e.source_id, e.text, e.locator, s.rel_path from selection x
      join excerpt e on e.id = x.excerpt_id join source s on s.id = e.source_id
      where (x.final_label in ('decision','request','condition','opinion') or (x.final_label = 'info' and x.jev_structural >= 0.5))
      and e.id not in (select excerpt_id from statement_done) and e.id not in (select excerpt_id from statement) order by e.id limit ?`)
    .all(limit);
  const meter = usage();
  const add = db.prepare(`insert into statement(excerpt_id, kind, party, subject, content, quote, said_on, structural, quote_ok)
    values(?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const day = (row) =>
    db.prepare('select sent_at from mail where source_id = ?').get(row.source_id)?.sent_at?.slice(0, 10) ??
    db.prepare("select value from source_meta where source_id = ? and key = 'day'").get(row.source_id)?.value ?? null;
  const markDone = db.prepare('insert or ignore into statement_done(excerpt_id) values(?)');
  const batches = Array.from({ length: Math.ceil(rows.length / 12) }, (_, k) => rows.slice(k * 12, k * 12 + 12));
  let failed = 0;
  await pool(batches, 8, async (batch) => {
    const items = batch.map((r, k) => `### ${k}\n${describe(db, r)}\n---\n${r.text.slice(0, 3000)}`).join('\n\n');
    let reply;
    try {
      reply = await claude(
        meter,
        `건축 설계 프로젝트 문서 발췌다. 각 발췌에서 누가 무엇을 결정·요청·요구·제시했는지 진술을 뽑아라.\n` +
          `규칙: 발췌에 실제로 있는 내용만. 인사·서명·목차·단순 수치 나열은 제외. 진술이 없으면 뽑지 않는다.\n` +
          `kind: decision(확정·합의) | request(요청·지시) | condition(설계 조건·제약·기준, 하중·치수·법규 포함) | opinion(검토 의견·우려·제안) | info(구조 설계에 쓰일 사실·데이터)\n` +
          `party: 그 말을 한 주체(기관·회사·사람). 문서 작성 주체를 파일 경로·메일 정보로 추정할 수 있으면 쓰고, 모르면 빈 문자열.\n` +
          `subject: 무엇에 관한 것인지(부재·공간·시설·주제). content: 한 문장 한국어 요약. quote: 발췌 원문에서 그대로 복사한 연속 구간(200자 이하).\n` +
          `structural: 구조 설계(하중·기둥·보·슬래브·기초·지반·구조안전·부재·처짐)에 관계되면 true.\n` +
          `JSON 배열로만 답하라: [{"i":발췌번호,"kind":"","party":"","subject":"","content":"","quote":"","structural":false}]\n\n${items}`,
      );
    } catch {
      failed++;
      return;
    }
    tx(db, () => {
      for (const s of reply) {
        const row = batch[Number(s.i)];
        if (!row || !s.content) continue;
        const ok = s.quote && squash(row.text).includes(squash(s.quote)) ? 1 : 0;
        add.run(row.id, s.kind, s.party ?? '', s.subject ?? '', s.content, s.quote ?? '', day(row), s.structural ? 1 : 0, ok);
      }
      for (const row of batch) markDone.run(row.id);
    });
  });
  const made = db.prepare('select count(*) as n, sum(quote_ok) as ok, sum(structural) as structural from statement').get();
  const result = { excerpts: rows.length, batches: batches.length, failedBatches: failed, statements: made.n, quoteOk: made.ok, structural: made.structural,
    claude: { calls: meter.llmCalls, in: meter.llmIn, out: meter.llmOut } };
  result.ms = logRun(db, 'statements', started, { items: rows.length, llmCalls: meter.llmCalls, llmIn: meter.llmIn, llmOut: meter.llmOut, note: JSON.stringify(result) });
  return result;
}
