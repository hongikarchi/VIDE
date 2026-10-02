// The composer's draft (PLAN-26 T-113, region D): the draft object (changed in place), its
// conversation and mode.
import { createSlice } from './core.ts';
import { initial, type DraftState } from '../model.ts';

/**
 * Work mode (user decision 2026-09-30, replaces the review/candidate/apply permissions): 계획 reads,
 * measures and plans without writing; 자동 (default) runs directly in the open document, one undo
 * record per execution. Remembered per project. The old `permission` field still goes along
 * (plan → review, auto → candidate) for servers that read only it.
 */
export type WorkMode = 'plan' | 'auto';

export interface DraftFields {
  draftSaved: boolean;
  unreadableDraft: boolean;
  // The conversation whose draft the composer holds (null = the default conversation).
  draftConversation: string | null;
  state: DraftState;
  // Set once the inline pin composer exists; render() may run before that.
  refreshPinComposer: () => void;
  // Request routing (SPEC-02.17): Jev judges view-only or file work when the request is sent;
  // while it runs `#request` is aria-busy.
  routing: boolean;
  mode: WorkMode;
  /** The composer's model was set by a chosen conversation, not by the user. */
  modelFollowsConversation: boolean;
  /** What the composer (shell/composer.tsx) draws; render()'s composer parts set it. */
  view: ComposerView;
  /** The composer's controls call these; app/composer.ts sets them when it starts. */
  actions: ComposerActions;
}

/** One item over the message box (`#context`), in the order drawn. */
export type ContextItem =
  | {
      kind: 'chip';
      text: string;
      remove: () => void;
      title?: string;
      select?: () => void;
      thumbnail?: string;
      action?: { label: string; title: string; run: () => void };
    }
  /** Host panel: what is selected in Rhino/CAD now, one click to attach. */
  | { kind: 'selection'; text: string; run: () => void }
  /** The draft's basis is off screen: [입력 기준 보기]. */
  | { kind: 'basis'; run: () => void }
  | { kind: 'new-basis' };

export interface ModelChoice {
  id: string;
  name: string;
}

export interface ComposerView {
  /** The page is ready (mode buttons); `undefined` before the first render(). */
  ready?: boolean;
  /** The work mode drawn on the toggle; `undefined` before the first render(). */
  mode?: WorkMode;
  context: ContextItem[];
  /** The model menu: "자동 (Jev)" first, then one group per service. */
  models: { first: ModelChoice[]; groups: { label: string; options: ModelChoice[] }[] };
  /** Models off the list (an older draft's), added after the groups until the menu is refilled. */
  extraModels: string[];
  /** The menu's value; `undefined` before the menu is first filled. */
  model?: string;
  modelDisabled: boolean;
  effort: {
    max: number;
    index: number;
    disabled: boolean;
    label: string;
    title?: string;
    fill?: string;
    steps: { text: string; active: boolean }[];
  };
  attachDisabled: boolean;
  addDisabled: boolean;
  send: { disabled: boolean; title: string };
  /** `#saved`: only a failed draft save is shown (set on typing). */
  saved: string;
}

export interface ComposerActions {
  setMode(mode: WorkMode): void;
  chooseModel(id: string): void;
  chooseEffort(index: number): void;
  send(): void;
  queue(): void;
  attach(files: File[]): void;
}

export const draftState = createSlice<DraftFields>({
  draftSaved: false,
  unreadableDraft: false,
  draftConversation: null,
  state: initial(),
  refreshPinComposer: () => {},
  routing: false,
  mode: 'auto',
  modelFollowsConversation: false,
  // The markup's state before the first render().
  view: {
    context: [],
    models: { first: [], groups: [] },
    extraModels: [],
    modelDisabled: false,
    effort: { max: 0, index: 0, disabled: false, label: '기본값', steps: [] },
    attachDisabled: false,
    addDisabled: false,
    send: { disabled: false, title: '보내기 · Ctrl+Enter' },
    saved: '',
  },
  actions: {
    setMode: () => {},
    chooseModel: () => {},
    chooseEffort: () => {},
    send: () => {},
    queue: () => {},
    attach: () => {},
  },
});

/**
 * Asks the composer to draw again. The bump waits for the current task's microtasks, so a render()
 * called from inside a React render or effect does not update another component during it, and the
 * several composer parts of one render() draw once.
 */
let paintQueued = false;
export function paintComposer() {
  if (paintQueued) return;
  paintQueued = true;
  queueMicrotask(() => {
    paintQueued = false;
    draftState.bump();
  });
}
