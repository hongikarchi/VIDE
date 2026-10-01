import { z } from 'zod';

/**
 * The record of a reference-image board (SPEC-09.3·09.9, PLAN-26 T-090 (a)): the regions a person
 * drew over an image attachment, kept by the engine per project and attachment. Regions are vector
 * shapes over the original image, never pixels: x and y are fractions (0–1) of the image's width
 * and height, so a smaller view copy of the same image lines up; a stroke width is a fraction of
 * the image's long side. The attachment itself is never changed.
 */

/** A coordinate as a fraction of the image (a stroke may run slightly past its edge). */
const fraction = z.number().finite().min(-0.05).max(1.05);
/** x0, y0, x1, y1, … in fractions of the image. */
const points = z
  .array(fraction)
  .max(40_000)
  .refine((list) => list.length % 2 === 0, 'points are x, y pairs');
const strokeWidth = z.number().finite().min(0.0005).max(0.5);

export const referenceShapeSchema = z.discriminatedUnion('kind', [
  /** A brush stroke: a polyline of `width`. */
  z.object({ kind: z.literal('brush'), width: strokeWidth, points: points.min(2) }).strict(),
  /** A lasso: a closed polygon drawn by hand. */
  z.object({ kind: z.literal('lasso'), points: points.min(6) }).strict(),
  z
    .object({
      kind: z.literal('rect'),
      x: fraction,
      y: fraction,
      w: z.number().finite().min(0).max(1.1),
      h: z.number().finite().min(0).max(1.1),
    })
    .strict(),
  /** An eraser stroke: removes what this region drew before it (only this region). */
  z.object({ kind: z.literal('erase'), width: strokeWidth, points: points.min(2) }).strict(),
]);
export type ReferenceShape = z.infer<typeof referenceShapeSchema>;

export const regionLetterSchema = z.string().regex(/^[A-Z]{1,4}$/);
export const referenceRegionSchema = z
  .object({
    letter: regionLetterSchema,
    /** One line for the AI (optional), e.g. "루버 간격과 깊이만". */
    note: z.string().max(500),
    shapes: z.array(referenceShapeSchema).max(2_000),
  })
  .strict();
export type ReferenceRegion = z.infer<typeof referenceRegionSchema>;

/** mask = the region editor; check = the 이해 확인 board. */
export const referenceStageSchema = z.enum(['mask', 'check']);
export type ReferenceStage = z.infer<typeof referenceStageSchema>;

/** What the page saves (PUT …/reference-boards/:attachmentId). */
export const referenceBoardInputSchema = z
  .object({
    regions: z.array(referenceRegionSchema).max(1_000),
    /** The index of the next region's letter; letters of deleted regions are not reused. */
    nextIndex: z.number().int().min(0).max(100_000),
    stage: referenceStageSchema,
    /** The image's size in pixels when the regions were drawn (for reading the fractions). */
    width: z.number().int().min(1).max(100_000).optional(),
    height: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();
export type ReferenceBoardInput = z.infer<typeof referenceBoardInputSchema>;

// --- The interpretation (SPEC-09.4, PLAN-26 T-090 (b)) ---------------------------------------

/** Where a read value comes from: the user's note or correction, the image, or nobody knows. */
export const valueSourceSchema = z.enum(['user', 'estimated', 'unknown']);
export type ValueSource = z.infer<typeof valueSourceSchema>;
const text = (max: number) => z.string().trim().max(max);
/** The target the AI names when nothing tells it where in our model (SPEC-09.8 2). */
export const UNKNOWN_TARGET = 'unknown';
export const interpretedValueSchema = z
  .object({
    name: text(60).min(1),
    value: text(80),
    unit: text(20)
      .nullable()
      .optional()
      .transform((value) => value || null),
    source: valueSourceSchema,
  })
  .strict();
export type InterpretedValue = z.infer<typeof interpretedValueSchema>;
const anchorSchema = z
  .object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) })
  .strict();
export const regionInterpretationSchema = z
  .object({
    letter: regionLetterSchema,
    /** A short name of what the region is (수직 루버). */
    element: text(80).min(1),
    /** The point the bubble's leader points at (fractions); null: the region's centre. */
    anchor: anchorSchema.nullable(),
    values: z.array(interpretedValueSchema).max(12),
    /** The bubble's sentence (A: 수직 루버 · 간격 약 600 · 깊이 300 느낌). */
    line: text(200).min(1),
    /** What the image cannot decide (material, end detail…). */
    openQuestions: z.array(text(120).min(1)).max(6),
    /** Where in our model; 'unknown' when nothing says (asked before [맞음] goes on). */
    target: text(200).min(1),
  })
  .strict();
export type RegionInterpretation = z.infer<typeof regionInterpretationSchema>;
/** The `reference` field of a structured turn (checked strictly: provider output is data). */
export const referenceOutputSchema = z
  .object({
    summary: text(300).min(1),
    /** The image job's instruction (shown only under [자세히]). */
    imagePrompt: text(1500),
    regions: z.array(regionInterpretationSchema).max(200),
  })
  .strict()
  .refine((value) => new Set(value.regions.map((r) => r.letter)).size === value.regions.length);
export type ReferenceOutput = z.infer<typeof referenceOutputSchema>;

/**
 * The JSON Schema of the `reference` field the CLIs get (Claude `--json-schema`, Codex
 * `--output-schema`): strict-mode compatible, every property required, optional values nullable.
 */
export const REFERENCE_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'imagePrompt', 'regions'],
  properties: {
    summary: { type: 'string', maxLength: 300 },
    imagePrompt: { type: 'string', maxLength: 1500 },
    regions: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['letter', 'element', 'anchor', 'values', 'line', 'openQuestions', 'target'],
        properties: {
          letter: { type: 'string', maxLength: 4 },
          element: { type: 'string', maxLength: 80 },
          anchor: {
            anyOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['x', 'y'],
                properties: { x: { type: 'number' }, y: { type: 'number' } },
              },
              { type: 'null' },
            ],
          },
          values: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'value', 'unit', 'source'],
              properties: {
                name: { type: 'string', maxLength: 60 },
                value: { type: 'string', maxLength: 80 },
                unit: { type: ['string', 'null'], maxLength: 20 },
                source: { type: 'string', enum: ['user', 'estimated', 'unknown'] },
              },
            },
          },
          line: { type: 'string', maxLength: 200 },
          openQuestions: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 120 } },
          target: { type: 'string', maxLength: 200 },
        },
      },
    },
  },
} as const;

/** What a reference turn asks: the whole board, one region, or the confirmed 판 (SPEC-09.6·09.8). */
export const referenceActionSchema = z.enum(['interpret', 'region', 'confirm']);
export type ReferenceAction = z.infer<typeof referenceActionSchema>;
/** The `reference` field of a request the board sends (POST …/requests). */
export const referenceRequestSchema = z
  .object({
    attachmentId: z.string().regex(/^[0-9a-f]{24}$/),
    action: referenceActionSchema,
    /** region: the region read again and the user's one-line correction. */
    letter: regionLetterSchema.optional(),
    note: z.string().trim().min(1).max(500).optional(),
    /** confirm: the 판 confirmed and the answers to the target question cards. */
    version: z.number().int().min(1).optional(),
    targets: z.record(regionLetterSchema, z.string().trim().min(1).max(200)).optional(),
    /** interpret/region: whether a view capture was saved just before (else no image job). */
    view: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === 'region' && (!value.letter || !value.note))
      context.addIssue({ code: 'custom', message: 'A region and a note are required' });
    if (value.action === 'confirm' && value.version === undefined)
      context.addIssue({ code: 'custom', message: 'The confirmed version is required' });
  });
export type ReferenceRequest = z.infer<typeof referenceRequestSchema>;

/**
 * The image job's state for one 판 (SPEC-09.5·09.7): waiting → running → ready / failed /
 * timeout / cancelled; off (project setting), no-model (no view to draw on), remote (not run from
 * a remote session).
 */
export const imageStateSchema = z.enum([
  'waiting',
  'running',
  'ready',
  'failed',
  'timeout',
  'cancelled',
  'off',
  'no-model',
  'remote',
]);
export type ImageState = z.infer<typeof imageStateSchema>;
export const versionImageSchema = z
  .object({
    state: imageStateSchema,
    startedAt: z.string().optional(),
    elapsedMs: z.number().int().min(0).optional(),
    /** ready: the generated PNG's size in bytes. */
    size: z.number().int().min(0).optional(),
    code: z.string().max(60).optional(),
  })
  .strict();
export type VersionImage = z.infer<typeof versionImageSchema>;
export const referenceVersionSchema = z
  .object({
    /** 판 1, 판 2… */
    number: z.number().int().min(1),
    conversationId: z.string().max(100),
    requestId: z.string().max(100),
    createdAt: z.string(),
    /**
     * all: the whole board read; region: one region read again; spoken: corrected in the chat;
     * continue: a confirmed 판 carried on ([새 판으로 고치기]).
     */
    kind: z.enum(['all', 'region', 'spoken', 'continue']),
    changed: z.array(regionLetterSchema),
    summary: z.string(),
    imagePrompt: z.string(),
    regions: z.array(regionInterpretationSchema),
    confirmed: z.object({ at: z.string(), requestId: z.string() }).strict().nullable(),
    image: versionImageSchema,
  })
  .strict();
export type ReferenceVersion = z.infer<typeof referenceVersionSchema>;

export const referenceBoardSchema = referenceBoardInputSchema.extend({
  attachmentId: z.string().regex(/^[0-9a-f]{24}$/),
  updatedAt: z.string().nullable(),
  /** The flattened input image (image + regions + letters) kept beside the record, when made. */
  masked: z
    .object({
      savedAt: z.string(),
      size: z.number().int().min(0),
    })
    .nullable(),
  /** The conversation the board is bound to (its latest reference turn's, SPEC-09.2 3). */
  conversationId: z.string().max(100).nullable().default(null),
  versions: z.array(referenceVersionSchema).default([]),
  /** The reference turn on its way (답하는 중). */
  pending: z
    .object({
      requestId: z.string().max(100),
      action: referenceActionSchema,
      letter: regionLetterSchema.optional(),
      /** region: the user's correction (sent again from the board when the turn fails). */
      note: z.string().max(500).optional(),
      startedAt: z.string(),
      /** Sent from a remote session: no image job (SPEC-09.10 4). */
      remote: z.boolean().optional(),
      view: z.boolean().optional(),
    })
    .strict()
    .nullable()
    .default(null),
  /** Why the last reference turn left no 판 (말풍선을 만들지 못했습니다). */
  problem: z
    .object({
      code: z.string().max(60),
      requestId: z.string().max(100),
      at: z.string(),
      /** The turn that left it: the whole board, or one region with its correction. */
      action: referenceActionSchema.optional(),
      letter: regionLetterSchema.optional(),
      note: z.string().max(500).optional(),
    })
    .strict()
    .nullable()
    .default(null),
});
export type ReferenceBoard = z.infer<typeof referenceBoardSchema>;

/** A board with nothing drawn yet. */
export const emptyReferenceBoard = (attachmentId: string): ReferenceBoard => ({
  attachmentId,
  regions: [],
  nextIndex: 0,
  stage: 'mask',
  updatedAt: null,
  masked: null,
  conversationId: null,
  versions: [],
  pending: null,
  problem: null,
});

/** The question cards [맞음] asks first for the regions whose target is unknown (SPEC-09.8 2). */
export function targetQuestions(version: Pick<ReferenceVersion, 'regions'>) {
  return version.regions
    .filter((region) => region.target === UNKNOWN_TARGET)
    .map((region) => ({
      id: `reference-target-${region.letter}`,
      letter: region.letter,
      title: `영역 ${region.letter}(${region.element})을 우리 모델의 어디에 적용할까요?`,
      options: [
        {
          id: 'new-layer',
          label: '새 레이어에 따로 만들기',
          hint: '기존 객체는 바꾸지 않습니다',
          recommended: true,
        },
        {
          id: 'selection',
          label: '지금 Rhino에서 선택한 객체',
          hint: '실행할 때 선택된 객체를 대상으로 합니다',
          recommended: false,
        },
      ],
      blocks: '모델링 반영',
      allowFree: true,
    }));
}

/** The box a region covers (fractions x0, y0, x1, y1): for the AI and the bubble's fallback anchor. */
export function regionBox(
  region: Pick<ReferenceRegion, 'shapes'>,
): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const shape of region.shapes) {
    if (shape.kind === 'erase') continue;
    if (shape.kind === 'rect') {
      x0 = Math.min(x0, shape.x);
      y0 = Math.min(y0, shape.y);
      x1 = Math.max(x1, shape.x + shape.w);
      y1 = Math.max(y1, shape.y + shape.h);
      continue;
    }
    const half = shape.kind === 'brush' ? shape.width / 2 : 0;
    for (let i = 0; i + 1 < shape.points.length; i += 2) {
      x0 = Math.min(x0, shape.points[i] - half);
      x1 = Math.max(x1, shape.points[i] + half);
      y0 = Math.min(y0, shape.points[i + 1] - half);
      y1 = Math.max(y1, shape.points[i + 1] + half);
    }
  }
  if (!Number.isFinite(x0)) return [0, 0, 1, 1];
  const clamp = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
  return [clamp(x0), clamp(y0), clamp(x1), clamp(y1)];
}

/** The letter of the region at `index`: A…Z, then AA, AB… (no count limit, SPEC-09.3 2). */
export function regionLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new RangeError('region index');
  let letter = '';
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    letter = String.fromCharCode(65 + rest) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

/**
 * The regions the AI is given: the drawn ones, or with none drawn the whole image as region A
 * (SPEC-09.3 4).
 */
export function effectiveRegions(
  regions: readonly ReferenceRegion[],
): (ReferenceRegion & { whole?: true })[] {
  const drawn = regions.filter((region) => region.shapes.some((shape) => shape.kind !== 'erase'));
  return drawn.length ? drawn : [{ letter: 'A', note: '', shapes: [], whole: true }];
}
