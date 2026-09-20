import {showReviewComparison} from './review-comparison.mjs';
import {api} from './gateway.mjs';
const dialog=document.createElement('dialog');document.body.append(dialog);
const element=(tag,text,parent)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;};
export function initializeReviews(getProject,notify){
 const list=document.getElementById('review-list');let generation=0;
 const refresh=async()=>{
  const projectId=getProject();if(!projectId)return;const current=++generation,rows=await api(`/projects/${projectId}/reviews`);if(current!==generation)return;
  list.replaceChildren();if(!rows.length)element('small','저장한 검토본이 없습니다.',list);
  if(rows.length>1){const compare=element('button','검토본 비교',list);compare.onclick=()=>showReviewComparison(projectId).catch(error=>notify(error.message));}
  for(const row of rows){const button=element('button',row.title,list);button.title=new Date(row.createdAt).toLocaleString('ko-KR');button.onclick=()=>open(row);}
 };
 const open=row=>{
  dialog.replaceChildren();dialog.className='review-dialog';dialog.setAttribute('aria-label','저장한 검토본');dialog.oncancel=null;
  const head=element('div','',dialog);head.className='quantity-head';element('h2',row.title,head);const download=element('a','HTML 내려받기',head);download.href=`/api/v1/projects/${getProject()}/reviews/${row.id}/download`;download.download='VIDE-review.html';const close=element('button','닫기',head);close.onclick=()=>dialog.close();
  const frame=element('iframe','',dialog);frame.title='검토본 내용';frame.setAttribute('sandbox','');frame.src=`/api/v1/projects/${getProject()}/reviews/${row.id}/preview`;
  if(!dialog.open)dialog.showModal();
 };
 const create=async(requestId,image)=>{
  const projectId=getProject(),views=await api(`/projects/${projectId}/table-views`);
  dialog.replaceChildren();dialog.className='quantity-dialog review-save';dialog.setAttribute('aria-label','검토본 저장');
  const head=element('div','',dialog);head.className='quantity-head';element('h2','검토본 저장',head);const close=element('button','닫기',head);close.onclick=()=>dialog.close();
  element('p','화면·입력·표·적용 상태를 현재 시점으로 남깁니다.',dialog);
  const form=element('div','',dialog);form.className='table-controls';const title=element('input','',form);title.setAttribute('aria-label','검토본 제목');title.placeholder='예: 수정 전, 검토 후보';title.maxLength=100;
  const picker=element('select','',form);picker.setAttribute('aria-label','검토본 표 구성');element('option','전체 객체',picker).value='';for(const view of views)element('option',view.name,picker).value=view.id;
  const save=element('button','검토본 저장',form);const status=element('p','',dialog);status.setAttribute('role','status');let saving=false;
  dialog.oncancel=event=>{if(saving)event.preventDefault();};
  save.onclick=async()=>{
   if(saving)return;saving=true;save.disabled=close.disabled=title.disabled=picker.disabled=true;
   try{const row=await api(`/projects/${projectId}/reviews`,'POST',{requestId,title:title.value,image,query:views.find(view=>view.id===picker.value)?.query||{}});await refresh();open(row);notify('검토본을 저장했습니다.');}
   catch(error){status.textContent=error.message;}
   finally{saving=false;save.disabled=close.disabled=title.disabled=picker.disabled=false;}
  };
  if(!dialog.open)dialog.showModal();title.focus();
 };
 return {refresh,create};
}
