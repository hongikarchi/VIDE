import {api} from './gateway.mjs';
const dialog=document.createElement('dialog');dialog.className='quantity-dialog';dialog.setAttribute('aria-label','후보 수량표');document.body.append(dialog);
function element(tag,text,parent){const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;}
export async function showQuantities(projectId,requestId,onSelect){
 const table=await api(`/projects/${projectId}/requests/${requestId}/quantities`);
 dialog.replaceChildren();const head=element('div','',dialog);head.className='quantity-head';element('h2','후보 수량표',head);const close=element('button','닫기',head);close.onclick=()=>dialog.close();
 element('p',`${table.host==='rhino'?'Rhino':'ZWCAD'} · ${table.rows.length}개 객체 · 저장된 후보 기준`,dialog);
 const wrap=element('div','',dialog);wrap.className='quantity-scroll';const grid=element('table','',wrap);const thead=element('thead','',grid);const titles=element('tr','',thead);
 for(const title of ['객체','유형','길이 (m)','기하 면적 (m²)','체적 (m³)'])element('th',title,titles);
 const body=element('tbody','',grid);const number=n=>n===null?'미상':n.toLocaleString('ko-KR',{maximumFractionDigits:3});
 for(const row of table.rows){const tr=element('tr','',body);const cell=element('td','',tr);const select=element('button',row.name,cell);select.onclick=()=>{onSelect(row.id);dialog.close();};element('td',row.type,tr);for(const key of ['length','area','volume'])element('td',number(row[key]),tr);}
 const total=element('tr','',body);element('th','합계',total);element('td',String(table.totals.count)+'개',total);for(const key of ['length','area','volume']){const metric=table.totals[key];element('td',`${metric.known?number(metric.value):'미상'}${metric.unknown?' · 미상 '+metric.unknown+'개 제외':''}`,total);}
 element('small','기하 면적은 연면적·법정 면적이 아닙니다. 미상 값은 합계에서 제외합니다.',dialog);
 const download=element('a','CSV 내려받기',dialog);download.href=`/api/v1/projects/${projectId}/requests/${requestId}/quantities.csv`;download.download='VIDE-quantities.csv';
 if(!dialog.open)dialog.showModal();
}
