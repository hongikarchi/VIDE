// Official library `vide/finish-codes` (SPEC-11.2, PLAN-43 기본값 2): the finish-code system
// (코드 477개, 재료 145종, 기준표 8개, 표준 일반사항) shipped with VIDE and read-only there. The data
// comes from the user's finish-code app without its project lists and names (AI.md §8). Only
// functions and the small `library` record are exported, so a compute box that imports the
// library does not carry the whole table as a constant.
import data from './library.json' with { type: 'json' };
import type { FinishCode, FinishLibrary } from '../../../contracts/finish.ts';
import { searchCodes, totalOf, type FinishFilter, type Thicknesses } from '../../finish.ts';

export const library = { id: 'vide/finish-codes', version: '3.0.0' } as const;

const LIBRARY = data as unknown as FinishLibrary;

/** The whole library (system, materials, codes, reference tables, standard notes). */
export function finishLibrary(): FinishLibrary {
  return LIBRARY;
}
/** One code, or null when the library has none. */
export function finishCode(code: string): FinishCode | null {
  return LIBRARY.codes[String(code).toUpperCase()] ?? null;
}
/** Codes matching a filter (element, categories, finishes, tags, words, total thickness). */
export function searchFinishCodes(filter: FinishFilter = {}): string[] {
  return searchCodes(LIBRARY, filter ?? {});
}
/** A code's total thickness (mm) with optional per-layer adjustments. */
export function finishTotal(code: string, thk: Thicknesses = {}): number {
  return totalOf(LIBRARY, code, thk ?? {});
}
