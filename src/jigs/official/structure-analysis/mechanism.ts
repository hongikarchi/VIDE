// Mechanism pre-check (PLAN-23 T-053): finds the joint patterns that make a frame a mechanism
// before the core runs, so the summary can name the offending nodes and the cause instead of a
// bare zero-pivot list. It reads topology and end releases only; the core stays the judge of
// everything else (sway, missing supports).
//
// - A free tip (unsupported node with one member end) whose member chain back to the first joint
//   or support carries a bending release is a hinged cantilever: the tip drops freely.
// - A free tip that is itself released has no rotational stiffness there: a warning, since the
//   tip still hangs on its member and the core auto-restrains an axis-aligned zero (a skew one it
//   reports as a mechanism at that node).
// - A truss member ending alone at a free node has no transverse stiffness.
// - A node where every frame end is released in bending (and nothing restrains its rotation) is
//   reported as a warning: the core auto-restrains an axis-aligned zero, a skew one is a mechanism.
// - A cantilever whose root is held only by the torsion of one straight girder (no column, no
//   crossing member, no backspan in line with it) is a warning: an open H section twists so
//   freely that factored loads give absurd rotations, which the core reports as a mechanism.

import type { DraftIssue } from '../../structure/input.ts';

interface PrecheckNode {
  id: string;
  xyz_m?: readonly number[];
  support?: Record<string, boolean | undefined>;
}
interface PrecheckMember {
  id: string;
  i: string;
  j: string;
  kind?: string;
  role?: string;
  releases?: { i?: Record<string, boolean | undefined>; j?: Record<string, boolean | undefined> };
}

export interface MechanismFinding {
  kind: 'hinged-cantilever' | 'released-tip' | 'truss-tip' | 'all-pinned' | 'torsion-root';
  /** Tip first, then the hinge (hinged cantilever) or the root (torsion root). */
  nodes: string[];
  members: string[];
}

const bendingReleased = (r: Record<string, boolean | undefined> | undefined) => !!(r?.ry || r?.rz);
const rotationHeld = (s: PrecheckNode['support']) => !!(s?.rx && s?.ry && s?.rz);

export function findMechanisms(model: {
  nodes: PrecheckNode[];
  members: PrecheckMember[];
}): MechanismFinding[] {
  const support = new Map(model.nodes.map((n) => [n.id, n.support]));
  const ends = new Map<string, { m: PrecheckMember; end: 'i' | 'j' }[]>();
  for (const m of model.members)
    for (const end of ['i', 'j'] as const) {
      const n = m[end];
      ends.set(n, [...(ends.get(n) ?? []), { m, end }]);
    }
  const free = (n: string) => !support.get(n);
  const xyz = new Map(model.nodes.map((n) => [n.id, n.xyz_m]));
  /** Plan direction (unit, sign-free) of a member seen from `node`, or undefined when vertical. */
  const planDir = (m: PrecheckMember, node: string) => {
    const [a, b] = [xyz.get(node), xyz.get(m.i === node ? m.j : m.i)];
    if (!a || !b) return undefined;
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const l = Math.hypot(dx, dy);
    return l > 1e-9 ? ([dx / l, dy / l] as const) : undefined;
  };
  const parallel = (u: readonly number[], v: readonly number[]) =>
    Math.abs(u[0] * v[0] + u[1] * v[1]) >= Math.cos((30 * Math.PI) / 180);
  /** The root's moment has no bending path: only torsion of members along one line holds it. */
  const torsionOnly = (root: string, chain: string[]) => {
    if (!free(root) && rotationHeld(support.get(root))) return false;
    const arm = model.members.find((m) => m.id === chain[chain.length - 1]);
    const armDir = arm && planDir(arm, root);
    if (!armDir) return false;
    const held = (ends.get(root) ?? []).filter(
      (e) =>
        !chain.includes(e.m.id) &&
        (e.m.kind ?? 'frame') === 'frame' &&
        !bendingReleased(e.m.releases?.[e.end]),
    );
    if (held.some((e) => e.m.role === 'column')) return false;
    const dirs = held.map((e) => planDir(e.m, root));
    if (dirs.some((d) => !d)) return false;
    const line = dirs[0];
    if (!line) return true;
    if (dirs.some((d) => !parallel(d!, line))) return false;
    return !parallel(armDir, line);
  };
  const out: MechanismFinding[] = [];
  for (const [node, at] of ends) {
    if (!free(node)) continue;
    if (at.length === 1) {
      const { m, end } = at[0];
      if ((m.kind ?? 'frame') !== 'frame') {
        out.push({ kind: 'truss-tip', nodes: [node], members: [m.id] });
        continue;
      }
      if (bendingReleased(m.releases?.[end])) {
        out.push({ kind: 'released-tip', nodes: [node], members: [m.id] });
        continue;
      }
      // Walk the chain back through free two-member nodes to the first joint or support.
      const chain: string[] = [];
      let cur = m,
        from: 'i' | 'j' = end,
        hinge: string | undefined,
        rootNode: string | undefined;
      for (let guard = 0; guard < model.members.length; guard++) {
        chain.push(cur.id);
        const far = from === 'i' ? 'j' : 'i';
        const farNode = cur[far];
        if (bendingReleased(cur.releases?.[far]) || (cur.kind ?? 'frame') !== 'frame') {
          hinge = farNode;
          break;
        }
        const next = ends.get(farNode) ?? [];
        rootNode = farNode;
        if (!free(farNode) || next.length !== 2) break;
        const other = next.find((e) => e.m !== cur);
        if (!other) break;
        if (bendingReleased(other.m.releases?.[other.end])) {
          hinge = farNode;
          break;
        }
        cur = other.m;
        from = other.end;
      }
      if (hinge) out.push({ kind: 'hinged-cantilever', nodes: [node, hinge], members: chain });
      else if (rootNode && torsionOnly(rootNode, chain)) {
        out.push({ kind: 'torsion-root', nodes: [node, rootNode], members: chain });
      }
      continue;
    }
    const frames = at.filter((e) => (e.m.kind ?? 'frame') === 'frame');
    if (
      frames.length === at.length &&
      !rotationHeld(support.get(node)) &&
      frames.every((e) => bendingReleased(e.m.releases?.[e.end]))
    )
      out.push({ kind: 'all-pinned', nodes: [node], members: frames.map((e) => e.m.id) });
  }
  return out;
}

const MESSAGES: Record<MechanismFinding['kind'], (f: MechanismFinding) => string> = {
  'hinged-cantilever': (f) =>
    `불안정(기구) — 내민 끝 ${f.nodes[0]}: 뿌리 ${f.nodes[1]}가 핀이라 끝이 떨어짐. 내민 부재는 뿌리를 강접으로`,
  'released-tip': (f) =>
    `내민 끝 ${f.nodes[0]}의 단부가 풀려 끝 회전을 잡는 부재가 없음 — 부재가 비스듬하면 기구로 나옴. 끝 단부는 강접으로`,
  'truss-tip': (f) => `불안정(기구) — 트러스 부재 하나만 닿은 자유 절점 ${f.nodes[0]}`,
  'torsion-root': (f) =>
    `내민 끝 ${f.nodes[0]}: 뿌리 ${f.nodes[1]}를 거더 비틀림만 잡음 — 하중에 따라 기구로 나옴. 뒤쪽 보를 잇거나 뿌리를 기둥에`,
  'all-pinned': (f) =>
    `절점 ${f.nodes[0]}: 닿는 단부 ${f.members.length}곳이 모두 핀 — 회전이 비스듬하면 기구가 됨`,
};

const WARNING_CODES: Partial<Record<MechanismFinding['kind'], string>> = {
  'all-pinned': 'ALL_PINNED',
  'torsion-root': 'TORSION_ROOT',
  'released-tip': 'RELEASED_TIP',
};

/**
 * Pre-check issues: MECHANISM errors (offending nodes, members) for hinged cantilevers and lone
 * truss tips; ALL_PINNED, TORSION_ROOT and RELEASED_TIP warnings that leave the verdict to the core.
 */
export function mechanismIssues(model: Parameters<typeof findMechanisms>[0]): DraftIssue[] {
  return findMechanisms(model).map((f) => ({
    level: WARNING_CODES[f.kind] ? 'warning' : 'error',
    code: WARNING_CODES[f.kind] ?? 'MECHANISM',
    message: MESSAGES[f.kind](f),
    nodes: f.nodes,
    members: f.members,
  }));
}
