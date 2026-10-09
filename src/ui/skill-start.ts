// startSkill (RESEARCH-12 §6.3, user decision 2026-10-01): one entry point that opens a jig from
// a request, the jig list or the AI's jig_open. It reuses the project's latest instance of the jig
// (or makes one under its default output layer), opens the jig's tab, binds a conversation to the
// instance (so the AI gets jig_set/jig_run), records the start in that conversation's ledger,
// applies the values the request gives for the jig's `from_request` settings and computes up to
// the first step a person confirms (해석 확정 and Rhino에 만들기 stay the person's). In 계획 mode it
// only opens and binds; the rest waits for [진행] (continueSkill). [일반 대화로] (revertSkill)
// closes what this start opened and undoes its settings. Older jigs without instances only open.
// The screen's parts come in as `SkillDeps`, so the sequence is tested without a page.

import { addressFromRequest } from '../contracts/site-data.ts';
import { instanceRouteContext, requestValues, type RouteParam } from './request-route.ts';
import type { SkillEntry } from './skill-catalog.ts';

export type SkillMode = 'auto' | 'plan';
export type SkillBy = 'rules' | 'jev' | 'user' | 'ai';
export interface SkillTab {
  instanceId: string;
  label: string;
  title?: string;
}
export interface SkillRunReport {
  steps: { id: string; kind?: string; status: string; cached?: boolean }[];
  blocked?: boolean;
  superseded?: boolean;
}
export interface SkillDeps {
  api: (path: string, method?: string, data?: unknown) => Promise<unknown>;
  projectId: () => string;
  /** The project's skill catalog (GET /projects/:id/skills), in routing order. */
  catalog: () => Promise<readonly SkillEntry[]>;
  openTab: (tab: SkillTab) => void;
  closeTab: (instanceId: string) => void;
  isTabOpen: (instanceId: string) => boolean;
  /** The tab of an older jig (`legacy:<id>`), or undefined when there is none. */
  legacyTab: (jigId: string) => SkillTab | undefined;
  /** How the jig's panel runs when nothing names the mode (src/ui/jig-panel/instance.ts). */
  preferRun: (
    instanceId: string,
    preference: { mode: 'confirmed'; until?: string } | undefined,
  ) => void;
  /** Tell an open panel of the instance to read it again and run (its settings changed). */
  paramsChanged: (instanceId: string) => void;
  /**
   * The next run of the instance's panel: its report, `undefined` when no panel started a run
   * within `startMs` (the start then runs it itself), or throws the run's error.
   */
  waitForRun: (instanceId: string, startMs: number) => Promise<SkillRunReport | undefined>;
  conversations: {
    /** The conversation the composer sends to (null = the project's default one). */
    active: () => string | null | undefined;
    select: (id: string | null) => void;
    refresh: () => Promise<void>;
  };
  /** The service and model the composer names for a new conversation (none = Jev chooses). */
  model?: () => { provider?: string; model?: string } | undefined;
}
export interface SkillStartOptions {
  mode: SkillMode;
  /** The request's words: values for `from_request` settings, and the AI turn after the start. */
  request?: string;
  by?: SkillBy;
  /** Open this instance (the jig list's row) instead of the latest one. */
  instanceId?: string;
  reuse?: 'last' | 'new';
  /** Bind this conversation (the AI's own, for jig_open) instead of finding or making one. */
  conversationId?: string;
  /** The person's [열기] on the JIG list: open and bind only (no values, no computation). */
  openOnly?: boolean;
}
export interface SkillValue {
  key: string;
  title: string;
  text: string;
  value?: number | string | boolean;
  ok: boolean;
}
export interface SkillStart {
  jigId: string;
  name: string;
  by: SkillBy;
  mode: SkillMode;
  legacy: boolean;
  instanceId: string;
  instanceTitle: string;
  created: boolean;
  /** The tab was not open before this start ([일반 대화로] closes it). */
  openedTab: boolean;
  conversationId: string | null;
  conversationCreated: boolean;
  /**
   * This start bound a conversation that was on no jig before (the empty tab of [+]): [일반 대화로]
   * unbinds it again, so the words it sends there go to an ordinary turn without jig tools.
   */
  boundExisting: boolean;
  /** The conversation the composer sent to before this start (the way back). */
  previousConversation: string | null | undefined;
  /** Values read from the request: applied in 자동, proposed in 계획. */
  values: SkillValue[];
  /** Param log seqs of the applied values (their undo). */
  seqs: number[];
  /** The step the computation runs until (none: every step no person waits on). */
  until?: string;
  untilTitle?: string;
  /** 계획: opened and bound; values and the computation wait for [진행]. */
  pending: boolean;
  /** 계획 with no instance of the jig yet: 작업본 만들기 is the first step of [진행]. */
  needsInstance?: boolean;
  report?: SkillRunReport;
  /** The AI turn sent after the computation (the screen sets it). */
  aiRequest?: string;
  /** What the computation left for a person (human steps waiting, failures). */
  summary?: { done: number; waiting: string[]; failed: string[] };
  /** Steps a person presses that the computation left (a `manual` step such as '법규 체크'). */
  left?: string[];
  /**
   * The address looked up for a jig with a `site-data` input (SPEC-12.3의 6): the one the request
   * names, else the project's known site address (the latest workbook whose target a person
   * confirmed). The project name is never taken for an address.
   */
  site?: { key: string; query: string; from: 'request' | 'project' };
  /** No address anywhere: the panel asks in the input's address card (the input key). */
  siteAsk?: string;
}

const code = (error: unknown) => (error as { code?: unknown } | null)?.code;
const skillError = (value: string) => Object.assign(new Error(value), { code: value });
const path = (deps: SkillDeps, rest = '') =>
  `/projects/${encodeURIComponent(deps.projectId())}${rest}`;

interface InstanceRow {
  id: string;
  jigId: string;
  title: string;
  updatedAt?: string;
  createdAt?: string;
}
interface SiteState {
  query?: string | null;
  targets?: { pnus?: string[]; by?: string } | null;
}
interface InstanceView {
  id: string;
  title: string;
  jig: { id: string; name: string; version?: string };
  params?: unknown;
  steps?: { id: string; title?: string; kind?: string; status?: string }[];
  inputs?: { key: string; kind?: string }[];
  body?: { siteData?: Record<string, SiteState> };
}
interface ConversationRow {
  id: string | null;
  kind?: string;
  state?: string;
  jigInstanceId?: string | null;
  requests?: number;
}

async function instances(deps: SkillDeps, jigId: string) {
  const reply = (await deps.api(path(deps, '/jig-instances'))) as { instances?: InstanceRow[] };
  return (reply?.instances ?? []).filter((row) => row.jigId === jigId);
}
const newestFirst = (rows: readonly InstanceRow[]) =>
  [...rows].sort((a, b) =>
    String(b.updatedAt ?? b.createdAt ?? '').localeCompare(
      String(a.updatedAt ?? a.createdAt ?? ''),
    ),
  );
const latest = (rows: readonly InstanceRow[]) => newestFirst(rows)[0];

/** A workbook's site address when a person confirmed its target parcels (else null). */
function confirmedSiteAddress(view: InstanceView, key: string): string | null {
  const state = view.body?.siteData?.[key];
  const pnus = state?.targets?.pnus ?? [];
  if (!pnus.length) return null;
  const confirmed =
    state?.targets?.by === 'user' ||
    (view.steps ?? []).some((step) => step.kind === 'human' && step.status === 'confirmed');
  if (!confirmed) return null;
  return state?.query?.trim() || pnus[0];
}

/**
 * ② of SPEC-12.3의 6: the project's known site address — the latest other workbook of the same
 * jig whose target parcels a person confirmed (project facts hold no address statement today).
 */
async function projectSiteAddress(deps: SkillDeps, jigId: string, except: string, key: string) {
  const rows = newestFirst(await instances(deps, jigId)).filter((row) => row.id !== except);
  for (const row of rows.slice(0, 10)) {
    const view = (await deps
      .api(path(deps, `/jig-instances/${encodeURIComponent(row.id)}`))
      .catch(() => undefined)) as InstanceView | undefined;
    const address = view && confirmedSiteAddress(view, key);
    if (address) return address;
  }
  return null;
}

/** The conversation the jig works in: the given one, one already on the instance, or a new one. */
async function bindConversation(
  deps: SkillDeps,
  entry: SkillEntry,
  instanceId: string,
  options: Pick<SkillStartOptions, 'request' | 'conversationId'>,
): Promise<{ id: string; created: boolean; bound: boolean }> {
  const bind = async (id: string, bound = false) => {
    await deps.api(path(deps, `/conversations/${encodeURIComponent(id)}/bind`), 'POST', {
      jigInstanceId: instanceId,
    });
    return { id, created: false, bound };
  };
  if (options.conversationId) {
    try {
      return await bind(options.conversationId);
    } catch (error) {
      if (code(error) !== 'CONVERSATION_BOUND') throw error;
    }
  }
  const list = ((await deps.api(path(deps, '/conversations'))) as ConversationRow[] | null) ?? [];
  const open = list.filter((row) => row.id && row.state !== 'closed');
  const already = open.find((row) => row.jigInstanceId === instanceId);
  if (already?.id) return { id: already.id, created: false, bound: false };
  // A new general conversation with nothing in it yet takes the jig (no empty conversation left).
  const active = deps.conversations.active();
  const fresh = open.find(
    (row) =>
      row.id === active &&
      !row.jigInstanceId &&
      (row.requests ?? 0) === 0 &&
      (row.kind === 'general' || row.kind === 'jig-run'),
  );
  if (fresh?.id) return bind(fresh.id, true);
  const model = deps.model?.();
  const made = (await deps.api(path(deps, '/conversations'), 'POST', {
    kind: 'jig-run',
    title: entry.name.slice(0, 60),
    body: options.request?.trim() || entry.name,
    jigInstanceId: instanceId,
    ...(model?.provider ? { provider: model.provider } : {}),
    ...(model?.provider && model.model ? { model: model.model } : {}),
  })) as { id?: string };
  if (!made?.id) throw skillError('INVALID_PROVIDER_OUTPUT');
  return { id: made.id, created: true, bound: false };
}

/** The values the request gives for the jig's `from_request` settings, read against its view. */
export function skillValues(
  request: string | undefined,
  params: unknown,
  keys: readonly string[],
): SkillValue[] {
  if (!request?.trim() || !keys.length) return [];
  const context = instanceRouteContext(params);
  return requestValues(request, context.params as RouteParam[], context.values, keys).map(
    (entry) => ({
      key: entry.key,
      title: entry.title,
      text: entry.change.text,
      ok: entry.change.ok,
      ...(entry.change.ok ? { value: entry.change.value } : {}),
    }),
  );
}

function summarize(report: SkillRunReport | undefined, titles: Map<string, string>) {
  if (!report) return undefined;
  const name = (id: string) => titles.get(id) ?? id;
  return {
    done: report.steps.filter((step) => step.status === 'done').length,
    waiting: report.steps
      .filter((step) => ['waiting', 'reconfirm'].includes(step.status) && step.kind === 'human')
      .map((step) => name(step.id)),
    failed: report.steps
      .filter((step) => ['failed', 'gate-failed'].includes(step.status))
      .map((step) => name(step.id)),
  };
}

/**
 * Steps a person presses next (SPEC-02.17 2): a `manual` step the run left (`skipped`, e.g.
 * '법규 체크') and a host step that is due ('Rhino에 만들기'). Confirmed human steps, steps blocked
 * behind a waiting one and a superseded run's skips are not left for a press.
 */
export function leftSteps(report: SkillRunReport | undefined, titles: Map<string, string>) {
  if (!report) return undefined;
  return report.steps
    .filter(
      (step) =>
        (step.status === 'skipped' && !report.superseded) ||
        (step.status === 'waiting' && step.kind === 'host'),
    )
    .map((step) => titles.get(step.id) ?? step.id);
}

/**
 * The route row's status once the AI turn after a start has ended (SPEC-02.17 2, T-272): the
 * turn's end and the work copy's state, so the row never stays at 'AI가 요약하는 중'. undefined
 * while the turn is still queued or running.
 */
export function skillTurnStatus(state: string, start: SkillStart | undefined): string | undefined {
  if (state === 'queued' || state === 'running') return undefined;
  const turn =
    state === 'succeeded'
      ? '응답 완료'
      : state === 'cancelled' || state === 'interrupted'
        ? '응답 중단'
        : '응답 실패';
  if (!start || start.legacy) return `${turn} · 열림`;
  const parts = [turn, `작업본 '${start.instanceTitle}' 열림`];
  for (const title of start.left ?? []) parts.push(`'${title}' 전`);
  return parts.join(' · ');
}

/** Record in the conversation's ledger (SPEC-02.19 1); a failure never stops the start. */
async function record(deps: SkillDeps, conversationId: string | null, body: unknown) {
  if (!conversationId) return;
  try {
    await deps.api(
      path(deps, `/conversations/${encodeURIComponent(conversationId)}/ledger`),
      'POST',
      {
        kind: 'result-ref',
        body,
      },
    );
  } catch {
    /* The ledger is a record; the jig is open either way. */
  }
}

/**
 * Open a jig from the catalog (see the module comment). Throws NOT_FOUND for an unknown jig and
 * JIG_USER_ONLY when the router or the AI starts a `user-only` jig.
 */
export async function startSkill(
  deps: SkillDeps,
  jigId: string,
  options: SkillStartOptions,
): Promise<SkillStart> {
  const by = options.by ?? 'user';
  const entry = (await deps.catalog()).find((skill) => skill.id === jigId);
  if (!entry) throw skillError('NOT_FOUND');
  if (entry.invocation === 'user-only' && by !== 'user') throw skillError('JIG_USER_ONLY');
  const previousConversation = deps.conversations.active();
  const base = {
    jigId,
    name: entry.name,
    by,
    mode: options.mode,
    previousConversation,
    boundExisting: false,
    values: [] as SkillValue[],
    seqs: [] as number[],
  };
  // An older jig screen: open it as it is (no instance, settings or conversation to bind).
  if (entry.kind === 'legacy') {
    const tab = deps.legacyTab(jigId);
    if (!tab) throw skillError('NOT_FOUND');
    const openedTab = !deps.isTabOpen(tab.instanceId);
    deps.openTab(tab);
    const conversationId = previousConversation ?? null;
    await record(deps, conversationId, { appAction: 'skill_open', jigId, by, legacy: true });
    return {
      ...base,
      legacy: true,
      instanceId: tab.instanceId,
      instanceTitle: tab.label,
      created: false,
      openedTab,
      conversationId,
      conversationCreated: false,
      pending: false,
    };
  }

  // 1 The instance: the named one, or the latest one (open.reuse = last).
  let instanceId = options.instanceId;
  if (!instanceId && (options.reuse ?? entry.open.reuse) === 'last')
    instanceId = latest(await instances(deps, jigId))?.id;
  const start: SkillStart = {
    ...base,
    legacy: false,
    instanceId: instanceId ?? '',
    instanceTitle: '',
    created: false,
    openedTab: false,
    conversationId: null,
    conversationCreated: false,
    ...(entry.autorun.step ? { until: entry.autorun.step } : {}),
    pending: options.mode === 'plan' && !options.openOnly,
    needsInstance: !instanceId,
  };
  // 계획 without an instance (ADR-026): nothing is made; 작업본 만들기 waits for [진행].
  if (start.pending && start.needsInstance) {
    await record(deps, previousConversation ?? null, {
      appAction: 'skill_open',
      jigId,
      by,
      mode: 'plan',
      needsInstance: true,
    });
    return start;
  }
  const titles = await open(deps, entry, start, options);
  if (options.openOnly) {
    await record(deps, start.conversationId, {
      appAction: 'skill_open',
      jigId,
      instanceId: start.instanceId,
      created: start.created,
      by,
    });
    return start;
  }
  if (start.pending) {
    await record(deps, start.conversationId, {
      appAction: 'skill_open',
      jigId,
      instanceId: start.instanceId,
      created: false,
      by,
      mode: 'plan',
      proposed: start.values.filter((value) => value.ok).map(({ key, value }) => ({ key, value })),
    });
    return start;
  }
  return run(deps, start, titles);
}

/**
 * 1–3 of the start: make the instance when there is none (no output layer yet: it is asked at
 * Rhino에 만들기, ADR-026), read it, bind a conversation (before the tab shows, so the jig's chip
 * is the one the composer sends to) and open the tab.
 */
async function open(
  deps: SkillDeps,
  entry: SkillEntry,
  start: SkillStart,
  options: Pick<SkillStartOptions, 'request' | 'conversationId' | 'openOnly'>,
) {
  if (!start.instanceId) {
    const n = (await instances(deps, entry.id)).length + 1;
    const made = (await deps.api(path(deps, '/jig-instances'), 'POST', {
      jig: entry.id,
      ...(entry.version ? { version: entry.version } : {}),
      title: `작업본 ${n}`,
      layerRootLater: true,
    })) as InstanceView;
    start.instanceId = made.id;
    start.created = true;
    start.needsInstance = false;
  }
  const view = (await deps.api(
    path(deps, `/jig-instances/${encodeURIComponent(start.instanceId)}`),
  )) as InstanceView;
  const titles = new Map((view.steps ?? []).map((step) => [step.id, step.title ?? step.id]));
  start.instanceTitle = view.title;
  if (start.until) start.untilTitle = titles.get(start.until) ?? start.until;
  start.values = skillValues(options.request, view.params, entry.fromRequest);
  // Site modeling (SPEC-12.3의 6): ① the address in the words, ② the project's known site address,
  // ③ ask in the panel's address card. It is looked up as the computation starts.
  const siteInput = (view.inputs ?? []).find((input) => input.kind === 'site-data');
  if (siteInput) {
    const key = siteInput.key;
    const named = options.request ? addressFromRequest(options.request) : null;
    const own = view.body?.siteData?.[key];
    if (named) start.site = { key, query: named, from: 'request' };
    else if (!own?.query && !own?.targets?.pnus?.length) {
      const known = await projectSiteAddress(deps, entry.id, start.instanceId, key);
      if (known) start.site = { key, query: known, from: 'project' };
      else start.siteAsk = key;
    }
  }
  const conversation = await bindConversation(deps, entry, start.instanceId, options);
  start.conversationId = conversation.id;
  start.conversationCreated = conversation.created;
  start.boundExisting = conversation.bound;
  // The chips read the list again first, so the new conversation is known when it is chosen.
  await deps.conversations.refresh().catch(() => {});
  deps.conversations.select(conversation.id);
  start.openedTab = !deps.isTabOpen(start.instanceId);
  // In 자동 the panel computes up to the checkpoint as it opens; in 계획 it shows as it is.
  if (!start.pending && !options.openOnly)
    deps.preferRun(start.instanceId, {
      mode: 'confirmed',
      ...(start.until ? { until: start.until } : {}),
    });
  deps.openTab({
    instanceId: start.instanceId,
    label: view.title,
    title: `${view.jig.name} · ${view.title}`,
  });
  return titles;
}

/** 자동 (or [진행] in 계획): apply the request's values, compute, record the start. */
async function run(
  deps: SkillDeps,
  start: SkillStart,
  titles: Map<string, string>,
  /** The tab opened just now: its panel's first run is the computation. */
  fresh = start.openedTab,
) {
  const instance = path(deps, `/jig-instances/${encodeURIComponent(start.instanceId)}`);
  const values = start.values.filter((value) => value.ok && value.value !== undefined);
  // The address the request named: candidates for the first person step (or the send notice).
  if (start.site)
    await deps
      .api(`${instance}/site-data/${encodeURIComponent(start.site.key)}/lookup`, 'POST', {
        query: start.site.query,
      })
      .catch(() => undefined);
  if (values.length) {
    const done = (await deps.api(`${instance}/params`, 'PUT', {
      values: values.map(({ key, value }) => ({ key, value })),
      by: 'user',
      reason: '요청 입력',
    })) as { seqs?: unknown };
    start.seqs = Array.isArray(done?.seqs)
      ? done.seqs.map(Number).filter((seq) => Number.isInteger(seq) && seq > 0)
      : [];
  }
  deps.preferRun(start.instanceId, {
    mode: 'confirmed',
    ...(start.until ? { until: start.until } : {}),
  });
  // The panel runs as it opens; an open panel runs again when told its settings changed.
  const waiting = deps.waitForRun(start.instanceId, 4000);
  if (!fresh || values.length) deps.paramsChanged(start.instanceId);
  let report = await waiting;
  // No panel ran it (no declared panel, or the tab could not show): run it here.
  report ??= (await deps.api(`${instance}/run`, 'POST', {
    mode: 'confirmed',
    ...(start.until ? { until: start.until } : {}),
  })) as SkillRunReport;
  start.report = report;
  start.summary = summarize(report, titles);
  start.left = leftSteps(report, titles);
  start.pending = false;
  await record(deps, start.conversationId, {
    appAction: 'skill_start',
    jigId: start.jigId,
    jigName: start.name,
    instanceId: start.instanceId,
    created: start.created,
    by: start.by,
    mode: start.mode,
    applied: values.map(({ key, title, text }) => ({ key, title, text })),
    ...(start.values.some((value) => !value.ok)
      ? {
          notApplied: start.values
            .filter((value) => !value.ok)
            .map(({ key, text }) => ({ key, text })),
        }
      : {}),
    until: start.until ?? null,
    ...(start.site ? { siteQuery: start.site.query, siteQueryFrom: start.site.from } : {}),
    ...(start.siteAsk
      ? { siteAsk: '대지 주소나 PNU를 jig 화면 맨 위 대상 필지 칸에 넣어 주세요' }
      : {}),
    computed: start.summary,
  });
  return start;
}

/**
 * [진행] of a 계획 start: the instance when there was none (made, read, bound, shown), then the
 * values it proposed, the computation and the record.
 */
export async function continueSkill(
  deps: SkillDeps,
  start: SkillStart,
  request?: string,
): Promise<SkillStart> {
  if (!start.pending || start.legacy) return start;
  const entry = (await deps.catalog()).find((skill) => skill.id === start.jigId);
  if (!entry) throw skillError('NOT_FOUND');
  start.pending = false;
  if (start.needsInstance) {
    const titles = await open(deps, entry, start, { request });
    return run(deps, start, titles, true);
  }
  const view = (await deps.api(
    path(deps, `/jig-instances/${encodeURIComponent(start.instanceId)}`),
  )) as InstanceView;
  const titles = new Map((view.steps ?? []).map((step) => [step.id, step.title ?? step.id]));
  // The tab shows already: its panel runs again when told.
  return run(deps, start, titles, false);
}

/**
 * [일반 대화로]: close the tab this start opened, undo its settings (newest first), stop the
 * preference, close the conversation it made or unbind the one it bound, give the composer its
 * conversation back and count the reversal (never the words).
 */
export async function revertSkill(deps: SkillDeps, start: SkillStart) {
  deps.preferRun(start.instanceId, undefined);
  if (start.openedTab) deps.closeTab(start.instanceId);
  const instance = path(deps, `/jig-instances/${encodeURIComponent(start.instanceId)}`);
  for (const seq of [...start.seqs].reverse())
    await deps.api(`${instance}/params/undo`, 'POST', { seq }).catch(() => undefined);
  if (start.seqs.length) deps.paramsChanged(start.instanceId);
  if (start.conversationCreated && start.conversationId)
    await deps
      .api(
        path(deps, `/conversations/${encodeURIComponent(start.conversationId)}/close`),
        'POST',
        {},
      )
      .catch(() => undefined);
  // The conversation this start bound (it was on no jig): unbound, so the words go to it as an
  // ordinary turn (SPEC-02.17 3) without jig_set/jig_run on the instance just backed out of.
  if (start.boundExisting && start.conversationId)
    await deps
      .api(
        path(deps, `/conversations/${encodeURIComponent(start.conversationId)}/unbind`),
        'POST',
        { jigInstanceId: start.instanceId },
      )
      .catch(() => undefined);
  await record(deps, start.conversationCreated ? null : start.conversationId, {
    appAction: 'skill_revert',
    jigId: start.jigId,
    instanceId: start.instanceId,
  });
  deps.conversations.select(start.previousConversation ?? null);
  void deps.conversations.refresh().catch(() => {});
  await deps
    .api(path(deps, '/route/revert'), 'POST', {
      target: 'jig',
      by: start.by === 'jev' ? 'jev' : 'rules',
    })
    .catch(() => undefined);
}

/** The route row's checklist in 계획 (and what 자동 did), one line each. */
export function skillChecklist(start: SkillStart): { text: string; done: boolean }[] {
  if (start.legacy) return [{ text: `${start.name} 열기`, done: true }];
  const items = start.needsInstance
    ? [
        { text: '작업본 만들기 (출력 레이어는 Rhino에 만들 때 정함)', done: false },
        { text: '이 jig의 대화에 연결', done: false },
      ]
    : [
        {
          text: `${start.created ? '새 작업본' : '작업본'} '${start.instanceTitle}' 열기`,
          done: true,
        },
        { text: '이 jig의 대화에 연결', done: true },
      ];
  for (const value of start.values)
    items.push({
      text: value.ok ? `설정값 ${value.text}` : value.text,
      done: !start.pending && value.ok,
    });
  if (start.site)
    items.push({
      text: `대지 주소 '${start.site.query}'(${start.site.from === 'request' ? '요청 글' : '프로젝트에서 확정한 주소'})로 필지 찾기`,
      done: !start.pending && !!start.report,
    });
  else if (start.siteAsk)
    items.push({
      text: '대지 주소 입력 — jig 화면 맨 위 대상 필지 칸에 주소나 PNU를 넣으세요',
      done: false,
    });
  items.push({
    text: start.untilTitle ? `'${start.untilTitle}' 앞까지 계산` : '사람 확인 전까지 계산',
    done: !start.pending && !!start.report,
  });
  items.push({ text: 'AI가 결과를 요약하고 모호한 입력을 묻기', done: !!start.aiRequest });
  return items;
}

// The screen registers its parts once (app.ts); the JIG list opens jigs through them.
let provided: SkillDeps | undefined;
export function provideSkillDeps(deps: SkillDeps | undefined) {
  provided = deps;
}
/** startSkill with the screen's parts; undefined before the screen registered them. */
export function openSkill(jigId: string, options: SkillStartOptions) {
  return provided ? startSkill(provided, jigId, options) : undefined;
}
