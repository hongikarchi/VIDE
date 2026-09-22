import {z} from 'zod';
import {legacyObjectSchema} from '../../src/core/geometry.ts';
import type {GeometryObject} from '../../src/core/geometry.ts';
import {workspaceResultSchema} from '../../src/contracts/workspace-result.ts';
const sceneSchema=workspaceResultSchema.shape.scene.unwrap();
const baselineSchema=z.object({filename:z.string(),fileHash:z.string(),referenceOnly:z.boolean().optional(),dwgEditMode:z.string().nullish(),sourceUnits:z.number().optional(),objects:z.array(legacyObjectSchema),scene:sceneSchema}).passthrough();
const importSchema=baselineSchema.omit({filename:true,fileHash:true}).extend({verified:z.literal(true)});
const buildSchema=z.object({verified:z.literal(true),scene:sceneSchema}).passthrough();
interface Invocation {mode:'inspect'|'edit'|'build'|'open';filename:string;objects?:GeometryObject[]}
const commandError=(cause:unknown)=>z.object({stdout:z.string().optional(),stderr:z.string().optional(),killed:z.boolean().optional()}).safeParse(cause).data??{};
import {validateDwgEdit,verifyDwgEdit} from './edit-contract.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,unlink,copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const run=promisify(execFile);
export class ZwcadWorkspace {
  directory:string;tail:Promise<unknown>;
  constructor(directory:string){this.directory=resolve(directory);this.tail=Promise.resolve();}
  async invoke(input:Invocation):Promise<unknown>{
    const execute=async()=>{
      await mkdir(this.directory,{recursive:true});
      const request=join(this.directory,randomUUID()+'.request.json');
      await writeFile(request,JSON.stringify(input),{flag:'wx'});
      try{
        const {stdout}=await run(join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',fileURLToPath(new URL(input.mode==='inspect'?'./import.ps1':input.mode==='edit'?'./edit.ps1':'./workspace.ps1',import.meta.url)),'-RequestPath',request],{windowsHide:true,encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024});
        try{return JSON.parse(stdout.trim());}catch{throw Object.assign(new Error('HOST_RESULT_UNKNOWN'),{code:'HOST_RESULT_UNKNOWN'});}
      }catch(cause){if(cause instanceof Error&&'code' in cause&&cause.code==='HOST_RESULT_UNKNOWN')throw cause;const error=commandError(cause);let code='ZWCAD_EXECUTION_FAILED';try{const failure=JSON.parse((error.stdout??'').trim());if(['UNKNOWN_UNITS','IMPORT_LIMIT','UNSUPPORTED_DWG_CONTENT','EMPTY_DWG','UNSUPPORTED_DWG_EDIT'].includes(failure.error))code=failure.error;}catch{}
        throw Object.assign(new Error(code),{code:error.killed?'HOST_RESULT_UNKNOWN':code,detail:(error.stdout||error.stderr||'').slice(0,2000)});}
      finally{await unlink(request).catch(()=>{});}
    };
    const result=this.tail.then(execute);this.tail=result.catch(()=>{});return result;
  }
  async status(){return {available:false,reason:'CONNECTS_WHEN_EXECUTED',host:'zwcad'};}
  async importFile(projectId:string,requestId:string,source:string){
    if(!/^[a-zA-Z0-9-]+$/.test(projectId)||!/^[a-zA-Z0-9-]+$/.test(requestId))throw Error('INVALID_ID');
    const directory=join(this.directory,projectId);await mkdir(directory,{recursive:true});const filename=join(directory,requestId+'.dwg');
    await copyFile(source,filename,constants.COPYFILE_EXCL);return this.inspectImport(projectId,requestId,createHash('sha256').update(await readFile(source)).digest('hex'));
  }
  async inspectImport(projectId:string,requestId:string,expectedHash:string){
    if(!/^[a-zA-Z0-9-]+$/.test(projectId)||!/^[a-zA-Z0-9-]+$/.test(requestId)||!/^[a-f0-9]{64}$/.test(expectedHash))throw Object.assign(new Error('INVALID_INPUT'),{code:'INVALID_INPUT'});
    const filename=join(this.directory,projectId,requestId+'.dwg');
    const before=createHash('sha256').update(await readFile(filename)).digest('hex');
    if(before!==expectedHash)throw Object.assign(new Error('SOURCE_CHANGED'),{code:'SOURCE_CHANGED'});
    const result=importSchema.parse(await this.invoke({mode:'inspect',filename}));
    const after=createHash('sha256').update(await readFile(filename)).digest('hex');
    if(!result.verified||before!==after)throw Object.assign(new Error('HOST_VERIFICATION_FAILED'),{code:'HOST_VERIFICATION_FAILED'});
    return {...result,filename,fileHash:after};
  }
  async build(projectId:string,requestId:string,objects:GeometryObject[],baselineValue?:unknown){
    const baseline=baselineValue===undefined?undefined:baselineSchema.parse(baselineValue);
    if(baseline?.referenceOnly&&baseline.dwgEditMode!=='polyline-vertices-v1')throw Object.assign(new Error('ZWCAD_REFERENCE_ONLY'),{code:'ZWCAD_REFERENCE_ONLY'});
    if(!/^[a-zA-Z0-9-]+$/.test(projectId)||!/^[a-zA-Z0-9-]+$/.test(requestId))throw Error('INVALID_ID');
    if(objects.some(o=>o.kind!=='polyline'||o.points.some(p=>p[2]!==o.points[0][2])))throw Object.assign(new Error('ZWCAD_POLYLINE_ONLY'),{code:'ZWCAD_POLYLINE_ONLY'});
    if(baseline?.fileHash&&createHash('sha256').update(await readFile(baseline.filename)).digest('hex')!==baseline.fileHash)throw Object.assign(new Error('SOURCE_CHANGED'),{code:'SOURCE_CHANGED'});
    const directory=join(this.directory,projectId);await mkdir(directory,{recursive:true});
    const filename=join(directory,requestId+'.dwg');
    if(baseline?.referenceOnly){
      validateDwgEdit(objects,baseline);await copyFile(baseline.filename,filename,constants.COPYFILE_EXCL);
      if(createHash('sha256').update(await readFile(filename)).digest('hex')!==baseline.fileHash)throw Object.assign(new Error('SOURCE_CHANGED'),{code:'SOURCE_CHANGED'});
      await this.invoke({mode:'edit',filename,objects});
      const result=await this.inspectImport(projectId,requestId,createHash('sha256').update(await readFile(filename)).digest('hex'));
      verifyDwgEdit(objects,baseline,result);return result;
    }
    const parsed=buildSchema.safeParse(await this.invoke({mode:'build',filename,objects}));
    if(!parsed.success)throw Object.assign(new Error('HOST_RESULT_UNKNOWN'),{code:'HOST_RESULT_UNKNOWN'});
    const result=parsed.data;
    if(!result.verified||result.scene.length!==objects.length)throw Object.assign(new Error('HOST_VERIFICATION_FAILED'),{code:'HOST_VERIFICATION_FAILED'});
    return {...result,filename,fileHash:createHash('sha256').update(await readFile(filename)).digest('hex')};
  }
  async open(filename:string){
    const target=resolve(filename);
    if(!target.startsWith(this.directory+'\\'))throw Error('INVALID_ARTIFACT');
    return this.invoke({mode:'open',filename:target});
  }
}
