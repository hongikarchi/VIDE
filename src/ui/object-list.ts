import { iconSvg } from './inspector.ts';

interface Item {
  id: string;
  name: string;
  /** Grouping key; with several files it is `file › layer`. */
  layer?: string;
  /** The layer's own name and its file, when several files are shown together. */
  layerName?: string;
  documentName?: string;
  /** The host's layer colour (#rrggbb), when the Sync sent one. */
  layerColor?: string;
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
const shortType = (type: string) => typeLabels[type] ?? type;
/** A host layer colour (#rrggbb) for the swatch; anything else keeps the neutral token. */
const swatchColor = (value?: string) => (value && /^#[0-9a-f]{6}$/i.test(value) ? value : '');

/**
 * Layer list (user decision 2026-10-01, the mockup's left slot): one row per layer with its colour,
 * name and count; a row opens its objects. With several files the layers sit under each file's name.
 * Object rows are created only when a layer opens so large Rhino documents stay responsive;
 * selection state is applied to live rows without rebuilding the list.
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
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const head = document.createElement('div');
  head.className = 'layer-list-head';
  const summary = document.createElement('small');
  summary.className = 'object-summary';
  const searchToggle = document.createElement('button');
  searchToggle.type = 'button';
  searchToggle.className = 'layer-search-toggle';
  searchToggle.title = '객체·레이어 검색';
  searchToggle.setAttribute('aria-label', '레이어 검색');
  searchToggle.setAttribute('aria-expanded', 'false');
  searchToggle.innerHTML = iconSvg('search');
  head.append(summary, searchToggle);
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'object-search';
  search.placeholder = '객체·레이어 검색';
  search.setAttribute('aria-label', '객체 검색');
  search.hidden = true;
  const tree = document.createElement('div');
  tree.className = 'object-groups';
  container.replaceChildren(head, search, tree);
  // The search field opens from the icon; closing it clears the filter so nothing stays hidden.
  const showSearch = (show: boolean) => {
    search.hidden = !show;
    searchToggle.setAttribute('aria-expanded', String(show));
    if (show) search.focus();
    else if (search.value) {
      search.value = '';
      clearTimeout(searchTimer);
      filter = '';
      build();
    }
  };
  searchToggle.onclick = () => showSearch(search.hidden === true);
  search.onkeydown = (e) => {
    if (e.key !== 'Escape') return;
    showSearch(false);
    searchToggle.focus();
  };
  const modeOf = (e: MouseEvent): SelectMode =>
    e.ctrlKey || e.metaKey ? 'remove' : e.shiftKey ? 'add' : 'replace';
  function row(item: Item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'object';
    const name = document.createElement('span');
    name.className = 'object-name';
    name.textContent = item.name;
    button.append(name);
    if (item.type) {
      const type = document.createElement('span');
      type.className = 'object-type';
      type.textContent = shortType(item.type);
      button.append(type);
    }
    button.title = item.type ? `${item.name} · ${typeLabel(item.type)}` : item.name;
    button.setAttribute('aria-label', item.name);
    button.setAttribute('aria-pressed', String(selected.has(item.id)));
    button.onclick = (e) => select([item.id], modeOf(e));
    rows.set(item.id, button);
    return button;
  }
  function layer(key: string, label: string, items: Item[]) {
    const wrap = document.createElement('div');
    wrap.className = 'layer';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'layer-row';
    toggle.title = label + ' · 눌러서 객체 보기';
    const swatch = document.createElement('span');
    swatch.className = 'sw';
    const color = swatchColor(items.find((item) => item.layerColor)?.layerColor);
    if (color) swatch.style.background = color;
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = label;
    const count = document.createElement('span');
    count.className = 'layer-count';
    count.textContent = items.length.toLocaleString();
    toggle.append(swatch, name, count);
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'group-select';
    pick.textContent = '선택';
    pick.title = '이 레이어 전체 선택 · Shift 추가 · Ctrl 제외';
    pick.setAttribute('aria-label', label + ' 전체 선택');
    pick.onclick = (e) => {
      e.stopPropagation();
      select(
        items.map((item) => item.id),
        modeOf(e),
      );
    };
    const body = document.createElement('div');
    body.className = 'layer-objects';
    wrap.append(toggle, pick, body);
    let filled = false;
    const show = (expanded: boolean) => {
      toggle.setAttribute('aria-expanded', String(expanded));
      body.hidden = !expanded;
      if (!expanded || filled) return;
      filled = true;
      for (const item of items.slice(0, ROW_LIMIT)) body.append(row(item));
      if (items.length > ROW_LIMIT) {
        const more = document.createElement('small');
        more.textContent = `외 ${(items.length - ROW_LIMIT).toLocaleString()}개 · 검색으로 좁히거나 레이어 선택을 사용하세요.`;
        body.append(more);
      }
    };
    toggle.onclick = () => {
      const next = toggle.getAttribute('aria-expanded') !== 'true';
      if (next) open.add(key);
      else open.delete(key);
      show(next);
    };
    show(open.has(key) || Boolean(filter));
    return wrap;
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
    searchToggle.hidden = !current.length;
    // Several files: each file's name heads its layers (the layer key starts with the file name).
    const byFile = new Set(items.map((item) => item.documentName ?? '')).size > 1;
    const fragment = document.createDocumentFragment();
    let file: string | undefined;
    for (const [key, list] of [...layers].sort(([a], [b]) => a.localeCompare(b))) {
      const first = list[0];
      if (byFile && first.documentName !== file) {
        file = first.documentName;
        const heading = document.createElement('div');
        heading.className = 'layer-file';
        heading.textContent = file || '파일 없음';
        heading.title = file || '';
        fragment.append(heading);
      }
      const label = byFile ? first.layerName || '레이어 없음' : key;
      fragment.append(layer('L:' + key, label, list));
    }
    tree.replaceChildren(fragment);
  }
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
