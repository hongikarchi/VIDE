// The work view and the AI column (PLAN-26 T-113, region C): the work followed, conversation
// chips, question cards, the request queue, the proposal slot (`#route-card`) and the jig start
// row. src/ui/app/thread.ts writes these fields and calls `bump()`; the AI column's components
// (src/ui/shell/right-column.tsx) render from them.
import type { ComponentType } from 'react';
import { createSlice } from './core.ts';
import type { ConversationsController } from '../conversations.tsx';
import type { SkillEntry } from '../skill-catalog.ts';
import type { SkillStart } from '../skill-start.ts';
import type { Route } from '../request-route.ts';
import type { ReferenceCardOptions } from '../reference-check.ts';

// Conversation chips (PLAN-24 T-061, src/ui/conversations.tsx) and question cards (T-062,
// src/ui/question-card.tsx) are their own screens, loaded after the page; the glob keeps this page
// working while one of them is not there yet.
export type QuestionCardsModule = typeof import('../question-card.tsx');

/**
 * A screen the AI column shows from a module the shell does not import itself (so the shell's
 * module order and the bundled CSS order stay those of the work screen): the component, its props
 * and a key (a new key mounts it afresh, like the old per-container roots did).
 */
export interface Part<P extends object> {
  View: ComponentType<P>;
  props: P;
  key: string | number;
}

/** The request queue under the work view (`#pending-requests`, `#request-count`). */
export interface RequestQueue {
  state: { instructions?: string[] };
  /** `render(rebuild)`: a field edit redraws without rebuilding the queue. */
  onChange: (rebuild: boolean) => void;
}

/** One line of a jig start row's checklist. */
export interface SkillRowStep {
  text: string;
  done: boolean;
}
/** What `#route-card` holds (one card at a time; `null` empty). */
export type RouteCardContent =
  | { kind: 'plan-first'; plan: () => void; auto: () => void; close: () => void }
  | {
      kind: 'proposal';
      text: string;
      run: { label: string; action: () => void } | undefined;
      toAi: () => void;
      close: () => void;
    }
  | {
      kind: 'skill';
      head: string;
      steps: SkillRowStep[] | undefined;
      note: string | undefined;
      progress: (() => void) | undefined;
      toChat: () => void;
    }
  | { kind: 'reference'; options: ReferenceCardOptions };
/**
 * The proposal slot. The two classes are kept as the old code added and removed them (a jig start
 * row adds `route-row`, the reference check adds `reference-check` and removes `route-row`, hiding
 * removes both), so the slot's class list stays what it was.
 */
export interface RouteCardState {
  content: RouteCardContent | null;
  hidden: boolean;
  routeRow: boolean;
  referenceCheck: boolean;
}

export interface WorkFields {
  foregroundRequest: { id: string; selected: string | null | undefined; draft: string } | undefined;
  /** The work opened in the work view (work history row or the latest request sent). */
  focusedWork: string | undefined;
  /** Raised by `focusWork`: the work view scrolls to its top (also for the same work again). */
  focusToken: number;
  conversationChips: ConversationsController | undefined;
  /** The chosen conversation, the work view's filter (`null` the default one; `undefined` no chips). */
  filter: string | null | undefined;
  /** The chips (`#conversation-chips`); undefined while not mounted. */
  chips: Part<import('../conversations.tsx').ConversationsProps> | undefined;
  questionModule: QuestionCardsModule | undefined;
  /** The chosen conversation's question cards (`#question-cards`). */
  questionCards: Part<import('../question-card.tsx').QuestionCardsProps> | undefined;
  /** The work view (`#conversation`); undefined until the first project draws it. */
  thread:
    | {
        View: ComponentType<import('../work-view.tsx').WorkThreadProps>;
        /** Everything but the filter, which the view reads from `filter`. */
        props: Omit<import('../work-view.tsx').WorkThreadProps, 'filter'>;
      }
    | undefined;
  /** The request queue; undefined until the first render (the count shows "0"). */
  queue: RequestQueue | undefined;
  /** `#recent-section[data-open]`, toggled by `#toggle-recent`. */
  recentOpen: boolean;
  routeCard: RouteCardState;
  /** The Make tab's side panel under the chips (`.make-side`): its element goes to this callback. */
  makeSide: ((element: HTMLElement | null) => void) | undefined;
  // The project's skill catalog, read once per project and again after a minute.
  skillCache: { projectId: string; at: number; list: Promise<SkillEntry[]> } | undefined;
  /** The started skill whose route row shows (one at a time). */
  shownSkill: { start?: SkillStart; body: string; route: Route; aiRequest?: string } | undefined;
}
export const workState = createSlice<WorkFields>({
  foregroundRequest: undefined,
  focusedWork: undefined,
  focusToken: 0,
  conversationChips: undefined,
  filter: undefined,
  chips: undefined,
  questionModule: undefined,
  questionCards: undefined,
  thread: undefined,
  queue: undefined,
  recentOpen: true,
  routeCard: { content: null, hidden: true, routeRow: false, referenceCheck: false },
  makeSide: undefined,
  skillCache: undefined,
  shownSkill: undefined,
});

/**
 * The Make tab's side panel (src/ui/make-tab.tsx): the AI column renders `section.make-side` under
 * the conversation chips and hands its element to `receive`; the returned function removes it.
 */
export function offerMakeSide(receive: (element: HTMLElement | null) => void) {
  workState.makeSide = receive;
  workState.bump();
  return () => {
    if (workState.makeSide !== receive) return;
    workState.makeSide = undefined;
    workState.bump();
  };
}
