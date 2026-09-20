import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const files = new Map([['/',['index.html','text/html']],['/app.mjs',['app.mjs','text/javascript']],['/model.mjs',['model.mjs','text/javascript']],['/style.css',['style.css','text/css']]]);
files.set('/viewport.mjs',['viewport.mjs','text/javascript']);
files.set('/vendor/three.module.js',['node_modules/three/build/three.module.js','text/javascript']);
files.set('/vendor/three.core.js',['node_modules/three/build/three.core.js','text/javascript']);
files.set('/vendor/OrbitControls.js',['node_modules/three/examples/jsm/controls/OrbitControls.js','text/javascript']);
const port=Number(process.env.VIDE_PREVIEW_PORT||4317);
createServer(async(req,res)=>{
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
  const origin=`http://127.0.0.1:${port}`;
  if(req.headers.host!==`127.0.0.1:${port}`||(req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site'){res.writeHead(403);res.end();return;}
  const file=files.get(req.url?.split('?')[0]);if(req.method!=='GET'||!file){res.writeHead(404);res.end();return;}
  try{res.writeHead(200,{'Content-Type':`${file[1]}; charset=utf-8`});let content=await readFile(new URL(file[0],import.meta.url));if(file[0].endsWith('/OrbitControls.js'))content=content.toString().replace(/from 'three'/g,"from '/vendor/three.module.js'");res.end(content);}catch{res.end();}
}).listen(port,'127.0.0.1',()=>console.log(`VIDE review: http://127.0.0.1:${port}`));
