import { setMobileView } from './mobile-navigation.tsx';
import { element as $ } from './elements.ts';
import { activeWorkspace, onWorkspaceChange, workspaceDestination } from './workspaces.ts';

/** The model screen's left panel shows one section: the document tree or the task history. */
let section = 'document-tree';
/**
 * The rail (user decision 2026-10-01): fixed destinations, one pressed for the screen shown. The
 * model screen's two left-panel sections are two destinations (모델, 작업 이력); a context tab
 * (a jig instance) belongs to JIG. Pressed is a soft background only (style.css `.rail`).
 */
function paintRail() {
  const destination = workspaceDestination();
  const current =
    destination === 'model' && activeWorkspace() === 'model' && section === 'task-list'
      ? 'history'
      : destination;
  for (const button of document.querySelectorAll<HTMLElement>('.rail [data-workspace-target]'))
    button.setAttribute('aria-pressed', String(button.dataset.workspaceTarget === current));
}
export function initializeWorkspacePanels() {
  const groups = new Map<string, HTMLElement[]>();
  const documents = [$('connection-card'), $('document-tree')];
  groups.set('document-tree', documents);
  // 작업 이력 is the request list only (T-109): 검토본 live in 산출물, attachments in each work view.
  groups.set('task-list', [$('task-list').closest('details')!]);
  // The rail's 모델 and 작업 이력 open the model screen on their section (src/ui/app.ts switches it).
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.rail [data-section]')];
  const mobileButtons: HTMLButtonElement[] = [];
  function select(id: string, expand = true) {
    section = id;
    for (const [key, nodes] of groups)
      for (const node of nodes) {
        node.hidden = key !== id;
        if (expand && key === id && node instanceof HTMLDetailsElement) node.open = true;
      }
    for (const button of mobileButtons)
      button.setAttribute('aria-pressed', String(button.dataset.tab === id));
    paintRail();
  }
  buttons.forEach((button) =>
    button.addEventListener('click', () => {
      if ($('left').hidden) $('toggle-left').click();
      // Mobile navigation owns visibility of the same panels: 모델 is the model view there and
      // 작업 이력 the documents view.
      setMobileView(button.dataset.section === 'task-list' ? 'documents' : 'model');
      select(button.dataset.section!);
    }),
  );
  onWorkspaceChange(() => paintRail());
  // Below 850 px the rail is gone; the left panel names its two sections itself.
  const mobileTabs = document.createElement('nav');
  mobileTabs.className = 'left-panel-tabs';
  mobileTabs.setAttribute('aria-label', '문서 패널 탭');
  for (const [id, label] of [
    ['document-tree', '작업 문서'],
    ['task-list', '작업 이력'],
  ]) {
    const tab = document.createElement('button');
    tab.textContent = label;
    tab.dataset.tab = id;
    mobileButtons.push(tab);
    tab.onclick = () => {
      select(id);
    };
    mobileTabs.append(tab);
  }
  select('document-tree', false);
  $('left').prepend(mobileTabs);
  const root = document.documentElement;
  let widths = { left: 266, right: 370 };
  try {
    const saved = JSON.parse(localStorage.getItem('vide:panel-widths') || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.right)) widths = saved;
  } catch {
    /* Invalid local preference uses defaults. */
  }
  const handles: HTMLDivElement[] = [];
  function layout() {
    const available = Math.max(520, innerWidth - 48 - 260);
    widths.left = Math.max(200, Math.min(480, widths.left));
    widths.right = Math.max(280, Math.min(640, widths.right));
    if (widths.left + widths.right > available) {
      widths.right = Math.max(280, available - widths.left);
      widths.left = Math.max(200, available - widths.right);
    }
    for (const side of ['left', 'right'] as const) {
      root.style.setProperty('--' + side + '-width', widths[side] + 'px');
      handles
        .find((handle) => handle.dataset.side === side)
        ?.setAttribute('aria-valuenow', String(widths[side]));
    }
  }
  function persist() {
    try {
      localStorage.setItem('vide:panel-widths', JSON.stringify(widths));
    } catch {
      /* Session resizing still works. */
    }
  }
  for (const side of ['left', 'right'] as const) {
    const handle = document.createElement('div');
    handle.className = 'panel-resize panel-resize-' + side;
    handle.dataset.side = side;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', side === 'left' ? '문서 패널 너비' : '대화 패널 너비');
    handle.setAttribute('aria-valuemin', side === 'left' ? '200' : '280');
    handle.setAttribute('aria-valuemax', side === 'left' ? '480' : '640');
    handle.tabIndex = 0;
    document.querySelector('.workspace')!.append(handle);
    handles.push(handle);
    let drag: { x: number; width: number } | undefined;
    handle.onpointerdown = (event) => {
      drag = { x: event.clientX, width: widths[side] };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    handle.onpointermove = (event) => {
      if (!drag) return;
      widths[side] = drag.width + (event.clientX - drag.x) * (side === 'left' ? 1 : -1);
      layout();
    };
    handle.onpointerup = () => {
      drag = undefined;
      persist();
    };
    handle.onlostpointercapture = () => {
      drag = undefined;
      persist();
    };
    handle.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault();
      widths[side] =
        event.key === 'Home'
          ? side === 'left'
            ? 266
            : 370
          : widths[side] + (event.key === 'ArrowRight' ? 16 : -16) * (side === 'left' ? 1 : -1);
      layout();
      persist();
    };
  }
  addEventListener('resize', layout);
  layout();
  const composerHandle = $('composer-resize');
  const body = $('body');
  let composerHeight = 96;
  try {
    const stored = Number(localStorage.getItem('vide:composer-height'));
    if (stored > 0) composerHeight = stored;
  } catch {
    /* Local preference is optional. */
  }
  function composerLayout() {
    const max = Math.max(76, Math.min(400, innerHeight * 0.45));
    composerHeight = Math.max(76, Math.min(max, composerHeight));
    body.style.height = `${composerHeight}px`;
    composerHandle.setAttribute('aria-valuemin', '76');
    composerHandle.setAttribute('aria-valuemax', String(Math.round(max)));
    composerHandle.setAttribute('aria-valuenow', String(Math.round(composerHeight)));
  }
  function saveComposer() {
    try {
      localStorage.setItem('vide:composer-height', String(composerHeight));
    } catch {
      /* Session resizing still works. */
    }
  }
  let composerDrag: { y: number; height: number } | undefined;
  composerHandle.onpointerdown = (event) => {
    if (event.button !== 0) return;
    composerDrag = { y: event.clientY, height: composerHeight };
    composerHandle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  composerHandle.onpointermove = (event) => {
    if (!composerDrag) return;
    composerHeight = composerDrag.height + composerDrag.y - event.clientY;
    composerLayout();
  };
  composerHandle.onlostpointercapture = composerHandle.onpointerup = () => {
    composerDrag = undefined;
    saveComposer();
  };
  composerHandle.onkeydown = (event) => {
    if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault();
    composerHeight =
      event.key === 'Home' ? 96 : composerHeight + (event.key === 'ArrowUp' ? 16 : -16);
    composerLayout();
    saveComposer();
  };
  addEventListener('resize', composerLayout);
  composerLayout();
}
