import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { z } from 'zod';
import {
  complianceRoleRecordSchema,
  roleProposalSchema,
  type ComplianceRoleRecord,
  type RoleProposal,
} from '../../contracts/compliance.ts';
import { api } from '../gateway.ts';
import { remoteSession } from '../remote-panel.ts';
import { resolve, type PanelData } from '../jig-panel/bindings.ts';
import { messageOf, type InstanceState, type StepReport } from '../jig-panel/instance.ts';
import { readResult, staleReasons, type ResultRead, type SourceNow } from './model.ts';

// What the 법규 체크 parts share (SPEC-15.13, Design SCR-32): the result of the `check` step, the
// earlier results the instance reads now (`…/jig-outputs/:key`, as the `jig-source` cards read
// them), the project's classification records and AI proposals (`…/compliance/roles`, ARCH-03
// §8.6, T-237), and from those whether the kept result is '다시 체크 필요' and why. One store per
// instance so the four parts on screen ask the engine once; it reads again after each run and after
// a classification change, never on a timer, and never runs the check itself. It also keeps the
// linked document's revision now (`…/compliance/revision`, a fingerprint, no read — asked again
// when the VIDE window gets focus back from Rhino) and the last role-check read of the document
// (`POST …/compliance/read`: once when the panel opens on this PC, and at [법규 체크]).

const sourceSchema = z
  .object({
    input: z
      .object({ key: z.string(), from: z.object({ jig: z.string() }).passthrough().optional() })
      .passthrough(),
    current: z
      .object({
        instanceId: z.string(),
        jig: z.string(),
        status: z.string(),
        at: z.string().nullable(),
      })
      .passthrough()
      .nullable(),
    ready: z.boolean(),
    stale: z.boolean(),
  })
  .passthrough();
type SourceState = z.infer<typeof sourceSchema>;

const rolesSchema = z
  .object({
    records: z.array(complianceRoleRecordSchema),
    version: z.number().int().nonnegative(),
    proposals: z.array(roleProposalSchema).default([]),
  })
  .passthrough();
export interface RolesState {
  records: ComplianceRoleRecord[];
  version: number;
  proposals: RoleProposal[];
}

const revisionSchema = z
  .object({ revisionKey: z.string().nullable(), reason: z.string().optional() })
  .passthrough();
const readSchema = z
  .object({
    linkId: z.string(),
    documentKey: z.string(),
    revisionKey: z.string(),
    readAt: z.string(),
    toMeters: z.number().nullable(),
    rolesVersion: z.number(),
    objects: z.number(),
    unclassified: z.number(),
    byRole: z.record(z.string(), z.number()),
    unusedByReason: z.record(z.string(), z.number()),
    aiAccepted: z.number(),
    hiddenWithRole: z.number(),
    geometryChanged: z.number(),
    missingRecords: z.array(z.unknown()).default([]),
    notes: z.array(z.string()).default([]),
    rows: z
      .array(
        z
          .object({
            objectId: z.string(),
            layer: z.string(),
            role: z.string().nullable(),
            roleSource: z.string().nullable(),
            hidden: z.boolean(),
            reason: z.string().nullable(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
/** What the last role-check read of the document found (SPEC-15.3·15.4). */
export type CheckRead = z.infer<typeof readSchema>;

interface Shared {
  limits?: SourceNow | null;
  siteModel?: SourceNow | null;
  roles?: RolesState;
  rolesError?: string;
  /** The linked document's revision key now; null = cannot be compared (SPEC-15.13). */
  revision?: { linkId: string; key: string | null; reason?: string };
  read?: CheckRead;
  readError?: string;
  reading?: boolean;
}

const LIMITS_JIG = 'vide/buildable-mass';
const SITE_JIG = 'vide/site-model';

const nowOf = (state: SourceState): SourceNow => ({
  instanceId: state.current?.instanceId || null,
  at: state.current?.at ?? null,
  needsRecompute: !!state.current && state.current.status !== 'done',
  moved: state.stale,
});

class Store {
  state: Shared = {};
  private listeners = new Set<() => void>();
  private reading?: Promise<void>;
  private again = false;
  constructor(
    private projectId: string,
    private instanceId: string,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.state;
  private set(next: Partial<Shared>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  /** The document's revision now (a fingerprint, never a read of the document). */
  async revision(linkId: string | undefined) {
    if (!linkId) return;
    const base = `/projects/${encodeURIComponent(this.projectId)}`;
    try {
      const answer = revisionSchema.parse(
        await api(
          `${base}/compliance/revision?linkId=${encodeURIComponent(linkId)}`,
          'GET',
          undefined,
          { quiet: ['NOT_FOUND', 'FORBIDDEN'] },
        ),
      );
      this.set({ revision: { linkId, key: answer.revisionKey, reason: answer.reason } });
    } catch (error) {
      this.set({ revision: { linkId, key: null, reason: messageOf(error) } });
    }
  }
  private readOnce?: Promise<CheckRead | undefined>;
  /**
   * The role-check read (SPEC-15.3 1): reads the linked document whole and classifies it. `force`
   * reads again ([법규 체크], a role change) and throws on failure; otherwise once per store.
   */
  readDocument(force = false): Promise<CheckRead | undefined> {
    if (this.readOnce && !force) return this.readOnce;
    const base = `/projects/${encodeURIComponent(this.projectId)}`;
    this.set({ reading: true });
    const reading = (async () => {
      try {
        const answer = readSchema.parse(
          await api(
            `${base}/compliance/read`,
            'POST',
            { instanceId: this.instanceId },
            { quiet: ['HOST_NOT_CONNECTED', 'NOT_FOUND', 'STALE_REFERENCE', 'STALE_CONNECTION'] },
          ),
        );
        this.set({ read: answer, readError: undefined, reading: false });
        return answer;
      } catch (error) {
        this.set({ readError: messageOf(error), reading: false });
        if (force) throw error;
        return undefined;
      }
    })();
    this.readOnce = reading.catch(() => undefined);
    return reading;
  }
  /** Read the sources and the classification again (queued behind a read in flight). */
  refresh(inputs: readonly { key: string; kind: string; from?: unknown }[], documentKey?: string) {
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    this.reading = (async () => {
      try {
        do {
          this.again = false;
          await this.read(inputs, documentKey);
        } while (this.again);
      } finally {
        this.reading = undefined;
      }
    })();
    return this.reading;
  }
  private async read(
    inputs: readonly { key: string; kind: string; from?: unknown }[],
    documentKey?: string,
  ) {
    const base = `/projects/${encodeURIComponent(this.projectId)}`;
    const next: Shared = { limits: null, siteModel: null };
    await Promise.all(
      inputs
        .filter((input) => input.kind === 'jig-output')
        .map(async (input) => {
          try {
            const state = sourceSchema.parse(
              await api(
                `${base}/jig-instances/${encodeURIComponent(this.instanceId)}/jig-outputs/${encodeURIComponent(input.key)}`,
              ),
            );
            const jig =
              (input.from as { jig?: string } | undefined)?.jig ??
              state.input.from?.jig ??
              state.current?.jig;
            if (jig === LIMITS_JIG) next.limits = nowOf(state);
            else if (jig === SITE_JIG) next.siteModel = nowOf(state);
          } catch {
            // Unknown now: the staleness check leaves this source out rather than guess.
            const jig = (input.from as { jig?: string } | undefined)?.jig;
            if (jig === LIMITS_JIG) next.limits = undefined;
            else if (jig === SITE_JIG) next.siteModel = undefined;
          }
        }),
    );
    try {
      const query = documentKey ? `?documentKey=${encodeURIComponent(documentKey)}` : '';
      const roles = rolesSchema.parse(await api(`${base}/compliance/roles${query}`));
      next.roles = roles;
      next.rolesError = undefined;
    } catch (error) {
      next.roles = undefined;
      next.rolesError = messageOf(error);
    }
    this.set(next);
  }
}
const stores = new Map<string, Store>();
function storeOf(projectId: string, instanceId: string) {
  const key = `${projectId}\u0000${instanceId}`;
  let store = stores.get(key);
  if (!store) stores.set(key, (store = new Store(projectId, instanceId)));
  return store;
}

export interface ComplianceView {
  read: ResultRead;
  /** The last role-check read of the document (before any check, too). */
  documentRead?: CheckRead;
  documentReadError?: string;
  documentReading: boolean;
  /** Read the document again for the roles (and before [법규 체크]); throws on failure when forced. */
  readDocument: (force?: boolean) => Promise<CheckRead | undefined>;
  /** The last [법규 체크] did not finish: why (the kept result, if any, is the one before). */
  failure?: string;
  /** The kept result no longer matches what it read (SPEC-15.13). */
  stale: boolean;
  reasons: string[];
  /** The massing work copy must be computed again first (the check would only say 사람 입력 필요). */
  limitsNeedRecompute: boolean;
  roles?: RolesState;
  rolesError?: string;
  remote: boolean;
  /** Read the sources and the classification again (after a role change). */
  refresh: () => Promise<void>;
  /** The step the result comes from (`step.check` → `check`). */
  step: string;
}

export function useCompliance({
  projectId,
  instanceId,
  jig,
  data,
  from,
  remote,
}: {
  projectId: string;
  instanceId: string;
  jig: InstanceState;
  data: PanelData;
  from: string;
  remote?: boolean;
}): ComplianceView {
  const store = storeOf(projectId, instanceId);
  const shared = useSyncExternalStore(store.subscribe, store.snapshot);
  const value = resolve(from, data);
  const read = useMemo(() => readResult(value), [value]);
  const step = from.split('.')[1] ?? '';
  const inputs = jig.view?.inputs;
  const isRemote = remote ?? remoteSession();
  const documentKey =
    (read.kind === 'ok' ? read.result.inputs.model?.documentKey : undefined) ??
    shared.read?.documentKey;
  const linkId = read.kind === 'ok' ? read.result.inputs.model?.linkId : undefined;
  const refresh = useCallback(async () => {
    await Promise.all([
      inputs ? store.refresh(inputs, documentKey) : Promise.resolve(),
      store.revision(linkId),
    ]);
  }, [store, inputs, documentKey, linkId]);
  const revision = jig.lastRun?.getTime();
  useEffect(() => {
    void refresh();
  }, [refresh, revision]);
  // Back from Rhino: the document may have changed (SPEC-15.13). Only the revision is asked.
  useEffect(() => {
    if (!linkId) return;
    const again = () => {
      if (document.visibilityState !== 'hidden') void store.revision(linkId);
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [store, linkId]);
  // The role check reads the document once when the panel opens on this PC (SPEC-15.3 1).
  const opened = !!jig.view;
  useEffect(() => {
    if (!isRemote && opened) void store.readDocument();
  }, [store, isRemote, opened]);
  // The last [법규 체크] that did not finish (SPEC-15.14): its reason; the kept result stays.
  const report = jig.reports[step];
  const failure =
    report && ['failed', 'gate-failed', 'blocked'].includes(report.status)
      ? failureText(report)
      : undefined;

  const stepStale =
    jig.stale.has(step) || jig.view?.steps.find((s) => s.id === step)?.status === 'stale';
  const reasons =
    read.kind === 'ok'
      ? staleReasons(read.result, {
          rolesVersion: shared.roles?.version,
          modelRevisionKey:
            shared.revision && shared.revision.linkId === linkId ? shared.revision.key : undefined,
          limits: shared.limits,
          siteModel: shared.siteModel,
          settingsChanged: jig.stale.has(step) || Object.keys(jig.pending).length > 0,
          stepStale,
        })
      : [];
  if (read.kind === 'ok' && failure) reasons.unshift('마지막 체크 실패 · 이전 결과');
  return {
    read,
    documentRead: shared.read,
    documentReadError: shared.readError,
    documentReading: !!shared.reading,
    readDocument: (force?: boolean) => store.readDocument(force),
    failure,
    stale: reasons.length > 0,
    reasons,
    limitsNeedRecompute: !!shared.limits?.needsRecompute,
    roles: shared.roles,
    rolesError: shared.rolesError,
    remote: isRemote,
    refresh,
    step,
  };
}

/** Why a check step did not finish, in words (SPEC-15.14). */
function failureText(report: StepReport): string {
  const code = report.error?.code;
  const message = report.error?.message ?? '';
  if (report.status === 'blocked') return '앞 단계가 끝나지 않아 체크하지 못했습니다';
  if (report.status === 'gate-failed')
    return `점검에서 멈췄습니다: ${report.gates
      .filter((g) => !g.ok)
      .map((g) => g.message)
      .join('; ')}`;
  if (code === 'BUDGET') return '계산 시간 상한을 넘었습니다 · 모델을 나눠 다시 체크하세요';
  if (code === 'SCHEMA') return '결과 형식이 맞지 않습니다';
  return message ? `체크하지 못했습니다: ${message}` : '체크하지 못했습니다';
}
