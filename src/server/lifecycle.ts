import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {z} from 'zod';
export async function liveLaunch(directory:string){
 try{
  const {url}=z.object({url:z.string()}).parse(JSON.parse(await readFile(join(directory,'launch.json'),'utf8'))),target=new URL(url);
  if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.port||target.username||target.password||target.pathname!=='/'||target.search||!/^#[a-f0-9]{64}$/.test(target.hash))return null;
  const response=await fetch(new URL('/api/v1/session',target),{method:'POST',redirect:'error',headers:{Origin:target.origin,'Content-Type':'application/json'},body:JSON.stringify({token:target.hash.slice(1)}),signal:AbortSignal.timeout(5000)});
  return response.ok&&z.object({authenticated:z.literal(true)}).safeParse(await response.json()).success?url:null;
 }catch{return null;}
}
