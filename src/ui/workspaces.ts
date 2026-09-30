// Workspace tabs (Design §03 작업공간 탭, decision A4; SCR-13·18): fixed-layout tabs over the
// centre column and one closable context tab per opened jig. A tab changes the centre, the left
// column and the drawer only; the conversation column, drafts and the selection stay as they are.
// There is no free docking, splitting or node editor. Below 900 px the row becomes one menu. The
// last tab and the open context tabs are a viewer convenience remembered per project in this
// browser's storage; a blocked or empty storage just opens the model tab.

export type FixedWorkspace = 'model' | 'data' | 'jig' | 'make' | 'report';
/** A jig opened in its own tab: a jig instance (작업본) id, or `legacy:<jigId>` for older jigs. */
export interface ContextTab {
  instanceId: string;
  label: string;
  /** The longer name shown as the tab's tooltip. */
  title?: string;
}
export interface WorkspaceChange {
  /** A fixed tab id, or `contextId(instanceId)` of a context tab. */
  active: string;
  context: readonly ContextTab[];
  /** The context tab this change closed. */
  closed?: ContextTab;
}

// The data and make tabs open with PLAN-22 T-065 and T-063; the report tab is T-057.
const FIXED: { id: FixedWorkspace; label: string; ready: boolean }[] = [
  { id: 'model', label: '모델', ready: true },
  { id: 'data', label: '자료', ready: false },
  { id: 'jig', label: 'JIG', ready: true },
  { id: 'make', label: '만들기', ready: false },
  { id: 'report', label: '보고서', ready: true },
];
const PREFIX = 'jig:';
export const contextId = (instanceId: string) => PREFIX + instanceId;
const instanceOf = (id: string) => (id.startsWith(PREFIX) ? id.slice(PREFIX.length) : undefined);
const MAX_CONTEXT = 12;

let projectId: string | undefined;
let active = 'model';
let context: ContextTab[] = [];
/** The jig used last (its tab open or closed), for the rail's JIG button. */
let lastJig: string | undefined;
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
        label: entry.label.slice(0, 120),
        ...(typeof entry.title === 'string' ? { title: entry.title.slice(0, 300) } : {}),
      }));
    return { active: typeof tab === 'string' ? tab : undefined, context: valid };
  } catch {
    return { context: [] };
  }
}

function known(id: string) {
  const instance = instanceOf(id);
  if (instance !== undefined) return context.some((tab) => tab.instanceId === instance);
  return FIXED.some((tab) => tab.id === id && tab.ready);
}
function emit(closed?: ContextTab) {
  document.body.dataset.workspace =
    active === 'model' || active === 'jig' || active === 'report' ? active : 'context';
  // The report screen loads when its tab is first shown (src/ui/report-tab.tsx).
  if (active === 'report' && projectId)
    void import('./report-tab.tsx').then((screen) => screen.showReports(projectId!));
  paint();
  remember();
  const change = { active, context, ...(closed ? { closed } : {}) };
  for (const listener of listeners) listener(change);
}
function activate(id: string) {
  const instance = instanceOf(id);
  if (instance !== undefined) lastJig = instance;
  active = id;
  emit();
}

/**
 * Show a tab: a fixed tab id, a context tab id, or with `instanceId` the jig instance's context
 * tab — opened first when it is not in the row (the jig screen resolves its name).
 */
export function setWorkspace(id: string, options: { instanceId?: string } = {}) {
  if (options.instanceId !== undefined) {
    const instanceId = options.instanceId;
    if (context.some((tab) => tab.instanceId === instanceId)) activate(contextId(instanceId));
    else
      void resolver?.(instanceId).then((tab) => {
        if (tab) openContextTab(tab);
      });
    return;
  }
  if (known(id)) activate(id);
}
/** Add a jig's context tab (or rename it when present) and show it unless `show` is false. */
export function openContextTab(tab: ContextTab, show = true) {
  const index = context.findIndex((entry) => entry.instanceId === tab.instanceId);
  if (index >= 0) context = context.map((entry, k) => (k === index ? { ...entry, ...tab } : entry));
  else {
    // The oldest tab that is not showing makes room; its instance stays and reopens from the list.
    if (context.length >= MAX_CONTEXT) {
      const drop = context.find((entry) => contextId(entry.instanceId) !== active);
      if (drop) context = context.filter((entry) => entry !== drop);
    }
    context = [...context, tab];
  }
  if (show) activate(contextId(tab.instanceId));
  else emit();
}
/** Close a context tab. The jig instance stays; the neighbouring tab (or the model tab) shows. */
export function closeContextTab(instanceId: string) {
  const index = context.findIndex((entry) => entry.instanceId === instanceId);
  if (index < 0) return;
  const closed = context[index];
  context = context.filter((_, k) => k !== index);
  if (active === contextId(instanceId)) {
    const neighbour = context[index] ?? context[index - 1];
    active = neighbour ? contextId(neighbour.instanceId) : 'model';
  }
  emit(closed);
}
export function renameContextTab(instanceId: string, label: string, title?: string) {
  if (!context.some((entry) => entry.instanceId === instanceId)) return;
  context = context.map((entry) =>
    entry.instanceId === instanceId ? { ...entry, label, ...(title ? { title } : {}) } : entry,
  );
  paint();
  remember();
}
export const activeWorkspace = () => active;
export const contextTabs = (): readonly ContextTab[] => context;
/** The instance id of the jig shown last, its tab open or not. */
export const lastJigInstance = () => lastJig;
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
  bar = options.mount;
  const saved = recall();
  context = saved.context;
  const target = saved.active && known(saved.active) ? saved.active : 'model';
  const instance = instanceOf(target);
  if (instance !== undefined) lastJig = instance;
  active = target;
  emit();
}

function tabButton(id: string, label: string, ready: boolean, title?: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', 'tab');
  button.dataset.workspace = id;
  button.textContent = label;
  const selected = id === active;
  button.setAttribute('aria-selected', String(selected));
  button.tabIndex = selected ? 0 : -1;
  if (title) button.title = title;
  if (!ready) {
    // Visible so the layout is known, but not yet usable; the tooltip says so.
    button.setAttribute('aria-disabled', 'true');
    button.title = '준비 중입니다';
  }
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
  close.title = '탭 닫기 · 작업본은 남고 JIG 목록에서 다시 엽니다';
  close.onclick = (event) => {
    event.stopPropagation();
    closeContextTab(tab.instanceId);
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
  for (const tab of FIXED) list.append(tabButton(tab.id, tab.label, tab.ready));
  if (context.length) {
    const rule = document.createElement('span');
    rule.className = 'workspace-tabs-rule';
    rule.setAttribute('aria-hidden', 'true');
    list.append(rule);
  }
  for (const tab of context) {
    const id = contextId(tab.instanceId);
    const item = document.createElement('span');
    item.className = 'workspace-context-tab';
    item.toggleAttribute('data-active', id === active);
    item.append(tabButton(id, tab.label, true, tab.title ?? tab.label));
    item.append(closeButton(tab, id === active));
    list.append(item);
  }
  list.onkeydown = (event) => {
    const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(
      (button) => button.getAttribute('aria-disabled') !== 'true',
    );
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
    else if (event.key === 'Delete' && instanceOf(current) !== undefined) {
      event.preventDefault();
      closeContextTab(instanceOf(current)!);
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
    select.append(option);
  }
  if (context.length) {
    const group = document.createElement('optgroup');
    group.label = '열린 jig';
    for (const tab of context) group.append(new Option(tab.label, contextId(tab.instanceId)));
    select.append(group);
  }
  select.value = active;
  select.onchange = () => setWorkspace(select.value);
  narrow.append(select);
  const open = context.find((tab) => contextId(tab.instanceId) === active);
  if (open) narrow.append(closeButton(open, true));

  bar.replaceChildren(list, narrow);
  if (focused) bar.querySelector<HTMLElement>(focused)?.focus();
}
