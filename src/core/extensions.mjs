import manifest from '../../extensions/object-summary/manifest.json' with {type:'json'};
import {run} from '../../extensions/object-summary/index.mjs';import {DomainError} from './store.mjs';
const allowed=new Map([[manifest.id,{manifest,run}]]);
export function validateExtensionManifest(value){
 if(!value||value.contractVersion!==1||value.input!=='saved-selection'||value.output!=='object-summary'||value.cancellation!==false||JSON.stringify(value.capabilities)!=='["model.read"]'||!(/^[a-z0-9-]{1,80}$/.test(value.id))||!(/^\d+\.\d+\.\d+$/.test(value.version))||typeof value.name!=='string')throw new DomainError('INVALID_EXTENSION_CONTRACT');
}
export class Extensions{
 constructor(store,workspace){for(const extension of allowed.values())validateExtensionManifest(extension.manifest);this.store=store;this.workspace=workspace;store.db.exec('CREATE TABLE IF NOT EXISTS extension_registrations(id TEXT PRIMARY KEY,version TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL)');}
 list(){return [...allowed.values()].map(({manifest})=>({...manifest,...this.registration(manifest.id)}));}
 registration(id){if(!allowed.has(id))throw new DomainError('NOT_FOUND');const row=this.store.db.prepare('SELECT enabled,revision,version FROM extension_registrations WHERE id=?').get(id);return {enabled:!!row?.enabled&&row.version===allowed.get(id).manifest.version,revision:row?.revision||0};}
 save(id,input){const extension=allowed.get(id);if(!extension)throw new DomainError('NOT_FOUND');if(!input||Object.keys(input).some(key=>!['enabled','revision'].includes(key))||typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.revision))throw new DomainError('INVALID_INPUT');if(this.registration(id).revision!==input.revision)throw new DomainError('REVISION_CONFLICT');
  this.store.db.prepare('INSERT INTO extension_registrations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,revision=excluded.revision').run(id,extension.manifest.version,Number(input.enabled),input.revision+1);return this.registration(id);
 }
 execute(projectId,id,input){
  const extension=allowed.get(id);if(!extension)throw new DomainError('NOT_FOUND');
  if(!input||Object.keys(input).some(key=>!['id','requestId','objectIds'].includes(key))||typeof input.id!=='string'||typeof input.requestId!=='string'||!Array.isArray(input.objectIds)||!input.objectIds.length||input.objectIds.length>100||input.objectIds.some(value=>typeof value!=='string')||new Set(input.objectIds).size!==input.objectIds.length)throw new DomainError('INVALID_INPUT');
  const source=this.workspace.get(projectId,input.requestId);if(!source.result?.hostExecuted)throw new DomainError('STALE_REFERENCE');
  const objects=input.objectIds.map(id=>source.result.objects.find(object=>object.id===id));if(objects.some(object=>!object))throw new DomainError('STALE_REFERENCE');
  const command={id:input.id,provider:'extension',extension:id,extensionVersion:extension.manifest.version,permission:'review',host:source.result.host||'rhino',baseRequestId:source.id,body:extension.manifest.name,pins:objects.map(object=>({id:object.id,name:object.name,basis:source.id,role:'reference'})),files:[],sketches:[]};
  // A repeated submission retrieves its existing result even if the extension was disabled later.
  const existing=this.workspace.list(projectId).find(request=>request.id===input.id);
  if(existing){if(JSON.stringify(existing.input)!==JSON.stringify(command))throw new DomainError('REVISION_CONFLICT');return existing;}
  if(!this.registration(id).enabled)throw new DomainError('EXTENSION_DISABLED');
  const {request}=this.workspace.submit(projectId,command);this.workspace.update(projectId,request.id,'running',{phase:'extension',hostExecuted:false});
  try{
   const context={objects:objects.map(object=>{const native=source.result.scene.find(item=>item.id===object.id);return {id:object.id,type:native?.nativeType||object.kind,layer:native?.layer64?Buffer.from(native.layer64,'base64').toString('utf8'):null};})};
   const output=extension.run(structuredClone(context));const resultIds=output?.rows?.flatMap(row=>row.objectIds)||[];
   if(output?.type!=='object-summary'||!Array.isArray(output.rows)||output.rows.some(row=>typeof row.type!=='string'||!(row.layer===null||typeof row.layer==='string')||row.count!==row.objectIds.length)||resultIds.length!==objects.length||new Set(resultIds).size!==objects.length||resultIds.some(id=>!input.objectIds.includes(id)))throw Error('Invalid extension result');
   return this.workspace.update(projectId,request.id,'succeeded',{hostExecuted:false,extensionExecuted:true,extensionResult:output,text:objects.length+'개 객체를 유형·레이어별로 요약했습니다.',baseRequestId:source.id});
  }catch{return this.workspace.update(projectId,request.id,'failed',{code:'EXTENSION_FAILED',hostExecuted:false,extensionExecuted:false});}
 }
}
