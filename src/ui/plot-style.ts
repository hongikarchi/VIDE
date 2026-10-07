/**
 * AutoCAD Color Index palette and plot style tables (CTB) for the viewport's plot preview.
 * A CTB maps each ACI index to a pen colour and lineweight. `monochrome` mirrors monochrome.ctb.
 * A project's .ctb (SPEC-14.15 3) arrives from the engine and is checked by `parsePlotStyleTable`.
 */

/** ACI 1–255 → #rrggbb. 0 (ByBlock) and 256 (ByLayer) are not colours and return undefined. */
export function aciColor(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 1 || index > 255) return undefined;
  const hex = (r: number, g: number, b: number) =>
    '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const fixed: Record<number, [number, number, number]> = {
    1: [255, 0, 0],
    2: [255, 255, 0],
    3: [0, 255, 0],
    4: [0, 255, 255],
    5: [0, 0, 255],
    6: [255, 0, 255],
    7: [255, 255, 255],
    8: [128, 128, 128],
    9: [192, 192, 192],
    250: [51, 51, 51],
    251: [80, 80, 80],
    252: [105, 105, 105],
    253: [130, 130, 130],
    254: [190, 190, 190],
    255: [255, 255, 255],
  };
  if (fixed[index]) return hex(...fixed[index]);
  // 10–249: 24 hues × 5 values, even = full saturation, odd = half saturation.
  const hue = (Math.floor(index / 10) - 1) * 15,
    step = index % 10;
  const value = [255, 165, 127, 76, 38][Math.floor(step / 2)],
    saturation = step % 2 ? 0.5 : 1;
  const c = value * saturation,
    x = c * (1 - Math.abs(((hue / 60) % 2) - 1)),
    m = value - c;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  // AutoCAD truncates channel values (ACI 30 = #ff7f00, ACI 11 = #ff7f7f).
  return hex(Math.floor(r + m), Math.floor(g + m), Math.floor(b + m));
}

export interface PlotPen {
  /** Pen colour, or 'object' to keep the object's own colour. */
  color: string | 'object';
  /** Lineweight in mm, or 'object' to use the object's lineweight. */
  lineWeight: number | 'object';
}
export interface PlotStyleTable {
  name: string;
  /** Per-ACI overrides (1–255); missing entries use `fallback`. */
  pens: Partial<Record<number, PlotPen>>;
  fallback: PlotPen;
  /** Lineweight used when neither the pen nor the object provides one (mm). */
  defaultLineWeight: number;
}
/** monochrome.ctb: every pen plots black with the object's lineweight. */
export const monochrome: PlotStyleTable = {
  name: 'monochrome.ctb',
  pens: {},
  fallback: { color: '#000000', lineWeight: 'object' },
  defaultLineWeight: 0.25,
};
/** Resolve the printed colour and width (mm) for one object. */
export function plotPen(
  table: PlotStyleTable,
  object: { colorIndex?: number; screenColor: string; lineWeight?: number },
) {
  const pen =
    (object.colorIndex !== undefined ? table.pens[object.colorIndex] : undefined) ?? table.fallback;
  return {
    color: pen.color === 'object' ? object.screenColor : pen.color,
    lineWeight:
      pen.lineWeight === 'object'
        ? object.lineWeight && object.lineWeight > 0
          ? object.lineWeight
          : table.defaultLineWeight
        : pen.lineWeight,
  };
}
/** Preview width in screen pixels for a lineweight in mm (paper at ~96 dpi, never thinner than 1 px). */
export function lineWeightPixels(mm: number) {
  return Math.min(8, Math.max(1, mm * 3.78));
}
/**
 * The table to plot with: a project's .ctb (read by the engine, src/core/ctb.ts, and checked with
 * `parsePlotStyleTable`) or the built-in monochrome.
 */
export function plotStyleTable(table?: PlotStyleTable) {
  return table ?? monochrome;
}
const penOf = (value: unknown): PlotPen | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const { color, lineWeight } = value as Record<string, unknown>;
  const okColor =
    color === 'object' || (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color));
  const okWeight =
    lineWeight === 'object' ||
    (typeof lineWeight === 'number' && Number.isFinite(lineWeight) && lineWeight >= 0);
  return okColor && okWeight
    ? { color: color as PlotPen['color'], lineWeight: lineWeight as PlotPen['lineWeight'] }
    : undefined;
};
/** The engine's table JSON (SPEC-14.15 3) → a `PlotStyleTable`, or undefined when malformed. */
export function parsePlotStyleTable(value: unknown): PlotStyleTable | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const fallback = penOf(raw.fallback);
  if (typeof raw.name !== 'string' || !fallback || !raw.pens || typeof raw.pens !== 'object')
    return undefined;
  const pens: PlotStyleTable['pens'] = {};
  for (const [key, entry] of Object.entries(raw.pens as Record<string, unknown>)) {
    const index = Number(key),
      pen = penOf(entry);
    if (!Number.isInteger(index) || index < 1 || index > 255 || !pen) return undefined;
    pens[index] = pen;
  }
  const weight = Number(raw.defaultLineWeight);
  return {
    name: raw.name,
    pens,
    fallback,
    defaultLineWeight: Number.isFinite(weight) && weight > 0 ? weight : 0.25,
  };
}
