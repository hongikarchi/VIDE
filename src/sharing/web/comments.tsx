import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {api,message,type Project,type Session} from './api';

const draftSchema=z.object({submissionId:z.string(),body:z.string(),objectId:z.string().nullable(),pending:z.boolean().default(false)});
type Draft=z.infer<typeof draftSchema>;
const notesSchema=z.object({comments:z.array(z.object({id:z.string(),publicationId:z.string(),authorId:z.string(),input:z.object({body:z.string(),objectId:z.string().nullable()}),receivedAt:z.number()})),nextCursor:z.string().nullable()});
export function Comments({project,publicationId,session,selected}:{project:Project;publicationId:string;session:Session;selected:string|null}){
  const storageKey=`vide-review:${session.user.id}:${project.id}:${publicationId}`;
  const [draft,setDraft]=useState<Draft>(()=>{try{const saved=draftSchema.safeParse(JSON.parse(localStorage.getItem(storageKey)||'null'));if(saved.success)return saved.data;}catch{}return {submissionId:crypto.randomUUID(),body:'',objectId:null,pending:false};});
  const [notes,setNotes]=useState<z.infer<typeof notesSchema>['comments']>([]),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[storageError,setStorageError]=useState('');
  const uncertain=draft.pending;
  const [previousBasis,setPreviousBasis]=useState(false);
  const locked=useRef(false),base=`/projects/${project.id}/publications/${publicationId}/comments`;
  async function refresh(after?:string){const value=notesSchema.parse(await api(base+(after?'?after='+encodeURIComponent(after):'')));setNotes(previous=>after?[...previous,...value.comments.filter(note=>!previous.some(old=>old.id===note.id))]:value.comments);setCursor(value.nextCursor);}
  useEffect(()=>{let active=true;void api(base).then(raw=>{if(!active)return;const data=notesSchema.parse(raw);setNotes(data.comments);setCursor(data.nextCursor);}).catch(error=>{if(active)setStatus(message(error));});return()=>{active=false;};},[base]);
  useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(draft));setStorageError('');}catch{setStorageError('이 브라우저에 초안을 저장하지 못했습니다. 창을 닫기 전에 내용을 복사해 주세요.');}},[storageKey,draft]);
  async function submit(){if(locked.current)return;locked.current=true;setBusy(true);setStatus('');
    if(!draft.pending&&!previousBasis){
      try{const current=z.object({id:z.string()}).parse(await api(`/projects/${project.id}/publications/current`));if(current.id!==publicationId){setPreviousBasis(true);setStatus('새 게시본이 있습니다. 이 의견은 현재 화면의 이전 게시본을 기준으로 남깁니다.');locked.current=false;setBusy(false);return;}}
      catch(error){setStatus(message(error));locked.current=false;setBusy(false);return;}
    }
    const pending={...draft,pending:true};setDraft(pending);try{localStorage.setItem(storageKey,JSON.stringify(pending));}catch{setStorageError('접수 확인 상태를 이 브라우저에 저장하지 못했습니다.');}
    try{await api(base,'POST',{submissionId:draft.submissionId,body:draft.body,objectId:draft.objectId});setDraft({submissionId:crypto.randomUUID(),body:'',objectId:null,pending:false});setStatus('서버에 의견이 접수되었습니다.');await refresh().catch(()=>setStatus('의견은 접수됐지만 목록을 갱신하지 못했습니다.'));}
    catch(error){setStatus(message(error)+' · 같은 내용으로 접수 확인을 다시 할 수 있습니다.');}
    finally{locked.current=false;setBusy(false);}
  }
  return <><h2>의견</h2>{notes.map(note=><article key={note.id} className="comment"><small>{note.authorId===session.user.id?'나':'참여자'} · {new Date(note.receivedAt).toLocaleString('ko-KR')}</small>{note.input.objectId?<p className="muted">{note.input.objectId}</p>:null}<p>{note.input.body}</p></article>)}
    {cursor?<button onClick={()=>{void refresh(cursor).catch(error=>setStatus(message(error)));}}>이전 의견 더 보기</button>:null}
    {project.role==='viewer'?<p className="muted">열람 권한으로 보고 있습니다.</p>:<form onSubmit={event=>{event.preventDefault();void submit();}}>
      <div className="muted">{draft.objectId?'대상: '+draft.objectId:'게시본 전체에 대한 의견'}</div>
      <div><button type="button" disabled={busy||uncertain||!selected} onClick={()=>setDraft({...draft,objectId:selected})}>선택 객체 첨부</button>{draft.objectId?<button type="button" disabled={busy||uncertain} onClick={()=>setDraft({...draft,objectId:null})}>대상 제외</button>:null}</div>
      <textarea aria-label="검토 의견" placeholder="이 설계에서 바꾸고 싶은 점…" maxLength={4000} required disabled={busy||uncertain} value={draft.body} onChange={event=>setDraft({...draft,body:event.target.value})}/>
      <button className="primary" disabled={busy||!draft.body.trim()}>{busy?'접수 확인 중…':uncertain?'같은 의견 접수 확인':previousBasis?'이전 게시본에 의견 보내기':'의견 보내기'}</button>
      {uncertain?<button type="button" disabled={busy} onClick={()=>{setDraft({...draft,submissionId:crypto.randomUUID(),pending:false});setStatus('이전 의견이 접수되었을 수 있습니다. 목록을 확인한 뒤 새 의견을 작성해 주세요.');void refresh().catch(()=>{});}}>새 의견으로 편집</button>:null}
    </form>}<p role="status" className="status">{status}</p>{storageError?<p role="alert" className="status">{storageError}</p>:null}</>;
}
