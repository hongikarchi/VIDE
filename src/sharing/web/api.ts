import {z} from 'zod';
export async function api(path:string,method='GET',data?:unknown):Promise<unknown>{
  const response=await fetch('/api'+path,{method,credentials:'same-origin',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  const value:unknown=await response.json();
  if(!response.ok){const parsed=z.object({error:z.string().optional(),message:z.string().optional()}).safeParse(value);throw new Error(parsed.success?(parsed.data.message||parsed.data.error||'요청 실패'):'요청 실패');}
  return value;
}
export const sessionSchema=z.object({user:z.object({id:z.string(),name:z.string(),email:z.string()})}).nullable();
export type Session=NonNullable<z.infer<typeof sessionSchema>>;
export const projectsSchema=z.object({projects:z.array(z.object({id:z.string(),name:z.string(),role:z.enum(['owner','viewer','commenter'])}))});
export type Project=z.infer<typeof projectsSchema>['projects'][number];
const coordinate=z.number().finite();
const geometry=z.discriminatedUnion('type',[
  z.object({type:z.literal('mesh'),positions:z.array(coordinate),indices:z.array(z.number().int().nonnegative())}).strict(),
  z.object({type:z.enum(['line','point']),positions:z.array(coordinate)}).strict(),
]).superRefine((value,ctx)=>{if(!value.positions.length||value.positions.length%3||value.type==='mesh'&&(value.indices.length%3||value.indices.some(i=>i>=value.positions.length/3)))ctx.addIssue({code:'custom',message:'잘못된 형상'});});
export const sceneSchema=z.object({format:z.literal('vide-public-scene-v1'),unit:z.literal('m'),objects:z.array(z.object({id:z.string(),name:z.string().optional(),geometry,measurements:z.object({length:coordinate.optional(),area:coordinate.optional(),volume:coordinate.optional()}).strict().optional()}).strict()).max(5000)}).strict();
export type Scene=z.infer<typeof sceneSchema>;
export const publicationSchema=z.object({id:z.string(),state:z.literal('published'),publishedAt:z.number(),manifest:z.object({title:z.string(),objectIds:z.array(z.string()),assets:z.array(z.object({id:z.string(),parts:z.array(z.object({sha256:z.string().regex(/^[0-9a-f]{64}$/),size:z.number().int().positive().max(8*1024*1024)}))}))})});
export type Publication=z.infer<typeof publicationSchema>;
export async function loadScene(projectId:string,publication:Publication,signal:AbortSignal):Promise<Scene>{
  const asset=publication.manifest.assets.find(asset=>asset.id==='scene');if(!asset)throw new Error('표시할 모델이 없습니다.');
  const size=asset.parts.reduce((sum,p)=>sum+p.size,0);if(size>64*1024*1024)throw new Error('현재 웹 뷰어는 64 MiB 이하 모델을 표시합니다.');
  const buffer=new Uint8Array(size);let offset=0;
  for(let i=0;i<asset.parts.length;i++){
    const part=asset.parts[i],response=await fetch(`/api/projects/${projectId}/publications/${publication.id}/assets/scene/${i}`,{signal,credentials:'same-origin'});
    if(!response.ok)throw new Error('모델 접근 권한 또는 게시 상태를 확인해 주세요.');
    const bytes=await response.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    if(bytes.byteLength!==part.size||hash!==part.sha256)throw new Error('게시 모델의 무결성을 확인하지 못했습니다.');
    buffer.set(new Uint8Array(bytes),offset);offset+=bytes.byteLength;
  }
  const scene=sceneSchema.parse(JSON.parse(new TextDecoder().decode(buffer)));
  const ids=scene.objects.map(object=>object.id);
  if(new Set(ids).size!==ids.length||ids.length!==publication.manifest.objectIds.length||ids.some(id=>!publication.manifest.objectIds.includes(id)))throw new Error('모델과 게시 대상이 일치하지 않습니다.');
  return scene;
}
export const message=(error:unknown)=>error instanceof Error?error.message:'처리하지 못했습니다.';
