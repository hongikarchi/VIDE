// Measure the locator against real history: commit subject = request, changed files = truth.
// Usage: npm run locate:eval -- [--commits 20] [--requests cases.jsonl]
// cases.jsonl lines: {"request": "한국어 요청", "files": ["src/ui/app.ts"]}
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadLocalEnv } from './jev.mjs';
import { buildIndex } from './index.mjs';
import { rankFiles } from './core.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const config = loadLocalEnv();
if (!config.key) {
  console.error('TYPESAFE_API_KEY가 .env에 없습니다.');
  process.exit(2);
}
const index = buildIndex();
const known = new Set(index.map((f) => f.path));
let cases;
if (option('--requests')) {
  cases = readFileSync(option('--requests'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
} else {
  const count = Number(option('--commits') ?? 20);
  const log = execFileSync(
    'git',
    ['log', '--no-merges', '-n', String(count * 4), '--format=%H%x09%s'],
    { encoding: 'utf8' },
  );
  cases = [];
  for (const line of log.split('\n').filter(Boolean)) {
    const [hash, subject] = line.split('\t');
    const files = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', hash], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => known.has(f) && !f.endsWith('.md'));
    // Skip docs-only, formatting and very wide commits: they are not locate tasks.
    if (!files.length || files.length > 12 || /format|prettier|merge/i.test(subject)) continue;
    cases.push({ request: subject, files, commit: hash.slice(0, 7) });
    if (cases.length >= count) break;
  }
}
// Baseline without Jev: word overlap between the request and path + summary.
const words = (text) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 2),
  );
const baseline = (request) => {
  const query = words(request);
  return index
    .map((file) => {
      const target = words(file.path + ' ' + file.summary);
      let score = 0;
      for (const w of query) if (target.has(w)) score++;
      return { path: file.path, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((f) => f.path);
};
const firstRank = (order, truth) =>
  Math.min(...truth.map((f) => (order.includes(f) ? order.indexOf(f) + 1 : Infinity)));
const orderings = {
  fits: (a, b) => b.fits - a.fits || b.probability - a.probability,
  probability: (a, b) => b.probability - a.probability,
  stage1: (a, b) => b.stage1 - a.stage1,
  combined: (a, b) => b.fits + b.probability - (a.fits + a.probability),
  probabilityStage1: (a, b) => b.probability + b.stage1 - (a.probability + a.stage1),
};
const alt = Object.fromEntries(Object.keys(orderings).map((k) => [k, []]));
const base = [];
const rows = [];
for (const item of cases) {
  const { ranked, usage } = await rankFiles(config, item.request, index);
  for (const [name, compare] of Object.entries(orderings))
    alt[name].push(
      firstRank(
        [...ranked].sort(compare).map((f) => f.path),
        item.files,
      ),
    );
  base.push(firstRank(baseline(item.request), item.files));
  const order = ranked.map((f) => f.path);
  const rank = Math.min(
    ...item.files.map((f) => (order.includes(f) ? order.indexOf(f) + 1 : Infinity)),
  );
  const recall5 =
    item.files.filter((f) => order.slice(0, 5).includes(f)).length / item.files.length;
  rows.push({
    ...item,
    rank,
    recall5,
    tokens: usage.input_tokens,
    ms: Math.round(usage.ms.reduce((a, b) => Math.max(a, b), 0)),
  });
  console.log(
    `${rank === Infinity ? '✗' : '#' + rank}\t${item.commit ?? ''}\t${item.request.slice(0, 70)}`,
  );
}
const hit = (k) => rows.filter((r) => r.rank <= k).length / rows.length;
const rate = (ranks, k) => ranks.filter((r) => r <= k).length / ranks.length;
const summary = {
  cases: rows.length,
  hit1: hit(1),
  hit3: hit(3),
  hit5: hit(5),
  recall5: rows.reduce((s, r) => s + r.recall5, 0) / rows.length,
  meanTokens: Math.round(rows.reduce((s, r) => s + r.tokens, 0) / rows.length),
  medianStageMs: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  model: config.model,
  orderings: Object.fromEntries(
    Object.entries(alt).map(([name, ranks]) => [
      name,
      { hit1: rate(ranks, 1), hit3: rate(ranks, 3), hit5: rate(ranks, 5) },
    ]),
  ),
  wordOverlapBaseline: { hit1: rate(base, 1), hit3: rate(base, 3), hit5: rate(base, 5) },
};
console.log(JSON.stringify(summary, null, 2));
