import {readFile} from 'node:fs/promises';import {join} from 'node:path';
export async function liveLaunch(directory){
 try{
  const {url}=JSON.parse(await readFile(join(directory,'launch.json'),'utf8')),target=new URL(url);
  if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.port||target.username||target.password||target.pathname!=='/'||target.search||!/^#[a-f0-9]{64}$/.test(target.hash))return null;
  const response=await fetch(new URL('/api/v1/session',target),{method:'POST',redirect:'error',headers:{Origin:target.origin,'Content-Type':'application/json'},body:JSON.stringify({token:target.hash.slice(1)}),signal:AbortSignal.timeout(5000)});
  return response.ok&&(await response.json()).authenticated===true?url:null;
 }catch{return null;}
}
