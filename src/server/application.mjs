import {randomUUID} from 'node:crypto';
import {DomainError} from '../core/store.mjs';
import {previewApplication,applyToDocument} from '../../hosts/rhino/application.mjs';
export class Applications{
 constructor(store,workspace,{preview=previewApplication,apply=applyToDocument}={}){this.store=store;this.workspace=workspace;this.preview=preview;this.apply=apply;this.pending=new Map();this.active=new Set();}
 async prepare(projectId,requestId,target){
  const candidate=this.workspace.get(projectId,requestId);
  if(!candidate.result?.hostExecuted||(candidate.result.host||'rhino')!=='rhino'||candidate.result.objects.some(o=>!['box','polyline','extrude'].includes(o.kind)))throw new DomainError('UNSUPPORTED_APPLICATION');
  const effect=await this.preview(projectId,target.instance,target.documentId,candidate.result.objects);
  let connection=this.store.db.prepare('SELECT * FROM connections WHERE host=? AND instanceId=? AND documentId=? AND connected=1').get('rhino',target.instance,String(target.documentId));
  if(connection&&connection.projectId!==projectId)throw new DomainError('DOCUMENT_ALREADY_CONNECTED');
  connection??=this.store.registerConnection(projectId,{host:'rhino',instanceId:target.instance,documentId:String(target.documentId)});
  if(this.store.hasUncertainWrite(connection.id))throw new DomainError('WRITE_UNCERTAIN');
  const run=this.store.createRun(projectId,{goal:'Apply inspected Rhino candidate',targets:[connection.id]});
  const command={id:randomUUID(),runId:run.id,connectionId:connection.id,revision:run.revision,kind:'applyCandidate',payload:{requestId,instance:target.instance,documentId:target.documentId,documentHash:effect.documentHash,candidateHash:candidate.result.fileHash}};
  if(this.pending.size>=100)this.pending.delete(this.pending.keys().next().value);
  this.pending.set(command.id,{projectId,command,expires:Date.now()+10*60*1000});
  return {id:command.id,...effect,documentId:target.documentId,saveRequired:true};
 }
 async confirm(projectId,id){
  try{return this.store.getCommand(projectId,id);}catch(error){if(error.code!=='NOT_FOUND')throw error;}
  const pending=this.pending.get(id);
  if(!pending||pending.projectId!==projectId||pending.expires<Date.now())throw new DomainError('PREVIEW_EXPIRED');
  const {command}=pending;
  if(this.active.has(command.connectionId))throw new DomainError('CONTROLLER_BUSY');
  this.active.add(command.connectionId);
  try{
   this.store.approve(projectId,command,'local-controller');this.store.enqueue(projectId,command);
   const leased=this.store.lease(command.connectionId);if(leased?.id!==id)throw new DomainError('CONTROLLER_BUSY');
   let outcome;
   try{const candidate=this.workspace.get(projectId,command.payload.requestId);outcome=await this.apply(projectId,id,candidate.result,command.payload);}
   catch(error){outcome={state:error.code==='HOST_REJECTED'?'failed':'unknown',result:{code:error.code||'HOST_RESULT_UNKNOWN',applied:false}};}
   return this.store.complete(command.connectionId,id,outcome);
  }finally{this.pending.delete(id);this.active.delete(command.connectionId);}
 }
}
