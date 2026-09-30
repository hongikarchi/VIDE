// CSV cells for the structure tables (SPEC-06.7·.12): UTF-8 BOM, every cell quoted, CRLF. Text that
// a spreadsheet would run as a formula (leading = + @ -) gets a leading apostrophe; numbers stay
// numbers so negative values are untouched. Same form as the S-06 diagnosis CSV.

export type CsvCell = string | number | null | undefined;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') return Number.isFinite(value) ? `"${value}"` : '""';
  const text = /^[\s]*[=+@-]/.test(value) ? "'" + value : value;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function csvText(rows: CsvCell[][]): string {
  return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
