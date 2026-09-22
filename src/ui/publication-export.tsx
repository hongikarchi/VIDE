import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api} from './gateway.ts';

interface ObjectChoice {id:string;name:string}
function Export({projectId,requestId,objects,close}:{projectId:string;requestId:string;objects:ObjectChoice[];close:()=>void}){
  const [selected,setSelected]=useState<string[]>([]),[title,setTitle]=useState(''),[names,setNames]=useState(false),[measurements,setMeasurements]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
  async function save(){if(busy)return;setBusy(true);try{
    const result=await api(`/projects/${projectId}/requests/${requestId}/publication-export`,'POST',{title,objectIds:selected,includeNames:names,includeMeasurements:measurements});
    const url=URL.createObjectURL(new Blob([JSON.stringify(result)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='VIDE-publication.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setStatus('선택한 자료를 저장했습니다. 공유 프로젝트의 게시에서 이 파일을 선택하세요.');
  }catch(error){setStatus(error instanceof Error?error.message:'자료를 만들지 못했습니다.');}finally{setBusy(false);}}
  return <><div className="quantity-head"><h2>공유할 자료</h2><button disabled={busy} onClick={close}>닫기</button></div><form onSubmit={event=>{event.preventDefault();void save();}}>
    <label>게시 제목 <input aria-label="게시 제목" required maxLength={200} value={title} disabled={busy} onChange={e=>setTitle(e.target.value)}/></label>
    <p>공개할 객체를 선택하세요. AI 입력·첨부·로컬 경로는 포함하지 않습니다.</p>
    <div className="publication-objects">{objects.map(object=><label key={object.id}><input type="checkbox" checked={selected.includes(object.id)} disabled={busy} onChange={e=>setSelected(e.target.checked?[...selected,object.id]:selected.filter(id=>id!==object.id))}/>{object.name}</label>)}</div>
    <p><label><input type="checkbox" checked={names} disabled={busy} onChange={e=>setNames(e.target.checked)}/>객체 이름 포함</label> <label><input type="checkbox" checked={measurements} disabled={busy} onChange={e=>setMeasurements(e.target.checked)}/>측정값 포함</label></p>
    <button disabled={busy||!selected.length||!title.trim()}>공유 자료 내려받기</button><p role="status">{status}</p>
  </form></>;
}
export function showPublicationExport(projectId:string,requestId:string,objects:ObjectChoice[]):void{
  const dialog=document.createElement('dialog');dialog.className='quantity-dialog';dialog.setAttribute('aria-label','공유할 자료');document.body.append(dialog);
  const root=createRoot(dialog);dialog.addEventListener('close',()=>{root.unmount();dialog.remove();},{once:true});
  root.render(<Export {...{projectId,requestId,objects}} close={()=>dialog.close()}/>);dialog.showModal();
}
