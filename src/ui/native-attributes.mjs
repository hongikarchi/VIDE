export function nativeAttributes(scene){
 const decode=value=>new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value),char=>char.charCodeAt(0)));
 const pairs=scene?.attributes64;
 if(!Array.isArray(pairs))return {known:false,complete:false,entries:[]};
 try{
  if(pairs.length>32)throw Error();
  const entries=pairs.map(pair=>{if(!Array.isArray(pair)||pair.length!==2||pair.some(value=>typeof value!=='string'||value.length>12000))throw Error();return {key:decode(pair[0]),value:decode(pair[1])};});
  return {known:true,complete:scene.attributesComplete===true,entries};
 }catch{return {known:false,complete:false,entries:[]};}
}

export function attachNativeAttributes(state,request,object){
 const attributes=nativeAttributes(request?.result?.scene?.find(item=>item.id===object?.id));
 if(!attributes.known||!attributes.entries.length)throw Error('첨부할 원본 사용자 속성이 없습니다.');
 const name=`Attributes-${request.id}-${object.id}.json`;
 if(state.files.some(file=>file.name===name))throw Error('이미 첨부한 속성입니다.');
 if(state.files.length>=100)throw Error('첨부 자료는 100개까지입니다.');
 const text=JSON.stringify({source:'Rhino ObjectAttributes user text',basis:request.id,objectId:object.id,objectName:object.name,complete:attributes.complete,attributes:attributes.entries});
 if(text.length>50000)throw Error('속성 첨부가 너무 큽니다.');
 state.files.push({name,displayName:'속성 · '+object.name,type:'native-attributes',text});
}
