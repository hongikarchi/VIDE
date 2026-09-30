// Capacity estimates for the sizing loop (SPEC-06.12): how a member's observed ratio scales when
// its section changes, per governing clause. The formulas mirror the core's (src/native/structure/
// src/check.rs: E3 flexural buckling, F2 lateral-torsional buckling, KL/r) so that the estimate
// lands near the next analysis, which is what decides. Nothing here is a verdict; the core's check
// stays the only judge of a member.

import type { StructureModelInput } from '../../../contracts/structure-model.ts';
import type { SectionProperties } from './section-props.ts';

export interface EstimateContext {
  /** Yield strength before the thickness rule (MPa) and the thickness rows of the material. */
  Fy_MPa: number;
  fyByThickness?: { tMax_mm: number; Fy_MPa: number }[];
  E_MPa: number;
  /** Largest K·L per axis over the member's segments (mm). */
  KL2_mm: number;
  KL3_mm: number;
  /** Largest unbraced length over the segments (mm) and Cb. */
  Lb_mm: number;
  Cb: number;
  role: string;
}

export interface EstimateSection {
  props: SectionProperties;
  /** Depth and flange thickness for the LTB terms (H only); web area for shear. */
  h_mm?: number;
  tf_mm?: number;
  web_mm2: number;
}

/** Yield strength for the thickest plate, as the core picks it. */
export function yieldStrength(
  context: Pick<EstimateContext, 'Fy_MPa' | 'fyByThickness'>,
  tMax_mm: number,
) {
  const rows = [...(context.fyByThickness ?? [])].sort((a, b) => a.tMax_mm - b.tMax_mm);
  return rows.find((r) => tMax_mm <= r.tMax_mm + 1e-9)?.Fy_MPa ?? context.Fy_MPa;
}

/** E3: critical stress for a slenderness KL/r. */
export function e3Fcr(Fy: number, E: number, slenderness: number) {
  const Fe = (Math.PI * Math.PI * E) / (slenderness * slenderness);
  return Fy / Fe <= 2.25 ? Math.pow(0.658, Fy / Fe) * Fy : 0.877 * Fe;
}

/** F2: nominal strong-axis moment (N·mm) of a doubly symmetric H with unbraced length Lb. */
export function f2Moment(section: EstimateSection, Fy: number, E: number, Lb: number, Cb: number) {
  const p = section.props;
  const Mp = Fy * p.Z3_mm3;
  if (!section.h_mm || !section.tf_mm || !(p.Cw_mm6 > 0)) return Mp;
  const Sx = p.S3_mm3;
  const ry = Math.sqrt(p.I2_mm4 / p.A_mm2);
  const rts = Math.sqrt(Math.sqrt(p.I2_mm4 * p.Cw_mm6) / Sx);
  const ho = section.h_mm - section.tf_mm;
  const jc = p.J_mm4 / (Sx * ho);
  const Lp = 1.76 * ry * Math.sqrt(E / Fy);
  const Lr =
    ((1.95 * rts * E) / (0.7 * Fy)) *
    Math.sqrt(jc + Math.sqrt(jc * jc + 6.76 * Math.pow((0.7 * Fy) / E, 2)));
  if (Lb <= Lp) return Mp;
  if (Lb <= Lr) return Math.min(Cb * (Mp - (Mp - 0.7 * Fy * Sx) * ((Lb - Lp) / (Lr - Lp))), Mp);
  const s = Lb / rts;
  const Fcr = ((Cb * Math.PI * Math.PI * E) / (s * s)) * Math.sqrt(1 + 0.078 * jc * s * s);
  return Math.min(Fcr * Sx, Mp);
}

/**
 * The quantity the observed ratio is inversely proportional to, for a clause name as the core
 * labels it. A larger value means a smaller ratio for the same demand.
 */
export function capacity(
  section: EstimateSection,
  clause: string | null,
  c: EstimateContext,
): number {
  const p = section.props;
  const Fy = yieldStrength(c, p.tMax_mm);
  const r2 = Math.sqrt(p.I2_mm4 / p.A_mm2);
  const r3 = Math.sqrt(p.I3_mm4 / p.A_mm2);
  const slenderness = Math.max(c.KL2_mm / r2, c.KL3_mm / r3);
  const key = clause ?? '';
  if (key.startsWith('세장비')) return 1 / Math.max(slenderness, 1e-9);
  if (key.startsWith('E3')) return e3Fcr(Fy, c.E_MPa, slenderness) * p.A_mm2;
  if (key.startsWith('D2')) return Fy * p.A_mm2;
  if (key.startsWith('G')) return Fy * section.web_mm2;
  if (key.startsWith('F6')) return Fy * p.Z2_mm3;
  if (key.startsWith('처짐')) return p.I3_mm4;
  const Mn = f2Moment(section, Fy, c.E_MPa, c.Lb_mm, c.Cb);
  if (key.startsWith('H1')) {
    // P/Pc + 8/9·M/Mc without the split: weight the axial term by the role.
    const w = c.role === 'column' ? 0.7 : 0.3;
    const Pn = e3Fcr(Fy, c.E_MPa, slenderness) * p.A_mm2;
    return 1 / (w / Pn + (1 - w) / Mn);
  }
  return Mn;
}

/** Estimate context of a design member from its segments in the model. */
export function estimateContext(
  model: Pick<StructureModelInput, 'nodes' | 'members' | 'materials'>,
  segments: string[],
  role: string,
): EstimateContext | undefined {
  const nodes = new Map(model.nodes.map((n) => [n.id, n.xyz_m]));
  const members = new Map(model.members.map((m) => [m.id, m]));
  const first = members.get(segments[0]);
  const material = first && model.materials.find((m) => m.id === first.material);
  if (!first || !material) return undefined;
  let KL2 = 0,
    KL3 = 0,
    Lb = 0,
    Cb = 1;
  for (const id of segments) {
    const m = members.get(id);
    const a = m && nodes.get(m.i),
      b = m && nodes.get(m.j);
    if (!m || !a || !b) continue;
    const L = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 1e3;
    KL2 = Math.max(KL2, (m.design?.K2 ?? 1) * L);
    KL3 = Math.max(KL3, (m.design?.K3 ?? 1) * L);
    Lb = Math.max(Lb, m.design?.Lb_m !== undefined ? m.design.Lb_m * 1e3 : L);
    Cb = m.design?.Cb ?? Cb;
  }
  return {
    Fy_MPa: material.Fy_MPa,
    fyByThickness: material.fyByThickness,
    E_MPa: material.E_MPa,
    KL2_mm: KL2,
    KL3_mm: KL3,
    Lb_mm: Lb,
    Cb,
    role,
  };
}
