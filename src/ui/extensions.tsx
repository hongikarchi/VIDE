import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { api } from './gateway.mjs';

const registrationSchema=z.object({enabled:z.boolean(),revision:z.number().int().nonnegative()});
const extensionSchema=registrationSchema.extend({id:z.string().min(1),name:z.string(),version:z.string()});
type Extension=z.infer<typeof extensionSchema>;
interface Context {projectId:string;requestId?:string|null;selected?:string|null;objects:{id:string}[]}
interface Submission {id:string;requestId:string;objectIds:string[]}
interface Props {context:Context;catalog:Extension[];onResult:(request:{id:string;[key:string]:unknown})=>void}
const dialog=document.createElement('dialog');dialog.className='quantity-dialog';dialog.setAttribute('aria-label','확장');document.body.append(dialog);
const root=createRoot(dialog);let opening=0,busy=false;
function Extensions({context,catalog,onResult}:Props){
 const [extensions,setExtensions]=useState(catalog),[status,setStatus]=useState(''),[pending,setPending]=useState(false);
 const [scopes,setScopes]=useState<Record<string,string>>({}),[attempts,setAttempts]=useState<Record<string,Submission>>({});
 const locked=useRef(false),submissions=useRef<Record<string,Submission>>({});
 async function perform(action:()=>Promise<void>){
  if(locked.current)return;locked.current=true;busy=true;setPending(true);
  try{await action();}catch(error){setStatus(error instanceof Error?error.message:'요청을 처리하지 못했습니다.');}
  finally{locked.current=false;busy=false;setPending(false);}
 }
 return <>
  <div className="quantity-head"><h2>확장</h2><button disabled={pending} onClick={()=>{if(!locked.current)dialog.close();}}>닫기</button></div>
  <p role="status">{status}</p>
  {extensions.map(extension=>{
   const scope=scopes[extension.id]??(context.selected?'selected':'all');
   const ids=scope==='selected'&&context.selected?[context.selected]:context.objects.map(object=>object.id);
   const attempt=attempts[extension.id],available=!!attempt||(extension.enabled&&!!context.requestId&&ids.length>0&&ids.length<=100);
   return <section key={extension.id}>
    <h3>{extension.name}</h3><p>v{extension.version} · 저장된 모델 읽기</p>
    <select aria-label="확장 대상" value={scope} disabled={pending||!!attempt} onChange={event=>setScopes(current=>({...current,[extension.id]:event.target.value}))}>
     {context.selected?<option value="selected">선택 객체</option>:null}<option value="all">현재 후보 전체 ({context.objects.length}개)</option>
    </select>
    <button disabled={pending} onClick={()=>perform(async()=>{
     const next=registrationSchema.parse(await api(`/extensions/${extension.id}`,'PUT',{revision:extension.revision,enabled:!extension.enabled}));
     setExtensions(current=>current.map(item=>item.id===extension.id?{...item,...next}:item));
     setStatus(next.enabled?'확장을 활성화했습니다.':'새 실행을 비활성화했습니다.');
    })}>{extension.enabled?'비활성화':extension.revision?'활성화':'등록'}</button>
    <button disabled={pending||!available} onClick={()=>perform(async()=>{
     const submission=submissions.current[extension.id]??={id:crypto.randomUUID(),requestId:context.requestId!,objectIds:[...ids]};
     setAttempts(current=>({...current,[extension.id]:submission}));
     const request=await api(`/projects/${context.projectId}/extensions/${extension.id}/run`,'POST',submission);
     if(request?.id!==submission.id)throw new Error('실행 결과의 요청이 일치하지 않습니다.');
     onResult(request);dialog.close();
    })}>{attempt?'같은 실행 다시 확인':'실행'}</button>
    {ids.length>100&&!attempt?<p>한 번에 최대 100개 객체를 요약합니다. 객체를 선택해 범위를 줄이세요.</p>:null}
   </section>;
  })}
  {!context.objects.length?<p>작업 후보를 먼저 열어 주세요.</p>:null}
 </>;
}
dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
dialog.addEventListener('close',()=>{opening++;root.render(null);});
export async function showExtensions(context:Context,onResult:Props['onResult']):Promise<void>{
 if(busy)return;const generation=++opening;
 const catalog=z.array(extensionSchema).parse(await api('/extensions'));
 if(generation!==opening||busy)return;
 root.render(<Extensions key={generation} context={{...context,objects:context.objects.map(object=>({...object}))}} {...{catalog,onResult}}/>);
 if(!dialog.open)dialog.showModal();
}
