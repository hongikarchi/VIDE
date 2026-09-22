import {z} from 'zod';
import {sketchSchema} from './workspace.ts';

const coordinate=z.number().finite().min(-100000).max(100000);
export const sharedPinSchema=z.object({unit:z.literal('m'),position:z.tuple([coordinate,coordinate,coordinate])}).strict();
export const sharedSketchSchema=sketchSchema.strict();
export const sharedCommentInputSchema=z.object({
  submissionId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  body:z.string().max(4000),objectId:z.string().nullable(),
  pin:sharedPinSchema.nullish(),sketches:z.array(sharedSketchSchema).max(100).optional(),
}).strict().superRefine((value,ctx)=>{if(!value.body.trim()&&!value.pin&&!value.sketches?.length)ctx.addIssue({code:'custom',message:'Empty comment'});});
export type SharedPin=z.infer<typeof sharedPinSchema>;
export type SharedSketch=z.infer<typeof sharedSketchSchema>;
export const sketchWorldPoint=(plane:SharedSketch['plane'],point:[number,number]):[number,number,number]=>plane==='XY'?[point[0],point[1],0]:plane==='XZ'?[point[0],0,point[1]]:[0,point[0],point[1]];
