import {captureDocument} from '../../hosts/rhino/capture.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {DomainError} from '../core/store.mjs';

export async function importModel(request,projectId,name,workspace,host,cadHost){
  workspace.store.project(projectId);
  if(request.headers['content-type']!=='application/octet-stream'||typeof name!=='string'||!(/\.(3dm|dwg)$/i.test(name))||name.length>200)throw new DomainError('INVALID_INPUT');
  const cad=name.toLowerCase().endsWith('.dwg');if(cad){if(!cadHost)throw new DomainError('INVALID_INPUT');host=cadHost;}
  const extension=cad?'dwg':'3dm';
  const chunks=[];let size=0;
  for await(const chunk of request){size+=chunk.length;if(size>64*1024*1024)throw new DomainError('INPUT_TOO_LARGE');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  if(cad?!/^AC10[0-9]{2}$/.test(bytes.subarray(0,6).toString('ascii')):!bytes.subarray(0,32).toString().startsWith('3D Geometry File Format'))throw new DomainError('INVALID_INPUT');
  const id=randomUUID(),input={id,provider:'codex-cli',host:cad?'zwcad':'rhino',source:'file',permission:'candidate',body:`${name} 불러오기`,pins:[],sketches:[],files:[]};
  const intent={phase:'import',host:cad?'zwcad':'rhino',sourceHash:createHash('sha256').update(bytes).digest('hex')};
  workspace.submit(projectId,input);workspace.update(projectId,id,'running',intent);
  const directory=join(host.directory,projectId),source=join(directory,id+'.upload.'+extension);
  let uncertain=false;
  try{
    await mkdir(directory,{recursive:true});await writeFile(source,bytes,{flag:'wx'});
    const result=await host.importFile(projectId,id,source);
    return workspace.update(projectId,id,'succeeded',{...result,host:cad?'zwcad':'rhino',hostExecuted:true,text:cad&&result.dwgEditMode==='polyline-vertices-v1'?'DWG 작업 사본을 열었습니다. 기존 직선 경계의 이동·정점 수정을 지원하며 원본 파일은 변경하지 않습니다.':cad?'DWG 모델 공간의 참고 경계를 읽었습니다. 좌표는 m이며 원본 도면 편집은 아직 지원하지 않습니다.':'원본과 분리된 작업 사본을 열었습니다. 좌표 단위는 m입니다.'});
  }catch(error){
    uncertain=error.code==='HOST_RESULT_UNKNOWN';
    return workspace.update(projectId,id,uncertain?'unknown':'failed',{...intent,code:error.code||'IMPORT_FAILED',hostExecuted:false});
  }finally{if(!uncertain)await unlink(source).catch(()=>{});}
}

export async function recoverDwgImport(projectId,id,workspace,host){
 const request=workspace.get(projectId,id);
 if(request.input.source!=='file'||request.input.host!=='zwcad')throw new DomainError('IMPORT_EVIDENCE_MISSING');
 if(request.state==='succeeded')return request;
 if(request.state!=='unknown'||request.result?.phase!=='import'||!/^[a-f0-9]{64}$/.test(request.result.sourceHash||''))throw new DomainError('IMPORT_EVIDENCE_MISSING');
 if(workspace.list(projectId).some(row=>['queued','running'].includes(row.state)))throw new DomainError('PROJECT_BUSY');
 let result;
 try{result=await host.inspectImport(projectId,id,request.result.sourceHash);}
 catch(error){throw new DomainError(['SOURCE_CHANGED','HOST_RESULT_UNKNOWN','HOST_VERIFICATION_FAILED','UNSUPPORTED_DWG_CONTENT','UNKNOWN_UNITS','EMPTY_DWG'].includes(error.code)?error.code:'IMPORT_RECOVERY_FAILED');}
 if(result.fileHash!==request.result.sourceHash||!result.verified||!result.referenceOnly)throw new DomainError('HOST_VERIFICATION_FAILED');
 const recovered=workspace.update(projectId,id,'succeeded',{...result,host:'zwcad',hostExecuted:true,recovered:true,text:'업로드 당시와 같은 DWG 복사본을 다시 읽어 참고 경계를 확인했습니다.'});
 await unlink(join(host.directory,projectId,id+'.upload.dwg')).catch(()=>{});
 return recovered;
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
