// The single notice slot (PLAN-26 T-113, region E).
import { createSlice } from './core.ts';

export interface ToastFields {
  toastTimer: ReturnType<typeof setTimeout> | undefined;
}
export const toastState = createSlice<ToastFields>({
  toastTimer: undefined,
});
