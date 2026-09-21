import type {ReviewSnapshot} from './reviews.ts';
import type {Comparison} from '../contracts/comparison.ts';
export function compareReviews(before:ReviewSnapshot,after:ReviewSnapshot,related=false){
 const left=before.payload,right=after.payload;
 const sameDocument=left.sourceDocument&&right.sourceDocument&&left.sourceDocument.instance===right.sourceDocument.instance&&left.sourceDocument.documentId===right.sourceDocument.documentId&&[...left.model,...right.model].every(object=>object.kind==='native');
 const compatible=!!(related||sameDocument)&&left.table.host===right.table.host;
 const tableCompatible=compatible&&JSON.stringify(left.table.query)===JSON.stringify(right.table.query)&&JSON.stringify(left.table.units)===JSON.stringify(right.table.units);
 const rows:Comparison['rows']=[];
 for(const id of new Set([...left.model,...right.model].map(object=>object.id))){
  const a=left.model.find(object=>object.id===id),b=right.model.find(object=>object.id===id);
  const status=!compatible?'incomparable':!a?'added':!b?'removed':!a.comparable||!b.comparable?'incomparable':a.geometryHash===b.geometryHash?'unchanged':'changed';
  const av=left.table.rows.find(row=>row.id===id),bv=right.table.rows.find(row=>row.id===id),delta:Comparison['rows'][number]['delta']={length:null,area:null,volume:null};
  for(const key of ['length','area','volume'] as const)delta[key]=tableCompatible&&av&&bv&&av[key]!==null&&bv[key]!==null?bv[key]-av[key]:null;
  rows.push({id,name:b?.name||a?.name||id,status,delta});
 }
 return {before:before.id,after:after.id,compatible,tableCompatible,reason:!compatible?'동일한 모델의 기준 관계를 확인할 수 없습니다.':!tableCompatible?'표 조건 또는 단위가 달라 수량 차이를 비교하지 않습니다.':null,rows};
}
