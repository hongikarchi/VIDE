import {api} from './gateway.mjs';
const element=(tag,text,parent)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;};
export async function renderReviewNotes(parent,projectId,reviewId,onAdopt,onBasis){
 const [review,notes]=await Promise.all([api(`/projects/${projectId}/reviews/${reviewId}`),api(`/projects/${projectId}/reviews/${reviewId}/notes`)]);
 if(!parent.isConnected)return;
 const key=`vide:review-note:${projectId}:${reviewId}`;let draft={body:'',objectId:null,id:crypto.randomUUID(),pending:false};
 try{const saved=JSON.parse(localStorage.getItem(key));if(saved&&typeof saved.body==='string')draft=saved;}catch{}
 element('h3','검토 의견',parent);element('small','이 검토본에 로컬로 저장됩니다.',parent);
 const list=element('div','',parent),form=element('div','',parent);form.className='review-note-form';
 const target=element('select','',form);target.setAttribute('aria-label','의견 대상');element('option','검토본 전체',target).value='';
 for(const object of review.payload.model)element('option',object.name,target).value=object.id;
 target.value=draft.objectId||'';
 const body=element('textarea','',form);body.setAttribute('aria-label','검토 의견 본문');body.maxLength=4000;body.value=draft.body;
 const save=element('button','의견 저장',form),status=element('p','',form);status.setAttribute('role','status');
 const persist=()=>{try{localStorage.setItem(key,JSON.stringify(draft));return true;}catch{status.textContent='초안 저장 불가. 화면을 닫기 전에 의견을 저장하세요.';return false;}};
 const lock=()=>{target.disabled=body.disabled=draft.pending;save.textContent=draft.pending?'동일 의견 다시 확인':'의견 저장';};lock();
 body.oninput=target.onchange=()=>{draft.body=body.value;draft.objectId=target.value||null;persist();};
 const render=()=>{list.replaceChildren();for(const note of notes){const card=element('article','',list);element('small',(review.payload.model.find(object=>object.id===note.objectId)?.name||'검토본 전체')+' · '+new Date(note.createdAt).toLocaleString('ko-KR'),card);element('p',note.body,card);
  const open=element('button','기준 후보 열기',card);open.onclick=()=>onBasis(review.requestId);
  const attach=element('button','요청 초안에 첨부',card);attach.onclick=()=>{try{onAdopt(note,review);}catch(error){status.textContent=error.message;}};
 }};render();
 save.onclick=async()=>{
  if(!draft.body.trim())return;draft.pending=true;persist();lock();save.disabled=true;
  try{const note=await api(`/projects/${projectId}/reviews/${reviewId}/notes`,'POST',{id:draft.id,body:draft.body,objectId:draft.objectId});if(!notes.some(item=>item.id===note.id))notes.push(note);draft={body:'',objectId:null,id:crypto.randomUUID(),pending:false};body.value='';target.value='';persist();render();status.textContent='의견을 저장했습니다. AI 실행 전의 검토 기록입니다.';}
  catch(error){status.textContent=error.message+' · 같은 의견을 다시 확인할 수 있습니다.';}
  finally{save.disabled=false;lock();}
 };
}
