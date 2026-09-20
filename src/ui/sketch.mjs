const limit=100000;
export function validCoordinate(value){return typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=limit;}
export function renderPoints(points,onChange,onError){
 const root=document.getElementById('sketch-points');root.replaceChildren();
 points.forEach((point,index)=>{
  const row=document.createElement('div');row.className='coordinate-row';
  const label=document.createElement('span');label.textContent=String(index+1);row.append(label);
  point.forEach((value,axis)=>{
   const field=document.createElement('input');field.type='number';field.step='any';field.value=String(value);
   field.setAttribute('aria-label',`점 ${index+1} ${axis===0?'U':'V'}`);
   field.onchange=()=>{const next=field.valueAsNumber;if(!validCoordinate(next)){field.value=String(value);onError('좌표는 ±100,000 m 이내의 숫자여야 합니다.');return;}point[axis]=next;onChange();};row.append(field);
  });
  const remove=document.createElement('button');remove.textContent='×';remove.setAttribute('aria-label',`점 ${index+1} 삭제`);remove.onclick=()=>{points.splice(index,1);onChange();};row.append(remove);root.append(row);
 });
}
