import {randomUUID,createHash} from 'node:crypto';
import {DomainError} from './store.mjs';
import {quantities} from './quantities.mjs';
export function validatePreview(image){
 if(typeof image!=='string'||image.length>1000000||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)||Buffer.from(image.split(',')[1],'base64').subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new DomainError('INVALID_INPUT');
}
export class Reviews{
 constructor(store){this.store=store;store.db.exec('CREATE TABLE IF NOT EXISTS review_snapshots(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),requestId TEXT NOT NULL,title TEXT NOT NULL,createdAt TEXT NOT NULL,payload TEXT NOT NULL)');}
 list(projectId){this.store.project(projectId);return this.store.db.prepare('SELECT id,requestId,title,createdAt FROM review_snapshots WHERE projectId=? ORDER BY rowid DESC').all(projectId);}
 get(projectId,id){this.store.project(projectId);const row=this.store.db.prepare('SELECT * FROM review_snapshots WHERE projectId=? AND id=?').get(projectId,id);if(!row)throw new DomainError('NOT_FOUND');return {...row,payload:JSON.parse(row.payload)};}
 create(projectId,input,request){
  const project=this.store.project(projectId);if(!input||typeof input.title!=='string'||!input.title.trim()||input.title.length>100||request.projectId!==projectId)throw new DomainError('INVALID_INPUT');validatePreview(input.image);
  if(this.list(projectId).length>=200)throw new DomainError('REVIEW_LIMIT');
  const table=quantities(request,input.query),id=randomUUID(),createdAt=new Date().toISOString(),title=input.title.trim();
  const result=request.result;
  const model=result.objects.map(({nativeId,...object})=>{const {nativeId:ignored,...geometry}=result.scene.find(item=>item.id===object.id)||{};return {id:object.id,name:object.name,geometryHash:createHash('sha256').update(JSON.stringify({object,geometry})).digest('hex')};});
  const frozen={id:request.id,createdAt:request.createdAt,input:{body:request.input.body,pins:request.input.pins,sketches:request.input.sketches,files:request.input.files.map(file=>({name:file.name,type:file.type}))},result:{hostExecuted:true,displayUnsupported:result.scene.filter(object=>!object.vertices?.length&&!object.line?.length).map(object=>object.nativeType||'미상'),verified:result.verified,host:result.host,text:result.text,objects:result.objects.map(({id,name,kind})=>({id,name,kind})),scene:result.scene.map(({id,nativeId,nativeType,area,volume})=>({id,nativeId,nativeType,area,volume}))},applications:(request.applications||[]).map(application=>({id:application.id,state:application.state,result:{applied:application.result?.applied,saved:application.result?.saved,code:application.result?.code}}))};
  const payload=JSON.stringify({project:{name:project.name},request:frozen,image:input.image,table,model,sourceDocument:result.sourceDocument,title,createdAt});
  if(Buffer.byteLength(payload)>2000000)throw new DomainError('INPUT_TOO_LARGE');
  this.store.db.prepare('INSERT INTO review_snapshots VALUES(?,?,?,?,?,?)').run(id,projectId,request.id,title,createdAt,payload);
  return {id,requestId:request.id,title,createdAt};
 }
}
