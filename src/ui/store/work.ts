// The work view and the AI column (PLAN-26 T-113, region C): the work followed, conversation
// chips, question cards and the jig start row.
import { createSlice } from './core.ts';
import type { ConversationsController } from '../conversations.tsx';
import type { SkillEntry } from '../skill-catalog.ts';
import type { SkillStart } from '../skill-start.ts';
import type { Route } from '../request-route.ts';

// Conversation chips (PLAN-24 T-061, src/ui/conversations.tsx) and question cards (T-062,
// src/ui/question-card.tsx) are their own screens, loaded after the page; the glob keeps this page
// working while one of them is not there yet.
export type QuestionCardsModule = typeof import('../question-card.tsx');

export interface WorkFields {
  foregroundRequest: { id: string; selected: string | null | undefined; draft: string } | undefined;
  /** The work opened in the work view (work history row or the latest request sent). */
  focusedWork: string | undefined;
  conversationChips: ConversationsController | undefined;
  mountCards: QuestionCardsModule['mountQuestionCards'] | undefined;
  questionCards: ReturnType<QuestionCardsModule['mountQuestionCards']> | undefined;
  // The project's skill catalog, read once per project and again after a minute.
  skillCache: { projectId: string; at: number; list: Promise<SkillEntry[]> } | undefined;
  /** The started skill whose route row shows (one at a time). */
  shownSkill: { start?: SkillStart; body: string; route: Route; aiRequest?: string } | undefined;
}
export const workState = createSlice<WorkFields>({
  foregroundRequest: undefined,
  focusedWork: undefined,
  conversationChips: undefined,
  mountCards: undefined,
  questionCards: undefined,
  skillCache: undefined,
  shownSkill: undefined,
});
