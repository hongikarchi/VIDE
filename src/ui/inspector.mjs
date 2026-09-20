const $ = id => document.getElementById(id);
let expanded=false;
function showInspector(open){
  $('inspector').classList.toggle('collapsed',!open);
  $('inspector-toggle').setAttribute('aria-expanded',String(open));
  $('inspector-toggle').textContent=open?'⌄':'⌃';
}
const paths = {
  layers:'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  history:'<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2"/>',
  file:'<path d="M14 3H5v18h14V8l-5-5Zm0 0v6h5M8 13h8m-8 4h5"/>',
  cursor:'<path d="m5 3 14 10-7 1-3 7L5 3Z"/>',
  pin:'<path d="m9 3 6 0-1 6 4 4H6l4-4-1-6Zm3 10v8"/>',
  pencil:'<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
  cube:'<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Zm0 10v10M3 7l9 5 9-5M12 2v10"/>',
};
export function initializeInspector(onTab) {
  for (const node of document.querySelectorAll('[data-icon]')) {
    node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[node.dataset.icon]}</svg>`;
  }
  for (const button of document.querySelectorAll('[data-inspect]')) button.onclick=()=>{
    document.querySelectorAll('[data-inspect]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
    onTab(button.dataset.inspect);
  };
  const handle=$('inspector-resize');
  const resize=height=>{
    const max=Math.max(120,Math.min(480,document.querySelector('.workspace').clientHeight-160));
    height=Math.min(max,Math.max(120,height));
    $('inspector').style.setProperty('--inspector-height',height+'px');
    handle.setAttribute('aria-valuemax',String(max));handle.setAttribute('aria-valuenow',String(Math.round(height)));
  };
  let drag;
  handle.onpointerdown=e=>{if(e.button!==0)return;drag={y:e.clientY,height:$('inspector').clientHeight};handle.setPointerCapture(e.pointerId);e.preventDefault();};
  handle.onpointermove=e=>{if(drag)resize(drag.height+drag.y-e.clientY);};
  handle.onpointerup=handle.onpointercancel=()=>{drag=null;};
  handle.onkeydown=e=>{if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();resize(e.key==='Home'?120:e.key==='End'?480:$('inspector').clientHeight+(e.key==='ArrowUp'?20:-20));}};
  $('inspector-toggle').onclick=()=>{
    expanded=!expanded;showInspector(expanded);
  };
}
export function renderInspector(object, result, request, tab='properties') {
  showInspector(Boolean(object)&&expanded);
  $('inspector-toggle').disabled=!object;
  $('selection').textContent=object?.name||'선택 없음';
  $('selection-kind').textContent=object?`${result?.host==='zwcad'?'ZWCAD':'Rhino'} · 작업 사본`:'';
  const content=$('inspector-content');content.replaceChildren();
  if(!object){content.textContent='객체를 선택하세요.';return;}
  const native=result?.scene?.find(item=>item.id===object.id);
  const number=(value,unit='')=>Number.isFinite(value)?`${value.toLocaleString('ko-KR',{maximumFractionDigits:3})}${unit}`:'—';
  const vector=value=>Array.isArray(value)?value.map(v=>number(v)).join(', ')+' m':'—';
  let properties;
  if(tab==='geometry') {
    const positions=native?.vertices?.length?native.vertices:native?.line;
    const size=positions?.length?Array.from({length:3},(_,axis)=>{
      let min=Infinity,max=-Infinity;for(let i=axis;i<positions.length;i+=3){min=Math.min(min,positions[i]);max=Math.max(max,positions[i]);}return max-min;
    }):null;
    properties=[['폭 X',number(size?.[0],' m')],['깊이 Y',number(size?.[1],' m')],['높이 Z',number(size?.[2],' m')],['기하 면적',number(native?.area,' m²')],['체적',number(native?.volume,' m³')],['원점',vector(object.origin)]];
  } else if(tab==='history') {
    properties=[['생성 요청',request?.input?.body||'파일 가져오기'],['처리 상태',request?.state||'—'],['결과 시각',request?.createdAt?new Date(request.createdAt).toLocaleString('ko-KR'):'—'],['기준 후보',object.revision||'—']];
  } else {
    properties=[['객체 이름',object.name],['형상',native?.nativeType||object.kind||object.type||'—'],['호스트',result?.host==='zwcad'?'ZWCAD':'Rhino'],['네이티브 ID',native?.nativeId||object.nativeId||'—'],['단위','m'],['상태','저장된 후보']];
  }
  const grid=document.createElement('div');grid.className='property-grid';content.append(grid);
  for(const [label,value] of properties){const item=document.createElement('div');item.className='property';const key=document.createElement('small');key.textContent=label;const text=document.createElement('strong');text.textContent=value;item.append(key,text);grid.append(item);}
}
