import { z } from 'zod';
const point=z.tuple([z.number(),z.number(),z.number()]);
const object=z.object({id:z.string(),nativeId:z.string().uuid(),kind:z.literal('native'),name:z.string(),origin:point});
export const nativeSceneSchema=z.object({
 id:z.string(),nativeId:z.string().uuid(),nativeType:z.string(),name64:z.string(),origin:point,boundsSize:point,
 vertices:z.array(z.number()),indices:z.array(z.number().int().nonnegative()),line:z.array(z.number()),
 area:z.number().nonnegative().nullable(),volume:z.number().nonnegative().nullable(),length:z.number().nonnegative().nullable(),
 layer64:z.string(),attributes64:z.array(z.tuple([z.string(),z.string()])),attributesComplete:z.boolean(),valid:z.literal(true),
});
export const nativeModelSchema=z.object({objects:z.array(object).max(500),scene:z.array(nativeSceneSchema).max(500),measurementVersion:z.literal(1).optional(),measurementStats:z.object({measuredObjects:z.number().int().nonnegative(),reusedObjects:z.number().int().nonnegative()}).optional()}).superRefine((model,ctx)=>{
 const objects=new Map(model.objects.map(object=>[object.id,object]));
 if(objects.size!==model.objects.length||model.scene.length!==model.objects.length||new Set(model.scene.map(scene=>scene.id)).size!==model.scene.length)ctx.addIssue({code:'custom',message:'Invalid object identity set'});
 for(const scene of model.scene){
  if(objects.get(scene.id)?.nativeId!==scene.nativeId||scene.vertices.length%3||scene.indices.length%3||scene.line.length%3||scene.indices.some(index=>index>=scene.vertices.length/3))ctx.addIssue({code:'custom',message:'Invalid display geometry'});
 }
});
export type NativeModel=z.infer<typeof nativeModelSchema>;
