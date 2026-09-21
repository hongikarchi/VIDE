import {sceneRepresentation} from '../core/scene-representation.mjs';
import {api,labels,errors} from './gateway.mjs';
import {showApplication} from './application.mjs';
import {showQuantities} from './quantities.mjs';
function element(tag,text,parent,attributes={}){
 const node=document.createElement(tag);node.textContent=text;
 for(const [key,value] of Object.entries(attributes))node.setAttribute(key,value);
 parent.append(node);return node;
}
export function renderHistory(root,messages,models,projectId,actions){
 const follow=root.scrollHeight-root.scrollTop-root.clientHeight<60;
 const previousScroll=root.scrollTop;root.replaceChildren();
 if(!messages.length){element('div','V.',root,{class:'chat-empty'});return;}
 for(const message of messages){
  const card=element('article','',root,{class:'chat-message'});
  element('p',message.body||'첨부한 문맥 검토',card);
  const references=[...message.pins.map(p=>p.name),...message.sketches.map(s=>s.name),...message.files.map(f=>f.name)];
  if(references.length)element('small',references.join(' · '),card);
  element('small',message.provider==='extension'?'확장 · '+message.extensionVersion:['file','document'].includes(message.source)?(message.host==='zwcad'?(message.request?.result?.dwgEditMode==='polyline-vertices-v1'?'ZWCAD 작업 사본':'ZWCAD 참고 도면'):'Rhino 작업 사본'):`${models.find(model=>model.id===message.model)?.name||message.model} · ${message.effort} · ${message.permission==='review'?'검토만':'후보 작업 허용'}`,card);
  const context=element('details','',card);element('summary','요청 문맥',context);element('pre',JSON.stringify(message.request?.input||message,null,2),context);
  const request=message.request;if(!request)continue;
  element('small',message.provider==='extension'&&request.state==='succeeded'?'확장 완료':request.state==='running'&&request.result?.phase==='host'?'호스트 생성·저장 검증 중':request.result?.phase==='stopping'?'중단 확인 중':labels[request.state]||request.state,card);
  if(request.result?.text)element('p',request.result.text,card);
  if(request.result?.extensionResult){
    for(const row of request.result.extensionResult.rows){const group=element('details','',card);element('summary',row.type+' · '+(row.layer||'레이어 미상')+' · '+row.count+'개',group);for(const id of row.objectIds){const target=element('button',message.pins.find(pin=>pin.id===id)?.name||id,group);target.onclick=()=>actions.selection(message.baseRequestId,id);}}
   }
  if(request.result?.hostExecuted)renderCandidate(card,message,projectId,actions);
  if(request.result?.code)element('p',errors[request.result.code]||request.result.code,card);
  if(request.state==='unknown'&&message.source==='file'&&message.host==='zwcad'&&request.result?.sourceHash){
   const recover=element('button','불러오기 결과 확인',card);recover.onclick=async()=>{recover.disabled=true;try{message.request=await api(`/projects/${projectId}/imports/${message.id}/reconcile`,'POST',{});actions.changed();}catch(error){actions.error(error.message);recover.disabled=false;}};
  }
  if(['failed','cancelled','interrupted'].includes(request.state)&&message.provider!=='extension'&&!['file','document'].includes(message.source)){
   const restore=element('button','입력을 초안으로 복원',card);restore.onclick=()=>{try{actions.restore(request);}catch(error){actions.error(error.message);}};
  }
  if(message.provider!=='extension'&&['queued','running'].includes(request.state)&&!['file','document'].includes(message.source)&&request.result?.phase!=='host'){
   const stop=element('button','중단',card);
   stop.onclick=async()=>{stop.disabled=true;try{await api(`/projects/${projectId}/requests/${message.id}/cancel`,'POST',{});}catch(error){actions.error(error.message);stop.disabled=false;}};
  }
 }
 root.scrollTop=follow?root.scrollHeight:previousScroll;
}
function renderCandidate(card,message,projectId,actions){
 const {request}=message,result=request.result,host=result.host==='zwcad'?'ZWCAD':'Rhino',extension=result.host==='zwcad'?'dwg':'3dm';
 const view=element('button','이 후보 보기',card);view.onclick=()=>actions.candidate(message.id);
 element('small',`${host} ${['file','document'].includes(message.source)?'작업 사본':'후보'} · 저장·재열기 검증됨`,card);
 if(result.sourceDocument){const source=result.sourceDocument;element('small',`${source.name} · ${new Date(source.capturedAt).toLocaleString()} 취득 · 현재 상태 미확인`,card);}
 const missing=(result.scene||[]).filter(object=>!sceneRepresentation(object));
 if(missing.length)element('small',`3D 표시 미지원 ${missing.length}개 (${[...new Set(missing.map(object=>object.nativeType))].join(', ')}) · 파일과 객체 목록에는 보존됨`,card);
 element('a',extension==='dwg'?'DWG 내려받기':'3dm 내려받기',card,{href:`/api/v1/projects/${projectId}/requests/${message.id}/model`,download:`VIDE-candidate.${extension}`});
 const open=element('button',`${host}에서 열기`,card);
 open.onclick=async()=>{open.disabled=true;try{await api(`/projects/${projectId}/requests/${message.id}/open`,'POST',{});}catch(error){actions.error(error.message);}finally{open.disabled=false;}};
 const saveReview=element('button','검토본 저장',card);saveReview.onclick=async()=>{try{await actions.saveReview(message.id);}catch(error){actions.error(error.message);}};
 const report=element('button','검토본 내려받기',card);report.onclick=()=>actions.report(message.id);
 if(host==='Rhino'&&((!result.sourceDocument&&result.objects.every(object=>['box','polyline','extrude'].includes(object.kind)))||(result.sourceDocument&&result.objects.every(object=>object.kind==='native')&&message.source!=='document'))){
  const apply=element('button','문서에 적용',card);
  apply.onclick=async()=>{try{await showApplication(projectId,message.id,application=>{request.applications=[...(request.applications||[]),application];actions.changed();},result.sourceDocument);}catch(error){actions.error(error.message);}};
 }
 for(const application of request.applications||[]){
  element('small',application.state==='succeeded'?'원본 반영됨 · 파일 저장 별도':application.state==='unknown'?'원본 적용 결과 미확인':application.state==='failed'?'원본 적용 실패':'원본 적용 중',card);
  if(application.result?.code)element('small',errors[application.result.code]||application.result.code,card);
  if(application.state==='unknown'){
   const recover=element('button','결과 다시 확인',card);recover.onclick=async()=>{recover.disabled=true;try{
    const result=await api(`/projects/${projectId}/applications/${application.id}/reconcile`,'POST',{});
    Object.assign(application,result);actions.changed();
   }catch(error){actions.error(error.message);recover.disabled=false;}};
  }
 }
 const table=element('button','수량표',card);table.onclick=async()=>{try{await showQuantities(projectId,message.id,id=>actions.selection(message.id,id));}catch(error){actions.error(error.message);}};
 const measurements=element('details','',card);element('summary','측정값',measurements);
 for(const object of result.scene||[])element('p',`${result.objects.find(o=>o.id===object.id)?.name||object.id} · 기하 면적 ${object.area?.toFixed(2)??'—'} m² · 체적 ${object.volume?.toFixed(2)??'—'} m³`,measurements);
}
