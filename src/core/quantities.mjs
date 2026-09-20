import {DomainError} from './store.mjs';
const known=value=>Number.isFinite(value)&&value>=0?value:null;
function lengthOf(line){
 if(!Array.isArray(line)||line.length<6||line.length%3||line.some(n=>!Number.isFinite(n)))return null;
 let length=0;for(let i=3;i<line.length;i+=3)length+=Math.hypot(line[i]-line[i-3],line[i+1]-line[i-2],line[i+2]-line[i-1]);return length;
}
export function quantities(request){
 if(!request.result?.hostExecuted||!Array.isArray(request.result.scene))throw new DomainError('NOT_FOUND');
 const rows=request.result.objects.map(object=>{
  const native=request.result.scene.find(s=>s.id===object.id);
  return {id:object.id,name:object.name,type:native?.nativeType||object.kind||'미상',length:lengthOf(native?.line),area:known(native?.area),volume:known(native?.volume)};
 });
 const totals={count:rows.length};
 for(const metric of ['length','area','volume'])totals[metric]={value:rows.reduce((sum,r)=>sum+(r[metric]??0),0),known:rows.filter(r=>r[metric]!==null).length,unknown:rows.filter(r=>r[metric]===null).length};
 return {basis:request.id,host:request.result.host||'rhino',createdAt:request.createdAt,scope:'candidate',source:'저장·재열기한 호스트 형상',units:{length:'m',area:'m²',volume:'m³'},rows,totals};
}
function cell(value){
 let text=value===null?'미상':String(value??'');
 if(/^[\s]*[=+@-]/.test(text))text="'"+text;
 return '"'+text.replaceAll('"','""')+'"';
}
export function quantitiesCsv(table){
 const header=['기준 후보','호스트','객체 ID','이름','유형','길이 (m)','기하 면적 (m²)','체적 (m³)','출처'];
 return '\ufeff'+[header,...table.rows.map(r=>[table.basis,table.host,r.id,r.name,r.type,r.length,r.area,r.volume,table.source])].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
