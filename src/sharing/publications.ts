import type {Env} from './auth';
import {HttpError,body,digest,json,text} from './http';
import {membership,type Actor} from './projects';

interface Part {sha256:string;size:number}
interface Asset {id:string;parts:Part[]}
export interface Manifest {title:string;objectIds:string[];assets:Asset[]}
export interface Publication {id:string;project_id:string;request_hash:string;base_id:string|null;manifest:string;state:string;history_shared:number;created_at:number;published_at:number|null}
const identifier=(value:unknown)=>{const result=text(value,100);if(!/^[A-Za-z0-9_-]+$/.test(result))throw new HttpError(400,'INVALID_ID');return result;};
const record=(value:unknown,keys:string[])=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new HttpError(400,'INVALID_MANIFEST');
  return value as Record<string,unknown>;
};
function manifest(raw:unknown):Manifest{
  const input=record(raw,['title','objectIds','assets']);
  if(!Array.isArray(input.objectIds)||input.objectIds.length>5000||!Array.isArray(input.assets)||!input.assets.length||input.assets.length>16)throw new HttpError(400,'INVALID_MANIFEST');
  const objectIds=input.objectIds.map(identifier);if(new Set(objectIds).size!==objectIds.length)throw new HttpError(400,'DUPLICATE_OBJECT');
  let size=0,count=0;
  const assets=input.assets.map(raw=>{
    const asset=record(raw,['id','parts']);if(!Array.isArray(asset.parts)||!asset.parts.length)throw new HttpError(400,'INVALID_MANIFEST');
    const parts=asset.parts.map(raw=>{
      const part=record(raw,['sha256','size']),hash=text(part.sha256,64),bytes=part.size;
      if(!/^[0-9a-f]{64}$/.test(hash)||typeof bytes!=='number'||!Number.isSafeInteger(bytes)||bytes<1||bytes>8*1024*1024)throw new HttpError(400,'INVALID_PART');
      size+=bytes;count++;return {sha256:hash,size:bytes};
    });return {id:identifier(asset.id),parts};
  });
  if(new Set(assets.map(a=>a.id)).size!==assets.length||size>512*1024*1024||count>128)throw new HttpError(413,'PUBLICATION_LIMIT');
  return {title:text(input.title),objectIds,assets};
}
export const assetKey=(p:Publication,assetId:string,index:number)=>`publications/${p.project_id}/${p.id}/${assetId}/${index}`;
const checksum=(object:R2Object)=>object.checksums.sha256?Array.from(new Uint8Array(object.checksums.sha256),n=>n.toString(16).padStart(2,'0')).join(''):null;
export async function accessiblePublication(env:Env,actor:Actor,projectId:string,id:string):Promise<Publication>{
  const role=await membership(env.DB,projectId,actor.id);
  const p=await env.DB.prepare('SELECT * FROM publications WHERE project_id=? AND id=?').bind(projectId,id).first<Publication>();
  if(!p)throw new HttpError(404,'PUBLICATION_NOT_FOUND');
  if(role!=='owner'){
    const project=await env.DB.prepare('SELECT current_publication_id FROM projects WHERE id=?').bind(projectId).first<{current_publication_id:string|null}>();
    if(p.state!=='published'||(!p.history_shared&&project?.current_publication_id!==id))throw new HttpError(404,'PUBLICATION_NOT_FOUND');
  }return p;
}

export async function publicationRoute(request:Request,env:Env,actor:Actor,projectId:string,path:string[]):Promise<Response>{
  const db=env.DB,role=await membership(db,projectId,actor.id);
  if(!path.length&&request.method==='GET'){
    const rows=await db.prepare(`SELECT id,state,created_at,published_at FROM publications WHERE project_id=?
      AND (?='owner' OR (state='published' AND (history_shared=1 OR id=(SELECT current_publication_id FROM projects WHERE id=?))))
      ORDER BY created_at DESC,id LIMIT 200`).bind(projectId,role,projectId).all();return json({publications:rows.results});
  }
  if(!path.length&&request.method==='POST'){
    if(role!=='owner')throw new HttpError(403,'OWNER_REQUIRED');
    const input=await body(request,256*1024),requestId=identifier(input.requestId),value=manifest(input.manifest),encoded=JSON.stringify(value),hash=await digest(encoded);
    const id=crypto.randomUUID();
    await db.prepare(`INSERT INTO publications(id,project_id,request_id,request_hash,base_id,manifest,state,created_at)
      SELECT ?,id,?,?,current_publication_id,?,'uploading',? FROM projects WHERE id=?
      ON CONFLICT(project_id,request_id) DO NOTHING`).bind(id,requestId,hash,encoded,Date.now(),projectId).run();
    const p=await db.prepare('SELECT * FROM publications WHERE project_id=? AND request_id=?').bind(projectId,requestId).first<Publication>();
    if(!p||p.request_hash!==hash)throw new HttpError(409,'REQUEST_CONFLICT');return json({id:p.id,state:p.state,manifest:value},201);
  }
  let id=path[0];if(!id)throw new HttpError(405,'METHOD_NOT_ALLOWED');
  if(id==='current'){
    const project=await db.prepare('SELECT current_publication_id FROM projects WHERE id=?').bind(projectId).first<{current_publication_id:string|null}>();
    if(!project?.current_publication_id)throw new HttpError(404,'PUBLICATION_NOT_FOUND');id=project.current_publication_id;
  }
  const p=await accessiblePublication(env,actor,projectId,id),value=JSON.parse(p.manifest) as Manifest;
  if(path.length===1&&request.method==='GET')return json({id:p.id,state:p.state,manifest:value,publishedAt:p.published_at});
  if(path[1]==='assets'&&path.length===4){
    const asset=value.assets.find(asset=>asset.id===path[2]),index=Number(path[3]);
    if(!asset||!/^\d+$/.test(path[3])||!Number.isSafeInteger(index)||!asset.parts[index])throw new HttpError(404,'ASSET_NOT_FOUND');
    const part=asset.parts[index],key=assetKey(p,asset.id,index);
    if(request.method==='PUT'){
      if(role!=='owner')throw new HttpError(403,'OWNER_REQUIRED');
      if(p.state!=='uploading')throw new HttpError(409,'PUBLICATION_IMMUTABLE');
      if(Number(request.headers.get('Content-Length'))!==part.size||!request.body)throw new HttpError(400,'PART_SIZE_MISMATCH');
      // Hash is part of the frozen manifest; even concurrent retries cannot substitute bytes.
      let result:R2Object|null;
      try{result=await env.ASSETS.put(key,request.body,{sha256:part.sha256,onlyIf:{etagDoesNotMatch:'*'}});}
      catch{throw new HttpError(422,'PART_UPLOAD_FAILED');}
      const stored=result??await env.ASSETS.head(key);
      if(!stored||stored.size!==part.size||checksum(stored)!==part.sha256)throw new HttpError(409,'PART_MISMATCH');
      return json({uploaded:true});
    }
    if(request.method==='GET'){
      const stored=await env.ASSETS.get(key);if(!stored)throw new HttpError(404,'ASSET_NOT_FOUND');
      return new Response(stored.body,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(stored.size),'Content-Disposition':'attachment','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','ETag':stored.httpEtag}});
    }
  }
  if(role!=='owner')throw new HttpError(403,'OWNER_REQUIRED');
  if(path.length===2&&path[1]==='history-access'&&request.method==='PATCH'){
    const input=await body(request);if(typeof input.shared!=='boolean'||p.state!=='published')throw new HttpError(400,'INVALID_INPUT');
    await db.prepare('UPDATE publications SET history_shared=? WHERE id=?').bind(input.shared?1:0,p.id).run();return json({shared:input.shared});
  }
  if(path.length===2&&path[1]==='finalize'&&request.method==='POST'){
    if(p.state==='published')return json({id:p.id,published:true});
    for(const asset of value.assets)for(let index=0;index<asset.parts.length;index++){
      const part=asset.parts[index],stored=await env.ASSETS.head(assetKey(p,asset.id,index));
      if(!stored||stored.size!==part.size||checksum(stored)!==part.sha256)throw new HttpError(409,'UPLOAD_INCOMPLETE');
    }
    await db.batch([
      db.prepare(`UPDATE publications SET state='published',published_at=? WHERE id=? AND state='uploading'
        AND EXISTS(SELECT 1 FROM projects WHERE id=? AND current_publication_id IS ?)` ).bind(Date.now(),p.id,projectId,p.base_id),
      db.prepare(`UPDATE projects SET current_publication_id=? WHERE id=? AND current_publication_id IS ?
        AND EXISTS(SELECT 1 FROM publications WHERE id=? AND state='published')`).bind(p.id,projectId,p.base_id,p.id),
    ]);
    const updated=await db.prepare('SELECT state FROM publications WHERE id=?').bind(p.id).first<{state:string}>();
    if(updated?.state!=='published')throw new HttpError(409,'PUBLICATION_BASE_CHANGED');return json({id:p.id,published:true});
  }
  throw new HttpError(404,'NOT_FOUND');
}
