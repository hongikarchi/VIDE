// Rhino layer hierarchy (user request 2026-10-08, SPEC-01.2 레이어 목록): Rhino nests layers
// (`Parent::Child::Grandchild`) and VIDE shows them as a tree in Rhino's panel order. The host's
// layer table (ARCH-01 §5 `layers`) gives ids, parents and order; an older Sync without the table
// is nested by splitting full paths on `::`. A DWG layer name cannot contain ':', so ZWCAD lists
// stay flat by construction. Pure functions: the left layer list, the jig and quantity pickers and
// the jig runtime all order layers through here.

/** One row of the host's layer table (src/contracts/native-model.ts displayLayerSchema). */
export interface HostLayer {
  id: string;
  parentId: string | null;
  fullPath: string;
  visible: boolean;
  locked?: boolean;
  color?: string;
  order: number;
  /** Objects directly on the layer (sublayers not included), hidden ones too. */
  objectCount?: number;
  /** The layer is expanded in Rhino's Layers panel (newer plugins only). */
  expanded?: boolean;
}

export interface LayerNode<T> {
  /** The layer's full path (unique within one document). */
  key: string;
  /** The host's layer id (absent for a node inferred from a path). */
  id?: string;
  /** The last `::` segment. */
  name: string;
  fullPath: string;
  depth: number;
  color?: string;
  /** The layer's own switch. */
  visible: boolean;
  /** Off itself or under a parent that is off (Rhino hides a sublayer of an off parent). */
  hidden: boolean;
  locked: boolean;
  expanded?: boolean;
  /** The host's own count (hidden objects included), when the table gave one. */
  hostCount?: number;
  /** Listed objects directly on the layer. */
  own: T[];
  children: LayerNode<T>[];
  /** Listed objects in the layer and all its sublayers. */
  total: number;
  /** Host count of the whole subtree (hidden objects included), when known. */
  hostTotal: number;
  order: number;
}

export interface LayerTree<T> {
  roots: LayerNode<T>[];
  /** 'table': from the host's layer table; 'paths': nested by `::`; 'flat': nothing nests. */
  source: 'table' | 'paths' | 'flat';
  /** Layers in the tree (shown nodes). */
  count: number;
}

export const SEPARATOR = '::';
const segments = (path: string) => path.split(SEPARATOR);
const leaf = (path: string) => {
  const parts = segments(path);
  return parts[parts.length - 1] || path;
};
const parentPath = (path: string) => {
  const at = path.lastIndexOf(SEPARATOR);
  return at > 0 ? path.slice(0, at) : undefined;
};

interface Draft {
  key: string;
  id?: string;
  fullPath: string;
  parent?: string;
  visible: boolean;
  locked: boolean;
  color?: string;
  order: number;
  expanded?: boolean;
  hostCount?: number;
}

export interface BuildOptions {
  /**
   * Keep a layer that has no listed object in its subtree (default: when the host counted objects
   * on it, i.e. a hidden layer whose objects the Sync left out).
   */
  keepEmpty?: (layer: { fullPath: string; hostCount?: number; hidden: boolean }) => boolean;
  /** Never nest (a ZWCAD/DWG list). */
  flat?: boolean;
}

/**
 * Builds the layer tree of one document. `pathOf` gives an item's full layer path (undefined: the
 * item has no layer and is left out — the caller lists it under '레이어 없음').
 * Guards: a missing parent makes the layer a root (or nests it by its path when that parent
 * exists); a parent cycle is broken at the first repeated layer; duplicate full paths keep the first.
 */
export function buildLayerTree<T>(
  table: readonly HostLayer[] | undefined | null,
  items: readonly T[],
  pathOf: (item: T) => string | undefined,
  options: BuildOptions = {},
): LayerTree<T> {
  const drafts = new Map<string, Draft>();
  const byId = new Map<string, Draft>();
  const usable = Array.isArray(table) && !options.flat;
  if (usable)
    for (const layer of table!) {
      if (!layer || typeof layer.fullPath !== 'string' || !layer.fullPath) continue;
      if (drafts.has(layer.fullPath)) continue;
      const draft: Draft = {
        key: layer.fullPath,
        id: typeof layer.id === 'string' ? layer.id : undefined,
        fullPath: layer.fullPath,
        visible: layer.visible !== false,
        locked: layer.locked === true,
        color: layer.color,
        order: Number.isFinite(layer.order) ? layer.order : Number.MAX_SAFE_INTEGER,
        expanded: typeof layer.expanded === 'boolean' ? layer.expanded : undefined,
        hostCount: typeof layer.objectCount === 'number' ? layer.objectCount : undefined,
      };
      drafts.set(draft.key, draft);
      if (draft.id && !byId.has(draft.id)) byId.set(draft.id, draft);
    }
  if (usable)
    for (const layer of table!) {
      const draft = layer && drafts.get(layer.fullPath);
      if (!draft || draft.id !== layer.id) continue;
      const parent = layer.parentId ? byId.get(layer.parentId) : undefined;
      if (parent && parent !== draft) draft.parent = parent.key;
      else {
        // Missing parent id: nest by the path when that layer is known.
        const byPath = parentPath(draft.fullPath);
        if (layer.parentId && byPath && drafts.has(byPath)) draft.parent = byPath;
      }
    }
  // Items on layers the table does not know (an older Sync, a stale table): add them by path.
  const ownOf = new Map<string, T[]>();
  for (const item of items) {
    const path = pathOf(item);
    if (!path) continue;
    const list = ownOf.get(path);
    if (list) list.push(item);
    else ownOf.set(path, [item]);
    if (drafts.has(path)) continue;
    let child = path;
    drafts.set(path, inferred(path));
    // Ancestors by path (not when the list is flat).
    for (let parent = options.flat ? undefined : parentPath(path); parent; ) {
      drafts.get(child)!.parent = parent;
      if (drafts.has(parent)) break;
      drafts.set(parent, inferred(parent));
      child = parent;
      parent = parentPath(parent);
    }
  }
  // Break cycles: walk each chain once; the first repeat loses its parent.
  for (const draft of drafts.values()) {
    const seen = new Set<string>([draft.key]);
    for (let current = draft; current.parent; ) {
      const next = drafts.get(current.parent);
      if (!next) {
        current.parent = undefined;
        break;
      }
      if (seen.has(next.key)) {
        current.parent = undefined;
        break;
      }
      seen.add(next.key);
      current = next;
    }
  }
  const nodes = new Map<string, LayerNode<T>>();
  for (const draft of drafts.values())
    nodes.set(draft.key, {
      key: draft.key,
      id: draft.id,
      name: options.flat ? draft.fullPath : leaf(draft.fullPath),
      fullPath: draft.fullPath,
      depth: 0,
      color: draft.color,
      visible: draft.visible,
      hidden: !draft.visible,
      locked: draft.locked,
      expanded: draft.expanded,
      hostCount: draft.hostCount,
      own: ownOf.get(draft.key) ?? [],
      children: [],
      total: 0,
      hostTotal: 0,
      order: draft.order,
    });
  const roots: LayerNode<T>[] = [];
  for (const draft of drafts.values()) {
    const node = nodes.get(draft.key)!;
    const parent = draft.parent ? nodes.get(draft.parent) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const compare = (a: LayerNode<T>, b: LayerNode<T>) =>
    a.order - b.order || a.fullPath.localeCompare(b.fullPath);
  const keep = options.keepEmpty ?? ((layer: { hostCount?: number }) => (layer.hostCount ?? 0) > 0);
  let count = 0;
  // Depth, inherited visibility, totals and pruning (cycles are broken above, so this ends).
  const finish = (list: LayerNode<T>[], depth: number, parentHidden: boolean): LayerNode<T>[] => {
    list.sort(compare);
    const kept: LayerNode<T>[] = [];
    for (const node of list) {
      node.depth = depth;
      node.hidden = parentHidden || !node.visible;
      node.children = finish(node.children, depth + 1, node.hidden);
      node.total = node.own.length + node.children.reduce((sum, child) => sum + child.total, 0);
      node.hostTotal =
        (node.hostCount ?? node.own.length) +
        node.children.reduce((sum, child) => sum + child.hostTotal, 0);
      if (node.total > 0 || node.children.length > 0 || keep(node)) {
        kept.push(node);
        count++;
      }
    }
    return kept;
  };
  const shown = finish(roots, 0, false);
  const nested = shown.some((node) => node.children.length > 0);
  return {
    roots: shown,
    source: nested ? (usable ? 'table' : 'paths') : usable ? 'table' : 'flat',
    count,
  };
}

function inferred(path: string): Draft {
  return {
    key: path,
    fullPath: path,
    visible: true,
    locked: false,
    order: Number.MAX_SAFE_INTEGER,
  };
}

/** Every item in a node's subtree (the layer's own objects first, then its sublayers'). */
export function subtreeItems<T>(node: LayerNode<T>): T[] {
  const out: T[] = [];
  const stack: LayerNode<T>[] = [node];
  while (stack.length) {
    const current = stack.pop()!;
    out.push(...current.own);
    for (let i = current.children.length - 1; i >= 0; i--) stack.push(current.children[i]);
  }
  return out;
}

/** The tree in display order (depth first). */
export function flattenTree<T>(roots: readonly LayerNode<T>[]): LayerNode<T>[] {
  const out: LayerNode<T>[] = [];
  const stack = [...roots].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    out.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return out;
}

export interface LayerOption {
  /** The full path (the value a picker stores). */
  value: string;
  /** Indented last segment, for a <select> or <datalist> label. */
  label: string;
  name: string;
  depth: number;
  /** False: a parent layer shown only to place its sublayers (not pickable). */
  present: boolean;
}

/**
 * Picker options from layer paths: Rhino's order and nesting (from the table when given, else by
 * `::`), each sublayer indented under its parent; parents missing from `paths` are added as
 * non-pickable rows. Flat (DWG) names keep their given order.
 */
export function layerOptions(
  paths: readonly string[],
  table?: readonly HostLayer[] | null,
): LayerOption[] {
  const wanted = new Set(paths);
  if (![...wanted].some((path) => path.includes(SEPARATOR)) && !table?.length)
    return [...wanted].map((path) => ({
      value: path,
      label: path,
      name: path,
      depth: 0,
      present: true,
    }));
  // No table: the given order (a caller's own Rhino order or name order) places each branch.
  const ordered = table?.length ? table : pathTable([...wanted]);
  const tree = buildLayerTree(ordered, [...wanted], (path) => path, {
    keepEmpty: (layer) => wanted.has(layer.fullPath),
  });
  return flattenTree(tree.roots).map((node) => ({
    value: node.fullPath,
    label: '　'.repeat(node.depth) + node.name,
    name: node.name,
    depth: node.depth,
    present: wanted.has(node.fullPath),
  }));
}

/** A layer table made from paths alone: parents by `::`, order by first appearance. */
function pathTable(paths: readonly string[]): HostLayer[] {
  const order = new Map<string, number>();
  for (const path of paths) {
    const parts = segments(path);
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join(SEPARATOR);
      if (!order.has(prefix)) order.set(prefix, order.size);
    }
  }
  return [...order].map(([fullPath, index]) => ({
    id: fullPath,
    parentId: parentPath(fullPath) ?? null,
    fullPath,
    visible: true,
    order: index,
  }));
}

/** Full paths ordered like Rhino's Layers panel (unknown paths after, by name). */
export function orderLayerPaths(paths: readonly string[], table?: readonly HostLayer[] | null) {
  const wanted = new Set(paths);
  const ordered = layerOptions(paths, table)
    .filter((option) => wanted.has(option.value))
    .map((option) => option.value);
  // Nothing is dropped: a path the tree could not place (an empty name) keeps its place at the end.
  const placed = new Set(ordered);
  return [...ordered, ...[...wanted].filter((path) => !placed.has(path))];
}
