// Section area from the contract dimensions, mirroring the core's formulas (src/native/structure/
// src/section.rs) so that TypeScript-side weights (notional loads) match the core's self-weight.
// Quantity-grade only: nothing here is used for member checks.

import type { StructureModelInput } from '../../../contracts/structure-model.ts';

type SectionLike = Pick<StructureModelInput['sections'][number], 'shape' | 'dims_mm' | 'props'>;

/** Gross area in mm²; undefined when the shape needs explicit props and has none. */
export function sectionArea_mm2(section: SectionLike): number | undefined {
  if (section.props?.A_mm2) return section.props.A_mm2;
  const d = section.dims_mm;
  switch (section.shape) {
    case 'H':
    case 'BH': {
      const { h, b, tw, tf } = d;
      if (!(h > 0 && b > 0 && tw > 0 && tf > 0)) return undefined;
      const r = Math.max(0, d.r ?? 0);
      return 2 * b * tf + (h - 2 * tf) * tw + 4 * (1 - Math.PI / 4) * r * r;
    }
    case 'BOX': {
      const { h, b, t } = d;
      if (!(h > 0 && b > 0 && t > 0)) return undefined;
      return b * h - (b - 2 * t) * (h - 2 * t);
    }
    case 'PIPE': {
      const { d: od, t } = d;
      if (!(od > 0 && t > 0)) return undefined;
      return (Math.PI / 4) * (od * od - (od - 2 * t) * (od - 2 * t));
    }
    case 'ROD':
      return d.d > 0 ? (Math.PI * d.d * d.d) / 4 : undefined;
    default:
      return undefined;
  }
}

/** Weight per metre (kN/m) of a section in a material with `density_kNpm3`. */
export function unitWeight_kNpm(
  section: SectionLike,
  material: { density_kNpm3: number },
): number | undefined {
  const area = sectionArea_mm2(section);
  return area === undefined ? undefined : material.density_kNpm3 * area * 1e-6;
}
