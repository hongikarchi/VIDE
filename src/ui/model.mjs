export const objects = [];
export const models = [
  {id:'claude-cli',name:'Claude · 계정 기본 모델',provider:'claude-cli',efforts:['default']},
  {id:'codex-cli',name:'ChatGPT · 계정 기본 모델',provider:'codex-cli',efforts:['default']},
];
export const initial = () => ({selected:null,host:'rhino',body:'',instructions:[],pins:[],sketches:[],files:[],model:models[0].id,effort:'default',permission:'review',messages:[]});
export const storageKey='vide:review:composer:v3';
export function chooseModel(s,id){const model=models.find(m=>m.id===id);if(!model)throw Error('모델을 선택하세요.');s.model=id;if(!model.efforts.includes(s.effort))s.effort=model.efforts.includes('medium')?'medium':model.efforts[0];}
export function pinSelection(s){const o=objects.find(o=>o.id===s.selected);if(o&&!s.pins.some(p=>p.id===o.id))s.pins.push({id:o.id,name:o.name,role:'target',basis:o.revision});}
export function validate(s){if(s.instructions!==undefined&&(!Array.isArray(s.instructions)||s.instructions.some(t=>typeof t!=='string')))return '요청 목록을 확인하세요.';if(requestBody(s).length>20000)return '요청 묶음은 20,000자까지 입력할 수 있습니다.';if(!requestBody(s).trim()&&!s.pins.length&&!s.sketches.length&&!s.files.length)return '메시지나 참조를 추가하세요.';const m=models.find(m=>m.id===s.model);if(!m||!m.efforts.includes(s.effort))return '모델과 effort를 확인하세요.';if(!['review','candidate'].includes(s.permission))return '권한을 확인하세요.';return '';}
export function packet(s){const error=validate(s);if(error)throw Error(error);return structuredClone({host:s.host||'rhino',baseRequestId:s.baseRequestId,body:requestBody(s),pins:s.pins,sketches:s.sketches,files:s.files,provider:models.find(m=>m.id===s.model).provider,model:s.model,effort:s.effort,permission:s.permission});}
export function attachSketch(s,points,plane,role){if(points.length<2)throw Error('두 점 이상 그리세요.');if(!['XY','XZ','YZ'].includes(plane)||!['reference','boundary','path','direction'].includes(role))throw Error('평면과 역할을 확인하세요.');if(role==='direction'&&points.length!==2)throw Error('방향은 두 점으로 지정하세요.');if(points.some(p=>p.length!==2||p.some(n=>!Number.isFinite(n))))throw Error('좌표를 확인하세요.');s.sketches.push({id:crypto.randomUUID(),name:`스케치 ${s.sketches.length+1}`,plane,origin:[0,0,0],axisU:plane==='YZ'?[0,1,0]:[1,0,0],axisV:plane==='XY'?[0,1,0]:[0,0,1],unit:'m',role,points:structuredClone(points)});}

export function requestBody(s){
 const instructions=[...(s.instructions||[]),s.body].filter(text=>text.trim());
 return instructions.length>1?instructions.map((text,i)=>`${i+1}. ${text}`).join('\n\n'):instructions[0]||'';
}

export function attachHostSelection(state,request,selection){
 const source=request?.result?.sourceDocument;
 if(!source||source.instance!==selection.instance||source.documentId!==selection.documentId)throw Error('선택한 Rhino 문서의 작업 사본을 먼저 가져오세요.');
 if(source.documentHash!==selection.documentHash)throw Error('원본이 취득 후 변경됐습니다. 작업 사본을 다시 가져온 뒤 선택을 첨부하세요.');
 const selected=selection.selectedIds.map(id=>request.result.objects.find(object=>object.id===id));
 if(selected.some(object=>!object))throw Error('현재 후보에 없는 선택 객체가 있습니다. 원본 작업 사본에서 선택을 다시 확인하세요.');
 const additions=selected.filter(object=>!state.pins.some(pin=>pin.id===object.id&&pin.basis===request.id));
 if(state.pins.length+additions.length>100)throw Error('요청에 첨부할 수 있는 객체는 100개까지입니다.');
 state.pins.push(...additions.map(object=>({id:object.id,name:object.name,role:'target',basis:request.id})));
 if(selected.length)state.selected=selected[0].id;
 return additions.length;
}
