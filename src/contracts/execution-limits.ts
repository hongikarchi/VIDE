import { z } from 'zod';

export const executionLimitsSchema = z
  .object({
    maxToolCalls: z.number().int().min(1).max(100),
    maxHostCommands: z.number().int().min(1).max(48),
    timeoutSeconds: z.number().int().min(30).max(600),
  })
  .strict();
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;
export function executionLimits(input: {
  executionLimits?: ExecutionLimits;
  linkedTargets?: unknown[];
}) {
  return (
    input.executionLimits ?? {
      maxToolCalls: input.linkedTargets ? 60 : 30,
      maxHostCommands: 12,
      timeoutSeconds: 180,
    }
  );
}
