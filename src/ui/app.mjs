import {showQuantities} from './quantities.mjs';
import {renderPoints,validCoordinate} from './sketch.mjs';
import {renderRequests,renderActiveWork} from './requests.mjs';
import {initializeInspector,renderInspector} from './inspector.mjs';
import {api,connect,labels,errors} from './gateway.mjs';
import {objects,models,initial,chooseModel,pinSelection,validate,packet,attachSketch,storageKey} from './model.mjs';
import {createViewport} from './viewport.mjs';
const $=id=>document.getElementById(id);
let project, busy=false, displayedResult,selectedResult,draftSaved=false;
let state=initial(),tool='select',points=[],toastTimer;
const message=text=>{clearTimeout(toastTimer);$('message').textContent=text;$('message').hidden=false;toastTimer=setTimeout(()=>$('message').hidden=true,4500);};
function el(tag,text,parent,attrs={}){const node=document.createElement(tag);node.textContent=text;for(const [k,v] of Object.entries(attrs))node.setAttribute(k,v);parent.append(node);return node;}
let inspectorTab='properties';
initializeInspector(tab=>{inspectorTab=tab;render();});
let viewport;
try{viewport=createViewport($('canvas'),objects,(id,pin)=>{state.selected=id;if(pin)pinSelection(state);render();},point=>{points.push(point);draw();});}catch{message('3D 뷰포트를 열 수 없습니다. WebGL 지원을 확인하세요.');}
function draw(){renderPoints(points,draw,message);viewport?.lines(state.sketches,points,$('plane').value);$('finish-sketch').disabled=points.length<2;$('undo-point').disabled=!points.length;}
function setTool(next){if(tool==='sketch'&&next!=='sketch'&&points.length){message('그린 선을 첨부하거나 취소하세요.');return;}tool=next;document.querySelectorAll('[data-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tool===tool)));$('sketch-tools').hidden=tool!=='sketch';viewport?.mode(tool,$('plane').value);$('tool-hint').textContent=tool==='sketch'?'평면에 점을 찍어 선을 그리세요. Esc 취소':tool==='pin'?'객체를 누르면 입력에 첨부됩니다.':'';draw();}
function chip(text,remove,pin){const span=el('span',text,$('context'),{class:'chip'});const b=el('button','×',span,{'aria-label':`${text} 제외`});b.onclick=remove;if(pin){const role=el('select','',span,{'aria-label':pin.name+' 역할'});for(const [value,label] of [['target','변경'],['preserve','유지'],['reference','참고']])el('option',label,role,{value});role.value=pin.role;role.onchange=()=>{pin.role=role.value;render();};}}
function render(rebuildRequests=true){
 if(rebuildRequests)renderRequests(state,render);
 renderActiveWork(state.messages);
 $('host-target').value=state.host||'rhino';
 if(project)try{localStorage.setItem('vide:draft:'+project.id,JSON.stringify({host:state.host,body:state.body,instructions:state.instructions,pins:state.pins,sketches:state.sketches,files:state.files,model:state.model,effort:state.effort,permission:state.permission}));draftSaved=true;}catch{draftSaved=false;}
 $('objects').replaceChildren();for(const o of objects){const b=el('button',o.name,$('objects'),{class:'object','aria-pressed':String(state.selected===o.id)});b.onclick=()=>{state.selected=o.id;if(tool==='pin')pinSelection(state);render();};}
 viewport?.select(state.selected);$('selection').textContent=objects.find(o=>o.id===state.selected)?.name||'';$('selection-pin').hidden=!state.selected;
 $('context').replaceChildren();state.pins.forEach((p,i)=>chip('@ '+p.name,()=>{state.pins.splice(i,1);render();},p));state.sketches.forEach((s,i)=>chip('⌁ '+s.name,()=>{state.sketches.splice(i,1);render();}));state.files.forEach((f,i)=>chip('▧ '+f.name,()=>{state.files.splice(i,1);render();}));
 const selected=models.find(m=>m.id===state.model);$('model').value=state.model;$('effort').replaceChildren();selected.efforts.forEach(e=>el('option',e,$('effort'),{value:e}));$('effort').value=state.effort;$('permission').value=state.permission;
 const active=state.messages.find(m=>m.id===displayedResult)?.request;renderInspector(objects.find(o=>o.id===state.selected),active?.result,active,inspectorTab);$('document-host').textContent=state.host==='zwcad'?'ZWCAD':'Rhino';$('work-count').textContent=`${state.messages.length}개 작업`;$('workspace-status').textContent=state.messages.some(m=>['queued','running'].includes(m.request?.state))?'작업 진행 중':project?'로컬 작업 공간 · '+project.name:'연결 중';
 sidebar();$('request').disabled=!project||busy||state.messages.some(m=>['queued','running'].includes(m.request?.state))||!!validate(state);$('request').title=validate(state)||'보내기 · Ctrl+Enter';draw();
}
function sidebar(){
 $('task-list').replaceChildren();if(!state.messages.length)el('small','아직 요청이 없습니다.',$('task-list'));state.messages.forEach((m,i)=>{const b=el('button',m.body||`첨부 검토 ${i+1}`,$('task-list'));b.onclick=()=>{if($('right').hidden)$('toggle-right').click();mobileView('input');document.querySelectorAll('.chat-message')[i]?.scrollIntoView({block:'nearest'});};});
 $('reference-list').replaceChildren();const files=[...state.messages.flatMap(m=>m.files),...state.files];if(!files.length)el('small','첨부한 파일이 없습니다.',$('reference-list'));files.forEach(f=>el('small',f.name,$('reference-list')));
}
function renderMessages(){
 const latest=state.messages.find(m=>m.id===selectedResult)||state.messages.filter(m=>m.request?.result?.hostExecuted&&(m.request.result.host||'rhino')===(state.host||'rhino')).at(-1);
 if(latest&&latest.id!==displayedResult){const result=latest.request.result;state.host=result.host||'rhino';$('host-target').value=state.host;objects.splice(0,objects.length,...result.objects.map(o=>({...o,revision:latest.id})));viewport?.replace(result.scene);displayedResult=latest.id;state.baseRequestId=latest.id;render();}
 sidebar();const box=$('conversation');box.replaceChildren();if(!state.messages.length){el('div','V.',box,{class:'chat-empty'});return;}for(const m of state.messages){const card=el('article','',box,{class:'chat-message'});el('p',m.body||'첨부한 문맥 검토',card);const refs=[...m.pins.map(p=>p.name),...m.sketches.map(s=>s.name),...m.files.map(f=>f.name)];if(refs.length)el('small',refs.join(' · '),card);el('small',m.source==='file'?'Rhino 작업 사본':`${models.find(x=>x.id===m.model)?.name||m.model} · ${m.effort} · ${m.permission==='review'?'검토만':'후보 작업 허용'}`,card);const details=el('details','',card);el('summary','요청 문맥',details);el('pre',JSON.stringify(m.request?.input||m,null,2),details);if(m.request){el('small',m.request.state==='running'&&m.request.result?.phase==='host'?'호스트 생성·저장 검증 중':m.request.result?.phase==='stopping'?'중단 확인 중':labels[m.request.state]||m.request.state,card);if(m.request.result?.text)el('p',m.request.result.text,card);if(m.request.result?.hostExecuted){const view=el('button','이 후보 보기',card);view.onclick=()=>{selectedResult=m.id;renderMessages();};el('small',`${m.request.result.host==='zwcad'?'ZWCAD':'Rhino'} 후보 · 저장·재열기 검증됨`,card);el('a',m.request.result.host==='zwcad'?'DWG 내려받기':'3dm 내려받기',card,{href:`/api/v1/projects/${project.id}/requests/${m.id}/model`,download:m.request.result.host==='zwcad'?'VIDE-candidate.dwg':'VIDE-candidate.3dm'});const open=el('button',m.request.result.host==='zwcad'?'ZWCAD에서 열기':'Rhino에서 열기',card);open.onclick=async()=>{open.disabled=true;try{await api(`/projects/${project.id}/requests/${m.id}/open`,'POST',{});}catch(error){message(error.message);}finally{open.disabled=false;}};const report=el('button','검토본 내려받기',card);report.onclick=()=>downloadReport(m.id);const table=el('button','수량표',card);table.onclick=async()=>{try{await showQuantities(project.id,m.id,id=>{selectedResult=m.id;renderMessages();state.selected=id;render();});}catch(error){message(error.message);}};const measurements=el('details','',card);el('summary','측정값',measurements);for(const object of m.request.result.scene||[])el('p',`${m.request.result.objects.find(o=>o.id===object.id)?.name||object.id} · 기하 면적 ${object.area?.toFixed(2)??'—'} m² · 체적 ${object.volume?.toFixed(2)??'—'} m³`,measurements);}if(m.request.result?.code)el('p',errors[m.request.result.code]||m.request.result.code,card);if(['queued','running'].includes(m.request.state)&&m.request.result?.phase!=='host'){const stop=el('button','중단',card);stop.onclick=async()=>{await api(`/projects/${project.id}/requests/${m.id}/cancel`,'POST',{});stop.disabled=true;};}}}box.scrollTop=box.scrollHeight;}
for(const model of models)el('option',model.name,$('model'),{value:model.id});
$('model').onchange=()=>{chooseModel(state,$('model').value);render();};$('effort').onchange=()=>{state.effort=$('effort').value;render();};$('permission').onchange=()=>{state.permission=$('permission').value;render();};
$('body').oninput=()=>{state.body=$('body').value;render();$('saved').textContent=draftSaved?'초안 저장됨':'저장 실패';if(state.body.endsWith('@'))$('attach-menu').open=true;};
$('request').onclick=async()=>{
 if(validate(state)||busy||!project)return;
 busy=true;render();
 const input={...packet(state),id:crypto.randomUUID()};
 try{
  const request=await api(`/projects/${project.id}/requests`,'POST',input);
  state.messages.push({...input,...request.input,request});state.body='';state.instructions=[];state.pins=[];state.sketches=[];state.files=[];$('body').value='';
  renderMessages();void poll(request.id);
 }catch(error){message(errors[error.code]||error.message);}
 finally{busy=false;render();}
};
async function poll(id){
 try{
  const request=await api(`/projects/${project.id}/requests/${id}`);
  const m=state.messages.find(x=>x.id===id);if(m)m.request=request;if(request.result?.hostExecuted)selectedResult=request.id;renderMessages();render();
  if(['queued','running'].includes(request.state))setTimeout(()=>poll(id),1200);
 }catch(error){message('작업 상태 연결이 끊겼습니다. 새로고침하면 저장된 기록을 다시 읽습니다.');}
}
$('body').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!e.isComposing){e.preventDefault();$('request').click();}};
$('pin').onclick=()=>{pinSelection(state);$('attach-menu').open=false;render();$('body').focus();};
$('draw').onclick=()=>{$('attach-menu').open=false;mobileView('model');setTool('sketch');};
$('attach-file').onclick=()=>{$('files').click();$('attach-menu').open=false;};
$('files').onchange=async()=>{try{for(const f of $('files').files){if(f.size>50000||!(/\.(txt|md|csv|json)$/i.test(f.name)))throw Error('현재 참고 자료는 50KB 이하 TXT·MD·CSV·JSON을 지원합니다.');state.files.push({name:f.name,size:f.size,type:f.type,text:await f.text(),contentStatus:'included'});}render();}catch(error){message(error.message);}finally{$('files').value='';}};
$('selection-pin').onclick=()=>{$('pin').click();};
for(const button of document.querySelectorAll('[data-tool]'))button.onclick=()=>setTool(button.dataset.tool);
$('plane').onchange=()=>{if(points.length){$('plane').value=state.drawingPlane||'XY';message('작성 중인 선을 첨부하거나 취소한 뒤 평면을 바꾸세요.');return;}state.drawingPlane=$('plane').value;viewport?.plane($('plane').value);};
$('finish-sketch').onclick=()=>{try{attachSketch(state,points,$('plane').value,$('line-role').value);points=[];setTool('select');render();mobileView('input');$('body').focus();}catch(e){message(e.message);}};
$('cancel-sketch').onclick=()=>{points=[];setTool('select');};$('undo-point').onclick=()=>{points.pop();draw();};
$('fit-view').onclick=()=>viewport?.fit();
$('projection').onchange=()=>{if(tool==='sketch'){message('스케치를 마친 뒤 뷰를 바꿀 수 있습니다.');return;}if($('projection').value==='axon')viewport?.home();else viewport?.plane({plan:'XY',front:'XZ',side:'YZ'}[$('projection').value]);};
$('save').onclick=()=>{try{localStorage.setItem(storageKey,JSON.stringify({version:3,state}));$('saved').textContent='저장됨';$('draft-menu').open=false;message('초안을 이 브라우저에 저장했습니다.');}catch{message('저장 실패. 초안은 유지됩니다.');}};
$('load').onclick=()=>{try{const saved=JSON.parse(localStorage.getItem(storageKey));if(saved?.version!==3||typeof saved.state?.body!=='string'||!['pins','sketches','files','messages'].every(k=>Array.isArray(saved.state[k])))throw Error();chooseModel(saved.state,saved.state.model);state={...saved.state,messages:state.messages};points=[];$('body').value=state.body;$('draft-menu').open=false;render();renderMessages();message('초안을 불러왔습니다.');}catch{message('읽을 수 있는 저장본이 없습니다.');}};
function mobileView(view){document.body.dataset.mobile=view;document.querySelectorAll('button[data-mobile]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mobile===view)));}
for(const b of document.querySelectorAll('button[data-mobile]'))b.onclick=()=>mobileView(b.dataset.mobile);
for(const side of ['left','right'])$(`toggle-${side}`).onclick=()=>{if(matchMedia('(max-width:850px)').matches){$(side).hidden=false;mobileView(side==='left'?'documents':'input');return;}$(side).hidden=!$(side).hidden;document.body.classList.toggle(`${side}-hidden`,$(side).hidden);$(`toggle-${side}`).setAttribute('aria-expanded',String(!$(side).hidden));$(`toggle-${side}`).textContent=side==='left'?($(side).hidden?'›':'‹'):($(side).hidden?'‹':'›');$(`toggle-${side}`).focus();};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(tool==='sketch'){points=[];setTool('select');}$('attach-menu').open=false;$('draft-menu').open=false;}if(e.altKey&&e.shiftKey&&['KeyL','KeyR'].includes(e.code)){e.preventDefault();$(`toggle-${e.code==='KeyL'?'left':'right'}`).click();}});
window.addEventListener('beforeunload',e=>{if(points.length||(!draftSaved&&(state.body||state.instructions?.length||state.pins.length||state.sketches.length))){e.preventDefault();e.returnValue='';}});
window.addEventListener('pagehide',()=>viewport?.dispose(),{once:true});
mobileView('model');render();

try{const linked=await connect();const catalog=await api('/models');models.splice(0,models.length,...catalog);$('model').replaceChildren();for(const m of models)el('option',m.name,$('model'),{value:m.id});project=linked.project;for(const p of linked.projects)el('option',p.name,$('project-picker'),{value:p.id});$('project-picker').value=project.id;try{const draft=JSON.parse(localStorage.getItem('vide:draft:'+project.id));if(draft&&typeof draft.body==='string'&&['pins','sketches','files'].every(k=>Array.isArray(draft[k]))){Object.assign(state,draft);chooseModel(state,state.model);$('body').value=state.body;}}catch{}state.messages=linked.requests.map(request=>({...request.input,request}));$('project-name').textContent=project.name;render();renderMessages();for(const m of state.messages)if(['queued','running'].includes(m.request.state))void poll(m.id);const host=await api('/host');const providers=await api('/providers');$('connection-status').textContent=providers.map(p=>`${p.id==='claude-cli'?'Claude':'ChatGPT'} ${p.available?'연결됨':'미연결'}`).join(' · ')+(host.available?' · Rhino 연결됨':' · Rhino 미연결');}catch(error){message(errors[error.code]||error.message);}

$('project-picker').onchange=()=>{location.search='?project='+encodeURIComponent($('project-picker').value);};
$('new-project').onclick=async()=>{const name=prompt('프로젝트 이름');if(!name?.trim())return;try{const p=await api('/projects','POST',{name:name.trim()});location.search='?project='+encodeURIComponent(p.id);}catch(error){message(error.message);}};

$('import-model').onclick=()=>{if(project&&!busy)$('model-file').click();};
$('model-file').onchange=async()=>{
 const file=$('model-file').files[0];if(!file||!project)return;
 if(file.size>64*1024*1024){message('현재 파일 크기는 64MB까지 지원합니다.');return;}
 busy=true;$('import-model').disabled=true;render();message('Rhino 작업 사본을 읽고 있습니다.');
 try{
  const response=await fetch(`/api/v1/projects/${project.id}/import?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
  const request=await response.json();if(!response.ok)throw Error(request.code);
  state.messages.push({...request.input,request});if(request.result?.hostExecuted){selectedResult=request.id;state.pins=[];}renderMessages();
  message(request.state==='succeeded'?'작업 사본을 열었습니다.':errors[request.result?.code]||'불러오기에 실패했습니다.');
 }catch(error){message(error.message);}finally{busy=false;$('import-model').disabled=false;$('model-file').value='';render();}
};

async function downloadReport(id){
 try{
  selectedResult=id;renderMessages();
  const response=await fetch(`/api/v1/projects/${project.id}/requests/${id}/report`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:viewport.capture()})});
  if(!response.ok){const failure=await response.json();throw Error(failure.code);}
  const url=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');anchor.href=url;anchor.download='VIDE-review.html';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(error){message(error.message);}
}

$('host-target').onchange=()=>{
 state.host=$('host-target').value;state.baseRequestId=undefined;state.selected=null;selectedResult=undefined;displayedResult=undefined;
 objects.splice(0,objects.length);viewport?.replace([]);renderMessages();render();
};

for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{
  if(tool==='sketch'){message('스케치를 마친 뒤 뷰를 바꿀 수 있습니다.');return;}
  $('projection').value=button.dataset.view;$('projection').onchange();
  document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
};
for(const button of document.querySelectorAll('[data-section]'))button.onclick=()=>{
  if($('left').hidden)$('toggle-left').click();
  mobileView('documents');
  const section=$(button.dataset.section);const details=section.closest('details');if(details)details.open=true;
  section.scrollIntoView({block:'nearest'});
  document.querySelectorAll('[data-section]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
};

$('fit-selection').onclick=()=>{if(state.selected)viewport?.fit(state.selected);else message('먼저 객체를 선택하세요.');};
for(const button of document.querySelectorAll('[data-projection]'))button.onclick=()=>{
 if(tool==='sketch'){message('스케치를 마친 뒤 투영을 바꿀 수 있습니다.');return;}
 viewport?.projection(button.dataset.projection);
};

$('add-request').onclick=()=>{
 if(!state.body.trim())return;
 state.instructions??=[];state.instructions.push(state.body);state.body='';$('body').value='';render();$('body').focus();
};

$('add-point').onclick=()=>{
 const point=[$('point-u').valueAsNumber,$('point-v').valueAsNumber];
 if(!point.every(validCoordinate)){message('U·V 좌표를 m 단위 숫자로 입력하세요.');return;}
 if(points.length>=1000){message('스케치 하나에 1,000점까지 입력할 수 있습니다.');return;}
 points.push(point);$('point-u').value='';$('point-v').value='';draw();$('point-u').focus();
};
for(const id of ['point-u','point-v'])$(id).onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('add-point').click();}};
