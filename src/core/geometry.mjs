import { DomainError } from './store.ts';
const fail=()=>{throw new DomainError('INVALID_GEOMETRY');};
const scalar=n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=100000;
const vector=p=>Array.isArray(p)&&p.length===3&&p.every(scalar);
export const geometryContract=`Return ONLY a JSON object {"message": "Korean explanation", "operations": [...]}. Do not output code.
Available operations, all coordinates/dimensions in meters:
{"kind":"box","id":"unique-id","name":"name","origin":[x,y,z],"size":[width,depth,height]}
{"kind":"polyline","id":"unique-id","name":"name","points":[[x,y,z],...]} (repeat first point to close)
{"kind":"extrude","id":"unique-id","name":"name","points":[[x,y,z],...],"height":number} (closed planar XY boundary)
{"kind":"move","id":"existing-id","delta":[x,y,z]}
{"kind":"height","id":"existing-box-or-extrusion-id","height":number}
{"kind":"vertices","id":"existing-polyline-or-extrusion-id","points":[[x,y,z],...]} (replaces boundary points; extrusion must remain closed planar XY)
{"kind":"copy","id":"new-id","sourceId":"existing-id","name":"copy name","delta":[x,y,z]} (box/polyline/extrusion or independent native geometry; repeat explicit copies up to the operation limit)
{"kind":"remove","id":"existing-id"}
Existing kind=native objects came from a user-selected 3dm. Their origin is the bounding box minimum. They support move/remove and copying independent geometry; native copies remain native, with no parametric height/vertices editing. Copying grouped, locked, referenced or history-linked native objects is unsupported; never reconstruct them as boxes or claim to know their topology. Their original geometry and attributes must be retained.
Read-only requests: operations=[] and grounded answer. Missing required dimensions: operations=[] and ask a specific question. Never invent requested dimensions. Sketch points use plane XY/XZ/YZ, origin 0 and meters. Object pins identify targets. Existing geometry is supplied as context. Preserve unmentioned geometry. Only describe proposed changes; execution is verified separately by VIDE.`;

export function interpret(text,existing=[],permission='review') {
  let proposal;try{proposal=JSON.parse(text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{fail();}
  if(!proposal||typeof proposal.message!=='string'||proposal.message.length>20000||!Array.isArray(proposal.operations)||proposal.operations.length>100)fail();
  if(permission==='review'&&proposal.operations.length)throw new DomainError('WRITE_NOT_ALLOWED');
  const objects=structuredClone(existing);
  for(const op of proposal.operations){
    if(!op||typeof op.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(op.id))fail();
    const index=objects.findIndex(o=>o.id===op.id),obj=objects[index];
    if(['box','polyline','extrude'].includes(op.kind)){
      if(obj||typeof op.name!=='string'||!op.name.trim()||op.name.length>200)fail();
      if(op.kind==='box'&&(!vector(op.origin)||!vector(op.size)||op.size.some(n=>n<=0)))fail();
      if(op.kind!=='box'){
        if(!Array.isArray(op.points)||op.points.length<2||op.points.length>1000||!op.points.every(vector))fail();
        if(op.kind==='extrude'&&(op.points.length<4||!scalar(op.height)||op.height<=0||JSON.stringify(op.points[0])!==JSON.stringify(op.points.at(-1))||op.points.some(p=>Math.abs(p[2]-op.points[0][2])>1e-6)))fail();
      }
      objects.push(op.kind==='box'?{kind:op.kind,id:op.id,name:op.name,origin:op.origin,size:op.size}:
        {kind:op.kind,id:op.id,name:op.name,points:op.points,...(op.kind==='extrude'?{height:op.height}:{})});
    }else if(op.kind==='move'){
      if(!obj||!vector(op.delta))fail();
      if(obj.origin)obj.origin=obj.origin.map((n,i)=>n+op.delta[i]);
      else obj.points=obj.points.map(p=>p.map((n,i)=>n+op.delta[i]));
      if(obj.origin?!vector(obj.origin):!obj.points.every(vector))fail();
    }else if(op.kind==='height'){
      if(!obj||!['box','extrude'].includes(obj.kind)||!scalar(op.height)||op.height<=0)fail();
      if(obj.kind==='box')obj.size[2]=op.height;else obj.height=op.height;
    }else if(op.kind==='vertices'){
      if(!obj||!['polyline','extrude'].includes(obj.kind))fail();
      const replacement=interpret(JSON.stringify({message:'validate',operations:[{...obj,points:op.points}]}),[],'candidate').objects[0];
      obj.points=replacement.points;
    }else if(op.kind==='copy'){
      const source=objects.find(o=>o.id===op.sourceId);
      if(obj||!source||!['box','polyline','extrude','native'].includes(source.kind)||!vector(op.delta)||typeof op.name!=='string'||!op.name.trim()||op.name.length>200)fail();
      const copy=structuredClone(source);copy.id=op.id;copy.name=op.name;
      if(source.kind==='native'){
        if(typeof source.nativeId!=='string')fail();
        copy.nativeSourceId=existing.some(item=>item.id===source.id)?source.id:source.nativeSourceId;
        if(typeof copy.nativeSourceId!=='string')fail();
      }
      if(copy.origin){copy.origin=copy.origin.map((n,i)=>n+op.delta[i]);if(!vector(copy.origin))fail();}
      else {copy.points=copy.points.map(p=>p.map((n,i)=>n+op.delta[i]));if(!copy.points.every(vector))fail();}
      objects.push(copy);
    }else if(op.kind==='remove'){
      if(!obj)fail();objects.splice(index,1);
    }else fail();
  }
  if(objects.length>500)fail();
  return {message:proposal.message,objects,changed:proposal.operations.length>0};
}

/** Enforce explicit preserved/reference geometry before crossing the host boundary. */
export function protectGeometry(before,after,ids){
 for(const id of new Set(ids)){
  const original=before.find(object=>object.id===id),next=after.find(object=>object.id===id);
  if(!original||!next||JSON.stringify(original)!==JSON.stringify(next))throw new DomainError('PROTECTED_OBJECT_CHANGED');
 }
}
