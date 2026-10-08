import { iconSvg } from './inspector.ts';
import {
  buildLayerTree,
  subtreeItems,
  type HostLayer,
  type LayerNode,
} from '../core/layer-tree.ts';

interface Item {
  id: string;
  name: string;
  /** Grouping key; with several files it is `file › layer`. */
  layer?: string;
  /** The layer's full path in its file (`Parent::Child`), when several files are shown together. */
  layerName?: string;
  documentName?: string;
  /** The file the row belongs to (one layer tree per file). */
  documentKey?: string;
  /** The host's layer colour (#rrggbb), when the Sync sent one. */
  layerColor?: string;
  /** The Sync's layer table (the same array for every row of a file): nesting, order, on/off. */
  layerTable?: readonly HostLayer[];
  /** The file's host: a ZWCAD/DWG list stays flat. */
  host?: string;
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

/** Remembered expand state per file and layer path (a viewer convenience: browser storage). */
const OPEN_KEY = 'vide.layer-open.v1';
type OpenState = Record<string, Record<string, boolean>>;
function readOpen(): OpenState {
  try {
    const value = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as unknown;
    return value && typeof value === 'object' ? (value as OpenState) : {};
  } catch {
    return {};
  }
}
function writeOpen(state: OpenState) {
  try {
    // Only the most recent files are kept so the entry stays small.
    const files = Object.keys(state);
    for (const file of files.slice(0, Math.max(0, files.length - 50))) delete state[file];
    localStorage.setItem(OPEN_KEY, JSON.stringify(state));
  } catch {
    /* Storage unavailable: the state lives for this page only. */
  }
}
const NO_LAYER = '레이어 없음';
/**
 * A layer row's number: what Rhino has in it and its sublayers. A layer that is off (itself or
 * under an off parent) counts the host's objects the Sync left out; a shown layer adds its own
 * listed objects and its sublayers' numbers, so the rows under a parent add up to the parent's.
 */
export function shownCount<T>(node: LayerNode<T>): number {
  if (node.hidden) return Math.max(node.hostTotal, node.total);
  return node.children.reduce((sum, child) => sum + shownCount(child), node.own.length);
}

interface Document {
  key: string;
  name?: string;
  items: Item[];
  table?: readonly HostLayer[];
  flat: boolean;
  host?: string;
}

/**
 * Layer list (user decision 2026-10-01, the mockup's left slot; tree since 2026-10-08): Rhino's
 * sublayers nest under their parents in Rhino's panel order, each row with its colour, name and the
 * count of its whole subtree; a row opens its sublayers, then its own objects. A layer that is off
 * (or under a parent that is off) shows greyed with the objects the Sync left out. ZWCAD/DWG layers
 * stay one flat list. With several files the layers sit under each file's name. Object rows are
 * created only when a layer opens so large Rhino documents stay responsive; selection state is
 * applied to live rows without rebuilding the list.
 */
export function createObjectList(
  container: HTMLElement,
  select: (ids: string[], mode: SelectMode) => void,
) {
  const rows = new Map<string, HTMLButtonElement>();
  const opened = readOpen();
  let signature = '';
  let tables: readonly unknown[] = [];
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
  // A tree for assistive tech (layer rows are tree items with their level); arrow keys move.
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', '레이어');
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
  const pathOf = (item: Item) => item.layerName ?? item.layer ?? undefined;
  function row(item: Item, depth: number) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'object';
    button.style.setProperty('--depth', String(depth));
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
    button.tabIndex = -1;
    button.onclick = (e) => select([item.id], modeOf(e));
    rows.set(item.id, button);
    return button;
  }
  function isOpen(file: string, node: LayerNode<Item>) {
    if (filter) return true;
    const remembered = opened[file]?.[node.fullPath];
    if (remembered !== undefined) return remembered;
    // Not toggled here yet: a parent follows Rhino's own Layers panel when the Sync says.
    return node.children.length > 0 && node.expanded === true;
  }
  function remember(file: string, path: string, value: boolean) {
    const state = (opened[file] ??= {});
    state[path] = value;
    // Move the file to the end (most recent).
    delete opened[file];
    opened[file] = state;
    writeOpen(opened);
  }
  function layer(file: string, node: LayerNode<Item>) {
    const wrap = document.createElement('div');
    wrap.className = 'layer';
    wrap.dataset.path = node.fullPath;
    wrap.setAttribute('role', 'treeitem');
    wrap.setAttribute('aria-level', String(node.depth + 1));
    wrap.setAttribute('aria-label', node.name);
    if (node.hidden) wrap.classList.add('layer-off');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'layer-row';
    toggle.tabIndex = -1;
    toggle.style.setProperty('--depth', String(node.depth));
    const empty = node.total === 0 && node.children.length === 0;
    const chevron = document.createElement('span');
    chevron.className = 'layer-chevron';
    if (!empty) chevron.innerHTML = iconSvg('chevron-right');
    const swatch = document.createElement('span');
    swatch.className = 'sw';
    const color = swatchColor(node.color ?? node.own.find((item) => item.layerColor)?.layerColor);
    if (color) swatch.style.background = color;
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = node.name;
    toggle.append(chevron, swatch, name);
    if (node.hidden) {
      const off = document.createElement('span');
      off.className = 'layer-state';
      off.title = node.visible ? '상위 레이어가 꺼져 있음' : '꺼진 레이어';
      off.innerHTML = iconSvg('eye-off');
      toggle.append(off);
    }
    if (node.locked) {
      const lock = document.createElement('span');
      lock.className = 'layer-state';
      lock.title = '잠긴 레이어';
      lock.innerHTML = iconSvg('lock');
      toggle.append(lock);
    }
    const count = document.createElement('span');
    count.className = 'layer-count';
    const shown = shownCount(node);
    count.textContent = shown.toLocaleString();
    toggle.append(count);
    // The badge's number, and how much of it the Sync left out (off layers are not brought in).
    const left = shown - node.total;
    toggle.title = [
      node.fullPath,
      node.children.length
        ? node.hidden
          ? `하위 레이어 포함 ${shown.toLocaleString()}개`
          : `이 레이어 ${node.own.length.toLocaleString()}개 · 하위 레이어 포함 ${shown.toLocaleString()}개`
        : `${shown.toLocaleString()}개`,
      left > 0
        ? node.hidden
          ? `${node.visible ? '상위 레이어가 꺼져' : '꺼져'} 있어 ${left.toLocaleString()}개는 가져오지 않음`
          : `꺼진 하위 레이어의 ${left.toLocaleString()}개는 가져오지 않음`
        : '',
      empty ? '' : '눌러서 열기',
    ]
      .filter(Boolean)
      .join(' · ');
    const body = document.createElement('div');
    body.className = 'layer-objects';
    body.setAttribute('role', 'group');
    wrap.append(toggle);
    if (node.total > 0) {
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'group-select';
      pick.tabIndex = -1;
      pick.textContent = '선택';
      pick.title = node.children.length
        ? '이 레이어와 하위 레이어 전체 선택 · Shift 추가 · Ctrl 제외'
        : '이 레이어 전체 선택 · Shift 추가 · Ctrl 제외';
      pick.setAttribute('aria-label', node.fullPath + ' 전체 선택');
      pick.onclick = (e) => {
        e.stopPropagation();
        select(
          subtreeItems(node).map((item) => item.id),
          modeOf(e),
        );
      };
      wrap.append(pick);
    }
    wrap.append(body);
    let filled = false;
    const show = (expanded: boolean) => {
      if (empty) {
        toggle.removeAttribute('aria-expanded');
        body.hidden = true;
        return;
      }
      toggle.setAttribute('aria-expanded', String(expanded));
      wrap.setAttribute('aria-expanded', String(expanded));
      body.hidden = !expanded;
      // Closing a layer around the keyboard's row moves that row to the layer itself.
      if (!expanded && active && body.contains(active)) activate(toggle);
      if (!expanded || filled) return;
      filled = true;
      // Sublayers first, then the layer's own objects (as in Rhino's panel).
      for (const child of node.children) body.append(layer(file, child));
      for (const item of node.own.slice(0, ROW_LIMIT)) body.append(row(item, node.depth));
      if (node.own.length > ROW_LIMIT) {
        const more = document.createElement('small');
        more.style.setProperty('--depth', String(node.depth));
        more.textContent = `외 ${(node.own.length - ROW_LIMIT).toLocaleString()}개 · 검색으로 좁히거나 레이어 선택을 사용하세요.`;
        body.append(more);
      }
    };
    toggle.onclick = () => {
      if (empty) return;
      const next = toggle.getAttribute('aria-expanded') !== 'true';
      if (!filter) remember(file, node.fullPath, next);
      show(next);
    };
    show(isOpen(file, node));
    return wrap;
  }
  /** The row that is in the Tab order (with its layer's 선택 button). */
  let active: HTMLElement | undefined;
  const pickOf = (element: HTMLElement) =>
    element.classList.contains('layer-row')
      ? element.parentElement?.querySelector<HTMLElement>(':scope > .group-select')
      : undefined;
  function activate(element: HTMLElement) {
    if (active === element) return;
    if (active) {
      active.tabIndex = -1;
      const pick = pickOf(active);
      if (pick) pick.tabIndex = -1;
    }
    active = element;
    element.tabIndex = 0;
    const pick = pickOf(element);
    if (pick) pick.tabIndex = 0;
  }
  /** Layer and object rows a viewer can see now, top to bottom. */
  const visibleRows = () =>
    [...tree.querySelectorAll<HTMLElement>('.layer-row, .object')].filter(
      (element) => !element.parentElement?.closest('.layer-objects[hidden]'),
    );
  /** The layer row a row sits under (none for a top layer). */
  const parentRow = (element: HTMLElement) => {
    const own = element.classList.contains('layer-row')
      ? element.parentElement?.parentElement
      : element.parentElement;
    return own?.closest('.layer')?.querySelector<HTMLElement>(':scope > .layer-row') ?? undefined;
  };
  tree.addEventListener('focusin', (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('.layer-row, .object')) activate(target);
  });
  // Tree keys (WAI-ARIA tree view): up/down move, right opens or goes to the first sublayer or
  // object, left closes or goes to the parent layer, Home/End go to the first/last row.
  tree.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (!target.matches('.layer-row, .object') || event.altKey || event.ctrlKey || event.metaKey)
      return;
    const rows = visibleRows();
    const at = rows.indexOf(target);
    const layerRow = target.classList.contains('layer-row');
    const expanded = target.getAttribute('aria-expanded');
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = rows[at + 1];
    else if (event.key === 'ArrowUp') next = rows[at - 1];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows.at(-1);
    else if (event.key === 'ArrowRight') {
      if (layerRow && expanded === 'false') target.click();
      else if (layerRow && expanded === 'true') next = rows[at + 1];
    } else if (event.key === 'ArrowLeft') {
      if (layerRow && expanded === 'true') target.click();
      else next = parentRow(target);
    } else return;
    event.preventDefault();
    next?.focus();
  });
  function documents(items: readonly Item[]) {
    const files = new Map<string, Document>();
    for (const item of items) {
      const key = item.documentKey ?? item.documentName ?? '';
      let file = files.get(key);
      if (!file) {
        file = {
          key,
          name: item.documentName,
          items: [],
          flat: item.host === 'zwcad',
          host: item.host,
        };
        files.set(key, file);
      }
      file.items.push(item);
      if (!file.table && item.layerTable) file.table = item.layerTable;
    }
    return [...files.values()];
  }
  function build() {
    rows.clear();
    const query = filter.toLowerCase();
    const matches = (item: Item) =>
      item.name.toLowerCase().includes(query) || (pathOf(item) ?? '').toLowerCase().includes(query);
    const items = query ? current.filter(matches) : current;
    // Layer tables come from every row (a search keeps the hidden layers and order of the file).
    const tableOf = new Map(documents(current).map((file) => [file.key, file.table]));
    const files = documents(items);
    if (query)
      for (const [key, table] of tableOf)
        if (table && !files.some((file) => file.key === key)) {
          const first = current.find(
            (item) => (item.documentKey ?? item.documentName ?? '') === key,
          );
          files.push({
            key,
            name: first?.documentName,
            items: [],
            table,
            flat: first?.host === 'zwcad',
            host: first?.host,
          });
        }
    const fragment = document.createDocumentFragment();
    const byFile = files.length > 1;
    let layerCount = 0;
    for (const file of files) {
      const table = tableOf.get(file.key) ?? file.table;
      const tree = buildLayerTree(
        file.flat ? undefined : table,
        file.items.filter((item) => pathOf(item)),
        (item) => pathOf(item),
        {
          flat: file.flat,
          keepEmpty: (layer) =>
            (layer.hostCount ?? 0) > 0 && (!query || layer.fullPath.toLowerCase().includes(query)),
        },
      );
      const loose = file.items.filter((item) => !pathOf(item));
      const roots = [...tree.roots];
      if (loose.length)
        roots.push({
          key: NO_LAYER,
          name: NO_LAYER,
          fullPath: NO_LAYER,
          depth: 0,
          visible: true,
          hidden: false,
          locked: false,
          own: loose,
          children: [],
          total: loose.length,
          hostTotal: loose.length,
          order: Number.MAX_SAFE_INTEGER,
        });
      if (!roots.length) continue;
      layerCount += tree.count + (loose.length ? 1 : 0);
      if (byFile) {
        const heading = document.createElement('div');
        heading.className = 'layer-file';
        heading.textContent = file.name || '파일 없음';
        heading.title = file.name || '';
        fragment.append(heading);
      }
      for (const node of roots) fragment.append(layer(file.key, node));
    }
    summary.textContent = current.length
      ? `${items.length.toLocaleString()}개 객체 · ${layerCount.toLocaleString()}개 레이어`
      : '모델을 가져오면 레이어별로 표시됩니다.';
    searchToggle.hidden = !current.length;
    const keep = active?.closest<HTMLElement>('.layer')?.dataset.path;
    active = undefined;
    tree.replaceChildren(fragment);
    // One row of the tree is in the Tab order (the one used last, else the first).
    const again = keep
      ? [...tree.querySelectorAll<HTMLElement>('.layer')].find((wrap) => wrap.dataset.path === keep)
      : undefined;
    const first = (again ?? tree).querySelector<HTMLElement>('.layer-row');
    if (first) activate(first);
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
    // A new layer table (order, on/off, a renamed parent) redraws the tree too.
    const nextTables: unknown[] = [];
    let last: unknown;
    for (const item of items)
      if (item.layerTable && item.layerTable !== last) {
        last = item.layerTable;
        if (!nextTables.includes(last)) nextTables.push(last);
      }
    const changed =
      next !== signature ||
      nextTables.length !== tables.length ||
      nextTables.some((table, index) => table !== tables[index]);
    if (changed) {
      signature = next;
      tables = nextTables;
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
