import {captureDocument} from '../../hosts/rhino/capture.mjs';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {DomainError} from '../core/store.mjs';

export async function importModel(request,projectId,name,workspace,host){
  workspace.store.project(projectId);
  if(request.headers['content-type']!=='application/octet-stream'||typeof name!=='string'||!name.toLowerCase().endsWith('.3dm')||name.length>200)throw new DomainError('INVALID_INPUT');
  const chunks=[];let size=0;
  for await(const chunk of request){size+=chunk.length;if(size>64*1024*1024)throw new DomainError('INPUT_TOO_LARGE');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  if(!bytes.subarray(0,32).toString().startsWith('3D Geometry File Format'))throw new DomainError('INVALID_INPUT');
  const id=randomUUID(),input={id,provider:'codex-cli',host:'rhino',source:'file',permission:'candidate',body:`${name} 불러오기`,pins:[],sketches:[],files:[]};
  workspace.submit(projectId,input);workspace.update(projectId,id,'running');
  const directory=join(host.directory,projectId),source=join(directory,id+'.upload.3dm');
  let uncertain=false;
  try{
    await mkdir(directory,{recursive:true});await writeFile(source,bytes,{flag:'wx'});
    const result=await host.importFile(projectId,id,source);
    return workspace.update(projectId,id,'succeeded',{...result,host:'rhino',hostExecuted:true,text:'원본과 분리된 작업 사본을 열었습니다. 좌표 단위는 m입니다.'});
  }catch(error){
    uncertain=error.code==='HOST_RESULT_UNKNOWN';
    return workspace.update(projectId,id,uncertain?'unknown':'failed',{code:error.code||'IMPORT_FAILED',hostExecuted:false});
  }finally{if(!uncertain)await unlink(source).catch(()=>{});}
}

export async function captureModel(projectId,target,workspace,host,capture=captureDocument){
 if(!target||!/^\d+:\d+$/.test(target.instance)||!Number.isInteger(target.documentId)||target.documentId<=0||target.documentId>4294967295)throw new DomainError('INVALID_INPUT');
 const input={id:target.id,provider:'codex-cli',host:'rhino',source:'document',permission:'candidate',body:'열린 Rhino 문서 가져오기',pins:[],sketches:[],files:[],sourceDocument:{instance:target.instance,documentId:target.documentId}};
 const submitted=workspace.submit(projectId,input);if(!submitted.created)return submitted.request;
 workspace.update(projectId,input.id,'running',{phase:'capture',host:'rhino'});
 try{
  const result=await capture(host,projectId,input.id,target.instance,target.documentId);
  return workspace.update(projectId,input.id,'succeeded',{...result,host:'rhino',hostExecuted:true,text:'열린 문서의 작업 사본을 가져왔습니다. 원본은 변경하지 않았으며 이후 변경은 자동 동기화하지 않습니다.'});
 }catch(error){return workspace.update(projectId,input.id,'failed',{code:error.code||'CAPTURE_FAILED',host:'rhino',hostExecuted:false});}
}
