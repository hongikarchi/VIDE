// Settings (설정값, SPEC-07.6, ARCH-03 §3·§4): values live in SI storage units, are shown in
// architectural units, carry who set them and on what basis, and every change is logged and can
// be undone. `fixedAtPin` values are set when the instance is made and never by a slider, a
// sentence or an AI (`PARAM_FIXED`). This module is pure; the store and routes call it.

import { DomainError } from '../../contracts/errors.ts';
import type { JigManifest, ParamDecl, ParamType } from './manifest.ts';

export interface ParamValue {
  value: number | string | boolean;
  by: 'default' | 'user' | 'decision' | 'fact' | 'ai' | 'rhino' | 'sketch';
  ref?: string;
  status?: 'ai' | 'confirmed' | 'contaminated' | 'superseded';
  at: string;
  note?: string;
}

export interface ParamChange {
  key: string;
  value: number | string | boolean;
  /** Unit of `value` when it is not the storage unit (e.g. 'mm' for a length). */
  unit?: string;
  ref?: string;
  status?: ParamValue['status'];
  note?: string;
}

export interface ParamChangeEntry {
  key: string;
  old: ParamValue | null;
  new: ParamValue;
}

/** Storage unit of each type (SI; ratio is a plain fraction, angle stays in degrees). */
export const STORAGE_UNIT: Record<ParamType, string> = {
  length: 'm',
  area: 'm2',
  force: 'kN',
  lineLoad: 'kN/m',
  areaLoad: 'kN/m2',
  angle: 'deg',
  ratio: '',
  count: 'EA',
  level: 'EL',
  choice: '',
  toggle: '',
};
/** Factor from a display unit to the storage unit. */
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

export const storageUnit = (decl: ParamDecl) => decl.unit ?? STORAGE_UNIT[decl.type];
export const displayUnit = (decl: ParamDecl) => decl.display?.unit ?? storageUnit(decl);

/** Rounded to 12 significant digits so unit factors do not leave float noise (700 mm → 0.7 m). */
const clean = (value: number) => Number(value.toPrecision(12));
export function toStorage(
  decl: ParamDecl,
  value: number,
  unit: string = displayUnit(decl),
): number {
  const factor = TO_STORAGE[unit];
  if (factor === undefined) throw new DomainError('UNIT_MISMATCH');
  return clean(value * factor);
}
export function toDisplay(decl: ParamDecl, value: number): number {
  const unit = displayUnit(decl);
  const factor = TO_STORAGE[unit] ?? 1;
  const shown = clean(value / factor);
  const decimals = decl.display?.decimals;
  return decimals === undefined ? shown : Number(shown.toFixed(decimals));
}

/** Check one value in storage units against its declaration; returns the normalised value. */
export function checkValue(decl: ParamDecl, value: unknown): number | string | boolean {
  if (decl.type === 'choice') {
    if (typeof value !== 'string' || !decl.choices?.some((c) => c.value === value))
      throw new DomainError('INVALID_INPUT');
    return value;
  }
  if (decl.type === 'toggle') {
    if (typeof value !== 'boolean') throw new DomainError('INVALID_INPUT');
    return value;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DomainError('INVALID_INPUT');
  if (decl.type === 'count' && !Number.isInteger(value)) throw new DomainError('INVALID_INPUT');
  if (decl.range && (value < decl.range.min - 1e-9 || value > decl.range.max + 1e-9))
    throw new DomainError('OUT_OF_RANGE');
  return value;
}

/** Every setting at its default (`by: 'default'`). */
export function initialParams(manifest: JigManifest, at = new Date().toISOString()) {
  const params: Record<string, ParamValue> = {};
  for (const decl of manifest.params) params[decl.key] = { value: decl.default, by: 'default', at };
  return params;
}

/** Plain values for a step: `{ key: value }` in storage units. */
export function plainValues(params: Record<string, ParamValue>) {
  return Object.fromEntries(Object.entries(params).map(([key, entry]) => [key, entry.value]));
}

export interface ApplyOptions {
  by: ParamValue['by'];
  /** True only while the instance is being made: `fixedAtPin` values may be set. */
  atPin?: boolean;
  at?: string;
}

/**
 * Apply changes to a settings record. Values arrive in the storage unit unless `unit` says
 * otherwise. Unknown keys are NOT_FOUND, fixed ones PARAM_FIXED, out-of-range OUT_OF_RANGE.
 */
export function applyChanges(
  manifest: JigManifest,
  current: Record<string, ParamValue>,
  changes: readonly ParamChange[],
  options: ApplyOptions,
): { next: Record<string, ParamValue>; entries: ParamChangeEntry[]; keys: string[] } {
  const decls = new Map(manifest.params.map((p) => [p.key, p]));
  const next = { ...current };
  const entries: ParamChangeEntry[] = [];
  const at = options.at ?? new Date().toISOString();
  for (const change of changes) {
    const decl = decls.get(change.key);
    if (!decl) throw new DomainError('NOT_FOUND');
    if (decl.fixedAtPin && !options.atPin) throw new DomainError('PARAM_FIXED');
    let value: unknown = change.value;
    if (typeof value === 'number' && change.unit !== undefined && change.unit !== storageUnit(decl))
      value = toStorage(decl, value, change.unit);
    const checked = checkValue(decl, value);
    const entry: ParamValue = {
      value: checked,
      by: options.by,
      at,
      ...(change.ref ? { ref: change.ref } : {}),
      ...(change.status ? { status: change.status } : {}),
      ...(change.note ? { note: change.note } : {}),
    };
    entries.push({ key: change.key, old: current[change.key] ?? null, new: entry });
    next[change.key] = entry;
  }
  return { next, entries, keys: entries.map((e) => e.key) };
}

/** The change that undoes a logged entry: the key back to its old value (the default when none). */
export function undoChange(
  manifest: JigManifest,
  entry: { key: string; old: unknown; new: unknown },
): ParamChange {
  const decl = manifest.params.find((p) => p.key === entry.key);
  if (!decl) throw new DomainError('NOT_FOUND');
  const old = entry.old as ParamValue | null;
  return { key: entry.key, value: old?.value ?? decl.default, note: 'undo' };
}
