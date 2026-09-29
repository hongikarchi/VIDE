// Input of `buildFrameModel` (SPEC-06.11 item 10): a frame plan states roles, supports, joints,
// loads and combinations explicitly. Nothing is inferred from slopes or layer names here.

import type { StructureModelInput } from '../../../contracts/structure-model.ts';
import type { Vec3 } from './geometry.ts';

export type PlanRole = 'girder' | 'edge' | 'beam' | 'arm' | 'trimmer';
export type EndCondition = 'rigid' | 'pinned';
export type LoadCase = 'D' | 'L';

export interface FrameColumn {
  /** Stable key (SPEC-07.8); becomes the design member id and the segment id prefix. */
  key: string;
  base: Vec3;
  top: Vec3;
  section: string;
  material?: string;
  /** Plan direction of the web (strong-axis bending direction); sets betaDeg and the joint rule. */
  strongAxis?: Vec3;
  baseFixity?: 'pinned' | 'fixed';
  /** Heights of lateral restraint nodes on this column, in addition to the plan-wide levels. */
  restraintZ_m?: number[];
  swayK?: number;
  /** Overrides of the effective-length factors and unbraced length (user values). */
  K?: { K2?: number; K3?: number };
  Lb_m?: number;
}

export interface FrameMember {
  key: string;
  role: PlanRole;
  /** Top-line points in order. Curved rails (sag beyond the merge tolerance) are segmented. */
  rail: Vec3[];
  section: string;
  material?: string;
  /** End conditions at the first and last rail point. */
  ends: [EndCondition, EndCondition];
  /** Top-flange lateral brace positions (secondary beam joints) as fractions of the rail length. */
  bracedAt?: number[];
  /** Negative-moment zones at rigid ends as fractions; omitted = whole length (conservative). */
  negativeZones?: [number, number][];
  /** Free end of a cantilever (arms default to 'j'); undefined = supported at both ends. */
  freeEnd?: 'i' | 'j';
  Lb_m?: number;
  K?: { K2?: number; K3?: number };
  Cb?: number;
}

export interface FrameLineLoad {
  memberKey: string;
  case: LoadCase;
  /** Downward line load (kN/m, positive = gravity). */
  value_kNpm: number;
  source?: 'area' | 'edge' | 'ceiling' | 'fill' | 'other';
  note?: string;
}

export interface FrameCombo {
  id: string;
  /** Pattern factors; NX/NY scale the notional loads derived from the D and L terms. */
  factors: { D?: number; L?: number; NX?: number; NY?: number };
  use: 'strength' | 'service';
}

export interface FramePlan {
  name?: string;
  mergeTolerance_m?: number;
  /** Sections every column and member refers to (contract shape). */
  sections: StructureModelInput['sections'];
  /** Materials; omitted = SM355 with assumed constants. */
  materials?: StructureModelInput['materials'];
  columns: FrameColumn[];
  members: FrameMember[];
  lineLoads?: FrameLineLoad[];
  /** Omitted = 1.2D+1.6L, 1.2D+1.6L+NX, 1.2D+1.6L+NY (strength) and D+L (service). */
  combos?: FrameCombo[];
  /** Notional lateral load = ratio × nodal gravity; default 0.002, false = none. */
  notional?: { ratio: number } | false;
  /** Plan-wide lateral restraint levels: column nodes at these heights are held in X and Y. */
  restraintLevels_m?: number[];
  /** Effective-length factor of column zones above the highest restraint (default 2.0). */
  swayK?: number;
  baseFixity?: 'pinned' | 'fixed';
  /** Rigid ends at H columns are kept only within this angle of the strong axis (default 15°). */
  jointRule?: { strongAxisTolDeg?: number } | false;
  /** Curve segmentation limits (default 1.0 m chord, 5 mm sag). */
  curve?: { maxLen_m?: number; maxSag_m?: number };
  deflectionLimits?: Record<string, number>;
  colorBands?: [number, number];
  sources?: NonNullable<StructureModelInput['meta']['sources']>;
}

/** Physical (design) members ↔ analysis segments, as the summary and the deflection rows need it. */
export interface MemberMap {
  /** Design member id → segment ids from the first end. */
  physical: Record<string, string[]>;
  roles: Record<string, 'column' | 'girder' | 'beam' | 'brace' | 'other'>;
  tags: Record<string, string>;
  /** Free end of cantilevers. */
  cantilever: Record<string, 'i' | 'j'>;
  /** Column design member owning each column node (restraint reactions are grouped by it). */
  columnOfNode: Record<string, string>;
}

export const PLAN_ROLE_TO_MODEL: Record<PlanRole, 'girder' | 'beam'> = {
  girder: 'girder',
  edge: 'girder',
  beam: 'beam',
  arm: 'beam',
  trimmer: 'beam',
};
