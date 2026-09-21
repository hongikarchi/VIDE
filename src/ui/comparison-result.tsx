import type { Comparison } from '../contracts/comparison.ts';
const metrics=[['length','길이','m'],['area','기하 면적','m²'],['volume','체적','m³']] as const;
export function ComparisonResult({result,review=false}:{result:Comparison;review?:boolean}){
 const labels={added:'추가',removed:'삭제',changed:review?'표시·속성 변경':'변경',unchanged:review?'표시·속성 동일':'동일',incomparable:'비교 불가'};
 return <>{result.reason?<p>{result.reason}</p>:null}{result.rows.map(row=><p key={row.id}>
  {labels[row.status]} · {row.name}{metrics.map(([key,label,unit])=>{const delta=row.delta[key];return delta!==null&&delta!==0?<small key={key}> · {label} {delta>0?'+':''}{delta.toLocaleString('ko-KR',{maximumFractionDigits:3})} {unit}</small>:null;})}
 </p>)}</>;
}
