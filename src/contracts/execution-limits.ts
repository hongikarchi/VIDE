import { z } from 'zod';

/**
 * A request's limits (SPEC-02.6). Since ADR-031 8 (T-122) only `timeoutSeconds` acts, as the time
 * a turn may go without any output (idle, not elapsed); `maxToolCalls` and `maxHostCommands` stay
 * in the contract for stored requests and the limits panel but no longer stop a turn.
 */
export const executionLimitsSchema = z
  .object({
    maxToolCalls: z.number().int().min(1).max(100),
    maxHostCommands: z.number().int().min(1).max(48),
    timeoutSeconds: z.number().int().min(30).max(600),
  })
  .strict();
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;
/** Single requests outside a conversation (and linked two-target runs): the earlier defaults. */
export const requestLimits: ExecutionLimits = {
  maxToolCalls: 30,
  maxHostCommands: 12,
  timeoutSeconds: 180,
};
/**
 * A conversation turn (modeling, data or make) and the answer turn of its question cards: the
 * schema maxima, so the AI can read, check and correct its work within one turn (SPEC-02.6).
 */
export const conversationTurnLimits: ExecutionLimits = {
  maxToolCalls: 100,
  maxHostCommands: 48,
  timeoutSeconds: 600,
};
export function executionLimits(input: {
  executionLimits?: ExecutionLimits;
  linkedTargets?: unknown[];
  conversationId?: string;
}): ExecutionLimits {
  if (input.executionLimits) return input.executionLimits;
  if (typeof input.conversationId === 'string') return { ...conversationTurnLimits };
  return input.linkedTargets ? { ...requestLimits, maxToolCalls: 60 } : { ...requestLimits };
}
