// The object inspector's content (PLAN-26 T-113, region B): buildInspectorView() turns the picked
// object, its result and the tab into what the panel shows; shell/inspector.tsx draws it from the
// viewer slice. renderInspector() draws the same content into a given element (test fixtures).
import { renderInspectorContent } from './inspector-content.tsx';
import type { InspectorContentProps } from './inspector-content.tsx';
import { nativeAttributes } from './native-attributes.ts';
import { iconSvg } from './icons.ts';

// Re-exported: the inspector module was the icon set's home before PLAN-26 T-113.
export { iconSvg };
export type InspectorTab = 'properties' | 'geometry' | 'relations' | 'history';
export interface InspectorView {
  /** The #selection title: the object's name or '선택 없음'. */
  title: string;
  /** The #selection-kind line. */
  kind: string;
  /** Changes with the object and the tab; the content scrolls back to the top when it does. */
  key: string;
  content: InspectorContentProps;
}
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
/** What the inspector shows for the picked object (none: '선택 없음') on a tab. */
export function buildInspectorView(
  object: InspectorObject | undefined | null,
  result: InspectorResult | undefined | null,
  request: InspectorRequest | undefined,
  tab: InspectorTab = 'properties',
  references: References = {},
): InspectorView {
  const view = (content: InspectorContentProps): InspectorView => ({
    title: object?.name || '선택 없음',
    kind: object ? `${result?.host === 'zwcad' ? 'ZWCAD' : 'Rhino'} · 작업 사본` : '',
    key: `${object?.id || ''}:${tab}`,
    content,
  });
  if (!object) return view({ empty: true });
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
    return view({
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
  if (
    (tab === 'properties' || tab === 'geometry') &&
    native?.nativeType &&
    native.nativeType !== 'Point' &&
    !native.vertices?.length &&
    !native.line?.length
  )
    properties.push(['화면 표현', '미지원 · 목록·네이티브 파일에 보존']);
  const attributes = tab === 'properties' ? nativeAttributes(native) : null;
  return view({
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
/**
 * Draws the inspector content into `content` (its own root): the test fixtures' path. The work
 * screen's inspector is drawn by shell/inspector.tsx from the viewer slice instead.
 */
export function renderInspector(
  object: InspectorObject | undefined | null,
  result: InspectorResult | undefined | null,
  request: InspectorRequest | undefined,
  tab: InspectorTab = 'properties',
  references: References = {},
  content: HTMLElement,
) {
  const view = buildInspectorView(object, result, request, tab, references);
  if (inspected.get(content) !== view.key) {
    content.scrollTop = 0;
    inspected.set(content, view.key);
  }
  renderInspectorContent(content, view.content);
}
const inspected = new WeakMap<HTMLElement, string>();
