// Section properties from the contract dimensions, mirroring the core's formulas (src/native/
// structure/src/section.rs) so that TypeScript-side weights (notional loads, schedule quantities)
// match the core's self-weight. Quantity-grade only (SPEC-06.12): nothing here is used for member
// checks; the sizing loop uses the ratios between candidates as an estimate that the next analysis
// corrects.

import type { StructureModelInput } from '../../../contracts/structure-model.ts';
import type { HSize } from '../../structure/sections.ts';

type SectionLike = Pick<StructureModelInput['sections'][number], 'shape' | 'dims_mm' | 'props'>;

export interface SectionProperties {
  A_mm2: number;
  I2_mm4: number;
  I3_mm4: number;
  J_mm4: number;
  Z2_mm3: number;
  Z3_mm3: number;
  S2_mm3: number;
  S3_mm3: number;
  Cw_mm6: number;
  /** Thickest plate (thickness-dependent yield strength). */
  tMax_mm: number;
}

/** Steel density for schedule quantities (KS D 3502 unit weights use 7,850 kg/m³). */
export const STEEL_DENSITY_KGPM3 = 7850;

/** Rolled H (with root fillets), box, pipe and rod, exactly as the core computes them. */
function computed(section: SectionLike): SectionProperties | undefined {
  const d = section.dims_mm;
  switch (section.shape) {
    case 'H':
    case 'BH': {
      const { h, b, tw, tf } = d;
      if (!(h > 0 && b > 0 && tw > 0 && tf > 0)) return undefined;
      const r = Math.max(0, d.r ?? 0);
      const hw = h - 2 * tf;
      // Root fillet: area (1 − π/4)r², centroid 0.2234r from the corner.
      const af = (1 - Math.PI / 4) * r * r;
      const cf = (r * (10 - 3 * Math.PI)) / (12 - 3 * Math.PI);
      const yf = h / 2 - tf - cf;
      const xf = tw / 2 + cf;
      const A = 2 * b * tf + hw * tw + 4 * af;
      const I3 = (b * h ** 3 - (b - tw) * hw ** 3) / 12 + 4 * af * yf * yf;
      const I2 = (2 * tf * b ** 3) / 12 + (hw * tw ** 3) / 12 + 4 * af * xf * xf;
      const Z3 = b * tf * (h - tf) + (tw * hw * hw) / 4 + 4 * af * yf;
      const Z2 = (tf * b * b) / 2 + (hw * tw * tw) / 4 + 4 * af * xf;
      const J = (2 * b * tf ** 3 + (h - tf) * tw ** 3) / 3;
      return {
        A_mm2: A,
        I2_mm4: I2,
        I3_mm4: I3,
        J_mm4: J,
        Z2_mm3: Z2,
        Z3_mm3: Z3,
        S2_mm3: I2 / (b / 2),
        S3_mm3: I3 / (h / 2),
        Cw_mm6: (I2 * (h - tf) ** 2) / 4,
        tMax_mm: Math.max(tf, tw),
      };
    }
    case 'BOX': {
      const { h, b, t } = d;
      if (!(h > 0 && b > 0 && t > 0)) return undefined;
      const [hi, bi] = [h - 2 * t, b - 2 * t];
      const [hm, bm] = [h - t, b - t];
      const I3 = (b * h ** 3 - bi * hi ** 3) / 12;
      const I2 = (h * b ** 3 - hi * bi ** 3) / 12;
      return {
        A_mm2: b * h - bi * hi,
        I2_mm4: I2,
        I3_mm4: I3,
        J_mm4: (4 * (hm * bm) ** 2 * t) / (2 * (hm + bm)),
        Z2_mm3: (h * b * b) / 4 - (hi * bi * bi) / 4,
        Z3_mm3: (b * h * h) / 4 - (bi * hi * hi) / 4,
        S2_mm3: I2 / (b / 2),
        S3_mm3: I3 / (h / 2),
        Cw_mm6: 0,
        tMax_mm: t,
      };
    }
    case 'PIPE': {
      const { d: od, t } = d;
      if (!(od > 0 && t > 0)) return undefined;
      const di = od - 2 * t;
      const I = (Math.PI / 64) * (od ** 4 - di ** 4);
      const Z = (od ** 3 - di ** 3) / 6;
      return {
        A_mm2: (Math.PI / 4) * (od * od - di * di),
        I2_mm4: I,
        I3_mm4: I,
        J_mm4: 2 * I,
        Z2_mm3: Z,
        Z3_mm3: Z,
        S2_mm3: I / (od / 2),
        S3_mm3: I / (od / 2),
        Cw_mm6: 0,
        tMax_mm: t,
      };
    }
    case 'ROD': {
      if (!(d.d > 0)) return undefined;
      const I = (Math.PI * d.d ** 4) / 64;
      const Z = d.d ** 3 / 6;
      return {
        A_mm2: (Math.PI * d.d * d.d) / 4,
        I2_mm4: I,
        I3_mm4: I,
        J_mm4: 2 * I,
        Z2_mm3: Z,
        Z3_mm3: Z,
        S2_mm3: I / (d.d / 2),
        S3_mm3: I / (d.d / 2),
        Cw_mm6: 0,
        tMax_mm: d.d,
      };
    }
    default:
      return undefined;
  }
}

/**
 * Properties of a contract section: computed from the dimensions, with explicit `props` winning
 * (missing moduli fall back to the computed ones). Undefined when the shape needs props and has none.
 */
export function sectionProps(section: SectionLike): SectionProperties | undefined {
  const base = computed(section);
  const given = section.props;
  if (!given) return base;
  return {
    A_mm2: given.A_mm2,
    I2_mm4: given.I2_mm4,
    I3_mm4: given.I3_mm4,
    J_mm4: given.J_mm4,
    Z2_mm3: given.Z2_mm3 ?? base?.Z2_mm3 ?? 0,
    Z3_mm3: given.Z3_mm3 ?? base?.Z3_mm3 ?? 0,
    S2_mm3: given.S2_mm3 ?? base?.S2_mm3 ?? 0,
    S3_mm3: given.S3_mm3 ?? base?.S3_mm3 ?? 0,
    Cw_mm6: given.Cw_mm6 ?? base?.Cw_mm6 ?? 0,
    tMax_mm: base?.tMax_mm ?? 0,
  };
}

/** Rolled H properties plus the unit weight (kg/m) for quantities — not for checks. */
export function hProps(
  size: Pick<HSize, 'h' | 'b' | 'tw' | 'tf'> & { r?: number },
  density_kgpm3 = STEEL_DENSITY_KGPM3,
): SectionProperties & { weight_kgpm: number } {
  const props = computed({
    shape: 'H',
    dims_mm: { h: size.h, b: size.b, tw: size.tw, tf: size.tf, r: size.r ?? 0 },
  })!;
  return { ...props, weight_kgpm: props.A_mm2 * 1e-6 * density_kgpm3 };
}

/** Gross area in mm²; undefined when the shape needs explicit props and has none. */
export function sectionArea_mm2(section: SectionLike): number | undefined {
  return sectionProps(section)?.A_mm2;
}

/** Weight per metre (kN/m) of a section in a material with `density_kNpm3`. */
export function unitWeight_kNpm(
  section: SectionLike,
  material: { density_kNpm3: number },
): number | undefined {
  const area = sectionArea_mm2(section);
  return area === undefined ? undefined : material.density_kNpm3 * area * 1e-6;
}
