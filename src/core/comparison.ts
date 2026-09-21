import {candidateSchema} from './reviews.ts';
import type {Workspace} from './workspace.ts';
import type {Comparison} from '../contracts/comparison.ts';
import type {z} from 'zod';
type Candidate=z.infer<typeof candidateSchema>;
import {DomainError} from './store.ts';
import {quantities} from './quantities.ts';
function representation(object:Candidate['result']['objects'][number]|undefined,scene:Candidate['result']['scene'][number]|undefined){
 const {nativeId,...attributes}=object??{};
 return JSON.stringify({attributes,geometry:scene?{vertices:scene.vertices,indices:scene.indices,line:scene.line,area:scene.area,volume:scene.volume,nativeType:scene.nativeType}:null});
}
export function compareCandidates(beforeValue:unknown,afterValue:unknown,related:boolean){
 const before=candidateSchema.parse(beforeValue),after=candidateSchema.parse(afterValue);
 if(!before.result?.hostExecuted||!after.result?.hostExecuted)throw new DomainError('NOT_FOUND');
 const compatible=related&&(before.result.host||'rhino')===(after.result.host||'rhino');
 const left=quantities(before),right=quantities(after),rows:(Comparison['rows'][number]&{before:unknown;after:unknown})[]=[];
 const ids=new Set([...left.rows.map(r=>r.id),...right.rows.map(r=>r.id)]);
 for(const id of ids){
  const a=left.rows.find(r=>r.id===id),b=right.rows.find(r=>r.id===id);
  const status:Comparison['rows'][number]['status']=!compatible?'incomparable':!a?'added':!b?'removed':representation(before.result.objects.find(o=>o.id===id),before.result.scene.find(o=>o.id===id))===representation(after.result.objects.find(o=>o.id===id),after.result.scene.find(o=>o.id===id))?'unchanged':'changed';
  const delta:Comparison['rows'][number]['delta']={length:null,area:null,volume:null};for(const metric of ['length','area','volume'] as const)delta[metric]=compatible&&a&&b&&a[metric]!==null&&b[metric]!==null?b[metric]-a[metric]:null;
  rows.push({id,name:b?.name||a?.name||id,status,before:a||null,after:b||null,delta});
 }
 return {before:before.id,after:after.id,compatible,reason:compatible?null:'기준 관계 또는 동일 호스트를 확인할 수 없습니다.',rows};
}
export function relatedCandidates(workspace:Workspace,projectId:string,before:{id:string},after:{id:string}){
 const ancestors=(initial:string)=>{let id:string|null|undefined=initial;const seen=new Set<string>();while(id&&!seen.has(id)){seen.add(id);const item=workspace.get(projectId,id);id=item.result?.baseRequestId||item.input?.baseRequestId;}return seen;};
 return ancestors(before.id).has(after.id)||ancestors(after.id).has(before.id);
}
