// The region editor's model (SPEC-09.3, PLAN-26 T-090 (a)) without the screen: regions A, B, C…
// as vector shapes in image fractions, an undo/redo history of whole states (a stroke, a region
// added or deleted, a note), the screen-to-image coordinate change and the drawing of the regions
// as SVG paths and on a canvas (the flattened input image). Kept free of React and the DOM tree so
// it is tested on its own (tests/core/reference-mask.test.mjs).
import {
  effectiveRegions,
  regionLetter,
  type ReferenceBoard,
  type ReferenceRegion,
  type ReferenceShape,
} from '../contracts/reference-board.ts';

export interface MaskState {
  regions: ReferenceRegion[];
  nextIndex: number;
  /** The region new strokes go to (not part of the undo history's meaning, but restored with it). */
  active?: string;
}
export interface MaskHistory {
  past: MaskState[];
  present: MaskState;
  future: MaskState[];
}
/** Older steps than this are dropped (the regions themselves stay). */
const HISTORY_LIMIT = 200;

export const maskState = (board: Pick<ReferenceBoard, 'regions' | 'nextIndex'>): MaskState => ({
  regions: board.regions,
  nextIndex: Math.max(board.nextIndex, board.regions.length),
  active: board.regions.at(-1)?.letter,
});
export const createHistory = (present: MaskState): MaskHistory => ({
  past: [],
  present,
  future: [],
});
/** One step: the new state goes on top; what was undone cannot be redone any more. */
export function commit(history: MaskHistory, next: MaskState): MaskHistory {
  if (next === history.present) return history;
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
  };
}
export function undo(history: MaskHistory): MaskHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}
export function redo(history: MaskHistory): MaskHistory {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}

/** A new empty region with the next letter; it becomes the active one. */
export function addRegion(state: MaskState): MaskState {
  const letter = regionLetter(state.nextIndex);
  return {
    regions: [...state.regions, { letter, note: '', shapes: [] }],
    nextIndex: state.nextIndex + 1,
    active: letter,
  };
}
/**
 * Adds a drawn shape to the active region. Drawing with no region (or an eraser stroke with none)
 * starts region A, B… first; an eraser stroke with no region erases nothing.
 */
export function addShape(state: MaskState, shape: ReferenceShape): MaskState {
  const target = state.regions.find((region) => region.letter === state.active);
  if (!target) {
    if (shape.kind === 'erase') return state;
    return addShape(addRegion(state), shape);
  }
  if (shape.kind === 'erase' && !target.shapes.some((entry) => entry.kind !== 'erase'))
    return state;
  return {
    ...state,
    regions: state.regions.map((region) =>
      region === target ? { ...region, shapes: [...region.shapes, shape] } : region,
    ),
  };
}
/** Removes a region; its letter is not used again (later letters do not move up). */
export function deleteRegion(state: MaskState, letter: string): MaskState {
  const index = state.regions.findIndex((region) => region.letter === letter);
  if (index < 0) return state;
  const regions = state.regions.filter((_, k) => k !== index);
  return {
    ...state,
    regions,
    active: state.active === letter ? (regions[index] ?? regions[index - 1])?.letter : state.active,
  };
}
export function setNote(state: MaskState, letter: string, note: string): MaskState {
  const text = note.replace(/\s+/g, ' ').slice(0, 500);
  const region = state.regions.find((entry) => entry.letter === letter);
  if (!region || region.note === text) return state;
  return {
    ...state,
    regions: state.regions.map((entry) => (entry === region ? { ...entry, note: text } : entry)),
  };
}
/** Choosing a region is not a step of the history. */
export const selectRegion = (state: MaskState, letter: string): MaskState =>
  state.regions.some((region) => region.letter === letter) ? { ...state, active: letter } : state;

/** A point on screen as fractions of the shown image's box (its on-screen rectangle). */
export function toImage(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
): [number, number] {
  const clamp = (value: number) => Math.min(1.05, Math.max(-0.05, value));
  return [
    clamp((clientX - box.left) / Math.max(1, box.width)),
    clamp((clientY - box.top) / Math.max(1, box.height)),
  ];
}
/** Drops points closer than `step` (in fractions) to the last kept one; the last point stays. */
export function thin(points: readonly number[], step: number): number[] {
  if (points.length <= 4) return [...points];
  const kept = [points[0], points[1]];
  for (let i = 2; i < points.length - 2; i += 2) {
    const dx = points[i] - kept[kept.length - 2];
    const dy = points[i + 1] - kept[kept.length - 1];
    if (dx * dx + dy * dy >= step * step) kept.push(points[i], points[i + 1]);
  }
  kept.push(points[points.length - 2], points[points.length - 1]);
  return kept.map((value) => Math.round(value * 100_000) / 100_000);
}
/** The rectangle between two corners as a shape (any drag direction). */
export function rectShape(a: [number, number], b: [number, number]): ReferenceShape {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const [x0, x1] = [clamp(Math.min(a[0], b[0])), clamp(Math.max(a[0], b[0]))];
  const [y0, y1] = [clamp(Math.min(a[1], b[1])), clamp(Math.max(a[1], b[1]))];
  return { kind: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
/** Whether a drawn shape is too small to keep (a click without a drag). */
export function negligible(shape: ReferenceShape): boolean {
  if (shape.kind === 'rect') return shape.w < 0.004 || shape.h < 0.004;
  if (shape.kind === 'lasso') {
    const { width, height } = extent(shape.points);
    return shape.points.length < 6 || width < 0.004 || height < 0.004;
  }
  return shape.points.length < 2;
}
function extent(points: readonly number[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxY = Math.max(maxY, points[i + 1]);
  }
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}
/**
 * Where a region's letter sits: the top-left corner of what it covers (eraser strokes aside), in
 * fractions, kept inside the image. The whole image (no region drawn) has it top-left.
 */
export function badgeAnchor(region: Pick<ReferenceRegion, 'shapes'>): [number, number] {
  let minX = Infinity,
    minY = Infinity;
  for (const shape of region.shapes) {
    if (shape.kind === 'erase') continue;
    if (shape.kind === 'rect') {
      minX = Math.min(minX, shape.x);
      minY = Math.min(minY, shape.y);
      continue;
    }
    const half = shape.kind === 'brush' ? shape.width / 2 : 0;
    const box = extent(shape.points);
    minX = Math.min(minX, box.minX - half);
    minY = Math.min(minY, box.minY - half);
  }
  if (!Number.isFinite(minX)) return [0.03, 0.04];
  return [Math.min(0.97, Math.max(0.03, minX)), Math.min(0.96, Math.max(0.04, minY))];
}

/**
 * The SVG path data of a shape in a box of `width` × `height` units (the image's pixels), and
 * whether it is a stroke (brush, eraser) of `strokeWidth` units or a filled area.
 */
export function shapePath(
  shape: ReferenceShape,
  width: number,
  height: number,
): { d: string; stroke?: number } {
  const long = Math.max(width, height);
  const at = (points: readonly number[]) => {
    let d = '';
    for (let i = 0; i + 1 < points.length; i += 2)
      d += `${i ? 'L' : 'M'}${round(points[i] * width)} ${round(points[i + 1] * height)}`;
    return d;
  };
  if (shape.kind === 'rect')
    return {
      d: `M${round(shape.x * width)} ${round(shape.y * height)}h${round(shape.w * width)}v${round(shape.h * height)}h${round(-shape.w * width)}Z`,
    };
  if (shape.kind === 'lasso') return { d: at(shape.points) + 'Z' };
  // A single point is a dot: a zero-length segment with round caps.
  const points = shape.points.length === 2 ? [...shape.points, ...shape.points] : shape.points;
  return { d: at(points), stroke: round(shape.width * long) };
}
const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Layers of a region for drawing in order: each eraser stroke removes what came before it in the
 * same region. Returned as groups `[paint shapes, eraser strokes that follow them]`.
 */
export function regionLayers(region: Pick<ReferenceRegion, 'shapes'>) {
  const layers: { paint: ReferenceShape[]; erase: ReferenceShape[] }[] = [];
  for (const shape of region.shapes) {
    const last = layers.at(-1);
    if (shape.kind === 'erase') {
      if (last) last.erase.push(shape);
    } else if (!last || last.erase.length) layers.push({ paint: [shape], erase: [] });
    else last.paint.push(shape);
  }
  return layers;
}

/** The colours of the flattened image (from tokens.css through src/ui/tokens.ts). */
export interface FlattenColors {
  accent: string;
  /** The letter on the badge. */
  ink: string;
}
/** Region fill opacity over the image (the editor shows the same through `--accent-muted`). */
export const REGION_ALPHA = 0.38;
/**
 * Draws the image with its regions and letters on `canvas` (the flattened input image for the AI,
 * SPEC-09.7 2): `width` × `height` pixels. With no region drawn the whole image is region A.
 */
export function drawFlattened(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  regions: readonly ReferenceRegion[],
  width: number,
  height: number,
  colors: FlattenColors,
) {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw Error('canvas');
  context.drawImage(image, 0, 0, width, height);
  const shown = effectiveRegions(regions);
  const layer = document.createElement('canvas');
  layer.width = width;
  layer.height = height;
  const paint = layer.getContext('2d')!;
  for (const region of shown) {
    if (region.whole) continue;
    paint.clearRect(0, 0, width, height);
    for (const group of regionLayers(region)) {
      paint.globalCompositeOperation = 'source-over';
      for (const shape of group.paint) trace(paint, shape, width, height, colors.accent);
      paint.globalCompositeOperation = 'destination-out';
      for (const shape of group.erase) trace(paint, shape, width, height, colors.accent);
    }
    paint.globalCompositeOperation = 'source-over';
    context.globalAlpha = REGION_ALPHA;
    context.drawImage(layer, 0, 0);
    context.globalAlpha = 1;
  }
  const radius = Math.max(10, Math.round(Math.max(width, height) * 0.018));
  context.font = `700 ${Math.round(radius * 1.05)}px Inter, 'Noto Sans KR', sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const region of shown) {
    const [x, y] = badgeAnchor(region);
    const cx = Math.min(width - radius, Math.max(radius, x * width));
    const cy = Math.min(height - radius, Math.max(radius, y * height));
    const wide = region.letter.length > 1 ? radius * 0.5 * (region.letter.length - 1) : 0;
    context.fillStyle = colors.accent;
    context.beginPath();
    context.roundRect(cx - radius - wide, cy - radius, (radius + wide) * 2, radius * 2, radius);
    context.fill();
    context.fillStyle = colors.ink;
    context.fillText(region.letter, cx, cy + 1);
  }
}
function trace(
  context: CanvasRenderingContext2D,
  shape: ReferenceShape,
  width: number,
  height: number,
  color: string,
) {
  const { d, stroke } = shapePath(shape, width, height);
  const path = new Path2D(d);
  if (stroke !== undefined) {
    context.strokeStyle = color;
    context.lineWidth = stroke;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.stroke(path);
  } else {
    context.fillStyle = color;
    context.fill(path);
  }
}
