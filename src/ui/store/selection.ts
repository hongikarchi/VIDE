// The selection and the shown result (PLAN-26 T-113, region B; the shown result is applied by
// src/ui/app/links-sync.ts).
import { createSlice } from './core.ts';

export interface SelectionFields {
  displayedResult: string | undefined;
  selectedResult: string | null | undefined;
  selectedIds: string[];
  appliedSelection: string | null | undefined;
  /** The selection a start restored (draft basis or newest result); it never un-hides a file. */
  restoredSelection: string | undefined;
}
export const selectionState = createSlice<SelectionFields>({
  displayedResult: undefined,
  selectedResult: undefined,
  selectedIds: [],
  appliedSelection: undefined,
  restoredSelection: undefined,
});
