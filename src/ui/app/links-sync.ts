// Linked files (PLAN-26 T-113, frozen after step F): Sync, Live Sync deltas, the offline view and
// inbox, and the layers composed into one scene.
import { z } from 'zod';
import { applyDisplayDelta } from '../../core/display-delta.ts';
import { belongsToLink } from '../../contracts/link-requests.ts';
import { api, errors } from '../gateway.ts';
import { draftHasInput, objects, objectsChanged } from '../model.ts';
import { element as $, readableError } from '../elements.ts';
import { type LinkRow, linkRowSchema, offlineStatusSchema, type InboxItem } from '../links.tsx';
import { requestData, requestMessage } from '../workspace-data.ts';
import { withObjects } from '../object-rows.ts';
import { hostAction } from '../host-panel.tsx';
import { layerSignature, composeLayers } from '../layers.ts';
import type { HostLayer } from '../../core/layer-tree.ts';
import { linksState, type Layer } from '../store/links.ts';
import { draftState } from '../store/draft.ts';
import { sessionState } from '../store/session.ts';
import { selectionState } from '../store/selection.ts';
import { workState } from '../store/work.ts';
import { viewerState } from '../store/viewer.ts';
import { setBody } from './composer.ts';
import { renderMessages, render } from './render.ts';
import { panelMode, currentProject, panelParams } from './context.ts';
import { viewportEmpty, pendingSketch, scheduleThumbnail } from './viewport.ts';
import { renderLinkPanel } from './left.ts';
import { message } from './status.ts';

/** The revision of each shown Sync this page holds; the engine raises it in place (T-084). */
export const heldRevision = new Map<string, number>();
/** The display revision the links list gives a request now (none: not a file's shown Sync). */
export const listedRevision = (id: string) =>
  linksState.links.find((link) => link.display?.requestId === id)?.display?.revision;
export const deltaReplySchema = z.union([
  z.object({ full: z.literal(true) }).passthrough(),
  z.object({
    revision: z.number(),
    objects: z.array(z.object({ id: z.string(), nativeId: z.string() }).passthrough()),
    scene: z.array(z.object({ id: z.string(), nativeId: z.string() }).passthrough()),
    removed: z.array(z.string()),
    definitions: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export const refreshing = new Set<string>();
/**
 * SPEC-01.11 Live Sync, shown: the engine changed a file's shown Sync in place (its display
 * revision rose); only the changed objects are fetched and merged into the model this page holds.
 */
export async function refreshDisplay(
  projectId: string,
  display: { requestId: string; revision: number },
) {
  const id = display.requestId;
  const entry = draftState.state.messages.find((item) => item.id === id);
  const result = entry?.request.result;
  const held = heldRevision.get(id) ?? 1;
  // Not drawn yet: the whole fetch brings the latest anyway.
  // The panels hold object rows only (no scene): the change page updates the rows (T-085).
  if (!entry || !result?.objects || (!result.scene && !panelMode) || display.revision <= held)
    return;
  if (refreshing.has(id) || loadingResults.has(id)) return;
  refreshing.add(id);
  try {
    // The panels ask for the changed rows only, never their geometry (`view=rows`).
    const reply = deltaReplySchema.parse(
      await api(
        `/projects/${projectId}/requests/${id}/delta?since=${held}${panelMode ? '&view=rows' : ''}`,
      ),
    );
    if (sessionState.project?.id !== projectId) return;
    const index = draftState.state.messages.findIndex((item) => item.id === id);
    const current = draftState.state.messages[index]?.request.result;
    if (index < 0 || !current?.objects || (!current.scene && !panelMode)) return;
    if ('full' in reply) {
      // Too far behind (or no longer stored per object): read the request whole again.
      heldRevision.delete(id);
      draftState.state.messages[index] = {
        ...draftState.state.messages[index],
        request: {
          ...draftState.state.messages[index].request,
          result: { ...current, scene: undefined, sceneOmitted: true },
        },
      };
      linksState.liveRefresh = id;
      await loadFullResult(id);
      return;
    }
    type Definitions = NonNullable<typeof current.definitions>;
    type Scene = NonNullable<typeof current.scene>;
    const merged = applyDisplayDelta<
      (typeof current.objects)[number],
      Scene[number],
      Definitions[string]
    >(
      { objects: current.objects, scene: current.scene ?? [], definitions: current.definitions },
      reply as unknown as {
        objects: typeof current.objects;
        scene: Scene;
        removed: string[];
        definitions?: Definitions;
      },
    );
    const next = draftState.state.messages[index];
    draftState.state.messages[index] = {
      ...next,
      request: {
        ...next.request,
        result: current.scene ? { ...current, ...merged } : { ...current, objects: merged.objects },
      },
    };
    heldRevision.set(id, reply.revision);
    linksState.liveRefresh = id;
    renderMessages();
  } catch {
    /* The next poll tries again. */
  } finally {
    refreshing.delete(id);
  }
}
/**
 * A ⟳ that wrote a new Sync (a copy of the shown one that a draft keeps, T-127): the page builds it
 * from the shown Sync it holds and the change since (`delta?base=`), not by fetching it whole.
 * Returns false when it cannot (the shown one is not held here, the engine answers `full`).
 */
async function continueFrom(
  projectId: string,
  request: Awaited<ReturnType<typeof requestData>>,
  basisId: string,
) {
  const basis = draftState.state.messages.find((item) => item.id === basisId)?.request.result;
  const held = heldRevision.get(basisId);
  if (!basis?.objects || (!basis.scene && !panelMode) || held === undefined) return false;
  try {
    const reply = deltaReplySchema.parse(
      await api(
        `/projects/${projectId}/requests/${encodeURIComponent(request.id)}/delta?${new URLSearchParams(
          { since: String(held), base: basisId, ...(panelMode ? { view: 'rows' } : {}) },
        ).toString()}`,
      ),
    );
    if ('full' in reply || sessionState.project?.id !== projectId) return false;
    type Definitions = NonNullable<typeof basis.definitions>;
    type Scene = NonNullable<typeof basis.scene>;
    const merged = applyDisplayDelta<
      (typeof basis.objects)[number],
      Scene[number],
      Definitions[string]
    >(
      { objects: basis.objects, scene: basis.scene ?? [], definitions: basis.definitions },
      reply as unknown as {
        objects: typeof basis.objects;
        scene: Scene;
        removed: string[];
        definitions?: Definitions;
      },
    );
    const entry = requestMessage(request);
    const {
      sceneOmitted: _scene,
      objectsOmitted: _objects,
      ...light
    } = (entry.request.result ?? {}) as NonNullable<typeof entry.request.result>;
    entry.request = {
      ...entry.request,
      result: basis.scene ? { ...light, ...merged } : { ...light, objects: merged.objects },
    };
    const index = draftState.state.messages.findIndex((item) => item.id === request.id);
    if (index >= 0) draftState.state.messages[index] = entry;
    else draftState.state.messages.push(entry);
    heldRevision.set(request.id, reply.revision);
    linksState.liveRefresh = request.id;
    return true;
  } catch {
    // The whole fetch (`loadFullResult`) shows it instead.
    return false;
  }
}
// Linked files (SPEC-01.11, src/ui/store/links.ts): drawn together as layers.
/** This page, for its draft leases on the files it uses (`GET …/links?page=&hold=`). */
export const pageId = crypto.randomUUID();
export const linkNotes = new Map<string, string>();
/** A candidate (or older Sync) shown in a file's place instead of its latest Sync. */
export const layerOverride = new Map<string, string>();
/** The link whose own record a request is (its Sync, or for a file item an older import). */
export const ownerOf = (request: { input: Record<string, unknown> }) =>
  linksState.links.find((link) => belongsToLink({ ...link, file: link.kind === 'file' }, request));
/** The linked file a request belongs to: its own link, or the link of its basis chain. */
export function linkOfRequest(id: string | null | undefined): string | undefined {
  let current = id ? draftState.state.messages.find((entry) => entry.id === id) : undefined;
  for (let depth = 0; current && depth < 30; depth++) {
    const owner = ownerOf(current.request);
    if (owner) return owner.id;
    const base = current.request.input.baseRequestId ?? current.request.result?.baseRequestId;
    current =
      typeof base === 'string'
        ? draftState.state.messages.find((entry) => entry.id === base)
        : undefined;
  }
  return undefined;
}
/** The shown result that belongs to no linked file: its row "작업 결과 · <이름>" (SPEC-01.11 4). */
export function transientLayer(): Layer | undefined {
  const entry = linksState.transientResult
    ? draftState.state.messages.find((item) => item.id === linksState.transientResult)
    : undefined;
  if (!entry) return undefined;
  const name = entry.request.result?.sourceDocument?.name || entry.body.slice(0, 40) || '결과';
  return { key: 'result:' + entry.id, requestId: entry.id, name: '작업 결과 · ' + name };
}
export function visibleLayers(): Layer[] {
  const layers: Layer[] = [];
  for (const link of linksState.links) {
    if (link.hidden) continue;
    const requestId = layerOverride.get(link.id) ?? link.lastSync?.requestId;
    if (requestId && draftState.state.messages.some((entry) => entry.id === requestId))
      layers.push({ key: link.id, requestId, name: link.name, link });
  }
  const transient = transientLayer();
  if (transient && !layers.some((layer) => layer.requestId === transient.requestId))
    layers.push(transient);
  return layers;
}
/**
 * Open a result: a linked file's candidate takes that file's place; anything else shows beside.
 * `restored` (the selection a restart brings back): a file's own Sync shows as its latest Sync
 * and a hidden file stays hidden (SPEC-01.11 4).
 */
export function showRequest(id: string, restored = false) {
  const link = linksState.links.find((entry) => entry.id === linkOfRequest(id));
  if (link) {
    const entry = draftState.state.messages.find((item) => item.id === id);
    if (link.lastSync?.requestId === id || (restored && entry && ownerOf(entry.request) === link))
      layerOverride.delete(link.id);
    else layerOverride.set(link.id, id);
    if (link.hidden && !restored) void setLinkHidden(link, false);
    linksState.transientResult = undefined;
    linksState.activeLayer = link.id;
  } else {
    linksState.transientResult = id;
    linksState.activeLayer = 'result:' + id;
  }
  linksState.fitNext = true;
}
/** The composer's target follows the active layer (SPEC-01.11 요청 대상). */
export function applyActiveLayer() {
  if (!linksState.currentLayers.some((layer) => layer.key === linksState.activeLayer)) {
    const newest = [...linksState.currentLayers].sort((a, b) =>
      String(
        draftState.state.messages.find((entry) => entry.id === a.requestId)?.request.createdAt ??
          '',
      ).localeCompare(
        String(
          draftState.state.messages.find((entry) => entry.id === b.requestId)?.request.createdAt ??
            '',
        ),
      ),
    );
    linksState.activeLayer = newest.at(-1)?.key;
  }
  const active = linksState.currentLayers.find((layer) => layer.key === linksState.activeLayer);
  selectionState.displayedResult = active?.requestId;
  const result = draftState.state.messages.find(
    (entry) => entry.id === selectionState.displayedResult,
  )?.request.result;
  if (result && !draftHasInput(draftState.state)) {
    draftState.state.host = result.host || 'rhino';
    $('host-target').value = draftState.state.host;
  }
  const connection = active?.link?.connection;
  if (!panelMode)
    linksState.connectedTarget =
      connection && active?.link?.host === 'rhino'
        ? { instance: connection.instance, documentId: connection.documentId }
        : undefined;
  viewportEmpty.connection(
    linksState.links.find((link) => link.connection)
      ? {
          key: linksState.links.find((link) => link.connection)!.id,
          name: linksState.links.find((link) => link.connection)!.name,
          host: linksState.links.find((link) => link.connection)!.host,
        }
      : undefined,
  );
}
export async function setLinkHidden(link: LinkRow, hidden: boolean) {
  link.hidden = hidden;
  renderMessages();
  renderLinkPanel();
  try {
    await api(`/projects/${currentProject().id}/links/${link.id}`, 'PUT', { hidden });
  } catch (error) {
    message(readableError(error).message);
  }
}
/**
 * A draft based on this file holds its automatic updates (SPEC-01.11 보류): the page tells the
 * engine with each links poll (a 5 s lease). Queued or running work the engine sees itself.
 */
export function draftHolds(link: LinkRow) {
  const uses = (id?: string | null) => !!id && linkOfRequest(id) === link.id;
  return (
    (draftHasInput(draftState.state) || !!pendingSketch()) &&
    (uses(draftState.state.baseRequestId) || draftState.state.pins.some((pin) => uses(pin.basis)))
  );
}
/** The links panel's line for the engine's Sync of a file (T-084). */
export function syncNote(link: LinkRow): string | undefined {
  const sync = link.sync;
  if (!sync) return undefined;
  if (sync.state === 'syncing') return 'Sync 중';
  if (sync.state === 'held') return '자동 Sync 보류 · 이 파일 기준 작업 중';
  if (sync.state === 'waiting') return '변경 중 · 곧 다시 Sync';
  if (sync.state === 'failed') return errors[sync.code ?? ''] || 'Sync 실패';
  return undefined;
}
/**
 * ⟳ (and 지금 Sync): a fresh read the user asked for; automatic Syncs are the engine's (T-084).
 * `full` (전체 다시 읽기, Shift+⟳): the whole document, not only what changed since the shown Sync.
 */
export async function syncLink(link: LinkRow, full = false) {
  const connection = link.connection;
  if (!connection || !sessionState.project || linksState.linkSyncing) return;
  const projectId = sessionState.project.id,
    target = { instance: connection.instance, documentId: connection.documentId };
  // The Sync shown now: a Live Sync into a new copy is drawn from it and the change (T-127).
  const shown = link.display?.requestId ?? link.lastSync?.requestId;
  linksState.linkSyncing = true;
  linkNotes.set(link.id, 'Sync 중');
  renderLinkPanel();
  if (!linksState.currentLayers.length) viewportEmpty.sync('loading');
  try {
    const request = await requestData(`/projects/${projectId}/capture`, 'POST', {
      ...target,
      id: crypto.randomUUID(),
      linkId: link.id,
      // The user's own Sync never joins one the engine is running.
      fresh: true,
      ...(full ? { full: true } : {}),
    });
    if (sessionState.project?.id !== projectId) return;
    if (
      shown &&
      shown !== request.id &&
      request.result?.displayOnly === true &&
      !draftState.state.messages.find((entry) => entry.id === request.id)?.request.result?.scene
    )
      await continueFrom(projectId, request, shown);
    // A Live Sync in place on the shown Sync: its change now, not on the next links poll.
    else if (shown === request.id && request.result?.displayOnly === true)
      await refreshDisplay(projectId, { requestId: shown, revision: Number.MAX_SAFE_INTEGER });
    if (sessionState.project?.id !== projectId) return;
    if (!draftState.state.messages.some((entry) => entry.id === request.id))
      draftState.state.messages.push(requestMessage(request));
    if (request.result?.hostExecuted) {
      // Polling replaces LinkRow objects while a long capture is running.
      const current = linksState.links.find((entry) => entry.id === link.id);
      if (current)
        current.lastSync = {
          requestId: request.id,
          at: request.createdAt ?? new Date().toISOString(),
        };
      layerOverride.delete(link.id);
      linkNotes.delete(link.id);
      viewportEmpty.sync('idle');
    } else {
      linkNotes.set(link.id, errors[request.result?.code ?? ''] || 'Sync 실패');
      viewportEmpty.sync(linksState.currentLayers.length ? 'idle' : 'failed');
    }
  } catch (error) {
    linkNotes.set(link.id, readableError(error).message);
    viewportEmpty.sync(linksState.currentLayers.length ? 'idle' : 'failed');
  } finally {
    linksState.linkSyncing = false;
    if (sessionState.project?.id === projectId) {
      renderMessages();
      render();
      renderLinkPanel();
    }
  }
}
export async function pollLinks() {
  if (!sessionState.project || !sessionState.ready || document.hidden || linksState.linksPolling)
    return;
  linksState.linksPolling = true;
  const projectId = sessionState.project.id;
  try {
    // Files the draft uses: the engine holds their automatic Syncs while this page renews the
    // lease (5 s); without a draft on a file the lease lapses on its own.
    const hold = linksState.links.filter(draftHolds).map((link) => link.id);
    // The Syncs the draft uses: a ⟳ meanwhile never changes them in place (T-127).
    const bases = [
      ...new Set(
        [draftState.state.baseRequestId, ...draftState.state.pins.map((pin) => pin.basis)].filter(
          (id): id is string => typeof id === 'string' && !!id,
        ),
      ),
    ];
    const query = hold.length
      ? '?' +
        new URLSearchParams({
          page: pageId,
          hold: hold.join(','),
          ...(bases.length ? { basis: bases.join(',') } : {}),
        }).toString()
      : '';
    const next = z.array(linkRowSchema).parse(await api(`/projects/${projectId}/links${query}`));
    if (sessionState.project?.id !== projectId) return;
    // A file's first Sync is framed in view.
    if (
      next.some(
        (link) => link.lastSync && !linksState.links.find((old) => old.id === link.id)?.lastSync,
      )
    )
      linksState.fitNext = true;
    linksState.links = next;
    workState.conversationChips?.update({
      targets: next.map((link) => ({ id: link.id, name: link.name })),
    });
    linksState.linksLoaded = true;
    // The host panel works on its own file: requests from it target that file.
    if (panelMode && linksState.connectedTarget) {
      const own = linksState.links.find(
        (link) =>
          link.connection?.instance === linksState.connectedTarget?.instance &&
          link.connection?.documentId === linksState.connectedTarget?.documentId,
      );
      if (own && linksState.activeLayer !== own.id) {
        linksState.activeLayer = own.id;
        applyActiveLayer();
      }
      // Removed from the project in VIDE (SPEC-01.11 9): the plugin drops its link as well.
      const target = linksState.connectedTarget;
      if (
        !linksState.panelUnlinking &&
        panelParams.get('project') === projectId &&
        !linksState.links.some(
          (link) =>
            (link.instance === target.instance && link.documentId === target.documentId) ||
            (link.connection?.instance === target.instance &&
              link.connection.documentId === target.documentId),
        )
      ) {
        linksState.panelUnlinking = true;
        hostAction('unlink');
      }
    }
    if (linksState.offlineAsked !== projectId) {
      linksState.offlineAsked = projectId;
      void pollOffline();
    }
    // Syncs made elsewhere (another window, the Rhino panel) are fetched once.
    for (const link of linksState.links) {
      const id = link.lastSync?.requestId;
      if (id && !draftState.state.messages.some((entry) => entry.id === id)) {
        // As the list shows it (T-123): its geometry is fetched when it is drawn (showLayers).
        const fetched = requestMessage(
          await api(`/projects/${projectId}/requests/${id}?view=summary`),
        );
        if (draftState.state.messages.some((entry) => entry.id === id)) continue;
        if (sessionState.project?.id !== projectId) return;
        draftState.state.messages.push(fetched);
      }
    }
    // The engine's Sync state per file, and Live Syncs in place merged as changes only.
    let syncing = false;
    for (const link of linksState.links) {
      if (!linksState.linkSyncing) {
        const note = syncNote(link);
        if (note) linkNotes.set(link.id, note);
        else linkNotes.delete(link.id);
      }
      if (link.sync?.state === 'syncing') syncing = true;
      if (link.display) void refreshDisplay(projectId, link.display);
    }
    // An empty view says the engine is reading a file, or that its Sync failed.
    const shown =
      linksState.currentLayers.length || linksState.linkSyncing || loadingResults.size
        ? undefined
        : syncing
          ? 'loading'
          : linksState.links.some((link) => link.sync?.state === 'failed')
            ? 'failed'
            : 'idle';
    if (shown && shown !== linksState.engineView) viewportEmpty.sync(shown);
    linksState.engineView = shown;
    const signature = JSON.stringify(
      linksState.links.map((link) => [link.id, link.hidden, link.lastSync, link.placement]),
    );
    if (signature !== linksState.linkSignature) {
      linksState.linkSignature = signature;
      renderMessages();
    } else applyActiveLayer();
    renderLinkPanel();
  } catch {
    /* Transient; the next poll retries and the last display stays. */
  } finally {
    linksState.linksPolling = false;
  }
}
// Offline view on the account site and requests left there (PLAN-20).
export async function pollOffline(change?: Promise<unknown>) {
  if (!sessionState.project || !sessionState.ready) return;
  const projectId = sessionState.project.id;
  try {
    const status = offlineStatusSchema.parse(
      (await change) ?? (await api(`/projects/${projectId}/offline-view`)),
    );
    if (sessionState.project?.id !== projectId) return;
    linksState.offlineState = { projectId, status };
    renderLinkPanel();
  } catch (error) {
    if (change) message(readableError(error).message);
  }
}
export function useInboxItem(item: InboxItem) {
  draftState.state.body = item.body;
  setBody(item.body);
  if (item.linkId && linksState.links.some((link) => link.id === item.linkId)) {
    linksState.activeLayer = item.linkId;
    applyActiveLayer();
  }
  render();
  $('body').focus();
  message('사이트에서 남긴 요청을 작성기에 넣었습니다. 내용을 확인하고 보내세요.');
  dismissInboxItem(item);
}
export function dismissInboxItem(item: InboxItem) {
  void pollOffline(
    api(`/projects/${item.projectId}/offline-view/inbox/${item.id}/dismiss`, 'POST', {}),
  );
}
/** The request list omits display meshes; fetch one request in full when it is shown. */
// One fetch per request; a second caller waits for the same one.
export const loadingResults = new Map<string, Promise<void>>();
export function loadFullResult(id: string): Promise<void> {
  const pending = loadingResults.get(id);
  if (pending || !sessionState.project) return pending ?? Promise.resolve();
  const projectId = sessionState.project.id;
  viewportEmpty.sync('loading');
  const loading = (async () => {
    try {
      // The fetch carries at least the display revision listed now (Live Syncs merge after it).
      const revision = listedRevision(id);
      const full = requestMessage(await api(`/projects/${projectId}/requests/${id}`));
      if (sessionState.project?.id !== projectId) return;
      if (revision !== undefined) heldRevision.set(id, revision);
      const index = draftState.state.messages.findIndex((entry) => entry.id === id);
      if (index >= 0) draftState.state.messages[index] = full;
      linksState.liveRefresh = id;
      viewportEmpty.sync('idle');
      renderMessages();
    } catch (error) {
      viewportEmpty.sync('failed');
      message(readableError(error).message);
    }
  })().finally(() => loadingResults.delete(id));
  loadingResults.set(id, loading);
  return loading;
}
/** The object list's row of each Sync row, while that row and its scene item stay the same. */
const listedRows = new WeakMap<
  object,
  { row: object; item: unknown; many: boolean; layer: string; table: unknown }
>();
/** Layer names by their base64 form: decoded once, not once per object and redraw (T-085). */
const layerNames = new Map<string, string | undefined>();
function layerOf(value?: string) {
  if (!value) return undefined;
  if (layerNames.has(value)) return layerNames.get(value);
  let name: string | undefined;
  try {
    name = new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
  } catch {
    name = undefined;
  }
  if (layerNames.size > 20_000) layerNames.clear();
  layerNames.set(value, name);
  return name;
}
/**
 * Display Syncs that are not drawn give up their geometry and object rows (T-085): five full Syncs
 * of a large document kept five models in the page. Showing one again fetches it.
 */
function releaseHidden(kept: Set<string>) {
  const messages = draftState.state.messages;
  for (let index = 0; index < messages.length; index++) {
    const entry = messages[index];
    const result = entry.request.result;
    if (
      !result?.scene ||
      result.displayOnly !== true ||
      kept.has(entry.id) ||
      loadingResults.has(entry.id) ||
      refreshing.has(entry.id)
    )
      continue;
    const { scene: _scene, definitions: _definitions, objects, ...rest } = result;
    messages[index] = {
      ...entry,
      request: {
        ...entry.request,
        result: {
          ...rest,
          sceneOmitted: true,
          ...(objects ? { objectsOmitted: true, objectCount: objects.length } : {}),
        },
      },
    };
    heldRevision.delete(entry.id);
  }
}
const loadingRows = new Set<string>();
let panelSignature = '';
/** Row arrays the panel's object list was composed from (a Live Sync gives a new array). */
let panelRows = new WeakSet<object>();
function showPanelLayers(layers: Layer[]) {
  linksState.currentLayers = layers;
  const projectId = sessionState.project?.id;
  const sources = layers.flatMap((layer) => {
    const result = draftState.state.messages.find((entry) => entry.id === layer.requestId)?.request
      .result;
    if (result?.objects) return [{ layer, objects: result.objects }];
    if (result?.objectsOmitted && projectId && !loadingRows.has(layer.requestId)) {
      loadingRows.add(layer.requestId);
      void withObjects(projectId, layer.requestId)
        .then(() => {
          if (sessionState.project?.id === projectId) renderMessages();
        })
        .catch(() => {
          /* The next redraw asks again. */
        })
        .finally(() => loadingRows.delete(layer.requestId));
    }
    return [];
  });
  const signature = sources
    .map(({ layer, objects: rows }) => `${layer.key}=${layer.requestId}:${rows.length}`)
    .join('|');
  const changed = sources.some(({ objects: rows }) => !panelRows.has(rows));
  if (signature !== panelSignature || changed) {
    panelSignature = signature;
    panelRows = new WeakSet(sources.map(({ objects: rows }) => rows));
    const composed = composeLayers(
      sources.map(({ layer, objects: rows }) => ({
        key: layer.key,
        name: layer.name,
        requestId: layer.requestId,
        objects: rows.map((row) => ({ ...row, type: row.kind })),
        scene: [],
      })),
    );
    objects.splice(0, objects.length, ...(composed.objects as unknown as typeof objects));
    objectsChanged();
  }
  applyActiveLayer();
}
/** Draw every visible layer together (SPEC-01.11); rebuild only when the layer set changed. */
export function showLayers() {
  const layers = visibleLayers();
  // The Rhino and ZWCAD panels draw no 3D scene and fetch no geometry (T-085): their object list
  // (Rhino's selection, pins) comes from the layers' object rows.
  if (panelMode) {
    showPanelLayers(layers);
    return;
  }
  for (const layer of layers) {
    const result = draftState.state.messages.find((entry) => entry.id === layer.requestId)?.request
      .result;
    if (result?.hostExecuted && !result.scene && result.sceneOmitted) {
      void loadFullResult(layer.requestId);
      return;
    }
  }
  const drawable = layers.flatMap((layer) => {
    const result = draftState.state.messages.find((entry) => entry.id === layer.requestId)?.request
      .result;
    return result?.hostExecuted && result.objects && result.scene ? [{ layer, result }] : [];
  });
  linksState.currentLayers = drawable.map(({ layer }) => layer);
  // An xref placement (SPEC-01.11 11) changes where a file draws: a new placement redraws it.
  const signature =
    layerSignature(linksState.currentLayers) +
    drawable.map(({ layer }) => layer.link?.placement?.join(',') ?? '').join('|');
  const refresh =
    linksState.liveRefresh !== undefined &&
    linksState.currentLayers.some((layer) => layer.requestId === linksState.liveRefresh);
  linksState.liveRefresh = undefined;
  if (signature === linksState.shownSignature && !refresh && !linksState.fitNext) {
    applyActiveLayer();
    return;
  }
  const many = drawable.length > 1;
  const composed = composeLayers(
    drawable.map(({ layer, result }) => {
      const native = new Map(result.scene!.map((item) => [item.id, item]));
      // Rhino's layer table (nesting, panel order, on/off): the layer list draws it as a tree.
      const table = (result as { layers?: unknown }).layers;
      const layerTable = Array.isArray(table) ? (table as HostLayer[]) : undefined;
      const host = layer.link?.host;
      return {
        key: layer.key,
        name: layer.name,
        requestId: layer.requestId,
        objects: result.objects!.map((o) => {
          const item = native.get(o.id);
          // An unchanged row after a Live Sync keeps its listed form (T-085).
          const known = listedRows.get(o);
          if (
            known &&
            known.item === item &&
            known.many === many &&
            known.layer === layer.name &&
            known.table === layerTable
          )
            return known.row as typeof o;
          const name = layerOf(item?.layer64);
          const row = {
            ...o,
            // Several files: the layer list groups by file, then by layer.
            layer: many ? `${layer.name} › ${name ?? '레이어 없음'}` : name,
            layerName: name,
            // The layer list's swatch (host layer colour, #rrggbb).
            layerColor: item?.layerColor,
            layerTable,
            host,
            type: item?.nativeType || o.kind,
          };
          listedRows.set(o, { row, item, many, layer: layer.name, table: layerTable });
          return row;
        }),
        // A drawing shown as an xref of a root drawing draws in the root's coordinates.
        scene: layer.link?.placement
          ? result.scene!.map((item) => ({ ...item, placement: layer.link!.placement }))
          : result.scene!,
        definitions: result.definitions,
      };
    }),
  );
  objects.splice(0, objects.length, ...(composed.objects as unknown as typeof objects));
  objectsChanged();
  if (!linksState.shownSignature || linksState.fitNext)
    viewerState.viewport?.replace(composed.scene, composed.definitions);
  else viewerState.viewport?.update(composed.scene, composed.definitions);
  linksState.shownSignature = signature;
  linksState.fitNext = false;
  releaseHidden(
    new Set(
      [
        ...linksState.currentLayers.map((layer) => layer.requestId),
        selectionState.displayedResult,
        selectionState.selectedResult,
        // The draft's basis and its pins' Syncs keep their rows (pin markers, send checks).
        draftState.state.baseRequestId,
        ...draftState.state.pins.map((pin) => pin.basis),
      ].filter((id): id is string => typeof id === 'string'),
    ),
  );
  applyActiveLayer();
  render();
  if (drawable.length) scheduleThumbnail();
}

export function initLinksSync1() {
  setInterval(() => void pollLinks(), 1500);
  setInterval(() => {
    if (!document.hidden) void pollOffline();
  }, 15_000);
}

/** renderMessages(): the chosen result becomes a layer once the links are known. */
export function applyShownSelection() {
  // Applied once the project's links are known: before that every result would look like one
  // that belongs to no file and stay drawn after its file is hidden (SPEC-01.11 4).
  if (selectionState.selectedResult !== selectionState.appliedSelection && linksState.linksLoaded) {
    selectionState.appliedSelection = selectionState.selectedResult;
    if (selectionState.selectedResult)
      showRequest(
        selectionState.selectedResult,
        selectionState.selectedResult === selectionState.restoredSelection,
      );
    else if (selectionState.selectedResult === null) {
      linksState.transientResult = undefined;
      linksState.activeLayer = undefined;
    }
    selectionState.restoredSelection = undefined;
  }
  // A result shown beside the files that now belongs to one (its file was linked or listed since)
  // follows that file and its visibility; a file's own Sync is shown as that file's.
  const owner = linksState.transientResult
    ? linksState.links.find((link) => link.id === linkOfRequest(linksState.transientResult))
    : undefined;
  if (owner && linksState.transientResult) {
    const entry = draftState.state.messages.find((item) => item.id === linksState.transientResult);
    if (
      entry &&
      ownerOf(entry.request) !== owner &&
      owner.lastSync?.requestId !== linksState.transientResult &&
      !layerOverride.has(owner.id)
    )
      layerOverride.set(owner.id, linksState.transientResult);
    if (linksState.activeLayer === 'result:' + linksState.transientResult)
      linksState.activeLayer = owner.id;
    linksState.transientResult = undefined;
  }
  // A project without linked files shows its latest result, as before links existed.
  if (
    linksState.linksLoaded &&
    !linksState.links.length &&
    selectionState.selectedResult === undefined
  )
    linksState.transientResult = draftState.state.messages
      .filter(
        (entry) =>
          entry.request?.result?.hostExecuted &&
          (entry.request.result.host || 'rhino') === (draftState.state.host || 'rhino'),
      )
      .at(-1)?.id;
}
