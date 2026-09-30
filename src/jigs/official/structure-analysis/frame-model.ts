// buildFrameModel (PLAN-23 T-052): a frame plan → analysis model with explicit roles, supports,
// joints and loads. Straight members are split at joints only, curved rails by segmentCurve;
// every segment carries design lengths measured on the physical member; lateral restraint holds
// the listed column nodes only; steel self-weight is on; notional lateral loads and named
// combinations are echoed by the summary (gate `combo-echo`).

import type { StructureModel, StructureModelInput } from '../../../contracts/structure-model.ts';
import type { DraftIssue } from '../../structure/input.ts';
import { designForBeam, designForColumn } from './design-length.ts';
import {
  PLAN_ROLE_TO_MODEL,
  type FrameCombo,
  type FramePlan,
  type FrameMember,
  type MemberMap,
} from './frame-plan.ts';
import { type Vec3, dist, isFiniteVec, projectOnLine, sub, unit } from './geometry.ts';
import { unitWeight_kNpm } from './section-props.ts';
import { cleanPolyline, isCurved, segmentCurve } from './segment.ts';

export interface FrameBuild {
  model: StructureModelInput;
  map: MemberMap;
  /** Assumptions the summary and the report print (SPEC-06.7). */
  assumptions: string[];
  /** Plan-level problems; an error means the model must not be analysed. */
  issues: DraftIssue[];
}

export const DEFAULT_COMBOS: FrameCombo[] = [
  { id: '1.2D+1.6L', factors: { D: 1.2, L: 1.6 }, use: 'strength' },
  { id: '1.2D+1.6L+NX', factors: { D: 1.2, L: 1.6, NX: 1 }, use: 'strength' },
  { id: '1.2D+1.6L+NY', factors: { D: 1.2, L: 1.6, NY: 1 }, use: 'strength' },
  { id: 'D+L', factors: { D: 1, L: 1 }, use: 'service' },
];

const SM355: StructureModelInput['materials'][number] = {
  id: 'SM355',
  grade: 'SM355',
  E_MPa: 210000,
  G_MPa: 81000,
  density_kNpm3: 77,
  Fy_MPa: 355,
  Fu_MPa: 490,
  fyByThickness: [
    { tMax_mm: 16, Fy_MPa: 355 },
    { tMax_mm: 40, Fy_MPa: 345 },
    { tMax_mm: 75, Fy_MPa: 335 },
    { tMax_mm: 100, Fy_MPa: 325 },
  ],
  provenance: {
    by: 'auto',
    assumed: true,
    note: '기본 강종 SM355, 두께별 항복강도·E = 210,000 MPa는 기준 원문 확인 전 가정',
  },
};

const PIN = { dx: true, dy: true, dz: true, rz: true };
const FIXED = { dx: true, dy: true, dz: true, rx: true, ry: true, rz: true };
const RELEASE = { ry: true, rz: true };

/** Nodes merged within a tolerance, found through a coarse grid. */
class NodeRegistry {
  readonly points: Vec3[] = [];
  private readonly grid = new Map<string, number[]>();
  private readonly tol: number;
  constructor(tol: number) {
    this.tol = tol;
  }
  private cell(p: Vec3) {
    return p.map((v) => Math.floor(v / (this.tol * 2)));
  }
  find(p: Vec3): number | undefined {
    const [x, y, z] = this.cell(p);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const n of this.grid.get(`${x + dx},${y + dy},${z + dz}`) ?? [])
            if (dist(this.points[n], p) <= this.tol) return n;
    return undefined;
  }
  at(p: Vec3): number {
    const found = this.find(p);
    if (found !== undefined) return found;
    this.points.push([p[0], p[1], p[2]]);
    const key = this.cell(p).join(',');
    this.grid.set(key, [...(this.grid.get(key) ?? []), this.points.length - 1]);
    return this.points.length - 1;
  }
  id(n: number) {
    return `N${n + 1}`;
  }
  /** Registered nodes strictly inside the segment ab (within tol of it), ordered along it. */
  interior(a: Vec3, b: Vec3, exclude: Set<number>): number[] {
    const l = dist(a, b);
    if (l <= 0) return [];
    const out: { n: number; t: number }[] = [];
    for (let n = 0; n < this.points.length; n++) {
      if (exclude.has(n)) continue;
      const { t, distance } = projectOnLine(this.points[n], a, b);
      if (distance <= this.tol && t * l > this.tol && (1 - t) * l > this.tol) out.push({ n, t });
    }
    return out.sort((u, v) => u.t - v.t).map((x) => x.n);
  }
}

interface Segment {
  id: string;
  i: number;
  j: number;
  length_m: number;
}

const planAngleDeg = (a: Vec3, b: Vec3) => {
  const u = unit([a[0], a[1], 0]),
    v = unit([b[0], b[1], 0]);
  const c = Math.abs(u[0] * v[0] + u[1] * v[1]);
  return (Math.acos(Math.min(1, c)) * 180) / Math.PI;
};

export function buildFrameModel(plan: FramePlan): FrameBuild {
  const tol = plan.mergeTolerance_m ?? 0.005;
  const issues: DraftIssue[] = [];
  const assumptions: string[] = [];
  const assume = (text: string) => {
    if (!assumptions.includes(text)) assumptions.push(text);
  };
  const error = (code: string, message: string, extra: Partial<DraftIssue> = {}) =>
    issues.push({ level: 'error', code, message, ...extra });
  const warn = (code: string, message: string, extra: Partial<DraftIssue> = {}) =>
    issues.push({ level: 'warning', code, message, ...extra });

  const materials = plan.materials?.length ? plan.materials : [SM355];
  if (!plan.materials?.length) assume(SM355.provenance!.note!);
  const materialIds = new Set(materials.map((m) => m.id));
  const defaultMaterial = materials[0].id;
  const sections = new Map(plan.sections.map((s) => [s.id, s]));
  const materialOf = (id: string | undefined, owner: string) => {
    const m = id ?? defaultMaterial;
    if (!materialIds.has(m)) error('MATERIAL_UNKNOWN', `${owner}: 재료 ${m} 없음`);
    return m;
  };
  const sectionOf = (id: string, owner: string) => {
    if (!sections.has(id)) error('SECTION_UNKNOWN', `${owner}: 단면 ${id} 없음`);
    return id;
  };

  // Keys must be unique across columns and members (they become design member ids); a later
  // duplicate is dropped so it cannot shadow the first.
  const keys = new Set<string>();
  const uniqueKey = <T extends { key: string }>(item: T) => {
    if (!item.key) {
      error('KEY_EMPTY', '빈 부재 키');
      return false;
    }
    if (keys.has(item.key)) {
      error('KEY_DUPLICATE', `부재 키 중복: ${item.key}`);
      return false;
    }
    keys.add(item.key);
    return true;
  };

  const registry = new NodeRegistry(tol);
  const columns = plan.columns.filter(uniqueKey).filter((c) => {
    if (!isFiniteVec(c.base) || !isFiniteVec(c.top)) {
      error('COLUMN_POINTS', `기둥 ${c.key}: 좌표가 유한하지 않음`);
      return false;
    }
    if (c.top[2] - c.base[2] <= tol) {
      error('COLUMN_HEIGHT', `기둥 ${c.key}: 상단이 하단보다 높지 않음`);
      return false;
    }
    return true;
  });
  const members = plan.members
    .filter(uniqueKey)
    .map((m) => ({ ...m, rail: cleanPolyline((m.rail ?? []).filter(isFiniteVec)) }))
    .filter((m) => {
      if (m.rail.length < 2 || dist(m.rail[0], m.rail[m.rail.length - 1]) <= tol) {
        error('RAIL_SHORT', `부재 ${m.key}: 레일 점이 2개 미만이거나 양 끝이 같음`);
        return false;
      }
      return true;
    });

  // 1. Nodes at column ends and rail ends; 2. curved rails get their vertices (joints of other
  // members become split points); restraint levels become column nodes.
  const columnEnds = columns.map((c) => ({ base: registry.at(c.base), top: registry.at(c.top) }));
  for (const m of members) {
    registry.at(m.rail[0]);
    registry.at(m.rail[m.rail.length - 1]);
  }
  const curve = { maxLen_m: plan.curve?.maxLen_m ?? 1.0, maxSag_m: plan.curve?.maxSag_m ?? 0.005 };
  const joints = registry.points.map((p) => [...p] as Vec3);
  const vertexNodes = new Map<string, number[]>();
  const curved = new Set<string>();
  for (const m of members)
    if (isCurved(m.rail, tol)) {
      curved.add(m.key);
      const vertices = segmentCurve(m.rail, { ...curve, splitAt: joints, tol_m: tol });
      vertexNodes.set(
        m.key,
        vertices.map((p) => registry.at(p)),
      );
    }
  const restraintLevels = plan.restraintLevels_m ?? [];
  const restraintNodes = new Map<string, number[]>();
  for (const c of columns) {
    const levels = [...new Set([...restraintLevels, ...(c.restraintZ_m ?? [])])];
    const nodes: number[] = [];
    for (const z of levels) {
      if (z < c.base[2] - tol || z > c.top[2] + tol) {
        warn('RESTRAINT_OUTSIDE', `기둥 ${c.key}: 구속 레벨 ${z} m가 기둥 밖`);
        continue;
      }
      const clamped = Math.min(c.top[2], Math.max(c.base[2], z));
      const t = (clamped - c.base[2]) / (c.top[2] - c.base[2]);
      nodes.push(
        registry.at([
          c.base[0] + t * (c.top[0] - c.base[0]),
          c.base[1] + t * (c.top[1] - c.base[1]),
          clamped,
        ]),
      );
    }
    restraintNodes.set(c.key, [...new Set(nodes)]);
  }

  // 3. Straight rails split at the registered nodes on them; columns likewise.
  for (const m of members)
    if (!curved.has(m.key)) {
      const a = m.rail[0],
        b = m.rail[m.rail.length - 1];
      const i = registry.at(a),
        j = registry.at(b);
      vertexNodes.set(m.key, [i, ...registry.interior(a, b, new Set([i, j])), j]);
    }
  const columnOfNode = new Map<number, string>();
  const columnVertices = new Map<string, number[]>();
  columns.forEach((c, k) => {
    const { base, top } = columnEnds[k];
    const nodes = [base, ...registry.interior(c.base, c.top, new Set([base, top])), top];
    columnVertices.set(c.key, nodes);
    for (const n of nodes) columnOfNode.set(n, c.key);
  });

  // 4. Segments; duplicates (same two nodes) are skipped with a warning.
  const seen = new Map<string, string>();
  const segmentsOf = new Map<string, Segment[]>();
  const makeSegments = (key: string, nodes: number[]) => {
    const out: Segment[] = [];
    for (let k = 1; k < nodes.length; k++) {
      const [i, j] = [nodes[k - 1], nodes[k]];
      if (i === j) continue;
      const pair = i < j ? `${i}-${j}` : `${j}-${i}`;
      const other = seen.get(pair);
      if (other) {
        warn('DUPLICATE', `${key}: ${other}와 같은 두 절점을 잇는 조각을 제거`, { members: [key] });
        continue;
      }
      const id = `${key}.${out.length + 1}`;
      seen.set(pair, id);
      out.push({ id, i, j, length_m: dist(registry.points[i], registry.points[j]) });
    }
    if (!out.length) error('NO_SEGMENT', `${key}: 해석 조각이 없음`, { members: [key] });
    segmentsOf.set(key, out);
  };
  for (const c of columns) makeSegments(c.key, columnVertices.get(c.key)!);
  for (const m of members) makeSegments(m.key, vertexNodes.get(m.key)!);

  // 5. Members with roles, releases (joint rule at H columns), betaDeg and design lengths.
  const swayK = plan.swayK ?? 2.0;
  const strongTol = plan.jointRule === false ? undefined : (plan.jointRule?.strongAxisTolDeg ?? 15);
  let demoted = 0;
  let cantileverFixed = 0;
  const outMembers: StructureModelInput['members'] = [];
  const designMembers: NonNullable<StructureModelInput['designMembers']> = [];
  const map: MemberMap = { physical: {}, roles: {}, tags: {}, cantilever: {}, columnOfNode: {} };
  for (const c of columns) {
    const segs = segmentsOf.get(c.key)!;
    if (!segs.length) continue;
    const section = sectionOf(c.section, `기둥 ${c.key}`);
    const material = materialOf(c.material, `기둥 ${c.key}`);
    const design = designForColumn({
      segments: segs.map((s) => ({ z0_m: registry.points[s.i][2], z1_m: registry.points[s.j][2] })),
      restraintZ_m: (restraintNodes.get(c.key) ?? []).map((n) => registry.points[n][2]),
      swayK: c.swayK ?? swayK,
      K: c.K,
      Lb_m: c.Lb_m,
    });
    design.notes.forEach(assume);
    const betaDeg = c.strongAxis
      ? (Math.atan2(c.strongAxis[1], c.strongAxis[0]) * 180) / Math.PI
      : 0;
    if (c.strongAxis) assume('기둥 웨브 방향(국부 2축) = 지정한 강축 방향');
    segs.forEach((s, k) => {
      outMembers.push({
        id: s.id,
        i: registry.id(s.i),
        j: registry.id(s.j),
        section,
        material,
        role: 'column',
        kind: 'frame',
        betaDeg,
        design: design.segments[k],
        provenance: { by: 'auto', assumed: false, note: `계획 기둥 ${c.key}` },
      });
    });
    map.physical[c.key] = segs.map((s) => s.id);
    map.roles[c.key] = 'column';
    map.tags[c.key] = 'column';
    for (const n of columnVertices.get(c.key)!) map.columnOfNode[registry.id(n)] = c.key;
    designMembers.push({
      id: c.key,
      role: 'column',
      tag: 'column',
      segments: segs.map((s) => s.id),
      length_m: segs.reduce((sum, s) => sum + s.length_m, 0),
      kind: 'span',
      supports: [registry.id(segs[0].i), registry.id(segs[segs.length - 1].j)],
      Lb_m: design.Lb_m,
      K: design.K,
      Cb: 1.0,
      provenance: {
        by: c.K || c.Lb_m ? 'user' : 'auto',
        assumed: !(c.K || c.Lb_m),
        note: '구속 사이 길이 기준, 구속 레벨 위는 swayK',
      },
    });
  }
  const columnMap = new Map(columns.map((c) => [c.key, c]));
  for (const m of members) {
    const segs = segmentsOf.get(m.key)!;
    if (!segs.length) continue;
    const section = sectionOf(m.section, `부재 ${m.key}`);
    const material = materialOf(m.material, `부재 ${m.key}`);
    const role = PLAN_ROLE_TO_MODEL[m.role] ?? 'beam';
    const freeEnd = m.freeEnd ?? (m.role === 'arm' ? 'j' : undefined);
    const ends: FrameMember['ends'] = [...m.ends];
    // A cantilever hangs on its root alone: the root holds the moment and the tip carries no
    // release (a pinned root or a released tip is a mechanism), whatever the plan or joint rule say.
    if (freeEnd) {
      if (ends[0] !== 'rigid' || ends[1] !== 'rigid') cantileverFixed++;
      ends[0] = 'rigid';
      ends[1] = 'rigid';
    }
    // Joint rule (SPEC-06.4): a rigid end at an H column stays rigid only near its strong axis.
    const endNodes: [number, number] = [segs[0].i, segs[segs.length - 1].j];
    endNodes.forEach((n, e) => {
      if (freeEnd) return;
      const owner = columnOfNode.get(n);
      const column = owner === undefined ? undefined : columnMap.get(owner);
      if (ends[e] !== 'rigid' || !column?.strongAxis || strongTol === undefined) return;
      const rail = m.rail;
      const direction =
        e === 0 ? sub(rail[1], rail[0]) : sub(rail[rail.length - 2], rail[rail.length - 1]);
      if (planAngleDeg(direction, column.strongAxis) > strongTol) {
        ends[e] = 'pinned';
        demoted++;
      }
    });
    const design = designForBeam({
      segments: segs,
      ends,
      bracedAt: m.bracedAt,
      negativeZones: m.negativeZones,
      cantilever: !!freeEnd,
      Lb_m: m.Lb_m,
      K: m.K,
      Cb: m.Cb,
    });
    design.notes.forEach(assume);
    segs.forEach((s, k) => {
      const releases: Record<string, Record<string, boolean>> = {};
      if (k === 0 && ends[0] === 'pinned') releases.i = RELEASE;
      if (k === segs.length - 1 && ends[1] === 'pinned') releases.j = RELEASE;
      outMembers.push({
        id: s.id,
        i: registry.id(s.i),
        j: registry.id(s.j),
        section,
        material,
        role,
        kind: 'frame',
        betaDeg: 0,
        ...(Object.keys(releases).length ? { releases } : {}),
        design: design.segments[k],
        provenance: { by: 'auto', assumed: false, note: `계획 부재 ${m.key} (${m.role})` },
      });
    });
    map.physical[m.key] = segs.map((s) => s.id);
    map.roles[m.key] = role;
    map.tags[m.key] = m.role;
    if (freeEnd) map.cantilever[m.key] = freeEnd;
    const supports = freeEnd
      ? [registry.id(freeEnd === 'j' ? segs[0].i : segs[segs.length - 1].j)]
      : [registry.id(segs[0].i), registry.id(segs[segs.length - 1].j)];
    designMembers.push({
      id: m.key,
      role,
      tag: m.role,
      segments: segs.map((s) => s.id),
      length_m: segs.reduce((sum, s) => sum + s.length_m, 0),
      kind: freeEnd ? 'cantilever' : 'span',
      supports,
      Lb_m: design.Lb_m,
      K: design.K,
      Cb: m.Cb ?? 1.0,
      provenance: {
        by: m.Lb_m || m.K || m.Cb ? 'user' : 'auto',
        assumed: !(m.Lb_m && m.K),
        note: curved.has(m.key)
          ? `곡선 레일을 ${segs.length}조각으로 나눔(현 ≤ ${curve.maxLen_m} m, 처짐 ≤ ${curve.maxSag_m * 1e3} mm)`
          : '접합점에서만 나눔',
      },
    });
  }
  if (demoted)
    assume(
      `H형강 기둥 주축 ±${strongTol}° 밖에서 붙는 단부 ${demoted}곳을 핀으로 둠(구조사무소 확인)`,
    );
  if (cantileverFixed)
    assume(`내민 부재 ${cantileverFixed}개는 핀으로 준 단부를 강접으로 둠(뿌리가 핀이면 기구)`);
  // A joint where every frame end is released is a hinge nothing holds: the first girder (else
  // the longest member) there and the member most in line with it stay continuous through it, so
  // the joint carries bending like a splice. Columns are never released.
  const rolePriority = { girder: 0, beam: 1, brace: 2, other: 3, column: 4 } as const;
  const endsAt = new Map<string, { k: number; end: 'i' | 'j' }[]>();
  outMembers.forEach((m, k) => {
    for (const end of ['i', 'j'] as const)
      endsAt.set(m[end], [...(endsAt.get(m[end]) ?? []), { k, end }]);
  });
  const segmentLength = new Map([...segmentsOf.values()].flat().map((s) => [s.id, s.length_m]));
  const pointOf = (id: string) => registry.points[Number(id.slice(1)) - 1];
  /** Unit direction of a member leaving `node`. */
  const away = (m: StructureModelInput['members'][number], node: string) =>
    unit(sub(pointOf(m.i === node ? m.j : m.i), pointOf(node)));
  const unrelease = ({ k, end }: { k: number; end: 'i' | 'j' }) => {
    const m = outMembers[k];
    const { [end]: _dropped, ...rest } = m.releases!;
    if (Object.keys(rest).length) m.releases = rest;
    else delete m.releases;
  };
  let restored = 0;
  for (const [node, at] of endsAt) {
    if (!at.every(({ k, end }) => outMembers[k].releases?.[end])) continue;
    const [first, ...others] = [...at].sort((a, b) => {
      const [ma, mb] = [outMembers[a.k], outMembers[b.k]];
      const byRole = rolePriority[ma.role] - rolePriority[mb.role];
      if (byRole) return byRole;
      return segmentLength.get(mb.id)! - segmentLength.get(ma.id)! || a.k - b.k;
    });
    unrelease(first);
    if (others.length) {
      const d = away(outMembers[first.k], node);
      const inLine = (e: { k: number }) => {
        const v = away(outMembers[e.k], node);
        return d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
      };
      unrelease([...others].sort((a, b) => inLine(a) - inLine(b))[0]);
    }
    restored++;
  }
  if (restored)
    assume(
      `모든 단부가 핀인 절점 ${restored}곳은 거더(없으면 가장 긴 부재)와 가장 곧게 잇는 부재를 연속으로 둠`,
    );
  assume('해석은 상단선 위에서 하며 편심을 무시함(상단선 기준)');
  assume('데크가 상부 플랜지를 잡는다고 보고 Cb = 1.0 가정');

  // 6. Nodes with supports.
  const supports = new Map<number, typeof PIN | typeof FIXED>();
  columns.forEach((c, k) => {
    const fixity = c.baseFixity ?? plan.baseFixity ?? 'pinned';
    supports.set(columnEnds[k].base, fixity === 'fixed' ? FIXED : PIN);
  });
  assume(`기둥 하단 = ${plan.baseFixity === 'fixed' ? '고정' : '핀'} 지점(가정)`);
  const nodes: StructureModelInput['nodes'] = registry.points.map((p, n) => ({
    id: registry.id(n),
    xyz_m: [p[0], p[1], p[2]],
    ...(supports.has(n)
      ? { support: supports.get(n), provenance: { by: 'auto' as const, assumed: true } }
      : {}),
  }));
  const restraintIds = [
    ...new Set([...restraintNodes.values()].flat().map((n) => registry.id(n))),
  ].sort();

  // 7. Loads: line loads on whole physical members, self-weight in D, notional lateral loads.
  const loads: StructureModelInput['loads'] = [];
  const gravity: Record<'D' | 'L', Map<string, number>> = { D: new Map(), L: new Map() };
  const addGravity = (pattern: 'D' | 'L', node: string, kN: number) =>
    gravity[pattern].set(node, (gravity[pattern].get(node) ?? 0) + kN);
  const segmentById = new Map([...segmentsOf.values()].flat().map((s) => [s.id, s]));
  const counts = new Map<string, number>();
  for (const load of plan.lineLoads ?? []) {
    const segs = segmentsOf.get(load.memberKey);
    if (!segs?.length) {
      error('LOAD_TARGET', `선하중 대상 부재 ${load.memberKey} 없음`);
      continue;
    }
    const n = (counts.get(`${load.case}:${load.memberKey}`) ?? 0) + 1;
    counts.set(`${load.case}:${load.memberKey}`, n);
    loads.push({
      id: `${load.case}:${load.memberKey}:${n}`,
      pattern: load.case,
      type: 'memberUniform',
      targets: segs.map((s) => s.id),
      direction: '-Z',
      value_kNpm: load.value_kNpm,
      provenance: {
        by: 'auto',
        assumed: false,
        note: load.note ?? `${load.source ?? 'other'} 선하중`,
      },
    });
    for (const s of segs) {
      const half = (load.value_kNpm * s.length_m) / 2;
      addGravity(load.case, registry.id(s.i), half);
      addGravity(load.case, registry.id(s.j), half);
    }
  }
  for (const m of outMembers) {
    const seg = segmentById.get(m.id)!;
    const section = sections.get(m.section);
    const material = materials.find((x) => x.id === m.material);
    const w = section && material ? unitWeight_kNpm(section, material) : undefined;
    if (w === undefined) continue;
    addGravity('D', m.i, (w * seg.length_m) / 2);
    addGravity('D', m.j, (w * seg.length_m) / 2);
  }
  assume('강재 자중을 D 패턴에 포함');
  const combos = plan.combos?.length ? plan.combos : DEFAULT_COMBOS;
  const notional = plan.notional === false ? undefined : (plan.notional?.ratio ?? 0.002);
  const usesNotional = {
    NX: combos.some((c) => c.factors.NX),
    NY: combos.some((c) => c.factors.NY),
  };
  const loadPatterns: StructureModelInput['loadPatterns'] = [
    { id: 'D', nature: 'D', selfWeight: true },
    { id: 'L', nature: 'L', selfWeight: false },
  ];
  for (const dir of ['X', 'Y'] as const) {
    if (!usesNotional[`N${dir}`]) continue;
    if (notional === undefined) {
      error('NOTIONAL_DISABLED', `조합이 N${dir}를 쓰지만 명목 수평하중이 꺼져 있음`);
      continue;
    }
    for (const pattern of ['D', 'L'] as const) {
      const id = `N${dir}_${pattern}`;
      loadPatterns.push({ id, nature: 'N', selfWeight: false });
      for (const [node, kN] of [...gravity[pattern]].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (Math.abs(kN) <= 1e-9) continue;
        loads.push({
          id: `${id}:${node}`,
          pattern: id,
          type: 'nodePoint',
          targets: [node],
          direction: `+${dir}`,
          value_kN: notional * kN,
          provenance: {
            by: 'auto',
            assumed: true,
            note: `명목 수평하중 ${notional} × 절점 중력(${pattern})`,
          },
        });
      }
    }
    assume(`명목 수평하중 = ${notional} × 절점 중력을 ${dir} 방향으로 가함(가정)`);
  }
  const combinations: StructureModelInput['combinations'] = combos.map((c) => {
    const terms: { pattern: string; factor: number }[] = [];
    if (c.factors.D) terms.push({ pattern: 'D', factor: c.factors.D });
    if (c.factors.L) terms.push({ pattern: 'L', factor: c.factors.L });
    for (const dir of ['X', 'Y'] as const) {
      const f = c.factors[`N${dir}`];
      if (!f || notional === undefined) continue;
      for (const pattern of ['D', 'L'] as const)
        if (c.factors[pattern])
          terms.push({ pattern: `N${dir}_${pattern}`, factor: c.factors[pattern]! * f });
    }
    if (!terms.length) error('COMBO_EMPTY', `조합 ${c.id}에 항이 없음`);
    return { id: c.id, terms, limitState: c.use };
  });

  const model: StructureModelInput = {
    schema: 'vide.structure.model/1',
    meta: { name: plan.name ?? 'frame', sources: plan.sources ?? [], mergeTolerance_m: tol },
    materials,
    sections: plan.sections,
    nodes,
    members: outMembers,
    loadPatterns,
    loads,
    areaLoads: [],
    combinations,
    analysis: {
      kind: 'linearStatic',
      ...(restraintIds.length
        ? { lateralRestraint: { nodes: restraintIds, dofs: ['dx', 'dy'] } }
        : {}),
    },
    designMembers,
    checkSettings: {
      code: 'KDS 14 31 10',
      deflectionLimits: plan.deflectionLimits ?? { beam: 360, girder: 360, other: 240 },
      colorBands: plan.colorBands ?? [0.7, 1.0],
    },
  };
  if (restraintIds.length)
    assume(`수평 구속(X·Y)은 지정 레벨의 기둥 절점 ${restraintIds.length}개에만 둠`);
  if (!outMembers.length) error('NO_MEMBERS', '계획에 부재가 없음');
  return { model, map, assumptions, issues };
}

/** The member map of a model from its `designMembers` (or one entry per member when absent). */
export function memberMapFrom(model: Pick<StructureModel, 'designMembers' | 'members'>): MemberMap {
  const map: MemberMap = { physical: {}, roles: {}, tags: {}, cantilever: {}, columnOfNode: {} };
  const byId = new Map(model.members.map((m) => [m.id, m]));
  if (!model.designMembers.length) {
    for (const m of model.members) {
      map.physical[m.id] = [m.id];
      map.roles[m.id] = m.role;
      if (m.role === 'column') {
        map.columnOfNode[m.i] = m.id;
        map.columnOfNode[m.j] = m.id;
      }
    }
    return map;
  }
  for (const d of model.designMembers) {
    map.physical[d.id] = [...d.segments];
    map.roles[d.id] = d.role;
    if (d.tag) map.tags[d.id] = d.tag;
    if (d.kind === 'cantilever') {
      const first = byId.get(d.segments[0]);
      map.cantilever[d.id] = first && d.supports[0] === first.i ? 'j' : 'i';
    }
    if (d.role === 'column')
      for (const id of d.segments) {
        const m = byId.get(id);
        if (!m) continue;
        map.columnOfNode[m.i] = d.id;
        map.columnOfNode[m.j] = d.id;
      }
  }
  return map;
}
