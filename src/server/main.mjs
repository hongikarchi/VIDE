import { resolve, join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { startServer } from './server.mjs';

const directory = resolve(process.env.VIDE_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'VIDE'));
await mkdir(directory, { recursive: true });
const app = await startServer({ filename: join(directory, 'vide.sqlite'), port: Number(process.env.VIDE_PORT || 0) });
await writeFile(join(directory, 'launch.json'), JSON.stringify({ url: app.launchUrl }), { encoding: 'utf8', mode: 0o600 });
console.log(`VIDE local workspace: ${app.launchUrl}`);
if(process.argv.includes('--open')){
  const browser=spawn('rundll32.exe',['url.dll,FileProtocolHandler',app.launchUrl],{windowsHide:true,detached:true,stdio:'ignore'});
  browser.on('error',()=>console.error('브라우저를 자동으로 열지 못했습니다. 위 실행 링크를 열어 주세요.'));
  browser.unref();
}
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
process.on('SIGINT', close); process.on('SIGTERM', close);
