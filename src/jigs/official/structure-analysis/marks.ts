// stableMarks (PLAN-23 T-054, SPEC-06.12): marks by role prefix and a number from 1, grouped by
// role × section × curvature (radius and rise within a tolerance), numbered in position order.
// A ledger from the previous calculation keeps the same member on the same mark (the S-18
// stable-id idea, RESEARCH-08 §3.6: same line, moved level, split, merge — matched by the chord),
// numbers are never reused, and members that appear with a new id on an old line are reported as a
// correspondence. The prefix table is a project setting and stays '가정' until the standard file is
// checked.

import type { MarkLedger, StructureModelInput } from '../../../contracts/structure-model.ts';
import type { DraftIssue } from '../../structure/input.ts';
import { memberGeometry, type MemberGeometry } from './curvature.ts';
import type { MemberMap } from './frame-plan.ts';
import { type Vec3, dist, projectOnLine } from './geometry.ts';

/** Plan tag (or role) → prefix. Assumed drawing convention (SPEC-06.12). */
export const DEFAULT_MARK_PREFIXES: Record<string, string> = {
  column: 'SC',
  girder: 'SG',
  edge: 'SEG',
  beam: 'SB',
  arm: 'SCB',
  trimmer: 'STB',
  brace: 'SV',
  other: 'SM',
};
export const MARK_PREFIX_NOTE =
  '부호 접두(SC 기둥·SG 거더·SEG 테두리보·SB 작은보·SCB 내민보·STB 개구부 보)는 표준 파일 확인 전 가정';

export interface MarkRule {
  /** Prepended to every mark, e.g. 'P1-' → 'P1-SG1'. Letters, digits, '_' and '-' only. */
  projectPrefix?: string;
  prefixes?: Record<string, string>;
  assumed?: boolean;
}

export interface MarkOptions {
  rule?: MarkRule;
  previous?: MarkLedger;
  /** Curved members within these of a group's radius and rise share its mark (default 0.05 m, 0.01 m). */
  radiusTol_m?: number;
  riseTol_m?: number;
  /** Chord matching tolerance for split/merge correspondence (default 0.02 m). */
  tol_m?: number;
}

export interface MarkCorrespondence {
  id: string;
  /** Previous design member ids on the same line. */
  from: string[];
  kind: 'same-line' | 'split' | 'merge' | 'moved';
}

export interface MarkResult {
  /** design member id → mark. */
  marks: Record<string, string>;
  ledger: MarkLedger;
  /** Members whose mark differs from the previous ledger (section or curvature changed). */
  changed: { id: string; from: string; to: string }[];
  /** Members with a new id whose chord lies on a previous member's line. */
  correspondence: MarkCorrespondence[];
  /** Marks from the previous ledger that no member carries now (their numbers stay taken). */
  retired: string[];
  assumptions: string[];
  issues: DraftIssue[];
}

type Group = MarkLedger['groups'][string];
const MARK_CHARS = /^[A-Za-z0-9_-]+$/;
const q = (v: number, cell: number) => Math.round(v / cell);

export function stableMarks(
  model: Pick<StructureModelInput, 'nodes' | 'members' | 'sections'> & {
    meta?: { mergeTolerance_m?: number };
  },
  map: MemberMap,
  options: MarkOptions = {},
): MarkResult {
  const issues: DraftIssue[] = [];
  const previous = options.previous;
  const projectPrefix = options.rule?.projectPrefix ?? previous?.rule.projectPrefix ?? '';
  const prefixes = {
    ...DEFAULT_MARK_PREFIXES,
    ...(previous?.rule.prefixes ?? {}),
    ...(options.rule?.prefixes ?? {}),
  };
  const assumed = options.rule?.assumed ?? previous?.rule.assumed ?? true;
  if (!/^[A-Za-z0-9_-]{0,20}$/.test(projectPrefix))
    issues.push({
      level: 'error',
      code: 'MARK_RULE',
      message: `프로젝트 접두 '${projectPrefix}'에 허용되지 않는 문자`,
    });
  for (const [tag, prefix] of Object.entries(prefixes))
    if (!/^[A-Za-z0-9_-]{1,10}$/.test(prefix))
      issues.push({
        level: 'error',
        code: 'MARK_RULE',
        message: `${tag}의 접두 '${prefix}'에 허용되지 않는 문자`,
      });
  const radiusTol = options.radiusTol_m ?? 0.05;
  const riseTol = options.riseTol_m ?? 0.01;
  const tol = options.tol_m ?? Math.max(0.02, 2 * (model.meta?.mergeTolerance_m ?? 0.005));

  const geometry = memberGeometry(model, map);
  const memberById = new Map(model.members.map((m) => [m.id, m]));
  const describe = (id: string): Group => {
    const role = map.roles[id] ?? 'other';
    const tag = map.tags[id];
    const prefix = prefixes[tag ?? ''] ?? prefixes[role] ?? 'SM';
    const sections = [...new Set(map.physical[id].map((s) => memberById.get(s)?.section ?? '?'))];
    if (sections.length > 1)
      issues.push({
        level: 'warning',
        code: 'MIXED_SECTION',
        message: `${id}: 조각의 단면이 다름(${sections.join(', ')}) — 첫 조각 기준으로 부호를 붙임`,
        members: [id],
      });
    const g = geometry[id];
    return {
      prefix,
      role,
      ...(tag ? { tag } : {}),
      section: sections[0],
      curved: !!g?.curved,
      ...(g?.curved
        ? { radius_m: Number(g.radius_m!.toFixed(3)), rise_m: Number(g.rise_m.toFixed(3)) }
        : {}),
    };
  };
  const same = (a: Group, b: Group) =>
    a.prefix === b.prefix &&
    a.section === b.section &&
    a.curved === b.curved &&
    (!a.curved ||
      (Math.abs((a.radius_m ?? 0) - (b.radius_m ?? 0)) <= radiusTol &&
        Math.abs((a.rise_m ?? 0) - (b.rise_m ?? 0)) <= riseTol));

  const ids = Object.keys(map.physical);
  const descriptors = new Map(ids.map((id) => [id, describe(id)]));
  const groups = new Map<string, Group>(Object.entries(previous?.groups ?? {}));
  const next: Record<string, number> = { ...(previous?.next ?? {}) };
  const marks: Record<string, string> = {};
  const changed: MarkResult['changed'] = [];

  // 1. Keep: a member with a previous mark whose group still describes it.
  const unassigned: string[] = [];
  for (const id of ids) {
    const mark = previous?.members[id];
    const group = mark ? groups.get(mark) : undefined;
    if (mark && group && same(group, descriptors.get(id)!)) marks[id] = mark;
    else unassigned.push(id);
  }
  // 2. Others in position order: an existing group of the same kind, else a new number per prefix.
  const key = (id: string) => {
    const mid: Vec3 = geometry[id]?.mid ?? [0, 0, 0];
    return [q(mid[2], 0.05), q(mid[1], 0.05), q(mid[0], 0.05)];
  };
  unassigned.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    for (let k = 0; k < 3; k++) if (ka[k] !== kb[k]) return ka[k] - kb[k];
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const id of unassigned) {
    const d = descriptors.get(id)!;
    let mark = [...groups.entries()].find(([, g]) => same(g, d))?.[0];
    if (!mark) {
      const n = (next[d.prefix] ?? 0) + 1;
      next[d.prefix] = n;
      mark = `${projectPrefix}${d.prefix}${n}`;
      groups.set(mark, d);
    }
    marks[id] = mark;
    const before = previous?.members[id];
    if (before && before !== mark) changed.push({ id, from: before, to: mark });
  }

  // 3. Correspondence: new ids on a previous member's line (split, merge, same line, moved level).
  const correspondence: MarkCorrespondence[] = [];
  const chords: MarkLedger['chords'] = {};
  for (const id of ids) {
    const g = geometry[id];
    if (g) chords[id] = [g.points[0], g.points[g.points.length - 1]];
  }
  if (previous) {
    const on = (p: Vec3, a: Vec3, b: Vec3, flat = false) => {
      const [pp, aa, bb]: Vec3[] = flat
        ? [
            [p[0], p[1], 0],
            [a[0], a[1], 0],
            [b[0], b[1], 0],
          ]
        : [p, a, b];
      const l = dist(aa, bb);
      if (l <= 0) return dist(pp, aa) <= tol;
      const { t, distance } = projectOnLine(pp, aa, bb);
      return distance <= tol && t * l >= -tol && (1 - t) * l >= -tol;
    };
    const old = Object.entries(previous.chords);
    for (const id of ids) {
      if (previous.members[id] || !chords[id]) continue;
      const [na, nb] = chords[id];
      const within = old.filter(([, [a, b]]) => on(na, a, b) && on(nb, a, b));
      if (within.length) {
        const whole = within.some(([, [a, b]]) => on(a, na, nb) && on(b, na, nb));
        correspondence.push({
          id,
          from: within.map(([pid]) => pid),
          kind: whole ? 'same-line' : 'split',
        });
        continue;
      }
      const contains = old.filter(([, [a, b]]) => on(a, na, nb) && on(b, na, nb));
      if (contains.length) {
        correspondence.push({ id, from: contains.map(([pid]) => pid), kind: 'merge' });
        continue;
      }
      const moved = old.filter(
        ([, [a, b]]) =>
          on(na, a, b, true) && on(nb, a, b, true) && on(a, na, nb, true) && on(b, na, nb, true),
      );
      if (moved.length) correspondence.push({ id, from: moved.map(([pid]) => pid), kind: 'moved' });
    }
  }

  const used = new Set(Object.values(marks));
  const retired = [...new Set(Object.values(previous?.members ?? {}))]
    .filter((m) => !used.has(m))
    .sort();
  for (const mark of used)
    if (!MARK_CHARS.test(mark))
      issues.push({
        level: 'error',
        code: 'MARK_CHARS',
        message: `부호 '${mark}'에 허용되지 않는 문자`,
      });
  if (changed.length)
    issues.push({
      level: 'info',
      code: 'MARKS_CHANGED',
      message: `부호가 바뀐 부재 ${changed.length}개(단면·곡선이 바뀜)`,
      members: changed.map((c) => c.id).slice(0, 40),
    });
  const assumptions = assumed ? [MARK_PREFIX_NOTE] : [];
  return {
    marks,
    ledger: {
      schema: 'vide.structure.marks/1',
      rule: { projectPrefix, prefixes, assumed },
      groups: Object.fromEntries(groups),
      members: marks,
      chords,
      next,
    },
    changed,
    correspondence,
    retired,
    assumptions,
    issues,
  };
}

/** Members of one mark, in the order marks were given. */
export function membersByMark(marks: Record<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, mark] of Object.entries(marks))
    if (mark) out.set(mark, [...(out.get(mark) ?? []), id]);
  return out;
}

export type { MemberGeometry };
