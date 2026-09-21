import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
type Point = [number, number];
export function validCoordinate(value: unknown): value is number {
  return typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=100000;
}
interface CoordinateProps {value:number;label:string;commit:(value:number)=>void;onError:(message:string)=>void}
function Coordinate({value,label,commit,onError}:CoordinateProps){
 const [text,setText]=useState(String(value));
 useEffect(()=>setText(String(value)),[value]);
 return <input type="number" step="any" aria-label={label} value={text}
  onChange={event=>setText(event.target.value)} onBlur={event=>{
   const next=event.target.valueAsNumber;
   if(!validCoordinate(next)){setText(String(value));onError('좌표는 ±100,000 m 이내의 숫자여야 합니다.');return;}
   if(next!==value)commit(next);
  }} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}}} />;
}
function Points({points,onChange,onError}:{points:Point[];onChange:()=>void;onError:(message:string)=>void}){
 return <>{points.map((point,index)=><div className="coordinate-row" key={index}>
  <span>{index+1}</span>{point.map((value,axis)=><Coordinate key={axis} value={value} label={`점 ${index+1} ${axis===0?'U':'V'}`}
   onError={onError} commit={next=>{point[axis]=next;onChange();}} />)}
  <button aria-label={`점 ${index+1} 삭제`} onClick={()=>{points.splice(index,1);onChange();}}>×</button>
 </div>)}</>;
}
let root:Root|undefined;
export function renderPoints(points:Point[],onChange:()=>void,onError:(message:string)=>void):void{
 if(!root){const element=document.getElementById('sketch-points');if(!element)throw new Error('Sketch points mount is missing');root=createRoot(element);}
 root.render(<Points points={points} onChange={onChange} onError={onError} />);
}
window.addEventListener('pagehide',event=>{if(!event.persisted){root?.unmount();root=undefined;}});
