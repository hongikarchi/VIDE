// 결합부 타입 (SPEC-16.7 5, PLAN-49 T-256): the topology comes from the lattice vertex keys of
// SPEC-16.5 5, never from distances.
//
//   node  — one per vertex key: the plates meeting there (valence) and the angles between the
//           consecutive edges around it, measured in the tangent plane (the reference normal there),
//           counter-clockwise from that normal, rounded to the angle step and rotated to the
//           lexicographically smallest order (so it starts at the smallest angle and does not depend
//           on where one starts). Same valence and same rounded angles → one `N-nn`.
//   joint — one per edge two plates share (the same two keys, adjacent in both outlines): the fold
//           angle between the two plates' best-fit plane normals (0° = coplanar, + = convex toward
//           the reference normal) and the edge length. The angle is binned by the step (bin b covers
//           [(b − ½)·step, (b + ½)·step]); within a bin the lengths are grouped by the type tolerance
//           (sorted, a new group when a length is more than the tolerance above the group's first).
//           Edges of one plate only (the face boundary) are not joints.
//
// Numbers: larger count first, then the smaller angles / bin, then the shorter length.

import { cross3, dot3, len3, norm3, scale3, sub3, type Vec3 } from './vec.ts';

export interface ConnectionPanel {
  id: string;
  keys: readonly string[];
  /** Vertex positions on the surface, one per key. */
  corners: readonly Vec3[];
  /** Reference normal at each vertex (the face normal, reversed when flipped). */
  normals: readonly Vec3[];
  /** Best-fit plane normal (to the reference side) and the plate's centre. */
  planeNormal: Vec3;
  centre: Vec3;
}

export interface NodeType {
  type: string;
  valence: number;
  angles: number[];
  count: number;
}
export interface NodeAt {
  key: string;
  type: string;
  at: Vec3;
}
export interface JointType {
  type: string;
  dihedral: [number, number];
  count: number;
  length: number;
  totalLength: number;
}
export interface JointAt {
  keys: [string, string];
  panels: [string, string];
  type: string;
  dihedral: number;
  length: number;
}

const DEG = 180 / Math.PI;
const tidy = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
const typeName = (prefix: string, i: number) => `${prefix}-${String(i + 1).padStart(2, '0')}`;

/** Nodes and joints of the plates (failed panels left out by the caller). */
export function connections(
  panels: readonly ConnectionPanel[],
  angleStep: number,
  typeTol: number,
): {
  nodes: NodeType[];
  nodeAt: NodeAt[];
  joints: JointType[];
  jointAt: JointAt[];
  notes: string[];
} {
  const notes: string[] = [];
  // ── nodes ──
  interface NodeDraft {
    key: string;
    at: Vec3;
    normal: Vec3;
    panels: Set<number>;
    neighbours: Map<string, Vec3>;
  }
  const nodeMap = new Map<string, NodeDraft>();
  const edgeMap = new Map<string, { keys: [string, string]; at: [Vec3, Vec3]; panels: number[] }>();
  panels.forEach((p, pi) => {
    const n = p.keys.length;
    for (let i = 0; i < n; i++) {
      const key = p.keys[i];
      let node = nodeMap.get(key);
      if (!node) {
        node = {
          key,
          at: p.corners[i],
          normal: p.normals[i],
          panels: new Set(),
          neighbours: new Map(),
        };
        nodeMap.set(key, node);
      }
      node.panels.add(pi);
      const prev = (i + n - 1) % n,
        next = (i + 1) % n;
      if (p.keys[prev] !== key) node.neighbours.set(p.keys[prev], p.corners[prev]);
      if (p.keys[next] !== key) node.neighbours.set(p.keys[next], p.corners[next]);
      const k2 = p.keys[next];
      if (k2 === key) continue;
      const id = key < k2 ? `${key}\u0000${k2}` : `${k2}\u0000${key}`;
      const edge = edgeMap.get(id);
      if (edge) {
        if (!edge.panels.includes(pi)) edge.panels.push(pi);
      } else
        edgeMap.set(id, { keys: [key, k2], at: [p.corners[i], p.corners[next]], panels: [pi] });
    }
  });

  const nodeGroups = new Map<string, { valence: number; angles: number[]; keys: string[] }>();
  const nodeSig = new Map<string, string>();
  let skipped = 0;
  for (const node of nodeMap.values()) {
    const valence = node.panels.size;
    const dirs = [...node.neighbours.values()];
    if (valence > 12 || dirs.length > 12 || dirs.length < 1) {
      skipped++;
      continue;
    }
    const nrm = norm3(node.normal);
    let e1 = sub3(dirs[0], node.at);
    e1 = sub3(e1, scale3(nrm, dot3(e1, nrm)));
    if (len3(e1) < 1e-12) e1 = cross3(nrm, Math.abs(nrm[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
    e1 = norm3(e1);
    const e2 = cross3(nrm, e1);
    const theta = dirs
      .map((d) => {
        const v = sub3(d, node.at);
        return Math.atan2(dot3(v, e2), dot3(v, e1));
      })
      .map((a) => (a < 0 ? a + 2 * Math.PI : a))
      .sort((a, b) => a - b);
    const gaps = theta.map((a, i) =>
      i + 1 < theta.length ? theta[i + 1] - a : 2 * Math.PI - a + theta[0],
    );
    const rounded = gaps.map((g) => tidy(Math.round((g * DEG) / angleStep) * angleStep));
    const angles = smallestRotation(rounded);
    const sig = `${valence}|${angles.join(',')}`;
    nodeSig.set(node.key, sig);
    const group = nodeGroups.get(sig);
    if (group) group.keys.push(node.key);
    else nodeGroups.set(sig, { valence, angles, keys: [node.key] });
  }
  if (skipped)
    notes.push(
      `결합부: 판이 12개 넘게 만나는 꼭짓점 ${skipped}개는 노드 타입에서 뺐습니다(극점 등)`,
    );
  const nodeOrder = [...nodeGroups.entries()].sort(
    ([sa, a], [sb, b]) =>
      b.keys.length - a.keys.length ||
      a.valence - b.valence ||
      compareNums(a.angles, b.angles) ||
      (sa < sb ? -1 : 1),
  );
  const nodeType = new Map<string, string>();
  const nodes: NodeType[] = nodeOrder.map(([sig, g], i) => {
    nodeType.set(sig, typeName('N', i));
    return { type: typeName('N', i), valence: g.valence, angles: g.angles, count: g.keys.length };
  });
  const nodeAt: NodeAt[] = [];
  for (const node of nodeMap.values()) {
    const sig = nodeSig.get(node.key);
    if (sig) nodeAt.push({ key: node.key, type: nodeType.get(sig)!, at: node.at });
  }

  // ── joints ──
  interface JointDraft {
    keys: [string, string];
    panels: [number, number];
    dihedral: number;
    bin: number;
    length: number;
  }
  const drafts: JointDraft[] = [];
  for (const edge of edgeMap.values()) {
    if (edge.panels.length !== 2) continue;
    const [ia, ib] =
      edge.panels[0] < edge.panels[1] ? edge.panels : [edge.panels[1], edge.panels[0]];
    const a = panels[ia],
      b = panels[ib];
    const cosang = Math.max(-1, Math.min(1, dot3(a.planeNormal, b.planeNormal)));
    let angle = Math.acos(cosang) * DEG;
    // Convex toward the normal when each plate's centre lies below the other's plane.
    const s =
      dot3(sub3(b.centre, a.centre), a.planeNormal) + dot3(sub3(a.centre, b.centre), b.planeNormal);
    if (s > 0) angle = -angle;
    const length = len3(sub3(edge.at[1], edge.at[0]));
    const keyA = panels[ia].keys,
      // Keys in the order of the lower panel's outline.
      i0 = keyA.indexOf(edge.keys[0]),
      i1 = keyA.indexOf(edge.keys[1]);
    const keys: [string, string] =
      (i0 + 1) % keyA.length === i1 ? [edge.keys[0], edge.keys[1]] : [edge.keys[1], edge.keys[0]];
    drafts.push({
      keys,
      panels: [ia, ib],
      dihedral: angle,
      bin: Math.round(angle / angleStep) + 0,
      length,
    });
  }
  const byBin = new Map<number, JointDraft[]>();
  for (const d of drafts) {
    const list = byBin.get(d.bin);
    if (list) list.push(d);
    else byBin.set(d.bin, [d]);
  }
  interface JointGroup {
    bin: number;
    items: JointDraft[];
  }
  const groups: JointGroup[] = [];
  for (const [bin, list] of byBin) {
    list.sort((x, y) => x.length - y.length);
    let current: JointGroup | null = null;
    for (const d of list) {
      if (!current || d.length - current.items[0].length > typeTol) {
        current = { bin, items: [] };
        groups.push(current);
      }
      current.items.push(d);
    }
  }
  const mean = (g: JointGroup) => g.items.reduce((a, d) => a + d.length, 0) / g.items.length;
  groups.sort(
    (a, b) =>
      b.items.length - a.items.length ||
      Math.abs(a.bin) - Math.abs(b.bin) ||
      a.bin - b.bin ||
      mean(a) - mean(b),
  );
  const joints: JointType[] = [];
  const jointAt: JointAt[] = [];
  groups.forEach((g, i) => {
    const type = typeName('J', i);
    const total = g.items.reduce((a, d) => a + d.length, 0);
    joints.push({
      type,
      dihedral: [tidy((g.bin - 0.5) * angleStep), tidy((g.bin + 0.5) * angleStep)],
      count: g.items.length,
      length: total / g.items.length,
      totalLength: total,
    });
    for (const d of g.items)
      jointAt.push({
        keys: d.keys,
        panels: [panels[d.panels[0]].id, panels[d.panels[1]].id],
        type,
        dihedral: tidy(d.dihedral),
        length: d.length,
      });
  });
  jointAt.sort(
    (x, y) =>
      x.panels[0].localeCompare(y.panels[0]) ||
      x.panels[1].localeCompare(y.panels[1]) ||
      x.keys[0].localeCompare(y.keys[0]),
  );
  return { nodes, nodeAt, joints, jointAt, notes };
}

function compareNums(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** The rotation of a cyclic list that is lexicographically smallest. */
function smallestRotation(xs: number[]): number[] {
  let best = xs;
  for (let r = 1; r < xs.length; r++) {
    const rot = xs.slice(r).concat(xs.slice(0, r));
    if (compareNums(rot, best) < 0) best = rot;
  }
  return best.slice();
}
