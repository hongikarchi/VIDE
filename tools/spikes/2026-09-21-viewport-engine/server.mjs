import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('.',import.meta.url));
const server=http.createServer(async(req,res)=>{
  try {
    if(req.method!=='GET'||req.headers.host!=='127.0.0.1:4317')throw Error('rejected');
    const url=new URL(req.url,'http://127.0.0.1:4317');
    let file=url.pathname==='/reference.json'?path.resolve('.vide/viewport-spike/reference.json'):path.resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
    if(url.pathname!=='/reference.json'&&!file.startsWith(root))throw Error('path');
    const body=await readFile(file);
    if(url.pathname.startsWith('/dist/'))res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/javascript','Cache-Control':'no-store'});res.end(body);
  }catch {res.writeHead(404);res.end('not found');}
});
server.listen(4317,'127.0.0.1',()=>console.log('Viewport experiment http://127.0.0.1:4317'));
