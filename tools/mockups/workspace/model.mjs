export const objects = [
  { id: 'mass-a', name: '주동 A', height: 6, width: 12, depth: 8, x: 100, y: 170 },
  { id: 'mass-b', name: '주동 B', height: 9, width: 8, depth: 6, x: 320, y: 270 },
];
// Illustrative catalog, following the local Vino mock; not a live account capability claim.
export const models = [
  {id:'gpt-5.6-sol',name:'GPT-5.6 Sol',provider:'Codex',efforts:['low','medium','high','xhigh']},
  {id:'gpt-5.6-terra',name:'GPT-5.6 Terra',provider:'Codex',efforts:['low','medium','high']},
  {id:'claude-fable-5',name:'Claude Fable 5',provider:'Claude Code',efforts:['low','medium','high','xhigh','max']},
];
export const initial = () => ({selected:'mass-a',body:'',pins:[],sketches:[],files:[],model:models[0].id,effort:'medium',permission:'review',messages:[]});
export const storageKey='vide:review:composer:v3';
export function chooseModel(s,id){const model=models.find(m=>m.id===id);if(!model)throw Error('모델을 선택하세요.');s.model=id;if(!model.efforts.includes(s.effort))s.effort=model.efforts.includes('medium')?'medium':model.efforts[0];}
export function pinSelection(s){const o=objects.find(o=>o.id===s.selected);if(o&&!s.pins.some(p=>p.id===o.id))s.pins.push({id:o.id,name:o.name,role:'target',basis:'fixture-01'});}
export function validate(s){if(!s.body.trim()&&!s.pins.length&&!s.sketches.length&&!s.files.length)return '메시지나 참조를 추가하세요.';const m=models.find(m=>m.id===s.model);if(!m||!m.efforts.includes(s.effort))return '모델과 effort를 확인하세요.';if(!['review','candidate'].includes(s.permission))return '권한을 확인하세요.';return '';}
export function packet(s){const error=validate(s);if(error)throw Error(error);return structuredClone({body:s.body,pins:s.pins,sketches:s.sketches,files:s.files,model:s.model,effort:s.effort,permission:s.permission});}
export function attachSketch(s,points,plane,role){if(points.length<2)throw Error('두 점 이상 그리세요.');if(!['XY','XZ','YZ'].includes(plane)||!['reference','boundary','path','direction'].includes(role))throw Error('평면과 역할을 확인하세요.');if(role==='direction'&&points.length!==2)throw Error('방향은 두 점으로 지정하세요.');if(points.some(p=>p.length!==2||p.some(n=>!Number.isFinite(n))))throw Error('좌표를 확인하세요.');s.sketches.push({id:crypto.randomUUID(),name:`스케치 ${s.sketches.length+1}`,plane,origin:[0,0,0],axisU:plane==='YZ'?[0,1,0]:[1,0,0],axisV:plane==='XY'?[0,1,0]:[0,0,1],unit:'m',role,points:structuredClone(points)});}
