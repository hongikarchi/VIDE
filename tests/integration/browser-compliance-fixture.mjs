// The 법규 체크 screen in a bare page (PLAN-48 T-239): the declared panel of
// `vide/compliance-check` drawn by the real `JigPanel` with a real viewport for its 3D overlay;
// the engine is played by the test through routed `api/v1` answers (browser-compliance.mjs).
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JigPanel } from '../../src/ui/jig-panel/panel.tsx';
import { createViewport } from '../../src/ui/viewport.ts';
import { SELECT_NATIVE_EVENT } from '../../src/ui/legal-target.ts';
import panel from '../../src/jigs/official/jigs/compliance-check/panel.json';
import '../../src/ui/tokens.css';

export function mount({ remote = false, width = 1100, projectId = 'p1', instanceId = 'i1' } = {}) {
  const record = { overlay: [], focus: [], selected: [] };
  window.addEventListener(SELECT_NATIVE_EVENT, (event) => record.selected.push(event.detail));
  const stage = document.createElement('div');
  Object.assign(stage.style, { display: 'flex', gap: '12px', alignItems: 'flex-start' });
  const root = document.createElement('div');
  root.id = 'panel-root';
  Object.assign(root.style, { width: `${width}px`, flex: 'none' });
  const viewport = document.createElement('div');
  Object.assign(viewport.style, { width: '320px', height: '240px', position: 'relative' });
  stage.append(root, viewport);
  document.body.append(stage);
  const pickListeners = new Set();
  const view = createViewport(
    viewport,
    [],
    (_ids, _mode, source) => {
      if (source.source === 'overlay')
        for (const listener of pickListeners) listener({ key: source.key, itemId: source.itemId });
    },
    () => {},
  );
  const host = {
    projectId,
    remote,
    overlay(key, items) {
      record.overlay.push({ key, n: items ? items.length : null });
      view.overlay(key, items);
    },
    focus(target) {
      record.focus.push(target);
      view.focus(target);
    },
    onOverlayPick(listener) {
      pickListeners.add(listener);
      return () => pickListeners.delete(listener);
    },
  };
  createRoot(root).render(createElement(JigPanel, { host, panel, instanceId }));
  return { record, view };
}
