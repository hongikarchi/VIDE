import {manualApproval,type Env} from './auth';
import {requestJoin,joinRoute} from './joins';
import {HttpError,body,digest,json,role,text} from './http';

export interface Actor {id:string;email:string}
type MemberRole='owner'|'viewer'|'commenter';
export async function membership(db:D1Database,projectId:string,userId:string):Promise<MemberRole>{
  const row=await db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').bind(projectId,userId).first<{role:MemberRole}>();
  if(!row)throw new HttpError(404,'PROJECT_NOT_FOUND');return row.role;
}
const ownerSql="EXISTS(SELECT 1 FROM project_members WHERE project_id=? AND user_id=? AND role='owner')";

export async function projectRoute(request:Request,env:Env,actor:Actor,path:string[]):Promise<Response>{
  const db=env.DB;
  if(path.length===0){
    if(request.method==='GET'){
      const rows=await db.prepare('SELECT p.id,p.name,p.created_at,m.role FROM projects p JOIN project_members m ON m.project_id=p.id WHERE m.user_id=? ORDER BY p.created_at DESC,p.id LIMIT 200').bind(actor.id).all();
      return json({projects:rows.results});
    }
    if(request.method==='POST'){
      const input=await body(request),name=text(input.name),id=crypto.randomUUID();
      await db.batch([
        db.prepare('INSERT INTO projects(id,name,created_by,created_at) VALUES(?,?,?,?)').bind(id,name,actor.id,Date.now()),
        db.prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'owner')").bind(id,actor.id),
      ]);
      return json({id,name,role:'owner'},201);
    }
    throw new HttpError(405,'METHOD_NOT_ALLOWED');
  }
  const projectId=path[0],current=await membership(db,projectId,actor.id);
  if(path.length===1&&request.method==='GET')return json(await db.prepare('SELECT id,name,created_at FROM projects WHERE id=?').bind(projectId).first());
  if(current!=='owner')throw new HttpError(403,'OWNER_REQUIRED');
  if(path[1]==='join-requests')return joinRoute(request,env,actor,projectId,path.slice(2));
  if(path[1]==='members'){
    if(path.length===2&&request.method==='GET')return json({members:(await db.prepare('SELECT m.user_id,m.role,u.name,u.email FROM project_members m JOIN user u ON u.id=m.user_id WHERE project_id=? ORDER BY m.user_id').bind(projectId).all()).results});
    if(path.length===3&&['PATCH','DELETE'].includes(request.method)){
      const target=path[2];if(target===actor.id)throw new HttpError(409,'OWNER_CANNOT_BE_REMOVED');
      const result=request.method==='DELETE'
        ?await db.prepare(`DELETE FROM project_members WHERE project_id=? AND user_id=? AND role!='owner' AND ${ownerSql}`).bind(projectId,target,projectId,actor.id).run()
        :await db.prepare(`UPDATE project_members SET role=? WHERE project_id=? AND user_id=? AND role!='owner' AND ${ownerSql}`).bind(role((await body(request)).role),projectId,target,projectId,actor.id).run();
      if(!result.meta.changes)throw new HttpError(404,'MEMBER_NOT_FOUND');return json({changed:true});
    }
  }
  if(path[1]==='invitations'){
    if(path.length===2&&request.method==='GET')return json({invitations:(await db.prepare('SELECT id,email,role,expires_at,revoked_at,accepted_at FROM invitations WHERE project_id=? ORDER BY created_at DESC LIMIT 200').bind(projectId).all()).results});
    if(path.length===2&&request.method==='POST'){
      const input=await body(request),email=text(input.email,254).toLowerCase(),selectedRole=role(input.role);
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new HttpError(400,'INVALID_EMAIL');
      const now=Date.now(),id=crypto.randomUUID(),token=crypto.randomUUID()+crypto.randomUUID(),expiresAt=now+7*86400000;
      const result=await db.prepare(`INSERT INTO invitations(id,project_id,email,role,token_hash,expires_at,created_at) SELECT ?,?,?,?,?,?,? WHERE ${ownerSql}`).bind(id,projectId,email,selectedRole,await digest(token),expiresAt,now,projectId,actor.id).run();
      if(!result.meta.changes)throw new HttpError(403,'OWNER_REQUIRED');
      // Fragment keeps the raw invitation token out of server access logs/referrers.
      const link=env.AUTH_ORIGIN+'/invite#'+token;
      let delivered=false;try{if(!manualApproval(env))await env.EMAIL!.send({from:env.EMAIL_FROM,to:email,subject:'VIDE project invitation',text:link});delivered=!manualApproval(env);}catch{}
      return json({id,expiresAt,link,emailDelivery:manualApproval(env)?'disabled':delivered?'submitted':'failed'},201);
    }
    if(path.length===3&&request.method==='DELETE'){
      const result=await db.prepare(`UPDATE invitations SET revoked_at=? WHERE project_id=? AND id=? AND ${ownerSql}`).bind(Date.now(),projectId,path[2],projectId,actor.id).run();
      if(!result.meta.changes)throw new HttpError(404,'INVITATION_NOT_FOUND');return json({revoked:true});
    }
  }
  throw new HttpError(404,'NOT_FOUND');
}

export async function acceptInvitation(request:Request,env:Env,actor:Actor):Promise<Response>{
  if(manualApproval(env))return requestJoin(request,env,actor);
  const token=text((await body(request)).token,200),hash=await digest(token),now=Date.now(),db=env.DB;
  // Both statements are one D1 transaction. A replay never recreates a removed membership.
  await db.batch([
    db.prepare(`INSERT INTO project_members(project_id,user_id,role)
      SELECT project_id,?,role FROM invitations WHERE token_hash=? AND email=? AND revoked_at IS NULL AND expires_at>? AND accepted_by IS NULL
      ON CONFLICT(project_id,user_id) DO NOTHING`).bind(actor.id,hash,actor.email.toLowerCase(),now),
    db.prepare(`UPDATE invitations SET accepted_by=?,accepted_at=? WHERE token_hash=? AND email=? AND revoked_at IS NULL AND expires_at>? AND accepted_by IS NULL
      AND EXISTS(SELECT 1 FROM project_members WHERE project_id=invitations.project_id AND user_id=?)`).bind(actor.id,now,hash,actor.email.toLowerCase(),now,actor.id),
  ]);
  const row=await db.prepare(`SELECT i.project_id,m.role FROM invitations i JOIN project_members m ON m.project_id=i.project_id AND m.user_id=i.accepted_by
    WHERE i.token_hash=? AND i.email=? AND i.accepted_by=? AND i.revoked_at IS NULL`).bind(hash,actor.email.toLowerCase(),actor.id).first();
  if(!row)throw new HttpError(409,'INVITATION_UNAVAILABLE');return json(row);
}
