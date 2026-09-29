// Stage 7: Jev checks that each quote supports its statement, and proposes party alias merges.
import { logRun, tx } from './db.mjs';
import { jev, pool, usage } from './llm.mjs';

export async function verify(db) {
  const started = performance.now();
  const meter = usage();
  const rows = db.prepare('select id, content, quote from statement where quote_ok = 1 and support_prob is null').all();
  const probs = await pool(rows, 16, async (s) => {
    const a = await jev(meter, `Quoted source text:\n${s.quote}`, {
      support: { type: 'noul', instructions: `The quoted text states or directly supports this claim: ${s.content}`,
        criteria: { true: 'the quote supports the claim', false: 'the quote does not support the claim' } },
    }).catch(() => null);
    return a?.support?.noul ?? null;
  });
  const setSupport = db.prepare('update statement set support_prob = ? where id = ?');
  tx(db, () => rows.forEach((s, k) => probs[k] !== null && setSupport.run(probs[k], s.id)));
  // Quotes are often shorter than the summary. Weak ones are re-checked against the whole excerpt.
  try { db.exec('alter table statement add column support_basis text'); } catch {}
  db.exec("update statement set support_basis = 'quote' where support_prob >= 0.5 and support_basis is null");
  const weakRows = db.prepare(`select st.id, st.content, e.text from statement st join excerpt e on e.id = st.excerpt_id
    where st.quote_ok = 1 and st.support_prob < 0.5 and st.support_basis is null`).all();
  const second = await pool(weakRows, 16, async (s) => {
    const a = await jev(meter, `Source excerpt:
${s.text.slice(0, 6000)}`, {
      support: { type: 'noul', instructions: `The excerpt states or directly supports this claim: ${s.content}`,
        criteria: { true: 'the excerpt supports the claim', false: 'the excerpt does not support the claim' } },
    }).catch(() => null);
    return a?.support?.noul ?? null;
  });
  const setBasis = db.prepare('update statement set support_prob = ?, support_basis = ? where id = ?');
  tx(db, () => weakRows.forEach((s, k) => second[k] !== null && setBasis.run(Math.max(second[k], 0), second[k] >= 0.5 ? 'excerpt' : 'none', s.id)));
  // Party aliases: each less frequent name may be another spelling of a more frequent one.
  const parties = db.prepare("select party, count(*) as n from statement where party <> '' group by party order by n desc").all();
  const canonical = [];
  const put = db.prepare('insert or replace into party_alias(alias, party, method, confidence) values(?, ?, ?, ?)');
  for (const p of parties) {
    const options = canonical.slice(0, 200);
    if (!options.length) { canonical.push(p.party); put.run(p.party, p.party, 'self', 1); continue; }
    const criteria = Object.fromEntries(options.map((c, k) => [`p${k}`, c]));
    criteria.new = 'None of these: a different organization or person';
    const a = await jev(meter, `Name as written in a project document: ${p.party}`, {
      same: { type: 'choice', instructions: 'Which listed organization or person is the same party as this name (different spelling, abbreviation, team of the same organization)?', criteria },
    }).catch(() => null);
    const choice = a?.same?.choice, confidence = a?.same?.confidence ?? 0;
    if (choice && choice !== 'new' && confidence >= 0.8) put.run(p.party, options[Number(choice.slice(1))], 'jev', confidence);
    else (canonical.push(p.party), put.run(p.party, p.party, 'self', 1));
  }
  const stats = db.prepare('select count(*) as n, sum(support_prob >= 0.5) as supported, sum(support_prob < 0.5) as weak from statement where quote_ok = 1').get();
  const result = { checked: rows.length, rechecked: weakRows.length, supported: stats.supported, weak: stats.weak, parties: parties.length, canonical: canonical.length,
    jev: { calls: meter.jevCalls, tokens: meter.jevTokens } };
  result.ms = logRun(db, 'verify', started, { items: rows.length, jevCalls: meter.jevCalls, jevTokens: meter.jevTokens, note: JSON.stringify(result) });
  return result;
}
