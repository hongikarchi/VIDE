import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { api } from '../gateway.ts';
import type { PanelSetting } from './bindings.ts';

// One instance (이 프로젝트의 jig) seen from the declarative panel: its view, the latest step
// outputs and reports, and the actions of the jig instance routes (ARCH-03 §7). A setting moved
// on a slider is written while dragging and only the `live` steps are recomputed; letting go
// recomputes the rest. Changes queue behind each other so the engine only sees the latest value,
// and a step whose inputs changed shows '다시 계산 필요' until a run reaches it (SPEC-07.7).

const gate = z
  .object({
    name: z.string(),
    level: z.string(),
    ok: z.boolean(),
    failed: z.array(z.string()),
    message: z.string(),
  })
  .passthrough();
export type Gate = z.infer<typeof gate>;
const setting = z
  .object({
    key: z.string(),
    title: z.string(),
    group: z.string(),
    type: z.string(),
    unit: z.string(),
    displayUnit: z.string(),
    decimals: z.number().optional(),
    value: z.union([z.number(), z.string(), z.boolean()]),
    displayValue: z.union([z.number(), z.string(), z.boolean()]),
    by: z.string(),
    ref: z.string().optional(),
    status: z.string().optional(),
    at: z.string(),
    fixedAtPin: z.boolean().optional(),
    range: z.object({ min: z.number(), max: z.number(), step: z.number().optional() }).optional(),
    choices: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    board: z.boolean().optional(),
    basis: z
      .object({
        status: z.enum(['confirmed', 'assumed', 'chosen', 'to-ask']),
        note: z.string().optional(),
        question: z.string().optional(),
      })
      .passthrough()
      .optional(),
    help: z.string().optional(),
  })
  .passthrough();
const assembled = z
  .object({
    role: z.string(),
    sources: z.array(
      z
        .object({ linkId: z.string(), readId: z.string(), layers: z.array(z.string()) })
        .passthrough(),
    ),
    confirmed: z.object({ by: z.string(), at: z.string() }).optional(),
  })
  .passthrough();
export const viewSchema = z
  .object({
    id: z.string(),
    jig: z.object({ id: z.string(), version: z.string(), name: z.string() }).passthrough(),
    title: z.string(),
    status: z.string(),
    body: z
      .object({
        layerRoot: z.string(),
        assembly: z.record(z.string(), assembled),
        zones: z.record(z.string(), z.array(z.unknown())).optional(),
      })
      .passthrough(),
    steps: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          kind: z.string(),
          speed: z.string(),
          status: z.string(),
          inputHash: z.string().optional(),
          ms: z.number().nullable().optional(),
          gates: z.array(gate).optional(),
        })
        .passthrough(),
    ),
    params: z.array(setting),
    inputs: z.array(
      z
        .object({
          key: z.string(),
          title: z.string(),
          kind: z.string(),
          required: z.boolean().optional(),
          roles: z
            .array(
              z
                .object({ role: z.string(), title: z.string(), required: z.boolean() })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    ),
    updatedAt: z.string(),
  })
  .passthrough();
export type InstanceView = z.infer<typeof viewSchema> & { params: PanelSetting[] };
const stepReport = z
  .object({
    id: z.string(),
    kind: z.string(),
    status: z.string(),
    inputHash: z.string(),
    cached: z.boolean(),
    ms: z.number().nullable(),
    gates: z.array(gate),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .passthrough();
export type StepReport = z.infer<typeof stepReport>;
const reportSchema = z
  .object({
    steps: z.array(stepReport),
    outputs: z.record(z.string(), z.unknown()),
    blocked: z.boolean(),
    superseded: z.boolean(),
  })
  .passthrough();
const candidates = z.object({
  proposals: z.record(
    z.string(),
    z.object({
      candidates: z.array(
        z.object({
          readId: z.string(),
          linkId: z.string(),
          layer: z.string(),
          objectCount: z.number(),
          reason: z.string(),
        }),
      ),
    }),
  ),
});
export type Candidate = z.infer<typeof candidates>['proposals'][string]['candidates'][number];

type Value = number | string | boolean;
const MESSAGES: Record<string, string> = {
  PARAM_FIXED: '이 설정값은 이 프로젝트의 jig를 만들 때 정해져 바꿀 수 없습니다.',
  OUT_OF_RANGE: '설정값이 허용 범위를 벗어났습니다.',
  UNIT_MISMATCH: '설정값의 단위가 맞지 않습니다.',
  LAYER_ROOT_MISSING: '연결 모델에 없는 레이어입니다. Rhino에 있는 레이어 이름을 쓰세요.',
  STALE_INPUT: '읽은 문서가 바뀌었습니다. 입력을 다시 읽으세요.',
  STALE_REFERENCE: '읽어 둔 입력을 찾을 수 없습니다. 연결 파일을 다시 읽으세요.',
  NOT_FOUND: '대상을 찾을 수 없습니다.',
  CONFIRMATION_REQUIRED: '확인이 필요한 작업입니다.',
  INVALID_INPUT: '입력이 올바르지 않습니다.',
};
export const messageOf = (error: unknown) =>
  MESSAGES[(error as { code?: string })?.code ?? ''] ??
  ((error instanceof Error && error.message) || '처리하지 못했습니다.');

/**
 * Sent on `window` when a setting of an instance changed outside its panel (the request box's
 * `PUT …/params` or its undo, app.ts); an open panel of that instance reads it again and recomputes.
 */
export const JIG_PARAMS_CHANGED = 'vide:jig-params-changed';

/**
 * Sent on `window` after each run of an open panel ({ instanceId, report }): a jig started from a
 * request (src/ui/skill-start.ts) waits for it before its AI turn.
 */
export const JIG_RAN = 'vide:jig-ran';
export type RunPreference = { mode: 'geometry' | 'confirmed'; until?: string };
/**
 * How a panel runs when nothing names the mode (open, recompute, a setting changed from the
 * request box): a jig started from a request computes up to its first human checkpoint
 * (`confirmed` mode, SPEC-07.7 fingerprints), not geometry only. Set before its tab opens.
 */
const runPreferences = new Map<string, RunPreference>();
export function preferRun(instanceId: string, preference: RunPreference | undefined) {
  if (preference) runPreferences.set(instanceId, preference);
  else runPreferences.delete(instanceId);
}

/** A step that has been evaluated by a run no longer waits for one. */
const evaluated = (status: string) => status !== 'blocked' && status !== 'skipped';

export function useInstance(projectId: string, instanceId: string) {
  const base = `/projects/${encodeURIComponent(projectId)}/jig-instances/${encodeURIComponent(instanceId)}`;
  const [view, setViewState] = useState<InstanceView>();
  const [outputs, setOutputs] = useState<Record<string, unknown>>({});
  const [reports, setReports] = useState<Record<string, StepReport>>({});
  const [stale, setStale] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<Record<string, Value>>({});
  const [proposals, setProposals] = useState<Record<string, Candidate[]>>({});
  const [busy, setBusy] = useState(false);
  const [computing, setComputing] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [lastRun, setLastRun] = useState<Date>();
  const viewRef = useRef<InstanceView | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const setView = (next: unknown) => {
    const parsed = viewSchema.parse(next) as InstanceView;
    viewRef.current = parsed;
    if (mounted.current) setViewState(parsed);
    return parsed;
  };

  const run = useCallback(
    async (options: { until?: string; mode?: 'geometry' | 'confirmed' } = {}) => {
      setComputing(true);
      try {
        // A full run without a named mode follows the instance's preference (a started skill).
        const preferred =
          !options.mode && !options.until ? runPreferences.get(instanceId) : undefined;
        const mode = options.mode ?? preferred?.mode ?? 'geometry';
        const until = options.until ?? preferred?.until;
        const ran = (detail: Record<string, unknown>) =>
          window.dispatchEvent(
            new CustomEvent(JIG_RAN, { detail: { instanceId, mode, ...detail } }),
          );
        let report: z.infer<typeof reportSchema>;
        try {
          report = reportSchema.parse(
            await api(`${base}/run`, 'POST', { mode, ...(until ? { until } : {}) }),
          );
        } catch (error) {
          ran({ error });
          throw error;
        }
        ran({ report });
        if (report.superseded || !mounted.current) return report;
        setOutputs((current) => ({ ...current, ...report.outputs }));
        setReports((current) => ({
          ...current,
          ...Object.fromEntries(report.steps.map((step) => [step.id, step])),
        }));
        setStale((current) => {
          const next = new Set(current);
          for (const step of report.steps) if (evaluated(step.status)) next.delete(step.id);
          return next;
        });
        setLastRun(new Date());
        return report;
      } finally {
        if (mounted.current) setComputing(false);
      }
    },
    [base, instanceId],
  );

  // Open: the view, then a run (cached steps come back without computing).
  useEffect(() => {
    let live = true;
    setNotice(undefined);
    void (async () => {
      try {
        setView(await api(base));
        if (live) await run();
      } catch (error) {
        if (live) setNotice(messageOf(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [base, run]);

  // A setting changed from the request box: read the instance again and recompute.
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ instanceId?: string }>).detail?.instanceId !== instanceId) return;
      void (async () => {
        try {
          setView(await api(base));
          if (mounted.current) setNotice(undefined);
          await run();
        } catch (error) {
          if (mounted.current) setNotice(messageOf(error));
        }
      })();
    };
    window.addEventListener(JIG_PARAMS_CHANGED, changed);
    return () => window.removeEventListener(JIG_PARAMS_CHANGED, changed);
  }, [base, instanceId, run]);

  // Setting changes: the latest value per key waits here while the engine is busy.
  const queue = useRef({ values: new Map<string, Value>(), full: false });
  const pumping = useRef(false);
  const liveUntil = () => viewRef.current?.steps.filter((step) => step.speed === 'live').at(-1)?.id;
  const pump = async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      while (queue.current.values.size || queue.current.full) {
        const values = [...queue.current.values];
        queue.current.values.clear();
        const full = queue.current.full;
        queue.current.full = false;
        const known = viewRef.current?.params;
        const changes = values.filter(
          ([key, value]) => known?.find((p) => p.key === key)?.value !== value,
        );
        if (changes.length) {
          const response = z
            .object({ affected: z.array(z.string()), instance: z.unknown() })
            .passthrough()
            .parse(
              await api(`${base}/params`, 'PUT', {
                values: changes.map(([key, value]) => ({ key, value })),
                by: 'user',
              }),
            );
          setView(response.instance);
          setStale((current) => new Set([...current, ...response.affected]));
        }
        // A newer position is waiting: compute that one instead.
        if (!full && queue.current.values.size) continue;
        const until = liveUntil();
        if (full) await run();
        else if (changes.length && until) await run({ until });
      }
      if (mounted.current) setPending({});
    } catch (error) {
      queue.current = { values: new Map(), full: false };
      if (mounted.current) {
        setPending({});
        setNotice(messageOf(error));
      }
    } finally {
      pumping.current = false;
    }
  };
  const change = (key: string, value: Value, phase: 'drag' | 'release') => {
    setNotice(undefined);
    setPending((current) => ({ ...current, [key]: value }));
    queue.current.values.set(key, value);
    if (phase === 'release') queue.current.full = true;
    else if (!liveUntil()) return; // no geometry steps to show while dragging
    void pump();
  };

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await work();
    } catch (error) {
      if (mounted.current) setNotice(messageOf(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const confirmStep = (stepId: string) =>
    act(async () => {
      const inputHash = reports[stepId]?.inputHash;
      if (!inputHash) return;
      setView(
        await api(`${base}/steps/${encodeURIComponent(stepId)}/confirm`, 'POST', { inputHash }),
      );
      await run();
    });
  /**
   * Candidates for a role. Layers that fit the role and are not read yet are read first from the
   * given Syncs (a jig input read: only those layers, nothing else changes, SPEC-07.5).
   */
  const findRole = (roleKey: string, syncIds: readonly string[], layers: readonly string[]) =>
    act(async () => {
      const known = z
        .object({ reads: z.array(z.object({ layers: z.array(z.string()) }).passthrough()) })
        .passthrough()
        .parse(await api(`${base}/reads`)).reads;
      const covered = new Set(known.flatMap((read) => read.layers));
      const missing = layers.filter((layer) => !covered.has(layer));
      if (missing.length)
        for (const syncId of syncIds)
          await api(`${base}/reads`, 'POST', { syncId, layers: missing, purpose: 'assembly' });
      const found = candidates.parse(
        await api(`${base}/assembly/propose`, 'POST', { roles: [roleKey] }),
      );
      setProposals((current) => ({
        ...current,
        [roleKey]: found.proposals[roleKey]?.candidates ?? [],
      }));
    });
  const confirmRole = (roleKey: string, candidate?: Candidate) =>
    act(async () => {
      const sources = candidate
        ? [{ readId: candidate.readId, layers: [candidate.layer] }]
        : (viewRef.current?.body.assembly[roleKey]?.sources ?? []).map((s) => ({
            readId: s.readId,
            layers: s.layers,
          }));
      if (!sources.length) return;
      await api(`${base}/assembly/${encodeURIComponent(roleKey)}`, 'PUT', {
        sources,
        confirm: true,
      });
      setProposals(({ [roleKey]: _done, ...rest }) => rest);
      setView(await api(base));
      await run();
    });
  const runStep = (stepId: string) => act(() => run({ until: stepId, mode: 'confirmed' }));
  /** Every step again (after edits made in Rhino were taken as 수정 사항). */
  const recompute = () => act(() => run());

  return {
    view,
    outputs,
    reports,
    stale,
    pending,
    proposals,
    busy,
    computing,
    notice,
    lastRun,
    change,
    confirmStep,
    findRole,
    confirmRole,
    runStep,
    recompute,
  };
}
export type InstanceState = ReturnType<typeof useInstance>;
