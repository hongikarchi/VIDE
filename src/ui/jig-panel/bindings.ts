// Reading a checked panel against an instance (SPEC-07.10): bindings to step outputs and settings,
// verdict bands (✓ 여유 · ! 주의 · ✕ 초과 · ? 미검토) from the jig's own band edges, overlay items
// for the 3D view and the plan, table columns, cell text and CSV. Pure, so tests run it in Node.

import type { OverlayItem, OverlayTone } from '../viewport.ts';
import type { ColumnSpec, LayerSpec } from '../kit/registry.ts';

/** One setting of an instance as the engine shows it (runtime `ParamView`). */
export interface PanelSetting {
  key: string;
  title: string;
  group: string;
  type: string;
  /** Storage unit (SI); `value` and `range` are in it. */
  unit: string;
  displayUnit: string;
  decimals?: number;
  value: number | string | boolean;
  displayValue: number | string | boolean;
  by: string;
  ref?: string;
  status?: string;
  at: string;
  fixedAtPin?: boolean;
  range?: { min: number; max: number; step?: number };
  choices?: { value: string; label: string }[];
  board?: boolean;
  basis?: {
    status: 'confirmed' | 'assumed' | 'chosen' | 'to-ask';
    note?: string;
    question?: string;
  };
  help?: string;
}
export interface PanelData {
  /** Latest output of each step, by step id. */
  outputs: Record<string, unknown>;
  params: readonly PanelSetting[];
  inputs?: Record<string, unknown>;
}

export type Band = 'ok' | 'warn' | 'ng' | 'na';
export const BAND_ORDER: readonly Band[] = ['ok', 'warn', 'ng', 'na'];
export const BAND_SYMBOL: Record<Band, string> = { ok: '✓', warn: '!', ng: '✕', na: '?' };
export const BAND_TEXT: Record<Band, string> = {
  ok: '여유',
  warn: '주의',
  ng: '초과',
  na: '미검토',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A dotted path inside a value (`site.polygon`, `columns.0.at`). */
export function fieldOf(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)];
    else if (isRecord(current)) current = current[segment];
    else return undefined;
  }
  return current;
}

/** The value a binding names (`$key` is the setting's stored value, like step outputs). */
export function resolve(binding: string, data: PanelData): unknown {
  if (binding === 'params') return data.params;
  if (binding.startsWith('$')) return data.params.find((p) => p.key === binding.slice(1))?.value;
  const [head, name, ...rest] = binding.split('.');
  const root =
    head === 'step' ? data.outputs[name] : head === 'inputs' ? data.inputs?.[name] : undefined;
  return rest.length ? fieldOf(root, rest.join('.')) : root;
}
/** The step a binding reads, when it reads one. */
export const stepOf = (binding: string | undefined) =>
  binding?.startsWith('step.') ? binding.split('.')[1] : undefined;

/** Band edges `[주의 시작, 초과 시작]` from a literal or a binding to two numbers. */
export function bandsOf(
  spec: string | readonly [number, number] | undefined,
  data: PanelData,
): [number, number] | undefined {
  const value = typeof spec === 'string' ? resolve(spec, data) : spec;
  return Array.isArray(value) && value.length >= 2 && finite(value[0]) && finite(value[1])
    ? [value[0], value[1]]
    : undefined;
}
export function bandOf(value: unknown, bands: readonly [number, number] | undefined): Band {
  if (!bands || !finite(value)) return 'na';
  return value < bands[0] ? 'ok' : value < bands[1] ? 'warn' : 'ng';
}
/** Items of a row list by band (the legend's counts). */
export function bandCounts(rows: readonly unknown[], field: string, bands?: [number, number]) {
  const counts: Record<Band, number> = { ok: 0, warn: 0, ng: 0, na: 0 };
  for (const row of rows) counts[bandOf(fieldOf(row, field), bands)] += 1;
  return counts;
}

export const rowsOf = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const point = (value: unknown): [number, number, number] | undefined =>
  Array.isArray(value) && value.length >= 2 && finite(value[0]) && finite(value[1])
    ? [value[0], value[1], finite(value[2]) ? value[2] : 0]
    : undefined;
/** A list of points: `[[x,y], …]`, `[[x,y,z], …]` or flat `[x,y,z, x,y,z, …]`. */
function points(value: unknown): [number, number, number][] {
  if (!Array.isArray(value)) return [];
  if (value.every(finite)) {
    const out: [number, number, number][] = [];
    for (let i = 0; i + 2 < value.length; i += 3) out.push([value[i], value[i + 1], value[i + 2]]);
    return out;
  }
  return value.flatMap((p) => {
    const at = point(p);
    return at ? [at] : [];
  });
}
const isPointList = (value: unknown) =>
  Array.isArray(value) && value.length >= 3 && value.every((p) => !!point(p));

/**
 * Triangles of a mesh layer row: `{v, f}` as given (xyz triples and index triples), or a 3D
 * outline (e.g. a panel's corners) fanned from its centre.
 */
export function meshOf(value: unknown): { v: number[]; f: number[] } | undefined {
  if (isRecord(value) && Array.isArray(value.v) && Array.isArray(value.f)) {
    const v = value.v,
      f = value.f;
    const count = Math.floor(v.length / 3);
    if (
      count >= 3 &&
      v.length % 3 === 0 &&
      f.length >= 3 &&
      f.length % 3 === 0 &&
      v.every(finite) &&
      f.every((i) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < count)
    )
      return { v: v as number[], f: f as number[] };
    return undefined;
  }
  const outline = points(value);
  if (outline.length < 3) return undefined;
  return fan(outline);
}
/** A closed outline as triangles around its centre (the centre is the last vertex). */
export function fan(outline: readonly (readonly [number, number, number])[]) {
  const n = outline.length;
  const c = [0, 0, 0];
  for (const p of outline) for (let k = 0; k < 3; k++) c[k] += p[k] / n;
  const v = [...outline.flatMap((p) => [p[0], p[1], p[2]]), c[0], c[1], c[2]];
  const f: number[] = [];
  for (let i = 0; i < n; i++) f.push(i, (i + 1) % n, n);
  return { v, f };
}

export interface LayerOptions {
  /** Colour by verdict; off shows the layer's own tone (판정색 끄기). */
  verdict: boolean;
  /** Only items of this band (the legend's 그 판정만 보기). */
  only?: Band;
}
/** Overlay items of one layer (world metres); rows without usable geometry are left out. */
export function layerItems(
  layer: LayerSpec,
  data: PanelData,
  options: LayerOptions,
): OverlayItem[] {
  const value = resolve(layer.from, data);
  const base: OverlayTone = layer.tone ?? 'ov-new';
  const bands = layer.colorBy ? bandsOf(layer.bands, data) : undefined;
  const at = layer.at ?? (layer.shape === 'point' ? 'at' : layer.shape);
  // A bare point list (e.g. an outline) is one polygon or line.
  const rows: { id: string; geometry: unknown; row?: Record<string, unknown> }[] =
    layer.shape !== 'point' && isPointList(value)
      ? [{ id: layer.key, geometry: value }]
      : rowsOf(value).map((row, i) => {
          const id = fieldOf(row, layer.id ?? 'key');
          return {
            id: typeof id === 'string' || typeof id === 'number' ? String(id) : `${layer.key}-${i}`,
            geometry: fieldOf(row, at),
            row,
          };
        });
  const items: OverlayItem[] = [];
  for (const { id, geometry, row } of rows) {
    let tone = base;
    if (layer.colorBy && row) {
      const band = bandOf(fieldOf(row, layer.colorBy), bands);
      if (options.only && band !== options.only) continue;
      if (options.verdict) tone = band;
    }
    const labelValue = layer.label && row ? fieldOf(row, layer.label) : undefined;
    const label =
      typeof labelValue === 'string' || finite(labelValue) ? String(labelValue) : undefined;
    const common = { id, tone, ...(label ? { label } : {}) };
    if (layer.shape === 'point') {
      const p = point(geometry);
      if (p) items.push({ ...common, kind: 'point', at: p });
    } else if (layer.shape === 'mesh') {
      const mesh = meshOf(geometry);
      if (mesh)
        items.push({
          ...common,
          kind: 'mesh',
          ...mesh,
          ...(layer.fill === false ? { fill: false } : {}),
        });
    } else {
      const list = points(geometry);
      if (layer.shape === 'polygon' && list.length >= 3)
        items.push({
          ...common,
          kind: 'polygon',
          points: list.map(([x, y]) => [x, y] as [number, number]),
          z: list[0][2],
          ...(layer.fill ? { fill: true } : {}),
        });
      else if (list.length >= 2)
        items.push({
          ...common,
          kind: 'polyline',
          points: list,
          ...(layer.dashed ? { dashed: true } : {}),
        });
    }
  }
  return items;
}

// --- numbers and tables --------------------------------------------------------------------------

/** Display unit → storage factor (mirrors the engine's settings table, src/jigs/runtime/params.ts). */
const TO_STORAGE: Record<string, number> = {
  m: 1,
  mm: 0.001,
  cm: 0.01,
  m2: 1,
  mm2: 1e-6,
  kN: 1,
  N: 0.001,
  'kN/m': 1,
  'kN/m2': 1,
  deg: 1,
  '': 1,
  '%': 0.01,
  EA: 1,
  EL: 1,
};
/** A stored setting value as the user reads it (e.g. 0.6 m → 600 mm). */
export function toDisplay(setting: PanelSetting, value: number): number {
  const shown = (value * (TO_STORAGE[setting.unit] ?? 1)) / (TO_STORAGE[setting.displayUnit] ?? 1);
  const clean = Number(shown.toPrecision(12));
  return setting.decimals === undefined ? clean : Number(clean.toFixed(setting.decimals));
}
export function fromDisplay(setting: PanelSetting, shown: number): number {
  return Number(
    (
      (shown * (TO_STORAGE[setting.displayUnit] ?? 1)) /
      (TO_STORAGE[setting.unit] ?? 1)
    ).toPrecision(12),
  );
}
/** Unit as written on screen. */
export const unitText = (unit: string) =>
  unit === 'deg' ? '°' : unit === 'm2' ? 'm²' : unit === 'kN/m2' ? 'kN/㎡' : unit;

export function formatNumber(value: number, decimals?: number): string {
  if (decimals !== undefined) return value.toFixed(decimals);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(3)));
}
/** Text of one table cell or KPI value; '—' when there is none. */
export function cellText(value: unknown, decimals?: number): string {
  if (value === undefined || value === null || value === '') return '—';
  if (finite(value)) return formatNumber(value, decimals);
  if (typeof value === 'boolean') return value ? '예' : '아니오';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.every(finite)) return value.map((v) => formatNumber(v, decimals ?? 2)).join(', ');
    return `${value.length}개`;
  }
  return '…';
}
/** Columns given by the panel, or the plain fields of the first rows. */
export function columnsOf(
  rows: readonly Record<string, unknown>[],
  columns?: readonly ColumnSpec[],
): ColumnSpec[] {
  if (columns?.length) return [...columns];
  const fields: string[] = [];
  for (const row of rows.slice(0, 20))
    for (const [key, value] of Object.entries(row))
      if (
        !fields.includes(key) &&
        (typeof value !== 'object' ||
          value === null ||
          (Array.isArray(value) && value.every(finite)))
      )
        fields.push(key);
  return fields.slice(0, 8).map((field) => ({ field, label: field }));
}
export const isNumeric = (rows: readonly Record<string, unknown>[], field: string) =>
  rows.length > 0 &&
  rows.slice(0, 20).every((row) => finite(fieldOf(row, field)) || fieldOf(row, field) == null);

/** CSV with a BOM for spreadsheet programs; text cells that start like a formula are quoted. */
export function toCsv(rows: readonly Record<string, unknown>[], columns: readonly ColumnSpec[]) {
  const quote = (text: string) =>
    /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  const cell = (value: unknown, column: ColumnSpec) => {
    if (finite(value))
      return column.decimals === undefined ? String(value) : value.toFixed(column.decimals);
    const text = cellText(value, column.decimals);
    const safe = text === '—' ? '' : /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return quote(safe);
  };
  const head = columns.map((c) => quote(c.unit ? `${c.label} (${unitText(c.unit)})` : c.label));
  const body = rows.map((row) => columns.map((c) => cell(fieldOf(row, c.field), c)).join(','));
  return '﻿' + [head.join(','), ...body].join('\r\n') + '\r\n';
}
