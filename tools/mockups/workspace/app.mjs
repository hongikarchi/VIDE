import {objects,models,initial,chooseModel,pinSelection,validate,packet,attachSketch,storageKey} from './model.mjs';
import {createViewport} from './viewport.mjs';
const $=id=>document.getElementById(id);
let state=initial(),tool='select',points=[],toastTimer;
const message=text=>{clearTimeout(toastTimer);$('message').textContent=text;$('message').hidden=false;toastTimer=setTimeout(()=>$('message').hidden=true,4500);};
function el(tag,text,parent,attrs={}){const node=document.createElement(tag);node.textContent=text;for(const [k,v] of Object.entries(attrs))node.setAttribute(k,v);parent.append(node);return node;}
let viewport;
try{viewport=createViewport($('canvas'),objects,(id,pin)=>{state.selected=id;if(pin)pinSelection(state);render();},point=>{points.push(point);draw();});}catch{message('3D 뷰포트를 열 수 없습니다. WebGL 지원을 확인하세요.');}
function draw(){viewport?.lines(state.sketches,points,$('plane').value);$('finish-sketch').disabled=points.length<2;$('undo-point').disabled=!points.length;}
function setTool(next){if(tool==='sketch'&&next!=='sketch'&&points.length){message('그린 선을 첨부하거나 취소하세요.');return;}tool=next;document.querySelectorAll('[data-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tool===tool)));$('sketch-tools').hidden=tool!=='sketch';viewport?.mode(tool,$('plane').value);$('tool-hint').textContent=tool==='sketch'?'평면에 점을 찍어 선을 그리세요. Esc 취소':tool==='pin'?'객체를 누르면 입력에 첨부됩니다.':'';draw();}
function chip(text,remove){const span=el('span',text,$('context'),{class:'chip'});const b=el('button','×',span,{'aria-label':`${text} 제외`});b.onclick=remove;}
function render(){
 $('objects').replaceChildren();for(const o of objects){const b=el('button',o.name,$('objects'),{class:'object','aria-pressed':String(state.selected===o.id)});b.onclick=()=>{state.selected=o.id;if(tool==='pin')pinSelection(state);render();};}
 viewport?.select(state.selected);$('selection').textContent=objects.find(o=>o.id===state.selected)?.name||'';
 $('context').replaceChildren();state.pins.forEach((p,i)=>chip('@ '+p.name,()=>{state.pins.splice(i,1);render();}));state.sketches.forEach((s,i)=>chip('⌁ '+s.name,()=>{state.sketches.splice(i,1);render();}));state.files.forEach((f,i)=>chip('▧ '+f.name,()=>{state.files.splice(i,1);render();}));
 const selected=models.find(m=>m.id===state.model);$('model').value=state.model;$('effort').replaceChildren();selected.efforts.forEach(e=>el('option',e,$('effort'),{value:e}));$('effort').value=state.effort;$('permission').value=state.permission;
 sidebar();$('request').disabled=!!validate(state);$('request').title=validate(state)||'보내기 · Ctrl+Enter';draw();
}
function sidebar(){
 $('task-list').replaceChildren();if(!state.messages.length)el('small','아직 요청이 없습니다.',$('task-list'));state.messages.forEach((m,i)=>{const b=el('button',m.body||`첨부 검토 ${i+1}`,$('task-list'));b.onclick=()=>{if($('right').hidden)$('toggle-right').click();mobileView('input');document.querySelectorAll('.chat-message')[i]?.scrollIntoView({block:'nearest'});};});
 $('reference-list').replaceChildren();const files=[...state.messages.flatMap(m=>m.files),...state.files];if(!files.length)el('small','첨부한 파일이 없습니다.',$('reference-list'));files.forEach(f=>el('small',f.name,$('reference-list')));
}
function renderMessages(){sidebar();const box=$('conversation');box.replaceChildren();if(!state.messages.length){el('div','V.',box,{class:'chat-empty'});return;}for(const m of state.messages){const card=el('article','',box,{class:'chat-message'});el('p',m.body||'첨부한 문맥 검토',card);const refs=[...m.pins.map(p=>p.name),...m.sketches.map(s=>s.name),...m.files.map(f=>f.name)];if(refs.length)el('small',refs.join(' · '),card);el('small',`${models.find(x=>x.id===m.model)?.name||m.model} · ${m.effort} · ${m.permission==='review'?'검토만':'후보 작업 허용'}`,card);const details=el('details','',card);el('summary','요청 문맥',details);el('pre',JSON.stringify(m,null,2),details);}el('p','로컬 요청 미리보기 · AI 미연결',box,{class:'receipt'});box.scrollTop=box.scrollHeight;}
for(const model of models)el('option',model.name,$('model'),{value:model.id});
$('model').onchange=()=>{chooseModel(state,$('model').value);render();};$('effort').onchange=()=>{state.effort=$('effort').value;};$('permission').onchange=()=>{state.permission=$('permission').value;};
$('body').oninput=()=>{state.body=$('body').value;$('saved').textContent='미저장';render();if(state.body.endsWith('@'))$('attach-menu').open=true;};
$('request').onclick=()=>{if(validate(state))return;state.messages.push(packet(state));state.body='';state.pins=[];state.sketches=[];state.files=[];$('body').value='';render();renderMessages();$('body').focus();};
$('body').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!e.isComposing){e.preventDefault();$('request').click();}};
$('pin').onclick=()=>{pinSelection(state);$('attach-menu').open=false;render();$('body').focus();};
$('draw').onclick=()=>{$('attach-menu').open=false;mobileView('model');setTool('sketch');};
$('attach-file').onclick=()=>{$('files').click();$('attach-menu').open=false;};
$('files').onchange=()=>{for(const f of $('files').files)state.files.push({name:f.name,size:f.size,type:f.type,contentStatus:'metadata-only'});$('files').value='';render();message('검수용 파일 이름만 첨부했습니다. 내용은 전송하지 않습니다.');};
for(const button of document.querySelectorAll('[data-tool]'))button.onclick=()=>setTool(button.dataset.tool);
$('plane').onchange=()=>{if(points.length){$('plane').value=state.drawingPlane||'XY';message('작성 중인 선을 첨부하거나 취소한 뒤 평면을 바꾸세요.');return;}state.drawingPlane=$('plane').value;viewport?.plane($('plane').value);};
$('finish-sketch').onclick=()=>{try{attachSketch(state,points,$('plane').value,$('line-role').value);points=[];setTool('select');render();mobileView('input');$('body').focus();}catch(e){message(e.message);}};
$('cancel-sketch').onclick=()=>{points=[];setTool('select');};$('undo-point').onclick=()=>{points.pop();draw();};
$('fit-view').onclick=()=>viewport?.fit();
$('projection').onchange=()=>{if(tool==='sketch'){message('스케치를 마친 뒤 뷰를 바꿀 수 있습니다.');return;}if($('projection').value==='axon')viewport?.home();else viewport?.plane({plan:'XY',front:'XZ',side:'YZ'}[$('projection').value]);};
$('save').onclick=()=>{try{localStorage.setItem(storageKey,JSON.stringify({version:3,state}));$('saved').textContent='저장됨';$('draft-menu').open=false;message('초안을 이 브라우저에 저장했습니다.');}catch{message('저장 실패. 초안은 유지됩니다.');}};
$('load').onclick=()=>{try{const saved=JSON.parse(localStorage.getItem(storageKey));if(saved?.version!==3||typeof saved.state?.body!=='string'||!['pins','sketches','files','messages'].every(k=>Array.isArray(saved.state[k])))throw Error();chooseModel(saved.state,saved.state.model);state=saved.state;points=[];$('body').value=state.body;$('draft-menu').open=false;render();renderMessages();message('초안을 불러왔습니다.');}catch{message('읽을 수 있는 저장본이 없습니다.');}};
function mobileView(view){document.body.dataset.mobile=view;document.querySelectorAll('button[data-mobile]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mobile===view)));}
for(const b of document.querySelectorAll('button[data-mobile]'))b.onclick=()=>mobileView(b.dataset.mobile);
for(const side of ['left','right'])$(`toggle-${side}`).onclick=()=>{if(matchMedia('(max-width:850px)').matches){$(side).hidden=false;mobileView(side==='left'?'documents':'input');return;}$(side).hidden=!$(side).hidden;document.body.classList.toggle(`${side}-hidden`,$(side).hidden);$(`toggle-${side}`).setAttribute('aria-expanded',String(!$(side).hidden));$(`toggle-${side}`).textContent=side==='left'?($(side).hidden?'›':'‹'):($(side).hidden?'‹':'›');$(`toggle-${side}`).focus();};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(tool==='sketch'){points=[];setTool('select');}$('attach-menu').open=false;$('draft-menu').open=false;}if(e.altKey&&e.shiftKey&&['KeyL','KeyR'].includes(e.code)){e.preventDefault();$(`toggle-${e.code==='KeyL'?'left':'right'}`).click();}});
window.addEventListener('beforeunload',e=>{if(state.body||state.pins.length||state.sketches.length){e.preventDefault();e.returnValue='';}});
window.addEventListener('pagehide',()=>viewport?.dispose(),{once:true});
mobileView('model');render();
