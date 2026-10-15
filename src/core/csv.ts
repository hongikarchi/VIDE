// CSV text for every table export (SPEC-07.11, PLAN-54 T-341): one cell escaper instead of one per
// screen. Spreadsheet-friendly by default: UTF-8 BOM so the Korean reads right, CRLF, a trailing
// CRLF, cells quoted only when they hold a quote, comma or line break, and text a spreadsheet would
// run as a formula (= + - @ tab CR first) kept as words with a leading apostrophe. Numbers are never
// guarded, so negative values stay numbers. Pure (no DOM, no node:): the server, the CLI and the
// browser share it.
//
// Jig-side code that runs in the jig sandbox (src/jigs/official/**, extensions/**) cannot read
// src/core and keeps its own small escaper with the same rules.

/** Which text gets a leading apostrophe; `false` turns the guard off. */
export type CsvGuard = false | RegExp | ((text: string) => boolean);

export interface CsvCellOptions {
  /** `needed` (default) quotes only cells with `"`, `,`, CR or LF; `always` quotes every cell. */
  quote?: 'needed' | 'always';
  /** Default: text starting with `= + - @`, tab or CR. */
  guard?: CsvGuard;
}
export interface CsvTextOptions extends CsvCellOptions {
  /** UTF-8 byte order mark first (default true). */
  bom?: boolean;
}

/** Text that a spreadsheet would read as a formula. */
export const FORMULA_START = /^[=+\-@\t\r]/;
const BOM = '﻿';

function guarded(text: string, guard: CsvGuard): boolean {
  if (guard === false) return false;
  return typeof guard === 'function' ? guard(text) : guard.test(text);
}

/** One CSV cell. `null`/`undefined` and non-finite numbers are empty. */
export function csvCell(value: unknown, options: CsvCellOptions = {}): string {
  const always = options.quote === 'always';
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'number') text = Number.isFinite(value) ? String(value) : '';
  else {
    text = String(value);
    if (guarded(text, options.guard ?? FORMULA_START)) text = `'${text}`;
  }
  return always || /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows as CSV text: CRLF between and after the rows, BOM first unless `bom: false`. */
export function csvText(
  rows: readonly (readonly unknown[])[],
  options: CsvTextOptions = {},
): string {
  const { bom = true, ...cell } = options;
  const lines = rows.map((row) => row.map((value) => csvCell(value, cell)).join(','));
  return (bom ? BOM : '') + lines.join('\r\n') + '\r\n';
}

/** A head row and the rows as one CSV file (BOM, CRLF). */
export function csvFile(
  head: readonly string[],
  rows: readonly (readonly unknown[])[],
  options: CsvTextOptions = {},
): string {
  return csvText([head, ...rows], options);
}
