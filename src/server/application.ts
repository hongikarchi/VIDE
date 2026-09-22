import {z} from 'zod';
import type {Store} from '../core/store.ts';
import type {Workspace} from '../core/workspace.ts';
import {hostTargetSchema} from '../contracts/host-documents.ts';
const resultSchema=z.object({objects:z.array(z.object({id:z.string(),kind:z.string()}).passthrough()),fileHash:z.string(),sourceDocument:z.object({instance:z.string(),documentId:z.number(),documentHash:z.string()}).passthrough().optional()}).passthrough();
const payloadSchema=hostTargetSchema.extend({requestId:z.string(),documentHash:z.string(),candidateHash:z.string(),mode:z.literal('native-move').optional(),movements:z.array(z.object({id:z.string(),delta:z.array(z.number()).length(3)})).optional()});
type Payload=z.infer<typeof payloadSchema>;
type Movement=NonNullable<Payload['movements']>[number];
const effectSchema=z.object({documentHash:z.string(),added:z.number(),updated:z.number(),removed:z.number()}).passthrough();
const outcomeSchema=z.object({state:z.enum(['succeeded','failed','unknown']),result:z.record(z.string(),z.unknown())});
interface Options {preview?:(projectId:string,instance:string,documentId:number,objects:{id:string;kind:string}[])=>Promise<unknown>;apply?:(projectId:string,id:string,candidate:unknown,payload:Payload)=>Promise<unknown>;nativePreview?:(instance:string,documentId:number,hash:string,moves:Movement[])=>Promise<unknown>;nativeApply?:(id:string,candidate:unknown,payload:Payload)=>Promise<unknown>;reconcile?:(id:string,candidate:unknown,payload:Payload)=>Promise<unknown>}
type Command={id:string;runId:string;connectionId:string;revision:number;kind:string;payload:Payload};
const errorCode=(value:unknown)=>value&&typeof value==='object'&&'code' in value&&typeof value.code==='string'?value.code:undefined;
import {reconcileNativeApplication} from '../../hosts/rhino/reconciliation.ts';
import {nativeMoves} from '../core/native-application.ts';
import {previewNativeApplication,applyNativeMovements} from '../../hosts/rhino/native-application.ts';
import {randomUUID} from 'node:crypto';
import {DomainError} from '../core/store.ts';
import {previewApplication,applyToDocument} from '../../hosts/rhino/application.ts';
export class Applications{
 store:Store;workspace:Workspace;preview:NonNullable<Options['preview']>;apply:NonNullable<Options['apply']>;nativePreview:NonNullable<Options['nativePreview']>;nativeApply:NonNullable<Options['nativeApply']>;reconcile:NonNullable<Options['reconcile']>;
 pending=new Map<string,{projectId:string;command:Command;expires:number}>();active=new Set<string>();
 constructor(store:Store,workspace:Workspace,{preview=previewApplication,apply=applyToDocument,nativePreview=previewNativeApplication,nativeApply=applyNativeMovements,reconcile=reconcileNativeApplication}:Options={}){this.store=store;this.workspace=workspace;this.preview=preview;this.apply=apply;this.reconcile=reconcile;this.nativePreview=nativePreview;this.nativeApply=nativeApply;this.pending=new Map();this.active=new Set();}
 async prepare(projectId:string,requestId:string,rawTarget:unknown){
  const target=hostTargetSchema.parse(rawTarget);
  const candidate=this.workspace.get(projectId,requestId);
  if(!candidate.result?.hostExecuted||(candidate.result.host||'rhino')!=='rhino')throw new DomainError('UNSUPPORTED_APPLICATION');
  // The legacy apply adapter understands translations/templates, not arbitrary SDK geometry edits.
  if(candidate.result.executionMode==='sdk')throw new DomainError('UNSUPPORTED_APPLICATION');
  const candidateResult=resultSchema.parse(candidate.result);
  let movements:Movement[]|undefined,effect:z.infer<typeof effectSchema>;
  if(candidateResult.sourceDocument||candidateResult.objects.some(object=>object.kind==='native')){
   const sourceDocument=candidateResult.sourceDocument;
   if(!sourceDocument||sourceDocument.instance!==target.instance||sourceDocument.documentId!==target.documentId)throw new DomainError('TARGET_MISMATCH');
   let original=candidate;const seen=new Set();
   while(original.input.source!=='document'){
    if(!original.result?.baseRequestId||seen.has(original.id))throw new DomainError('UNSUPPORTED_APPLICATION');seen.add(original.id);original=this.workspace.get(projectId,original.result.baseRequestId);
   }
   movements=nativeMoves(candidate.result,original.result);
   effect=effectSchema.parse(await this.nativePreview(target.instance,target.documentId,sourceDocument.documentHash,movements));
  }else{
   if(candidateResult.objects.some(object=>!['box','polyline','extrude'].includes(object.kind)))throw new DomainError('UNSUPPORTED_APPLICATION');
   effect=effectSchema.parse(await this.preview(projectId,target.instance,target.documentId,candidateResult.objects));
  }
  const row=this.store.db.prepare('SELECT * FROM connections WHERE host=? AND instanceId=? AND documentId=? AND connected=1').get('rhino',target.instance,String(target.documentId));
  let connection=row?z.object({id:z.string(),projectId:z.string()}).parse(row):undefined;
  if(connection&&connection.projectId!==projectId)throw new DomainError('DOCUMENT_ALREADY_CONNECTED');
  connection??=this.store.registerConnection(projectId,{host:'rhino',instanceId:target.instance,documentId:String(target.documentId)});
  if(this.store.hasUncertainWrite(connection.id))throw new DomainError('WRITE_UNCERTAIN');
  const run=this.store.createRun(projectId,{goal:'Apply inspected Rhino candidate',targets:[connection.id]});
  const command:Command={id:randomUUID(),runId:run.id,connectionId:connection.id,revision:run.revision,kind:'applyCandidate',payload:{requestId,instance:target.instance,documentId:target.documentId,documentHash:effect.documentHash,candidateHash:candidateResult.fileHash,...(movements?{mode:'native-move',movements}:{})}};
  if(this.pending.size>=100)this.pending.delete(this.pending.keys().next().value!);
  this.pending.set(command.id,{projectId,command,expires:Date.now()+10*60*1000});
  return {id:command.id,...effect,documentId:target.documentId,saveRequired:true};
 }
 async recover(projectId:string,id:string){
  const command=this.store.getCommand(projectId,id);
  if(command.kind!=='applyCandidate'||command.payload.mode!=='native-move')throw new DomainError('APPLICATION_EVIDENCE_MISSING');
  if(command.state!=='unknown')return command;
  if(this.active.has(command.connectionId))throw new DomainError('CONTROLLER_BUSY');
  this.active.add(command.connectionId);
  try{
   const payload=payloadSchema.parse(command.payload);
   const candidate=this.workspace.get(projectId,payload.requestId);
   const outcome=outcomeSchema.parse(await this.reconcile(id,candidate.result,payload));
   return this.store.complete(command.connectionId,id,{state:outcome.state,result:{...outcome.result,previousResult:(command.result&&typeof command.result==='object'&&'previousResult' in command.result?command.result.previousResult:undefined)||command.result}});
  }finally{this.active.delete(command.connectionId);}
 }
 async confirm(projectId:string,id:string){
  try{return this.store.getCommand(projectId,id);}catch(error){if(errorCode(error)!=='NOT_FOUND')throw error;}
  const pending=this.pending.get(id);
  if(!pending||pending.projectId!==projectId||pending.expires<Date.now())throw new DomainError('PREVIEW_EXPIRED');
  const {command}=pending;
  if(this.active.has(command.connectionId))throw new DomainError('CONTROLLER_BUSY');
  this.active.add(command.connectionId);
  try{
   this.store.approve(projectId,command,'local-controller');this.store.enqueue(projectId,command);
   const leased=this.store.lease(command.connectionId);if(leased?.id!==id)throw new DomainError('CONTROLLER_BUSY');
   let outcome:z.infer<typeof outcomeSchema>;
   try{const candidate=this.workspace.get(projectId,command.payload.requestId);outcome=outcomeSchema.parse(command.payload.mode==='native-move'?await this.nativeApply(id,candidate.result,command.payload):await this.apply(projectId,id,candidate.result,command.payload));}
   catch(error){outcome={state:errorCode(error)==='HOST_REJECTED'?'failed':'unknown',result:{code:errorCode(error)||'HOST_RESULT_UNKNOWN',applied:false}};}
   return this.store.complete(command.connectionId,id,outcome);
  }finally{this.pending.delete(id);this.active.delete(command.connectionId);}
 }
}
