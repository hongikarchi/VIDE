import { z } from 'zod';
import { workspaceRequestSchema } from '../contracts/workspace-result.ts';
import { requestInputSchema } from '../contracts/workspace.ts';
import { api } from './gateway.ts';

export const draftPinSchema = z
  .object({
    id: z.string(),
    basis: z.string(),
    role: z.enum(['target', 'preserve', 'reference']),
    name: z.string().optional(),
    label: z.string().max(40).optional(),
  })
  .passthrough();
export const uiInputSchema = requestInputSchema.safeExtend({
  pins: z.array(draftPinSchema),
  source: z.string().optional(),
  extensionVersion: z.string().optional(),
});
export const uiRequestSchema = workspaceRequestSchema.extend({
  input: uiInputSchema,
  createdAt: z.string().optional(),
});
export type UiRequest = z.infer<typeof uiRequestSchema>;
export async function requestData(path: string, method = 'GET', data?: unknown) {
  return uiRequestSchema.parse(await api(path, method, data));
}
export function requestMessage(value: unknown) {
  const request = uiRequestSchema.parse(value),
    input = request.input;
  return {
    ...input,
    model: input.model || input.provider,
    effort: input.effort || 'default',
    request,
  };
}
export type UiMessage = ReturnType<typeof requestMessage>;
export const modelsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    provider: z.enum(['claude-cli', 'codex-cli']),
    efforts: z.array(z.string()).min(1),
    /** Reads images (SPEC-09.3 6); an older engine says nothing: taken as yes. */
    images: z.boolean().optional(),
  }),
);
export const providersSchema = z.array(
  z.object({ id: z.string(), available: z.boolean() }).passthrough(),
);
export const hostStatusSchema = z
  .object({
    available: z.boolean(),
    mode: z.string().optional(),
    zwcadAvailable: z.boolean().optional(),
  })
  .passthrough();
