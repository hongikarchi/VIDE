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
    if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(input.id)
      || typeof input.body !== 'string' || input.body.length > 20000
      || !['review','candidate'].includes(input.permission)
      || !['claude-cli','codex-cli','extension'].includes(input.provider)) fail('INVALID_INPUT');
    if(input.provider==='extension'&&(input.permission!=='review'||typeof input.extension!=='string'||!(/^[a-z0-9-]{1,80}$/.test(input.extension))||typeof input.extensionVersion!=='string'))fail('INVALID_INPUT');
    for (const key of ['pins','sketches','files']) if (!Array.isArray(input[key]) || input[key].length > 100) fail('INVALID_INPUT');
    if(input.host!==undefined&&!['rhino','zwcad'].includes(input.host))fail('INVALID_INPUT');
    if(input.baseRequestId!==undefined&&input.baseRequestId!==null&&(typeof input.baseRequestId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(input.baseRequestId)))fail('INVALID_INPUT');
    if(input.model!==undefined&&(typeof input.model!=='string'||!/^[a-zA-Z0-9._-]{1,100}(?:\[1m\])?$/.test(input.model)))fail('INVALID_INPUT');
    if(input.effort!==undefined&&!['default','low','medium','high','xhigh','max'].includes(input.effort))fail('INVALID_INPUT');
    for(const s of input.sketches){
      if(!s||!['XY','XZ','YZ'].includes(s.plane)||s.unit!=='m'||!['reference','boundary','path','direction'].includes(s.role)
        ||!Array.isArray(s.points)||s.points.length<2||s.points.length>1000||s.points.some(p=>!Array.isArray(p)||p.length!==2||p.some(n=>!Number.isFinite(n)||Math.abs(n)>100000)))fail('INVALID_INPUT');
    }
    for(const f of input.files)if(!f||typeof f.name!=='string'||typeof f.text!=='string'||f.text.length>50000)fail('INVALID_INPUT');
    if (!input.body.trim() && !input.sketches.length && !input.pins.length && !input.files.length) fail('INVALID_INPUT');
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
    if (!['running','succeeded','failed','cancelled','interrupted','unknown'].includes(state)) fail('INVALID_INPUT');
    this.get(projectId,id);
    this.store.db.prepare('UPDATE workspace_requests SET state=?,result=? WHERE id=? AND projectId=?')
      .run(state,result===null?null:JSON.stringify(result),id,projectId);
    return this.get(projectId,id);
  }
}
