import {api} from './gateway.mjs';
const element=(tag,text,parent)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;};
const number=value=>value===null?'미상':value.toLocaleString('ko-KR',{maximumFractionDigits:3});
const aggregate=metric=>`${metric.known?number(metric.value):'미상'}${metric.unknown?' · 미상 '+metric.unknown+'개 제외':''}`;
export function initializeQuantityView(parent,projectId,requestId,initial,views,onSelect,isCurrent){
 const controls=element('div','',parent);controls.className='table-controls';
 const search=element('input','',controls);search.placeholder='객체 검색';search.setAttribute('aria-label','객체 검색');search.maxLength=200;
 const select=(label,items)=>{const node=element('select','',controls);node.setAttribute('aria-label',label);for(const [value,text] of items)element('option',text,node).value=value;return node;};
 const object=select('집계 객체',[['','전체 객체'],...initial.available.objects.map(item=>[item.id,item.name])]);
 const type=select('객체 유형',[['','전체 유형'],...initial.available.types.map(value=>[value,value])]);
 const layer=select('레이어 필터',[['','전체 레이어'],...initial.available.layers.map(value=>[value,value])]);
 const group=select('그룹 기준',[['none','그룹 없음'],['type','유형별'],['layer','레이어별']]);
 const refresh=element('button','표 갱신',controls);
 const saved=element('details','',parent);element('summary','표 구성',saved);const savedControls=element('div','',saved);savedControls.className='table-controls';
 const picker=element('select','',savedControls);picker.setAttribute('aria-label','저장한 표 구성');
 const name=element('input','',savedControls);name.placeholder='구성 이름';name.setAttribute('aria-label','표 구성 이름');name.maxLength=80;
 const save=element('button','구성 저장',savedControls),remove=element('button','구성 삭제',savedControls);remove.disabled=true;
 const status=element('p','',parent);status.setAttribute('role','status');const wrap=element('div','',parent);wrap.className='quantity-scroll';
 const download=element('a','CSV 내려받기',parent);download.download='VIDE-quantities.csv';
 let generation=0,selected;
 const query=()=>({search:search.value,type:type.value,layer:layer.value,groupBy:group.value,objectId:object.value});
 const render=table=>{
  wrap.replaceChildren();status.textContent=`${table.rows.length} / ${table.totalCount}개 객체 · 선택한 저장 기준`;
  const grid=element('table','',wrap),head=element('tr','',element('thead','',grid));for(const title of ['객체','유형','레이어','길이 (m)','기하 면적 (m²)','체적 (m³)'])element('th',title,head);
  const body=element('tbody','',grid);
  const row=data=>{const tr=element('tr','',body),cell=element('td','',tr),button=element('button',data.name,cell);button.onclick=()=>onSelect(data.id);element('td',data.type,tr);element('td',data.layer??'미상',tr);for(const key of ['length','area','volume'])element('td',number(data[key]),tr);};
  const summary=(label,totals)=>{const tr=element('tr','',body);tr.className='quantity-summary';element('th',label,tr);element('td',totals.count+'개',tr);element('td','',tr);for(const key of ['length','area','volume'])element('td',aggregate(totals[key]),tr);};
  if(table.groups.length)for(const group of table.groups){summary(group.key,group.totals);for(const id of group.ids)row(table.rows.find(item=>item.id===id));}else table.rows.forEach(row);
  summary('합계',table.totals);download.href=`/api/v1/projects/${projectId}/requests/${requestId}/quantities.csv?${new URLSearchParams(table.query)}`;
 };
 const reload=async()=>{const current=++generation;refresh.disabled=true;try{const table=await api(`/projects/${projectId}/requests/${requestId}/quantities?${new URLSearchParams(query())}`);if(current===generation&&isCurrent())render(table);}catch(error){if(current===generation&&isCurrent())status.textContent=error.message+' 마지막 성공 표를 유지합니다.';}finally{if(current===generation)refresh.disabled=false;}};
 const catalog=()=>{picker.replaceChildren();element('option','새 구성',picker).value='';for(const view of views)element('option',view.name,picker).value=view.id;picker.value=selected?.id||'';remove.disabled=!selected;};
 picker.onchange=()=>{selected=views.find(view=>view.id===picker.value);name.value=selected?.name||'';remove.disabled=!selected;if(selected){search.value=selected.query.search;for(const [node,value] of [[object,selected.query.objectId||''],[type,selected.query.type],[layer,selected.query.layer],[group,selected.query.groupBy]]){if(![...node.options].some(option=>option.value===value))element('option',value+' · 현재 기준에 없음',node).value=value;node.value=value;}void reload();}};
 const viewBusy=busy=>{picker.disabled=name.disabled=save.disabled=busy;remove.disabled=busy||!selected;};
 save.onclick=async()=>{viewBusy(true);try{const value=await api(`/projects/${projectId}/table-views${selected?'/'+selected.id:''}`,selected?'PUT':'POST',{name:name.value,query:query(),revision:selected?.revision});if(!isCurrent())return;const index=views.findIndex(view=>view.id===value.id);if(index<0)views.push(value);else views[index]=value;selected=value;catalog();status.textContent='표 구성을 저장했습니다.';}catch(error){if(isCurrent())status.textContent=error.message;}finally{viewBusy(false);}};
 remove.onclick=async()=>{if(!selected)return;const target=selected;viewBusy(true);try{await api(`/projects/${projectId}/table-views/${target.id}/delete`,'POST',{revision:target.revision});if(!isCurrent())return;views.splice(views.findIndex(view=>view.id===target.id),1);selected=undefined;catalog();status.textContent='표 구성을 삭제했습니다.';}catch(error){if(isCurrent())status.textContent=error.message;}finally{viewBusy(false);}};
 refresh.onclick=reload;object.onchange=type.onchange=layer.onchange=group.onchange=reload;search.onchange=reload;search.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();void reload();}};
 catalog();render(initial);
}
