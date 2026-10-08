import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { api } from '../gateway.ts';
import { remoteSession } from '../remote-panel.ts';
import type { PanelData, PanelSetting } from '../jig-panel/bindings.ts';
import { JIG_PARAMS_CHANGED, messageOf, type InstanceState } from '../jig-panel/instance.ts';
import {
  STAGES,
  defaultColorBy,
  readLayout,
  readMembers,
  readTyping,
  stageOf,
  stagesUpTo,
  valueOf,
  type ColorBy,
  type PanelingStage,
  type Read,
  type Results,
} from './model.ts';
import type { MemberSet, PanelLayout, PanelTyping } from '../../contracts/paneling.ts';

// What the 패널링 parts share (SPEC-16.3·16.4·16.8, Design SCR-33): the chosen stage, the 색 기준
// and the chosen panel; the three step outputs read against the contract; which stage is computed
// or '다시 계산 필요'; the 기준 면 the instance holds (`GET …/paneling/surface`, PLAN-49 T-251) and
// the person's actions on it ([고른 면 쓰기] · [다시 읽기]); taking an assumed value as the
// person's (same value, `by: 'user'`) and answering a question card (`by: 'decision'`). One store
// per instance so the parts on screen agree; nothing here computes geometry or reads Rhino on its
// own — only the buttons do.

export interface SurfaceState {
  documentName?: string;
  linkId?: string;
  objectId?: string;
  faces: number;
  readAt?: string;
  /** Document unit as written ('mm'). */
  unit?: string;
  /** Extent of the read faces, metres. */
  extent?: [number, number, number];
  /** Live Sync saw the face's fingerprint move (SPEC-16.3 3). */
  changed: boolean;
}
// The engine's answers (PLAN-49 T-251, `src/server/paneling-routes.ts`): GET `…/paneling/surface`
// gives the kept reference, its summary and '기준 면이 바뀜'; POST `…/paneling/surface/read` gives
// the new reference or `ok: false` with the reason (the earlier sample stays).
const pickedSchema = z
  .object({
    linkId: z.string().optional(),
    objectId: z.string().optional(),
    faces: z.array(z.number()).default([]),
    readAt: z.string().optional(),
  })
  .passthrough();
const summarySchema = z
  .object({
    toMeters: z.number().optional(),
    extent: z.tuple([z.number(), z.number(), z.number()]).optional(),
  })
  .passthrough()
  .nullable()
  .optional();
const surfaceStateSchema = z
  .object({
    picked: pickedSchema.nullable().optional(),
    documentName: z.string().optional(),
    summary: summarySchema,
    changed: z.unknown().optional(),
  })
  .passthrough();
const surfaceReadSchema = z
  .object({
    ok: z.boolean(),
    code: z.string().optional(),
    message: z.string().optional(),
    picked: pickedSchema.optional(),
    documentName: z.string().optional(),
    summary: summarySchema,
  })
  .passthrough();

const UNIT_BY_METERS: [number, string][] = [
  [0.001, 'mm'],
  [0.01, 'cm'],
  [1, 'm'],
  [0.0254, 'in'],
  [0.3048, 'ft'],
];
const unitOf = (toMeters?: number) =>
  toMeters === undefined
    ? undefined
    : UNIT_BY_METERS.find(([m]) => Math.abs(m - toMeters) < 1e-9 * Math.max(1, m))?.[1];

/** The card's view of a kept reference (null when no face was read). */
export function surfaceStateOf(
  answer: {
    picked?: z.infer<typeof pickedSchema> | null;
    documentName?: string;
    summary?: z.infer<typeof summarySchema>;
  },
  changed: unknown,
): SurfaceState | null {
  const { picked, summary, documentName } = answer;
  if (!picked) return null;
  return {
    documentName,
    linkId: picked.linkId,
    objectId: picked.objectId,
    faces: picked.faces.length,
    readAt: picked.readAt,
    unit: unitOf(summary?.toMeters),
    extent: summary?.extent,
    changed: Boolean(changed),
  };
}

/** Read failures by code (the read template's codes, ARCH-03 §9.1, and the route's); the
 * earlier sample stays (SPEC-16.3 5). */
const SURFACE_ERRORS: Record<string, string> = {
  MESH_NOT_ACCEPTED: '메쉬 기준 면은 아직 받지 않습니다 · Rhino에서 서피스로 바꾸세요',
  NOT_A_SURFACE: '서피스나 폴리서피스의 면이 아닙니다. Rhino에서 면을 고른 뒤 누르세요.',
  PICK_NONE: 'Rhino에서 서피스나 폴리서피스 면을 고른 뒤 누르세요.',
  FACE_NOT_FOUND: '고른 면을 찾지 못했습니다. Rhino에서 다시 고르세요.',
  HOST_NOT_CONNECTED: '연결된 Rhino 문서가 없습니다. Rhino를 연결한 뒤 다시 누르세요.',
  UNKNOWN_UNITS: '문서 단위를 알 수 없어 읽지 않았습니다.',
  NO_SAMPLE_INSIDE: '트림 안에 표본이 없습니다. 면이 너무 작거나 트림이 좁습니다.',
  SAMPLE_LIMIT: '표본이 한도(65,536점)를 넘습니다. 면을 나눠 고르세요.',
  READ_CHANGED_DOCUMENT: '읽는 동안 문서가 바뀌어 읽지 않았습니다. 다시 누르세요.',
  FORBIDDEN: '면 읽기는 작업 PC 화면에서 합니다.',
};
const MESH = 'MESH_NOT_ACCEPTED';

interface Shared {
  stage: PanelingStage;
  colorBy?: ColorBy;
  selected?: string;
  surface?: SurfaceState | null;
  surfaceError?: string;
  /** The surface error is a mesh pick (경고색 한 줄). */
  meshRefused?: boolean;
  reading?: boolean;
  /** Bumped by [가정 값 보기]: the settings part scrolls into view. */
  reveal: number;
  notice?: string;
}

class Store {
  state: Shared = { stage: 'preview', reveal: 0 };
  private listeners = new Set<() => void>();
  constructor(
    readonly projectId: string,
    readonly instanceId: string,
  ) {}
  get base() {
    return `/projects/${encodeURIComponent(this.projectId)}/jig-instances/${encodeURIComponent(this.instanceId)}`;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.state;
  set(next: Partial<Shared>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  get surfaceBase() {
    return `/projects/${encodeURIComponent(this.projectId)}/paneling/surface`;
  }
  async readSurface() {
    try {
      const read = surfaceStateSchema.parse(
        await api(`${this.surfaceBase}?instanceId=${encodeURIComponent(this.instanceId)}`),
      );
      this.set({ surface: surfaceStateOf(read, read.changed) });
    } catch {
      // Nothing read yet (or no route in this engine): the card asks for a face.
      this.set({ surface: null });
    }
  }
  async pickSurface(mode: 'pick' | 'reread') {
    this.set({ reading: true, surfaceError: undefined, meshRefused: false });
    try {
      const read = surfaceReadSchema.parse(
        await api(`${this.surfaceBase}/read`, 'POST', { instanceId: this.instanceId, mode }),
      );
      if (!read.ok) {
        // A refused read keeps the earlier sample (SPEC-16.3 5).
        const code = read.code ?? '';
        this.set({
          reading: false,
          surfaceError: read.message ?? SURFACE_ERRORS[code] ?? code,
          meshRefused: code === MESH,
        });
        return;
      }
      this.set({ surface: surfaceStateOf(read, false), reading: false });
      window.dispatchEvent(
        new CustomEvent(JIG_PARAMS_CHANGED, { detail: { instanceId: this.instanceId } }),
      );
    } catch (error) {
      const code = (error as { code?: string })?.code ?? '';
      this.set({
        reading: false,
        surfaceError: SURFACE_ERRORS[code] ?? messageOf(error),
        meshRefused: code === MESH,
      });
    }
  }
  /** Write values as given by a person (`user`) or a question card (`decision`), then recompute. */
  async setValues(
    values: { key: string; value: number | string | boolean }[],
    by: 'user' | 'decision',
  ) {
    if (!values.length) return;
    this.set({ notice: undefined });
    try {
      await api(`${this.base}/params`, 'PUT', { values, by });
      window.dispatchEvent(
        new CustomEvent(JIG_PARAMS_CHANGED, { detail: { instanceId: this.instanceId } }),
      );
    } catch (error) {
      this.set({ notice: messageOf(error) });
    }
  }
}
const stores = new Map<string, Store>();
function storeOf(projectId: string, instanceId: string) {
  const key = `${projectId}\u0000${instanceId}`;
  let store = stores.get(key);
  if (!store) stores.set(key, (store = new Store(projectId, instanceId)));
  return store;
}

export interface StageStatus {
  computed: boolean;
  stale: boolean;
  failed: boolean;
  /** The output is there but does not pass the contract (not drawn). */
  invalid: boolean;
}

export interface PanelingView {
  stage: PanelingStage;
  setStage: (stage: PanelingStage) => void;
  reads: { preview: Read<PanelLayout>; members: Read<MemberSet>; optimize: Read<PanelTyping> };
  results: Results;
  status: Record<PanelingStage, StageStatus>;
  settings: readonly PanelSetting[];
  /** Stored values with the changes still on their way. */
  values: Readonly<Record<string, number | string | boolean>>;
  colorBy: ColorBy;
  setColorBy: (colorBy: ColorBy) => void;
  selected?: string;
  select: (id: string | undefined) => void;
  surface?: SurfaceState | null;
  surfaceError?: string;
  meshRefused: boolean;
  reading: boolean;
  pickSurface: (mode: 'pick' | 'reread') => Promise<void>;
  confirm: (keys: readonly string[]) => Promise<void>;
  answer: (values: { key: string; value: number | string | boolean }[]) => Promise<void>;
  reveal: number;
  showAssumed: (stage: PanelingStage) => void;
  notice?: string;
  remote: boolean;
  /** The work copy's API path (`…/reports/paneling`, SPEC-16.11). */
  base: string;
}

export function usePaneling({
  projectId,
  instanceId,
  jig,
  data,
  remote,
}: {
  projectId: string;
  instanceId: string;
  jig: InstanceState;
  data: PanelData;
  remote?: boolean;
}): PanelingView {
  const store = storeOf(projectId, instanceId);
  const shared = useSyncExternalStore(store.subscribe, store.snapshot);
  const revision = jig.lastRun?.getTime();
  useEffect(() => {
    void store.readSurface();
  }, [store, revision]);

  const preview = data.outputs.preview,
    members = data.outputs.members,
    optimize = data.outputs.optimize;
  const reads = useMemo(
    () => ({
      preview: readLayout(preview),
      members: readMembers(members),
      optimize: readTyping(optimize),
    }),
    [preview, members, optimize],
  );
  const results = useMemo<Results>(
    () => ({
      layout: valueOf(reads.preview),
      members: valueOf(reads.members),
      typing: valueOf(reads.optimize),
    }),
    [reads],
  );
  const settings = jig.view?.params ?? [];
  const values = useMemo(
    () => ({
      ...Object.fromEntries(settings.map((s) => [s.key, s.value])),
      ...jig.pending,
    }),
    [settings, jig.pending],
  );
  const pendingStages = new Set(
    Object.keys(jig.pending).flatMap((key) => {
      const setting = settings.find((s) => s.key === key);
      const stage = setting && stageOf(setting);
      return stage ? [stage] : [];
    }),
  );
  const status = Object.fromEntries(
    STAGES.map(({ id }) => {
      const step = jig.view?.steps.find((s) => s.id === id);
      const report = jig.reports[id];
      const read = reads[id];
      const changedBefore = stagesUpTo(id).some((s) => pendingStages.has(s));
      return [
        id,
        {
          computed: read.kind === 'ok',
          invalid: read.kind === 'invalid',
          stale: jig.stale.has(id) || step?.status === 'stale' || changedBefore,
          failed:
            report?.status === 'failed' ||
            report?.status === 'gate-failed' ||
            step?.status === 'failed',
        },
      ];
    }),
  ) as Record<PanelingStage, StageStatus>;

  const setStage = useCallback((stage: PanelingStage) => store.set({ stage }), [store]);
  const setColorBy = useCallback((colorBy: ColorBy) => store.set({ colorBy }), [store]);
  const select = useCallback((selected: string | undefined) => store.set({ selected }), [store]);
  const confirm = useCallback(
    (keys: readonly string[]) =>
      store.setValues(
        keys.flatMap((key) => {
          const setting = settings.find((s) => s.key === key);
          return setting ? [{ key, value: setting.value }] : [];
        }),
        'user',
      ),
    [store, settings],
  );
  const answer = useCallback(
    (list: { key: string; value: number | string | boolean }[]) =>
      store.setValues(list, 'decision'),
    [store],
  );
  const showAssumed = useCallback(
    (stage: PanelingStage) => store.set({ stage, reveal: store.state.reveal + 1 }),
    [store],
  );
  const pickSurface = useCallback((mode: 'pick' | 'reread') => store.pickSurface(mode), [store]);

  return {
    stage: shared.stage,
    setStage,
    reads,
    results,
    status,
    settings,
    values,
    colorBy: shared.colorBy ?? defaultColorBy(shared.stage),
    setColorBy,
    selected: shared.selected,
    select,
    surface: shared.surface,
    surfaceError: shared.surfaceError,
    meshRefused: !!shared.meshRefused,
    reading: !!shared.reading,
    pickSurface,
    confirm,
    answer,
    reveal: shared.reveal,
    showAssumed,
    notice: shared.notice,
    remote: remote ?? remoteSession(),
    base: store.base,
  };
}
