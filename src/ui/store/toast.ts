// The single notice slot (PLAN-26 T-113, region E): what `#message` shows. src/ui/app/status.ts
// writes it (message, messageWithActions); shell/toast.tsx renders it.
import { createSlice } from './core.ts';

export interface ToastAction {
  label: string;
  run: () => void;
}
export interface ToastFields {
  toastTimer: ReturnType<typeof setTimeout> | undefined;
  text: string;
  hidden: boolean;
  /** Action buttons after the text; with any, the text is followed by one space (the old markup). */
  actions: ToastAction[] | undefined;
  /** Raised for each notice, so a new notice gets new buttons. */
  generation: number;
}
export const toastState = createSlice<ToastFields>({
  toastTimer: undefined,
  text: '',
  hidden: true,
  actions: undefined,
  generation: 0,
});
