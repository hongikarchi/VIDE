export interface DisplayGeometry {vertices?:number[];indices?:number[];line?:number[];nativeType?:string;origin?:number[]}
type Representation={type:'mesh';positions:number[];indices:number[]}|{type:'line'|'point';positions:number[]};
export function sceneRepresentation(object:DisplayGeometry):Representation|null{
 if(object.vertices?.length&&object.indices?.length)return {type:'mesh',positions:object.vertices,indices:object.indices};
 if(object.line?.length)return {type:'line',positions:object.line};
 if(object.nativeType==='Point'&&Array.isArray(object.origin)&&object.origin.length===3&&object.origin.every(Number.isFinite))return {type:'point',positions:object.origin};
 return null;
}
