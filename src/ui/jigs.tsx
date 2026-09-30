import { memo, useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { api } from './gateway.ts';
import { DeclaredJig } from './jig-panel/declared-jig.tsx';
import { KnowledgeJig } from './knowledge-jig.tsx';
import { DraftList, ImportJig, MakeCard } from './make-tab.tsx';
import type { Point3 } from './model.ts';
import { StructureJig } from './structure-jig.tsx';
import type { OverlayItem } from './viewport.ts';
import {
  activeWorkspace,
  closeContextTab,
  contextId,
  contextTabs,
  lastJigInstance,
  onWorkspaceChange,
  openContextTab,
  renameContextTab,
  setContextResolver,
  setWorkspace,
  type ContextTab,
} from './workspaces.ts';

// The JIG tab (SCR-18) lists jigs (working tools for one kind of task); each opened jig gets a
// context tab (SCR-13). The Sync jig here shows the relation between a Rhino model and a CAD
// drawing, their differences, an AI review of what the differences mean, and edits that make one
// side follow the other.
const jigSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  summary: z.string(),
  inputs: z.array(z.string()),
  status: z.enum(['available', 'planned']),
  basis: z.string().optional(),
});
type Jig = z.infer<typeof jigSchema>;
const point = z.tuple([z.number(), z.number(), z.number()]);
const syncSchema = z.object({
  alignment: z.object({
    rotation: z.number(),
    translation: z.tuple([z.number(), z.number()]),
    dz: z.number(),
    pairs: z.number(),
    residual: z.object({ max: z.number(), rms: z.number() }),
    ambiguous: z.boolean(),
    source: z.string(),
    candidates: z.array(
      z.object({
        rotation: z.number(),
        translation: z.tuple([z.number(), z.number()]),
        dz: z.number(),
        votes: z.number(),
      }),
    ),
  }),
  rows: z.array(
    z.object({
      id: z.string(),
      state: z.enum(['match', 'offset', 'rhino-only', 'cad-only']),
      rhino: z
        .object({
          id: z.string(),
          nativeId: z.string(),
          layer: z.string(),
          name: z.string().optional(),
          type: z.string(),
        })
        .optional(),
      cad: z
        .object({ id: z.string(), nativeId: z.string(), layer: z.string(), type: z.string() })
        .optional(),
      deviation: z.number().optional(),
      length: z.number().optional(),
      ends: z.object({ rhino: z.tuple([point, point]), cad: z.tuple([point, point]) }).optional(),
      inRhino: z.tuple([point, point]).optional(),
    }),
  ),
  totalRows: z.number(),
  layers: z.array(z.object({ rhino: z.string(), cad: z.string(), pairs: z.number() })),
  summary: z.object({
    match: z.number(),
    offset: z.number(),
    rhinoOnly: z.number(),
    cadOnly: z.number(),
  }),
  rhinoLayers: z.array(z.object({ name: z.string(), count: z.number() })),
  cadLayers: z.array(z.object({ name: z.string(), count: z.number() })),
  counts: z.object({ rhino: z.number(), cad: z.number() }),
  cadUnits: z.string(),
});
type Sync = z.infer<typeof syncSchema>;
/** A stored Sync as far as finding one document object in it needs. */
const syncObjectsSchema = z
  .object({
    result: z
      .object({
        objects: z
          .array(z.object({ id: z.string(), nativeId: z.string().optional() }).passthrough())
          .optional(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
type Row = Sync['rows'][number];

export interface SyncSource {
  id: string;
  host: 'rhino' | 'zwcad';
  label: string;
}
/** What a jig frames: objects of a Sync, a box in metres, or an overlay layer or item. */
export type JigFocus =
  | { requestId: string; ids: string[] }
  | { min: Point3; max: Point3 }
  | { overlay: string; itemId?: string };
export interface JigContext {
  projectId: string;
  /** The project's name, for tab names such as '구조 · <project>'. */
  projectName?: string;
  sources: SyncSource[];
  /** Layer paths in the linked documents' Syncs: the output layers a new jig instance may use. */
  layers?: string[];
  /** Show one object of a Sync in the viewport (selected and framed). */
  show: (requestId: string, objectId: string) => void;
  /** Colour objects of a Sync in the viewport (structure verdicts); omitted when unsupported. */
  tint?: (requestId: string, colors: Record<string, string>) => void;
  /** Back to the model's own colours. */
  clearTint: () => void;
  /**
   * Draw a jig result as an overlay layer over the model (null removes it). Overlays are display
   * only: never selected, saved, synced or sent. Each jig keeps its own; they are on the model
   * only while that jig's tab shows.
   */
  overlay: (key: string, items: OverlayItem[] | null) => void;
  /** Show, hide or fade one overlay layer; the jig's layers keep their style between tabs. */
  overlayStyle?: (key: string, style: { visible?: boolean; opacity?: number }) => void;
  /** Frame part of the model without changing the selection. */
  focus: (target: JigFocus) => void;
  /** Overlay items clicked in the viewport (e.g. to move to the table row); returns unsubscribe. */
  onOverlayPick?: (listener: (hit: { key: string; itemId: string }) => void) => () => void;
  /** Send a request made by a jig (AI review or edits) into the conversation. */
  send: (input: {
    body: string;
    files: { name: string; text: string }[];
    permission: 'review' | 'candidate';
    host?: 'rhino' | 'zwcad';
    baseRequestId?: string;
    applyToSource?: boolean;
    jig: Record<string, unknown>;
  }) => Promise<void>;
}

// A jig instance (작업본) as the engine shows it (ARCH-03 §4·§7), read for the jig screens.
const gateSchema = z
  .object({
    name: z.string(),
    level: z.string(),
    ok: z.boolean(),
    message: z.string(),
    verdict: z.boolean().optional(),
  })
  .passthrough();
const paramViewSchema = z
  .object({
    key: z.string(),
    title: z.string(),
    group: z.string(),
    type: z.string(),
    unit: z.string(),
    displayUnit: z.string(),
    value: z.union([z.number(), z.string(), z.boolean()]),
    displayValue: z.union([z.number(), z.string(), z.boolean()]),
    by: z.string(),
    fixedAtPin: z.boolean().optional(),
    choices: z.array(z.object({ value: z.string(), label: z.string() }).passthrough()).optional(),
    help: z.string().optional(),
  })
  .passthrough();
const instanceViewSchema = z
  .object({
    id: z.string(),
    jig: z
      .object({ id: z.string(), version: z.string(), name: z.string(), summary: z.string() })
      .passthrough(),
    title: z.string(),
    status: z.string(),
    body: z.object({ layerRoot: z.string() }).passthrough(),
    steps: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          kind: z.string(),
          status: z.string(),
          inputHash: z.string().optional(),
          ms: z.number().nullish(),
          gates: z.array(gateSchema).optional(),
        })
        .passthrough(),
    ),
    params: z.array(paramViewSchema),
    updatedAt: z.string(),
  })
  .passthrough();
const runReportSchema = z
  .object({
    steps: z.array(
      z
        .object({
          id: z.string(),
          status: z.string(),
          cached: z.boolean(),
          ms: z.number().nullable(),
          gates: z.array(gateSchema),
          error: z.object({ code: z.string(), message: z.string() }).optional(),
        })
        .passthrough(),
    ),
    outputs: z.record(z.string(), z.unknown()),
    blocked: z.boolean(),
    superseded: z.boolean(),
  })
  .passthrough();
export type JigInstanceView = z.infer<typeof instanceViewSchema>;
export type JigRunReport = z.infer<typeof runReportSchema>;
/** One setting change; a number in another unit than the setting's own names that unit. */
export interface JigParamChange {
  key: string;
  value: number | string | boolean;
  unit?: string;
}
export interface JigHostState {
  /** The instance as last read: steps, settings, inputs. */
  instance?: JigInstanceView;
  /** The last run in this session (step reports and outputs). */
  report?: JigRunReport;
  busy: boolean;
  /** Why the last action failed, in words for the screen. */
  error?: string;
}
/**
 * What a v3 jig screen (the declarative panel, T-048) gets for its instance in the context tab.
 * Actions resolve to undefined when they fail and put the reason in `state().error`. The slots are
 * the tab's regions beside the panel (Design SCR-13): above the 3D view (KPI strip, view switch),
 * floating over its top left (slider board), and the drawer that takes the inspector's place while
 * it has content. Asking the conversation, making in Rhino, export and fact lookup come with
 * PLAN-24 T-062 and PLAN-22 T-055, T-057 and T-065.
 */
export interface JigHost extends JigContext {
  instanceId: string;
  state: () => JigHostState;
  subscribe: (listener: () => void) => () => void;
  refresh: () => Promise<JigInstanceView | undefined>;
  params: {
    get: () => JigInstanceView['params'];
    set: (values: JigParamChange[], reason?: string) => Promise<JigInstanceView | undefined>;
    undo: (seq: number) => Promise<JigInstanceView | undefined>;
  };
  run: (options?: {
    until?: string;
    mode?: 'geometry' | 'preview' | 'confirmed';
  }) => Promise<JigRunReport | undefined>;
  output: (stepId: string) => Promise<unknown>;
  confirm: (stepId: string) => Promise<JigInstanceView | undefined>;
  /**
   * Show one object of a linked Rhino document by its id there (the bake card's [보기]): the
   * newest Sync that holds it selects and frames it. Resolves to why not when no Sync holds it.
   */
  focusObject: (nativeId: string) => Promise<string | undefined>;
  /** Open one of this instance's reports in the 보고서 tab. */
  openReport: (reportId: string) => void;
  slots: { top: HTMLElement; board: HTMLElement; drawer: HTMLElement };
}

// The jig surface of the workspace tabs (workspaces.ts, Design §03·SCR-13·18): one non-modal panel
// in the centre column. On the JIG tab it holds the jig list over the whole centre; on a jig's
// context tab it docks left of the 3D view, which stays usable (T-041). An opened jig stays mounted
// while its tab is in the row, so switching tabs keeps its inputs and results. The older jigs
// (Sync, structure, project data) have no instance on the engine: they stay mounted after their
// tab closes and come back as they were until the page reloads.
const workspace = document.querySelector('.workspace') ?? document.body;
const viewportArea = document.querySelector('.viewport-area') ?? workspace;
const dialog = document.createElement('dialog');
dialog.className = 'quantity-dialog jig-dialog';
dialog.setAttribute('aria-label', 'JIG');
workspace.append(dialog);
const root = createRoot(dialog);

type LegacyKind = 'sync' | 'structure' | 'knowledge';
const LEGACY: Record<LegacyKind, { title: string; purpose: string }> = {
  sync: { title: 'Sync · 도면↔모델', purpose: 'Sync' },
  structure: { title: '구조 분석', purpose: '구조' },
  knowledge: { title: '프로젝트 자료 · 시험판', purpose: '자료' },
};
const legacyKind = (instanceId: string) =>
  /^legacy:(sync|structure|knowledge)$/.exec(instanceId)?.[1] as LegacyKind | undefined;
interface OpenJig {
  instanceId: string;
  kind: LegacyKind | 'instance';
  /** Overlay layers the jig drew; on the model only while its tab shows. */
  drawn: Map<string, OverlayItem[]>;
  styles: Map<string, { visible?: boolean; opacity?: number }>;
  context: JigContext;
  host?: JigHost;
}
let provide: (() => JigContext) | undefined;
/** The workspace as of the last render; the jigs' contexts read through it. */
let latest: JigContext | undefined;
let sourcesKey = '';
/** Bumped when the Syncs change, so the jigs that are not showing re-render with the new list. */
let generation = 0;
let collapsed = false;
/** The JIG list's source filter, kept between visits. */
let listSource: Source = 'all';
const mounted = new Map<string, OpenJig>();
/** The jig whose tab shows; its overlays are on the model. */
let shown: OpenJig | undefined;
const narrow = () => matchMedia('(max-width: 850px)').matches;
/** Read the workspace again; before a project is open there is nothing to read. */
function current() {
  try {
    if (provide) latest = provide();
  } catch {
    /* No project yet: keep the last one read. */
  }
  return latest;
}

function render() {
  current();
  const folded = collapsed && !!shown;
  workspace.classList.toggle('jig-open', dialog.open);
  workspace.classList.toggle('jig-collapsed', folded);
  dialog.toggleAttribute('data-collapsed', folded);
  for (const jig of mounted.values())
    for (const slot of Object.values(jig.host?.slots ?? {})) slot.hidden = jig !== shown;
  if (latest) root.render(<Surface context={latest} />);
}
const fold = (value: boolean) => {
  collapsed = value;
  render();
};
/** Follow the active tab: open or close the panel and put the shown jig's overlays on the model. */
function surface() {
  current();
  const active = activeWorkspace();
  const tab = contextTabs().find((entry) => contextId(entry.instanceId) === active);
  const next = tab ? (mounted.get(tab.instanceId) ?? mount(tab.instanceId)) : undefined;
  if (next !== shown) {
    if (shown) for (const key of shown.drawn.keys()) latest?.overlay(key, null);
    if (next)
      for (const [key, items] of next.drawn) {
        latest?.overlay(key, items);
        const style = next.styles.get(key);
        if (style) latest?.overlayStyle?.(key, style);
      }
    shown = next;
    collapsed = false;
  }
  const open = active === 'jig' || !!next;
  const focus = document.activeElement;
  if (open && !dialog.open) {
    dialog.show();
    // Opening from the tab row or the rail leaves the focus there (show() would move it inside).
    if (focus instanceof HTMLElement && focus !== document.body)
      focus.focus({ preventScroll: true });
  } else if (!open && dialog.open) {
    dialog.close();
    // Closed from inside the panel: the focus goes to the tab that now shows.
    if (focus instanceof Node && dialog.contains(focus))
      document
        .querySelector<HTMLElement>('#workspace-tabs [role="tab"][aria-selected="true"]')
        ?.focus({ preventScroll: true });
  }
  render();
}
function mount(instanceId: string): OpenJig {
  const jig = {
    instanceId,
    kind: legacyKind(instanceId) ?? 'instance',
    drawn: new Map(),
    styles: new Map(),
  } as OpenJig;
  jig.context = tabContext(jig);
  mounted.set(instanceId, jig);
  if (jig.kind === 'instance') {
    jig.host = instanceHost(jig);
    // Read the instance whatever screen draws it (the head names the jig once it is read).
    void jig.host.refresh();
  }
  return jig;
}
function unmount(jig: OpenJig) {
  if (shown === jig) {
    for (const key of jig.drawn.keys()) latest?.overlay(key, null);
    shown = undefined;
  }
  for (const slot of Object.values(jig.host?.slots ?? {})) slot.remove();
  mounted.delete(jig.instanceId);
}
onWorkspaceChange((change) => {
  const open = new Set(change.context.map((tab) => tab.instanceId));
  // A closed instance tab lets its screen go; the instance itself stays on the engine.
  for (const jig of [...mounted.values()])
    if (jig.kind === 'instance' && !open.has(jig.instanceId)) unmount(jig);
  surface();
});

/**
 * One jig's view of the workspace. It reads the latest workspace on every use (so a new Sync shows
 * up in an open jig) and keeps the jig's overlays and overlay clicks to its own tab.
 */
function tabContext(jig: OpenJig): JigContext {
  const now = () => {
    if (!latest) throw Error('JIG 화면을 준비하는 중입니다.');
    return latest;
  };
  // On a phone the panel covers the model: fold it so the shown result is visible.
  const reveal = () => {
    if (narrow()) fold(true);
  };
  return {
    get projectId() {
      return now().projectId;
    },
    get projectName() {
      return now().projectName;
    },
    get sources() {
      return now().sources;
    },
    get layers() {
      return now().layers;
    },
    show: (requestId, objectId) => {
      reveal();
      now().show(requestId, objectId);
    },
    tint: (requestId, colors) => {
      reveal();
      now().tint?.(requestId, colors);
    },
    clearTint: () => now().clearTint(),
    overlay: (key, items) => {
      if (items) jig.drawn.set(key, items);
      else {
        jig.drawn.delete(key);
        jig.styles.delete(key);
      }
      // A result that lands while another tab shows waits until this tab shows again.
      if (shown === jig) now().overlay(key, items);
    },
    overlayStyle: (key, style) => {
      jig.styles.set(key, { ...jig.styles.get(key), ...style });
      if (shown === jig) now().overlayStyle?.(key, style);
    },
    focus: (target) => now().focus(target),
    onOverlayPick: (listener) => {
      const handle = (event: Event) => {
        if (shown === jig) listener((event as CustomEvent<{ key: string; itemId: string }>).detail);
      };
      dialog.addEventListener('overlaypick', handle);
      return () => dialog.removeEventListener('overlaypick', handle);
    },
    send: (input) => now().send(input),
  };
}

const jigErrors: Record<string, string> = {
  PARAM_FIXED: '작업본을 만들 때 정한 값이라 바꿀 수 없습니다. 바꾸려면 새로 여세요.',
  OUT_OF_RANGE: '정해진 범위 밖의 값입니다.',
  UNIT_MISMATCH: '단위가 맞지 않습니다.',
  GATE_BLOCKED: '점검에 막혔습니다. 단계에 적힌 이유를 확인하세요.',
  LAYER_ROOT_MISSING: '연결 모델에 없는 레이어입니다. 연결 파일에 있는 레이어를 고르세요.',
  STALE_INPUT: '읽은 문서가 그 뒤에 바뀌었습니다. 입력을 다시 읽은 뒤 계산하세요.',
  JIG_INVALID: '이 jig의 설명서에 문제가 있어 열 수 없습니다.',
  NOT_FOUND: '작업본을 찾을 수 없습니다.',
};
function jigError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    (typeof code === 'string' && jigErrors[code]) ||
    (error instanceof Error ? error.message : '처리하지 못했습니다.')
  );
}

/** The engine side of one instance: read, change settings, run, confirm (ARCH-03 §7). */
function instanceHost(jig: OpenJig): JigHost {
  let state: JigHostState = { busy: false };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<JigHostState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
    // The panel's head names the jig once it is read.
    if (shown === jig) render();
  };
  const path = (rest = '') =>
    `/projects/${encodeURIComponent(jig.context.projectId)}/jig-instances/${encodeURIComponent(jig.instanceId)}${rest}`;
  const read = (value: unknown) => {
    const instance = instanceViewSchema.parse(value);
    update({ instance });
    renameContextTab(jig.instanceId, instance.title, `${instance.jig.name} · ${instance.title}`);
    return instance;
  };
  async function act<T>(work: () => Promise<T>): Promise<T | undefined> {
    update({ busy: true, error: undefined });
    try {
      const value = await work();
      update({ busy: false });
      return value;
    } catch (error) {
      update({ busy: false, error: jigError(error) });
      return undefined;
    }
  }
  const changed = (value: unknown) =>
    read(z.object({ instance: z.unknown() }).passthrough().parse(value).instance);
  const slot = (name: string, parent: Element) => {
    const node = document.createElement('div');
    node.className = `jig-${name}`;
    node.dataset.instance = jig.instanceId;
    node.hidden = true;
    parent.append(node);
    return node;
  };
  const own = {
    instanceId: jig.instanceId,
    state: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh: () => act(async () => read(await api(path()))),
    params: {
      get: () => state.instance?.params ?? [],
      set: (values: JigParamChange[], reason?: string) =>
        act(async () =>
          changed(await api(path('/params'), 'PUT', { values, ...(reason ? { reason } : {}) })),
        ),
      undo: (seq: number) =>
        act(async () => changed(await api(path('/params/undo'), 'POST', { seq }))),
    },
    run: (options: { until?: string; mode?: 'geometry' | 'preview' | 'confirmed' } = {}) =>
      act(async () => {
        const report = runReportSchema.parse(await api(path('/run'), 'POST', options));
        update({ report });
        read(await api(path()));
        return report;
      }),
    // A read: it leaves `busy` alone so the screen can fetch outputs while settings change.
    output: async (stepId: string) => {
      try {
        const reply = await api(path(`/steps/${encodeURIComponent(stepId)}/output`));
        return z.object({ output: z.unknown() }).passthrough().parse(reply).output;
      } catch (error) {
        update({ error: jigError(error) });
        return undefined;
      }
    },
    confirm: (stepId: string) =>
      act(async () => {
        const inputHash = state.instance?.steps.find((step) => step.id === stepId)?.inputHash;
        if (!inputHash) throw Error('먼저 계산하세요.');
        return read(
          await api(path(`/steps/${encodeURIComponent(stepId)}/confirm`), 'POST', { inputHash }),
        );
      }),
    focusObject: async (nativeId: string) => {
      const wanted = nativeId.toLowerCase();
      const project = `/projects/${encodeURIComponent(jig.context.projectId)}`;
      // Sources are in request order (oldest first): the newest Sync holding the object wins.
      for (const source of jig.context.sources.filter((s) => s.host === 'rhino').reverse()) {
        let objects: { id: string; nativeId?: string }[] = [];
        try {
          objects =
            syncObjectsSchema.parse(
              await api(`${project}/requests/${encodeURIComponent(source.id)}`),
            ).result?.objects ?? [];
        } catch {
          continue;
        }
        const hit = objects.find((object) => object.nativeId?.toLowerCase() === wanted);
        if (hit) {
          jig.context.show(source.id, hit.id);
          return undefined;
        }
      }
      return '연결한 Rhino 문서의 Sync에 이 객체가 없습니다. 원본에 반영한 뒤 Sync를 다시 하면 보입니다.';
    },
    openReport: (reportId: string) =>
      void import('./report-tab.tsx').then((screen) => screen.openReport(jig.instanceId, reportId)),
    slots: {
      top: slot('top', workspace),
      board: slot('board', viewportArea),
      drawer: slot('drawer', workspace),
    },
  };
  // The host reads the workspace (Syncs, viewport, conversation) through the jig's context.
  return Object.assign(Object.create(jig.context) as JigContext, own);
}

setContextResolver(async (instanceId) => {
  const kind = legacyKind(instanceId);
  if (kind) return legacyTab(kind);
  const projectId = current()?.projectId;
  if (!projectId) return undefined;
  try {
    const view = instanceViewSchema.parse(
      await api(
        `/projects/${encodeURIComponent(projectId)}/jig-instances/${encodeURIComponent(instanceId)}`,
      ),
    );
    return { instanceId, label: view.title, title: `${view.jig.name} · ${view.title}` };
  } catch {
    // The instance is gone or unreadable: the list is the way back.
    setWorkspace('jig');
    return undefined;
  }
});
function legacyTab(kind: LegacyKind): ContextTab {
  const project = current()?.projectName;
  return {
    instanceId: `legacy:${kind}`,
    label: project ? `${LEGACY[kind].purpose} · ${project}` : LEGACY[kind].title,
    title: LEGACY[kind].title,
  };
}
const mm = (metres: number) => `${Math.round(metres * 10000) / 10} mm`;
const stateText: Record<Row['state'], string> = {
  match: '일치',
  offset: '오차',
  'rhino-only': 'Rhino에만',
  'cad-only': 'CAD에만',
};
const unitScale: Record<string, number> = {
  Millimeters: 1000,
  Centimeters: 100,
  Meters: 1,
  Inches: 39.37007874,
  Feet: 3.280839895,
};

const round = (values: number[], k = 1e4) => values.map((v) => Math.round(v * k) / k);

// The JIG list (SCR-18): the official catalogue, this project's jigs (installed and pinned here, or
// being written in this checkout) with their instances, and drafts (T-063).
const packageSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    kind: z.enum(['tool', 'library']),
    name: z.string(),
    summary: z.string(),
    stage: z.enum(['official', 'project', 'dev']),
    corrupt: z.boolean().optional(),
  })
  .passthrough();
type Package = z.infer<typeof packageSchema>;
const instanceRowSchema = z
  .object({
    id: z.string(),
    jigId: z.string(),
    version: z.string(),
    title: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
type InstanceRow = z.infer<typeof instanceRowSchema>;
type Source = 'all' | 'official' | 'project' | 'draft';
const SOURCES: { id: Source; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'official', label: '공식' },
  { id: 'project', label: '이 프로젝트의 jig' },
  { id: 'draft', label: '내 초안' },
];
const stageText: Record<Package['stage'], string> = {
  official: '공식',
  project: '이 프로젝트의 jig',
  dev: '작성 중',
};
const sourceOf = (entry: Package): Source => (entry.stage === 'official' ? 'official' : 'project');
const when = (iso: string) =>
  new Date(iso).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function Gallery({ context }: { context: JigContext }) {
  const [legacy, setLegacy] = useState<Jig[]>();
  const [packages, setPackages] = useState<Package[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [instances, setInstances] = useState<InstanceRow[]>([]);
  const [source, setSource] = useState<Source>(listSource);
  const [creating, setCreating] = useState<string>();
  /** The project jig whose [삭제] waits for confirmation. */
  const [removing, setRemoving] = useState<string>();
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(0);
  const projectId = context.projectId;
  // Read on each visit: instances change as jigs are opened, packages as jigs are pinned.
  useEffect(() => {
    let live = true;
    const project = `/projects/${encodeURIComponent(projectId)}`;
    void api('/jigs')
      .then((value) => live && setLegacy(z.array(jigSchema).parse(value)))
      .catch((error: Error) => live && setNotice(error.message));
    void api('/jigs/packages')
      .then(
        (value) =>
          live && setPackages(z.object({ jigs: z.array(packageSchema) }).parse(value).jigs),
      )
      .catch(() => undefined);
    void api(`${project}/jigs`)
      .then(
        (value) =>
          live &&
          setPinned(
            z
              .object({ pinned: z.array(z.object({ jigId: z.string() }).passthrough()) })
              .parse(value)
              .pinned.map((row) => row.jigId),
          ),
      )
      .catch(() => undefined);
    void api(`${project}/jig-instances`)
      .then(
        (value) =>
          live &&
          setInstances(z.object({ instances: z.array(instanceRowSchema) }).parse(value).instances),
      )
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId, loaded]);
  // Installed jigs show only in the project they are pinned to.
  const tools = packages.filter(
    (entry) => entry.kind === 'tool' && (entry.stage !== 'project' || pinned.includes(entry.id)),
  );
  const official = (legacy?.length ?? 0) + tools.filter((t) => sourceOf(t) === 'official').length;
  const counts: Record<Source, number> = {
    all: (legacy?.length ?? 0) + tools.length,
    official,
    project: tools.filter((t) => sourceOf(t) === 'project').length,
    draft: 0,
  };
  const listed = (kind: Source) => source === 'all' || source === kind;
  // [삭제] takes an installed jig off this project's list; its instances stay in the project.
  const remove = async (entry: Package) => {
    setRemoving(undefined);
    try {
      await api(
        `/projects/${encodeURIComponent(projectId)}/jigs/${encodeURIComponent(entry.id)}/pin`,
        'DELETE',
      );
      setNotice(`‘${entry.name}’을 이 프로젝트의 jig에서 삭제했습니다.`);
      setLoaded((n) => n + 1);
    } catch (error) {
      setNotice(`‘${entry.name}’을 삭제하지 못했습니다. ${jigError(error)}`);
    }
  };
  const toolCard = (entry: Package) => {
    const key = `${entry.id}@${entry.version}`;
    const rows = instances.filter((row) => row.jigId === entry.id);
    return (
      <article
        key={key}
        className="jig-card"
        data-source={sourceOf(entry)}
        data-status={entry.corrupt ? 'planned' : 'available'}
      >
        <div className="jig-card-head">
          <strong>{entry.name}</strong>
          <span className="pill" data-ok={String(!entry.corrupt)}>
            {entry.corrupt ? '열 수 없음' : '사용 가능'}
          </span>
        </div>
        <p>
          {entry.corrupt
            ? '설치한 뒤 파일이 바뀌어 열 수 없습니다. 다시 가져오세요.'
            : entry.summary}
        </p>
        <small>
          {stageText[entry.stage]} · 버전 {entry.version}
        </small>
        {rows.length ? (
          <ul className="jig-instances" aria-label={`${entry.name} 작업본`}>
            {rows.map((row) => (
              <li key={row.id}>
                <span>{row.title}</span>
                <small>
                  {when(row.updatedAt)}
                  {row.version !== entry.version ? ` · 버전 ${row.version}` : ''}
                </small>
                <button
                  type="button"
                  onClick={() =>
                    openContextTab({
                      instanceId: row.id,
                      label: row.title,
                      title: `${entry.name} · ${row.title}`,
                    })
                  }
                >
                  열기
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {entry.corrupt ? null : creating === key ? (
          <NewInstance
            entry={entry}
            context={context}
            onCancel={() => setCreating(undefined)}
            onOpened={() => setCreating(undefined)}
          />
        ) : (
          <button type="button" onClick={() => setCreating(key)}>
            새로 열기
          </button>
        )}
        {entry.stage !== 'project' ? null : removing === key ? (
          <div className="jig-remove" role="group" aria-label={`${entry.name} 삭제 확인`}>
            <small>
              이 프로젝트의 jig 목록에서 뺍니다.
              {rows.length ? ` 작업본 ${rows.length}개는 지우지 않습니다.` : ''} 다시 쓰려면 다시
              가져옵니다.
            </small>{' '}
            <button type="button" onClick={() => void remove(entry)}>
              삭제
            </button>{' '}
            <button type="button" onClick={() => setRemoving(undefined)}>
              취소
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setRemoving(key)}>
            삭제
          </button>
        )}
      </article>
    );
  };
  return (
    <div className="jig-gallery">
      <nav className="jig-sources" aria-label="출처">
        {SOURCES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={source === entry.id}
            onClick={() => setSource((listSource = entry.id))}
          >
            <span>{entry.label}</span> <small>{counts[entry.id]}</small>
          </button>
        ))}
      </nav>
      <div className="jig-gallery-main">
        <p className="jig-intro">
          jig는 한 가지 작업을 위한 도구입니다. 계산 단계는 매번 같은 결과를 내고, AI 단계는 계산
          결과만 근거로 판정합니다. 연 jig는 위의 탭에서 3D와 함께 쓰고, 준비 중인 jig는 과거 작업을
          옮겨 오는 중입니다.
        </p>
        {notice ? <p role="status">{notice}</p> : null}
        <ImportJig projectId={projectId} onImported={() => setLoaded((n) => n + 1)} />
        {source === 'draft' ? <DraftList projectId={projectId} /> : null}
        <div className="jig-grid">
          {source === 'all' || source === 'draft' ? <MakeCard projectId={projectId} /> : null}
          {listed('project') ? tools.filter((t) => sourceOf(t) === 'project').map(toolCard) : null}
          {listed('official')
            ? (legacy ?? []).map((jig) => {
                const kind = legacyKind(`legacy:${jig.id}`);
                return (
                  <article
                    key={jig.id}
                    className="jig-card"
                    data-source="official"
                    data-status={jig.status}
                  >
                    <div className="jig-card-head">
                      <strong>{jig.name}</strong>
                      <span className="pill" data-ok={String(jig.status === 'available')}>
                        {jig.status === 'available' ? '사용 가능' : '준비 중'}
                      </span>
                    </div>
                    <p>{jig.summary}</p>
                    <small>
                      {jig.code} · 입력: {jig.inputs.join(', ')}
                      {jig.basis ? ` · 근거 ${jig.basis}` : ''}
                    </small>
                    {jig.status === 'available' && kind ? (
                      <button type="button" onClick={() => openContextTab(legacyTab(kind))}>
                        열기
                      </button>
                    ) : null}
                  </article>
                );
              })
            : null}
          {listed('official')
            ? tools.filter((t) => sourceOf(t) === 'official').map(toolCard)
            : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Open a new instance of a jig (SCR-18 [새로 열기]): its name and the output layer, an existing
 * layer of a linked model under which the jig makes one layer (SPEC-07.4). Both stay with it.
 */
function NewInstance({
  entry,
  context,
  onCancel,
  onOpened,
}: {
  entry: Package;
  context: JigContext;
  onCancel: () => void;
  onOpened: () => void;
}) {
  const layers = useMemo(() => context.layers ?? [], [context]);
  const [title, setTitle] = useState(
    context.projectName ? `${entry.name} · ${context.projectName}` : entry.name,
  );
  const [layer, setLayer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const listId = `jig-layers-${entry.id.replace(/[^a-z0-9]+/gi, '-')}`;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !layer.trim()) return;
    setBusy(true);
    setError('');
    try {
      const view = instanceViewSchema.parse(
        await api(`/projects/${encodeURIComponent(context.projectId)}/jig-instances`, 'POST', {
          jig: entry.id,
          version: entry.version,
          title: title.trim(),
          layerRoot: layer.trim(),
        }),
      );
      onOpened();
      openContextTab({
        instanceId: view.id,
        label: view.title,
        title: `${view.jig.name} · ${view.title}`,
      });
    } catch (cause) {
      setError(jigError(cause));
      setBusy(false);
    }
  };
  return (
    <form className="jig-new" onSubmit={(event) => void submit(event)}>
      <label>
        이름
        <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        출력 레이어
        <input
          value={layer}
          list={layers.length ? listId : undefined}
          maxLength={1000}
          placeholder={layers.length ? '연결 모델의 레이어' : '연결 모델의 레이어 이름'}
          onChange={(e) => setLayer(e.target.value)}
        />
      </label>
      {layers.length ? (
        <datalist id={listId}>
          {layers.map((path) => (
            <option key={path} value={path} />
          ))}
        </datalist>
      ) : null}
      <small>
        jig는 이 레이어 바로 아래 한 단계에만 만듭니다. 출력 레이어는 나중에 바꿀 수 없고, 바꾸려면
        새로 엽니다.
      </small>
      {error ? <p role="status">{error}</p> : null}
      <div>
        <button
          type="submit"
          className="primary-button"
          disabled={busy || !title.trim() || !layer.trim()}
        >
          {busy ? '여는 중…' : '열기'}
        </button>{' '}
        <button type="button" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}

function SyncJig({ context }: { context: JigContext }) {
  const rhinoSources = context.sources.filter((s) => s.host === 'rhino');
  const cadSources = context.sources.filter((s) => s.host === 'zwcad');
  const [rhino, setRhino] = useState(rhinoSources.at(-1)?.id ?? '');
  const [cad, setCad] = useState(cadSources.at(-1)?.id ?? '');
  const [tolerance, setTolerance] = useState(1);
  const [search, setSearch] = useState(100);
  const [rhinoLayers, setRhinoLayers] = useState<string[]>([]);
  const [cadLayers, setCadLayers] = useState<string[]>([]);
  const [result, setResult] = useState<Sync>();
  const [filter, setFilter] = useState<'problems' | Row['state'] | 'all'>('problems');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const run = async (extra: Record<string, unknown> = {}) => {
    if (!rhino || !cad) return;
    setBusy(true);
    setNotice('');
    try {
      const value = syncSchema.parse(
        await api(`/projects/${context.projectId}/jigs/sync`, 'POST', {
          rhino,
          cad,
          tolerance: tolerance / 1000,
          search: search / 1000,
          ...(rhinoLayers.length ? { rhinoLayers } : {}),
          ...(cadLayers.length ? { cadLayers } : {}),
          ...extra,
        }),
      );
      setResult(value);
      setPicked(new Set());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '실행하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  const rows = useMemo(
    () =>
      (result?.rows ?? []).filter((row) =>
        filter === 'all'
          ? true
          : filter === 'problems'
            ? row.state !== 'match'
            : row.state === filter,
      ),
    [result, filter],
  );
  const a = result?.alignment;
  const cadUnits = result?.cadUnits ?? 'Millimeters';
  const scale = unitScale[cadUnits] ?? 1000;
  const chosen = (result?.rows ?? []).filter((row) => picked.has(row.id));
  // Edits that make the drawing follow the model (coordinates in drawing units).
  const cadEdits = () => {
    const bestLayer = (layer: string) => result?.layers.find((l) => l.rhino === layer)?.cad;
    return chosen.flatMap((row): Record<string, unknown>[] => {
      const at = (p: number[]) =>
        round(
          p.map((v) => v * scale),
          1e3,
        );
      if (row.state === 'offset' && row.cad && row.ends)
        return [
          {
            row: row.id,
            action: 'move-ends',
            handle: row.cad.nativeId,
            from: row.ends.cad.map(at),
            to: row.ends.rhino.map((p) => at([p[0], p[1], row.ends!.cad[0][2]])),
          },
        ];
      if (row.state === 'rhino-only' && row.rhino && row.ends)
        return [
          {
            row: row.id,
            action: 'add-line',
            layer: bestLayer(row.rhino.layer) ?? row.rhino.layer,
            points: row.ends.rhino.map((p) => at([p[0], p[1], 0])),
          },
        ];
      if (row.state === 'cad-only' && row.cad)
        return [{ row: row.id, action: 'erase', handle: row.cad.nativeId }];
      return [];
    });
  };
  // Edits that make the model follow the drawing (metres, the AI's working units in Rhino).
  const rhinoEdits = () => {
    const bestLayer = (layer: string) => result?.layers.find((l) => l.cad === layer)?.rhino;
    return chosen.flatMap((row): Record<string, unknown>[] => {
      if (row.state === 'offset' && row.rhino && row.inRhino)
        return [
          {
            row: row.id,
            action: 'move-ends',
            id: row.rhino.nativeId,
            to: row.inRhino.map((p) => round(p)),
          },
        ];
      if (row.state === 'cad-only' && row.cad && row.inRhino)
        return [
          {
            row: row.id,
            action: 'add-line',
            layer: bestLayer(row.cad.layer) ?? row.cad.layer,
            points: row.inRhino.map((p) => round(p)),
          },
        ];
      if (row.state === 'rhino-only' && row.rhino)
        return [{ row: row.id, action: 'delete', id: row.rhino.nativeId }];
      return [];
    });
  };
  const table = () =>
    JSON.stringify({
      relation: a && {
        rotationDegrees: Math.round(((a.rotation * 180) / Math.PI) * 1e4) / 1e4,
        translationMm: round(
          a.translation.map((v) => v * 1000),
          10,
        ),
        heightDifferenceMm: Math.round(a.dz * 1e4) / 10,
        pairs: a.pairs,
        residualMm: {
          max: Math.round(a.residual.max * 1e4) / 10,
          rms: Math.round(a.residual.rms * 1e4) / 10,
        },
        ambiguous: a.ambiguous,
      },
      summary: result?.summary,
      layers: result?.layers.slice(0, 40),
      rows: (result?.rows ?? [])
        .filter((row) => row.state !== 'match')
        .slice(0, 250)
        .map((row) => ({
          row: row.id,
          state: row.state,
          rhino:
            row.rhino && `${row.rhino.name ?? ''} ${row.rhino.layer} ${row.rhino.nativeId}`.trim(),
          cad: row.cad && `${row.cad.layer} ${row.cad.nativeId} ${row.cad.type}`,
          deviationMm:
            row.deviation === undefined ? undefined : Math.round(row.deviation * 1e4) / 10,
          lengthM: row.length === undefined ? undefined : Math.round(row.length * 1000) / 1000,
        })),
    });
  const send = async (kind: 'review' | 'cad' | 'rhino') => {
    if (!result) return;
    setBusy(true);
    try {
      if (kind === 'review')
        await context.send({
          body: 'Sync jig 결과(첨부 sync-jig.json)를 검토해 줘. 위치 관계가 믿을 만한지, 레이어 대응이 맞는지, 오차·한쪽에만 있는 행이 실제 불일치인지 의도된 표현(중심선/외곽선, 층 높이, 도면 표기 관례 등)인지 판정하고, 어느 쪽을 고쳐야 할지 행 번호(R숫자)와 표의 수치만 인용해서 정리해 줘. 표에 없는 수치나 행은 만들지 마.',
          files: [{ name: 'sync-jig.json', text: table() }],
          permission: 'review',
          jig: { kind: 'sync-review', rows: result.rows.map((row) => row.id) },
        });
      else if (kind === 'cad')
        await context.send({
          body: `첨부 sync-edits.json의 편집을 열린 도면에 그대로 적용해 줘 (좌표 단위: ${cadUnits}). move-ends는 해당 핸들 선의 두 끝점을 from→to로 옮기고, add-line은 지정 레이어(없으면 만들기)에 선을 추가하고, erase는 해당 핸들을 지워. 목록에 없는 객체는 건드리지 마. 끝나면 조회해서 결과를 행 번호별로 알려 줘.`,
          files: [{ name: 'sync-edits.json', text: JSON.stringify(cadEdits()) }],
          permission: 'candidate',
          host: 'zwcad',
          baseRequestId: cad,
          jig: { kind: 'sync-apply', side: 'cad' },
        });
      else
        await context.send({
          body: '첨부 sync-edits.json의 편집을 Rhino 문서에 그대로 적용해 줘 (좌표 단위: m, 작업 사본 기준). move-ends는 해당 ID 곡선의 두 끝점을 to로 옮기고(직선 유지, ID·이름·레이어·속성 유지), add-line은 지정 레이어(없으면 만들기)에 선을 추가하고, delete는 해당 ID를 지워. 목록에 없는 객체는 건드리지 마. 끝나면 조회해서 결과를 행 번호별로 알려 줘.',
          files: [{ name: 'sync-edits.json', text: JSON.stringify(rhinoEdits()) }],
          permission: 'candidate',
          host: 'rhino',
          baseRequestId: rhino,
          applyToSource: true,
          jig: { kind: 'sync-apply', side: 'rhino' },
        });
      setNotice(
        kind === 'review'
          ? 'AI 검토를 대화에 보냈습니다.'
          : '반영 요청을 대화에 보냈습니다. 결과는 오른쪽 대화에서 확인하세요.',
      );
    } catch (error) {
      console.error(error);
      setNotice((error instanceof Error && error.message) || '보내지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  const layerPicker = (
    title: string,
    list: { name: string; count: number }[],
    value: string[],
    set: (v: string[]) => void,
  ) => (
    <details className="jig-layers">
      <summary>
        {title} 레이어 {value.length ? `${value.length}개 선택` : '전체'}
      </summary>
      {list.map((layer) => (
        <label key={layer.name}>
          <input
            type="checkbox"
            checked={value.includes(layer.name)}
            onChange={(event) =>
              set(
                event.target.checked
                  ? [...value, layer.name]
                  : value.filter((n) => n !== layer.name),
              )
            }
          />
          {layer.name || '(이름 없음)'} <small>{layer.count}</small>
        </label>
      ))}
    </details>
  );
  return (
    <div className="jig-sync">
      <div className="jig-inputs">
        <label>
          Rhino Sync
          <select aria-label="Rhino Sync" value={rhino} onChange={(e) => setRhino(e.target.value)}>
            {!rhinoSources.length ? <option value="">Rhino Sync가 없습니다</option> : null}
            {rhinoSources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          ZWCAD Sync
          <select aria-label="ZWCAD Sync" value={cad} onChange={(e) => setCad(e.target.value)}>
            {!cadSources.length ? <option value="">ZWCAD Sync가 없습니다</option> : null}
            {cadSources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          일치 허용 (mm)
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={tolerance}
            onChange={(e) => setTolerance(Number(e.target.value) || 1)}
          />
        </label>
        <label>
          탐색 반경 (mm)
          <input
            type="number"
            min="1"
            step="10"
            value={search}
            onChange={(e) => setSearch(Number(e.target.value) || 100)}
          />
        </label>
        <button
          type="button"
          className="primary-button"
          disabled={busy || !rhino || !cad}
          onClick={() => void run()}
        >
          {busy ? '계산 중…' : '정렬·비교 실행'}
        </button>
      </div>
      {!rhinoSources.length || !cadSources.length ? (
        <small>Rhino 문서와 ZWCAD 도면을 각각 한 번 Sync하면 여기서 고를 수 있습니다.</small>
      ) : null}
      {result ? (
        <div className="jig-layer-pickers">
          {layerPicker('Rhino', result.rhinoLayers, rhinoLayers, setRhinoLayers)}
          {layerPicker('CAD', result.cadLayers, cadLayers, setCadLayers)}
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {a ? (
        <section className="jig-relation">
          <h3>위치 관계 (Rhino → CAD)</h3>
          <p>
            이동 X {mm(a.translation[0])} · Y {mm(a.translation[1])} · 높이 차 {mm(a.dz)} · 회전{' '}
            {Math.round(((a.rotation * 180) / Math.PI) * 1000) / 1000}° · 대응 {a.pairs}쌍 · 잔차
            최대 {mm(a.residual.max)} · RMS {mm(a.residual.rms)}
            {a.source === 'identity' ? ' · 대응하는 직선이 없어 원점 그대로 비교했습니다' : ''}
          </p>
          {a.ambiguous ? (
            <div className="jig-ambiguous">
              <strong>같은 간격이 반복돼 위치 관계가 하나로 정해지지 않습니다.</strong> 후보를
              고르거나, 기준 레이어(그리드 등)만 남기고 다시 실행하세요.
              {a.candidates.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() =>
                    void run({
                      candidate: { rotation: c.rotation, translation: c.translation, dz: c.dz },
                    })
                  }
                >
                  후보 {i + 1}: X {mm(c.translation[0])}, Y {mm(c.translation[1])} ({c.votes}쌍)
                </button>
              ))}
            </div>
          ) : null}
          <p className="jig-summary">
            일치 {result!.summary.match} · <b>오차 {result!.summary.offset}</b> ·{' '}
            <b>Rhino에만 {result!.summary.rhinoOnly}</b> · <b>CAD에만 {result!.summary.cadOnly}</b>{' '}
            (Rhino {result!.counts.rhino}개 · CAD {result!.counts.cad}개)
          </p>
          {result!.layers.length ? (
            <details>
              <summary>레이어 대응 {result!.layers.length}개</summary>
              <ul>
                {result!.layers.slice(0, 30).map((l) => (
                  <li key={l.rhino + '|' + l.cad}>
                    {l.rhino || '(이름 없음)'} ↔ {l.cad || '(이름 없음)'} · {l.pairs}쌍
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}
      {result ? (
        <>
          <div className="jig-filter" role="group" aria-label="차이 보기">
            {(['problems', 'offset', 'rhino-only', 'cad-only', 'match', 'all'] as const).map(
              (key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                >
                  {key === 'problems' ? '불일치 전체' : key === 'all' ? '전체' : stateText[key]}
                </button>
              ),
            )}
          </div>
          <div className="jig-table-wrap">
            <table className="jig-table">
              <thead>
                <tr>
                  <th />
                  <th>행</th>
                  <th>상태</th>
                  <th>Rhino</th>
                  <th>CAD</th>
                  <th>차이</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 500).map((row) => (
                  <tr key={row.id} data-state={row.state}>
                    <td>
                      {row.state !== 'match' ? (
                        <input
                          type="checkbox"
                          aria-label={`${row.id} 선택`}
                          checked={picked.has(row.id)}
                          onChange={(event) => {
                            const next = new Set(picked);
                            if (event.target.checked) next.add(row.id);
                            else next.delete(row.id);
                            setPicked(next);
                          }}
                        />
                      ) : null}
                    </td>
                    <td>{row.id}</td>
                    <td>{stateText[row.state]}</td>
                    <td>
                      {row.rhino ? (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => context.show(rhino, row.rhino!.id)}
                        >
                          {row.rhino.name && row.rhino.name !== 'Object'
                            ? row.rhino.name + ' · '
                            : ''}
                          {row.rhino.layer || row.rhino.type}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {row.cad ? (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => context.show(cad, row.cad!.id)}
                        >
                          {row.cad.layer} · {row.cad.nativeId}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{row.deviation === undefined ? '' : mm(row.deviation)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 500 ? (
              <small>처음 500행만 표시합니다 (전체 {rows.length}).</small>
            ) : null}
          </div>
          <div className="jig-actions">
            <button type="button" disabled={busy} onClick={() => void send('review')}>
              AI 검토 (차이의 의미 판정)
            </button>
            <button
              type="button"
              disabled={busy || !chosen.length}
              onClick={() => void send('cad')}
            >
              선택 {chosen.length}개 · CAD를 Rhino에 맞춤
            </button>
            <button
              type="button"
              disabled={busy || !chosen.length}
              onClick={() => void send('rhino')}
            >
              선택 {chosen.length}개 · Rhino를 CAD에 맞춤
            </button>
          </div>
          <small>
            오차는 끝점을 옮기고, 한쪽에만 있는 것은 반대쪽에 선을 추가하거나(맞출 대상 쪽이 기준)
            지웁니다. 반영은 대화에 요청으로 보내며 CAD는 열린 도면에 바로(UNDO 가능), Rhino는
            사본에서 수정 후 문서에 적용합니다.
          </small>
        </>
      ) : null}
    </div>
  );
}

function titleOf(jig: OpenJig) {
  if (jig.kind !== 'instance') return LEGACY[jig.kind].title;
  return (
    jig.host?.state().instance?.jig.name ??
    contextTabs().find((tab) => tab.instanceId === jig.instanceId)?.label ??
    'JIG'
  );
}

/** The panel: the jig list on the JIG tab, or the shown jig with its head (fold, list, close). */
function Surface({ context }: { context: JigContext }) {
  const jig = shown;
  const list = activeWorkspace() === 'jig';
  const title = jig ? titleOf(jig) : 'JIG';
  return (
    <>
      {jig ? (
        collapsed ? (
          <button
            type="button"
            className="jig-expand"
            aria-label={`${title} 펼치기`}
            title="JIG 펼치기"
            onClick={() => fold(false)}
          >
            <span>{title}</span>
          </button>
        ) : (
          <div className="quantity-head">
            <h2>{title}</h2>
            <div>
              <button
                type="button"
                title="JIG 목록 · 이 탭은 그대로 둡니다"
                onClick={() => setWorkspace('jig')}
              >
                목록
              </button>{' '}
              <button
                type="button"
                title="3D를 넓게 보기 · 입력과 결과는 그대로 둡니다"
                onClick={() => fold(true)}
              >
                접기
              </button>{' '}
              <button
                type="button"
                title="이 탭 닫기 · 작업본은 남고 JIG 목록에서 다시 엽니다"
                onClick={() => closeContextTab(jig.instanceId)}
              >
                닫기
              </button>
            </div>
          </div>
        )
      ) : null}
      {/* The list is read again on each visit and leaves nothing behind in the panel. */}
      {list ? (
        <div className="jig-list">
          <Gallery context={context} />
        </div>
      ) : null}
      {/* Every opened jig stays mounted; hiding keeps its inputs and results. */}
      {[...mounted.values()].map((open) => (
        <div
          key={open.instanceId}
          className="jig-body"
          data-jig={open.kind}
          hidden={open !== jig || collapsed}
        >
          <JigBody jig={open} generation={generation} />
        </div>
      ))}
    </>
  );
}

/** One jig's screen; kept from re-rendering while other tabs change (`generation` = new Syncs). */
const JigBody = memo(function JigBody({ jig }: { jig: OpenJig; generation: number }) {
  switch (jig.kind) {
    case 'sync':
      return <SyncJig context={jig.context} />;
    case 'structure':
      return <StructureJig context={jig.context} />;
    case 'knowledge':
      return <KnowledgeJig projectId={jig.context.projectId} />;
    case 'instance':
      // A jig with a declared screen draws it (T-048); otherwise the plain instance view.
      return <DeclaredJig host={jig.host!} plain={<InstanceJig host={jig.host!} />} />;
    default:
      return <InstanceJig host={jig.host!} />;
  }
});

const stepText: Record<string, string> = {
  pending: '계산 전',
  running: '계산 중',
  done: '계산됨',
  failed: '실패',
  stale: '다시 계산 필요',
  waiting: '확정 전',
  confirmed: '확정됨',
  reconfirm: '다시 확인 필요',
  blocked: '앞 단계에서 멈춤',
  skipped: '건너뜀',
  'gate-failed': '점검에 막힘',
};
const stepMark: Record<string, string> = {
  done: '✓',
  confirmed: '✓',
  failed: '✕',
  'gate-failed': '✕',
  blocked: '✕',
  stale: '◌',
  reconfirm: '!',
  running: '…',
  skipped: '–',
};
const kindText: Record<string, string> = {
  code: '계산',
  library: '라이브러리',
  ai: 'AI',
  human: '사람',
  host: '호스트',
};
const byText: Record<string, string> = {
  default: '기본값',
  user: '사용자',
  decision: '결정',
  fact: '자료',
  ai: 'AI',
  rhino: 'Rhino',
  sketch: '스케치',
};
const instanceText: Record<string, string> = {
  new: '계산 전',
  computed: '계산됨',
  'gate-failed': '점검 실패',
  stale: '다시 계산 필요',
};

/** A plain view of an instance (steps and settings) for a jig the declarative panel does not draw. */
function InstanceJig({ host }: { host: JigHost }) {
  const state = useSyncExternalStore(host.subscribe, host.state);
  const view = state.instance;
  if (!view)
    return (
      <p className="jig-intro" role="status">
        {state.error ?? '작업본을 읽는 중…'}{' '}
        {state.error && !state.busy ? (
          <button type="button" onClick={() => void host.refresh()}>
            다시 읽기
          </button>
        ) : null}
      </p>
    );
  const groups = new Map<string, JigInstanceView['params']>();
  for (const param of view.params)
    groups.set(param.group, [...(groups.get(param.group) ?? []), param]);
  return (
    <div className="jig-instance">
      <p className="jig-intro">
        {view.jig.name} {view.jig.version} · {instanceText[view.status] ?? view.status} · 출력
        레이어 {view.body.layerRoot}
      </p>
      <div className="jig-actions">
        <button
          type="button"
          className="primary-button"
          disabled={state.busy}
          onClick={() => void host.run()}
        >
          {state.busy ? '계산 중…' : '계산'}
        </button>
      </div>
      {state.error ? <p role="status">{state.error}</p> : null}
      <ol className="jig-steps" aria-label="단계">
        {view.steps.map((step) => {
          const ran = state.report?.steps.find((entry) => entry.id === step.id);
          const status = ran?.status ?? step.status;
          const ms = ran ? ran.ms : step.ms;
          const problems = (ran?.gates ?? step.gates ?? []).filter((g) => !g.ok && !g.verdict);
          return (
            <li key={step.id} data-status={status}>
              <span className="jig-step-mark" aria-hidden="true">
                {stepMark[status] ?? '○'}
              </span>
              <div>
                <strong>{step.title}</strong>
                <small>
                  {[
                    stepText[status] ?? status,
                    kindText[step.kind] ?? step.kind,
                    ms != null ? `${ms} ms` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
                {problems.map((gate) => (
                  <p key={gate.name}>{gate.message}</p>
                ))}
                {ran?.error ? <p>{ran.error.message}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
      {[...groups].map(([group, params]) => (
        <fieldset key={group} className="jig-param-group" disabled={state.busy}>
          <legend>{group}</legend>
          {params.map((param) => (
            <ParamRow
              key={`${param.key}:${String(param.displayValue)}`}
              param={param}
              set={(value) =>
                void host.params.set([
                  {
                    key: param.key,
                    value,
                    ...(typeof value === 'number' ? { unit: param.displayUnit } : {}),
                  },
                ])
              }
            />
          ))}
        </fieldset>
      ))}
    </div>
  );
}
/** One setting: the value in its display unit; a new value is sent when the field is left. */
function ParamRow({
  param,
  set,
}: {
  param: JigInstanceView['params'][number];
  set: (value: number | string | boolean) => void;
}) {
  const fixed = !!param.fixedAtPin;
  const commit = (input: HTMLInputElement) => {
    if (typeof param.displayValue === 'number') {
      const value = Number(input.value);
      if (input.value.trim() === '' || !Number.isFinite(value)) {
        input.value = String(param.displayValue);
        return;
      }
      if (value !== param.displayValue) set(value);
    } else if (input.value !== param.displayValue) set(input.value);
  };
  const control = param.choices?.length ? (
    <select
      aria-label={param.title}
      defaultValue={String(param.value)}
      disabled={fixed}
      onChange={(event) => set(event.target.value)}
    >
      {param.choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </select>
  ) : typeof param.value === 'boolean' ? (
    <input
      type="checkbox"
      aria-label={param.title}
      defaultChecked={param.value}
      disabled={fixed}
      onChange={(event) => set(event.target.checked)}
    />
  ) : (
    <input
      type={typeof param.displayValue === 'number' ? 'number' : 'text'}
      step="any"
      aria-label={param.title}
      defaultValue={String(param.displayValue)}
      disabled={fixed}
      onBlur={(event) => commit(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(event.currentTarget);
      }}
    />
  );
  return (
    <div className="jig-param" title={param.help}>
      <span>{param.title}</span>
      {control}
      <small>
        {param.displayUnit}
        {fixed ? ' · 고정' : ` · ${byText[param.by] ?? param.by}`}
      </small>
    </div>
  );
}

/** Give the jig screens the workspace: project, Syncs, viewport and conversation. */
export function attachJigs(context: () => JigContext) {
  provide = context;
}
/**
 * The rail's JIG button: back to the jig used last (its tab opens again if it was closed; an older
 * jig comes back with its inputs and results), or the JIG list before any jig was opened.
 */
export function showJigs() {
  const active = activeWorkspace();
  if (active === 'jig' || contextTabs().some((tab) => contextId(tab.instanceId) === active)) {
    if (collapsed) fold(false);
    return;
  }
  const last = lastJigInstance();
  if (last) setWorkspace('jig', { instanceId: last });
  else setWorkspace('jig');
}
/** The Syncs changed: open jigs get the new list without being opened again. */
export function refreshJigs() {
  if (!mounted.size) return;
  const context = current();
  if (!context) return;
  const key = context.sources.map((source) => `${source.id}|${source.label}`).join('\n');
  if (key === sourcesKey) return;
  sourcesKey = key;
  generation++;
  if (dialog.open) render();
}
/** The viewport reports a click on an overlay item; the shown jig may follow it. */
export function overlayPicked(hit: { key: string; itemId: string }) {
  dialog.dispatchEvent(
    new CustomEvent('overlaypick', { detail: { key: hit.key, itemId: hit.itemId } }),
  );
}
