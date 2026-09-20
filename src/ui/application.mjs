import {api,errors} from './gateway.mjs';
const dialog=document.createElement('dialog');dialog.className='quantity-dialog application-dialog';dialog.setAttribute('aria-label','Rhino 원본 적용');document.body.append(dialog);
function element(tag,text,parent){const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;}
export async function showApplication(projectId,requestId,onResult){
 const catalog=await api('/host/documents');dialog.replaceChildren();
 const head=element('div','',dialog);head.className='quantity-head';element('h2','Rhino 문서에 적용',head);const close=element('button','닫기',head);
 element('p','선택한 열린 문서에 이 후보를 반영합니다. 파일 저장은 Rhino에서 별도로 수행합니다.',dialog);
 const picker=element('select','',dialog);picker.setAttribute('aria-label','적용할 Rhino 문서');
 for(const doc of catalog.documents){const option=element('option',`${doc.name} · ${doc.objectCount}개 객체 · ${doc.units}`,picker);option.value=String(doc.id);}
 const inspect=element('button','영향 검토',dialog);inspect.disabled=!catalog.documents.length;
 const info=element('p',catalog.documents.length?'적용할 문서를 고르고 영향 범위를 확인하세요.':'열린 Rhino 문서가 없습니다.',dialog);info.setAttribute('role','status');
 const confirm=element('button','검토한 변경 적용',dialog);confirm.disabled=true;let preview,running=false,inspecting=false;
 close.onclick=()=>{if(!running&&!inspecting)dialog.close();};dialog.oncancel=e=>{if(running||inspecting)e.preventDefault();};
 picker.onchange=()=>{preview=null;confirm.disabled=true;info.textContent='새 대상의 영향 범위를 다시 확인하세요.';};
 inspect.onclick=async()=>{if(inspecting||running)return;inspecting=true;preview=null;close.disabled=true;inspect.disabled=true;confirm.disabled=true;picker.disabled=true;
  try{preview=await api(`/projects/${projectId}/applications`,'POST',{requestId,instance:catalog.instance,documentId:Number(picker.value)});info.textContent=`추가 ${preview.added} · 수정 ${preview.updated} · 삭제 ${preview.removed}개. 이 프로젝트가 소유한 객체만 수정·삭제합니다.`;confirm.disabled=false;}
  catch(error){info.textContent='영향 검토 실패: '+error.message;}
  finally{inspecting=false;close.disabled=false;inspect.disabled=false;picker.disabled=false;}
 };
 confirm.onclick=async()=>{
  if(!preview||running)return;running=true;confirm.disabled=true;inspect.disabled=true;picker.disabled=true;close.disabled=true;info.textContent='Rhino 문서에 반영 중…';
  try{const result=await api(`/projects/${projectId}/applications/${preview.id}`,'POST',{});info.textContent=result.state==='succeeded'?'문서 반영 완료 · 파일은 아직 저장하지 않았습니다.':result.state==='unknown'?'결과 미확인 · 이 문서의 추가 적용을 보류합니다.':'적용하지 못했습니다: '+(errors[result.result?.code]||result.result?.code||result.state);onResult(result);}
  catch(error){info.textContent='적용 상태 확인 필요: '+error.message;}
  finally{running=false;close.disabled=false;}
 };
 if(!dialog.open)dialog.showModal();
}
