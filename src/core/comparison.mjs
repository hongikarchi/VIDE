import {DomainError} from './store.mjs';
import {quantities} from './quantities.ts';
function representation(object,scene){
 const {nativeId,...attributes}=object;
 return JSON.stringify({attributes,geometry:scene?{vertices:scene.vertices,indices:scene.indices,line:scene.line,area:scene.area,volume:scene.volume,nativeType:scene.nativeType}:null});
}
export function compareCandidates(before,after,related){
 if(!before.result?.hostExecuted||!after.result?.hostExecuted)throw new DomainError('NOT_FOUND');
 const compatible=related&&(before.result.host||'rhino')===(after.result.host||'rhino');
 const left=quantities(before),right=quantities(after),rows=[];
 const ids=new Set([...left.rows.map(r=>r.id),...right.rows.map(r=>r.id)]);
 for(const id of ids){
  const a=left.rows.find(r=>r.id===id),b=right.rows.find(r=>r.id===id);
  let status=!compatible?'incomparable':!a?'added':!b?'removed':representation(before.result.objects.find(o=>o.id===id),before.result.scene.find(o=>o.id===id))===representation(after.result.objects.find(o=>o.id===id),after.result.scene.find(o=>o.id===id))?'unchanged':'changed';
  const delta={};for(const metric of ['length','area','volume'])delta[metric]=compatible&&a&&b&&a[metric]!==null&&b[metric]!==null?b[metric]-a[metric]:null;
  rows.push({id,name:b?.name||a?.name,status,before:a||null,after:b||null,delta});
 }
 return {before:before.id,after:after.id,compatible,reason:compatible?null:'기준 관계 또는 동일 호스트를 확인할 수 없습니다.',rows};
}
export function relatedCandidates(workspace,projectId,before,after){
 const ancestors=id=>{const seen=new Set();while(id&&!seen.has(id)){seen.add(id);const item=workspace.get(projectId,id);id=item.result?.baseRequestId||item.input?.baseRequestId;}return seen;};
 return ancestors(before.id).has(after.id)||ancestors(after.id).has(before.id);
}
