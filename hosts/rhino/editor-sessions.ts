import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {launchRhinoWorker} from './worker-client.ts';
import type {HostTarget,HostDocuments} from '../../src/contracts/host-documents.ts';

type Worker=Awaited<ReturnType<typeof launchRhinoWorker>>;
interface Options {directory:string;executable:string;plugin:string;bootstrap:string;launch?:typeof launchRhinoWorker}
const failure=(code:string)=>Object.assign(new Error(code),{code});

/** Visible user editing sessions stay alive when the controller closes. */
export class EditorSessions {
 private sessions=new Map<string,Worker>();
 private options:Options;
 constructor(options:Options){this.options=options;}
 has(instance:string){return this.sessions.has(instance);}
 async open(source:{filename:string;fileHash:string}){
  await mkdir(this.options.directory,{recursive:true});
  const worker=await (this.options.launch||launchRhinoWorker)({...this.options,directory:join(this.options.directory,randomUUID()),mode:'editor',visible:true,source});
  const instance=worker.identity.pid+':'+worker.identity.startTicks;
  worker.detach();this.sessions.set(instance,worker);
  return {opened:true,instance,documentId:worker.identity.documentId};
 }
 private get(target:HostTarget){
  const worker=this.sessions.get(target.instance);
  if(!worker||worker.identity.documentId!==target.documentId)throw failure('STALE_CONNECTION');
  return worker;
 }
 async list():Promise<HostDocuments|null>{
  const documents:HostDocuments['documents']=[];
  for(const [instance,worker] of this.sessions){
   try{const snapshot=await worker.inspectEditor();documents.push({instance,id:snapshot.documentId,name:snapshot.name,units:snapshot.units,objectCount:snapshot.objectCount,modified:snapshot.modified});}
   catch(error){if(error&&typeof error==='object'&&'code' in error&&['HOST_LEASE_EXPIRED','TARGET_MISMATCH'].includes(String(error.code)))this.sessions.delete(instance);}
  }
  return documents.length?{instance:documents[0].instance!,documents}:null;
 }
 async inspect(target:HostTarget){
  const snapshot=await this.get(target).inspectEditor();
  return {...target,documentHash:snapshot.documentHash,selectedIds:snapshot.selectedIds,observedAt:new Date().toISOString()};
 }
 async capture(target:HostTarget){return this.get(target).captureEditor(randomUUID());}
}
