import {api,errors} from './gateway.mjs';
const dialog=document.createElement('dialog');dialog.className='quantity-dialog ai-settings';dialog.setAttribute('aria-label','AI 연결 설정');document.body.append(dialog);
const element=(tag,text,parent)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;};
let generation=0;
export async function showAiSettings(onStatus){
 const current=++generation,config=await api('/settings/ai');if(current!==generation)return;
 dialog.replaceChildren();let saving=false;const head=element('div','',dialog);head.className='quantity-head';element('h2','AI 연결 설정',head);const close=element('button','닫기',head);close.onclick=()=>{generation++;dialog.close();};dialog.oncancel=event=>{if(saving)event.preventDefault();else generation++;};
 element('p','공식 CLI의 구독 로그인을 사용합니다. 경로를 비우면 자동 탐색합니다.',dialog);
 const paths={},states={};for(const [provider,label] of [['claude-cli','Claude Code'],['codex-cli','Codex · ChatGPT']]){
  const section=element('section','',dialog);element('h3',label,section);const input=element('input','',section);input.setAttribute('aria-label',label+' 실행 경로');input.value=config.paths[provider]||'';input.placeholder=config.resolved[provider]||'실행 파일 전체 경로';paths[provider]=input;
  states[provider]=element('p','연결 확인 전',section);states[provider].setAttribute('role','status');
 }
 const actions=element('div','',dialog);actions.className='table-controls';const save=element('button','설정 저장',actions),check=element('button','연결 확인',actions);const status=element('p','',dialog);status.setAttribute('role','status');
 element('small','로그인은 각 공식 CLI에서 진행합니다. 설정 변경은 다음 요청부터 적용되며 구독 잔여 사용량은 여기서 확인할 수 없습니다.',dialog);
 let checkGeneration=0;
 const verify=async()=>{const revision=++checkGeneration;check.disabled=true;try{const rows=await api('/providers');if(current!==generation||revision!==checkGeneration)return;for(const row of rows)states[row.id].textContent=row.available?'구독 로그인 확인됨':errors[row.reason]||'로그인 또는 실행 상태를 확인하세요.';onStatus?.(rows);}catch(error){if(current===generation)status.textContent=error.message;}finally{if(revision===checkGeneration)check.disabled=false;}};
 check.onclick=verify;
 save.onclick=async()=>{if(saving)return;saving=true;save.disabled=close.disabled=check.disabled=true;for(const path of Object.values(paths))path.disabled=true;
  try{const saved=await api('/settings/ai','PUT',{revision:config.revision,paths:Object.fromEntries(Object.entries(paths).map(([provider,input])=>[provider,input.value.trim()||null]))});config.revision=saved.revision;status.textContent='설정을 저장했습니다. 다음 요청부터 적용됩니다.';await verify();}
  catch(error){status.textContent=error.message;}
  finally{saving=false;save.disabled=close.disabled=check.disabled=false;for(const path of Object.values(paths))path.disabled=false;}
 };
 if(!dialog.open)dialog.showModal();void verify();
}
