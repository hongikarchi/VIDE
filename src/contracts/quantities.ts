import { z } from 'zod';
const filter = z.string().max(200).nullish().transform(value=>value??'');
export const quantityQuerySchema = z.object({search:filter,type:filter,layer:filter,groupBy:z.enum(['none','type','layer']).nullish().transform(value=>value??'none'),objectId:filter}).strict();
export type QuantityQuery = z.infer<typeof quantityQuerySchema>;
const metric = z.number().finite().nonnegative().nullable();
const aggregate = z.object({value:z.number().finite().nonnegative(),known:z.number().int().nonnegative(),unknown:z.number().int().nonnegative()});
const totals = z.object({count:z.number().int().nonnegative(),length:aggregate,area:aggregate,volume:aggregate});
export const quantityTableSchema = z.object({
  query:quantityQuerySchema,host:z.string(),
  available:z.object({objects:z.array(z.object({id:z.string(),name:z.string()})),types:z.array(z.string()),layers:z.array(z.string())}),
  totalCount:z.number().int().nonnegative(),
  rows:z.array(z.object({id:z.string(),name:z.string(),type:z.string(),layer:z.string().nullable(),length:metric,area:metric,volume:metric})),
  groups:z.array(z.object({key:z.string(),totals,ids:z.array(z.string())})),totals,
}).passthrough();
export type QuantityTable = z.infer<typeof quantityTableSchema>;
export const tableViewSchema = z.object({id:z.string(),name:z.string(),revision:z.number().int(),query:quantityQuerySchema}).passthrough();
export const tableViewsSchema = z.array(tableViewSchema);
export type TableView = z.infer<typeof tableViewSchema>;
