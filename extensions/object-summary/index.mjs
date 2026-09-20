export function run({objects}){
 const groups=new Map();
 for(const object of objects){const key=JSON.stringify([object.type,object.layer]);if(!groups.has(key))groups.set(key,{type:object.type,layer:object.layer,objectIds:[]});groups.get(key).objectIds.push(object.id);}
 return {type:'object-summary',rows:[...groups.values()].map(row=>({...row,count:row.objectIds.length}))};
}
