import {api} from './gateway.mjs';
const dialog=document.createElement('dialog');dialog.className='quantity-dialog';dialog.setAttribute('aria-label','후보 수량표');document.body.append(dialog);
function element(tag,text,parent){const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;}
export async function showQuantities(projectId,requestId,onSelect){
 const table=await api(`/projects/${projectId}/requests/${requestId}/quantities`);
 dialog.replaceChildren();const head=element('div','',dialog);head.className='quantity-head';element('h2','후보 수량표',head);const close=element('button','닫기',head);close.onclick=()=>dialog.close();
 element('p',`${table.host==='rhino'?'Rhino':'ZWCAD'} · ${table.rows.length}개 객체 · 저장된 후보 기준`,dialog);
 const compareArea=element('div','',dialog);compareArea.className='comparison-controls';
 const picker=element('select','',compareArea);picker.setAttribute('aria-label','비교할 이전 후보');element('option','비교할 후보 선택',picker).value='';
 const requests=await api(`/projects/${projectId}/requests`);
 for(const candidate of requests.filter(r=>r.result?.hostExecuted&&r.id!==requestId)){
  const option=element('option',`${new Date(candidate.createdAt).toLocaleString('ko-KR')} · ${candidate.input.body||'파일 가져오기'}`,picker);option.value=candidate.id;
 }
 const compare=element('button','현재 후보와 비교',compareArea);const comparison=element('div','',dialog);comparison.className='comparison-result';
 let generation=0;
 compare.onclick=async()=>{
  if(!picker.value)return;const current=++generation;compare.disabled=true;
  try{const result=await api(`/projects/${projectId}/comparison?before=${encodeURIComponent(picker.value)}&after=${encodeURIComponent(requestId)}`);
   if(current!==generation||!dialog.open)return;comparison.replaceChildren();
   if(result.reason)element('p',result.reason,comparison);
   const labels={added:'추가',removed:'삭제',changed:'변경',unchanged:'동일',incomparable:'비교 불가'};
   for(const row of result.rows){const line=element('div',`${labels[row.status]} · ${row.name}`,comparison);for(const [metric,unit] of [['length','m'],['area','m²'],['volume','m³']])if(row.delta[metric]!==null&&row.delta[metric]!==0)element('small',` ${metric==='length'?'길이':metric==='area'?'기하 면적':'체적'} ${row.delta[metric]>0?'+':''}${row.delta[metric].toLocaleString('ko-KR',{maximumFractionDigits:3})} ${unit}`,line);}
  }catch{comparison.textContent='비교 자료를 읽지 못했습니다.';}finally{compare.disabled=false;}
 };
 const wrap=element('div','',dialog);wrap.className='quantity-scroll';const grid=element('table','',wrap);const thead=element('thead','',grid);const titles=element('tr','',thead);
 for(const title of ['객체','유형','길이 (m)','기하 면적 (m²)','체적 (m³)'])element('th',title,titles);
 const body=element('tbody','',grid);const number=n=>n===null?'미상':n.toLocaleString('ko-KR',{maximumFractionDigits:3});
 for(const row of table.rows){const tr=element('tr','',body);const cell=element('td','',tr);const select=element('button',row.name,cell);select.onclick=()=>{onSelect(row.id);dialog.close();};element('td',row.type,tr);for(const key of ['length','area','volume'])element('td',number(row[key]),tr);}
 const total=element('tr','',body);element('th','합계',total);element('td',String(table.totals.count)+'개',total);for(const key of ['length','area','volume']){const metric=table.totals[key];element('td',`${metric.known?number(metric.value):'미상'}${metric.unknown?' · 미상 '+metric.unknown+'개 제외':''}`,total);}
 element('small','기하 면적은 연면적·법정 면적이 아닙니다. 미상 값은 합계에서 제외합니다.',dialog);
 const download=element('a','CSV 내려받기',dialog);download.href=`/api/v1/projects/${projectId}/requests/${requestId}/quantities.csv`;download.download='VIDE-quantities.csv';
 if(!dialog.open)dialog.showModal();
}
