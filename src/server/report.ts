import type {SourceRequest} from '../core/quantities.ts';
import type {QuantityTable} from '../contracts/quantities.ts';
import type {DisplayGeometry} from '../core/scene-representation.ts';
interface ReportRequest extends Omit<SourceRequest,'result'>{input:{body:string;pins?:{name?:string;role:string}[];sketches?:{name?:string;plane:string;role:string}[];files?:{name:string}[]};result?:NonNullable<SourceRequest['result']>&{displayUnsupported?:string[];verified?:boolean;text?:string;scene:(NonNullable<SourceRequest['result']>['scene'][number]&DisplayGeometry)[]};applications?:{state:string}[]}
import {sceneRepresentation} from '../core/scene-representation.ts';
import {validatePreview} from '../core/reviews.ts';
import {quantities} from '../core/quantities.ts';
import {DomainError} from '../core/store.ts';
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(3):'—';

export function renderReport(project:{name:string},request:ReportRequest,image:unknown,snapshot?:{table:QuantityTable;title?:string;createdAt?:string}){
  if(!request.result?.hostExecuted)throw new DomainError('NOT_FOUND');
  validatePreview(image);
  const table=snapshot?.table||quantities(request);
  const rows=table.rows.map(row=>`<tr><td>${escape(row.name)}</td><td>${escape(row.type)}</td><td>${escape(row.layer??'미상')}</td><td>${number(row.length)}</td><td>${number(row.area)}</td><td>${number(row.volume)}</td></tr>`).join('');
  const applied=(request.applications||[]).filter(item=>item.state==='succeeded').length,unknown=(request.applications||[]).filter(item=>item.state==='unknown').length;
  const state=unknown?`원본 적용 결과 미확인 ${unknown}건`:applied?`원본 반영 기록 ${applied}건 · 파일 저장은 별도`:'원본 반영 기록 없음 · 작업 사본';
  const context=(request.input.pins||[]).map(pin=>`${pin.name} (${{target:'변경',preserve:'유지',reference:'참고'}[pin.role]||pin.role})`).concat((request.input.sketches||[]).map(sketch=>`${sketch.name} · ${sketch.plane} · ${sketch.role}`),(request.input.files||[]).map(file=>file.name)).join(' · ');
  const unsupported=request.result.displayUnsupported??(snapshot?[]:request.result.scene.filter(object=>!sceneRepresentation(object)).map(object=>object.nativeType||'미상'));
  const filter=[table.query.search&&'검색: '+table.query.search,table.query.type&&'유형: '+table.query.type,table.query.layer&&'레이어: '+table.query.layer,table.query.groupBy!=='none'&&'그룹: '+({type:'유형별',layer:'레이어별'}[table.query.groupBy])].filter(Boolean).join(' · ')||'전체 객체';
  const groups=table.groups.map(group=>`<p>${escape(group.key)} · ${group.totals.count}개 · 기하 면적 ${group.totals.area.known?number(group.totals.area.value):'—'} m² (미상 ${group.totals.area.unknown}개 제외) · 체적 ${group.totals.volume.known?number(group.totals.volume.value):'—'} m³ (미상 ${group.totals.volume.unknown}개 제외)</p>`).join('');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(project.name)} · 검토본</title>
<style>body{max-width:1100px;margin:40px auto;padding:0 24px;font:15px/1.8 Arial,sans-serif;color:#28312c}h1{font-size:30px}p{white-space:pre-wrap}small{color:#657067}img{display:block;width:100%;max-height:420px;object-fit:contain;background:#edf0ec;border:1px solid #ddd}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;border-bottom:1px solid #ddd;padding:10px;overflow-wrap:anywhere}td:last-child{font-size:10px}@media print{body{margin:0}img{max-height:480px;object-fit:contain}}</style>
<h1>${escape(snapshot?.title||project.name)}</h1><small>${escape(project.name)} · VIDE 검토본 · ${escape(snapshot?.createdAt||request.createdAt)} · 기준 ${escape(request.id)}</small>
<h2>작업 요청</h2><p>${escape(request.input.body)}</p><p>${escape(context)}</p><h2>검토 화면</h2><img src="${image}" alt="해당 후보의 3D 뷰포트">${unsupported.length?`<small>3D 표시 미지원 ${unsupported.length}개 (${escape([...new Set(unsupported)].join(', '))}). 표와 파일의 객체 목록은 별도입니다.</small>`:''}<h2>결과</h2><p>${escape(request.result.text)}</p>
<h2>호스트 측정값</h2><p>${escape(filter)} · ${table.rows.length}개</p>${groups}<table><thead><tr><th>객체</th><th>유형</th><th>레이어</th><th>길이(m)</th><th>기하 면적(m²)</th><th>체적(m³)</th></tr></thead><tbody>${rows}</tbody></table>
<p>입체의 기하 면적은 표면적이며 건축면적·연면적을 뜻하지 않습니다. 닫힌 평면 곡선은 경계 면적입니다. —는 미측정입니다.</p>
<small>${escape(state)}. 네이티브 파일 저장·재열기 검증: ${request.result.verified?'통과':'미확인'}.</small></html>`;
}
