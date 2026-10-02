// 3D viewport and inspector (PLAN-26 T-113, region B): selection, sketch tool and brush, captures,
// view buttons and the project card thumbnail.
import { z } from 'zod';
import { workspaceShowsViewport } from '../workspaces.ts';
import { renderInspector, initializeInspector, iconSvg } from '../inspector.ts';
import { showQuantities } from '../quantities.tsx';
import { attachNativeAttributes } from '../native-attributes.ts';
import { type SelectMode } from '../object-list.ts';
import { objects, attachBrushSketch } from '../model.ts';
import { displayIdOf, sourceIdOf } from '../layers.ts';
import { initializeViewportEmpty } from '../viewport-empty.ts';
import { element as $, readableError } from '../elements.ts';
import { createViewport } from '../viewport.ts';
import { overlayPicked } from '../jigs.tsx';
import { initializeDisplaySettings } from '../display-settings.ts';
import { selectionState } from '../store/selection.ts';
import { draftState } from '../store/draft.ts';
import { linksState } from '../store/links.ts';
import { viewerState } from '../store/viewer.ts';
import { sketchState } from '../store/sketch.ts';
import { sessionState } from '../store/session.ts';
import { isTyping, type ShortcutResult } from './shortcuts.ts';
import { currentProject } from './context.ts';
import { applyActiveLayer } from './links-sync.ts';
import { renderLinkPanel, mobileView } from './left.ts';
import { render, renderMessages } from './render.ts';
import { message } from './status.ts';
import { pinComposer } from './composer.ts';

/** Rhino-style selection: replace by default, Shift adds, Ctrl removes. */
export function applySelection(ids: string[], mode: SelectMode) {
  if (mode === 'replace') selectionState.selectedIds = [...new Set(ids)];
  else if (mode === 'add')
    selectionState.selectedIds = [...new Set([...selectionState.selectedIds, ...ids])];
  else selectionState.selectedIds = selectionState.selectedIds.filter((id) => !ids.includes(id));
  draftState.state.selected = selectionState.selectedIds.at(-1) ?? null;
  const picked = objects.find((object) => object.id === draftState.state.selected);
  if (typeof picked?.documentKey === 'string' && picked.documentKey !== linksState.activeLayer) {
    linksState.activeLayer = picked.documentKey;
    applyActiveLayer();
    renderLinkPanel();
  }
  render();
}
/** Show a result and select one of its objects by the object's own id. */
export function selectInResult(requestId: string | undefined, id: string) {
  if (requestId) {
    selectionState.selectedResult = requestId;
    selectionState.appliedSelection = undefined;
    renderMessages();
  }
  draftState.state.selected = (requestId && displayIdOf(objects, requestId, id)) || id;
  render();
  return draftState.state.selected;
}
export let viewportEmpty!: ReturnType<typeof initializeViewportEmpty>;
export function captureViewport() {
  if (!viewerState.viewport) throw Error('3D 화면을 준비한 뒤 다시 시도하세요.');
  return viewerState.viewport.capture();
}
/**
 * The view with the draft's sketch strokes and numbered pin markers, small enough for the stored
 * request (the whole input stays under 200 KB); undefined without pins/sketches or a view.
 */
export function annotatedCapture() {
  if (!viewerState.viewport || (!draftState.state.pins.length && !draftState.state.sketches.length))
    return undefined;
  const pins = draftState.state.pins.flatMap((pin, index) => {
    const id = displayIdOf(objects, pin.basis, pin.id);
    return id ? [{ id, label: /\d+/.exec(pin.label ?? '')?.[0] ?? String(index + 1) }] : [];
  });
  try {
    for (const [maxSize, quality] of [
      [1280, 0.8],
      [960, 0.7],
      [720, 0.6],
    ]) {
      const dataUrl = viewerState.viewport.captureWithAnnotations(pins, { maxSize, quality });
      if (dataUrl.length <= 150_000 && /^data:image\/(png|jpeg);base64,/.test(dataUrl))
        return { kind: 'annotated' as const, name: '고정·스케치 화면', dataUrl };
    }
  } catch {
    /* No picture: the pins and sketches still go as data. */
  }
  return undefined;
}
/** Unattached brush strokes. */
export function pendingSketch() {
  return sketchState.strokes.length > 0;
}
export function draw() {
  viewerState.viewport?.sketches(draftState.state.sketches, sketchState.strokes);
  $('finish-sketch').disabled = !sketchState.strokes.length;
  $('undo-point').disabled = !pendingSketch();
  $('clear-sketch').disabled = !pendingSketch();
}
export const followSurface = () => $('brush-surface').getAttribute('aria-pressed') !== 'false';
export function brushSettings() {
  const width = $('brush-width').valueAsNumber || 4;
  $('brush-width-value').textContent = String(width);
  for (const swatch of document.querySelectorAll<HTMLButtonElement>('.swatch'))
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color === $('brush-color').value));
  viewerState.viewport?.brush({
    color: $('brush-color').value,
    width,
    surface: followSurface(),
    erase: $('brush-eraser').getAttribute('aria-pressed') === 'true',
  });
  draw();
}
export function setEraser(on: boolean) {
  $('brush-eraser').setAttribute('aria-pressed', String(on));
  brushSettings();
}
/** Attach the drawn strokes to the message as one sketch. */
export function attachStrokes() {
  if (!sketchState.strokes.length) return;
  attachBrushSketch(draftState.state, sketchState.strokes, {
    placement: followSurface() ? 'surface' : 'view',
  });
  sketchState.strokes = [];
  render();
}
export function setTool(next: 'select' | 'sketch') {
  // Leaving the sketch tool keeps what was drawn: the strokes join the message as a sketch.
  if (sketchState.tool === 'sketch' && next !== 'sketch' && pendingSketch())
    try {
      attachStrokes();
      message('그린 선을 입력에 첨부했습니다.');
    } catch (cause) {
      message(readableError(cause).message);
      return;
    }
  sketchState.tool = next;
  document
    .querySelectorAll<HTMLButtonElement>('[data-tool]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === sketchState.tool)));
  $('sketch-tools').hidden = sketchState.tool !== 'sketch';
  viewerState.viewport?.mode(sketchState.tool);
  if (sketchState.tool === 'sketch') brushSettings();
  $('tool-hint').textContent =
    sketchState.tool === 'sketch'
      ? '펜·드래그로 그리기 · 손가락/우클릭 회전 · 두 손가락/Shift+우클릭 이동 · 휠·핀치 확대 · 위/앞/옆 보기는 그 평면에 그리기'
      : '';
  draw();
}
/** A small viewport image for the project card on the account website (signed-in PCs only). */
export function scheduleThumbnail() {
  if (!sessionState.accountSite || !sessionState.project) return;
  clearTimeout(viewerState.thumbnailTimer);
  const wait = Date.now() - viewerState.thumbnailSent > 60_000 ? 1500 : 60_000;
  viewerState.thumbnailTimer = setTimeout(() => void sendThumbnail().catch(() => {}), wait);
}
export async function sendThumbnail() {
  if (!viewerState.viewport || !sessionState.project || !objects.length) return;
  const target = sessionState.project.id,
    source = new Image();
  source.src = viewerState.viewport.capture();
  await source.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 300;
  const scale = Math.max(480 / source.width, 300 / source.height),
    width = source.width * scale,
    height = source.height * scale;
  canvas.getContext('2d')?.drawImage(source, (480 - width) / 2, (300 - height) / 2, width, height);
  if (sessionState.project?.id !== target) return;
  viewerState.thumbnailSent = Date.now();
  // Plain fetch: a missed card image is not a work error worth reporting.
  await fetch(`api/v1/projects/${encodeURIComponent(target)}/thumbnail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: canvas.toDataURL('image/jpeg', 0.72) }),
  });
}
/** The viewport selection has objects not yet pinned (the selection bar's [요청에 고정]). */
export function canPin() {
  return (
    sessionState.ready &&
    !sessionState.busy &&
    selectionState.selectedIds.some((id) => {
      const object = objects.find((o) => o.id === id && o.revision);
      return (
        !!object &&
        !draftState.state.pins.some(
          (p) => p.id === sourceIdOf(object) && p.basis === object.revision,
        )
      );
    })
  );
}

export function initViewport1() {
  viewportEmpty = initializeViewportEmpty($('canvas').parentElement!);
}

export function initViewport2() {
  initializeInspector((tab) => {
    viewerState.inspectorTab = tab;
    render();
  });
  try {
    viewerState.viewport = createViewport(
      $('canvas'),
      objects,
      (ids, mode, source) =>
        source.source === 'overlay' ? overlayPicked(source) : applySelection(ids, mode),
      (event) => {
        if (event.type === 'stroke') {
          if (sketchState.strokes.length >= 200) {
            message('스케치 하나에 200획까지 그릴 수 있습니다. 먼저 첨부하세요.');
            return;
          }
          sketchState.strokes.push(event.stroke);
        } else sketchState.strokes.splice(event.index, 1);
        draw();
      },
      (camera) => {
        document
          .querySelectorAll<HTMLButtonElement>('[data-view]')
          .forEach((button) =>
            button.setAttribute('aria-pressed', String(button.dataset.view === camera.view)),
          );
        const toggle = $('projection-toggle');
        toggle.dataset.projection = camera.projection;
        // The icon shows the current projection; the button switches to the other one.
        toggle.innerHTML = iconSvg(
          camera.projection === 'perspective' ? 'perspective' : 'orthographic',
        );
        toggle.title =
          camera.projection === 'perspective'
            ? '지금 원근 투영 · 눌러서 평행(직교) 투영'
            : '지금 평행(직교) 투영 · 눌러서 원근 투영';
        toggle.setAttribute(
          'aria-label',
          camera.projection === 'perspective' ? '평행 투영으로 전환' : '원근 투영으로 전환',
        );
      },
    );
  } catch {
    message('3D 뷰포트를 열 수 없습니다. WebGL 지원을 확인하세요.');
  }
  initializeDisplaySettings($('display-settings') as HTMLButtonElement, (settings) =>
    viewerState.viewport?.display(settings),
  );
}

export function initViewport3() {
  $('selection-pin').onclick = () => {
    if (canPin()) pinComposer.insertSelection();
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]'))
    button.onclick = () => setTool(z.enum(['select', 'sketch']).parse(button.dataset.tool));
  for (const id of ['brush-color', 'brush-width'] as const)
    $(id).addEventListener('input', brushSettings);
  $('brush-surface').onclick = () => {
    $('brush-surface').setAttribute('aria-pressed', String(!followSurface()));
    brushSettings();
  };
  for (const swatch of document.querySelectorAll<HTMLButtonElement>('.swatch')) {
    // The page CSP blocks inline style attributes; set each swatch's color through the CSSOM.
    swatch.style.setProperty('--swatch', swatch.dataset.color ?? '#d0473a');
    swatch.onclick = () => {
      $('brush-color').value = swatch.dataset.color ?? '#d0473a';
      setEraser(false);
    };
  }
  $('brush-eraser').onclick = () =>
    setEraser($('brush-eraser').getAttribute('aria-pressed') !== 'true');
  $('clear-sketch').onclick = () => {
    sketchState.strokes = [];
    draw();
  };
  $('finish-sketch').onclick = () => {
    try {
      attachStrokes();
      setTool('select');
      mobileView('input');
      $('body').focus();
    } catch (cause) {
      message(readableError(cause).message);
    }
  };
  $('cancel-sketch').onclick = () => {
    sketchState.strokes = [];
    setTool('select');
  };
  $('undo-point').onclick = () => {
    sketchState.strokes.pop();
    draw();
  };
  $('fit-view').onclick = () => viewerState.viewport?.fit();
  $('projection').onchange = () => {
    if ($('projection').value === 'axon') viewerState.viewport?.home();
    else
      viewerState.viewport?.plane(
        ({ plan: 'XY', front: 'XZ', side: 'YZ' } as const)[
          z.enum(['plan', 'front', 'side']).parse($('projection').value)
        ],
      );
  };
}

export function initViewport4() {
  window.addEventListener('pagehide', () => viewerState.viewport?.dispose(), { once: true });
}

export function initViewport5() {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
    button.onclick = () => {
      $('projection').value = z.enum(['axon', 'plan', 'front', 'side']).parse(button.dataset.view);
      $('projection').dispatchEvent(new Event('change'));
    };
  $('fit-selection').onclick = () => {
    if (draftState.state.selected) viewerState.viewport?.fit(draftState.state.selected);
    else message('먼저 객체를 선택하세요.');
  };
  $('projection-toggle').onclick = () => {
    viewerState.viewport?.projection(
      $('projection-toggle').dataset.projection === 'perspective' ? 'orthographic' : 'perspective',
    );
  };
}

/** render(): the multi-selection follows the primary selection and the objects shown. */
export function normalizeSelection() {
  // Other panels may set a single primary selection; keep the multi-selection consistent.
  if (draftState.state.selected && !selectionState.selectedIds.includes(draftState.state.selected))
    selectionState.selectedIds = [draftState.state.selected];
  if (!draftState.state.selected && selectionState.selectedIds.length)
    selectionState.selectedIds = [];
  selectionState.selectedIds = selectionState.selectedIds.filter((id) =>
    objects.some((o) => o.id === id),
  );
}
/** render(): the viewport selection, the inspector title and the selection bar. */
export function paintSelection() {
  viewerState.viewport?.select(selectionState.selectedIds);
  $('selection').textContent =
    selectionState.selectedIds.length > 1
      ? `${selectionState.selectedIds.length.toLocaleString()}개 객체 선택`
      : objects.find((o) => o.id === draftState.state.selected)?.name || '';
  $('selection-bar').hidden = !selectionState.selectedIds.length;
  $('selection-count').textContent = `${selectionState.selectedIds.length.toLocaleString()}개 선택`;
}
/** render(): the inspector of the picked object; returns the request it was read from. */
export function paintInspector() {
  const inspected = objects.find((o) => o.id === draftState.state.selected);
  const active = draftState.state.messages.find(
    (m) =>
      m.id ===
      (typeof inspected?.revision === 'string'
        ? inspected.revision
        : selectionState.displayedResult),
  )?.request;
  renderInspector(
    inspected && { ...inspected, id: sourceIdOf(inspected) },
    active?.result,
    active,
    viewerState.inspectorTab,
    {
      quantities: (request, object) => {
        if (!request) return;
        void showQuantities(
          currentProject().id,
          request.id,
          (id) => {
            selectInResult(request.id, id);
          },
          object.id,
        ).catch((error) => message(error.message));
      },
      attachAttributes: (request, object) => {
        try {
          if (sessionState.busy) throw Error('전송이 끝난 뒤 첨부하세요.');
          if (!request) throw Error('기준 후보를 확인하세요.');
          attachNativeAttributes(draftState.state, request, object);
          render();
          message('표시된 속성을 요청 초안에 첨부했습니다.');
        } catch (cause) {
          const error = readableError(cause);
          message(error.message);
        }
      },
      get: (id) => draftState.state.messages.find((message) => message.id === id)?.request,
      open: (id, objectId) => {
        if (objectId) selectInResult(id, objectId);
        else {
          selectionState.selectedResult = id;
          selectionState.appliedSelection = undefined;
          renderMessages();
          draftState.state.selected = null;
          render();
        }
      },
    },
  );
  return active;
}
export type ActiveRequest = ReturnType<typeof paintInspector>;
/** render(): after the inspector, the multi-selection title and the empty-view state. */
export function paintSelectionTitle(active: ActiveRequest) {
  if (selectionState.selectedIds.length > 1)
    $('selection').textContent =
      `${selectionState.selectedIds.length.toLocaleString()}개 객체 선택`;
  viewportEmpty.modelShown(Boolean(active?.result?.hostExecuted) || sketchState.tool === 'sketch');
}

/** Sketch tool keys (shortcut order 10): E eraser, S surface, Ctrl+Z last stroke, [ ] width. */
export function sketchKeys(e: KeyboardEvent): ShortcutResult {
  if (sketchState.tool === 'sketch' && !isTyping(e)) {
    if (e.key === 'e' || e.key === 'E') {
      setEraser($('brush-eraser').getAttribute('aria-pressed') !== 'true');
      return 'stop';
    }
    if (e.key === 's' || e.key === 'S') {
      $('brush-surface').click();
      return 'stop';
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      $('undo-point').click();
      return 'stop';
    }
    if (e.key === '[' || e.key === ']') {
      const width = $('brush-width').valueAsNumber + (e.key === ']' ? 1 : -1);
      $('brush-width').value = String(Math.min(24, Math.max(1, width)));
      brushSettings();
      return 'stop';
    }
  }
}
/** 3D view keys (order 20): only where the 3D view is (not the JIG list). */
export function viewKeys(e: KeyboardEvent): ShortcutResult {
  const viewport = viewerState.viewport;
  if (
    !isTyping(e) &&
    sketchState.tool !== 'sketch' &&
    viewport &&
    !e.altKey &&
    workspaceShowsViewport()
  ) {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 'a') {
      e.preventDefault();
      const shown = new Set(viewport.visibleIds());
      selectionState.selectedIds = objects.map((o) => o.id).filter((id) => shown.has(id));
      draftState.state.selected = selectionState.selectedIds.at(-1) ?? null;
      render();
      return 'stop';
    }
    if (!e.ctrlKey && !e.metaKey && ['h', 'i', 'u', 'z'].includes(key)) {
      e.preventDefault();
      if (key === 'z')
        viewport.fit(selectionState.selectedIds.length ? selectionState.selectedIds : undefined);
      else if (key === 'u') {
        const count = viewport.hiddenCount();
        viewport.unhide();
        if (count) message(`숨긴 객체 ${count.toLocaleString()}개를 다시 표시했습니다.`);
      } else if (!selectionState.selectedIds.length) message('먼저 객체를 선택하세요.');
      else {
        if (key === 'h') viewport.hide(selectionState.selectedIds);
        else viewport.isolate(selectionState.selectedIds);
        message(
          key === 'h'
            ? `${selectionState.selectedIds.length.toLocaleString()}개 숨김 · U로 모두 표시`
            : `선택한 ${selectionState.selectedIds.length.toLocaleString()}개만 표시 · U로 모두 표시`,
        );
        if (key === 'h') {
          selectionState.selectedIds = [];
          draftState.state.selected = null;
        }
        render();
      }
      return 'stop';
    }
  }
}
/** Escape (order 30): clears the selection outside the sketch tool and the message box. */
export function escapeSelection(e: KeyboardEvent): ShortcutResult {
  if (
    e.key === 'Escape' &&
    sketchState.tool !== 'sketch' &&
    selectionState.selectedIds.length &&
    !(e.target instanceof HTMLTextAreaElement)
  ) {
    selectionState.selectedIds = [];
    draftState.state.selected = null;
    render();
  }
}
/** Escape (order 40): drops the strokes and leaves the sketch tool. */
export function escapeSketch(e: KeyboardEvent): ShortcutResult {
  if (e.key === 'Escape' && sketchState.tool === 'sketch') {
    sketchState.strokes = [];
    setTool('select');
  }
}
