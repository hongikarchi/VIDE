// Layout of the work screen (PLAN-26 T-113, region A): the side panels (folded, width), the left
// panel's section, the mobile view, and what the rail and the left panel draw (theme toggle, home
// link, host name, Sync coverage, work history). The rail, the left panel, the edge toggles, the
// width handles and the mobile tab bar render from this slice; the actions below are the only
// writers. The old screen changed this DOM at once and its callers read it right after (the focus
// moves to a toggle, a section's <details> opens), so the actions that do so commit synchronously.
import { flushSync } from 'react-dom';
import { createSlice, type SliceControls } from './core.ts';
import { currentTheme } from '../theme.ts';

export type Side = 'left' | 'right';
/** The model screen's left panel shows one section: the document tree or the task history. */
export type Section = 'document-tree' | 'task-list';
export type MobileView = 'model' | 'input' | 'documents';

/** One row of the work history (the request list, newest first). */
export interface HistoryRow {
  id: string;
  title: string;
  current: boolean;
  time?: string;
  host: string;
  state?: { label: string; value: string };
  open: () => void;
  /** Present for a finished request: removes it from the list. */
  remove?: () => void;
  /** The 검토본 saved from this request (T-109). */
  review?: { text: string; title: string; open: () => void };
}
/** What the host left out of the current model (SPEC-01.2, T-043), as the badge shows it. */
export interface CoverageBadge {
  text: string;
  title: string;
}

export interface LayoutFields {
  /** Set by initializeWorkspacePanels: the rail's pressed state, the sections and handles exist. */
  ready: boolean;
  section: Section;
  /** The `hidden` of #left / #right (a narrow screen shows a panel without unfolding it). */
  leftHidden: boolean;
  rightHidden: boolean;
  /** Folded on a wide screen: body.left-hidden / right-hidden and the edge toggle's look. */
  leftFolded: boolean;
  rightFolded: boolean;
  mobileView: MobileView;
  widths: { left: number; right: number };
  /** The theme the rail's toggle was last drawn for (it shows the theme it switches to). */
  railTheme: 'light' | 'dark';
  /** The rail's home link to the account site's project list, shown when this PC is signed in. */
  homeShown: boolean;
  /** Its address: kept once set, as the old link's href was. */
  homeHref: string | undefined;
  documentHost: string;
  /** Undefined until the first render: the badge does not exist before. */
  coverage: CoverageBadge | undefined;
  history: { empty: boolean; rows: HistoryRow[] };
}
export const layoutState = createSlice<LayoutFields>({
  ready: false,
  section: 'document-tree',
  leftHidden: false,
  rightHidden: false,
  leftFolded: false,
  rightFolded: false,
  mobileView: 'model',
  widths: { left: 266, right: 370 },
  railTheme: 'light',
  homeShown: false,
  homeHref: undefined,
  documentHost: 'Rhino',
  coverage: undefined,
  history: { empty: true, rows: [] },
});

/** Bump and commit the React screen now, so the DOM is current when this call returns. */
export function commitNow(slice: SliceControls) {
  flushSync(() => slice.bump());
}

export function setMobileView(view: MobileView) {
  document.body.dataset.mobile = view;
  layoutState.mobileView = view;
  layoutState.bump();
}

/** Show one section of the left panel; `expand` opens its <details>. */
export function selectSection(section: Section, expand = true) {
  layoutState.section = section;
  commitNow(layoutState);
  if (!expand) return;
  const node =
    section === 'document-tree'
      ? document.getElementById('document-tree')
      : document.getElementById('task-list')?.closest('details');
  if (node instanceof HTMLDetailsElement) node.open = true;
}

function setHidden(side: Side, hidden: boolean) {
  if (side === 'left') layoutState.leftHidden = hidden;
  else {
    layoutState.rightHidden = hidden;
    // #right is the AI column's markup; its `hidden` has one writer, this action.
    const right = document.getElementById('right');
    if (right) right.hidden = hidden;
  }
}
/**
 * The edge toggle (and Alt+Shift+L / R): fold or unfold a side panel and focus its toggle. Below
 * 850 px the panel is shown in the mobile view instead.
 */
export function togglePanel(side: Side) {
  if (matchMedia('(max-width:850px)').matches) {
    setHidden(side, false);
    commitNow(layoutState);
    setMobileView(side === 'left' ? 'documents' : 'input');
    return;
  }
  const hidden = !(side === 'left' ? layoutState.leftHidden : layoutState.rightHidden);
  setHidden(side, hidden);
  if (side === 'left') layoutState.leftFolded = hidden;
  else layoutState.rightFolded = hidden;
  document.body.classList.toggle(`${side}-hidden`, hidden);
  commitNow(layoutState);
  document.getElementById(`toggle-${side}`)?.focus();
}
/** Opens a folded side panel the way its edge toggle does (focus included); open stays open. */
export function revealPanel(side: Side) {
  if (side === 'left' ? layoutState.leftHidden : layoutState.rightHidden) togglePanel(side);
}

const WIDTH = {
  left: { min: 200, max: 480, home: 266 },
  right: { min: 280, max: 640, home: 370 },
} as const;
export const widthLimits = WIDTH;
/** Fit the panel widths to the window and write them as CSS variables. */
export function layoutWidths() {
  const widths = layoutState.widths;
  const available = Math.max(520, innerWidth - 48 - 260);
  widths.left = Math.max(200, Math.min(480, widths.left));
  widths.right = Math.max(280, Math.min(640, widths.right));
  if (widths.left + widths.right > available) {
    widths.right = Math.max(280, available - widths.left);
    widths.left = Math.max(200, available - widths.right);
  }
  for (const side of ['left', 'right'] as const)
    document.documentElement.style.setProperty('--' + side + '-width', widths[side] + 'px');
  commitNow(layoutState);
}
export function persistWidths() {
  try {
    localStorage.setItem('vide:panel-widths', JSON.stringify(layoutState.widths));
  } catch {
    /* Session resizing still works. */
  }
}

/** The rail's theme toggle shows the theme it switches to. */
export function paintThemeToggle() {
  layoutState.railTheme = currentTheme();
  layoutState.bump();
}
