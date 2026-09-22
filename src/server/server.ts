import {z} from 'zod';
import type {IncomingMessage} from 'node:http';
import type {StoredWork} from '../contracts/stored-work.ts';
import {hostTargetSchema} from '../contracts/host-documents.ts';
import {candidateSchema} from '../core/reviews.ts';
type ExecutionOptions=NonNullable<ConstructorParameters<typeof Execution>[1]>;
interface ServerOptions {filename:string;port?:number;providerFactory?:ExecutionOptions['providerFactory'];host?:RhinoWorkspace;cadHost?:ZwcadWorkspace;applicationOptions?:ConstructorParameters<typeof Applications>[2];onShutdown?:()=>void;sdkOptions?:Omit<ConstructorParameters<typeof SdkExecution>[0],'tools'|'origin'>}
import {readWebAsset} from './web-assets.ts';
import {Extensions} from '../core/extensions.ts';
import { AgentTools } from './agent-tools.ts';
import { SdkExecution } from './sdk-execution.ts';
import {AiSettings} from '../core/ai-settings.ts';
import {ReviewNotes} from '../core/review-notes.ts';
import {compareReviews} from '../core/review-comparison.ts';
import {Reviews} from '../core/reviews.ts';
import {createPublicationBundle} from '../core/publication.ts';
import {TableViews} from '../core/table-views.ts';
import {Applications} from './application.ts';
import {listDocuments,inspectDocument} from '../../hosts/rhino/documents.ts';
import {compareCandidates,relatedCandidates} from '../core/comparison.ts';
import {quantities,quantitiesCsv} from '../core/quantities.ts';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile,unlink } from 'node:fs/promises';
import { Store, DomainError } from '../core/store.ts';
import { Workspace } from '../core/workspace.ts';
import { Execution } from './execution.ts';
import { RhinoWorkspace } from '../../hosts/rhino/workspace.ts';
import { ZwcadWorkspace } from '../../hosts/zwcad/workspace.ts';
import { dirname, join } from 'node:path';
import { importModel,captureModel,recoverDwgImport } from './import-model.ts';
import { renderReport } from './report.ts';

const equal = (a:unknown, b:string) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(request:IncomingMessage):Promise<Record<string,unknown>> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new DomainError('JSON_REQUIRED');
  let size = 0; const chunks:Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length; if (size > 1024 * 1024) throw new DomainError('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  try { const parsed:unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw 0; return z.record(z.string(),z.unknown()).parse(parsed); }
  catch { throw new DomainError('INVALID_INPUT'); }
}
const statuses:Record<string,number> = { NOT_FOUND: 404, FORBIDDEN: 403, UNAUTHORIZED: 401, JSON_REQUIRED: 415, INPUT_TOO_LARGE: 413,
  REVISION_CONFLICT: 409, TARGET_MISMATCH: 409, CONTROLLER_BUSY: 409, PROJECT_BUSY:409, STALE_REFERENCE:409 };
export async function startServer({ filename, port = 0, providerFactory, host, cadHost,applicationOptions,onShutdown,sdkOptions }:ServerOptions) {
  const store = new Store(filename), bootstrap = randomBytes(32).toString('hex'), session = randomBytes(32).toString('hex');
  const agentTools = new AgentTools();
  const workspace = new Workspace(store),tableViews=new TableViews(store),reviews=new Reviews(store),reviewNotes=new ReviewNotes(store,reviews);
  host ??= new RhinoWorkspace(join(dirname(filename),'models'));
  const hosts={rhino:host,zwcad:cadHost||new ZwcadWorkspace(join(dirname(filename),'cad-models'))},importRecoveries=new Map<string,Promise<StoredWork>>();
  const aiSettings=new AiSettings(store),extensions=new Extensions(store,workspace);
  const sdk=sdkOptions?new SdkExecution({...sdkOptions,tools:agentTools,origin:()=>origin}):undefined;
  const applications=new Applications(store,workspace,{...applicationOptions,sdk:sdk?.editors});
  const rhinoImport=sdk?{directory:host.directory,importFile:(projectId:string,id:string,source:string)=>sdk.importFile(source,intent=>workspace.update(projectId,id,'running',intent))}:host;
  const execution = new Execution(workspace, { providerFactory, host, hosts,settings:aiSettings,sdk });
  const withApplications=(request:StoredWork)=>({...request,applications:store.db.prepare("SELECT id,state,result FROM commands WHERE projectId=? AND kind='applyCandidate' AND json_extract(payload,'$.requestId')=? ORDER BY rowid").all(request.projectId,request.id).map(row=>({...row,result:row.result?JSON.parse(z.string().parse(row.result)):null}))});
  let origin='', authority='',stopping=false;
  const server = createServer(async (request, response) => {
    const requestId = randomBytes(8).toString('hex');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status:number, data:unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
    try {
      if (request.headers.host !== authority) throw new DomainError('FORBIDDEN');
      if (request.headers.origin && request.headers.origin !== origin) throw new DomainError('FORBIDDEN');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new DomainError('FORBIDDEN');
      const url = new URL(request.url||'/', origin);
      if (url.pathname === '/mcp') {
        if (stopping) throw new DomainError('APP_STOPPING');
        await agentTools.handle(request, response, body); return;
      }
      if (request.method === 'GET') {
        const asset=await readWebAsset(url.pathname);
        if(asset){response.writeHead(200,{'Content-Type':asset.contentType});response.end(asset.body);return;}
      }
      if (!url.pathname.startsWith('/api/v1/')) throw new DomainError('NOT_FOUND');
      if (!['GET', 'POST', 'PUT'].includes(request.method||'')) { send(405, { code: 'METHOD_NOT_ALLOWED', requestId }); return; }
      if (request.method !== 'GET' && request.headers.origin !== origin) throw new DomainError('FORBIDDEN');
      if (url.pathname === '/api/v1/session' && request.method === 'POST') {
        const input = await body(request);
        if (!equal(input.token, bootstrap)) throw new DomainError('UNAUTHORIZED');
        response.setHeader('Set-Cookie', `vide_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
        send(200, { authenticated: true }); return;
      }
      const cookie = request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('vide_session='))?.slice(13);
      if (!equal(cookie, session)) throw new DomainError('UNAUTHORIZED');
      if(stopping&&request.method!=='GET')throw new DomainError('APP_STOPPING');
      if(url.pathname==='/api/v1/shutdown'&&request.method==='POST'&&onShutdown){stopping=true;send(200,{stopping:true});setImmediate(onShutdown);return;}
      const upload=/^\/api\/v1\/projects\/([^/]+)\/import$/.exec(url.pathname);
      if(upload&&request.method==='POST'){send(200,await importModel(request,upload[1],url.searchParams.get('name'),workspace,rhinoImport,hosts.zwcad));return;}
      const capture=/^\/api\/v1\/projects\/([^/]+)\/capture$/.exec(url.pathname);
      if(capture&&request.method==='POST'){
        const target=hostTargetSchema.extend({id:z.string()}).parse(await body(request));
        const own=await sdk?.editors.has(target.instance);
        send(200,await captureModel(capture[1],target,workspace,own?rhinoImport:host,own?async()=>sdk!.captureEditor(target,intent=>workspace.update(capture[1],target.id,'running',intent)):undefined));return;
      }
      const reviewComparison=/^\/api\/v1\/projects\/([^/]+)\/review-comparison$/.exec(url.pathname);
      const publicExport=/^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/publication-export$/.exec(url.pathname);
      if(publicExport&&request.method==='POST'){
        const bundle=createPublicationBundle(workspace.get(publicExport[1],publicExport[2]),await body(request));
        const bytes=Buffer.concat(bundle.chunks);
        if(bytes.byteLength>64*1024*1024)throw new DomainError('WEB_MODEL_LIMIT');
        response.setHeader('Content-Disposition','attachment; filename="VIDE-publication.json"');
        send(200,{format:'vide-publication-v1',requestId:randomUUID(),manifest:bundle.manifest,scene:JSON.parse(bytes.toString('utf8'))});return;
      }
      if(reviewComparison&&request.method==='GET'){
        const projectId=reviewComparison[1],before=reviews.get(projectId,url.searchParams.get('before')||''),after=reviews.get(projectId,url.searchParams.get('after')||'');
        let related=false;try{related=relatedCandidates(workspace,projectId,workspace.get(projectId,before.requestId),workspace.get(projectId,after.requestId));}catch(error){if(!(error instanceof DomainError)||error.code!=='NOT_FOUND')throw error;}
        send(200,compareReviews(before,after,related));return;
      }
      const note=/^\/api\/v1\/projects\/([^/]+)\/reviews\/([^/]+)\/notes$/.exec(url.pathname);
      if(note){
        if(request.method==='GET'){send(200,reviewNotes.list(note[1],note[2]));return;}
        if(request.method==='POST'){send(201,reviewNotes.create(note[1],note[2],await body(request)));return;}
      }
      const review=/^\/api\/v1\/projects\/([^/]+)\/reviews(?:\/([^/]+)(\/(?:preview|download))?)?$/.exec(url.pathname);
      if(review){
        if(request.method==='POST'&&!review[2]){const input=await body(request);send(201,reviews.create(review[1],input,withApplications(workspace.get(review[1],z.string().parse(input.requestId)))));return;}
        if(request.method==='GET'&&!review[2]){send(200,reviews.list(review[1]));return;}
        if(request.method==='GET'&&review[2]){
          const value=reviews.get(review[1],review[2]);if(!review[3]){send(200,value);return;}
          const saved=value.payload,html=renderReport(saved.project,saved.request,saved.image,saved);
          response.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
          response.writeHead(200,{'Content-Type':'text/html; charset=utf-8',...(review[3]==='/download'?{'Content-Disposition':'attachment; filename="VIDE-review.html"'}:{})});response.end(html);return;
        }
      }
      const report=/^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/report$/.exec(url.pathname);
      if(report&&request.method==='POST'){
        const html=renderReport(store.project(report[1]),withApplications(workspace.get(report[1],report[2])),(await body(request)).image);
        response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Disposition':'attachment; filename="VIDE-review.html"'});response.end(html);return;
      }
      if(url.pathname==='/api/v1/extensions'&&request.method==='GET'){send(200,extensions.list());return;}
      const extension=/^\/api\/v1\/extensions\/([^/]+)$/.exec(url.pathname);
      if(extension&&request.method==='PUT'){send(200,extensions.save(extension[1],await body(request)));return;}
      const extensionRun=/^\/api\/v1\/projects\/([^/]+)\/extensions\/([^/]+)\/run$/.exec(url.pathname);
      if(extensionRun&&request.method==='POST'){send(200,extensions.execute(extensionRun[1],extensionRun[2],await body(request)));return;}
      if(url.pathname==='/api/v1/settings/ai'){
        if(request.method==='PUT'){send(200,aiSettings.save(await body(request)));return;}
        if(request.method==='GET'){send(200,{...aiSettings.get(),resolved:Object.fromEntries(['claude-cli','codex-cli'].map(id=>[id,execution.executable(id)||null]))});return;}
      }
      if (url.pathname === '/api/v1/providers' && request.method === 'GET') {
        send(200, await execution.status()); return;
      }
      if (url.pathname === '/api/v1/host' && request.method === 'GET') { send(200,sdk?await sdk.status():await host.status()); return; }
      if (url.pathname === '/api/v1/models' && request.method === 'GET') { send(200,await execution.models()); return; }
      if(url.pathname==='/api/v1/host/documents'&&request.method==='GET'){
        const owned=await sdk?.editors.list();
        try{const legacy=await listDocuments();const documents=legacy.documents.map(doc=>({...doc,instance:doc.instance??legacy.instance}));send(200,owned?{...owned,documents:[...owned.documents,...documents.filter(doc=>!owned.documents.some(item=>item.instance===doc.instance&&item.id===doc.id))]}:legacy);}
        catch(error){if(!owned)throw error;send(200,owned);}return;
      }
      if(url.pathname==='/api/v1/host/selection'&&request.method==='GET'){const target=hostTargetSchema.parse({instance:url.searchParams.get('instance'),documentId:Number(url.searchParams.get('document'))});send(200,await sdk?.editors.has(target.instance)?await sdk!.editors.inspect(target):await inspectDocument(target.instance,target.documentId));return;}
      const importRecovery=/^\/api\/v1\/projects\/([^/]+)\/imports\/([^/]+)\/reconcile$/.exec(url.pathname);
      if(importRecovery&&request.method==='POST'){
        await body(request);const [,projectId,id]=importRecovery,key=projectId+':'+id;
        if(!importRecoveries.has(key)){const pending=recoverDwgImport(projectId,id,workspace,hosts.zwcad).finally(()=>importRecoveries.delete(key));importRecoveries.set(key,pending);}
        send(200,await importRecoveries.get(key));return;
      }
      const application=/^\/api\/v1\/projects\/([^/]+)\/applications(?:\/([^/]+)(\/reconcile)?)?$/.exec(url.pathname);
      if(application){
        if(request.method==='POST'&&application[3]){send(200,await applications.recover(application[1],application[2]));return;}
        if(request.method==='POST'&&!application[2]){const input=await body(request);send(201,await applications.prepare(application[1],z.string().parse(input.requestId),{instance:input.instance,documentId:input.documentId}));return;}
        if(request.method==='POST'&&application[2]){send(200,await applications.confirm(application[1],application[2]));return;}
        if(request.method==='GET'&&application[2]){send(200,store.getCommand(application[1],application[2]));return;}
      }
      const comparison=/^\/api\/v1\/projects\/([^/]+)\/comparison$/.exec(url.pathname);
      if(comparison&&request.method==='GET'){
        const projectId=comparison[1],before=workspace.get(projectId,url.searchParams.get('before')||''),after=workspace.get(projectId,url.searchParams.get('after')||'');
        send(200,compareCandidates(before,after,relatedCandidates(workspace,projectId,before,after)));return;
      }
      const view=/^\/api\/v1\/projects\/([^/]+)\/table-views(?:\/([^/]+)(\/delete)?)?$/.exec(url.pathname);
      if(view){
        if(request.method==='GET'&&!view[2]){send(200,tableViews.list(view[1]));return;}
        if(request.method==='POST'&&view[3]){send(200,tableViews.remove(view[1],view[2],z.number().int().parse((await body(request)).revision)));return;}
        if(request.method==='POST'&&!view[2]){send(201,tableViews.save(view[1],await body(request)));return;}
        if(request.method==='PUT'&&view[2]){send(200,tableViews.save(view[1],await body(request),view[2]));return;}
      }
      const table=/^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/(quantities|quantities.csv)$/.exec(url.pathname);
      if(table&&request.method==='GET'){
        const data=quantities(candidateSchema.parse(workspace.get(table[1],table[2])),Object.fromEntries(url.searchParams));
        if(table[3]==='quantities'){send(200,data);return;}
        response.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="VIDE-quantities.csv"'});response.end(quantitiesCsv(data));return;
      }
      const artifact=/^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/(model|open)$/.exec(url.pathname);
      if(artifact&&((request.method==='GET'&&artifact[3]==='model')||(request.method==='POST'&&artifact[3]==='open'))){
        const saved=workspace.get(artifact[1],artifact[2]);
        if(!saved.result?.hostExecuted||!saved.result.filename)throw new DomainError('NOT_FOUND');
        if(artifact[3]==='open'){send(200,saved.result.executionMode==='sdk'&&sdk?await sdk.open(saved.result):await hosts[z.enum(['rhino','zwcad']).parse(saved.result.host||'rhino')].open(z.string().parse(saved.result.filename)));return;}
        const content=await readFile(z.string().parse(saved.result.filename));
        response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="VIDE-candidate.${saved.result.host==='zwcad'?'dwg':'3dm'}"`});response.end(content);return;
      }
      const job = /^\/api\/v1\/projects\/([^/]+)\/requests(?:\/([^/]+)(\/cancel)?)?$/.exec(url.pathname);
      const sdkRecovery=/^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/reconcile$/.exec(url.pathname);
      if(sdkRecovery&&request.method==='POST'){
        const [,projectId,id]=sdkRecovery,saved=workspace.get(projectId,id);
        if(saved.state==='succeeded'){send(200,withApplications(saved));return;}
        if(saved.state!=='unknown'||saved.result?.executionMode!=='sdk'||!sdk)throw new DomainError('NOT_FOUND');
        const key='sdk:'+projectId+':'+id;
        if(!importRecoveries.has(key)){
          const pending=sdk.recover(saved.result).then(async result=>{
            const recovered=workspace.update(projectId,id,'succeeded',result);
            if(saved.input.source==='file')await unlink(join(host.directory,projectId,id+'.upload.3dm')).catch(()=>{});
            return recovered;
          })
            .catch(()=>workspace.get(projectId,id)).finally(()=>importRecoveries.delete(key));
          importRecoveries.set(key,pending);
        }
        send(200,withApplications((await importRecoveries.get(key))!));return;
      }
      if (job) {
        const [, projectId, id, cancel] = job;
        if (request.method === 'GET') { send(200, id ? withApplications(workspace.get(projectId,id)) : workspace.list(projectId).map(withApplications)); return; }
        if (request.method === 'POST' && cancel) { send(200, execution.cancel(projectId,id)); return; }
        if (request.method === 'POST' && !id) {
          const input=await body(request);if(input.provider==='extension')throw new DomainError('INVALID_INPUT');
          const result = workspace.submit(projectId, input);
          if (result.created) execution.start(result.request);
          send(result.created ? 202 : 200, workspace.get(projectId,result.request.id)); return;
        }
      }
      if (url.pathname === '/api/v1/projects') {
        if (request.method === 'GET') { send(200, store.listProjects()); return; }
        if (request.method === 'POST') { send(201, store.createProject((await body(request)).name)); return; }
      }
      const match = /^\/api\/v1\/projects\/([^/]+)\/inputs(?:\/([^/]+))?$/.exec(url.pathname);
      if (match) {
        const [, projectId, inputId] = match;
        if (request.method === 'GET' && !inputId) { send(200, store.listInputs(projectId)); return; }
        if (request.method === 'POST' && !inputId) { send(201, store.saveInput(projectId, await body(request))); return; }
        if (request.method === 'PUT' && inputId) {
          const input = await body(request); send(200, store.updateInput(projectId, inputId, z.number().int().parse(input.revision), input.body)); return;
        }
      }
      throw new DomainError('NOT_FOUND');
    } catch (error) {
      if (!response.headersSent) send(error instanceof DomainError ? (statuses[error.code] ?? 400) : error instanceof z.ZodError?400:500,
        { code: error instanceof DomainError ? error.code : error instanceof z.ZodError?'INVALID_INPUT':'INTERNAL_ERROR', requestId });
      else response.end();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) { store.close(); throw error; }
  const address=server.address();if(!address||typeof address==='string')throw Error('LISTEN_FAILED');
  authority = `127.0.0.1:${address.port}`; origin = `http://${authority}`;
  return { origin, launchUrl: `${origin}/#${bootstrap}`, store, agentTools,
    close: async () => { stopping=true;agentTools.close(); await execution.close();await Promise.allSettled([...importRecoveries.values()]);return new Promise<void>((resolve, reject) => server.close(error => { store.close(); error ? reject(error) : resolve(); })); } };
}
