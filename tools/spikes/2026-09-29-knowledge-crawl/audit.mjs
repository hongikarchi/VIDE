// Stage 5b: how wrong is "trust Jev when it is confident"? Claude re-labels random samples from the
// accepted and rejected bins; the Claude-routed bin already has both labels.
import { logRun, tx } from './db.mjs';
import { usage } from './llm.mjs';
import { claudeLabels } from './select.mjs';

const SUBSTANTIVE = new Set(['decision', 'request', 'condition', 'opinion']);

export async function audit(db, _root, args) {
  const started = performance.now();
  const i = args.indexOf('--sample');
  const n = i >= 0 ? Number(args[i + 1]) : 30;
  const pick = (route) =>
    db.prepare(`select e.id, e.text, e.locator, s.rel_path, x.text_sha, x.jev_label, x.jev_prob, x.jev_structural
      from selection x join excerpt e on e.id = x.excerpt_id join source s on s.id = e.source_id
      where x.route = ? order by random() limit ?`).all(route, n);
  const meter = usage();
  const put = db.prepare('update selection set audit_label = ? where text_sha = ?');
  const result = { sample: n };
  for (const route of ['accept', 'reject']) {
    const rows = pick(route);
    const labels = await claudeLabels(meter, rows);
    let same = 0, contentAgree = 0, structuralAgree = 0, missedSubstantive = 0;
    const misses = [];
    tx(db, () =>
      rows.forEach((row, k) => {
        const c = labels.get(k) ?? {};
        put.run(c.label ?? null, row.text_sha);
        if (c.label === row.jev_label) same++;
        if ((c.label === 'none') === (row.jev_label === 'none')) contentAgree++;
        if (!!c.structural === row.jev_structural >= 0.5) structuralAgree++;
        if (route === 'reject' && SUBSTANTIVE.has(c.label)) (missedSubstantive++, misses.push(row.id));
      }),
    );
    result[route] = { n: rows.length, sameLabel: same, contentAgree, structuralAgree, ...(route === 'reject' ? { missedSubstantive, misses } : {}) };
  }
  // Claude-routed bin: would Jev's (low-confidence) answer have matched Claude's?
  const routed = db.prepare("select jev_label, llm_label from selection where route = 'llm' and llm_label is not null").all();
  result.llmBin = {
    n: routed.length,
    jevSameAsClaude: routed.filter((r) => r.jev_label === r.llm_label).length,
    jevContentAgree: routed.filter((r) => (r.jev_label === 'none') === (r.llm_label === 'none')).length,
  };
  // Cost of labelling everything with Claude instead, from this audit's own usage.
  const total = db.prepare('select count(*) as n from selection').get().n;
  const labelled = result.accept.n + result.reject.n;
  result.claudeAll = {
    excerpts: total,
    estIn: Math.round((meter.llmIn / labelled) * total),
    estOut: Math.round((meter.llmOut / labelled) * total),
    estMinutes: Math.round(((performance.now() - started) / labelled) * total / 60000),
  };
  result.claude = { calls: meter.llmCalls, in: meter.llmIn, out: meter.llmOut };
  db.prepare('insert or replace into meta(key, value) values(?, ?)').run('audit', JSON.stringify(result));
  result.ms = logRun(db, 'audit', started, { items: labelled, llmCalls: meter.llmCalls, llmIn: meter.llmIn, llmOut: meter.llmOut, note: JSON.stringify(result) });
  return result;
}
