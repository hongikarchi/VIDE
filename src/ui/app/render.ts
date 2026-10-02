// The redraw order (PLAN-26 T-113, frozen): render() and renderMessages() call the regions' parts
// in the order the old app.ts drew them.
import { notifyReference } from '../reference-bridge.ts';
import { objects } from '../model.ts';
import { refreshJigs } from '../jigs.tsx';
import { sessionState } from '../store/session.ts';
import { draftState } from '../store/draft.ts';
import { selectionState } from '../store/selection.ts';
import { workState } from '../store/work.ts';
import {
  paintComposerReady,
  followShownBasis,
  saveDraft,
  paintContext,
  paintSettings,
  paintSendButton,
} from './composer.ts';
import { paintRequestQueue, renderConversation, renderQuestionCards } from './thread.ts';
import {
  paintHostTarget,
  paintDocumentHost,
  renderObjectList,
  sidebar,
  renderLinkPanel,
} from './left.ts';
import {
  normalizeSelection,
  paintSelection,
  paintInspector,
  paintSelectionTitle,
  draw,
} from './viewport.ts';
import { paintDisplayCoverage, paintStatus } from './status.ts';
import { applyShownSelection, showLayers } from './links-sync.ts';

/**
 * Redraws the screen from the draft and the shown result. The order of the regions' parts is the
 * old app.ts order; a region changes what its own part draws, not this list (PLAN-26 T-113).
 */
export function render(rebuildRequests = true) {
  paintComposerReady();
  notifyReference();
  followShownBasis();
  paintRequestQueue(rebuildRequests);
  // Intervention availability follows the composer, so the work view follows every render.
  if (sessionState.project) renderConversation();
  paintHostTarget();
  saveDraft();
  normalizeSelection();
  renderObjectList(objects, selectionState.selectedIds);
  paintSelection();
  draftState.refreshPinComposer();
  paintContext();
  paintSettings();
  const active = paintInspector();
  paintSelectionTitle(active);
  paintDisplayCoverage(active);
  paintDocumentHost(active);
  paintStatus();
  sidebar();
  paintSendButton();
  draw();
}
/** Redraws what follows the request list: chips, question cards, layers, history, work view, links. */
export function renderMessages() {
  workState.conversationChips?.update({ messages: draftState.state.messages });
  renderQuestionCards();
  applyShownSelection();
  showLayers();
  sidebar();
  renderConversation();
  // A new Sync reaches the jigs that are open (their Sync lists).
  if (sessionState.project) refreshJigs();
  // The links panel shows the work-result row of what is drawn; it also refreshes the dashboard.
  renderLinkPanel();
}
