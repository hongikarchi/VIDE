import {csharpLiteral as literal} from '../common/csharp.ts';
interface CaptureHost {directory:string;importFile(projectId:string,requestId:string,source:string):Promise<Record<string,unknown>>}
import {mkdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {DomainError} from '../../src/core/store.ts';
import {legacyRhinoCommand as rhinoCommand} from './transport.ts';
import {documentGuard,documentFingerprint} from './document-contract.ts';
export async function captureDocument(host:CaptureHost,projectId:string,requestId:string,instance:string,documentId:number){
 if(!/^[a-zA-Z0-9-]+$/.test(projectId)||!/^[a-zA-Z0-9-]+$/.test(requestId))throw new DomainError('INVALID_INPUT');
 const guard=documentGuard(instance,documentId);
 const directory=join(host.directory,projectId),snapshot=join(directory,requestId+'.capture.3dm');
 await mkdir(directory,{recursive:true});
 const code=`${guard}${documentFingerprint}
 var originalPath=document.Path;var originalName=document.Name;bool modified=document.Modified;
 var selected=document.Objects.GetSelectedObjects(false,false).Select(o=>o.Id.ToString()).ToArray();
 var options=new Rhino.FileIO.FileWriteOptions();options.SuppressAllInput=true;options.SuppressDialogBoxes=true;options.UpdateDocumentPath=false;options.WriteSelectedObjectsOnly=false;
 if(!document.Write3dmFile(${literal(snapshot)},options))throw new Exception("Capture failed");
 if(document.Path!=originalPath||document.Name!=originalName||document.Modified!=modified)throw new Exception("Document state changed");
 output.AppendLine(fingerprint);output.AppendLine(document.ModelUnitSystem.ToString());
 output.AppendLine(Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(document.Name??"Untitled")));
 output.AppendLine(String.Join(",",selected));`;
 let uncertain=false;
 try{
  const response=await rhinoCommand('execute_rhinocommon_csharp_code',{code},{timeoutMs:60000});
  if(!response.success)throw new DomainError('CAPTURE_FAILED');
  const [hash,units,name,selection='']=response.output.trim().split(/\r?\n/);
  if(!/^[a-f0-9]{64}$/.test(hash))throw new DomainError('HOST_INVALID_RESPONSE');
  const result=await host.importFile(projectId,requestId,snapshot);
  return {...result,sourceDocument:{instance,documentId,documentHash:hash,units,name:Buffer.from(name,'base64').toString('utf8'),selectedIds:selection?selection.split(','):[],capturedAt:new Date().toISOString()}};
 }catch(error){uncertain=!!(error&&typeof error==='object'&&'code' in error&&error.code==='HOST_RESULT_UNKNOWN');throw error;}
 finally{if(!uncertain)await unlink(snapshot).catch(()=>{});}
}
