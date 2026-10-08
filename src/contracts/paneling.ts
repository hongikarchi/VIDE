// 패널링의 내부 계약 (SPEC-16, PLAN-49 T-250~T-258). The builders of each wave share these shapes:
//
//   surface read (T-251)  — the picked Rhino face, sampled on a UV grid           → `SurfaceSample`
//   stage 1 (T-252)       — `SurfaceSample` + `PreviewSettings`                    → `PanelLayout`
//   stage 2 (T-254)       — `PanelLayout` + `MemberSettings`                       → `MemberSet`
//   stage 3 (T-256)       — `MemberSet` + `OptimizeSettings`                       → `PanelTyping`
//   screen (T-253), make (T-255·T-257) — read the outputs above
//
// Coordinates are world metres of the linked document (`SurfaceSample.toMeters` converts the
// document unit). UV values are the face's own parameters (never assume a 0..1 domain).
// Settings carry their 출처 (SPEC-16.4): a `assumed` value may drive a preview, never a member make.

import { z } from 'zod';

const finite = z.number().finite();
const vec3 = z.tuple([finite, finite, finite]);
const vec2 = z.tuple([finite, finite]);
const hash = z.string().regex(/^[a-f0-9]{8,64}$/);
const iso = z.string().min(10).max(40);
const interval = z.tuple([finite, finite]).refine(([a, b]) => b > a, 'interval must increase');
const panelId = z.string().regex(/^(F\d{1,3}-)?P-\d{1,4}-\d{1,4}(\+\d{1,4}-\d{1,4})*$/);

/** Hard cap on panels per work copy (SPEC-16.10). */
export const PANEL_LIMIT = 20000;

// ── 기준 면 표본 (SPEC-16.3) ────────────────────────────────────────────────────────────────────

/** One sampled face: an `nu × nv` grid, row-major (`i` along U, then `j` along V). */
export const surfaceFaceSampleSchema = z
  .object({
    faceIndex: z.number().int().nonnegative(),
    domainU: interval,
    domainV: interval,
    nu: z.number().int().min(2).max(1024),
    nv: z.number().int().min(2).max(1024),
    /** Sample positions xyz, length 3·nu·nv. */
    points: z.array(finite),
    /** Unit normals xyz (after the face's `OrientationIsReversed`), length 3·nu·nv. */
    normals: z.array(finite),
    /** Principal curvatures k1, k2 (1/m), length 2·nu·nv. */
    curvatures: z.array(finite),
    /** 1 = inside the trim, 0 = trimmed away, length nu·nv. */
    inside: z.array(z.union([z.literal(0), z.literal(1)])),
    /** Trim boundary loops in UV (outer first). */
    trimLoops: z.array(z.array(vec2).min(3)).max(500),
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
        /** How it was read: attached Rhino template, hidden worker, … (PLAN-49 T-250). */
        path: z.enum(['attached-template', 'hidden-worker']),
      })
      .strict(),
    faces: z.array(surfaceFaceSampleSchema).min(1).max(64),
  })
  .strict();
export type SurfaceSample = z.infer<typeof surfaceSampleSchema>;

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
    /** Target panel width × height, metres. */
    size: sourced(z.tuple([finite.positive(), finite.positive()])),
    measure: sourced(z.enum(['arc-length', 'parameter', 'projected'])),
    direction: sourced(
      z
        .object({
          axis: z.enum(['u', 'v']),
          startCorner: z.enum(['min-min', 'max-min', 'min-max', 'max-max']),
          flip: z.boolean(),
        })
        .strict(),
    ),
    boundary: sourced(
      z
        .object({
          rule: z.enum(['trim', 'merge', 'drop']),
          /** `merge`: a cut panel smaller than this share of a full panel joins its neighbour. */
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
    thicknessSide: sourced(z.enum(['outside', 'inside'])),
    joint: sourced(finite.min(0)),
    jointPlacement: sourced(z.enum(['centered', 'inset'])),
    /** Stock sheet width × height, metres; null = no limit. */
    stock: sourced(z.tuple([finite.positive(), finite.positive()]).nullable()),
  })
  .strict();
export type MemberSettings = z.infer<typeof memberSettingsSchema>;

export const optimizeSettingsSchema = z
  .object({
    flatnessTol: sourced(finite.positive()),
    planarize: sourced(z.enum(['none', 'best-fit', 'pq'])),
    typeTol: sourced(finite.positive()),
    maxTypes: sourced(z.number().int().positive().nullable()),
    /** Radius (m) at or above which a panel counts as flat. */
    flatRadius: sourced(finite.positive()),
    nodeAngleStep: sourced(finite.positive()),
  })
  .strict();
export type OptimizeSettings = z.infer<typeof optimizeSettingsSchema>;

/** True when every setting of a stage was given or accepted by a person (`paneling-confirmed`). */
export function stageConfirmed(settings: Record<string, { source: SettingSource }>): boolean {
  return Object.values(settings).every((s) => s.source !== 'assumed');
}

// ── 실패 (SPEC-16.10) ─────────────────────────────────────────────────────────────────────────

export const PANEL_FAILURES = [
  'outside-trim',
  'dropped',
  'degenerate',
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
    row: z.number().int().nonnegative(),
    col: z.number().int().nonnegative(),
    /** Outline in the face's UV parameters, closed implicitly. */
    uv: z.array(vec2).min(3).max(64),
    /** The same outline on the surface (from the sample), metres. */
    corners: z.array(vec3).min(3).max(64),
    boundary: z.boolean(),
    mergedFrom: z.array(panelId).max(8).default([]),
    width: finite.nonnegative(),
    height: finite.nonnegative(),
    area: finite.nonnegative(),
    failure: panelFailureSchema.nullable(),
  })
  .strict();
export type Panel = z.infer<typeof panelSchema>;

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
        failed: z.number().int().nonnegative(),
        dropped: z.number().int().nonnegative(),
        offTarget: z.number().int().nonnegative(),
      })
      .strict(),
    sizeRange: z
      .object({ minW: finite, maxW: finite, minH: finite, maxH: finite, area: finite })
      .strict(),
  })
  .strict();
export type PanelLayout = z.infer<typeof panelLayoutSchema>;

// ── 2단계 결과 (SPEC-16.6) ─────────────────────────────────────────────────────────────────────

export const meshSchema = z
  .object({ v: z.array(finite).max(3_000_000), f: z.array(z.number().int().nonnegative()) })
  .strict()
  .refine((m) => m.v.length % 3 === 0 && m.f.length % 3 === 0, 'mesh arrays come in triples')
  .refine((m) => m.f.every((i) => i < m.v.length / 3), 'mesh index out of range');

export const memberSchema = z
  .object({
    panelId,
    /** Joint-reduced outline in UV, for the make template to rebuild on the real face. */
    uv: z.array(vec2).min(3).max(64),
    /** Closed solid from the sample, for preview and checks. */
    solid: meshSchema.nullable(),
    flatSize: z.tuple([finite.nonnegative(), finite.nonnegative()]),
    flatSizeApprox: z.boolean(),
    thickness: finite.positive(),
    area: finite.nonnegative(),
    volume: finite.nonnegative(),
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
    /** Centre lines of the joints, metres. */
    joints: z.array(z.array(vec3).min(2).max(256)).max(PANEL_LIMIT * 4),
    overStock: z.array(panelId).max(PANEL_LIMIT),
  })
  .strict();
export type MemberSet = z.infer<typeof memberSetSchema>;

// ── 3단계 결과 (SPEC-16.7) ─────────────────────────────────────────────────────────────────────

export const curvatureClassSchema = z.enum(['flat', 'single', 'double']);

export const panelTypeSchema = z
  .object({
    type: z.string().regex(/^T-\d{2,4}$/),
    class: curvatureClassSchema,
    count: z.number().int().positive(),
    representative: panelId,
    size: z.tuple([finite.nonnegative(), finite.nonnegative()]),
    maxDeviation: finite.nonnegative(),
    mirrored: z.boolean(),
  })
  .strict();

export const typedPanelSchema = z
  .object({
    panelId,
    type: z.string().regex(/^T-\d{2,4}$/),
    class: curvatureClassSchema,
    flatness: finite.nonnegative(),
    planarGap: finite.nonnegative().nullable(),
    deviation: finite.nonnegative(),
    /** Cut outline in its own plane (XY, metres); null for curved panels (SPEC-16.7 6). */
    flat: z.array(vec2).min(3).max(64).nullable(),
    failure: panelFailureSchema.nullable(),
  })
  .strict();

export const nodeTypeSchema = z
  .object({
    type: z.string().regex(/^N-\d{2,4}$/),
    valence: z.number().int().min(1).max(12),
    angles: z.array(finite).max(12),
    count: z.number().int().positive(),
  })
  .strict();

export const jointTypeSchema = z
  .object({
    type: z.string().regex(/^J-\d{2,4}$/),
    dihedral: interval,
    count: z.number().int().positive(),
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
    overTypeTol: z.array(panelId).max(PANEL_LIMIT),
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
