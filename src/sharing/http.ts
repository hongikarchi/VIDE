export class HttpError extends Error {
  constructor(public status:number,public code:string){super(code);}
}
export const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function body(request:Request):Promise<Record<string,unknown>>{
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new HttpError(415,'JSON_REQUIRED');
  if(Number(request.headers.get('Content-Length'))>16384)throw new HttpError(413,'INPUT_TOO_LARGE');
  if(!request.body)throw new HttpError(400,'INPUT_REQUIRED');
  const reader=request.body.getReader();let length=0;const chunks:Uint8Array[]=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>16384){await reader.cancel();throw new HttpError(413,'INPUT_TOO_LARGE');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{const parsed:unknown=JSON.parse(new TextDecoder().decode(bytes));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();return parsed as Record<string,unknown>;}
  catch{throw new HttpError(400,'INVALID_JSON');}
}
export function text(value:unknown,max=200):string{
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new HttpError(400,'INVALID_INPUT');
  return value.trim();
}
export function role(value:unknown):'viewer'|'commenter'{
  if(value!=='viewer'&&value!=='commenter')throw new HttpError(400,'INVALID_ROLE');return value;
}
export async function digest(value:string):Promise<string>{
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
}
