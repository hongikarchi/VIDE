import { setMobileView } from './mobile-navigation.tsx';
import { element as $ } from './elements.ts';
export function initializeWorkspacePanels() {
  const groups = new Map<string, HTMLElement[]>();
  const documents = [
    $('host-target'),
    $('host-document-controls').closest('details')!,
    document.querySelector<HTMLElement>('.document-heading')!,
    $('document-tree'),
  ];
  groups.set('document-tree', documents);
  groups.set('task-list', [
    $('task-list').closest('details')!,
    $('review-list').closest('details')!,
  ]);
  groups.set('reference-list', [$('reference-list').closest('details')!]);
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-section]')];
  const mobileButtons: HTMLButtonElement[] = [];
  function select(id: string, expand = true) {
    for (const [key, nodes] of groups)
      for (const node of nodes) {
        node.hidden = key !== id;
        if (expand && key === id && node instanceof HTMLDetailsElement) node.open = true;
      }
    for (const button of [...buttons, ...mobileButtons])
      button.setAttribute(
        'aria-pressed',
        String((button.dataset.section || button.dataset.tab) === id),
      );
  }
  buttons.forEach((button) =>
    button.addEventListener('click', () => {
      if ($('left').hidden) $('toggle-left').click();
      // Mobile navigation owns visibility of the same panels.
      setMobileView('documents');
      select(button.dataset.section!);
    }),
  );
  select('document-tree', false);
  const mobileTabs = document.createElement('nav');
  mobileTabs.className = 'left-panel-tabs';
  mobileTabs.setAttribute('aria-label', '문서 패널 탭');
  buttons.forEach((button) => {
    const tab = document.createElement('button');
    tab.textContent = button.getAttribute('aria-label');
    tab.dataset.tab = button.dataset.section;
    tab.setAttribute('aria-pressed', String(button.dataset.section === 'document-tree'));
    mobileButtons.push(tab);
    tab.onclick = () => {
      select(button.dataset.section!);
    };
    mobileTabs.append(tab);
  });
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
}
