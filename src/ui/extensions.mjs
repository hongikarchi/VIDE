import {api} from './gateway.mjs';
const dialog=document.createElement('dialog');dialog.className='quantity-dialog';dialog.setAttribute('aria-label','확장');document.body.append(dialog);
const element=(tag,text,parent)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;};
export async function showExtensions(context,onResult){
 const catalog=await api('/extensions');dialog.replaceChildren();let busy=false;
 const head=element('div','',dialog);head.className='quantity-head';element('h2','확장',head);const close=element('button','닫기',head);close.onclick=()=>dialog.close();dialog.oncancel=event=>{if(busy)event.preventDefault();};
 const status=element('p','',dialog);status.setAttribute('role','status');
 for(const extension of catalog){
  const card=element('section','',dialog);element('h3',extension.name,card);element('p',`v${extension.version} · 저장된 모델 읽기`,card);
  const scope=element('select','',card);scope.setAttribute('aria-label','확장 대상');if(context.selected)element('option','선택 객체',scope).value='selected';element('option',`현재 후보 전체 (${context.objects.length}개)`,scope).value='all';
  const toggle=element('button',extension.enabled?'비활성화':extension.revision?'활성화':'등록',card),run=element('button','실행',card);
  const available=()=>{const count=scope.value==='selected'?1:context.objects.length;run.disabled=!extension.enabled||!context.requestId||!count||count>100;if(count>100)status.textContent='한 번에 최대 100개 객체를 요약합니다. 객체를 선택해 범위를 줄이세요.';};scope.onchange=available;available();
  let submission;
  const lock=value=>{busy=value;close.disabled=toggle.disabled=scope.disabled=run.disabled=value;};
  toggle.onclick=async()=>{lock(true);try{Object.assign(extension,await api(`/extensions/${extension.id}`,'PUT',{revision:extension.revision,enabled:!extension.enabled}));toggle.textContent=extension.enabled?'비활성화':'활성화';status.textContent=extension.enabled?'확장을 활성화했습니다.':'새 실행을 비활성화했습니다.';}catch(error){status.textContent=error.message;}finally{lock(false);available();}};
  run.onclick=async()=>{lock(true);try{
   submission??={id:crypto.randomUUID(),requestId:context.requestId,objectIds:scope.value==='selected'?[context.selected]:context.objects.map(object=>object.id)};
   const request=await api(`/projects/${context.projectId}/extensions/${extension.id}/run`,'POST',submission);onResult(request);dialog.close();
  }catch(error){status.textContent=error.message;run.textContent='같은 실행 다시 확인';}finally{lock(false);available();if(submission)scope.disabled=true;}};
 }
 if(!context.objects.length)element('p','작업 후보를 먼저 열어 주세요.',dialog);if(!dialog.open)dialog.showModal();
}
