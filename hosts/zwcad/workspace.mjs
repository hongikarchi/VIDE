import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const run=promisify(execFile);
export class ZwcadWorkspace {
  constructor(directory){this.directory=resolve(directory);this.tail=Promise.resolve();}
  async invoke(input){
    const execute=async()=>{
      await mkdir(this.directory,{recursive:true});
      const request=join(this.directory,randomUUID()+'.request.json');
      await writeFile(request,JSON.stringify(input),{flag:'wx'});
      try{
        const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',fileURLToPath(new URL('./workspace.ps1',import.meta.url)),'-RequestPath',request],{windowsHide:true,encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024});
        return JSON.parse(stdout.trim());
      }catch(error){throw Object.assign(new Error('ZWCAD_EXECUTION_FAILED'),{code:error.killed?'HOST_RESULT_UNKNOWN':'ZWCAD_EXECUTION_FAILED',detail:(error.stdout||error.stderr||'').slice(0,2000)});}
      finally{await unlink(request).catch(()=>{});}
    };
    const result=this.tail.then(execute);this.tail=result.catch(()=>{});return result;
  }
  async status(){return {available:false,reason:'CONNECTS_WHEN_EXECUTED',host:'zwcad'};}
  async build(projectId,requestId,objects,baseline){
    if(!/^[a-zA-Z0-9-]+$/.test(projectId)||!/^[a-zA-Z0-9-]+$/.test(requestId))throw Error('INVALID_ID');
    if(objects.some(o=>o.kind!=='polyline'||o.points.some(p=>p[2]!==o.points[0][2])))throw Object.assign(new Error('ZWCAD_POLYLINE_ONLY'),{code:'ZWCAD_POLYLINE_ONLY'});
    if(baseline?.fileHash&&createHash('sha256').update(await readFile(baseline.filename)).digest('hex')!==baseline.fileHash)throw Object.assign(new Error('SOURCE_CHANGED'),{code:'SOURCE_CHANGED'});
    const directory=join(this.directory,projectId);await mkdir(directory,{recursive:true});
    const filename=join(directory,requestId+'.dwg');
    const result=await this.invoke({mode:'build',filename,objects});
    if(!result.verified||result.scene.length!==objects.length)throw Object.assign(new Error('HOST_VERIFICATION_FAILED'),{code:'HOST_VERIFICATION_FAILED'});
    return {...result,filename,fileHash:createHash('sha256').update(await readFile(filename)).digest('hex')};
  }
  async open(filename){
    const target=resolve(filename);
    if(!target.startsWith(this.directory+'\\'))throw Error('INVALID_ARTIFACT');
    return this.invoke({mode:'open',filename:target});
  }
}
