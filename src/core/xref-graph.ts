// xref relations of the project's drawings (SPEC-01.11 11, PLAN-43 T-200): what the hidden ZWCAD
// read from each drawing copy (hosts/zwcad/worker/XrefGraph.cs) becomes a graph of drawings
// (nodes, by their ORIGINAL path) and xref references (edges, parent → child with the INSERTs).
// A stored xref path is resolved against the original drawing's folder, never the copy's:
// ① the stored path as it is, when absolute and present ② relative to the parent's folder ③ the
// file name in the parent's folder. Unresolved references are missing; references that lead
// back to a drawing on the way are cycles; a parent naming the same child twice is a duplicate.
// `placementsOf` gives a root and the drawings it shows with their insert transforms composed,
// in metres of the root (display only).
import { win32 } from 'node:path';

/** One xref block record of a drawing: the name, the path as stored, attach/overlay, status. */
export interface XrefBlock {
  name: string;
  path: string;
  overlay: boolean;
  status: string;
}
/** One INSERT of an xref block. `transform` is the row-major 4x4 block transform (drawing units). */
export interface XrefInsert {
  name: string;
  handle: string;
  space: 'model' | 'paper' | 'block';
  layout: string | null;
  /** The block that holds a nested INSERT. */
  block: string | null;
  nested: boolean;
  position: number[];
  rotation: number;
  scale: number[];
  transform: number[];
}
interface UnitsRead {
  error: string | null;
  /** INSUNITS as stored; `scale` metres per drawing unit (mm assumed when unitless). */
  units: number | null;
  scale: number | null;
  unitsAssumed: boolean;
}
export interface XrefFileRead extends UnitsRead {
  xrefs: XrefBlock[];
  inserts: XrefInsert[];
}
/** A drawing's model space display rows (the attached Sync's reader), in metres. */
export interface XrefDisplayRead extends UnitsRead {
  objects?: Record<string, unknown>[];
  scene?: Record<string, unknown>[];
  displayCoverage?: Record<string, unknown>;
  displayWarnings?: Record<string, number>;
}
export interface XrefReadFile {
  id: number;
  path: string;
}
/** Reads drawing copies; `progress(done)` after each one. */
export interface XrefReader {
  available(): Promise<boolean>;
  graph(
    files: readonly XrefReadFile[],
    work: string,
    progress: (done: number) => void,
    signal?: AbortSignal,
  ): Promise<Map<number, XrefFileRead>>;
  display(
    files: readonly XrefReadFile[],
    work: string,
    progress: (done: number) => void,
    signal?: AbortSignal,
  ): Promise<Map<number, XrefDisplayRead>>;
}

export type Resolution = 'absolute' | 'relative' | 'folder';
export interface XrefNode {
  path: string;
  name: string;
  /** Read by ZWCAD (false: a referenced drawing that could not be read). */
  read: boolean;
  error: string | null;
  unitsAssumed: boolean;
  scale: number | null;
}
export interface XrefEdge {
  parent: string;
  name: string;
  stored: string;
  overlay: boolean;
  status: string;
  /** The resolved drawing (original path), or null when missing. */
  child: string | null;
  how: Resolution | null;
  missing: boolean;
  cycle: boolean;
  duplicate: boolean;
  inserts: XrefInsert[];
}
export interface XrefGraph {
  nodes: XrefNode[];
  edges: XrefEdge[];
  /** Drawings no other drawing refers to that refer to some (and one per cycle with no root). */
  roots: string[];
}

/** One key per file: Windows paths compare without case. */
export const pathKey = (path: string) => win32.normalize(path).toLowerCase();

/** Where a stored xref path points from a parent drawing's original path, if anywhere. */
export function resolveXref(
  stored: string,
  parent: string,
  exists: (path: string) => boolean,
): { path: string; how: Resolution } | null {
  const value = stored.trim();
  if (!value) return null;
  const folder = win32.dirname(parent);
  if (win32.isAbsolute(value) && /^([a-z]:|\\\\)/i.test(value) && exists(value))
    return { path: win32.normalize(value), how: 'absolute' };
  if (!/^([a-z]:|\\\\)/i.test(value)) {
    const relative = win32.resolve(folder, value);
    if (exists(relative)) return { path: relative, how: 'relative' };
  }
  const same = win32.join(folder, win32.basename(value.replaceAll('/', '\\')));
  if (exists(same)) return { path: same, how: 'folder' };
  return null;
}

/**
 * The graph of the drawings read (`reads`, keyed by original path). `exists` answers for files
 * outside the read set (a reference to a drawing that was not listed). `real`, when given, names
 * the real spelling of a path a reference writes another way (a mapped drive `Z:\…` for the
 * `\\server\share\…` the folder listing used): such a child is the drawing read under it.
 */
export function buildXrefGraph(
  reads: ReadonlyMap<string, XrefFileRead>,
  exists: (path: string) => boolean,
  real?: (path: string) => string,
): XrefGraph {
  const known = new Map<string, string>();
  for (const path of reads.keys()) known.set(pathKey(path), path);
  const present = (path: string) => known.has(pathKey(path)) || exists(path);
  /** The read set's spelling of `path` when it is one of them under another spelling. */
  const spelling = (path: string) => {
    if (!real || known.has(pathKey(path))) return path;
    const other = known.get(pathKey(real(path)));
    return other ?? path;
  };
  const nodes = new Map<string, XrefNode>();
  const node = (written: string) => {
    const path = spelling(written);
    const key = pathKey(path);
    let value = nodes.get(key);
    if (!value) {
      const read = reads.get(known.get(key) ?? path);
      value = {
        path: known.get(key) ?? path,
        name: win32.basename(path),
        read: !!read && !read.error,
        error: read?.error ?? null,
        unitsAssumed: read?.unitsAssumed ?? false,
        scale: read?.scale ?? null,
      };
      nodes.set(key, value);
    }
    return value;
  };
  const edges: XrefEdge[] = [];
  const sorted = [...reads.keys()].sort((a, b) => a.localeCompare(b));
  for (const parent of sorted) {
    node(parent);
    const read = reads.get(parent)!;
    const seen = new Set<string>();
    for (const block of read.xrefs) {
      const inserts = read.inserts.filter(
        (insert) => insert.name.toLowerCase() === block.name.toLowerCase(),
      );
      // A record CAD keeps after its last INSERT went (or a nested xref brought along): no relation.
      if (block.status === 'Unreferenced' && !inserts.length) continue;
      const target = resolveXref(block.path, parent, present);
      const child = target ? node(target.path).path : null;
      const key = child ? pathKey(child) : null;
      const duplicate = !!key && seen.has(key);
      if (key) seen.add(key);
      edges.push({
        parent,
        name: block.name,
        stored: block.path,
        overlay: block.overlay,
        status: block.status,
        child,
        how: target?.how ?? null,
        missing: !target,
        cycle: false,
        duplicate,
        inserts,
      });
    }
  }
  const outgoing = new Map<string, XrefEdge[]>();
  for (const edge of edges) {
    const key = pathKey(edge.parent);
    outgoing.set(key, [...(outgoing.get(key) ?? []), edge]);
  }
  // Cycles: an edge back to a drawing on the current path.
  const done = new Set<string>();
  const walk = (key: string, stack: Set<string>) => {
    if (done.has(key)) return;
    stack.add(key);
    for (const edge of outgoing.get(key) ?? []) {
      if (!edge.child) continue;
      const child = pathKey(edge.child);
      if (stack.has(child)) edge.cycle = true;
      else walk(child, stack);
    }
    stack.delete(key);
    done.add(key);
  };
  for (const parent of sorted) walk(pathKey(parent), new Set());
  const referenced = new Set(
    edges.filter((edge) => edge.child && !edge.cycle).map((edge) => pathKey(edge.child!)),
  );
  const roots = sorted.filter(
    (path) => outgoing.get(pathKey(path))?.length && !referenced.has(pathKey(path)),
  );
  // A cycle no root reaches still shows: its first drawing becomes a root.
  const reached = new Set<string>();
  const reach = (key: string) => {
    if (reached.has(key)) return;
    reached.add(key);
    for (const edge of outgoing.get(key) ?? []) if (edge.child) reach(pathKey(edge.child));
  };
  for (const root of roots) reach(pathKey(root));
  for (const path of sorted)
    if (outgoing.get(pathKey(path))?.length && !reached.has(pathKey(path))) {
      roots.push(path);
      reach(pathKey(path));
    }
  return { nodes: [...nodes.values()], edges, roots };
}

/** Row-major 4x4 product a·b. */
export function multiply(a: readonly number[], b: readonly number[]) {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      for (let k = 0; k < 4; k++) out[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return out;
}
const scaling = (s: number) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
export const IDENTITY = scaling(1);

export interface Placement {
  path: string;
  name: string;
  /** Row-major 4x4 from the drawing's metres to the root's metres; null for the root. */
  matrix: number[] | null;
  depth: number;
  parent: string | null;
  /** The INSERT used (the first model space one); a drawing shown once even when inserted again. */
  handle: string | null;
}
/**
 * The root and the drawings it shows in model space, each once, with its placement. As in CAD, an
 * overlay is shown only when the root itself refers to it; references in paper space or inside
 * blocks place nothing; a cycle stops at the drawing already on the way.
 */
export function placementsOf(graph: XrefGraph, root: string): Placement[] {
  const byKey = new Map(graph.nodes.map((node) => [pathKey(node.path), node]));
  const outgoing = new Map<string, XrefEdge[]>();
  for (const edge of graph.edges) {
    const key = pathKey(edge.parent);
    outgoing.set(key, [...(outgoing.get(key) ?? []), edge]);
  }
  const rootNode = byKey.get(pathKey(root));
  if (!rootNode) return [];
  const out: Placement[] = [
    {
      path: rootNode.path,
      name: rootNode.name,
      matrix: null,
      depth: 0,
      parent: null,
      handle: null,
    },
  ];
  const shown = new Set([pathKey(root)]);
  const visit = (path: string, matrix: number[], depth: number) => {
    const parentScale = byKey.get(pathKey(path))?.scale ?? 0.001;
    for (const edge of outgoing.get(pathKey(path)) ?? []) {
      if (!edge.child || edge.cycle || (edge.overlay && depth > 0)) continue;
      const key = pathKey(edge.child);
      if (shown.has(key)) continue;
      const insert = edge.inserts.find((item) => item.space === 'model' && !item.nested);
      if (!insert || insert.transform.length !== 16) continue;
      const child = byKey.get(key)!;
      const childScale = child.scale ?? parentScale;
      const placed = multiply(
        matrix,
        multiply(scaling(parentScale), multiply(insert.transform, scaling(1 / childScale))),
      );
      shown.add(key);
      out.push({
        path: child.path,
        name: child.name,
        matrix: placed,
        depth: depth + 1,
        parent: path,
        handle: insert.handle,
      });
      visit(child.path, placed, depth + 1);
    }
  };
  visit(rootNode.path, IDENTITY, 0);
  return out;
}
