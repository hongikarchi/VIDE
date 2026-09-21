import { z } from 'zod';
import { requestStateSchema } from './workspace.ts';
// Fields consumed by the workspace UI. Unknown host metadata is preserved for later adapters.
const scene=z.object({id:z.string(),nativeType:z.string().optional(),vertices:z.array(z.number()).optional(),indices:z.array(z.number()).optional(),line:z.array(z.number()).optional(),origin:z.array(z.number()).optional(),area:z.number().nullish(),volume:z.number().nullish()}).passthrough();
export const applicationResultSchema=z.object({id:z.string(),state:z.string(),result:z.object({code:z.string().optional()}).passthrough().nullish()}).passthrough();
export const workspaceResultSchema=z.object({
 hostExecuted:z.boolean().optional(),host:z.string().optional(),phase:z.string().optional(),text:z.string().optional(),code:z.string().optional(),dwgEditMode:z.string().optional(),sourceHash:z.string().optional(),
 sourceDocument:z.object({name:z.string(),capturedAt:z.string(),instance:z.string(),documentId:z.number()}).passthrough().optional(),
 objects:z.array(z.object({id:z.string(),name:z.string(),kind:z.string()}).passthrough()).optional(),scene:z.array(scene).optional(),
 extensionResult:z.object({rows:z.array(z.object({type:z.string(),layer:z.string().nullish(),count:z.number(),objectIds:z.array(z.string())}).passthrough())}).passthrough().optional(),
}).passthrough();
export const workspaceRequestSchema=z.object({id:z.string(),state:requestStateSchema,input:z.unknown().optional(),result:workspaceResultSchema.nullish(),applications:z.array(applicationResultSchema).optional()}).passthrough();
export type WorkspaceRequest=z.infer<typeof workspaceRequestSchema>;
