import { z } from 'zod';
import { DomainError } from '../contracts/errors.ts';
import type { Records } from '../core/records.ts';

/**
 * 검토본과 함께 기록 (PLAN-53 T-335, ARCH-01 §5 「검토본과 함께 기록」, SPEC-17.1·17.6): the optional
 * `record` of `POST …/reviews` — a decision (D) or a reason (E) kept with the snapshot. The key is
 * read here before `Reviews.create` (whose input drops unknown keys). A remote session that sends it
 * is FORBIDDEN before the snapshot is made; a record that cannot be added never undoes the snapshot
 * and answers as `record: {error}`.
 */
export const reviewRecordSchema = z
  .object({
    type: z.enum(['D', 'E']),
    text: z.string().max(20_000).optional(),
  })
  .strict();
export type ReviewRecordInput = z.infer<typeof reviewRecordSchema>;

/** The body's `record`, checked; undefined when absent. Remote → FORBIDDEN, malformed → INVALID_INPUT. */
export function reviewRecordInput(body: unknown, remote: boolean): ReviewRecordInput | undefined {
  const raw = body && typeof body === 'object' ? (body as { record?: unknown }).record : undefined;
  if (raw === undefined || raw === null) return undefined;
  if (remote) throw new DomainError('FORBIDDEN');
  const parsed = reviewRecordSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError('INVALID_INPUT');
  return parsed.data;
}

/** The kept record of a saved 검토본: `source: 'manual'` (SPEC-17 R-87), `sourceKey: review:<id>`. */
export function addReviewRecord(
  records: Records,
  projectId: string,
  review: { id: string; requestId: string; title: string },
  record: ReviewRecordInput,
  by: string,
): { id: string } | { error: string } {
  try {
    const row = records.add(
      projectId,
      {
        type: record.type,
        text: record.text?.trim() || review.title,
        attachments: { reviewId: review.id, requestId: review.requestId },
      },
      {
        by: by.trim() || 'user',
        state: 'kept',
        source: 'manual',
        sourceKey: 'review:' + review.id,
      },
    );
    return { id: row.id };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { error: typeof code === 'string' ? code : 'UNEXPECTED' };
  }
}
