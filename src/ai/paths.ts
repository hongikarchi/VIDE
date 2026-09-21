import {existsSync,readdirSync,statSync} from 'node:fs';import {join} from 'node:path';import {homedir} from 'node:os';
export function installedCodex(){
 const npm=join(homedir(),'AppData','Roaming','npm','node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');if(existsSync(npm))return npm;
 const directory=join(process.env.LOCALAPPDATA||join(homedir(),'AppData','Local'),'OpenAI','Codex','bin');
 try{return readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^[a-zA-Z0-9._-]+$/.test(entry.name)).slice(0,200).map(entry=>join(directory,entry.name,'codex.exe')).filter(existsSync).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs)[0];}catch{return undefined;}
}
