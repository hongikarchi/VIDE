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
  // Request routing (SPEC-02.17): Jev judges view-only or file work when the request is sent.
  routing: boolean;
  mode: WorkMode;
  /** The composer's model was set by a chosen conversation, not by the user. */
  modelFollowsConversation: boolean;
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
});
