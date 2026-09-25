import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const record = z
  .object({
    caseId: z.string().min(1),
    variant: z.enum(['baseline', 'candidate']),
    success: z.boolean(),
    safetyFailure: z.boolean(),
    durationMs: z.number().finite().positive(),
    providerCalls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().nullable(),
    externalCost: z.number().finite().nonnegative().nullable(),
    version: z.string().min(1),
  })
  .strict();
const batch = z.object({ labelsReviewed: z.boolean(), records: z.array(record).min(2) }).strict();
const p95 = (rows) =>
  rows.map((r) => r.durationMs).sort((a, b) => a - b)[Math.ceil(rows.length * 0.95) - 1];
export function compare(raw) {
  const input = batch.parse(raw),
    pairs = new Map();
  for (const row of input.records) {
    const pair = pairs.get(row.caseId) || {};
    if (pair[row.variant]) throw Error('DUPLICATE_RESULT');
    pair[row.variant] = row;
    pairs.set(row.caseId, pair);
  }
  if ([...pairs.values()].some((p) => !p.baseline || !p.candidate)) throw Error('UNPAIRED_RESULTS');
  const baseline = [...pairs.values()].map((p) => p.baseline),
    candidate = [...pairs.values()].map((p) => p.candidate);
  const failures = (rows) => rows.filter((r) => !r.success).length;
  const reduction = 1 - p95(candidate) / p95(baseline);
  return {
    cases: pairs.size,
    baselineP95Ms: p95(baseline),
    candidateP95Ms: p95(candidate),
    reduction,
    extraFailures: failures(candidate) - failures(baseline),
    candidateSafetyFailures: candidate.filter((r) => r.safetyFailure).length,
    unknownCost: input.records.some((r) => r.externalCost === null),
    unknownTokens: input.records.some((r) => r.inputTokens === null),
    criteriaMet:
      input.labelsReviewed &&
      pairs.size >= 60 &&
      candidate.every((r) => !r.safetyFailure) &&
      failures(candidate) <= failures(baseline) &&
      reduction >= 0.1,
    adoptionApproved: false,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('RESULT_FILE_REQUIRED');
  console.log(
    JSON.stringify(compare(JSON.parse(await readFile(process.argv[2], 'utf8'))), null, 2),
  );
}
