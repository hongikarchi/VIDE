import {requestInputSchema,requestStateSchema} from '../contracts/workspace.ts';
import { DomainError } from './store.mjs';

const fail = code => { throw new DomainError(code); };
const decode = row => row ? { ...row, input: JSON.parse(row.input), result: row.result ? JSON.parse(row.result) : null } : null;

/** Durable browser jobs, separate from the host command queue. */
export class Workspace {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_requests (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
      input TEXT NOT NULL, state TEXT NOT NULL, result TEXT, createdAt TEXT NOT NULL);
      UPDATE workspace_requests SET state=CASE WHEN state='running' AND json_extract(result,'$.phase')='host' THEN 'unknown' ELSE 'interrupted' END WHERE state IN ('queued','running');`);
  }
  list(projectId) {
    this.store.project(projectId);
    return this.store.db.prepare('SELECT * FROM workspace_requests WHERE projectId=? ORDER BY rowid').all(projectId).map(decode);
  }
  get(projectId, id) {
    return decode(this.store.db.prepare('SELECT * FROM workspace_requests WHERE projectId=? AND id=?').get(projectId,id)) ?? fail('NOT_FOUND');
  }
  basis(projectId,input){
    if(input.baseRequestId===null)return undefined;
    if(input.baseRequestId)return this.get(projectId,input.baseRequestId);
    return this.list(projectId).filter(request=>request.id!==input.id&&request.result?.hostExecuted&&(request.result.host||'rhino')===(input.host||'rhino')).at(-1);
  }
  submit(projectId, input) {
    this.store.project(projectId);
    if (!requestInputSchema.safeParse(input).success) fail('INVALID_INPUT');
    // Keep the original serialization for existing idempotency records.
    const serialized = JSON.stringify(input);
    if (Buffer.byteLength(serialized) > 200000) fail('INPUT_TOO_LARGE');
    const existing = this.store.db.prepare('SELECT * FROM workspace_requests WHERE id=?').get(input.id);
    if (existing) {
      if (existing.projectId !== projectId || existing.input !== serialized) fail('REVISION_CONFLICT');
      return { request: decode(existing), created: false };
    }
    const target=input.host||'rhino';
    if(input.permission==='candidate'&&this.list(projectId).some(r=>r.state==='unknown'&&(r.input.host||'rhino')===target))fail('HOST_RESULT_UNRESOLVED');
    const baseline=this.basis(projectId,input);
    if(input.baseRequestId&&!baseline?.result?.hostExecuted)fail('STALE_REFERENCE');
    if(baseline&&(baseline.result.host||'rhino')!==target)fail('TARGET_MISMATCH');
    for(const pin of input.pins){
      if(!pin||!['target','preserve','reference'].includes(pin.role)||typeof pin.basis!=='string')fail('STALE_REFERENCE');
      let source;try{source=this.get(projectId,pin.basis);}catch{fail('STALE_REFERENCE');}
      if(!source.result?.hostExecuted||!source.result.objects.some(o=>o.id===pin.id))fail('STALE_REFERENCE');
      if((source.result.host||'rhino')===target&&['target','preserve'].includes(pin.role)&&pin.basis!==baseline?.id)fail('STALE_REFERENCE');
    }
    if (this.store.db.prepare("SELECT id FROM workspace_requests WHERE projectId=? AND state IN ('queued','running')").get(projectId)) fail('PROJECT_BUSY');
    this.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(input.id, projectId, serialized, 'queued', null, new Date().toISOString());
    return {request:this.get(projectId,input.id),created:true};
  }
  update(projectId,id,state,result=null) {
    if (state==='queued'||!requestStateSchema.safeParse(state).success) fail('INVALID_INPUT');
    this.get(projectId,id);
    this.store.db.prepare('UPDATE workspace_requests SET state=?,result=? WHERE id=? AND projectId=?')
      .run(state,result===null?null:JSON.stringify(result),id,projectId);
    return this.get(projectId,id);
  }
}
