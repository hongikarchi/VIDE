import {z} from 'zod';
import {requestInputSchema,requestStateSchema} from './workspace.ts';

// Storage knows lifecycle/identity. Host-specific geometry remains owned by each host contract.
export const storedResultSchema=z.object({
 hostExecuted:z.boolean().optional(),host:z.string().optional(),phase:z.string().optional(),baseRequestId:z.string().optional(),
 objects:z.array(z.object({id:z.string()}).passthrough()).optional(),
}).passthrough();
export const storedWorkSchema=z.object({id:z.string(),projectId:z.string(),input:requestInputSchema,state:requestStateSchema,result:storedResultSchema.nullable(),createdAt:z.string()});
export type StoredWork=z.infer<typeof storedWorkSchema>;
