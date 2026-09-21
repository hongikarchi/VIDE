import {draftSnapshot,restoreDraft,restoreSavedDraft} from './draft-storage.ts';
import {z} from 'zod';
import {element as $,append as el,readableError} from './elements.ts';
import {requestData,requestMessage,modelsSchema,providersSchema,hostStatusSchema} from './workspace-data.ts';
import type {Point2,DraftPin} from './model.ts';
import type {MobileView} from './mobile-navigation.tsx';
import {renderProjectHeading} from './project-heading.tsx';
import {setMobileView} from './mobile-navigation.tsx';
import {showQuantities} from './quantities.tsx';
import {attachNativeAttributes} from './native-attributes.ts';
import {showExtensions} from './extensions.tsx';
const showAiSettings:typeof import('./ai-settings.tsx').showAiSettings = async onStatus => (await import('./ai-settings.tsx')).showAiSettings(onStatus);
import {initializeReviews} from './reviews.tsx';
import {renderHistory} from './history.tsx';
import {initializeDocuments} from './documents.tsx';
import {renderPoints,validCoordinate} from './sketch.tsx';
import {renderRequests,renderActiveWork} from './requests.tsx';
import {initializeInspector,renderInspector} from './inspector.ts';
import {api,connect,errors} from './gateway.ts';
import {objects,models,initial,chooseModel,pinSelection,attachHostSelection,attachReviewNote,failedRequestDraft,draftHasInput,validate,packet,attachSketch,storageKey} from './model.ts';
import {createViewport} from './viewport.ts';

let project:{id:string;name:string}|undefined,busy=false,displayedResult:string|undefined,selectedResult:string|null|undefined,draftSaved=false,unreadableDraft=false;
function currentProject(){if(!project)throw Error('프로젝트를 먼저 여세요.');return project;}
let state=initial();let tool:'select'|'pin'|'sketch'='select',points:Point2[]=[],toastTimer:ReturnType<typeof setTimeout>|undefined;
const message=(text:string)=>{clearTimeout(toastTimer);$('message').textContent=text;$('message').hidden=false;toastTimer=setTimeout(()=>$('message').hidden=true,4500);};
const reviews=initializeReviews(()=>project?.id,message,(note,review)=>{
 if(busy)throw Error('현재 요청 전송이 끝난 뒤 첨부하세요.');
 attachReviewNote(state,note,review);render();if($('right').hidden)$('toggle-right').click();mobileView('input');
 message('의견과 원 기준을 요청 초안에 첨부했습니다. 조건을 확인한 뒤 보내세요.');
},id=>{selectedResult=id;renderMessages();message('의견 작성 당시 후보를 열었습니다.');});
initializeDocuments(message,async target=>{
 if(!project||busy)throw Error('현재 작업이 끝난 뒤 가져오세요.');
 busy=true;render();message('열린 Rhino 문서의 작업 사본을 가져오고 있습니다.');
 try{const request=await requestData(`/projects/${currentProject().id}/capture`,'POST',{...target,id:crypto.randomUUID()});
 state.messages.push(requestMessage(request));if(request.result?.hostExecuted){selectedResult=request.id;state.selected=null;}
 renderMessages();message(request.result?.text||errors[request.result?.code??'']||'작업 사본을 가져오지 못했습니다.');
 }finally{busy=false;render();}
},selection=>{
 const request=state.messages.find(message=>message.id===displayedResult)?.request;
 const count=attachHostSelection(state,request,selection);render();
 message(selection.selectedIds.length?`${count}개 객체를 요청에 첨부했습니다.`:'Rhino에서 선택한 객체가 없습니다.');
});
let inspectorTab:NonNullable<Parameters<typeof renderInspector>[3]>='properties';
initializeInspector(tab=>{inspectorTab=tab;render();});
let viewport:ReturnType<typeof createViewport>|undefined;
try{viewport=createViewport($('canvas'),objects,(id,pin)=>{state.selected=id;if(pin)pinSelection(state);render();},point=>{points.push(point);draw();});}catch{message('3D 뷰포트를 열 수 없습니다. WebGL 지원을 확인하세요.');}
function planeName(){return z.enum(['XY','XZ','YZ']).parse($('plane').value);}
function captureViewport(){if(!viewport)throw Error('3D 화면을 준비한 뒤 다시 시도하세요.');return viewport.capture();}
function draw(){renderPoints(points,draw,message);viewport?.lines(state.sketches,points,planeName());$('finish-sketch').disabled=points.length<2;$('undo-point').disabled=!points.length;}
function setTool(next:'select'|'pin'|'sketch'){if(tool==='sketch'&&next!=='sketch'&&points.length){message('그린 선을 첨부하거나 취소하세요.');return;}tool=next;document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tool===tool)));$('sketch-tools').hidden=tool!=='sketch';viewport?.mode(tool,planeName());$('tool-hint').textContent=tool==='sketch'?'평면에 점을 찍어 선을 그리세요. Esc 취소':tool==='pin'?'객체를 누르면 입력에 첨부됩니다.':'';draw();}
function chip(text:string,remove:()=>void,pin?:DraftPin){const span=el('span',text,$('context'),{class:'chip'});const b=el('button','×',span,{'aria-label':`${text} 제외`});b.onclick=remove;if(pin){const role=el('select','',span,{'aria-label':pin.name+' 역할'});for(const [value,label] of [['target','변경'],['preserve','유지'],['reference','참고']])el('option',label,role,{value});role.value=pin.role;role.onchange=()=>{pin.role=z.enum(['target','preserve','reference']).parse(role.value);render();};}}
function render(rebuildRequests=true){
 if(unreadableDraft&&draftHasInput(state))unreadableDraft=false;
 if(!draftHasInput(state)&&displayedResult)state.baseRequestId=displayedResult;
 if(rebuildRequests)renderRequests(state,render);
 renderActiveWork(state.messages);
 $('host-target').value=state.host||'rhino';
 if(project&&!unreadableDraft)try{localStorage.setItem('vide:draft:'+currentProject().id,JSON.stringify(draftSnapshot(state)));draftSaved=true;}catch{draftSaved=false;}
 $('objects').replaceChildren();for(const o of objects){const b=el('button',o.name,$('objects'),{class:'object','aria-pressed':String(state.selected===o.id)});b.onclick=()=>{state.selected=o.id;if(tool==='pin')pinSelection(state);render();};}
 viewport?.select(state.selected);$('selection').textContent=objects.find(o=>o.id===state.selected)?.name||'';$('selection-pin').hidden=!state.selected;
 $('context').replaceChildren();state.pins.forEach((p,i)=>chip('@ '+p.name,()=>{state.pins.splice(i,1);render();},p));state.sketches.forEach((s,i)=>chip('⌁ '+s.name,()=>{state.sketches.splice(i,1);render();}));state.files.forEach((f,i)=>chip('▧ '+(f.displayName||f.name),()=>{state.files.splice(i,1);render();}));
 if(draftHasInput(state)&&displayedResult&&state.baseRequestId!==displayedResult){if(state.baseRequestId){const basis=el('button','입력 기준 보기',$('context'));basis.onclick=()=>{selectedResult=state.baseRequestId;renderMessages();};}else el('small','새 작업 기준',$('context'));}
 const selected=models.find(m=>m.id===state.model);if(!selected&&!Array.from($('model').options).some(option=>option.value===state.model))el('option',state.model+' · 사용 확인 필요',$('model'),{value:state.model});$('model').value=state.model;$('effort').replaceChildren();(selected?.efforts||[state.effort]).forEach(e=>el('option',e,$('effort'),{value:e}));$('effort').value=state.effort;$('permission').value=state.permission;
 const active=state.messages.find(m=>m.id===displayedResult)?.request;renderInspector(objects.find(o=>o.id===state.selected),active?.result,active,inspectorTab,{quantities:(request,object)=>{if(!request)return;void showQuantities(currentProject().id,request.id,id=>{selectedResult=request.id;renderMessages();state.selected=id;render();},object.id).catch(error=>message(error.message));},attachAttributes:(request,object)=>{try{if(busy)throw Error('전송이 끝난 뒤 첨부하세요.');if(!request)throw Error('기준 후보를 확인하세요.');attachNativeAttributes(state,request,object);render();message('표시된 속성을 요청 초안에 첨부했습니다.');}catch(cause){const error=readableError(cause);message(error.message);}},get:id=>state.messages.find(message=>message.id===id)?.request,open:(id,objectId)=>{selectedResult=id;renderMessages();state.selected=objectId||null;render();}});$('document-host').textContent=(active?.result?.host||state.host)==='zwcad'?'ZWCAD':'Rhino';$('work-count').textContent=`${state.messages.length}개 작업`;$('workspace-status').textContent=state.messages.some(m=>['queued','running'].includes(m.request?.state))?'작업 진행 중':project?'로컬 작업 공간 · '+project.name:'연결 중';
 sidebar();$('request').disabled=!project||busy||state.messages.some(m=>['queued','running'].includes(m.request?.state))||!!validate(state);$('request').title=validate(state)||'보내기 · Ctrl+Enter';draw();
}
function sidebar(){
 $('task-list').replaceChildren();if(!state.messages.length)el('small','아직 요청이 없습니다.',$('task-list'));state.messages.forEach((m,i)=>{const b=el('button',m.body||`첨부 검토 ${i+1}`,$('task-list'));b.onclick=()=>{if($('right').hidden)$('toggle-right').click();mobileView('input');document.querySelectorAll('.chat-message')[i]?.scrollIntoView({block:'nearest'});};});
 $('reference-list').replaceChildren();const files=[...state.messages.flatMap(m=>m.files),...state.files];if(!files.length)el('small','첨부한 파일이 없습니다.',$('reference-list'));files.forEach(f=>el('small',f.name,$('reference-list')));
}
function renderMessages(){
 const latest=selectedResult===null?undefined:state.messages.find(m=>m.id===selectedResult)||state.messages.filter(m=>m.request?.result?.hostExecuted&&(m.request.result.host||'rhino')===(state.host||'rhino')).at(-1);
 if(latest&&latest.id!==displayedResult){const result=latest.request.result;if(!result?.hostExecuted||!result.objects||!result.scene){message('후보 형상을 확인할 수 없습니다.');return;}if(!draftHasInput(state)){state.host=result.host||'rhino';$('host-target').value=state.host;}objects.splice(0,objects.length,...result.objects.map(o=>({...o,revision:latest.id})));viewport?.replace(result.scene);displayedResult=latest.id;render();}
 sidebar();renderHistory($('conversation'),state.messages,models,project?.id,{
  restore:request=>{
   if(busy)throw Error('현재 전송이 끝난 뒤 복원하세요.');
   const draft=failedRequestDraft(state,request);
   if((state.body.trim()||(state.instructions||[]).length||state.pins.length||state.sketches.length||state.files.length||points.length)&&!confirm('현재 작성 중인 초안을 저장된 요청 입력으로 바꿀까요?'))return;
   Object.assign(state,draft);selectedResult=draft.baseRequestId??null;displayedResult=undefined;objects.splice(0,objects.length);viewport?.replace([]);points=[];$('body').value=state.body;render();renderMessages();if($('right').hidden)$('toggle-right').click();mobileView('input');message('원 입력과 기준을 복원했습니다. 설정을 확인한 뒤 보내세요.');
  },
  candidate:id=>{selectedResult=id;renderMessages();},
  selection:(requestId,id)=>{selectedResult=requestId;renderMessages();state.selected=id;render();},
  report:downloadReport,saveReview:async id=>{selectedResult=id;renderMessages();await reviews.create(id,captureViewport());},changed:renderMessages,error:message,
 });
}

$('quit-app').onclick=async()=>{
 if(!confirm('VIDE를 종료할까요? 진행 중인 작업은 마무리하거나 중단하고 기록을 보존합니다.'))return;
 try{await api('/shutdown','POST',{});document.body.replaceChildren();const text=document.createElement('p');text.textContent='VIDE 종료 중입니다. 이 창을 닫아도 됩니다.';document.body.append(text);}catch(cause){const error=readableError(cause);message(error.message);}
};
$('extensions').onclick=()=>{if(!project)return;void showExtensions({projectId:project.id,requestId:displayedResult,selected:state.selected,objects:structuredClone(objects)},request=>{
 if(!state.messages.some(message=>message.id===request.id))state.messages.push(requestMessage(request));renderMessages();render();mobileView('input');
}).catch(error=>message(error.message));};
$('ai-settings').onclick=()=>{ $('draft-menu').open=false;void showAiSettings(rows=>{const host=$('connection-status').textContent.match(/ · Rhino.*$/)?.[0]||'';$('connection-status').textContent=rows.map(row=>`${row.id==='claude-cli'?'Claude':'ChatGPT'} ${row.available?'연결됨':'미연결'}`).join(' · ')+host;}).catch(error=>message(error.message));};
for(const model of models)el('option',model.name,$('model'),{value:model.id});
$('model').onchange=()=>{chooseModel(state,$('model').value);render();};$('effort').onchange=()=>{state.effort=$('effort').value;render();};$('permission').onchange=()=>{state.permission=z.enum(['review','candidate']).parse($('permission').value);render();};
$('body').oninput=()=>{state.body=$('body').value;render();$('saved').textContent=draftSaved?'초안 저장됨':'저장 실패';if(state.body.endsWith('@'))$('attach-menu').open=true;};
$('request').onclick=async()=>{
 if(validate(state)||busy||!project)return;
 busy=true;render();
 const input={...packet(state),id:crypto.randomUUID()};
 try{
  const request=await requestData(`/projects/${currentProject().id}/requests`,'POST',input);
  state.messages.push(requestMessage(request));state.body='';state.instructions=[];state.pins=[];state.sketches=[];state.files=[];$('body').value='';
  renderMessages();void poll(request.id);
 }catch(cause){const error=readableError(cause);message(errors[error.code??'']||error.message);}
 finally{busy=false;render();}
};
async function poll(id:string){
 try{
  const request=await requestData(`/projects/${currentProject().id}/requests/${id}`);
  const m=state.messages.find(x=>x.id===id);if(m)m.request=request;if(request.result?.hostExecuted)selectedResult=request.id;renderMessages();render();
  if(['queued','running'].includes(request.state))setTimeout(()=>poll(id),1200);
 }catch(cause){const error=readableError(cause);message('작업 상태 연결이 끊겼습니다. 새로고침하면 저장된 기록을 다시 읽습니다.');}
}
$('body').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!e.isComposing){e.preventDefault();$('request').click();}};
$('pin').onclick=()=>{pinSelection(state);$('attach-menu').open=false;render();$('body').focus();};
$('draw').onclick=()=>{$('attach-menu').open=false;mobileView('model');setTool('sketch');};
$('attach-file').onclick=()=>{$('files').click();$('attach-menu').open=false;};
$('files').onchange=async()=>{try{for(const f of $('files').files??[]){if(f.size>50000||!(/\.(txt|md|csv|json)$/i.test(f.name)))throw Error('현재 참고 자료는 50KB 이하 TXT·MD·CSV·JSON을 지원합니다.');state.files.push({name:f.name,size:f.size,type:f.type,text:await f.text(),contentStatus:'included'});}render();}catch(cause){const error=readableError(cause);message(error.message);}finally{$('files').value='';}};
$('selection-pin').onclick=()=>{$('pin').click();};
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]'))button.onclick=()=>setTool(z.enum(['select','pin','sketch']).parse(button.dataset.tool));
$('plane').onchange=()=>{if(points.length){$('plane').value=state.drawingPlane||'XY';message('작성 중인 선을 첨부하거나 취소한 뒤 평면을 바꾸세요.');return;}state.drawingPlane=planeName();viewport?.plane(planeName());};
$('finish-sketch').onclick=()=>{try{attachSketch(state,points,$('plane').value,$('line-role').value);points=[];setTool('select');render();mobileView('input');$('body').focus();}catch(cause){message(readableError(cause).message);}};
$('cancel-sketch').onclick=()=>{points=[];setTool('select');};$('undo-point').onclick=()=>{points.pop();draw();};
$('fit-view').onclick=()=>viewport?.fit();
$('projection').onchange=()=>{if(tool==='sketch'){message('스케치를 마친 뒤 뷰를 바꿀 수 있습니다.');return;}if($('projection').value==='axon')viewport?.home();else viewport?.plane(({plan:'XY',front:'XZ',side:'YZ'} as const)[z.enum(['plan','front','side']).parse($('projection').value)]);};
$('save').onclick=()=>{if(!project||busy)return;try{localStorage.setItem(storageKey+':'+currentProject().id,JSON.stringify({version:4,projectId:currentProject().id,state:draftSnapshot(state)}));$('saved').textContent='저장됨';$('draft-menu').open=false;message('이 프로젝트의 초안을 이 브라우저에 저장했습니다.');}catch{message('저장 실패. 초안은 유지됩니다.');}};
$('load').onclick=()=>{if(!project||busy)return;try{state=restoreSavedDraft(JSON.parse(localStorage.getItem(storageKey+':'+currentProject().id)??'null'),currentProject().id,state.messages);selectedResult=state.baseRequestId??null;displayedResult=undefined;objects.splice(0,objects.length);viewport?.replace([]);points=[];$('body').value=state.body;$('draft-menu').open=false;render();renderMessages();message('초안을 불러왔습니다.');}catch{message('이 프로젝트에서 읽을 수 있는 저장본이 없습니다.');}};
function mobileView(view:MobileView){setMobileView(view);}
for(const side of ['left','right'])$(`toggle-${side}`).onclick=()=>{if(matchMedia('(max-width:850px)').matches){$(side).hidden=false;mobileView(side==='left'?'documents':'input');return;}$(side).hidden=!$(side).hidden;document.body.classList.toggle(`${side}-hidden`,Boolean($(side).hidden));$(`toggle-${side}`).setAttribute('aria-expanded',String(!$(side).hidden));$(`toggle-${side}`).textContent=side==='left'?($(side).hidden?'›':'‹'):($(side).hidden?'‹':'›');$(`toggle-${side}`).focus();};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(tool==='sketch'){points=[];setTool('select');}$('attach-menu').open=false;$('draft-menu').open=false;}if(e.altKey&&e.shiftKey&&['KeyL','KeyR'].includes(e.code)){e.preventDefault();$(`toggle-${e.code==='KeyL'?'left':'right'}`).click();}});
window.addEventListener('beforeunload',e=>{if(points.length||(!draftSaved&&(state.body||state.instructions?.length||state.pins.length||state.sketches.length))){e.preventDefault();e.returnValue='';}});
window.addEventListener('pagehide',()=>viewport?.dispose(),{once:true});
mobileView('model');render();


function selectProject(id:string){location.search='?project='+encodeURIComponent(id);}
const createProject=async()=>{const name=prompt('프로젝트 이름');if(!name?.trim())return;try{const p=z.object({id:z.string()}).parse(await api('/projects','POST',{name:name.trim()}));location.search='?project='+encodeURIComponent(p.id);}catch(cause){const error=readableError(cause);message(error.message);}};

$('import-model').onclick=()=>{if(project&&!busy)$('model-file').click();};
$('model-file').onchange=async()=>{
 const file=$('model-file').files?.[0];if(!file||!project)return;
 if(file.size>64*1024*1024){message('현재 파일 크기는 64MB까지 지원합니다.');return;}
 busy=true;$('import-model').disabled=true;render();message('모델 작업 사본을 읽고 있습니다.');
 try{
  const response=await fetch(`/api/v1/projects/${currentProject().id}/import?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
  const value:unknown=await response.json();if(!response.ok)throw Error(z.object({code:z.string()}).parse(value).code);const request=requestMessage(value).request;
  state.messages.push(requestMessage(request));if(request.result?.hostExecuted){selectedResult=request.id;state.pins=[];}renderMessages();
  message(request.state==='succeeded'?'작업 사본을 열었습니다.':errors[request.result?.code??'']||'불러오기에 실패했습니다.');
 }catch(cause){const error=readableError(cause);message(error.message);}finally{busy=false;$('import-model').disabled=false;$('model-file').value='';render();}
};

async function downloadReport(id:string){
 try{
  selectedResult=id;renderMessages();
  const response=await fetch(`/api/v1/projects/${currentProject().id}/requests/${id}/report`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:captureViewport()})});
  if(!response.ok){const failure=await response.json();throw Error(failure.code);}
  const url=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');anchor.href=url;anchor.download='VIDE-review.html';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(cause){const error=readableError(cause);message(error.message);}
}

$('host-target').onchange=()=>{
 state.host=z.enum(['rhino','zwcad']).parse($('host-target').value);state.baseRequestId=undefined;state.selected=null;selectedResult=undefined;displayedResult=undefined;
 objects.splice(0,objects.length);viewport?.replace([]);renderMessages();render();
};

for(const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))button.onclick=()=>{
  if(tool==='sketch'){message('스케치를 마친 뒤 뷰를 바꿀 수 있습니다.');return;}
  $('projection').value=z.enum(['axon','plan','front','side']).parse(button.dataset.view);$('projection').dispatchEvent(new Event('change'));
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
};
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-section]'))button.onclick=()=>{
  if($('left').hidden)$('toggle-left').click();
  mobileView('documents');
  const sectionId=button.dataset.section;if(!sectionId)return;const section=$(sectionId);const details=section.closest('details');if(details)details.open=true;
  section.scrollIntoView({block:'nearest'});
  document.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
};

$('fit-selection').onclick=()=>{if(state.selected)viewport?.fit(state.selected);else message('먼저 객체를 선택하세요.');};
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-projection]'))button.onclick=()=>{
 if(tool==='sketch'){message('스케치를 마친 뒤 투영을 바꿀 수 있습니다.');return;}
 viewport?.projection(z.enum(['orthographic','perspective']).parse(button.dataset.projection));
};

$('add-request').onclick=()=>{
 if(!state.body.trim())return;
 state.instructions??=[];state.instructions.push(state.body);state.body='';$('body').value='';render();$('body').focus();
};

$('add-point').onclick=()=>{
 const point:Point2=[$('point-u').valueAsNumber,$('point-v').valueAsNumber];
 if(!point.every(validCoordinate)){message('U·V 좌표를 m 단위 숫자로 입력하세요.');return;}
 if(points.length>=1000){message('스케치 하나에 1,000점까지 입력할 수 있습니다.');return;}
 points.push(point);$('point-u').value='';$('point-v').value='';draw();$('point-u').focus();
};
for(const id of ['point-u','point-v'] as const)$(id).onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('add-point').click();}};

async function initializeWorkspace(){
 try{
  const linked=await connect();
  const catalog=modelsSchema.parse(await api('/models'));
  models.splice(0,models.length,...catalog);
  $('model').replaceChildren();
  for(const model of models)el('option',model.name,$('model'),{value:model.id});
  project=linked.project;
  state.messages=linked.requests.map(requestMessage);
  void reviews.refresh().catch(error=>message(error.message));
  renderProjectHeading({projects:linked.projects,selected:project.id,select:selectProject,create:createProject});
  let restored=false;
  try{
   const raw=localStorage.getItem('vide:draft:'+project.id);
   if(raw){state=restoreDraft(JSON.parse(raw),state.messages);selectedResult=state.baseRequestId??null;restored=true;$('body').value=state.body;}
  }catch{unreadableDraft=true;message('저장된 초안의 형식 또는 기준을 확인할 수 없습니다. 작업 이력은 유지됩니다.');}
  if(!restored)selectedResult=linked.requests.filter(request=>request.result?.hostExecuted).at(-1)?.id;
  render();renderMessages();
  for(const entry of state.messages)if(['queued','running'].includes(entry.request.state))void poll(entry.id);
  const host=hostStatusSchema.parse(await api('/host'));
  const providers=providersSchema.parse(await api('/providers'));
  $('connection-status').textContent=providers.map(provider=>`${provider.id==='claude-cli'?'Claude':'ChatGPT'} ${provider.available?'연결됨':'미연결'}`).join(' · ')+(host.available?(host.mode==='sdk'?' · Rhino 실행 준비':' · Rhino 연결됨'):' · Rhino 미연결');
 }catch(cause){const error=readableError(cause);message(errors[error.code??'']||error.message);}
}
await initializeWorkspace();
