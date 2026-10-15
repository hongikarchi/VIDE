/**
 * 시점 형상 (PLAN-53 T-335, ARCH-01 §5 「시점 형상」, Design SCR-46 구현 기준 「기준 시점 글자」): the
 * records timeline's link to the model's past. `momentTicks()` gives the 검토본·동기화 ticks of the
 * time axis; `pickMoment(date)` (the timeline's `onPickMoment`, called when the cursor is let go or
 * playing stops) draws, per linked file, its Sync at that date in the file's place through the
 * existing past-Sync path (`layerOverride` → `showLayers`, camera kept) as a view-only override:
 * the composer's basis and the active layer stay on the current model (`viewOnlyOverrides`), and
 * the basis line over the viewport says which moment it is. [현재로] (and `pickMoment(null)`, the
 * folded timeline) brings every file back to its latest Sync. Only overrides set here are undone; a
 * hidden file stays hidden. Data: the reviews list the app already reads and the requests list.
 */
import {
  basisText,
  buildMoments,
  momentTicks as ticksOf,
  pickMoments,
  type Moment,
  type MomentTick,
  type MomentSyncInput,
} from '../core/records-moments.ts';
import { reviewRows, onReviewsChange } from './reviews.tsx';
import { draftState } from './store/draft.ts';
import { linksState } from './store/links.ts';
import { selectionState } from './store/selection.ts';
import { sessionState } from './store/session.ts';
import {
  clearLayerOverrides,
  layerOverride,
  ownerOf,
  setViewOnlyOverride,
  showLayers,
  viewOnlyOverrides as mine,
} from './app/links-sync.ts';
import './records-moment.css';

export type { Moment, MomentTick } from '../core/records-moments.ts';

// `mine` (links-sync's view-only overrides): linkId → the Sync this module put in that file's
// place, for viewing only — the composer keeps the file's latest Sync as its basis.
let basis: Moment | null = null,
  shown = false,
  loading = false,
  watch: number | undefined,
  today: (() => void) | undefined;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((listener) => listener());
onReviewsChange(publish);

const projectId = () => sessionState.project?.id;

/** Each linked file's successful document Syncs (requests list order). */
function syncs(): MomentSyncInput[] {
  const rows: MomentSyncInput[] = [];
  for (const entry of draftState.state.messages) {
    const request = entry.request;
    if (request.input.source !== 'document' || request.state !== 'succeeded') continue;
    const link = ownerOf(request);
    if (!link) continue;
    rows.push({
      requestId: entry.id,
      linkId: link.id,
      linkName: link.name,
      createdAt: String(request.createdAt ?? ''),
      pruned: (request.result as { modelStore?: unknown } | undefined)?.modelStore === 'pruned',
    });
  }
  return rows;
}
/** Every moment of the shown project, oldest first. */
export function moments(): Moment[] {
  return buildMoments(syncs(), reviewRows(projectId()));
}
/** The time axis ticks: one per day, a 검토본 day taller; hover lines '10-01 검토본 · A안'. */
export function momentTicks(): MomentTick[] {
  return ticksOf(moments());
}
/** Reviews saved or listed again: the timeline asks for ticks again. */
export function onMomentsChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
/** [현재로] also moves the timeline's cursor to today (the timeline sets this). */
export function setMomentToday(handler: (() => void) | undefined) {
  today = handler;
}

const latestOf = () =>
  new Map(linksState.links.map((link) => [link.id, link.lastSync?.requestId] as const));

/**
 * The model at `date` ('YYYY-MM-DD'): files whose moment is not their latest Sync draw that Sync
 * in their place; the basis line shows. `null`: back to the current model, line removed.
 */
export function pickMoment(date: string | null) {
  if (date === null) {
    clearMoment();
    return;
  }
  const pick = pickMoments(moments(), date, latestOf());
  // Files leaving the past: only an override this module set is undone.
  const undo: string[] = [];
  for (const [linkId, id] of [...mine]) {
    if (pick.overrides.has(linkId)) continue;
    mine.delete(linkId);
    if (layerOverride.get(linkId) === id) undo.push(linkId);
  }
  let changed = false;
  for (const [linkId, requestId] of pick.overrides) {
    const link = linksState.links.find((entry) => entry.id === linkId);
    if (!link || link.hidden) continue;
    // Already in that file's place (the person opened it): left as it is, never undone here.
    if (layerOverride.get(linkId) === requestId) continue;
    setViewOnlyOverride(linkId, requestId);
    changed = true;
  }
  for (const linkId of undo) layerOverride.delete(linkId);
  if (changed || undo.length) showLayers();
  basis = pick.basis;
  shown = true;
  follow();
}
/** Back to the current model and no basis line (the folded timeline, leaving the model tab). */
export function clearMoment() {
  const own = [...mine].filter(([linkId, id]) => layerOverride.get(linkId) === id);
  mine.clear();
  clearLayerOverrides(own.map(([linkId]) => linkId));
  basis = null;
  shown = false;
  follow();
}
/** For the timeline and tests: the basis line and whether a past moment is drawn. */
export function momentState() {
  return {
    text: shown ? basisText(basis, loading) : '',
    past: mine.size > 0,
    loading,
    overrides: Object.fromEntries(mine),
  };
}

/** A past Sync without its scene loads first (`showLayers` fetches it): '… 불러오는 중…' till drawn. */
function follow() {
  const drawn = () =>
    [...mine].every(([linkId, id]) =>
      linksState.currentLayers.some((layer) => layer.key === linkId && layer.requestId === id),
    );
  loading = shown && !drawn();
  paint();
  if (watch !== undefined) window.clearInterval(watch);
  watch = undefined;
  if (!loading) return;
  const until = Date.now() + 60_000;
  watch = window.setInterval(() => {
    if (drawn() || Date.now() > until || !shown) {
      window.clearInterval(watch);
      watch = undefined;
      loading = false;
      paint();
    }
  }, 150);
}

let line: HTMLDivElement | undefined;
/** The basis line at the viewport's top left, with [현재로] while a past moment is drawn. */
function paint() {
  const area = document.querySelector('.viewport-area');
  if (!shown || !area) {
    line?.remove();
    line = undefined;
    publish();
    return;
  }
  if (!line) {
    line = document.createElement('div');
    line.className = 'records-moment-basis';
    line.setAttribute('role', 'status');
    const text = document.createElement('span');
    const now = document.createElement('button');
    now.type = 'button';
    now.textContent = '현재로';
    now.addEventListener('click', () => {
      if (today) today();
      clearMoment();
      // The current model: the basis is the files' latest Syncs (a later 검토본 of an older Sync
      // would otherwise name a moment that is not drawn).
      shown = true;
      basis = pickMoments(
        moments().filter((moment) => moment.kind === 'sync'),
        localToday(),
        latestOf(),
      ).basis;
      follow();
    });
    line.append(text, now);
  }
  if (line.parentElement !== area) area.append(line);
  const state = momentState();
  (line.firstElementChild as HTMLElement).textContent = state.text;
  (line.lastElementChild as HTMLButtonElement).hidden = !state.past;
  publish();
}
function localToday() {
  const at = new Date();
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

// Browser tests drive the moments without the timeline (tests/integration/browser-records-moment.mjs).
(window as unknown as { videRecordsMoment?: unknown }).videRecordsMoment = {
  ticks: momentTicks,
  pick: pickMoment,
  clear: clearMoment,
  state: momentState,
  // The composer's basis (a moment is seen only: it stays the file's latest Sync).
  displayed: () => selectionState.displayedResult,
};
