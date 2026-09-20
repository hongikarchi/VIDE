export function sceneRepresentation(object){
 if(object.vertices?.length&&object.indices?.length)return {type:'mesh',positions:object.vertices};
 if(object.line?.length)return {type:'line',positions:object.line};
 if(object.nativeType==='Point'&&Array.isArray(object.origin)&&object.origin.length===3&&object.origin.every(Number.isFinite))return {type:'point',positions:object.origin};
 return null;
}
