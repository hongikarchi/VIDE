import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
// Offline only. This runner never calls a provider or changes product settings.
export function recommend(input) {
  if (input.explicitEffort) return { effort: input.explicitEffort, reason: 'user' };
  if (input.ambiguous || input.untrustedInstruction) return { effort: null, reason: 'abstain' };
  if (input.documents > 1 || input.constraints > 2 || input.text.length > 1500)
    return { effort: 'high', reason: 'complex' };
  if (input.operation === 'read' && input.documents === 1 && input.constraints === 0)
    return { effort: 'low', reason: 'simple-read' };
  return { effort: null, reason: 'abstain' };
}
export function validateCases(cases) {
  if (cases.length !== 120) throw new Error('EXPECTED_120_CASES');
  const ids = new Set(),
    families = new Map(),
    counts = new Map();
  for (const row of cases) {
    if (ids.has(row.id) || !['development', 'evaluation'].includes(row.split))
      throw new Error('INVALID_CASE');
    ids.add(row.id);
    if (families.has(row.family) && families.get(row.family) !== row.split)
      throw new Error('FAMILY_LEAKAGE');
    families.set(row.family, row.split);
    counts.set(row.category, (counts.get(row.category) || 0) + 1);
    if (!row.basis || row.labelStatus !== 'provisional' || !Array.isArray(row.allowed))
      throw new Error('INVALID_LABEL');
  }
  if (
    counts.size !== 6 ||
    [...counts.values()].some((n) => n !== 20) ||
    cases.filter((r) => r.split === 'evaluation').length !== 60
  )
    throw new Error('UNBALANCED_CASES');
}
export function evaluate(cases) {
  validateCases(cases);
  return ['development', 'evaluation'].map((split) => {
    const rows = cases.filter((r) => r.split === split);
    let abstained = 0,
      matches = 0,
      unsafeLow = 0;
    const times = rows
      .map((row) => {
        const start = performance.now(),
          result = recommend(row.input),
          elapsed = performance.now() - start;
        if (result.effort === null) abstained++;
        if (row.allowed.includes(result.effort)) matches++;
        if (result.effort === 'low' && !row.allowed.includes('low')) unsafeLow++;
        return elapsed;
      })
      .sort((a, b) => a - b);
    return {
      split,
      count: rows.length,
      matches,
      abstained,
      unsafeLow,
      ruleOnlyP50Ms: times[Math.floor(times.length * 0.5)],
      ruleOnlyP95Ms: times[Math.floor(times.length * 0.95)],
      labels: 'provisional',
      productSuccess: null,
      endToEndLatency: null,
      adoptionEligible: false,
    };
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cases = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));
  console.log(JSON.stringify(evaluate(cases), null, 2));
}
