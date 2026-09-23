import {requestInputSchema,requestStateSchema} from '../contracts/workspace.ts';
import { DomainError } from './store.ts';
import type {Store} from './store.ts';
import type {RequestInput,RequestState} from '../contracts/workspace.ts';
import {storedWorkSchema,storedResultSchema} from '../contracts/stored-work.ts';
import type {StoredWork} from '../contracts/stored-work.ts';
import {z} from 'zod';

function fail(code:string):never { throw new DomainError(code); }
const encodedRow=z.object({input:z.string(),result:z.string().nullable()}).passthrough();
const pinSchema=z.object({id:z.string(),basis:z.string(),role:z.enum(['target','preserve','reference'])}).passthrough();
const decode = (row:unknown):StoredWork|null => {
 if(!row)return null;
 const value=encodedRow.parse(row);
 const decoded={...value,input:JSON.parse(value.input),result:value.result?JSON.parse(value.result):null};
 storedWorkSchema.parse(decoded);
 // Validation must not reorder legacy JSON keys: extension retries compare their exact input serialization.
 return decoded as StoredWork;
};

/** Durable browser jobs, separate from the host command queue. */
export class Workspace {
  readonly store:Store;
  constructor(store:Store) {
    this.store = store;
    store.db.exec(`
      UPDATE workspace_requests SET state=CASE WHEN state='running' AND json_extract(result,'$.phase')='host' THEN 'unknown' ELSE 'interrupted' END WHERE state IN ('queued','running');`);
  }
  list(projectId:string):StoredWork[] {
    this.store.project(projectId);
    return this.store.db.prepare('SELECT * FROM workspace_requests WHERE projectId=? ORDER BY rowid').all(projectId).map(row=>decode(row)!);
  }
  get(projectId:string, id:string):StoredWork {
    return decode(this.store.db.prepare('SELECT * FROM workspace_requests WHERE projectId=? AND id=?').get(projectId,id)) ?? fail('NOT_FOUND');
  }
  basis(projectId:string,input:Pick<RequestInput,'id'|'baseRequestId'|'host'>):StoredWork|undefined{
    if(input.baseRequestId===null)return undefined;
    if(input.baseRequestId)return this.get(projectId,input.baseRequestId);
    return this.list(projectId).filter(request=>request.id!==input.id&&request.result?.hostExecuted&&(request.result.host||'rhino')===(input.host||'rhino')).at(-1);
  }
  submit(projectId:string, value:unknown) {
    this.store.project(projectId);
    const parsed=requestInputSchema.safeParse(value);if(!parsed.success)fail('INVALID_INPUT');const input=parsed.data;
    // Keep the original serialization for existing idempotency records.
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 200000) fail('INPUT_TOO_LARGE');
    const existing = this.store.db.prepare('SELECT * FROM workspace_requests WHERE id=?').get(input.id);
    if (existing) {
      if (existing.projectId !== projectId || existing.input !== serialized) fail('REVISION_CONFLICT');
      return { request: decode(existing)!, created: false };
    }
    const target=input.host||'rhino';
    if(input.permission==='candidate'&&this.list(projectId).some(r=>r.state==='unknown'&&(r.input.host||'rhino')===target))fail('HOST_RESULT_UNRESOLVED');
    const baseline=this.basis(projectId,input);
    if(input.baseRequestId&&!baseline?.result?.hostExecuted)fail('STALE_REFERENCE');
    if(baseline&&(baseline.result?.host||'rhino')!==target)fail('TARGET_MISMATCH');
    for(const value of input.pins){
      const parsedPin=pinSchema.safeParse(value);if(!parsedPin.success)fail('STALE_REFERENCE');const pin=parsedPin.data;
      let source;try{source=this.get(projectId,pin.basis);}catch{fail('STALE_REFERENCE');}
      if(!source.result?.hostExecuted||!source.result.objects?.some(o=>o.id===pin.id))fail('STALE_REFERENCE');
      if((source.result.host||'rhino')===target&&['target','preserve'].includes(pin.role)&&pin.basis!==baseline?.id)fail('STALE_REFERENCE');
    }
    if (this.store.db.prepare("SELECT id FROM workspace_requests WHERE projectId=? AND state IN ('queued','running')").get(projectId)) fail('PROJECT_BUSY');
    this.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(input.id, projectId, serialized, 'queued', null, new Date().toISOString());
    return {request:this.get(projectId,input.id),created:true};
  }
  update(projectId:string,id:string,state:RequestState,result:unknown=null):StoredWork {
    if (state==='queued'||!requestStateSchema.safeParse(state).success) fail('INVALID_INPUT');
    this.get(projectId,id);
    if(result!==null&&!storedResultSchema.safeParse(result).success)fail('INVALID_HOST_RESULT');
    this.store.db.prepare('UPDATE workspace_requests SET state=?,result=? WHERE id=? AND projectId=?')
      .run(state,result===null?null:JSON.stringify(result),id,projectId);
    return this.get(projectId,id);
  }
}
