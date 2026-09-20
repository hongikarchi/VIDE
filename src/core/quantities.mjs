import {DomainError} from './store.mjs';
const known=value=>Number.isFinite(value)&&value>=0?value:null;
function lengthOf(line){
 if(!Array.isArray(line)||line.length<6||line.length%3||line.some(n=>!Number.isFinite(n)))return null;
 let length=0;for(let i=3;i<line.length;i+=3)length+=Math.hypot(line[i]-line[i-3],line[i+1]-line[i-2],line[i+2]-line[i-1]);return length;
}
export function quantities(request,rawQuery={}){
 const query=quantityQuery(rawQuery);
 if(!request.result?.hostExecuted||!Array.isArray(request.result.scene))throw new DomainError('NOT_FOUND');
 const rows=request.result.objects.map(object=>{
  const native=request.result.scene.find(s=>s.id===object.id);
  return {id:object.id,name:object.name,type:native?.nativeType||object.kind||'미상',layer:native?.layer64!==undefined?Buffer.from(native.layer64,'base64').toString('utf8'):null,length:known(native?.length)??(object.kind!=='native'?lengthOf(native?.line):null),area:known(native?.area),volume:known(native?.volume)};
 });
 const filtered=rows.filter(row=>(!query.search||row.name.toLocaleLowerCase().includes(query.search.toLocaleLowerCase()))&&(!query.type||row.type===query.type)&&(!query.layer||row.layer===query.layer));
 const groups=[];
 if(query.groupBy!=='none')for(const key of new Set(filtered.map(row=>row[query.groupBy]))){const members=filtered.filter(row=>row[query.groupBy]===key);groups.push({key:key??'미상',totals:summarize(members),ids:members.map(row=>row.id)});}
 return {basis:request.id,host:request.result.host||'rhino',createdAt:request.createdAt,scope:'candidate',source:'저장·재열기한 호스트 형상',units:{length:'m',area:'m²',volume:'m³'},query,available:{types:[...new Set(rows.map(row=>row.type))],layers:[...new Set(rows.map(row=>row.layer).filter(value=>value!==null))]},totalCount:rows.length,rows:filtered,groups,totals:summarize(filtered)};
}
function cell(value){
 let text=value===null?'미상':String(value??'');
 if(/^[\s]*[=+@-]/.test(text))text="'"+text;
 return '"'+text.replaceAll('"','""')+'"';
}
export function quantitiesCsv(table){
 const header=['기준 후보','호스트','객체 ID','이름','유형','레이어','길이 (m)','기하 면적 (m²)','체적 (m³)','출처','객체 수','길이 미상 수','면적 미상 수','체적 미상 수','행 구분','그룹 기준'];
 const rows=table.rows.map(row=>[table.basis,table.host,row.id,row.name,row.type,row.layer,row.length,row.area,row.volume,table.source,1,...['length','area','volume'].map(key=>row[key]===null?1:0),'객체',table.query.groupBy]);
 for(const group of table.groups){const metric=key=>group.totals[key].known?group.totals[key].value:null;rows.push([table.basis,table.host,'',group.key,table.query.groupBy==='type'?group.key:'',table.query.groupBy==='layer'?group.key:'',metric('length'),metric('area'),metric('volume'),table.source,group.totals.count,...['length','area','volume'].map(key=>group.totals[key].unknown),'그룹 합계',table.query.groupBy]);}
 return '\ufeff'+[header,...rows].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}

export function quantityQuery(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['search','type','layer','groupBy'].includes(key)))throw new DomainError('INVALID_INPUT');
 const query={search:value.search??'',type:value.type??'',layer:value.layer??'',groupBy:value.groupBy??'none'};
 if(['search','type','layer'].some(key=>typeof query[key]!=='string'||query[key].length>200)||!['none','type','layer'].includes(query.groupBy))throw new DomainError('INVALID_INPUT');return query;
}
function summarize(rows){
 const totals={count:rows.length};
 for(const metric of ['length','area','volume'])totals[metric]={value:rows.reduce((sum,row)=>sum+(row[metric]??0),0),known:rows.filter(row=>row[metric]!==null).length,unknown:rows.filter(row=>row[metric]===null).length};return totals;
}
