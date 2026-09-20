// Pending clauses share the visible pins, sketches, files and execution settings.
export function renderRequests(state,onChange){
 const root=document.getElementById('pending-requests');root.replaceChildren();
 const items=state.instructions||[];
 document.getElementById('request-count').textContent=String(items.length);
 items.forEach((text,index)=>{
  const row=document.createElement('div');row.className='pending-request';
  const field=document.createElement('textarea');field.value=text;field.rows=1;field.setAttribute('aria-label',`요청 ${index+1}`);
  field.oninput=()=>{items[index]=field.value;onChange(false);};
  const remove=document.createElement('button');remove.textContent='×';remove.setAttribute('aria-label',`요청 ${index+1} 삭제`);
  remove.onclick=()=>{items.splice(index,1);onChange(true);};row.append(field,remove);root.append(row);
 });
 if(!items.length){const hint=document.createElement('small');hint.textContent='입력한 요청을 모아서 실행할 수 있습니다.';root.append(hint);}
}
export function renderActiveWork(messages){
 const root=document.getElementById('active-work');root.replaceChildren();
 const active=messages.filter(m=>['queued','running','unknown','interrupted'].includes(m.request?.state));
 if(!active.length){root.textContent='진행 중인 작업 없음';return;}
 for(const m of active){const item=document.createElement('div');const title=document.createElement('strong');title.textContent=m.body||'첨부 문맥 검토';const phase=document.createElement('small');phase.textContent=m.request.state==='unknown'?'호스트 결과 확인 필요 · 새 후보 보류':m.request.state==='interrupted'?'연결 종료로 중단됨 · 자동 재실행 없음':m.request.state==='queued'?'대기':m.request.result?.phase==='host'?'호스트 생성·저장 검증':m.request.result?.phase==='stopping'?'중단 확인 중':'AI 요청 처리';item.append(title,phase);root.append(item);}
}
