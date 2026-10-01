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

/**
 * mask = the region editor; check = the 이해 확인 board (phase (a): the board's frame only,
 * nothing interpreted yet).
 */
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
});

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
