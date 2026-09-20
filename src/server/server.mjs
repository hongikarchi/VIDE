import {ReviewNotes} from '../core/review-notes.mjs';
import {compareReviews} from '../core/review-comparison.mjs';
import {Reviews} from '../core/reviews.mjs';
import {TableViews} from '../core/table-views.mjs';
import {Applications} from './application.mjs';
import {listDocuments,inspectDocument} from '../../hosts/rhino/documents.mjs';
import {compareCandidates,relatedCandidates} from '../core/comparison.mjs';
import {quantities,quantitiesCsv} from '../core/quantities.mjs';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Store, DomainError } from '../core/store.mjs';
import { Workspace } from '../core/workspace.mjs';
import { Execution } from './execution.mjs';
import { RhinoWorkspace } from '../../hosts/rhino/workspace.mjs';
import { ZwcadWorkspace } from '../../hosts/zwcad/workspace.mjs';
import { dirname, join } from 'node:path';
import { importModel,captureModel } from './import-model.mjs';
import { renderReport } from './report.mjs';

const assets = new Map([
  ['/', ['../ui/index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['../ui/app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['../ui/style.css', 'text/css; charset=utf-8']],
  ...['model','viewport','gateway','inspector','requests','sketch','quantities','quantity-view','documents','application','history','reviews','review-comparison','review-notes'].map(name => [`/${name}.mjs`, [`../ui/${name}.mjs`, 'text/javascript; charset=utf-8']]),
  ['/vendor/three.module.js', ['../../node_modules/three/build/three.module.js', 'text/javascript']],
  ['/vendor/three.core.js', ['../../node_modules/three/build/three.core.js', 'text/javascript']],
  ['/vendor/OrbitControls.js', ['../../node_modules/three/examples/jsm/controls/OrbitControls.js', 'text/javascript']],
]);
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new DomainError('JSON_REQUIRED');
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length; if (size > 1024 * 1024) throw new DomainError('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw 0; return parsed; }
  catch { throw new DomainError('INVALID_INPUT'); }
}
const statuses = { NOT_FOUND: 404, FORBIDDEN: 403, UNAUTHORIZED: 401, JSON_REQUIRED: 415, INPUT_TOO_LARGE: 413,
  REVISION_CONFLICT: 409, TARGET_MISMATCH: 409, CONTROLLER_BUSY: 409, PROJECT_BUSY:409, STALE_REFERENCE:409 };
export async function startServer({ filename, port = 0, providerFactory, host, applicationOptions } = {}) {
  const store = new Store(filename), bootstrap = randomBytes(32).toString('hex'), session = randomBytes(32).toString('hex');
  const workspace = new Workspace(store),tableViews=new TableViews(store),reviews=new Reviews(store),reviewNotes=new ReviewNotes(store,reviews);
  host ??= new RhinoWorkspace(join(dirname(filename),'models'));
  const hosts={rhino:host,zwcad:new ZwcadWorkspace(join(dirname(filename),'cad-models'))};
  const applications=new Applications(store,workspace,applicationOptions);
  const execution = new Execution(workspace, { providerFactory, host, hosts });
  const withApplications=request=>({...request,applications:store.db.prepare("SELECT id,state,result FROM commands WHERE projectId=? AND kind='applyCandidate' AND json_extract(payload,'$.requestId')=? ORDER BY rowid").all(request.projectId,request.id).map(row=>({...row,result:row.result?JSON.parse(row.result):null}))});
  let origin, authority;
  const server = createServer(async (request, response) => {
    const requestId = randomBytes(8).toString('hex');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
    try {
      if (request.headers.host !== authority) throw new DomainError('FORBIDDEN');
      if (request.headers.origin && request.headers.origin !== origin) throw new DomainError('FORBIDDEN');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new DomainError('FORBIDDEN');
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [file, contentType] = assets.get(url.pathname);
        let content = await readFile(new URL(file, import.meta.url));
        if (url.pathname === '/vendor/OrbitControls.js') content = content.toString().replace(/from 'three'/g, "from '/vendor/three.module.js'");
        response.writeHead(200, { 'Content-Type': contentType }); response.end(content); return;
      }
      if (!url.pathname.startsWith('/api/v1/')) throw new DomainError('NOT_FOUND');
      if (!['GET', 'POST', 'PUT'].includes(request.method)) { send(405, { code: 'METHOD_NOT_ALLOWED', requestId }); return; }
      if (request.method !== 'GET' && request.headers.origin !== origin) throw new DomainError('FORBIDDEN');
      if (url.pathname === '/api/v1/session' && request.method === 'POST') {
        const input = await body(request);
        if (!equal(input.token, bootstrap)) throw new DomainError('UNAUTHORIZED');
        response.setHeader('Set-Cookie', `vide_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
        send(200, { authenticated: true }); return;
      }
      const cookie = request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('vide_session='))?.slice(13);
      if (!equal(cookie, session)) throw new DomainError('UNAUTHORIZED');
      const upload=/^\/api\/v1\/projects\/([^/]+)\/import$/.exec(url.pathname);
      if(upload&&request.method==='POST'){send(200,await importModel(request,upload[1],url.searchParams.get('name'),workspace,host));return;}
      const capture=/^\/api\/v1\/projects\/([^/]+)\/capture$/.exec(url.pathname);
      if(capture&&request.method==='POST'){send(200,await captureModel(capture[1],await body(request),workspace,host));return;}
      const reviewComparison=/^\/api\/v1\/projects\/([^/]+)\/review-comparison$/.exec(url.pathname);
      if(reviewComparison&&request.method==='GET'){
        const projectId=reviewComparison[1],before=reviews.get(projectId,url.searchParams.get('before')),after=reviews.get(projectId,url.searchParams.get('after'));
        let related=false;try{related=relatedCandidates(workspace,projectId,workspace.get(projectId,before.requestId),workspace.get(projectId,after.requestId));}catch(error){if(error.code!=='NOT_FOUND')throw error;}
        send(200,compareReviews(before,after,related));return;
      }
      const note=/^\/api\/v1\/projects\/([^/]+)\/reviews\/([^/]+)\/notes$/.exec(url.pathname);
      if(note){
        if(request.method==='GET'){send(200,reviewNotes.list(note[1],note[2]));return;}
        if(request.method==='POST'){send(201,reviewNotes.create(note[1],note[2],await body(request)));return;}
      }
      const review=/^\/api\/v1\/projects\/([^/]+)\/reviews(?:\/([^/]+)(\/(?:preview|download))?)?$/.exec(url.pathname);
      if(review){
        if(request.method==='POST'&&!review[2]){const input=await body(request);send(201,reviews.create(review[1],input,withApplications(workspace.get(review[1],input.requestId))));return;}
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
      if (url.pathname === '/api/v1/providers' && request.method === 'GET') {
        send(200, await execution.status()); return;
      }
      if (url.pathname === '/api/v1/host' && request.method === 'GET') { send(200,await host.status()); return; }
      if (url.pathname === '/api/v1/models' && request.method === 'GET') { send(200,await execution.models()); return; }
      if(url.pathname==='/api/v1/host/documents'&&request.method==='GET'){send(200,await listDocuments());return;}
      if(url.pathname==='/api/v1/host/selection'&&request.method==='GET'){send(200,await inspectDocument(url.searchParams.get('instance')||'',Number(url.searchParams.get('document'))));return;}
      const application=/^\/api\/v1\/projects\/([^/]+)\/applications(?:\/([^/]+)(\/reconcile)?)?$/.exec(url.pathname);
      if(application){
        if(request.method==='POST'&&application[3]){send(200,await applications.recover(application[1],application[2]));return;}
        if(request.method==='POST'&&!application[2]){const input=await body(request);send(201,await applications.prepare(application[1],input.requestId,{instance:input.instance,documentId:input.documentId}));return;}
        if(request.method==='POST'&&application[2]){send(200,await applications.confirm(application[1],application[2]));return;}
        if(request.method==='GET'&&application[2]){send(200,store.getCommand(application[1],application[2]));return;}
      }
      const comparison=/^\/api\/v1\/projects\/([^/]+)\/comparison$/.exec(url.pathname);
      if(comparison&&request.method==='GET'){
        const projectId=comparison[1],before=workspace.get(projectId,url.searchParams.get('before')),after=workspace.get(projectId,url.searchParams.get('after'));
        send(200,compareCandidates(before,after,relatedCandidates(workspace,projectId,before,after)));return;
      }
      const view=/^\/api\/v1\/projects\/([^/]+)\/table-views(?:\/([^/]+)(\/delete)?)?$/.exec(url.pathname);
      if(view){
        if(request.method==='GET'&&!view[2]){send(200,tableViews.list(view[1]));return;}
        if(request.method==='POST'&&view[3]){send(200,tableViews.remove(view[1],view[2],(await body(request)).revision));return;}
        if(request.method==='POST'&&!view[2]){send(201,tableViews.save(view[1],await body(request)));return;}
        if(request.method==='PUT'&&view[2]){send(200,tableViews.save(view[1],await body(request),view[2]));return;}
      }
      const table=/^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/(quantities|quantities.csv)$/.exec(url.pathname);
      if(table&&request.method==='GET'){
        const data=quantities(workspace.get(table[1],table[2]),Object.fromEntries(url.searchParams));
        if(table[3]==='quantities'){send(200,data);return;}
        response.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="VIDE-quantities.csv"'});response.end(quantitiesCsv(data));return;
      }
      const artifact=/^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/(model|open)$/.exec(url.pathname);
      if(artifact&&((request.method==='GET'&&artifact[3]==='model')||(request.method==='POST'&&artifact[3]==='open'))){
        const saved=workspace.get(artifact[1],artifact[2]);
        if(!saved.result?.hostExecuted||!saved.result.filename)throw new DomainError('NOT_FOUND');
        if(artifact[3]==='open'){send(200,await hosts[saved.result.host||'rhino'].open(saved.result.filename));return;}
        const content=await readFile(saved.result.filename);
        response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="VIDE-candidate.${saved.result.host==='zwcad'?'dwg':'3dm'}"`});response.end(content);return;
      }
      const job = /^\/api\/v1\/projects\/([^/]+)\/requests(?:\/([^/]+)(\/cancel)?)?$/.exec(url.pathname);
      if (job) {
        const [, projectId, id, cancel] = job;
        if (request.method === 'GET') { send(200, id ? withApplications(workspace.get(projectId,id)) : workspace.list(projectId).map(withApplications)); return; }
        if (request.method === 'POST' && cancel) { send(200, execution.cancel(projectId,id)); return; }
        if (request.method === 'POST' && !id) {
          const result = workspace.submit(projectId, await body(request));
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
          const input = await body(request); send(200, store.updateInput(projectId, inputId, input.revision, input.body)); return;
        }
      }
      throw new DomainError('NOT_FOUND');
    } catch (error) {
      if (!response.headersSent) send(error instanceof DomainError ? (statuses[error.code] ?? 400) : 500,
        { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR', requestId });
      else response.end();
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) { store.close(); throw error; }
  authority = `127.0.0.1:${server.address().port}`; origin = `http://${authority}`;
  return { origin, launchUrl: `${origin}/#${bootstrap}`, store,
    close: async () => { await execution.close(); return new Promise((resolve, reject) => server.close(error => { store.close(); error ? reject(error) : resolve(); })); } };
}
