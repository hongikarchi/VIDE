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
import { messageOf, type InstanceState } from '../jig-panel/instance.ts';
import { readResult, staleReasons, type ResultRead, type SourceNow } from './model.ts';

// What the 법규 체크 parts share (SPEC-15.13, Design SCR-32): the result of the `check` step, the
// earlier results the instance reads now (`…/jig-outputs/:key`, as the `jig-source` cards read
// them), the project's classification records and AI proposals (`…/compliance/roles`, ARCH-03
// §8.6, T-237), and from those whether the kept result is '다시 체크 필요' and why. One store per
// instance so the four parts on screen ask the engine once; it reads again after each run and after
// a classification change, never on a timer, and never runs the check itself.

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

interface Shared {
  limits?: SourceNow | null;
  siteModel?: SourceNow | null;
  roles?: RolesState;
  rolesError?: string;
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
  const documentKey = read.kind === 'ok' ? read.result.inputs.model?.documentKey : undefined;
  const refresh = useCallback(
    () => (inputs ? store.refresh(inputs, documentKey) : Promise.resolve()),
    [store, inputs, documentKey],
  );
  const revision = jig.lastRun?.getTime();
  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  const stepStale =
    jig.stale.has(step) || jig.view?.steps.find((s) => s.id === step)?.status === 'stale';
  const reasons =
    read.kind === 'ok'
      ? staleReasons(read.result, {
          rolesVersion: shared.roles?.version,
          limits: shared.limits,
          siteModel: shared.siteModel,
          settingsChanged: jig.stale.has(step) || Object.keys(jig.pending).length > 0,
          stepStale,
        })
      : [];
  return {
    read,
    stale: reasons.length > 0,
    reasons,
    limitsNeedRecompute: !!shared.limits?.needsRecompute,
    roles: shared.roles,
    rolesError: shared.rolesError,
    remote: remote ?? remoteSession(),
    refresh,
    step,
  };
}
