import {z} from 'zod';
import {tableViewSchema} from '../contracts/quantities.ts';
import type {Store} from './store.mjs';
import type {TableView} from '../contracts/quantities.ts';
import {randomUUID} from 'node:crypto';
import {DomainError} from './store.mjs';
import {quantityQuery} from './quantities.ts';
const storedRow=z.object({query:z.string()}).passthrough();
const inputSchema=z.object({name:z.string().max(80).refine(value=>Boolean(value.trim())),query:z.unknown().optional(),revision:z.unknown().optional()}).passthrough();
const decode=(row:unknown):TableView=>{const value=storedRow.parse(row);return tableViewSchema.parse({...value,query:JSON.parse(value.query)});};
export class TableViews{
 private readonly store:Store;
 constructor(store:Store){this.store=store;store.db.exec(`CREATE TABLE IF NOT EXISTS table_views(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,query TEXT NOT NULL,revision INTEGER NOT NULL,updatedAt TEXT NOT NULL)`);}
 list(projectId:string):TableView[]{this.store.project(projectId);return this.store.db.prepare('SELECT * FROM table_views WHERE projectId=? ORDER BY name,id').all(projectId).map(decode);}
 save(projectId:string,value:unknown,id?:string):TableView{
  this.store.project(projectId);
  const parsed=inputSchema.safeParse(value);if(!parsed.success)throw new DomainError('INVALID_INPUT');const input=parsed.data;
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
 remove(projectId:string,id:string,revision:unknown){
  this.store.project(projectId);const row=this.store.db.prepare('SELECT revision FROM table_views WHERE projectId=? AND id=?').get(projectId,id);if(!row)throw new DomainError('NOT_FOUND');if(row.revision!==revision)throw new DomainError('REVISION_CONFLICT');
  this.store.db.prepare('DELETE FROM table_views WHERE projectId=? AND id=?').run(projectId,id);return {deleted:true};
 }
}
