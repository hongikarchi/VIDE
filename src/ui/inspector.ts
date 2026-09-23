import { renderInspectorContent } from './inspector-content.tsx';
import type { InspectorContentProps } from './inspector-content.tsx';
import { nativeAttributes } from './native-attributes.ts';
type InspectorTab = 'properties' | 'geometry' | 'relations' | 'history';
interface InspectorObject {
  id: string;
  name: string;
  nativeSourceId?: string;
  origin?: number[];
  revision?: string;
  kind?: string;
  type?: string;
  nativeId?: string;
}
interface InspectorScene {
  id: string;
  vertices?: number[];
  line?: number[];
  boundsSize?: number[];
  length?: number | null;
  area?: number | null;
  volume?: number | null;
  layer64?: string;
  nativeType?: string;
  nativeId?: string;
  attributes64?: unknown;
  attributesComplete?: unknown;
}
interface InspectorResult {
  targetResults?: { requestId: string; candidate?: boolean }[];
  host?: string;
  hostExecuted?: boolean;
  baseRequestId?: string;
  scene?: InspectorScene[];
  objects?: InspectorObject[];
}
interface InspectorRequest {
  id: string;
  input?: {
    body?: string;
    parentRequestId?: string;
    baseRequestId?: string | null;
    pins?: { basis: string; id: string; role: string; name?: string }[];
  };
  result?: InspectorResult | null;
  state?: string;
  createdAt?: string;
}
interface References {
  get?: (id: string) => InspectorRequest | undefined;
  open?: (basis: string, id?: string) => void;
  quantities?: (request: InspectorRequest | undefined, object: InspectorObject) => void;
  attachAttributes?: (request: InspectorRequest | undefined, object: InspectorObject) => void;
}
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw Error('Missing inspector element: ' + id);
  return element as T;
}

let expanded = false;
const inspected = new WeakMap<HTMLElement, string>();
function showInspector(open: boolean) {
  $('inspector').classList.toggle('collapsed', !open);
  $('inspector-toggle').setAttribute('aria-expanded', String(open));
  $('inspector-toggle').textContent = open ? '⌄' : '⌃';
}
const paths: Record<string, string> = {
  extension: '<path d="M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm14 0v8m-4-4h8"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2"/>',
  file: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v6h5M8 13h8m-8 4h5"/>',
  cursor: '<path d="m5 3 14 10-7 1-3 7L5 3Z"/>',
  pin: '<path d="m9 3 6 0-1 6 4 4H6l4-4-1-6Zm3 10v8"/>',
  pencil: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
  cube: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Zm0 10v10M3 7l9 5 9-5M12 2v10"/>',
};
export function initializeInspector(onTab: (tab: InspectorTab) => void) {
  for (const node of document.querySelectorAll<HTMLElement>('[data-icon]')) {
    node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[node.dataset.icon ?? ''] ?? ''}</svg>`;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-inspect]'))
    button.onclick = () => {
      document
        .querySelectorAll<HTMLButtonElement>('[data-inspect]')
        .forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      const tab = button.dataset.inspect;
      if (tab && ['properties', 'geometry', 'relations', 'history'].includes(tab))
        onTab(tab as InspectorTab);
    };
  const handle = $('inspector-resize');
  const resize = (height: number) => {
    const max = Math.max(
      120,
      Math.min(480, (document.querySelector<HTMLElement>('.workspace')?.clientHeight ?? 640) - 160),
    );
    height = Math.min(max, Math.max(120, height));
    $('inspector').style.setProperty('--inspector-height', height + 'px');
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(Math.round(height)));
  };
  let drag: { y: number; height: number } | null = null;
  handle.onpointerdown = (e) => {
    if (e.button !== 0) return;
    drag = { y: e.clientY, height: $('inspector').clientHeight };
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  handle.onpointermove = (e) => {
    if (drag) resize(drag.height + drag.y - e.clientY);
  };
  handle.onpointerup = handle.onpointercancel = () => {
    drag = null;
  };
  handle.onkeydown = (e) => {
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      resize(
        e.key === 'Home'
          ? 120
          : e.key === 'End'
            ? 480
            : $('inspector').clientHeight + (e.key === 'ArrowUp' ? 20 : -20),
      );
    }
  };
  $('inspector-toggle').onclick = () => {
    expanded = !expanded;
    showInspector(expanded);
  };
}
export function renderInspector(
  object: InspectorObject | undefined | null,
  result: InspectorResult | undefined | null,
  request: InspectorRequest | undefined,
  tab: InspectorTab = 'properties',
  references: References = {},
  content = $('inspector-content'),
) {
  const key = `${object?.id || ''}:${tab}`;
  if (inspected.get(content) !== key) {
    content.scrollTop = 0;
    inspected.set(content, key);
  }
  showInspector(Boolean(object) && expanded);
  $<HTMLButtonElement>('inspector-toggle').disabled = !object;
  $('selection').textContent = object?.name || '선택 없음';
  $('selection-kind').textContent = object
    ? `${result?.host === 'zwcad' ? 'ZWCAD' : 'Rhino'} · 작업 사본`
    : '';
  if (!object) {
    renderInspectorContent(content, { empty: true });
    return;
  }
  if (tab === 'relations') {
    const links: { basis: string; id: string; label: string }[] = [];
    const basis = request?.input?.baseRequestId || result?.baseRequestId;
    if (basis) links.push({ basis, id: object.nativeSourceId || object.id, label: '이전 후보' });
    const parent =
      request?.input?.parentRequestId && references.get?.(request.input.parentRequestId);
    for (const sibling of (parent && parent.result?.targetResults) || []) {
      if (sibling.requestId !== request?.id && sibling.candidate)
        links.push({ basis: sibling.requestId, id: '', label: '같은 요청 후보' });
    }
    for (const pin of request?.input?.pins || [])
      links.push({
        basis: pin.basis,
        id: pin.id,
        label:
          ((
            { target: '변경 입력', preserve: '유지 입력', reference: '참고 입력' } as Record<
              string,
              string
            >
          )[pin.role] || '입력') +
          ' · ' +
          pin.name,
      });
    renderInspectorContent(content, {
      links: links.map((link) => {
        const source = references.get?.(link.basis),
          target = source?.result?.objects?.find((item) => item.id === link.id);
        return {
          label:
            link.label +
            (source?.result?.hostExecuted
              ? ' · ' + (source.result.host === 'zwcad' ? 'ZWCAD' : 'Rhino')
              : ' · 기준 확인 불가'),
          disabled: !source?.result?.hostExecuted,
          open: () => references.open?.(link.basis, target?.id),
        };
      }),
    });
    return;
  }
  const native = result?.scene?.find((item) => item.id === object.id);
  const number = (value: unknown, unit = '') =>
    typeof value === 'number' && Number.isFinite(value)
      ? `${value.toLocaleString('ko-KR', { maximumFractionDigits: 3 })}${unit}`
      : '—';
  const vector = (value: unknown) =>
    Array.isArray(value) ? value.map((v) => number(v)).join(', ') + ' m' : '—';
  let properties: InspectorContentProps['rows'];
  if (tab === 'geometry') {
    const positions = native?.vertices?.length ? native.vertices : native?.line;
    const bounds = native?.boundsSize;
    const measuredBounds =
      Array.isArray(bounds) && bounds.length === 3 && bounds.every(Number.isFinite);
    const size = measuredBounds
      ? bounds
      : positions?.length
        ? Array.from({ length: 3 }, (_, axis) => {
            let min = Infinity,
              max = -Infinity;
            for (let i = axis; i < positions.length; i += 3) {
              min = Math.min(min, positions[i]);
              max = Math.max(max, positions[i]);
            }
            return max - min;
          })
        : null;
    const prefix = measuredBounds ? '' : '표시 ';
    properties = [
      [prefix + '폭 X', number(size?.[0], ' m')],
      [prefix + '깊이 Y', number(size?.[1], ' m')],
      [prefix + '높이 Z', number(size?.[2], ' m')],
      ['곡선 길이', number(native?.length, ' m')],
      ['기하 면적', number(native?.area, ' m²')],
      ['체적', number(native?.volume, ' m³')],
      ['원점', vector(object.origin)],
    ];
  } else if (tab === 'history') {
    properties = [
      ['생성 요청', request?.input?.body || '파일 가져오기'],
      ['처리 상태', request?.state || '—'],
      ['결과 시각', request?.createdAt ? new Date(request.createdAt).toLocaleString('ko-KR') : '—'],
      ['기준 후보', object.revision || '—'],
    ];
  } else {
    let layer = '—';
    try {
      if (native?.layer64)
        layer = new TextDecoder().decode(
          Uint8Array.from(atob(native.layer64), (c) => c.charCodeAt(0)),
        );
    } catch {
      layer = '읽기 실패';
    }
    properties = [
      ['객체 이름', object.name],
      ['레이어', layer],
      ['형상', native?.nativeType || object.kind || object.type || '—'],
      ['호스트', result?.host === 'zwcad' ? 'ZWCAD' : 'Rhino'],
      ['네이티브 ID', native?.nativeId || object.nativeId || '—'],
      ['단위', 'm'],
      ['상태', '저장된 후보'],
    ];
  }
  const attributes = tab === 'properties' ? nativeAttributes(native) : null;
  renderInspectorContent(content, {
    rows: properties,
    quantities:
      tab === 'properties' && references.quantities
        ? () => references.quantities?.(request, object)
        : undefined,
    attributes:
      attributes?.known && (attributes.entries.length || !attributes.complete)
        ? {
            entries: attributes.entries,
            complete: attributes.complete,
            attach: () => references.attachAttributes?.(request, object),
          }
        : undefined,
  });
}
