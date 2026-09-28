interface Item {
  id: string;
  name: string;
  layer?: string;
  type?: string;
}
export type SelectMode = 'replace' | 'add' | 'remove';

const typeLabels: Record<string, string> = {
  Brep: '솔리드·서피스',
  Extrusion: '돌출',
  Mesh: '메시',
  Curve: '커브',
  PolylineCurve: '폴리라인',
  LineCurve: '선',
  NurbsCurve: '커브',
  ArcCurve: '호·원',
  PolyCurve: '복합 커브',
  Point: '점',
  PointCloud: '점군',
  SubD: 'SubD',
  InstanceReference: '블록',
  box: '박스',
  polyline: '폴리라인',
  extrude: '돌출',
};
export const typeLabel = (type: string) =>
  typeLabels[type] ? `${typeLabels[type]} · ${type}` : type;
const ROW_LIMIT = 400;

/**
 * Layer → type tree. Rows are created only when a group opens so large Rhino documents stay
 * responsive; selection state is applied to live rows without rebuilding the tree.
 */
export function createObjectList(
  container: HTMLElement,
  select: (ids: string[], mode: SelectMode) => void,
) {
  const rows = new Map<string, HTMLButtonElement>();
  const open = new Set<string>();
  let signature = '';
  let selected = new Set<string>();
  let filter = '';
  let current: readonly Item[] = [];
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'object-search';
  search.placeholder = '객체·레이어 검색';
  search.setAttribute('aria-label', '객체 검색');
  const summary = document.createElement('small');
  summary.className = 'object-summary';
  const tree = document.createElement('div');
  tree.className = 'object-groups';
  container.replaceChildren(search, summary, tree);
  const modeOf = (e: MouseEvent): SelectMode =>
    e.ctrlKey || e.metaKey ? 'remove' : e.shiftKey ? 'add' : 'replace';
  function row(item: Item) {
    const button = document.createElement('button');
    button.className = 'object';
    button.textContent = item.name;
    button.title = item.name;
    button.setAttribute('aria-pressed', String(selected.has(item.id)));
    button.onclick = (e) => select([item.id], modeOf(e));
    rows.set(item.id, button);
    return button;
  }
  function group(
    key: string,
    label: string,
    items: Item[],
    fill: (body: HTMLElement) => void,
    depth: number,
  ) {
    const details = document.createElement('details');
    details.className = 'object-group';
    details.dataset.depth = String(depth);
    const head = document.createElement('summary');
    const name = document.createElement('span');
    name.textContent = label;
    name.title = label;
    const count = document.createElement('em');
    count.textContent = items.length.toLocaleString();
    const pick = document.createElement('button');
    pick.className = 'group-select';
    pick.textContent = '선택';
    pick.title = '이 그룹 전체 선택 · Shift 추가 · Ctrl 제외';
    pick.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      select(
        items.map((item) => item.id),
        modeOf(e),
      );
    };
    head.append(name, count, pick);
    const body = document.createElement('div');
    details.append(head, body);
    let filled = false;
    const ensure = () => {
      if (filled || !details.open) return;
      filled = true;
      fill(body);
    };
    details.ontoggle = () => {
      if (details.open) open.add(key);
      else open.delete(key);
      ensure();
    };
    if (open.has(key) || filter || current.length <= 150) {
      details.open = true;
      ensure();
    }
    return details;
  }
  function build() {
    rows.clear();
    const query = filter.toLowerCase();
    const items = query
      ? current.filter(
          (item) =>
            item.name.toLowerCase().includes(query) ||
            (item.layer ?? '').toLowerCase().includes(query),
        )
      : current;
    const layers = new Map<string, Item[]>();
    for (const item of items) {
      const layer = item.layer || '레이어 없음';
      const list = layers.get(layer) ?? [];
      list.push(item);
      layers.set(layer, list);
    }
    summary.textContent = current.length
      ? `${items.length.toLocaleString()}개 객체 · ${layers.size.toLocaleString()}개 레이어`
      : '모델을 가져오면 레이어별로 표시됩니다.';
    const fragment = document.createDocumentFragment();
    for (const [layer, list] of [...layers].sort(([a], [b]) => a.localeCompare(b))) {
      fragment.append(
        group(
          'L:' + layer,
          layer,
          list,
          (body) => {
            const types = new Map<string, Item[]>();
            for (const item of list) {
              const type = item.type || '기타';
              const bucket = types.get(type) ?? [];
              bucket.push(item);
              types.set(type, bucket);
            }
            for (const [type, bucket] of [...types].sort((a, b) => b[1].length - a[1].length))
              body.append(
                group(
                  'T:' + layer + '/' + type,
                  typeLabel(type),
                  bucket,
                  (inner) => {
                    for (const item of bucket.slice(0, ROW_LIMIT)) inner.append(row(item));
                    if (bucket.length > ROW_LIMIT) {
                      const more = document.createElement('small');
                      more.textContent = `외 ${(bucket.length - ROW_LIMIT).toLocaleString()}개 · 검색으로 좁히거나 그룹 선택을 사용하세요.`;
                      inner.append(more);
                    }
                  },
                  1,
                ),
              );
          },
          0,
        ),
      );
    }
    tree.replaceChildren(fragment);
  }
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  search.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      filter = search.value.trim();
      build();
    }, 150);
  };
  return (items: readonly Item[], nextSelection: readonly string[]) => {
    const next =
      items.length +
      ':' +
      (items[0]?.id ?? '') +
      ':' +
      (items.at(-1)?.id ?? '') +
      ':' +
      items.reduce(
        (hash, item) => (hash * 31 + item.name.length + (item.layer?.length ?? 0)) | 0,
        7,
      );
    const changed = next !== signature;
    if (changed) {
      signature = next;
      current = items;
      selected = new Set(nextSelection);
      build();
      return;
    }
    const target = new Set(nextSelection);
    for (const id of selected)
      if (!target.has(id)) rows.get(id)?.setAttribute('aria-pressed', 'false');
    for (const id of target) rows.get(id)?.setAttribute('aria-pressed', 'true');
    selected = target;
  };
}
