import { createProvider } from '../ai/providers.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { geometryContract, interpret, protectGeometry } from '../core/geometry.mjs';

export class Execution {
  constructor(workspace, { providerFactory = createProvider, host, hosts } = {}) {
    this.workspace=workspace; this.providerFactory=providerFactory; this.host=host; this.active=new Map();
    this.hosts=hosts||{rhino:host};
  }
  provider(input) {
    const executable=input.provider==='claude-cli'
      ? process.env.VIDE_CLAUDE_PATH || join(homedir(),'.local','bin','claude.exe')
      : process.env.VIDE_CODEX_PATH || [join(homedir(),'AppData','Roaming','npm','node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe')].find(existsSync);
    return this.providerFactory({provider:input.provider,executable,timeoutMs:180000,
      model:input.model&&input.model!==input.provider?input.model:undefined,
      effort:input.effort&&input.effort!=='default'?input.effort:undefined});
  }
  async models(){
    const catalog=[{id:'claude-cli',name:'Claude · 기본 모델',provider:'claude-cli',efforts:['default','low','medium','high','xhigh','max']},
      {id:'codex-cli',name:'ChatGPT · 기본 모델',provider:'codex-cli',efforts:['default']}];
    try{const cache=JSON.parse(await readFile(join(homedir(),'.codex','models_cache.json'),'utf8'));
      for(const model of cache.models||[])if(/^[a-zA-Z0-9._-]{1,100}$/.test(model.slug))catalog.push({id:model.slug,name:model.display_name||model.slug,provider:'codex-cli',efforts:['default',...(model.supported_reasoning_levels||[]).map(x=>x.effort).filter(x=>['low','medium','high','xhigh','max'].includes(x))]});
    }catch{/* Default model remains usable without a cached catalog. */}
    try{const settings=JSON.parse(await readFile(join(homedir(),'.claude','settings.json'),'utf8'));
      if(typeof settings.model==='string'&&/^[a-zA-Z0-9._-]{1,100}(?:\[1m\])?$/.test(settings.model))catalog.push({id:settings.model,name:settings.model,provider:'claude-cli',efforts:['default','low','medium','high','xhigh','max']});
    }catch{}
    return catalog;
  }
  async status() {
    return Promise.all(['claude-cli','codex-cli'].map(async provider=>{
      try {return {id:provider,...await this.provider({provider}).status()};}
      catch(error){return {id:provider,available:false,reason:error.code||'CLI_UNAVAILABLE'};}
    }));
  }
  start(request) {
    if(this.active.has(request.id))return;
    const controller=new AbortController();
    const completion=this.run(request,controller).finally(()=>this.active.delete(request.id));
    this.active.set(request.id,{controller,completion,projectId:request.projectId});
  }
  async run(request,controller) {
    const {projectId,id,input}=request;
    const target=input.host||'rhino',host=this.hosts[target];
    this.workspace.update(projectId,id,'running');
    let hostIntent;
    try {
      const items=[...input.pins.map((data,i)=>({id:`pin-${i}`,type:'object-reference',data})),
        ...input.sketches.map((data,i)=>({id:`sketch-${i}`,type:'sketch',data})),
        ...input.files.map((data,i)=>({id:`file-${i}`,type:'file',data}))];
      const previous=input.baseRequestId?this.workspace.get(projectId,input.baseRequestId):this.workspace.list(projectId).filter(r=>r.id!==id&&r.result?.hostExecuted&&(r.result.host||'rhino')===target).at(-1);
      if(previous?.result.referenceOnly&&input.permission==='candidate')throw {code:'ZWCAD_REFERENCE_ONLY'};
      const referenced=input.pins.map(pin=>{const source=this.workspace.get(projectId,pin.basis);return {role:pin.role,sourceRequestId:source.id,host:source.result.host||'rhino',object:source.result.objects.find(o=>o.id===pin.id)};});
      if(referenced.length)items.push({id:'referenced-geometry',type:'geometry-reference',data:referenced});
      const conversation=this.workspace.list(projectId).filter(r=>r.id!==id&&r.state==='succeeded').slice(-6)
        .map(r=>({request:r.input.body,response:r.result?.text}));
      if(conversation.length)items.push({id:'conversation',type:'conversation',data:conversation});
      if(host)items.push({id:'working-model',type:'geometry',data:previous?.result.objects||[]});
      if(previous?.result.scene)items.push({id:'measurements',type:'native-measurements',data:previous.result.scene.map(({id,area,volume,length,boundsSize,layer64})=>({id,area,volume,length,boundsSize,layer:layer64?Buffer.from(layer64,'base64').toString('utf8'):null}))});
      const targetContract=target==='zwcad'?'Target is ZWCAD: only planar XY polylines, their move and remove are supported. No solid operations.':'Target is Rhino.';
      const goal=(host?geometryContract+'\n'+targetContract+' Other-host pinned geometry is read-only reference in meters, never a writable target.\nPermission: '+input.permission+'\nUser request: ':'')+(input.body||'첨부한 설계 문맥을 검토해 주세요.');
      const result=await this.provider(input).run({goal,
        revision:1,items,includedIds:items.map(item=>item.id)}, {signal:controller.signal,
        onProgress:event=>this.workspace.update(projectId,id,'running',{phase:event.state==='stopping'?'stopping':'model',hostExecuted:false})});
      if(host){
        const proposal=interpret(result.text,previous?.result.objects||[],input.permission);
        const protectedIds=input.pins.filter(pin=>['preserve','reference'].includes(pin.role)&&pin.basis===previous?.id).map(pin=>pin.id);
        protectGeometry(previous?.result.objects||[],proposal.objects,protectedIds);
        if(controller.signal.aborted)throw {code:'CANCELLED'};
        if(proposal.changed){
          hostIntent={phase:'host',hostExecuted:false,objects:proposal.objects,baseRequestId:previous?.id,host:target};
          this.workspace.update(projectId,id,'running',hostIntent);
          const native=await host.build(projectId,id,proposal.objects,previous?.result);
          const objects=proposal.objects.map(o=>o.kind==='native'?{...o,nativeId:native.scene.find(x=>x.id===o.id).nativeId}:o);
          this.workspace.update(projectId,id,'succeeded',{...result,text:proposal.message,objects,...native,sourceDocument:previous?.result.sourceDocument,baseRequestId:previous?.id,host:target,hostExecuted:true});
        }else this.workspace.update(projectId,id,'succeeded',{...result,text:proposal.message,hostExecuted:false});
      }else this.workspace.update(projectId,id,'succeeded',{...result,hostExecuted:false});
    } catch(error) {
      this.workspace.update(projectId,id,error.code==='CANCELLED'?'cancelled':error.code==='HOST_RESULT_UNKNOWN'?'unknown':'failed',{...(error.code==='HOST_RESULT_UNKNOWN'?hostIntent:{}),code:error.code||'EXECUTION_FAILED',hostExecuted:false});
    }
  }
  cancel(projectId,id) {
    const active=this.active.get(id);
    if(active?.projectId===projectId)active.controller.abort();
    return this.workspace.get(projectId,id);
  }
  async close(){const active=[...this.active.values()];active.forEach(x=>x.controller.abort());await Promise.all(active.map(x=>x.completion));}
}
