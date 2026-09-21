import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

type Row = readonly [string, string | number | undefined];
interface Link { label: string; disabled: boolean; open: () => void }
interface Attributes { entries: {key: string; value: string}[]; complete: boolean; attach?: () => void }
export interface InspectorContentProps {
  empty?: boolean;
  rows?: Row[];
  links?: Link[];
  quantities?: () => void;
  attributes?: Attributes;
}
function PropertyGrid({ rows }: {rows: Row[]}) {
  return <div className="property-grid">{rows.map(([label, value], index) =>
    <div className="property" key={`${label}:${index}`}><small>{label}</small><strong>{value}</strong></div>)}</div>;
}
export function InspectorContent({empty, rows, links, quantities, attributes}: InspectorContentProps) {
  if (empty) return <>객체를 선택하세요.</>;
  if (links) return <>
    <small>이 객체가 포함된 작업의 기준과 입력</small>
    {links.length ? links.map((link,index) => <p key={index}><button disabled={link.disabled} onClick={link.open}>{link.label}</button></p>)
      : <p>연결된 이전 후보나 객체 입력이 없습니다.</p>}
  </>;
  return <>
    <PropertyGrid rows={rows ?? []} />
    {quantities ? <button onClick={quantities}>이 객체 수량표</button> : null}
    {attributes ? <>
      <p>Rhino 사용자 속성 · 취득 기준</p>
      <PropertyGrid rows={attributes.entries.map(entry=>[entry.key,entry.value])} />
      {!attributes.complete ? <p>일부 속성만 읽었습니다.</p> : null}
      {attributes.entries.length ? <button onClick={attributes.attach}>표시 속성을 요청에 첨부</button> : null}
    </> : null}
  </>;
}
const roots = new Map<HTMLElement, Root>();
export function renderInspectorContent(element: HTMLElement, props: InspectorContentProps): void {
  let root = roots.get(element);
  if (!root) { root = createRoot(element); roots.set(element,root); }
  root.render(<InspectorContent {...props} />);
}
export function disposeInspectorContent(element: HTMLElement): void {
  roots.get(element)?.unmount(); roots.delete(element);
}
window.addEventListener('pagehide',event=>{
  if (!event.persisted) { for (const element of roots.keys()) disposeInspectorContent(element); }
});
