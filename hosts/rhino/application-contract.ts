import { z } from 'zod';
import { hostTargetSchema } from '../../src/contracts/host-documents.ts';
const movementSchema = z.object({ id: z.string(), delta: z.array(z.number()).length(3) });
export type Movement = z.infer<typeof movementSchema>;
export const applicationPayloadSchema = hostTargetSchema.extend({
  documentHash: z.string(),
  candidateHash: z.string(),
  movements: z.array(movementSchema).optional(),
});
export const applicationCandidateSchema = z.object({ filename: z.string() }).passthrough();
export const nativeApplicationPayloadSchema = applicationPayloadSchema.extend({
  movements: z.array(movementSchema).min(1).max(500),
});
