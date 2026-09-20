import {statSync} from 'node:fs';import {win32} from 'node:path';import {DomainError} from './store.mjs';
const providers=['claude-cli','codex-cli'];
export class AiSettings{
 constructor(store,checkFile=path=>statSync(path).isFile()){this.store=store;this.checkFile=checkFile;store.db.exec('CREATE TABLE IF NOT EXISTS ai_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, paths TEXT NOT NULL)');}
 get(){const row=this.store.db.prepare('SELECT revision,paths FROM ai_settings WHERE id=1').get();return row?{revision:row.revision,paths:JSON.parse(row.paths)}:{revision:0,paths:{'claude-cli':null,'codex-cli':null}};}
 save(input){
  if(!input||Object.keys(input).some(key=>!['revision','paths'].includes(key))||!Number.isSafeInteger(input.revision)||!input.paths||typeof input.paths!=='object'||Array.isArray(input.paths)||Object.keys(input.paths).length!==2||Object.keys(input.paths).some(key=>!providers.includes(key)))throw new DomainError('INVALID_INPUT');
  if(input.revision!==this.get().revision)throw new DomainError('REVISION_CONFLICT');
  const paths={};for(const provider of providers){const value=input.paths[provider];if(value===null||value===''){paths[provider]=null;continue;}
   if(typeof value!=='string'||value.length>1024||!(/^[A-Za-z]:[\\/]/.test(value))||win32.basename(value).toLowerCase()!==(provider==='claude-cli'?'claude.exe':'codex.exe'))throw new DomainError('INVALID_CLI_PATH');
   const path=win32.normalize(value);try{if(!this.checkFile(path))throw 0;}catch{throw new DomainError('CLI_FILE_MISSING');}paths[provider]=path;
  }
  this.store.db.prepare('INSERT INTO ai_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,paths=excluded.paths').run(input.revision+1,JSON.stringify(paths));return this.get();
 }
}
