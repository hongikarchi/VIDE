// 패널링의 내부 계약 (SPEC-16, PLAN-49 T-250~T-258). The builders of each wave share these shapes:
//
//   surface read (T-251)  — the picked Rhino face, sampled on a UV grid           → `SurfaceSample`
//   stage 1 (T-252)       — `SurfaceSample` + `PreviewSettings`                    → `PanelLayout`
//   stage 2 (T-254)       — `PanelLayout` + `MemberSettings`                       → `MemberSet`
//   stage 3 (T-256)       — `MemberSet` + `OptimizeSettings`                       → `PanelTyping`
//   screen (T-253), make (T-255·T-257) — read the outputs above
//
// Units (SPEC-16.2 공통 규칙): every length here is metres — coordinates, sizes, thickness, joint,
// and the person's tolerances (flatnessTol, typeTol) too; the screen shows mm. Areas m², curvature
// 1/m, angles degrees. Coordinates are world metres of the linked document (`toMeters` converts the
// document unit). UV values are the face's own parameters (never assume a 0..1 domain); on a closed
// direction a panel's UV may run past the domain end by at most one period (the maker wraps it).
// Geometric equality (same vertex, zero edge, closed solid) uses `geomTol(sample)`, never the
// person's tolerances. Outlines are counter-clockwise seen from the reference normal (the face
// normal, reversed when `direction.flip`), starting at the vertex nearest the start corner.
// Settings carry their 출처 (SPEC-16.4): an `assumed` value may drive a preview, never a member make.

import { z } from 'zod';

const finite = z.number().finite();
const vec3 = z.tuple([finite, finite, finite]);
const vec2 = z.tuple([finite, finite]);
const hash = z.string().regex(/^[a-f0-9]{8,64}$/);
const iso = z.string().min(10).max(40);
const interval = z.tuple([finite, finite]).refine(([a, b]) => b > a, 'interval must increase');
/** `P-<row>-<col>` counted from 1 at the start corner, `a`/`b` for triangle halves, `+r-c` for a
 *  merged cut panel, `F<face>-` when several faces are picked (SPEC-16.5 2). */
const panelId = z
  .string()
  .regex(/^(F\d{1,3}-)?P-[1-9]\d{0,3}-[1-9]\d{0,3}[ab]?(\+[1-9]\d{0,3}-[1-9]\d{0,3}[ab]?)*$/);
/** Lattice vertex key (SPEC-16.5 5): `<face>:<i>:<j>`, `<face>:x:<key>|<key>:<n>`, `<face>:t:<loop>:<n>`. */
const vertexKey = z.string().min(5).max(200);
const typeId = z.string().regex(/^T-\d{2,4}$/);

/** Hard cap on panels per work copy (SPEC-16.10). */
export const PANEL_LIMIT = 20000;
/** Cap on sample points per read, all faces together (SPEC-16.3 2). */
export const SAMPLE_LIMIT = 65536;
/** Cap on outline vertices per panel (SPEC-16.10). */
export const OUTLINE_LIMIT = 64;
/** Lower bound of the geometric tolerance, metres (0.1 mm). */
export const GEOM_TOL_MIN = 0.0001;

// ── 기준 면 표본 (SPEC-16.3) ────────────────────────────────────────────────────────────────────

/** One sampled face: an `nu × nv` grid at equal parameter steps, row-major (`i` along U, then `j` along V). */
export const surfaceFaceSampleSchema = z
  .object({
    faceIndex: z.number().int().nonnegative(),
    domainU: interval,
    domainV: interval,
    nu: z.number().int().min(2).max(512),
    nv: z.number().int().min(2).max(512),
    /** Periodic direction (seam), e.g. a full cylinder around U. */
    closedU: z.boolean(),
    closedV: z.boolean(),
    /** Sides collapsed to a point (pole), e.g. a sphere's ends. */
    singular: z
      .object({ uMin: z.boolean(), uMax: z.boolean(), vMin: z.boolean(), vMax: z.boolean() })
      .strict(),
    /** Sample positions xyz, length 3·nu·nv. */
    points: z.array(finite),
    /** Unit normals xyz (after the face's `OrientationIsReversed`), length 3·nu·nv. */
    normals: z.array(finite),
    /** Signed principal curvatures k1 ≥ k2 (1/m) against `normals` (+ = centre on the normal side),
     *  length 2·nu·nv. */
    curvatures: z.array(finite),
    /** 1 = inside the trim, 0 = trimmed away, length nu·nv. */
    inside: z.array(z.union([z.literal(0), z.literal(1)])),
    /** Trim boundary loops in UV (outer first). */
    trimLoops: z.array(z.array(vec2).min(3)).max(500),
    /** Computed by the host function the make template also uses (SPEC-16.3 2). */
    geometryHash: hash,
  })
  .strict()
  .superRefine((f, ctx) => {
    const n = f.nu * f.nv;
    if (f.points.length !== 3 * n) ctx.addIssue({ code: 'custom', message: 'points length' });
    if (f.normals.length !== 3 * n) ctx.addIssue({ code: 'custom', message: 'normals length' });
    if (f.curvatures.length !== 2 * n)
      ctx.addIssue({ code: 'custom', message: 'curvatures length' });
    if (f.inside.length !== n) ctx.addIssue({ code: 'custom', message: 'inside length' });
  });
export type SurfaceFaceSample = z.infer<typeof surfaceFaceSampleSchema>;

export const surfaceSampleSchema = z
  .object({
    schema: z.literal('vide.paneling.surface@1'),
    source: z
      .object({
        linkId: z.string().min(1).max(200),
        documentKey: z.string().min(1).max(200),
        objectId: z.string().uuid(),
        revisionKey: z.string().min(1).max(200),
        readAt: iso,
        /** Document unit → metres. */
        toMeters: finite.positive(),
        /** Document absolute tolerance, metres. */
        absTol: finite.nonnegative(),
        /** How it was read: attached Rhino template, hidden worker, … (PLAN-49 T-250). */
        path: z.enum(['attached-template', 'hidden-worker']),
      })
      .strict(),
    faces: z.array(surfaceFaceSampleSchema).min(1).max(64),
  })
  .strict()
  .refine(
    (s) => s.faces.reduce((n, f) => n + f.nu * f.nv, 0) <= SAMPLE_LIMIT,
    'too many sample points',
  );
export type SurfaceSample = z.infer<typeof surfaceSampleSchema>;

/** `tol = max(document absolute tolerance, 0.1 mm)` (SPEC-16.2 공통 규칙 2). */
export function geomTol(sample: { source: { absTol: number } }): number {
  return Math.max(sample.source.absTol, GEOM_TOL_MIN);
}

// ── 설정값과 출처 (SPEC-16.2·16.4) ─────────────────────────────────────────────────────────────

export const SETTING_SOURCES = [
  'person',
  'assumed',
  'question',
  'project-fact',
  'ai-accepted',
] as const;
export const settingSourceSchema = z.enum(SETTING_SOURCES);
export type SettingSource = z.infer<typeof settingSourceSchema>;

const sourced = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, source: settingSourceSchema }).strict();

export const PATTERNS = ['grid', 'staggered', 'diamond', 'triangle'] as const;
export const patternSchema = z.enum(PATTERNS);
export const PATTERN_LABELS: Record<z.infer<typeof patternSchema>, string> = {
  grid: '사각 격자',
  staggered: '엇갈림',
  diamond: '마름모',
  triangle: '삼각',
};

export const previewSettingsSchema = z
  .object({
    pattern: sourced(patternSchema),
    /** Module width (along the pattern axis) × height, metres; joints are centred on it (SPEC-16.6 1). */
    size: sourced(z.tuple([finite.positive(), finite.positive()])),
    /** SPEC-16.5 1: arc length along the two reference isocurves, equal parameter steps, or a projected grid. */
    measure: sourced(z.enum(['arc-length', 'parameter', 'projected'])),
    /** Plane of the projected grid; read only when `measure` is `projected`. */
    projection: sourced(z.enum(['plan-xy', 'best-vertical'])),
    direction: sourced(
      z
        .object({
          /** Pattern axis: columns (width) run along it. */
          axis: z.enum(['u', 'v']),
          /** `<u end>-<v end>` of the face domain where (s, t) = (0, 0). */
          startCorner: z.enum(['min-min', 'max-min', 'min-max', 'max-max']),
          /** Reverse the reference normal (thickness side, winding, curvature sign, mirror test). */
          flip: z.boolean(),
        })
        .strict(),
    ),
    boundary: sourced(
      z
        .object({
          rule: z.enum(['trim', 'merge', 'drop']),
          /** `merge`: a cut panel smaller than this share of a full panel's area joins its neighbour. */
          mergeBelow: finite.min(0).max(1),
        })
        .strict(),
    ),
  })
  .strict();
export type PreviewSettings = z.infer<typeof previewSettingsSchema>;

export const memberSettingsSchema = z
  .object({
    thickness: sourced(finite.positive()),
    /** `outside` = toward the reference normal. */
    thicknessSide: sourced(z.enum(['outside', 'inside'])),
    /** Joint width measured on the surface between neighbouring plate edges, metres. */
    joint: sourced(finite.min(0)),
    /** Edges on the face boundary/trim: `flush` keeps them, `half` moves them in by joint/2. */
    boundaryJoint: sourced(z.enum(['flush', 'half'])),
    /** Stock sheet width × height, metres; null = no limit. Compared either way round. */
    stock: sourced(z.tuple([finite.positive(), finite.positive()]).nullable()),
  })
  .strict();
export type MemberSettings = z.infer<typeof memberSettingsSchema>;

export const optimizeSettingsSchema = z
  .object({
    /** Metres. A panel is flat when flatness ≤ this (SPEC-16.7 1). */
    flatnessTol: sourced(finite.positive()),
    planarize: sourced(z.enum(['none', 'best-fit', 'pq'])),
    /** Metres: max corresponding-point distance after rigid alignment (SPEC-16.7 4). */
    typeTol: sourced(finite.positive()),
    maxTypes: sourced(z.number().int().positive().nullable()),
    /** Radius (m) at or above which a panel counts as flat. */
    flatRadius: sourced(finite.positive()),
    /** Degrees: rounding step for node angles and joint fold-angle bins. */
    nodeAngleStep: sourced(finite.positive()),
  })
  .strict();
export type OptimizeSettings = z.infer<typeof optimizeSettingsSchema>;

/** True when every setting of a stage was given or accepted by a person (`paneling-confirmed`). */
export function stageConfirmed(settings: Record<string, { source: SettingSource }>): boolean {
  return Object.values(settings).every((s) => s.source !== 'assumed');
}

export type PanelingStage = 'preview' | 'members' | 'optimize';
type StageSettings = Record<string, { source: SettingSource }>;

/** May this stage be made in Rhino (SPEC-16.4 3)? Preview always (tagged `vide-assumed`); members and
 *  typing only when that stage and every earlier stage is confirmed. Freshness (no '다시 계산 필요')
 *  and the face fingerprint are checked separately by the engine and the make template. */
export function makeAllowed(
  stage: PanelingStage,
  settings: { preview: StageSettings; members?: StageSettings; optimize?: StageSettings },
): boolean {
  if (stage === 'preview') return true;
  if (!settings.members || !stageConfirmed(settings.preview) || !stageConfirmed(settings.members))
    return false;
  if (stage === 'members') return true;
  return !!settings.optimize && stageConfirmed(settings.optimize);
}

/** `vide-key` of a made object (SPEC-16.9 6): kind + first 8 of the layout hash + panel id, so a new
 *  layout never reuses an old key and a stage-2/3 change replaces the same panel. */
export function makeKey(
  kind: 'preview' | 'member' | 'type' | 'cut' | 'fail' | 'joint' | 'node',
  layoutHash: string,
  ref: string,
): string {
  return `${kind}:${layoutHash.slice(0, 8)}:${ref}`;
}

// ── 실패 (SPEC-16.10) ─────────────────────────────────────────────────────────────────────────

export const PANEL_FAILURES = [
  'outside-trim',
  'dropped',
  'degenerate',
  'folded-projection',
  'thickness-curvature',
  'not-closed',
  'over-stock',
  'over-type-tol',
  'make-failed',
] as const;
export const panelFailureSchema = z
  .object({ code: z.enum(PANEL_FAILURES), message: z.string().min(1).max(300) })
  .strict();

// ── 1단계 결과 (SPEC-16.5) ─────────────────────────────────────────────────────────────────────

export const panelSchema = z
  .object({
    id: panelId,
    faceIndex: z.number().int().nonnegative(),
    /** 1-based, from the start corner: col along the pattern axis, row across it. */
    row: z.number().int().positive(),
    col: z.number().int().positive(),
    /** Outline in the face's UV parameters, closed implicitly, counter-clockwise from the reference normal. */
    uv: z.array(vec2).min(3).max(OUTLINE_LIMIT),
    /** The same outline on the surface (from the sample), metres. */
    corners: z.array(vec3).min(3).max(OUTLINE_LIMIT),
    /** One lattice key per outline vertex; neighbours, nodes and joints come from these (SPEC-16.5 5). */
    vertexKeys: z.array(vertexKey).min(3).max(OUTLINE_LIMIT),
    boundary: z.boolean(),
    /** A cell touching a collapsed side, kept as a triangle (SPEC-16.5 1). */
    pole: z.boolean(),
    mergedFrom: z.array(panelId).max(8),
    /** SPEC-16.2 공통 규칙 4: pattern-axis-aligned extents in the panel's best-fit plane. */
    width: finite.nonnegative(),
    height: finite.nonnegative(),
    area: finite.nonnegative(),
    failure: panelFailureSchema.nullable(),
  })
  .strict()
  .refine(
    (p) => p.uv.length === p.corners.length && p.uv.length === p.vertexKeys.length,
    'uv, corners and vertexKeys must have the same length',
  );
export type Panel = z.infer<typeof panelSchema>;

/** The layout's own hash (`MemberSet.layoutHash`, the middle part of `makeKey`) is the fingerprint of
 *  its `surfaceHash` (the sample's face hashes) and `settingsHash` (stage 1's), which decide it
 *  (`layoutFingerprint` in vide/paneling-kit). */
export const panelLayoutSchema = z
  .object({
    schema: z.literal('vide.paneling.layout@1'),
    surfaceHash: hash,
    settingsHash: hash,
    panels: z.array(panelSchema).max(PANEL_LIMIT),
    counts: z
      .object({
        total: z.number().int().nonnegative(),
        boundary: z.number().int().nonnegative(),
        pole: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        dropped: z.number().int().nonnegative(),
        offTarget: z.number().int().nonnegative(),
      })
      .strict(),
    sizeRange: z
      .object({ minW: finite, maxW: finite, minH: finite, maxH: finite, area: finite })
      .strict(),
    /** Module actually used when a closed direction rounded the count (SPEC-16.5 1), else the target. */
    module: z.tuple([finite.positive(), finite.positive()]),
    /** Sample spacing is coarser than half the module (SPEC-16.3 2). */
    coarseSample: z.boolean(),
  })
  .strict();
export type PanelLayout = z.infer<typeof panelLayoutSchema>;

// ── 2단계 결과 (SPEC-16.6) ─────────────────────────────────────────────────────────────────────

export const meshSchema = z
  .object({
    v: z.array(finite).max(3 * 4096),
    f: z.array(z.number().int().nonnegative()).max(3 * 8192),
  })
  .strict()
  .refine((m) => m.v.length % 3 === 0 && m.f.length % 3 === 0, 'mesh arrays come in triples')
  .refine((m) => m.f.every((i) => i < m.v.length / 3), 'mesh index out of range');

export const memberSchema = z
  .object({
    panelId,
    /** Joint-reduced outline in UV, for the make template to rebuild on the real face. */
    uv: z.array(vec2).min(3).max(OUTLINE_LIMIT),
    /** Closed solid from the sample, for preview and checks; not kept in the work copy or report. */
    solid: meshSchema.nullable(),
    /** Plate width × height (SPEC-16.2 공통 규칙 4). */
    flatSize: z.tuple([finite.nonnegative(), finite.nonnegative()]),
    flatSizeApprox: z.boolean(),
    thickness: finite.positive(),
    area: finite.nonnegative(),
    volume: finite.nonnegative(),
    /** Measured joint gap [min, max] on the surface at edge ends and middles; null without neighbours. */
    jointGap: z.tuple([finite.nonnegative(), finite.nonnegative()]).nullable(),
    /** Gap differs from the target by more than max(1 mm, 10 % of the joint) (SPEC-16.6 1). */
    jointUneven: z.boolean(),
    failure: panelFailureSchema.nullable(),
  })
  .strict();
export type Member = z.infer<typeof memberSchema>;

export const memberSetSchema = z
  .object({
    schema: z.literal('vide.paneling.members@1'),
    layoutHash: hash,
    settingsHash: hash,
    members: z.array(memberSchema).max(PANEL_LIMIT),
    /** Centre lines of the joints, metres, keyed by the two shared vertex keys. */
    joints: z
      .array(
        z
          .object({ keys: z.tuple([vertexKey, vertexKey]), line: z.array(vec3).min(2).max(256) })
          .strict(),
      )
      .max(PANEL_LIMIT * 4),
    overStock: z.array(panelId).max(PANEL_LIMIT),
  })
  .strict();
export type MemberSet = z.infer<typeof memberSetSchema>;

// ── 3단계 결과 (SPEC-16.7) ─────────────────────────────────────────────────────────────────────

export const curvatureClassSchema = z.enum(['flat', 'single', 'double']);

export const panelTypeSchema = z
  .object({
    type: typeId,
    /** Highest class among the members (classes describe, they do not split types). */
    class: curvatureClassSchema,
    count: z.number().int().positive(),
    vertexCount: z.number().int().min(3).max(OUTLINE_LIMIT),
    representative: panelId,
    /** Plate width × height of the representative. */
    size: z.tuple([finite.nonnegative(), finite.nonnegative()]),
    maxDeviation: finite.nonnegative(),
    /** The type this one mirrors, if any (mirror images are distinct types, SPEC-16.7 4). */
    mirrorOf: typeId.nullable(),
  })
  .strict();

export const typedPanelSchema = z
  .object({
    panelId,
    type: typeId,
    class: curvatureClassSchema,
    /** Max distance of the check points to the best-fit plane, metres (SPEC-16.7 1). */
    flatness: finite.nonnegative(),
    /** Max distance to neighbours' plate vertices sharing a vertex key; null when not planarized. */
    planarGap: finite.nonnegative().nullable(),
    /** Max distance of the plate's vertices from the reference surface; null when not planarized. */
    offSurface: finite.nonnegative().nullable(),
    /** Distance to the type representative after rigid alignment. */
    deviation: finite.nonnegative(),
    /** Cut outline: first vertex at the origin, pattern axis +X, front face up (SPEC-16.7 6); null when curved. */
    flat: z.array(vec2).min(3).max(OUTLINE_LIMIT).nullable(),
    failure: panelFailureSchema.nullable(),
  })
  .strict();

export const nodeTypeSchema = z
  .object({
    type: z.string().regex(/^N-\d{2,4}$/),
    valence: z.number().int().min(1).max(12),
    /** Angles between consecutive edges in the tangent plane, rotated to start at the smallest. */
    angles: z.array(finite).max(12),
    count: z.number().int().positive(),
  })
  .strict();

export const jointTypeSchema = z
  .object({
    type: z.string().regex(/^J-\d{2,4}$/),
    /** Bin of the fold angle between the two plates' normals (0 = coplanar, + = convex to the normal). */
    dihedral: interval,
    count: z.number().int().positive(),
    /** Representative edge length and the sum over the type. */
    length: finite.nonnegative(),
    totalLength: finite.nonnegative(),
  })
  .strict();

/** One node or joint occurrence, for the make template's markers. */
export const nodeAtSchema = z
  .object({ key: vertexKey, type: z.string().regex(/^N-\d{2,4}$/), at: vec3 })
  .strict();
export const jointAtSchema = z
  .object({
    keys: z.tuple([vertexKey, vertexKey]),
    panels: z.tuple([panelId, panelId]),
    type: z.string().regex(/^J-\d{2,4}$/),
    dihedral: finite,
    length: finite.nonnegative(),
  })
  .strict();

export const panelTypingSchema = z
  .object({
    schema: z.literal('vide.paneling.typing@1'),
    membersHash: hash,
    settingsHash: hash,
    panels: z.array(typedPanelSchema).max(PANEL_LIMIT),
    types: z.array(panelTypeSchema).max(PANEL_LIMIT),
    nodes: z.array(nodeTypeSchema).max(5000),
    joints: z.array(jointTypeSchema).max(5000),
    nodeAt: z.array(nodeAtSchema).max(PANEL_LIMIT * 2),
    jointAt: z.array(jointAtSchema).max(PANEL_LIMIT * 4),
    overTypeTol: z.array(panelId).max(PANEL_LIMIT),
    /** Set when `maxTypes` could not be met (vertex counts differ): the smallest reachable count. */
    maxTypesUnmet: z.number().int().positive().nullable(),
  })
  .strict();
export type PanelTyping = z.infer<typeof panelTypingSchema>;

/** Object attribute names the make templates write (SPEC-16.9 4, ARCH-03 §9.1 rules). */
export const PANEL_ATTRS = [
  'vide-panel-id',
  'vide-panel-type',
  'vide-panel-class',
  'vide-panel-size',
  'vide-thickness',
  'vide-joint',
  'vide-flatness-mm',
  'vide-deviation-mm',
  'vide-assumed',
  'vide-status',
] as const;

/** Schedule CSV columns (SPEC-16.7 7, 16.11): key and Korean header with unit. Lengths are written in
 *  mm (1 decimal), areas m² (3 decimals), angles ° (1 decimal); UTF-8 with BOM, comma separated. */
export const SCHEDULE_COLUMNS = {
  panels: [
    ['id', '번호'],
    ['face', '면'],
    ['row', '행'],
    ['col', '열'],
    ['boundary', '경계'],
    ['type', '타입'],
    ['class', '등급'],
    ['width', '가로(mm)'],
    ['height', '세로(mm)'],
    ['plateWidth', '판 가로(mm)'],
    ['plateHeight', '판 세로(mm)'],
    ['thickness', '두께(mm)'],
    ['area', '면적(m²)'],
    ['flatness', '평면도(mm)'],
    ['planarGap', '평면화 틈(mm)'],
    ['offSurface', '면에서 벗어남(mm)'],
    ['jointGapMin', '줄눈 틈 최소(mm)'],
    ['jointGapMax', '줄눈 틈 최대(mm)'],
    ['sampleDeviation', '표본 차이(mm)'],
    ['status', '상태'],
    ['reason', '이유'],
  ],
  types: [
    ['type', '타입'],
    ['count', '수'],
    ['class', '등급'],
    ['vertexCount', '꼭짓점 수'],
    ['representative', '대표 패널'],
    ['plateWidth', '판 가로(mm)'],
    ['plateHeight', '판 세로(mm)'],
    ['maxDeviation', '최대 편차(mm)'],
    ['mirrorOf', '거울상 짝'],
  ],
  nodes: [
    ['type', '노드 타입'],
    ['count', '수'],
    ['valence', '만나는 수'],
    ['angles', '각(°)'],
  ],
  joints: [
    ['type', '줄눈 타입'],
    ['count', '수'],
    ['dihedral', '꺾인 각 구간(°)'],
    ['length', '길이(mm)'],
    ['totalLength', '길이 합(m)'],
  ],
} as const;
