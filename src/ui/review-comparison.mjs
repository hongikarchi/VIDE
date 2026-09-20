import {api} from './gateway.mjs';
const dialog=document.createElement('dialog');dialog.className='review-dialog review-compare';dialog.setAttribute('aria-label','검토본 비교');document.body.append(dialog);
const element=(tag,text,parent)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;};
let generation=0;
export async function showReviewComparison(projectId){
 const current=++generation,rows=await api(`/projects/${projectId}/reviews`);if(current!==generation)return;
 dialog.replaceChildren();const head=element('div','',dialog);head.className='quantity-head';element('h2','검토본 비교',head);const close=element('button','닫기',head);close.onclick=()=>{generation++;dialog.close();};dialog.oncancel=()=>generation++;
 const controls=element('div','',dialog);controls.className='table-controls';
 const picker=label=>{const select=element('select','',controls);select.setAttribute('aria-label',label);for(const row of rows)element('option',row.title+' · '+new Date(row.createdAt).toLocaleString('ko-KR'),select).value=row.id;return select;};
 const before=picker('검토본 A'),after=picker('검토본 B');if(rows.length){before.value=rows.at(-1).id;after.value=rows[0].id;}
 const compare=element('button','비교',controls);compare.disabled=rows.length<2;
 const summary=element('div','',dialog);summary.className='review-differences';summary.setAttribute('role','status');
 const panels=element('div','',dialog);panels.className='review-panels';
 let requestGeneration=0;
 compare.onclick=async()=>{
  const revision=++requestGeneration,a=before.value,b=after.value;compare.disabled=true;
  try{const result=await api(`/projects/${projectId}/review-comparison?before=${encodeURIComponent(a)}&after=${encodeURIComponent(b)}`);if(current!==generation||revision!==requestGeneration||!dialog.open)return;
   summary.replaceChildren();if(result.reason)element('p',result.reason,summary);
   const labels={added:'추가',removed:'삭제',changed:'표시·속성 변경',unchanged:'표시·속성 동일',incomparable:'비교 불가'};
   for(const row of result.rows){const text=element('p',`${labels[row.status]} · ${row.name}`,summary);for(const [key,label,unit] of [['length','길이','m'],['area','기하 면적','m²'],['volume','체적','m³']])if(row.delta[key]!==null&&row.delta[key]!==0)text.append(` · ${label} ${row.delta[key]>0?'+':''}${row.delta[key].toLocaleString('ko-KR',{maximumFractionDigits:3})} ${unit}`);}
   panels.replaceChildren();for(const [id,label] of [[a,'검토본 A 내용'],[b,'검토본 B 내용']]){const frame=element('iframe','',panels);frame.title=label;frame.setAttribute('sandbox','');frame.src=`/api/v1/projects/${projectId}/reviews/${id}/preview`;}
  }catch(error){if(current===generation)summary.textContent=error.message;}finally{compare.disabled=rows.length<2;}
 };
 if(!dialog.open)dialog.showModal();if(rows.length>=2)void compare.onclick();
}
