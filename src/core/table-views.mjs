import {randomUUID} from 'node:crypto';
import {DomainError} from './store.mjs';
import {quantityQuery} from './quantities.mjs';
const decode=row=>({...row,query:JSON.parse(row.query)});
export class TableViews{
 constructor(store){this.store=store;store.db.exec(`CREATE TABLE IF NOT EXISTS table_views(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,query TEXT NOT NULL,revision INTEGER NOT NULL,updatedAt TEXT NOT NULL)`);}
 list(projectId){this.store.project(projectId);return this.store.db.prepare('SELECT * FROM table_views WHERE projectId=? ORDER BY name,id').all(projectId).map(decode);}
 save(projectId,input,id){
  this.store.project(projectId);
  if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>80)throw new DomainError('INVALID_INPUT');
  const query=JSON.stringify(quantityQuery(input.query)),name=input.name.trim(),updatedAt=new Date().toISOString();
  if(id){
   const previous=this.store.db.prepare('SELECT * FROM table_views WHERE projectId=? AND id=?').get(projectId,id);if(!previous)throw new DomainError('NOT_FOUND');
   if(input.revision!==previous.revision)throw new DomainError('REVISION_CONFLICT');
   this.store.db.prepare('UPDATE table_views SET name=?,query=?,revision=revision+1,updatedAt=? WHERE projectId=? AND id=?').run(name,query,updatedAt,projectId,id);
  }else{
   if(this.list(projectId).length>=200)throw new DomainError('TABLE_VIEW_LIMIT');id=randomUUID();this.store.db.prepare('INSERT INTO table_views VALUES(?,?,?,?,1,?)').run(id,projectId,name,query,updatedAt);
  }
  return decode(this.store.db.prepare('SELECT * FROM table_views WHERE projectId=? AND id=?').get(projectId,id));
 }
 remove(projectId,id,revision){
  this.store.project(projectId);const row=this.store.db.prepare('SELECT revision FROM table_views WHERE projectId=? AND id=?').get(projectId,id);if(!row)throw new DomainError('NOT_FOUND');if(row.revision!==revision)throw new DomainError('REVISION_CONFLICT');
  this.store.db.prepare('DELETE FROM table_views WHERE projectId=? AND id=?').run(projectId,id);return {deleted:true};
 }
}
