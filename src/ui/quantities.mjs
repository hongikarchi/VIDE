import {initializeQuantityView} from './quantity-view.mjs';
import {api} from './gateway.mjs';
const dialog=document.createElement('dialog');dialog.className='quantity-dialog';dialog.setAttribute('aria-label','후보 수량표');document.body.append(dialog);
function element(tag,text,parent){const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;}
let opening=0;
export async function showQuantities(projectId,requestId,onSelect,objectId=''){
 const currentOpening=++opening;const [table,requests,views]=await Promise.all([api(`/projects/${projectId}/requests/${requestId}/quantities?${new URLSearchParams({objectId})}`),api(`/projects/${projectId}/requests`),api(`/projects/${projectId}/table-views`)]);if(currentOpening!==opening)return;
 dialog.replaceChildren();const head=element('div','',dialog);head.className='quantity-head';element('h2','후보 수량표',head);const close=element('button','닫기',head);close.onclick=()=>{opening++;dialog.close();};dialog.oncancel=()=>opening++;
 element('p',`${table.host==='rhino'?'Rhino':'ZWCAD'} · ${table.rows.length}개 객체 · 저장된 후보 기준`,dialog);
 const compareArea=element('div','',dialog);compareArea.className='comparison-controls';
 const picker=element('select','',compareArea);picker.setAttribute('aria-label','비교할 이전 후보');element('option','비교할 후보 선택',picker).value='';
 for(const candidate of requests.filter(r=>r.result?.hostExecuted&&r.id!==requestId)){
  const option=element('option',`${new Date(candidate.createdAt).toLocaleString('ko-KR')} · ${candidate.input.body||'파일 가져오기'}`,picker);option.value=candidate.id;
 }
 const compare=element('button','현재 후보와 비교',compareArea);const comparison=element('div','',dialog);comparison.className='comparison-result';
 let generation=0;
 compare.onclick=async()=>{
  if(!picker.value)return;const current=++generation;compare.disabled=true;
  try{const result=await api(`/projects/${projectId}/comparison?before=${encodeURIComponent(picker.value)}&after=${encodeURIComponent(requestId)}`);
   if(current!==generation||!dialog.open||currentOpening!==opening)return;comparison.replaceChildren();
   if(result.reason)element('p',result.reason,comparison);
   const labels={added:'추가',removed:'삭제',changed:'변경',unchanged:'동일',incomparable:'비교 불가'};
   for(const row of result.rows){const line=element('div',`${labels[row.status]} · ${row.name}`,comparison);for(const [metric,unit] of [['length','m'],['area','m²'],['volume','m³']])if(row.delta[metric]!==null&&row.delta[metric]!==0)element('small',` ${metric==='length'?'길이':metric==='area'?'기하 면적':'체적'} ${row.delta[metric]>0?'+':''}${row.delta[metric].toLocaleString('ko-KR',{maximumFractionDigits:3})} ${unit}`,line);}
  }catch{comparison.textContent='비교 자료를 읽지 못했습니다.';}finally{compare.disabled=false;}
 };
 initializeQuantityView(dialog,projectId,requestId,table,views,id=>{onSelect(id);opening++;dialog.close();},()=>currentOpening===opening&&dialog.open);
 element('small','기하 면적은 연면적·법정 면적이 아닙니다. 미상 값은 합계에서 제외합니다.',dialog);
 if(!dialog.open)dialog.showModal();
}
