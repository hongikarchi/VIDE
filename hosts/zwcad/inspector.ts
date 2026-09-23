import {existsSync,createReadStream} from 'node:fs';
import {mkdir,readFile,writeFile,access,unlink,rmdir} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {launchOwnedHost} from '../common/owned-process.ts';
import {sendHostCommand} from '../common/transport.ts';
import {packageRoot} from '../../src/core/package-root.ts';

const readySchema=z.object({port:z.number().int().min(1).max(65535),pid:z.number().int().positive(),startTicks:z.string().regex(/^\d+$/),sessionId:z.string().uuid(),documentId:z.string().uuid(),revision:z.literal(0)});
const allowedErrors=new Set(['UNKNOWN_UNITS','IMPORT_LIMIT','UNSUPPORTED_DWG_CONTENT','EMPTY_DWG','UNSUPPORTED_DWG_EDIT']);
const failure=(code:string)=>Object.assign(Error(code),{code});
async function fingerprint(filename:string){const hash=createHash('sha256');for await(const bytes of createReadStream(filename))hash.update(bytes);return hash.digest('hex');}
export function inspectorOptions(){
 const root=fileURLToPath(packageRoot),bundled=join(root,'hosts/zwcad/worker/runtime/VIDE.Zwcad.Worker.dll');
 return {executable:process.env.VIDE_ZWCAD_PATH||join(process.env.ProgramFiles||'C:\\Program Files','ZWSOFT/ZWCAD 2023/ZWCAD.exe'),
  plugin:existsSync(bundled)?bundled:join(root,'.vide/build/zwcad-worker/VIDE.Zwcad.Worker.dll')};
}

/** Inspect only the caller's artifact copy; never attach to an existing CAD application. */
export async function inspectDwg(filename:string,outputRoot:string,options=inspectorOptions(),edit?:{output:string;objects:unknown[]}):Promise<unknown>{
 if(![filename,outputRoot,options.executable,options.plugin].every(isAbsolute))throw failure('INVALID_HOST_LAUNCH');
 try{await Promise.all([filename,options.executable,options.plugin].map(path=>access(path)));}catch{throw failure('SDK_HOST_NOT_INSTALLED');}
 if(edit&&(!isAbsolute(edit.output)||resolve(edit.output)===resolve(filename)||existsSync(edit.output)))throw failure('UNSUPPORTED_DWG_EDIT');
 const before=await fingerprint(filename),directory=join(outputRoot,randomUUID());await mkdir(outputRoot,{recursive:true});await mkdir(directory);
 const report=join(directory,'ready.json'),script=join(directory,'start.scr');
 const token=randomBytes(32).toString('hex'),sessionId=randomUUID();
 await writeFile(script,`(command "_NETLOAD" ${JSON.stringify(options.plugin.replaceAll('\\','/'))})\nVIDEInspectDwg\n`,{flag:'wx'});
 if(edit)await writeFile(join(directory,'edits.json'),JSON.stringify({objects:edit.objects}),{flag:'wx'});
 const owner=await launchOwnedHost({executable:options.executable,args:['/b',script],visible:false,environment:{...process.env,
  VIDE_WORKER_TOKEN:token,VIDE_WORKER_SESSION:sessionId,VIDE_WORKER_REPORT:report,VIDE_WORKER_SOURCE:resolve(filename),VIDE_WORKER_OUTPUT:edit?.output||'',VIDE_WORKER_EDITS:edit?join(directory,'edits.json'):''}});
 let completed=false;
 try{
  await writeFile(join(directory,'process.json'),JSON.stringify(owner.identity),{flag:'wx'});
  const deadline=Date.now()+90000;let ready:z.infer<typeof readySchema>|undefined;
  while(Date.now()<deadline){
   try{ready=readySchema.parse(JSON.parse(await readFile(report,'utf8')));break;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw failure('HOST_INVALID_RESPONSE');}
   try{
    const result=z.object({code:z.string()}).parse(JSON.parse(await readFile(report+'.error.json','utf8')));
    throw failure(allowedErrors.has(result.code)?result.code:'ZWCAD_EXECUTION_FAILED');
   }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   await new Promise(accept=>setTimeout(accept,200));
  }
  if(!ready)throw failure('WORKER_START_TIMEOUT');
  if(ready.pid!==owner.identity.pid||ready.startTicks!==owner.identity.startTicks||ready.sessionId!==sessionId)throw failure('HOST_OWNERSHIP_MISMATCH');
  const response=z.object({ok:z.literal(true),model:z.unknown()}).parse(await sendHostCommand('vide',{
   token,sessionId,pid:ready.pid,startTicks:ready.startTicks,documentId:ready.documentId,method:'query',
  },{port:ready.port,timeoutMs:20000,beforeSend:()=>owner.verify(ready!.port)}));
  if(await fingerprint(filename)!==before)throw failure('SOURCE_CHANGED');
  completed=true;return response.model;
 }finally{
  await owner.stop();
  if(completed){
   // Remove only known bootstrap artifacts created in this fresh directory; never recurse.
   for(const name of ['start.scr','process.json','ready.json',...(edit?['edits.json']:[])])await unlink(join(directory,name));
   await rmdir(directory);
  }
 }
}
