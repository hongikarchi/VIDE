import {DomainError} from '../core/store.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>Number.isFinite(value)?value.toFixed(3):'—';

export function renderReport(project,request,image){
  if(!request.result?.hostExecuted)throw new DomainError('NOT_FOUND');
  if(typeof image!=='string'||image.length>1000000||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image))throw new DomainError('INVALID_INPUT');
  if(Buffer.from(image.split(',')[1],'base64').subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new DomainError('INVALID_INPUT');
  const rows=request.result.scene.map(o=>`<tr><td>${escape(request.result.objects.find(x=>x.id===o.id)?.name||o.id)}</td><td>${number(o.area)}</td><td>${number(o.volume)}</td><td>${escape(o.nativeId)}</td></tr>`).join('');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(project.name)} · 검토본</title>
<style>body{max-width:1100px;margin:40px auto;padding:0 24px;font:15px/1.8 Arial,sans-serif;color:#28312c}h1{font-size:30px}p{white-space:pre-wrap}small{color:#657067}img{max-width:100%;border:1px solid #ddd}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;border-bottom:1px solid #ddd;padding:10px;overflow-wrap:anywhere}td:last-child{font-size:10px}@media print{body{margin:0}img{max-height:480px;object-fit:contain}}</style>
<h1>${escape(project.name)}</h1><small>VIDE 검토본 · ${escape(request.createdAt)} · 기준 ${escape(request.id)}</small>
<h2>작업 요청</h2><p>${escape(request.input.body)}</p><h2>검토 화면</h2><img src="${image}" alt="해당 후보의 3D 뷰포트"><h2>결과</h2><p>${escape(request.result.text)}</p>
<h2>호스트 측정값</h2><table><thead><tr><th>객체</th><th>기하 면적(m²)</th><th>체적(m³)</th><th>네이티브 객체 ID</th></tr></thead><tbody>${rows}</tbody></table>
<p>입체의 기하 면적은 표면적이며 건축면적·연면적을 뜻하지 않습니다. 닫힌 평면 곡선은 경계 면적입니다. —는 미측정입니다.</p>
<small>원본 사용자 문서 적용을 의미하지 않는 별도 작업 후보입니다. 네이티브 파일 저장·재열기 검증: ${request.result.verified?'통과':'미확인'}.</small></html>`;
}
