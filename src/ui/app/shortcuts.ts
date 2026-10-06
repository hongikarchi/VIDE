// Keyboard shortcuts of the work screen (PLAN-26 T-113): one document keydown listener runs the
// regions' handlers in a fixed order. A handler that returns 'stop' ends the key's handling (the
// old single listener's `return`); any other result lets the next handler see the key.
import { escapeEffortMenu } from './composer.ts';
import { panelToggleKeys } from './left.ts';
import { escapeSelection, escapeSketch, sketchKeys, viewKeys, walkKeys } from './viewport.ts';

export type ShortcutResult = 'stop' | void;
export type ShortcutHandler = (event: KeyboardEvent) => ShortcutResult;

/** The order is part of the contract: change it only here. */
export const SHORTCUT_ORDER = {
  walkKeys: 5,
  sketchKeys: 10,
  viewKeys: 20,
  escapeSelection: 30,
  escapeSketch: 40,
  escapeEffortMenu: 50,
  panelToggleKeys: 60,
} as const;

const handlers: { order: number; handler: ShortcutHandler }[] = [];

export function registerShortcut(order: number, handler: ShortcutHandler) {
  handlers.push({ order, handler });
  handlers.sort((a, b) => a.order - b.order);
}

/** A key typed into a field (or an editable text such as a note, SPEC-10) is text, not a shortcut. */
export function isTyping(event: KeyboardEvent) {
  return (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLSelectElement ||
    (event.target instanceof HTMLElement && event.target.isContentEditable)
  );
}

export function initShortcuts() {
  registerShortcut(SHORTCUT_ORDER.walkKeys, walkKeys);
  registerShortcut(SHORTCUT_ORDER.sketchKeys, sketchKeys);
  registerShortcut(SHORTCUT_ORDER.viewKeys, viewKeys);
  registerShortcut(SHORTCUT_ORDER.escapeSelection, escapeSelection);
  registerShortcut(SHORTCUT_ORDER.escapeSketch, escapeSketch);
  registerShortcut(SHORTCUT_ORDER.escapeEffortMenu, escapeEffortMenu);
  registerShortcut(SHORTCUT_ORDER.panelToggleKeys, panelToggleKeys);
  document.addEventListener('keydown', (e) => {
    for (const { handler } of handlers) if (handler(e) === 'stop') return;
  });
}
