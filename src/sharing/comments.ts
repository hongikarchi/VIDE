import type {Env} from './auth';
import type {Actor} from './projects';
import {membership} from './projects';
import {accessiblePublication,type Manifest} from './publications';
import {HttpError,body,digest,json} from './http';
import {sharedCommentInputSchema} from '../contracts/shared-spatial';

interface CommentRow {id:string;publication_id:string;user_id:string;payload:string;received_at:number;input_hash:string}
const view=(row:CommentRow)=>({id:row.id,publicationId:row.publication_id,authorId:row.user_id,input:JSON.parse(row.payload),receivedAt:row.received_at});
export async function commentRoute(request:Request,env:Env,actor:Actor,projectId:string,publicationId:string):Promise<Response>{
  const publication=await accessiblePublication(env,actor,projectId,publicationId),db=env.DB;
  if(publication.state!=='published')throw new HttpError(409,'PUBLICATION_NOT_PUBLISHED');
  if(request.method==='GET'){
    const after=new URL(request.url).searchParams.get('after');let time=0,id='';
    if(after){const row=await db.prepare('SELECT received_at,id FROM comments WHERE publication_id=? AND id=?').bind(publicationId,after).first<{received_at:number;id:string}>();if(!row)throw new HttpError(400,'INVALID_CURSOR');time=row.received_at;id=row.id;}
    const rows=(await db.prepare(`SELECT * FROM comments WHERE publication_id=? AND (received_at>? OR (received_at=? AND id>?)) ORDER BY received_at,id LIMIT 201`).bind(publicationId,time,time,id).all<CommentRow>()).results;
    const page=rows.slice(0,200);return json({comments:page.map(view),nextCursor:rows.length>200?page.at(-1)?.id:null});
  }
  if(request.method!=='POST')throw new HttpError(405,'METHOD_NOT_ALLOWED');
  const role=await membership(db,projectId,actor.id);if(role==='viewer')throw new HttpError(403,'COMMENTER_REQUIRED');
  const parsed=sharedCommentInputSchema.safeParse(await body(request,256*1024));
  if(!parsed.success)throw new HttpError(400,'INVALID_COMMENT_INPUT');
  const input=parsed.data,submissionId=input.submissionId;
  const manifest=JSON.parse(publication.manifest) as Manifest;
  if(input.objectId!==null&&(typeof input.objectId!=='string'||!manifest.objectIds.includes(input.objectId)))throw new HttpError(400,'OBJECT_NOT_PUBLISHED');
  const payload=JSON.stringify({body:input.body,objectId:input.objectId,...(input.pin?{pin:input.pin}:{}),...(input.sketches?.length?{sketches:input.sketches}:{})}),hash=await digest(publicationId+'\n'+payload),id=crypto.randomUUID();
  // Recheck write permission at the insertion point, not just when the request started.
  await db.prepare(`INSERT INTO comments(id,project_id,publication_id,user_id,submission_id,input_hash,payload,received_at)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM project_members WHERE project_id=? AND user_id=? AND role IN ('owner','commenter'))
    AND EXISTS(SELECT 1 FROM publications p JOIN projects pr ON pr.id=p.project_id WHERE p.id=? AND p.state='published'
      AND (p.history_shared=1 OR pr.current_publication_id=p.id OR EXISTS(SELECT 1 FROM project_members WHERE project_id=pr.id AND user_id=? AND role='owner')))
    ON CONFLICT(project_id,user_id,submission_id) DO NOTHING`).bind(id,projectId,publicationId,actor.id,submissionId,hash,payload,Date.now(),projectId,actor.id,publicationId,actor.id).run();
  const row=await db.prepare('SELECT * FROM comments WHERE project_id=? AND user_id=? AND submission_id=?').bind(projectId,actor.id,submissionId).first<CommentRow>();
  if(!row)throw new HttpError(403,'COMMENT_NOT_ACCEPTED');
  if(row.input_hash!==hash)throw new HttpError(409,'SUBMISSION_CONFLICT');return json(view(row),201);
}
