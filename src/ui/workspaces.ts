// Workspaces (Design §03 작업공간 탭, decision A4; SCR-13·18): fixed screens reached from the rail
// (src/ui/workspace-panels.ts) and one closable context tab per opened jig in the row over the
// centre column. Since 2026-10-01 (user decision) the row holds only what is open and hides when
// nothing is; the fixed screens are the rail's. A workspace changes the centre, the left column and
// the drawer only; the conversation column, drafts and the selection stay as they are. There is no
// free docking, splitting or node editor. Below 900 px the row becomes one menu, which also lists
// the fixed screens because the rail is gone below 850 px. The last screen and the open context
// tabs are a viewer convenience remembered per project in this browser's storage; a blocked or
// empty storage just opens the model screen.

import { isJigIcon } from '../contracts/jig-icons.ts';
import { createSlice } from './store/core.ts';
import { commitNow } from './store/layout.ts';

export type FixedWorkspace = 'dashboard' | 'model' | 'data' | 'notes' | 'jig' | 'make' | 'output';
/** A sub-view of the 산출물 tab (src/ui/output-tab.tsx). */
export type OutputView = 'sheet' | 'report' | 'review' | 'render';
/**
 * An item opened in its own tab. A jig (the default kind): `instanceId` is a jig instance (작업본)
 * id, or `legacy:<jigId>` for older jigs. A reference image (SPEC-09.2, PLAN-26 T-090):
 * `instanceId` is the image attachment's id, and its screen is src/ui/reference-tab.tsx.
 */
export type ContextKind = 'jig' | 'reference';
export interface ContextTab {
  instanceId: string;
  kind?: ContextKind;
  label: string;
  /** The longer name shown as the tab's tooltip. */
  title?: string;
  /** A jig tab's icon (PLAN-26 T-100), drawn before its name. */
  icon?: string;
}
export interface WorkspaceChange {
  /** A fixed tab id, or `tabId(tab)` of a context tab. */
  active: string;
  context: readonly ContextTab[];
  /** The context tab this change closed. */
  closed?: ContextTab;
}

// The data and make tabs open with PLAN-22 T-065 and T-063; the report tab is T-057.
// 대시보드 (first draft, user request 2026-10-01) comes first; the model tab stays the default.
// 산출물 (PLAN-26 T-081) holds 도면 · 보고서 · 렌더링; the report tab (T-057) is its 보고서 view.
// 만들기 is part of JIG since PLAN-26 T-099 (user request 2026-10-01): it has no rail button and no
// menu entry (`menu: false`), opens from the JIG list's cards, and the rail's JIG stays pressed on
// it. Its id stays, because the AI's `ui_go`, the request route and `openDraft` show it by id.
const FIXED: {
  id: FixedWorkspace;
  label: string;
  ready: boolean;
  title?: string;
  menu?: false;
}[] = [
  { id: 'dashboard', label: '대시보드', ready: true },
  { id: 'data', label: '자료', ready: true },
  // 노트·일지 (SPEC-10, user request 2026-10-06): the members' shared notes from the account site.
  { id: 'notes', label: '노트·일지', ready: true },
  { id: 'model', label: '모델', ready: true },
  { id: 'jig', label: 'JIG', ready: true },
  { id: 'make', label: '만들기', ready: true, menu: false },
  { id: 'output', label: '산출물', ready: true, title: 'Output · 도면 · 보고서 · 검토본 · 렌더링' },
];
const PREFIX = 'jig:';
const REFERENCE = 'ref:';
/** The tab id of a jig instance's context tab. */
export const contextId = (instanceId: string) => PREFIX + instanceId;
/** The tab id of a reference image's tab. */
export const referenceTabId = (attachmentId: string) => REFERENCE + attachmentId;
/** The tab id of any context tab. */
export const tabId = (tab: ContextTab) =>
  tab.kind === 'reference' ? referenceTabId(tab.instanceId) : contextId(tab.instanceId);
const instanceOf = (id: string) => (id.startsWith(PREFIX) ? id.slice(PREFIX.length) : undefined);
/** The attachment of a reference tab id. */
export const referenceOf = (id: string) =>
  id.startsWith(REFERENCE) ? id.slice(REFERENCE.length) : undefined;
const sameTab = (a: ContextTab, b: { instanceId: string; kind?: ContextKind }) =>
  a.instanceId === b.instanceId && (a.kind ?? 'jig') === (b.kind ?? 'jig');
const MAX_CONTEXT = 12;
/** Former tab ids that are now a view of a fixed tab: every way to the report still opens it. */
const ALIAS: Record<string, { tab: FixedWorkspace; view: OutputView }> = {
  report: { tab: 'output', view: 'report' },
};
/** The 산출물 view asked for with the tab (an alias or a caller); else its remembered view. */
let outputView: OutputView | undefined;

let projectId: string | undefined;
/**
 * The tab row's state (PLAN-26 T-113): the shown tab, the open context tabs, and whether the row is
 * drawn (initializeWorkspaces; a host panel has none). src/ui/shell/workspace-tabs.tsx renders it.
 */
export const workspacesState = createSlice({
  active: 'model',
  context: [] as ContextTab[],
  mounted: false,
});
const tabs = workspacesState;
let resolver: ((instanceId: string) => Promise<ContextTab | undefined>) | undefined;
const listeners = new Set<(change: WorkspaceChange) => void>();
document.body.dataset.workspace = 'model';

const storageKey = () => (projectId ? `vide:workspace:${projectId}` : undefined);
function remember() {
  const key = storageKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({ active: tabs.active, context: tabs.context }));
  } catch {
    /* A viewer convenience only; the tabs work without it. */
  }
}
function recall(): { active?: string; context: ContextTab[] } {
  const key = storageKey();
  try {
    const saved = key ? (JSON.parse(localStorage.getItem(key) ?? 'null') as unknown) : null;
    if (!saved || typeof saved !== 'object') return { context: [] };
    const { active: tab, context: tabs } = saved as { active?: unknown; context?: unknown };
    const valid = (Array.isArray(tabs) ? tabs : [])
      .filter(
        (entry): entry is ContextTab =>
          !!entry &&
          typeof entry.instanceId === 'string' &&
          entry.instanceId.length > 0 &&
          entry.instanceId.length <= 220 &&
          typeof entry.label === 'string',
      )
      .slice(0, MAX_CONTEXT)
      .map((entry) => ({
        instanceId: entry.instanceId,
        ...(entry.kind === 'reference' ? { kind: 'reference' as const } : {}),
        label: entry.label.slice(0, 120),
        ...(typeof entry.title === 'string' ? { title: entry.title.slice(0, 300) } : {}),
        ...(isJigIcon(entry.icon) ? { icon: entry.icon } : {}),
      }));
    return { active: typeof tab === 'string' ? tab : undefined, context: valid };
  } catch {
    return { context: [] };
  }
}

function known(id: string) {
  if (tabs.context.some((tab) => tabId(tab) === id)) return true;
  return FIXED.some((tab) => tab.id === id && tab.ready);
}
function emit(closed?: ContextTab) {
  document.body.dataset.workspace =
    tabs.active === 'dashboard' ||
    tabs.active === 'model' ||
    tabs.active === 'jig' ||
    tabs.active === 'output' ||
    tabs.active === 'data' ||
    tabs.active === 'notes' ||
    tabs.active === 'make'
      ? tabs.active
      : referenceOf(tabs.active) !== undefined
        ? 'reference'
        : 'context';
  // The 대시보드 screen reads the project's state when it is shown (src/ui/dashboard.tsx).
  if (tabs.active === 'dashboard' && projectId)
    void import('./dashboard.tsx').then((screen) => screen.showDashboard(projectId!));
  // The 만들기 screen loads when its tab is first shown (src/ui/make-tab.tsx, PLAN-22 T-063).
  if (tabs.active === 'make' && projectId)
    void import('./make-tab.tsx').then((screen) => screen.showMake(projectId!));
  // The 자료 screen also loads when its tab is first shown (src/ui/facts-tab.tsx, PLAN-22 T-065).
  if (tabs.active === 'data' && projectId)
    void import('./facts-tab.tsx').then((screen) => screen.showFacts(projectId!));
  // The 노트·일지 screen (src/ui/notes-tab.tsx, SPEC-10) loads its block editor when first shown.
  if (tabs.active === 'notes' && projectId)
    void import('./notes-tab.tsx').then((screen) => screen.showNotes(projectId!));
  // The 산출물 screen loads when its tab is first shown (src/ui/output-tab.tsx); its 보고서 view
  // is the report screen (src/ui/report-tab.tsx).
  if (tabs.active === 'output' && projectId) {
    const view = outputView;
    outputView = undefined;
    void import('./output-tab.tsx').then((screen) => screen.showOutput(projectId!, view));
  } else outputView = undefined;
  // A reference image's tab: the region editor or the 이해 확인 board (src/ui/reference-tab.tsx).
  const reference = tabs.context.find(
    (tab) => tab.kind === 'reference' && tabId(tab) === tabs.active,
  );
  if (reference && projectId) {
    const project = projectId;
    void import('./reference-tab.tsx').then((screen) => screen.showReference(project, reference));
  }
  paint();
  remember();
  const change = { active: tabs.active, context: tabs.context, ...(closed ? { closed } : {}) };
  for (const listener of listeners) listener(change);
}
function activate(id: string) {
  tabs.active = id;
  emit();
}

/**
 * Show a tab: a fixed tab id, a context tab id, or with `instanceId` the jig instance's context
 * tab — opened first when it is not in the row (the jig screen resolves its name).
 */
export function setWorkspace(
  id: string,
  options: { instanceId?: string; outputView?: OutputView } = {},
) {
  const alias = ALIAS[id];
  if (alias) {
    id = alias.tab;
    outputView = alias.view;
  } else if (id === 'output' && options.outputView) outputView = options.outputView;
  if (options.instanceId !== undefined) {
    const instanceId = options.instanceId;
    if (tabs.context.some((tab) => sameTab(tab, { instanceId }))) activate(contextId(instanceId));
    else
      void resolver?.(instanceId).then((tab) => {
        if (tab) openContextTab(tab);
      });
    return;
  }
  if (known(id)) activate(id);
}
/** Add a context tab (or rename it when present) and show it unless `show` is false. */
export function openContextTab(tab: ContextTab, show = true) {
  const index = tabs.context.findIndex((entry) => sameTab(entry, tab));
  if (index >= 0)
    tabs.context = tabs.context.map((entry, k) => (k === index ? { ...entry, ...tab } : entry));
  else {
    // The oldest tab that is not showing makes room; its instance stays and reopens from the list.
    if (tabs.context.length >= MAX_CONTEXT) {
      const drop = tabs.context.find((entry) => tabId(entry) !== tabs.active);
      if (drop) tabs.context = tabs.context.filter((entry) => entry !== drop);
    }
    tabs.context = [...tabs.context, tab];
  }
  if (show) activate(tabId(tab));
  else emit();
}
/**
 * Close a context tab. What it showed stays (a jig instance, a reference board); the neighbouring
 * tab (or the model tab) shows.
 */
export function closeContextTab(instanceId: string, kind: ContextKind = 'jig') {
  const index = tabs.context.findIndex((entry) => sameTab(entry, { instanceId, kind }));
  if (index < 0) return;
  const closed = tabs.context[index];
  tabs.context = tabs.context.filter((_, k) => k !== index);
  if (tabs.active === tabId(closed)) {
    const neighbour = tabs.context[index] ?? tabs.context[index - 1];
    tabs.active = neighbour ? tabId(neighbour) : 'model';
  }
  emit(closed);
}
export function renameContextTab(
  instanceId: string,
  label: string,
  title?: string,
  kind: ContextKind = 'jig',
) {
  if (!tabs.context.some((entry) => sameTab(entry, { instanceId, kind }))) return;
  tabs.context = tabs.context.map((entry) =>
    sameTab(entry, { instanceId, kind }) ? { ...entry, label, ...(title ? { title } : {}) } : entry,
  );
  paint();
  remember();
}
/** Draw a jig tab's icon (the jig screen sets it once it has read the instance). */
export function setContextIcon(instanceId: string, icon: string | undefined) {
  const tab = tabs.context.find((entry) => sameTab(entry, { instanceId }));
  if (!tab || tab.icon === icon) return;
  tabs.context = tabs.context.map((entry) =>
    entry === tab ? { ...entry, ...(isJigIcon(icon) ? { icon } : { icon: undefined }) } : entry,
  );
  paint();
  remember();
}
export const activeWorkspace = () => tabs.active;
export const contextTabs = (): readonly ContextTab[] => tabs.context;
/**
 * The rail destination the shown workspace belongs to: a jig instance's tab and the 만들기 screen
 * are JIG's (T-099); a reference image's tab belongs to none.
 */
export const workspaceDestination = (): FixedWorkspace | undefined =>
  instanceOf(tabs.active) !== undefined || tabs.active === 'make'
    ? 'jig'
    : referenceOf(tabs.active) !== undefined
      ? undefined
      : (tabs.active as FixedWorkspace);
/** The 3D view is part of the model tab and of every jig context tab. */
export const workspaceShowsViewport = () =>
  tabs.active === 'model' || instanceOf(tabs.active) !== undefined;
export function onWorkspaceChange(listener: (change: WorkspaceChange) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** How a context tab not in the row gets its name (the jig screen registers this). */
export function setContextResolver(
  resolve: (instanceId: string) => Promise<ContextTab | undefined>,
) {
  resolver = resolve;
}

/** Draw the tab row in `mount` (#workspace-tabs) and come back to this project's last tab. */
export function initializeWorkspaces(options: { projectId: string; mount: HTMLElement }) {
  projectId = options.projectId;
  // Basis chips anywhere open the fact window of this project (src/ui/jig-panel/registry.ts).
  void import('./jig-panel/registry.ts').then((chips) =>
    chips.listenForBasisChips((statementId) => {
      if (projectId)
        void import('./jig-panel/basis-parts.tsx').then((parts) =>
          parts.openFactWindow(projectId!, statementId),
        );
    }),
  );
  // The row is the shell's #workspace-tabs (src/ui/shell/workspace-tabs.tsx); `mount` names it.
  tabs.mounted = options.mount.id === 'workspace-tabs';
  const saved = recall();
  tabs.context = saved.context;
  // A last tab saved under a former id (the 보고서 tab) opens where it lives now.
  const alias = saved.active ? ALIAS[saved.active] : undefined;
  if (alias) {
    saved.active = alias.tab;
    outputView = alias.view;
  }
  tabs.active = saved.active && known(saved.active) ? saved.active : 'model';
  emit();
}

/**
 * Redraw the row now. Listeners and the jig panel read it right after (the selected tab gets the
 * focus), as they did when the row was rebuilt here. A row redrawn while it holds the focus gives
 * it back to the same kind of control.
 */
function paint() {
  if (!tabs.mounted) return;
  const bar = document.getElementById('workspace-tabs');
  const focused =
    bar && bar.contains(document.activeElement)
      ? document.activeElement instanceof HTMLSelectElement
        ? 'select'
        : '[role="tab"][aria-selected="true"]'
      : undefined;
  commitNow(tabs);
  if (focused) bar?.querySelector<HTMLElement>(focused)?.focus();
}

/** The fixed screens the narrow menu lists (만들기 is JIG's and has no entry). */
export const menuWorkspaces = () => FIXED.filter((tab) => tab.menu !== false);
