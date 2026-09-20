import {api} from './gateway.mjs';
export function initializeDocuments(notify){
 const refresh=document.getElementById('refresh-documents'),picker=document.getElementById('host-documents'),info=document.getElementById('host-document-info');
 let catalog;
 refresh.onclick=async()=>{
  refresh.disabled=true;info.textContent='문서 조회 중';
  try{catalog=await api('/host/documents');picker.replaceChildren();for(const item of catalog.documents){const option=document.createElement('option');option.value=String(item.id);option.textContent=item.name;picker.append(option);}picker.hidden=!catalog.documents.length;document.getElementById('inspect-selection').disabled=!catalog.documents.length;picker.onchange();}
  catch{info.textContent='Rhino 문서를 읽을 수 없습니다.';}finally{refresh.disabled=false;}
 };
 picker.onchange=()=>{const document=catalog?.documents.find(d=>d.id===Number(picker.value));info.textContent=document?`${document.objectCount}개 객체 · ${document.units}${document.modified?' · 저장되지 않은 변경':''}`:'연결된 열린 문서가 없습니다.';};
 document.getElementById('inspect-selection').onclick=async()=>{
  if(!catalog)return;
  try{const result=await api(`/host/selection?instance=${encodeURIComponent(catalog.instance)}&document=${encodeURIComponent(picker.value)}`);notify(`Rhino 문서 선택: ${result.selectedIds.length}개 객체. 작업 참조로 사용하려면 문서 취득이 필요합니다.`);}
  catch{notify('문서 연결이 바뀌었습니다. 열린 문서를 다시 조회하세요.');}
 };
}
