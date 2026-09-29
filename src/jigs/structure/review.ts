// Model checks before confirmation (SPEC-06.2) and cause of failures after analysis (SPEC-06.7).

import type { StructureModel, StructureResult } from '../../contracts/structure-model.ts';
import { structureModelSchema } from '../../contracts/structure-model.ts';
import { analyzeStructure } from './core.ts';
import type { DraftIssue } from './input.ts';
import type { LedgerRow } from './loads.ts';

type Pt = [number, number, number];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Deterministic checks plus a stability probe with unit loads through the core. */
export function checkModel(input: unknown): { issues: DraftIssue[]; model?: StructureModel } {
  const parsed = structureModelSchema.safeParse(input);
  if (!parsed.success)
    return {
      issues: parsed.error.issues.slice(0, 50).map((i) => ({
        level: 'error' as const,
        code: 'CONTRACT',
        message: `${i.path.join('.')}: ${i.message}`,
      })),
    };
  const model = parsed.data;
  const issues: DraftIssue[] = [];
  const tol = model.meta.mergeTolerance_m;
  const nodes = new Map(model.nodes.map((n) => [n.id, n.xyz_m as Pt]));
  // Near but separate nodes: likely an unmerged joint.
  const list = model.nodes.map((n) => ({ id: n.id, p: n.xyz_m as Pt }));
  const cell = (p: Pt) => p.map((v) => Math.floor(v / (tol * 3))).join(',');
  const grid = new Map<string, typeof list>();
  for (const n of list) grid.set(cell(n.p), [...(grid.get(cell(n.p)) ?? []), n]);
  const near = new Set<string>();
  for (const n of list) {
    const [x, y, z] = n.p.map((v) => Math.floor(v / (tol * 3)));
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const m of grid.get(`${x + dx},${y + dy},${z + dz}`) ?? [])
            if (m.id > n.id && dist(m.p, n.p) <= tol * 3) near.add(`${n.id}|${m.id}`);
  }
  if (near.size)
    issues.push({
      level: 'warning',
      code: 'NEAR_NODES',
      message: `서로 ${(tol * 3 * 1e3).toFixed(0)} mm 안에 있는 별개 절점 ${near.size}쌍 — 연결되지 않은 접합일 수 있음`,
      nodes: [...near].slice(0, 40).flatMap((p) => p.split('|')),
    });
  const short = model.members.filter((m) => dist(nodes.get(m.i)!, nodes.get(m.j)!) < 0.05);
  if (short.length)
    issues.push({
      level: 'warning',
      code: 'SHORT_MEMBER',
      message: `길이 50 mm 미만 부재 ${short.length}개`,
      members: short.map((m) => m.id),
    });
  const extent = Math.max(
    ...[0, 1, 2].map(
      (k) => Math.max(...list.map((n) => n.p[k])) - Math.min(...list.map((n) => n.p[k])),
    ),
  );
  if (extent > 2000)
    issues.push({
      level: 'warning',
      code: 'UNITS',
      message: `모델 크기 ${extent.toFixed(0)} m — 단위(mm/m)를 확인`,
    });
  if (!model.nodes.some((n) => n.support && Object.values(n.support).some(Boolean)))
    issues.push({ level: 'error', code: 'NO_SUPPORT', message: '지점이 없음' });
  const placeholder = model.members.filter((m) => m.section === 'UNASSIGNED');
  if (placeholder.length)
    issues.push({
      level: 'error',
      code: 'SECTION_ASSUMED',
      message: `단면 미지정 부재 ${placeholder.length}개`,
      members: placeholder.map((m) => m.id).slice(0, 50),
    });
  const assumed =
    model.members.filter((m) => m.provenance?.assumed).length +
    model.sections.filter((s) => s.provenance?.assumed).length;
  if (assumed)
    issues.push({
      level: 'info',
      code: 'ASSUMED',
      message: `가정으로 표시된 항목 ${assumed}개 — 확인 후 확정`,
    });

  // Stability probe: unit loads in X, Y and −Z at every node, one combination.
  if (!issues.some((i) => i.level === 'error')) {
    const probe = {
      ...model,
      loadPatterns: [{ id: 'P', nature: 'D' as const, selfWeight: false }],
      loads: (['+X', '+Y', '-Z'] as const).map((direction, k) => ({
        id: `probe${k}`,
        pattern: 'P',
        type: 'nodePoint' as const,
        targets: model.nodes.map((n) => n.id),
        direction,
        value_kN: 1,
      })),
      areaLoads: [],
      combinations: [
        { id: 'P', terms: [{ pattern: 'P', factor: 1 }], limitState: 'strength' as const },
      ],
    };
    const result = analyzeStructure(probe);
    if (result.status === 'error')
      issues.push({
        level: 'error',
        code: result.diagnostics.mechanisms.length ? 'MECHANISM' : 'ANALYSIS',
        message: result.diagnostics.mechanisms.length
          ? `불안정(기구) — ${result.diagnostics.mechanisms.length}개 자유도가 구속되지 않음`
          : `해석 실패: ${result.error}`,
        nodes: [...new Set(result.diagnostics.mechanisms.map((m) => m.node))],
      });
    else if (result.diagnostics.autoRestrained.length)
      issues.push({
        level: 'info',
        code: 'AUTO_RESTRAINED',
        message: `강성이 없는 자유도 ${result.diagnostics.autoRestrained.length}개를 자동 구속(트러스 절점 회전 등)`,
      });
  }
  return { issues, model };
}

/** Tag each failing member as a member shortfall or an input/model suspicion (SPEC-06.7). */
export function classifyFailures(
  model: StructureModel,
  result: StructureResult,
  ledger: LedgerRow[] = [],
): StructureResult {
  const sections = new Map(model.sections.map((s) => [s.id, s]));
  const members = new Map(model.members.map((m) => [m.id, m]));
  const leak = ledger.filter((row) => Math.abs(row.undelivered_kN) > 0.01 * Math.abs(row.input_kN));
  const restrained = new Set(result.diagnostics.autoRestrained.map((d) => d.node));
  const checks = result.checks.map((check) => {
    if (check.status !== 'fail') return check;
    const member = members.get(check.member);
    const notes: string[] = [];
    if (member && sections.get(member.section)?.provenance?.assumed) notes.push('단면이 가정값');
    if (member?.provenance?.assumed) notes.push('역할이 가정값');
    if (member && (restrained.has(member.i) || restrained.has(member.j)))
      notes.push('자동 구속된 절점에 연결');
    if ((check.ratio ?? 0) > 5) notes.push('검정비가 비정상적으로 큼(5 초과)');
    if (leak.length)
      notes.push(`면하중 일부가 부재로 전달되지 않음(${leak.map((l) => l.area).join(', ')})`);
    if (model.materials.some((m) => m.provenance?.assumed)) notes.push('재료 상수가 가정값');
    const suspect = notes.some((n) => !n.startsWith('재료'));
    return {
      ...check,
      cause: suspect ? ('input-suspect' as const) : ('member' as const),
      notes: [...check.notes, ...notes],
    };
  });
  return { ...result, checks };
}
