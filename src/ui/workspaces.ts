// Workspaces (Design §03 작업공간 탭, decision A4; SCR-13·18): fixed screens reached from the rail
// (src/ui/workspace-panels.ts) and one closable context tab per opened jig in the row over the
// centre column. Since 2026-10-01 (user decision) the row holds only what is open and hides when
// nothing is; the fixed screens are the rail's. A workspace changes the centre, the left column and
// the drawer only; the conversation column, drafts and the selection stay as they are. There is no
// free docking, splitting or node editor. Below 900 px the row becomes one menu, which also lists
// the fixed screens because the rail is gone below 850 px. The last screen and the open context
// tabs are a viewer convenience remembered per project in this browser's storage; a blocked or
// empty storage just opens the model screen.

export type FixedWorkspace = 'dashboard' | 'model' | 'data' | 'jig' | 'make' | 'output';
/** A sub-view of the 산출물 tab (src/ui/output-tab.tsx). */
export type OutputView = 'sheet' | 'report' | 'render';
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
const FIXED: { id: FixedWorkspace; label: string; ready: boolean; title?: string }[] = [
  { id: 'dashboard', label: '대시보드', ready: true },
  { id: 'model', label: '모델', ready: true },
  { id: 'data', label: '자료', ready: true },
  { id: 'jig', label: 'JIG', ready: true },
  { id: 'make', label: '만들기', ready: true },
  { id: 'output', label: '산출물', ready: true, title: 'Output · 도면 · 보고서 · 렌더링' },
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
let active = 'model';
let context: ContextTab[] = [];
let resolver: ((instanceId: string) => Promise<ContextTab | undefined>) | undefined;
const listeners = new Set<(change: WorkspaceChange) => void>();
let bar: HTMLElement | undefined;
document.body.dataset.workspace = 'model';

const storageKey = () => (projectId ? `vide:workspace:${projectId}` : undefined);
function remember() {
  const key = storageKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({ active, context }));
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
      }));
    return { active: typeof tab === 'string' ? tab : undefined, context: valid };
  } catch {
    return { context: [] };
  }
}

function known(id: string) {
  if (context.some((tab) => tabId(tab) === id)) return true;
  return FIXED.some((tab) => tab.id === id && tab.ready);
}
function emit(closed?: ContextTab) {
  document.body.dataset.workspace =
    active === 'dashboard' ||
    active === 'model' ||
    active === 'jig' ||
    active === 'output' ||
    active === 'data' ||
    active === 'make'
      ? active
      : referenceOf(active) !== undefined
        ? 'reference'
        : 'context';
  // The 대시보드 screen reads the project's state when it is shown (src/ui/dashboard.tsx).
  if (active === 'dashboard' && projectId)
    void import('./dashboard.tsx').then((screen) => screen.showDashboard(projectId!));
  // The 만들기 screen loads when its tab is first shown (src/ui/make-tab.tsx, PLAN-22 T-063).
  if (active === 'make' && projectId)
    void import('./make-tab.tsx').then((screen) => screen.showMake(projectId!));
  // The 자료 screen also loads when its tab is first shown (src/ui/facts-tab.tsx, PLAN-22 T-065).
  if (active === 'data' && projectId)
    void import('./facts-tab.tsx').then((screen) => screen.showFacts(projectId!));
  // The 산출물 screen loads when its tab is first shown (src/ui/output-tab.tsx); its 보고서 view
  // is the report screen (src/ui/report-tab.tsx).
  if (active === 'output' && projectId) {
    const view = outputView;
    outputView = undefined;
    void import('./output-tab.tsx').then((screen) => screen.showOutput(projectId!, view));
  } else outputView = undefined;
  // A reference image's tab: the region editor or the 이해 확인 board (src/ui/reference-tab.tsx).
  const reference = context.find((tab) => tab.kind === 'reference' && tabId(tab) === active);
  if (reference && projectId) {
    const project = projectId;
    void import('./reference-tab.tsx').then((screen) => screen.showReference(project, reference));
  }
  paint();
  remember();
  const change = { active, context, ...(closed ? { closed } : {}) };
  for (const listener of listeners) listener(change);
}
function activate(id: string) {
  active = id;
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
    if (context.some((tab) => sameTab(tab, { instanceId }))) activate(contextId(instanceId));
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
  const index = context.findIndex((entry) => sameTab(entry, tab));
  if (index >= 0) context = context.map((entry, k) => (k === index ? { ...entry, ...tab } : entry));
  else {
    // The oldest tab that is not showing makes room; its instance stays and reopens from the list.
    if (context.length >= MAX_CONTEXT) {
      const drop = context.find((entry) => tabId(entry) !== active);
      if (drop) context = context.filter((entry) => entry !== drop);
    }
    context = [...context, tab];
  }
  if (show) activate(tabId(tab));
  else emit();
}
/**
 * Close a context tab. What it showed stays (a jig instance, a reference board); the neighbouring
 * tab (or the model tab) shows.
 */
export function closeContextTab(instanceId: string, kind: ContextKind = 'jig') {
  const index = context.findIndex((entry) => sameTab(entry, { instanceId, kind }));
  if (index < 0) return;
  const closed = context[index];
  context = context.filter((_, k) => k !== index);
  if (active === tabId(closed)) {
    const neighbour = context[index] ?? context[index - 1];
    active = neighbour ? tabId(neighbour) : 'model';
  }
  emit(closed);
}
export function renameContextTab(
  instanceId: string,
  label: string,
  title?: string,
  kind: ContextKind = 'jig',
) {
  if (!context.some((entry) => sameTab(entry, { instanceId, kind }))) return;
  context = context.map((entry) =>
    sameTab(entry, { instanceId, kind }) ? { ...entry, label, ...(title ? { title } : {}) } : entry,
  );
  paint();
  remember();
}
export const activeWorkspace = () => active;
export const contextTabs = (): readonly ContextTab[] => context;
/**
 * The rail destination the shown workspace belongs to: a jig instance's tab is JIG's; a reference
 * image's tab belongs to none.
 */
export const workspaceDestination = (): FixedWorkspace | undefined =>
  instanceOf(active) !== undefined
    ? 'jig'
    : referenceOf(active) !== undefined
      ? undefined
      : (active as FixedWorkspace);
/** The 3D view is part of the model tab and of every jig context tab. */
export const workspaceShowsViewport = () => active === 'model' || instanceOf(active) !== undefined;
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

/** Draw the tab row in `mount` and come back to this project's last tab. */
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
  bar = options.mount;
  const saved = recall();
  context = saved.context;
  // A last tab saved under a former id (the 보고서 tab) opens where it lives now.
  const alias = saved.active ? ALIAS[saved.active] : undefined;
  if (alias) {
    saved.active = alias.tab;
    outputView = alias.view;
  }
  active = saved.active && known(saved.active) ? saved.active : 'model';
  emit();
}

function tabButton(id: string, label: string, title?: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', 'tab');
  button.dataset.workspace = id;
  button.textContent = label;
  const selected = id === active;
  button.setAttribute('aria-selected', String(selected));
  button.tabIndex = selected ? 0 : -1;
  if (title) button.title = title;
  button.onclick = () => setWorkspace(id);
  return button;
}
function closeButton(tab: ContextTab, focusable: boolean) {
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'workspace-tab-close';
  close.textContent = '×';
  close.tabIndex = focusable ? 0 : -1;
  close.setAttribute('aria-label', `${tab.label} 탭 닫기`);
  close.title =
    tab.kind === 'reference'
      ? '탭 닫기 · 영역은 남고 첨부의 [영역 표시]로 다시 엽니다'
      : '탭 닫기 · 작업본은 남고 JIG 목록에서 다시 엽니다';
  close.onclick = (event) => {
    event.stopPropagation();
    closeContextTab(tab.instanceId, tab.kind);
  };
  return close;
}
function paint() {
  if (!bar) return;
  // Repainting replaces the row; focus comes back to the same kind of control.
  const focused = bar.contains(document.activeElement)
    ? document.activeElement instanceof HTMLSelectElement
      ? 'select'
      : '[role="tab"][aria-selected="true"]'
    : undefined;
  const list = document.createElement('div');
  list.className = 'workspace-tablist';
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', '작업공간');
  // Only what is open: the fixed screens are the rail's (user decision 2026-10-01).
  for (const tab of context) {
    const id = tabId(tab);
    const item = document.createElement('span');
    item.className = 'workspace-context-tab';
    item.toggleAttribute('data-active', id === active);
    item.append(tabButton(id, tab.label, tab.title ?? tab.label));
    item.append(closeButton(tab, id === active));
    list.append(item);
  }
  list.onkeydown = (event) => {
    const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const at = tabs.findIndex((button) => button === document.activeElement);
    if (at < 0) return;
    const current = tabs[at].dataset.workspace!;
    const move = (k: number) => {
      event.preventDefault();
      setWorkspace(tabs[(k + tabs.length) % tabs.length].dataset.workspace!);
      bar?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    };
    if (event.key === 'ArrowRight') move(at + 1);
    else if (event.key === 'ArrowLeft') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(tabs.length - 1);
    else if (event.key === 'Delete' && context.some((tab) => tabId(tab) === current)) {
      event.preventDefault();
      const tab = context.find((entry) => tabId(entry) === current)!;
      closeContextTab(tab.instanceId, tab.kind);
      bar?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    }
  };

  // Narrow screens: one menu in the centre's head instead of the row.
  const narrow = document.createElement('div');
  narrow.className = 'workspace-menu';
  const select = document.createElement('select');
  select.setAttribute('aria-label', '작업공간');
  for (const tab of FIXED) {
    const option = new Option(tab.ready ? tab.label : `${tab.label} · 준비 중`, tab.id);
    option.disabled = !tab.ready;
    if (tab.title) option.title = tab.title;
    select.append(option);
  }
  for (const [kind, label] of [
    ['jig', '열린 jig'],
    ['reference', '참고 이미지'],
  ] as const) {
    const tabs = context.filter((tab) => (tab.kind ?? 'jig') === kind);
    if (!tabs.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const tab of tabs) group.append(new Option(tab.label, tabId(tab)));
    select.append(group);
  }
  select.value = active;
  select.onchange = () => setWorkspace(select.value);
  narrow.append(select);
  const open = context.find((tab) => tabId(tab) === active);
  if (open) narrow.append(closeButton(open, true));

  bar.replaceChildren(list, narrow);
  // With nothing open the row hides where the rail is shown, so the content gets the space.
  bar.toggleAttribute('data-empty', !context.length);
  if (focused) bar.querySelector<HTMLElement>(focused)?.focus();
}
