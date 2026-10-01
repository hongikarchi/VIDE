import {
  CONTEXT_LIMIT,
  selectContext,
  type ContextCandidate,
  type ContextChoice,
} from '../ai/context-selector.ts';
import { isDwgSdkEditMode } from '../contracts/dwg-edit-mode.ts';
import type { AccountProfiles } from '../ai/account-profiles.ts';
import { executionLimits } from '../contracts/execution-limits.ts';
import { modelContext } from './model-context.ts';
import { CLAUDE_MODELS, claudeEfforts, modelName } from './model-capabilities.ts';
import { hostUse, waitingOf } from '../contracts/request-scope.ts';
import { z } from 'zod';
import { runLinked } from './linked-execution.ts';
// Jig review gates (sync-review rows, structure-draft-review members/nodes; SPEC-06.9).
import { factCitations, jigCheck } from './jig-gates.ts';
import { conversationHandlers, conversationSources, type AgentTools } from './agent-tools.ts';
import type { Workspace } from '../core/workspace.ts';
import type { StoredWork } from '../contracts/stored-work.ts';
import type { RequestInput } from '../contracts/workspace.ts';
import type {
  CliOptions,
  NativeQuestionAnswer,
  NativeQuestionCard,
  NativeQuestionHandler,
  ProviderContext,
  Progress,
  ProviderStatus,
  SessionOptions,
} from '../ai/claude-cli.ts';
import type { GeometryObject } from '../core/geometry.ts';
import type { SdkExecution } from './sdk-execution.ts';
import type { ZwcadSdkExecution } from './zwcad-sdk-execution.ts';
import type { ConversationService, Turn } from './conversations.ts';
import { turnOutputResult } from './turn-output.ts';
import { makeTurnResult } from './make-routes.ts';
import { workspaceResultSchema } from '../contracts/workspace-result.ts';
import { bakeJobOf } from '../jigs/bake/bake.ts';
// Plan / Auto and direct execution in the attached document (ADR-022).
import { requestMode, withMode } from '../contracts/workspace.ts';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../contracts/errors.ts';
import { hostTargetSchema } from '../contracts/host-documents.ts';
import {
  DIRECT_MAX_DELETES,
  continueBody,
  documentAfter,
  hostLeftUnknown,
  displayQuery,
  executionsOf,
  publicRecord,
  runDirectTurn,
  takePlan,
  PLAN_RULES,
  type DirectDriver,
  type ExecutionRecord,
} from './direct-mode.ts';
import { directRefusal } from '../contracts/direct-refusal.ts';
interface Provider {
  run(
    context: ProviderContext,
    options: { signal: AbortSignal; onProgress: (event: Progress) => void },
  ): Promise<{ text: string; [key: string]: unknown }>;
  status(): Promise<ProviderStatus>;
  /** The CLI version a conversation session is recorded with (CLI providers). */
  checkVersion?(): Promise<string>;
}
interface Host {
  build(
    projectId: string,
    id: string,
    objects: GeometryObject[],
    previous?: Record<string, unknown>,
  ): Promise<unknown>;
}
interface Options {
  applyAttached?: (
    request: StoredWork,
    result: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>;
  profiles?: AccountProfiles;
  tools?: AgentTools;
  providerFactory?: (options: CliOptions & { provider: string }) => Provider;
  host?: Host;
  hosts?: Partial<Record<'rhino' | 'zwcad', Host>>;
  settings?: { get: () => { paths: Partial<Record<string, string | null>> } };
  sdk?: SdkExecution;
  zwcadSdk?: ZwcadSdkExecution;
  /** A request stopped on its account's subscription limit (so the next one can switch). */
  onProviderLimit?: (provider: string, accountProfileId: string) => void;
  /** Start/end, duration and failure code of every run (diagnostic log). */
  diagnostics?: Diagnostics;
  /** Which earlier exchanges go with a request (Jev when a key is set; else the last six). */
  selectContext?: (body: string, candidates: ContextCandidate[]) => Promise<ContextChoice>;
  /** Conversations (SPEC-02.19): session per turn, ledger, one running turn per conversation. */
  conversations?: ConversationService;
  /** The project's addendum to the instruction bundle (PLAN-24 지침 묶음). */
  projectInstructions?: (projectId: string) => string;
  /**
   * The attached document a direct turn writes to (ADR-022); default: the Rhino editor connection
   * of `sdk`. Undefined when the basis is not an attached document (tests inject a mock host).
   */
  directDriver?: (host: 'rhino' | 'zwcad', sourceDocument: unknown) => DirectDriver | undefined;
}
const pinsSchema = z.array(
  z
    .object({
      id: z.string(),
      basis: z.string(),
      role: z.enum(['target', 'preserve', 'reference']),
    })
    .passthrough(),
);
const executionResultSchema = workspaceResultSchema.extend({
  referenceOnly: z.boolean().optional(),
});
const errorSchema = z
  .object({ code: z.string().optional(), intent: z.record(z.string(), z.unknown()).optional() })
  .passthrough();
const errorData = (cause: unknown) => errorSchema.safeParse(cause).data ?? {};

import { installedCodex } from '../ai/paths.ts';
import { createProvider } from '../ai/providers.ts';
import {
  CodexAppServer,
  closeCodexAppServers,
  codexAppServerEnabled,
} from '../ai/codex-app-server.ts';
import type { InstructionHost, InstructionMode } from '../ai/instructions/index.ts';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { geometryContract, interpret, protectGeometry } from '../core/geometry.ts';
import { Diagnostics, requestStages, type RunMarks } from './diagnostics.ts';
import { clearAuthStatus } from '../ai/claude-cli.ts';

/**
 * The project read tools a host modeling turn gets beside its host tools (SPEC-02.6): linked
 * files' layers, Sync samples and the project facts. They read VIDE's own records, never a host.
 */
export const HOST_TURN_PROJECT_TOOLS = [
  'links_layers',
  'sync_sample',
  'project_brief',
  'project_search',
  'project_issue',
  'project_statement',
  'project_checks',
] as const;
/**
 * The handlers of HOST_TURN_PROJECT_TOOLS for a turn of `conversation`, to spread into a host
 * scope's handler list (the host's own handlers win on a name clash).
 */
export function hostTurnProjectHandlers(
  workspace: Workspace,
  conversation: Parameters<typeof conversationSources>[1],
  requestId?: string,
) {
  const all = conversationHandlers(conversationSources(workspace, conversation, { requestId }));
  return Object.fromEntries(
    HOST_TURN_PROJECT_TOOLS.flatMap((name) => (all[name] ? [[name, all[name]]] : [])),
  ) as Pick<ReturnType<typeof conversationHandlers>, (typeof HOST_TURN_PROJECT_TOOLS)[number]>;
}

/** Claude's AskUserQuestion on the question cards: on unless VIDE_NATIVE_QUESTIONS=0. */
export const nativeQuestionsEnabled = () => process.env.VIDE_NATIVE_QUESTIONS !== '0';

export class Execution {
  workspace: Workspace;
  applyAttached?: Options['applyAttached'];
  onProviderLimit?: Options['onProviderLimit'];
  profiles?: AccountProfiles;
  providerFactory: NonNullable<Options['providerFactory']>;
  host?: Host;
  hosts: Partial<Record<'rhino' | 'zwcad', Host>>;
  settings?: Options['settings'];
  sdk?: SdkExecution;
  zwcadSdk?: ZwcadSdkExecution;
  tools?: AgentTools;
  diagnostics?: Diagnostics;
  selectContext: NonNullable<Options['selectContext']>;
  conversations?: ConversationService;
  projectInstructions?: Options['projectInstructions'];
  private injectedDirect?: Options['directDriver'];
  /**
   * Questions a Claude turn asks with its own AskUserQuestion tool (ADR-026 4, SPIKE-2026-09-30-
   * native-questions-claude), waiting for the person's answer in the same run: request id → cards.
   */
  private readonly nativeQuestions = new Map<
    string,
    {
      projectId: string;
      cards: NativeQuestionCard[];
      answer: (answers: NativeQuestionAnswer[] | null) => void;
    }
  >();
  /** Step times of the running requests (the `request-stages` diagnostic line). */
  private readonly marks = new Map<
    string,
    RunMarks & { source?: { timing?: RunMarks['provider'] } }
  >();
  active = new Map<
    string,
    { controller: AbortController; completion: Promise<void>; projectId: string }
  >();
  constructor(
    workspace: Workspace,
    {
      providerFactory = createProvider,
      host,
      hosts,
      settings,
      sdk,
      zwcadSdk,
      tools,
      profiles,
      applyAttached,
      onProviderLimit,
      diagnostics,
      conversations,
      projectInstructions,
      directDriver,
      selectContext: choose = (body, candidates) =>
        selectContext(body, candidates, { key: () => '' }),
    }: Options = {},
  ) {
    this.injectedDirect = directDriver;
    this.workspace = workspace;
    this.onProviderLimit = onProviderLimit;
    this.applyAttached = applyAttached;
    this.profiles = profiles;
    this.providerFactory = providerFactory;
    this.host = host;
    this.active = new Map();
    this.hosts = hosts || { rhino: host };
    this.settings = settings;
    this.sdk = sdk;
    this.zwcadSdk = zwcadSdk;
    this.tools = tools;
    this.diagnostics = diagnostics;
    this.selectContext = choose;
    this.conversations = conversations;
    this.projectInstructions = projectInstructions;
  }
  executable(provider: string) {
    return (
      this.settings?.get().paths[provider] ||
      (provider === 'claude-cli'
        ? process.env.VIDE_CLAUDE_PATH || join(homedir(), '.local', 'bin', 'claude.exe')
        : process.env.VIDE_CODEX_PATH || installedCodex())
    );
  }
  provider(
    input: Pick<
      RequestInput,
      // conversationId: a conversation turn takes the wider turn limits (SPEC-02.6).
      'provider' | 'model' | 'effort' | 'accountProfileId' | 'executionLimits' | 'conversationId'
    >,
    agent?: unknown,
    session?: SessionOptions,
    /** The instruction bundle's mode, the project whose addendum it carries, and its host. */
    instructions?: { mode: InstructionMode; projectId: string; host?: InstructionHost },
    /** Claude's own question tool, answered on the question cards (conversation turns). */
    nativeQuestions?: NativeQuestionHandler,
  ) {
    const executable = this.executable(input.provider);
    // Flag (SPIKE-2026-09-30-codex-app-server): Codex through `codex app-server` instead of
    // `codex exec`; only replaces the default factory (tests keep their injected one).
    const factory =
      input.provider === 'codex-cli' &&
      codexAppServerEnabled() &&
      this.providerFactory === createProvider
        ? (options: CliOptions) => new CodexAppServer(options)
        : this.providerFactory;
    return factory({
      provider: input.provider,
      executable,
      session,
      configDirectory:
        input.provider !== 'extension'
          ? this.profiles?.directory(
              input.provider,
              input.accountProfileId ?? this.profiles.list().active[input.provider],
            )
          : undefined,
      timeoutMs: executionLimits(input).timeoutSeconds * 1000,
      agent,
      model: input.model && input.model !== input.provider ? input.model : undefined,
      effort: input.effort && input.effort !== 'default' ? input.effort : undefined,
      ...(instructions
        ? {
            instructionMode: instructions.mode,
            instructionHost: instructions.host,
            projectInstructions: this.projectInstructions?.(instructions.projectId),
          }
        : {}),
      ...(nativeQuestions && input.provider === 'claude-cli' ? { nativeQuestions } : {}),
    });
  }
  /**
   * The handler of one turn's native questions: the cards go on the request (phase `question`,
   * shown on the question cards) until the person answers (`answerQuestions`) or the turn stops.
   */
  private questionHandler(projectId: string, requestId: string): NativeQuestionHandler {
    return (cards, signal) =>
      new Promise((resolve) => {
        const done = (answers: NativeQuestionAnswer[] | null) => {
          if (this.nativeQuestions.get(requestId)?.answer !== done) return;
          this.nativeQuestions.delete(requestId);
          signal.removeEventListener('abort', stop);
          try {
            this.workspace.update(projectId, requestId, 'running', {
              phase: 'model',
              hostExecuted: false,
            });
          } catch {
            /* The request ended meanwhile. */
          }
          resolve(answers);
        };
        const stop = () => done(null);
        signal.addEventListener('abort', stop, { once: true });
        this.nativeQuestions.set(requestId, { projectId, cards, answer: done });
        this.workspace.update(projectId, requestId, 'running', {
          phase: 'question',
          hostExecuted: false,
          questions: cards,
        });
      });
  }
  /** The person's answers to a running turn's native questions (the question cards). */
  answerQuestions(
    projectId: string,
    requestId: string,
    answers: NativeQuestionAnswer[],
  ): { ok: true } {
    const waiting = this.nativeQuestions.get(requestId);
    if (!waiting || waiting.projectId !== projectId) throw new DomainError('NOT_FOUND');
    const known = new Set(waiting.cards.map((card) => card.id));
    waiting.answer(answers.filter((answer) => known.has(answer.id)));
    return { ok: true };
  }
  async models() {
    // Explicit models only: a "CLI default" entry hid which model actually ran. ChatGPT models
    // come from the Codex CLI's own catalog; Claude Code keeps none, so the current family is listed.
    const catalog: { id: string; name: string; provider: string; efforts: string[] }[] = [];
    for (const [id, name] of CLAUDE_MODELS)
      catalog.push({ id, name, provider: 'claude-cli', efforts: claudeEfforts(id) });
    // The Codex CLI keeps its model list per account folder; a newly added account has none until
    // its first run, so fall back to the default folder, then to the CLI's own default model.
    const codexCache = z.object({
      models: z
        .array(
          z.object({
            slug: z.string(),
            visibility: z.string().optional(),
            display_name: z.string().optional(),
            supported_reasoning_levels: z.array(z.object({ effort: z.string() })).optional(),
          }),
        )
        .optional(),
    });
    const active = this.profiles?.directory('codex-cli', this.profiles.list().active['codex-cli']);
    const folders = [...(active ? [active] : []), join(homedir(), '.codex')];
    for (const folder of folders) {
      try {
        const cache = codexCache.parse(
          JSON.parse(await readFile(join(folder, 'models_cache.json'), 'utf8')),
        );
        for (const model of cache.models || [])
          if (model.visibility !== 'hide' && /^[a-zA-Z0-9._-]{1,100}$/.test(model.slug))
            catalog.push({
              id: model.slug,
              name: model.display_name || model.slug,
              provider: 'codex-cli',
              efforts: [
                'default',
                ...(model.supported_reasoning_levels || [])
                  .map((x) => x.effort)
                  .filter((x) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(x)),
              ],
            });
      } catch {
        /* No cached catalog in this folder. */
      }
      if (catalog.some((model) => model.provider === 'codex-cli')) break;
    }
    if (!catalog.some((model) => model.provider === 'codex-cli'))
      catalog.push({
        id: 'codex-cli',
        name: 'ChatGPT (CLI 기본 모델)',
        provider: 'codex-cli',
        efforts: ['default'],
      });
    try {
      const settings = z
        .object({ model: z.string().optional() })
        .parse(
          JSON.parse(
            await readFile(
              join(
                this.profiles?.directory('claude-cli', this.profiles.list().active['claude-cli']) ??
                  join(homedir(), '.claude'),
                'settings.json',
              ),
              'utf8',
            ),
          ),
        );
      // Aliases (opus, sonnet…) name a listed model; only an explicit other ID is added.
      if (
        typeof settings.model === 'string' &&
        settings.model.startsWith('claude-') &&
        /^[a-zA-Z0-9._-]{1,100}(?:\[1m\])?$/.test(settings.model)
      )
        catalog.push({
          id: settings.model,
          name: modelName(settings.model),
          provider: 'claude-cli',
          efforts: claudeEfforts(settings.model),
        });
    } catch {
      /* Optional provider preferences: built-in model remains usable. */
    }
    return catalog.filter(
      (model, index) => catalog.findIndex((entry) => entry.id === model.id) === index,
    );
  }
  async status() {
    return Promise.all(
      (['claude-cli', 'codex-cli'] as const).map(async (provider) => {
        try {
          return { id: provider, ...(await this.provider({ provider }).status()) };
        } catch (error) {
          return {
            id: provider,
            available: false,
            reason: errorData(error).code || 'CLI_UNAVAILABLE',
          };
        }
      }),
    );
  }
  /** The provider of a run, noted for its step times (only the last one made is measured). */
  private timed<P extends Provider>(id: string, provider: P): P {
    const marks = this.marks.get(id);
    if (marks) {
      marks.providerAt ??= Date.now();
      marks.source = provider as { timing?: RunMarks['provider'] };
    }
    return provider;
  }
  /** Runs the request now, or leaves a waiting one in line (SPEC-02.9): `pump` starts it in turn. */
  start(request: StoredWork) {
    if (this.active.has(request.id)) return;
    if (waitingOf(request)) {
      this.pump(request.projectId);
      return;
    }
    // One running turn per conversation (SPEC-02.19 4): a later message waits in its line.
    const hold = this.conversations?.hold(
      request,
      this.workspace.list(request.projectId),
      new Set(this.active.keys()),
    );
    if (hold?.code) {
      this.workspace.update(request.projectId, request.id, 'interrupted', {
        ...request.result,
        code: hold.code,
      });
      return;
    }
    if (hold?.waitingFor) {
      this.workspace.wait(request.projectId, request.id, hold.waitingFor);
      return;
    }
    const controller = new AbortController();
    const completion = this.traced(request, this.run(request, controller)).finally(() => {
      this.active.delete(request.id);
      this.pump(request.projectId);
    });
    this.active.set(request.id, { controller, completion, projectId: request.projectId });
  }
  private closing = false;
  /** Starts the waiting requests whose turn has come (after any run ends or a wait is cancelled). */
  private pump(projectId: string) {
    if (this.closing) return;
    try {
      for (const next of this.workspace.release(projectId))
        if (!this.active.has(next.id)) this.start({ ...next, result: null });
    } catch (error) {
      // The project may be gone; a failed hand-over leaves the requests waiting, never running.
      this.diagnostics?.write('queue-failed', { projectId, ...Diagnostics.error(error) });
    }
  }
  /** Diagnostic start/end lines around one run: IDs, model, duration, final state and code. */
  private traced<T>(request: StoredWork, run: Promise<T>) {
    const started = performance.now();
    const input = request.input as Record<string, unknown>;
    const base = { requestId: request.id, projectId: request.projectId };
    this.diagnostics?.write('request-start', {
      ...base,
      provider: input.provider,
      model: input.model ?? null,
      effort: input.effort ?? null,
      host: input.host ?? 'rhino',
      mode: requestMode(input),
      conversation: input.conversationId ?? null,
    });
    return run
      .catch((error: unknown) => {
        this.diagnostics?.write('request-crash', { ...base, ...Diagnostics.error(error) });
        throw error;
      })
      .finally(() => {
        let state = 'unknown',
          code: unknown = null,
          activity: unknown;
        try {
          const done = this.workspace.get(request.projectId, request.id);
          state = done.state;
          code = (done.result as { code?: unknown } | null)?.code ?? null;
          activity = (done.result as { activity?: unknown } | null)?.activity;
        } catch {
          /* The request may be gone (project removed). */
        }
        const marks = this.marks.get(request.id);
        this.marks.delete(request.id);
        // Each step's milliseconds (numbers only), so a slow stage can be measured exactly.
        if (marks)
          this.diagnostics?.write('request-stages', {
            ...base,
            ...requestStages({ ...marks, provider: marks.source?.timing }, activity, Date.now()),
          });
        this.diagnostics?.write('request-end', {
          ...base,
          state,
          code,
          ms: Math.round(performance.now() - started),
        });
      });
  }
  intervene(projectId: string, predecessorId: string, value: unknown) {
    const saved = this.workspace.intervene(projectId, predecessorId, value);
    if (!saved.created) return saved.request;
    const predecessor = this.active.get(predecessorId);
    const { request } = saved;
    if (!predecessor || predecessor.projectId !== projectId) {
      const waiting = this.workspace.get(projectId, predecessorId);
      if (!waitingOf(waiting))
        return this.workspace.update(projectId, request.id, 'interrupted', {
          code: 'PREDECESSOR_UNAVAILABLE',
        });
      // The predecessor was still waiting in line: it is withdrawn and the new condition takes a
      // place of its own.
      this.workspace.update(projectId, predecessorId, 'cancelled', {
        ...waiting.result,
        code: 'CANCELLED',
      });
      const admission = this.workspace.admission(projectId, request.id);
      if (admission.code)
        return this.workspace.update(projectId, request.id, 'interrupted', {
          code: admission.code,
        });
      if (admission.waitingFor) this.workspace.wait(projectId, request.id, admission.waitingFor);
      else this.start(this.workspace.get(projectId, request.id));
      this.pump(projectId);
      return this.workspace.get(projectId, request.id);
    }
    const controller = new AbortController();
    const completion = (async () => {
      await predecessor.completion;
      if (controller.signal.aborted) {
        this.workspace.update(projectId, request.id, 'cancelled');
        return;
      }
      const previous = this.workspace.get(projectId, predecessorId);
      const children = this.workspace
        .list(projectId)
        .filter((row) => row.input.parentRequestId === predecessorId);
      if (
        previous.state === 'unknown' ||
        children.some((row) => row.state === 'unknown' || row.result?.hostExecuted)
      ) {
        this.workspace.update(projectId, request.id, 'interrupted', {
          code: 'INTERVENTION_REVIEW_REQUIRED',
        });
        return;
      }
      // Its own turn now (SPEC-02.9): an unresolved result stops it, a busy document or a full
      // AI turn limit puts it in line (started by `pump`).
      const admission = this.workspace.admission(projectId, request.id);
      if (admission.code) {
        this.workspace.update(projectId, request.id, 'interrupted', { code: admission.code });
        return;
      }
      if (admission.waitingFor) {
        this.workspace.wait(projectId, request.id, admission.waitingFor);
        return;
      }
      await this.traced(request, this.run(request, controller));
    })()
      .catch(() => {
        this.workspace.update(projectId, request.id, 'interrupted', {
          code: 'INTERVENTION_REVIEW_REQUIRED',
        });
      })
      .finally(() => {
        this.active.delete(request.id);
        this.pump(projectId);
      });
    this.active.set(request.id, { controller, completion, projectId });
    predecessor.controller.abort();
    return request;
  }
  /** A conversation's turn: its session and the ledger items (undefined outside a conversation). */
  private beginTurn(request: StoredWork): Promise<Turn | undefined> | undefined {
    if (!this.conversations || typeof request.input.conversationId !== 'string') return undefined;
    return this.conversations.beginTurn(request, {
      rows: this.workspace.list(request.projectId),
      cliVersion: async () => (await this.provider(request.input).checkVersion?.()) ?? 'unknown',
    });
  }
  private endTurn(turn: Turn, projectId: string, id: string) {
    try {
      const done = this.workspace.get(projectId, id);
      // A turn stopped at a guard card ended normally as an AI turn (its session resumes).
      const state = done.state === 'needs-confirmation' ? 'succeeded' : done.state;
      this.conversations!.endTurn(turn, { state, result: done.result });
    } catch (error) {
      this.diagnostics?.write('conversation-turn-failed', {
        requestId: id,
        projectId,
        ...Diagnostics.error(error),
      });
    }
  }
  async run(request: StoredWork, controller: AbortController, attempt = 0): Promise<void> {
    // Both mode and the old permission filled (a stored row keeps only what was submitted).
    request = { ...request, input: withMode(request.input) };
    const { projectId, id, input } = request;
    // Step times (diagnostic log): the run starts here, before its synchronous part up to the
    // provider call; a retried turn keeps its first start.
    if (!this.marks.has(id)) {
      const received = Date.parse(request.createdAt ?? '');
      this.marks.set(id, {
        runAt: Date.now(),
        ...(Number.isFinite(received) ? { receivedAt: received } : {}),
      });
    }
    // A jig's AI review reads only the attached jig table: no host, no document context.
    // A turn taken without the host (SPEC-02.9 1) gets none either.
    const reviewJig = z
      .object({ kind: z.enum(['sync-review', 'structure-draft-review', 'input-roles']) })
      .safeParse(input.jig).success;
    const jigReview = reviewJig || hostUse(input) === 'none';
    const target = input.host || 'rhino',
      host = jigReview ? undefined : this.hosts[target];
    this.workspace.update(projectId, id, 'running');
    let hostIntent: Record<string, unknown> | undefined;
    let turn: Turn | undefined;
    try {
      if (input.applyToSource && (!this.sdk || !this.applyAttached))
        throw { code: 'EXECUTOR_NOT_READY' };
      // Rhino에 만들기 (SPEC-07.12, ARCH-03 §9.3): the fixed bodies the bake route prepared run in
      // the work copy with no provider; the job writes the bake record and the candidate summary.
      const bake = bakeJobOf(request);
      if (bake) {
        if (!this.sdk) throw { code: 'EXECUTOR_NOT_READY' };
        const basis = this.workspace.basis(projectId, input);
        let result: Record<string, unknown>;
        try {
          result = await this.sdk.runFixed({
            input,
            previous: basis
              ? { ...basis, result: executionResultSchema.parse(basis.result) }
              : undefined,
            codes: bake.codes,
            expectedDocumentHash: bake.expectedDocumentHash,
            signal: controller.signal,
            update: (progress) => {
              if (progress.phase === 'host') hostIntent = progress;
              this.workspace.update(projectId, id, 'running', progress);
            },
          });
        } catch (cause) {
          // A refused or failing template leaves the original untouched; keep the worker's
          // diagnostics with the failure so the template fault can be fixed.
          const error = errorData(cause);
          if (error.code !== 'BAKE_TEMPLATE_REJECTED' && error.code !== 'BAKE_FAILED') throw cause;
          const { code, diagnostics, diagnosticId, exceptionType } = error as Record<
            string,
            unknown
          >;
          this.workspace.update(projectId, id, 'failed', {
            code,
            hostExecuted: false,
            ...(diagnostics ? { diagnostics } : {}),
            ...(diagnosticId ? { diagnosticId } : {}),
            ...(exceptionType ? { exceptionType } : {}),
          });
          return;
        }
        this.workspace.update(projectId, id, 'succeeded', await bake.finish(result));
        return;
      }
      const pins = pinsSchema.parse(input.pins);
      const items: { id: string; type: string; data: unknown }[] = [
        ...pins.map((data, i) => ({ id: `pin-${i}`, type: 'object-reference', data })),
        ...input.sketches.map((data, i) => ({ id: `sketch-${i}`, type: 'sketch', data })),
        ...input.files.map((data, i) => ({ id: `file-${i}`, type: 'file', data })),
        // Images go to the model as image content (PLAN-24; the CLI adapters split them out).
        ...(input.images ?? []).map((data, i) => ({ id: `image-${i}`, type: 'image', data })),
      ];
      // Outside a conversation the run stays synchronous up to the provider call (no await).
      const pending = this.beginTurn(request);
      if (pending) turn = await pending;
      if (input.linkedTargets) {
        if (!this.sdk || !this.zwcadSdk || !this.tools) throw { code: 'EXECUTOR_NOT_READY' };
        if (turn) items.push(...turn.items);
        await runLinked({
          request,
          workspace: this.workspace,
          tools: this.tools,
          drivers: { rhino: this.sdk, zwcad: this.zwcadSdk },
          items,
          signal: controller.signal,
          provider: (agent) =>
            this.timed(
              id,
              this.provider(input, agent, turn?.session, { mode: 'modeling', projectId }),
            ),
        });
        return;
      }
      const basis = jigReview ? undefined : this.workspace.basis(projectId, input);
      const previous = basis
        ? { ...basis, result: executionResultSchema.parse(basis.result) }
        : undefined;
      // The drawing open in ZWCAD (connection plugin) is edited directly by its own path.
      const openCadDrawing =
        previous?.result.host === 'zwcad' &&
        previous.result.displayOnly === true &&
        (previous.result.sourceDocument as { connection?: string } | undefined)?.connection ===
          'attached-editor';
      if (
        previous?.result.referenceOnly &&
        !openCadDrawing &&
        (!isDwgSdkEditMode(previous.result.dwgEditMode) ||
          (previous.result.dwgEditMode === 'linear-entities-v1' && !this.zwcadSdk)) &&
        input.permission === 'candidate'
      )
        throw { code: 'ZWCAD_REFERENCE_ONLY' };
      const referenced = pins.map((pin) => {
        const source = this.workspace.get(projectId, pin.basis),
          result = executionResultSchema.parse(source.result);
        return {
          role: pin.role,
          sourceRequestId: source.id,
          host: result.host || 'rhino',
          object: result.objects?.find((o) => o.id === pin.id),
        };
      });
      if (referenced.length)
        items.push({ id: 'referenced-geometry', type: 'geometry-reference', data: referenced });
      const hidden = this.workspace.hiddenIds(projectId);
      // Earlier exchanges of this conversation (the default one: requests without any). A provider
      // session holds them itself (SPEC-02.17 6; a new one gets the hand-over): no Jev selection and
      // no conversation item, only the ledger summary of its turn items. The ledger method sends a
      // selection.
      const earlier = (
        turn?.session
          ? []
          : this.workspace
              .list(projectId)
              .filter((r) => (r.input.conversationId ?? null) === (input.conversationId ?? null))
      )
        .filter((r) => r.id !== id && r.state === 'succeeded' && !hidden.has(r.id))
        .map((r) => ({
          id: r.id,
          request: r.input.body,
          response: typeof r.result?.text === 'string' ? r.result.text : undefined,
        }));
      // Six or fewer all go without a Jev call (and without an extra wait before the run).
      const context =
        earlier.length <= CONTEXT_LIMIT
          ? { ids: earlier.map((entry) => entry.id), by: 'all' as const, ms: 0 }
          : await this.selectContext(input.body, earlier);
      const marks = this.marks.get(id);
      if (marks) marks.contextMs = context.ms;
      this.diagnostics?.write('context', {
        request: id,
        by: turn?.session ? 'session' : context.by,
        ms: context.ms,
        sent: context.ids.length,
        of: earlier.length,
        ...(context.reason ? { reason: context.reason } : {}),
      });
      const chosen = new Set(context.ids);
      // Each exchange is clipped so a few long answers cannot push the packet past its 256 KB cap.
      const clip = (text: string | undefined, max: number) =>
        text && text.length > max ? text.slice(0, max) + ' …(생략)' : text;
      const conversation = earlier
        .filter((entry) => chosen.has(entry.id))
        .map((entry) => ({
          request: clip(entry.request, 2000),
          response: clip(entry.response, 6000),
        }));
      if (conversation.length)
        items.push({ id: 'conversation', type: 'conversation', data: conversation });
      if (turn) items.push(...turn.items);
      const sdk = jigReview ? undefined : target === 'rhino' ? this.sdk : this.zwcadSdk;
      if (sdk)
        items.push(
          ...modelContext(
            previous?.result,
            pins.filter((pin) => pin.basis === previous?.id).map((pin) => pin.id),
          ),
        );
      else if (host)
        items.push({ id: 'working-model', type: 'geometry', data: previous?.result.objects || [] });
      if (!sdk && previous?.result.scene)
        items.push({
          id: 'measurements',
          type: 'native-measurements',
          data: previous.result.scene.map(({ id, area, volume, length, boundsSize, layer64 }) => ({
            id,
            area,
            volume,
            length,
            boundsSize,
            layer: layer64 ? Buffer.from(layer64, 'base64').toString('utf8') : null,
          })),
        });
      // Plan / Auto (ADR-022): Plan turns end with a plan card; Auto on an attached document edits
      // it directly, one undo record per execute.
      const runMode = requestMode(input);
      if (runMode === 'plan')
        items.push({ id: 'plan-mode', type: 'mode', data: { mode: runMode, rules: PLAN_RULES } });
      const direct =
        !jigReview && target === 'rhino' && previous?.result.displayOnly === true
          ? this.directDriverFor(target, previous.result.sourceDocument)
          : undefined;
      const origin =
        typeof this.tools?.origin === 'function' ? this.tools.origin() : this.tools?.origin;
      if (direct && previous && this.tools && origin) {
        const result = await runDirectTurn({
          input,
          mode: runMode,
          driver: direct,
          previous,
          items,
          signal: controller.signal,
          tools: this.tools,
          origin,
          protectedIds: pins
            .filter((pin) => pin.role !== 'target' && pin.basis === previous.id)
            .map((pin) => pin.id),
          provider: (agent) =>
            this.timed(
              id,
              this.provider(input, agent, turn?.session, {
                mode: 'modeling',
                projectId,
                host: target,
              }),
            ),
          update: (progress) => {
            if (progress.phase === 'host') hostIntent = progress;
            this.workspace.update(projectId, id, 'running', progress);
          },
          onExecution: (record) => this.ledgerExecution(request, record),
        });
        this.settleModes(request, result, false);
        return;
      }
      if (sdk) {
        const result = await sdk.run({
          input,
          previous,
          items,
          signal: controller.signal,
          provider: (agent) =>
            this.timed(
              id,
              this.provider(input, agent, turn?.session, {
                mode: 'modeling',
                projectId,
                host: target,
              }),
            ),
          update: (progress) => {
            if (progress.phase === 'host') hostIntent = progress;
            this.workspace.update(projectId, id, 'running', progress);
          },
        });
        // Deprecated (ADR-022): the candidate → apply path of a Rhino work copy. An attached
        // document takes the direct path above; this stays for requests stored before it.
        if (input.applyToSource && result.hostExecuted && target !== 'zwcad')
          await this.applyAttached!(request, result, controller.signal);
        // ZWCAD's attached drawing runs its own direct loop (executions, guarded) inside sdk.run.
        else this.settleModes(request, result, target === 'zwcad');
        return;
      }
      const targetContract =
        target === 'zwcad'
          ? 'Target is ZWCAD: only planar XY polylines, their move and remove are supported. No solid operations.'
          : 'Target is Rhino.';
      const dwgContract =
        previous?.result.dwgEditMode === 'polyline-vertices-v1'
          ? ' Imported DWG: ONLY move/vertices of existing IDs. Preserve names, object count and unmentioned geometry. No add/copy/remove in this path.'
          : '';
      const goal =
        (host
          ? geometryContract +
            '\n' +
            targetContract +
            dwgContract +
            ' Other-host pinned geometry is read-only reference in meters, never a writable target.\nPermission: ' +
            input.permission +
            '\nUser request: '
          : '') + (input.body || '첨부한 설계 문맥을 검토해 주세요.');
      // A conversation turn without the host gets the conversation's tools (PLAN-24 T-062).
      const sources =
        turn && !host && this.tools
          ? conversationSources(this.workspace, turn.conversation, {
              requestId: id,
              ledger: (item) =>
                this.conversations!.addLedger(projectId, turn!.conversation.id, item),
            })
          : undefined;
      const scope =
        sources && this.tools
          ? this.tools.issueConversation(sources, {
              readOnly: runMode === 'plan',
              isCurrent: () => !controller.signal.aborted,
              maxCalls: executionLimits(input).maxToolCalls,
              ttlMs: Math.min(600000, (executionLimits(input).timeoutSeconds + 60) * 1000),
            })
          : undefined;
      // The bundle's mode (PLAN-24 지침 묶음): host edit, jig making, jig review or data.
      const mode: InstructionMode = host
        ? 'modeling'
        : turn?.conversation.kind === 'jig-make'
          ? 'make'
          : reviewJig
            ? 'review'
            : 'data';
      // A stopped make-conversation (stop card unanswered, or this turn hit the turn cap) gets no
      // file tools and no jig_delete_file (T-063).
      const connection =
        scope?.connection.draftDir &&
        (sources?.draft?.guard?.stop ||
          this.conversations?.makeStopped(projectId, turn!.conversation.id))
          ? {
              ...scope.connection,
              makeStopped: true,
              tools: scope.connection.tools.filter((name) => name !== 'jig_delete_file'),
            }
          : scope?.connection;
      const result = await this.timed(
        id,
        this.provider(
          input,
          connection,
          turn?.session,
          {
            mode,
            projectId,
            ...(host ? { host: target } : {}),
          },
          // A conversation turn asks with Claude's own question tool by default (ADR-026 4);
          // VIDE_NATIVE_QUESTIONS=0 keeps the structured-output cards only. Like the Codex
          // app-server flag, an injected provider factory (tests) opts in with =1 only.
          turn &&
            (process.env.VIDE_NATIVE_QUESTIONS === '1' ||
              (nativeQuestionsEnabled() && this.providerFactory === createProvider))
            ? this.questionHandler(projectId, id)
            : undefined,
        ),
      )
        .run(
          { goal, revision: 1, items, includedIds: items.map((item) => item.id) },
          {
            signal: controller.signal,
            onProgress: (event) =>
              this.workspace.update(projectId, id, 'running', {
                phase: event.state === 'stopping' ? 'stopping' : 'model',
                hostExecuted: false,
              }),
          },
        )
        .finally(() => scope?.revoke());
      if (host) {
        const proposal = interpret(result.text, previous?.result.objects || [], input.permission);
        const protectedIds = pins
          .filter(
            (pin) => ['preserve', 'reference'].includes(pin.role) && pin.basis === previous?.id,
          )
          .map((pin) => pin.id);
        protectGeometry(previous?.result.objects || [], proposal.objects, protectedIds);
        if (controller.signal.aborted) throw { code: 'CANCELLED' };
        if (proposal.changed) {
          hostIntent = {
            phase: 'host',
            hostExecuted: false,
            objects: proposal.objects,
            baseRequestId: previous?.id,
            host: target,
          };
          this.workspace.update(projectId, id, 'running', hostIntent);
          const returned = await host.build(projectId, id, proposal.objects, previous?.result);
          const checked = z
            .object({
              scene: z.array(
                z.object({ id: z.string(), nativeId: z.string().optional() }).passthrough(),
              ),
            })
            .passthrough()
            .safeParse(returned);
          if (!checked.success) throw { code: 'HOST_RESULT_UNKNOWN' };
          const native = checked.data;
          if (
            proposal.objects.some(
              (object) =>
                object.kind === 'native' &&
                !native.scene.find((scene) => scene.id === object.id)?.nativeId,
            )
          )
            throw { code: 'HOST_RESULT_UNKNOWN' };
          const objects = proposal.objects.map((o) =>
            o.kind === 'native'
              ? { ...o, nativeId: native.scene.find((x) => x.id === o.id)?.nativeId }
              : o,
          );
          this.workspace.update(projectId, id, 'succeeded', {
            ...result,
            text: proposal.message,
            objects,
            ...native,
            sourceDocument: previous?.result.sourceDocument,
            baseRequestId: previous?.id,
            host: target,
            hostExecuted: true,
          });
        } else
          this.workspace.update(projectId, id, 'succeeded', {
            ...result,
            text: proposal.message,
            hostExecuted: false,
          });
      } else {
        // Plan mode (ADR-022): the plan card leaves the text and the strict turn output.
        const planned = runMode === 'plan' ? takePlan(result) : undefined;
        const raw = planned?.value ?? result;
        const answer: Record<string, unknown> = {
          ...raw,
          ...jigCheck(input, raw.text),
          ...turnOutputResult(turn, raw),
        };
        if (planned) {
          const inner = takePlan(answer);
          Object.assign(answer, inner.value, { mode: runMode });
          const plan = inner.plan ?? planned.plan;
          if (plan) answer.plan = plan;
        }
        // A make turn: Codex's files go into the draft; a stopped turn ends with its card (T-063).
        if (sources?.draft) {
          const made = await makeTurnResult(projectId, sources.draft, result, answer);
          Object.assign(answer, made);
          // SPEC-07.9: the files VIDE wrote for Codex stay in the ledger as a code item.
          if (made.makeFiles)
            sources.ledger?.({ kind: 'code', body: made.makeFiles, requestId: id });
        }
        // Citation gate of the project facts tools (SPEC-08.7): on the answer the user reads.
        const cited =
          sources?.facts && typeof answer.text === 'string'
            ? factCitations(answer.text, sources.facts.returned)
            : {};
        this.workspace.update(projectId, id, 'succeeded', {
          ...answer,
          ...cited,
          hostExecuted: false,
        });
      }
    } catch (cause) {
      const error = errorData(cause);
      if (error.code === 'SESSION_LOST' && turn && attempt === 0 && !controller.signal.aborted) {
        // The resumed transcript is gone (SPEC-02.19 5): the turn runs once more in a new
        // session that gets the ledger and a hand-over.
        this.conversations!.endTurn(turn, { state: 'failed', result: { code: error.code } });
        turn = undefined;
        return this.run(request, controller, 1);
      }
      // A refused login or a subscription limit: the remembered login is asked again.
      if (error.code === 'PROVIDER_LIMIT' || error.code === 'CLI_MODE_CHANGED') clearAuthStatus();
      if (error.code === 'PROVIDER_LIMIT')
        this.onProviderLimit?.(
          String(request.input.provider),
          String(request.input.accountProfileId ?? 'default'),
        );
      this.workspace.update(
        projectId,
        id,
        error.code === 'CANCELLED'
          ? 'cancelled'
          : error.code === 'HOST_RESULT_UNKNOWN'
            ? 'unknown'
            : 'failed',
        {
          ...(error.code === 'HOST_RESULT_UNKNOWN' ? error.intent || hostIntent : {}),
          // A direct turn that failed after applying executes keeps them ([되돌리기] still works).
          ...(error.code !== 'HOST_RESULT_UNKNOWN' &&
          error.partial &&
          typeof error.partial === 'object'
            ? error.partial
            : {}),
          code: error.code || 'EXECUTION_FAILED',
          hostExecuted: false,
        },
      );
    } finally {
      if (turn) this.endTurn(turn, projectId, id);
    }
  }
  /** Settles when the request's run ends (undefined when it is not running here). */
  completion(id: string): Promise<unknown> | undefined {
    return this.active.get(id)?.completion;
  }

  // --- Plan / Auto and direct execution (ADR-022) -----------------------------------------------

  /**
   * The attached document a direct turn writes to (or a stored execution undoes). `attachedOnly`:
   * the source must name an attached editor connection (a request's basis); stored execution
   * targets carry only instance and document.
   */
  directDriverFor(
    host: 'rhino' | 'zwcad',
    sourceDocument: unknown,
    attachedOnly = true,
  ): DirectDriver | undefined {
    if (
      attachedOnly &&
      !z.object({ connection: z.literal('attached-editor') }).safeParse(sourceDocument).success
    )
      return undefined;
    if (this.injectedDirect) return this.injectedDirect(host, sourceDocument);
    const parsed = hostTargetSchema.safeParse(sourceDocument);
    if (!parsed.success) return undefined;
    const target = { instance: parsed.data.instance, documentId: parsed.data.documentId };
    // An executor without the direct methods (an older or stub one) keeps the work copy path.
    if (host === 'rhino' && typeof this.sdk?.runDirect === 'function') {
      const sdk = this.sdk;
      const reads = displayQuery(async () => {
        const { sourceDocument, ...model } = await sdk.readLayers(target, {});
        return { ...model, units: sourceDocument.units };
      });
      return {
        host,
        target,
        execute: async (command) => {
          try {
            return await sdk.runDirect(target, command.code, command.guard, command);
          } finally {
            reads.invalidate();
          }
        },
        undo: (undoId) => sdk.undoDirect(target, undoId),
        query: (options) => reads.page(options),
        vision: () => sdk.directView(target),
        fingerprint: () => sdk.fingerprint(target),
      };
    }
    if (host === 'zwcad' && this.zwcadSdk) {
      // ZWCAD's turn runs its own direct loop (zwcad-sdk-execution.ts); this driver serves
      // [되돌리기] and a confirmed re-run.
      const attached = this.zwcadSdk.editors?.attached;
      if (!attached) return undefined;
      return {
        host,
        target,
        execute: (command) => attached.directExecute(target, command),
        undo: (undoId) => attached.directUndo(target, undoId),
        fingerprint: () => attached.fingerprint(target),
        query: async () => {
          throw { code: 'EXECUTOR_NOT_READY' };
        },
      };
    }
    return undefined;
  }
  /** Books a run's outcome by mode: Plan keeps its plan card, a tripped guard waits on its card. */
  private settleModes(request: StoredWork, result: Record<string, unknown>, ledger: boolean) {
    const { projectId, id, input } = request;
    const mode = requestMode(input);
    let value: Record<string, unknown> = { ...result, mode };
    if (mode === 'plan') {
      const taken = takePlan(value);
      value = taken.plan ? { ...taken.value, plan: taken.plan } : taken.value;
    }
    if (ledger) for (const record of executionsOf(value)) this.ledgerExecution(request, record);
    // A direct turn's end time: [진행] shows the final answer's time up to here.
    if (typeof value.appliedDirectly === 'boolean') value.endedAt = new Date().toISOString();
    const guarded = !!value.guarded && typeof value.guarded === 'object';
    this.workspace.update(projectId, id, guarded ? 'needs-confirmation' : 'succeeded', value);
  }
  /** Each direct execution goes in the conversation's ledger (counts only, never the body). */
  private ledgerExecution(request: StoredWork, record: Partial<ExecutionRecord>) {
    const conversationId = request.input.conversationId;
    if (!this.conversations || typeof conversationId !== 'string') return;
    const { code: _code, changes, ...entry } = record;
    const count = (key: 'added' | 'changed' | 'removed') =>
      Array.isArray(changes?.[key]) ? (changes[key] as unknown[]).length : 0;
    try {
      this.conversations.addLedger(request.projectId, conversationId, {
        kind: 'code',
        requestId: request.id,
        body: {
          execution: {
            ...entry,
            host: entry.host ?? (request.input.host || 'rhino'),
            ...(changes
              ? {
                  changes: {
                    added: count('added'),
                    changed: count('changed'),
                    removed: count('removed'),
                  },
                }
              : {}),
          },
        },
      });
    } catch (error) {
      this.diagnostics?.write('conversation-ledger-failed', {
        requestId: request.id,
        projectId: request.projectId,
        ...Diagnostics.error(error),
      });
    }
  }
  /**
   * [되돌리기] (POST …/requests/:rid/undo {executionId}): the host undoes that execution's record
   * only while it is the document's latest one; otherwise {ok:false, reason:'not-latest'} and the
   * user reverts with the host's own Undo.
   */
  async undo(projectId: string, id: string, executionId: unknown) {
    const key = z.string().min(1).max(100).parse(executionId);
    const request = this.workspace.get(projectId, id);
    const entry = executionsOf(request.result).find((e) => e.executionId === key);
    if (!entry?.undoId) throw new DomainError('NOT_FOUND');
    if (entry.state === 'undone') return { ok: true, already: true, request };
    // A run (or a confirmed re-run) still writing this request would overwrite the undone mark;
    // meanwhile the host's own Undo stays available.
    if (this.active.has(id) || ['queued', 'running'].includes(request.state))
      throw new DomainError('REVISION_CONFLICT');
    const host = entry.host ?? (request.result?.host === 'zwcad' ? 'zwcad' : 'rhino');
    const driver = this.directDriverFor(
      host,
      entry.target ?? request.result?.sourceDocument,
      false,
    );
    if (!driver) throw new DomainError('EXECUTOR_NOT_READY');
    const answer = await driver.undo(entry.undoId);
    if (!answer.ok)
      return {
        ok: false,
        reason: typeof answer.reason === 'string' ? answer.reason : 'undo-failed',
        request: this.workspace.get(projectId, id),
      };
    // Re-read: the run may have moved on while the host answered.
    const now = this.workspace.get(projectId, id);
    const updated = this.workspace.update(projectId, id, now.state, {
      ...now.result,
      executions: executionsOf(now.result).map((e) =>
        e.executionId === key ? { ...e, state: 'undone', undoneAt: new Date().toISOString() } : e,
      ),
    });
    this.ledgerExecution(updated, { ...entry, state: 'undone' });
    // The host had it undone already (Rhino Ctrl+Z / ZWCAD U): nothing more was undone now.
    return { ok: true, ...(answer.already === true ? { already: true } : {}), request: updated };
  }
  /**
   * The guard card's [진행] (POST …/requests/:rid/confirm {executionId}): the held body runs again
   * with the guard released, as its own undo record. A host that kept no body (ZWCAD) runs the
   * turn again with the guard released.
   */
  async confirm(projectId: string, id: string, executionId?: unknown) {
    const key =
      executionId === undefined ? undefined : z.string().min(1).max(100).parse(executionId);
    const request = this.workspace.get(projectId, id);
    if (request.state !== 'needs-confirmation' || this.active.has(id))
      throw new DomainError('REVISION_CONFLICT');
    const executions = executionsOf(request.result);
    const entry = [...executions]
      .reverse()
      .find((e) => e.state === 'guarded' && (!key || e.executionId === key));
    if (key && !entry) throw new DomainError('NOT_FOUND');
    const driver =
      entry?.code && entry.target
        ? this.directDriverFor(entry.host ?? 'rhino', entry.target, false)
        : undefined;
    if (!entry?.code || !driver) {
      this.start({ ...request, input: { ...request.input, guardConfirmed: true } });
      return this.workspace.get(projectId, id);
    }
    // An earlier refusal of this [진행] no longer describes the request once it runs again.
    const { refused: _refused, ...base } = (request.result ?? {}) as Record<string, unknown>;
    this.workspace.update(projectId, id, 'running', { ...base, phase: 'host' });
    const runId = randomUUID();
    const started = Date.now();
    let outcome: Awaited<ReturnType<DirectDriver['execute']>> | undefined;
    let lost: unknown;
    try {
      outcome = await driver.execute({
        requestId: runId,
        code: entry.code,
        label: entry.label,
        guard: { confirmed: true, maxDeletes: DIRECT_MAX_DELETES },
      });
    } catch (error) {
      lost = error;
    }
    // Refused before it touched the document (read-only, busy, closed): nothing ran, the guard
    // card stays answerable once the cause is fixed.
    const refusal =
      !outcome?.ok &&
      !outcome?.guarded &&
      directRefusal(driver.host, outcome ?? lost, Date.now() - started);
    if (refusal)
      return this.workspace.update(projectId, id, 'needs-confirmation', {
        ...base,
        phase: undefined,
        refused: { code: refusal.code, reason: refusal.reason },
      });
    // The answer was lost: the document may or may not hold the record (fingerprint decides).
    if (!outcome)
      return this.workspace.update(projectId, id, 'unknown', {
        ...base,
        phase: 'host',
        code: 'HOST_RESULT_UNKNOWN',
      });
    // A change the host could not revert leaves the document unknown, like a lost answer.
    if (hostLeftUnknown(outcome))
      return this.workspace.update(projectId, id, 'unknown', {
        ...base,
        phase: 'host',
        code: 'HOST_RESULT_UNKNOWN',
      });
    if (!outcome.ok)
      return this.workspace.update(projectId, id, 'failed', {
        ...base,
        phase: undefined,
        code: typeof outcome.code === 'string' ? outcome.code : 'EXECUTION_FAILED',
        ...(outcome.diagnostics ? { diagnostics: outcome.diagnostics } : {}),
      });
    const applied: ExecutionRecord = {
      executionId: runId,
      host: driver.host,
      target: driver.target,
      label: entry.label,
      at: new Date().toISOString(),
      state: 'applied',
      undoId: outcome.undoId ?? null,
      changes: outcome.changes,
      confirms: entry.executionId,
    };
    const document = outcome.undoId ? await documentAfter(driver, outcome) : undefined;
    if (document) applied.document = document;
    const { guarded: _guarded, ...rest } = base;
    const updated = this.workspace.update(projectId, id, 'succeeded', {
      ...rest,
      phase: undefined,
      appliedDirectly: true,
      executions: [
        ...executions.map((e) =>
          e.executionId === entry.executionId ? publicRecord({ ...e, state: 'confirmed' }) : e,
        ),
        applied,
      ],
    });
    this.ledgerExecution(updated, applied);
    return updated;
  }
  /**
   * The plan card's [진행] (POST …/requests/:rid/continue): an Auto turn in the same conversation
   * that carries the plan out. Idempotent: the continuation's id derives from the plan's.
   */
  continuePlan(projectId: string, id: string) {
    const request = this.workspace.get(projectId, id);
    const source = request.input;
    if (
      requestMode(source) !== 'plan' ||
      request.state !== 'succeeded' ||
      source.provider === 'extension'
    )
      throw new DomainError('REVISION_CONFLICT');
    const plan = takePlan({ plan: request.result?.plan }).plan;
    const input: Record<string, unknown> = {
      id: `${id.slice(0, 96)}-go`,
      mode: 'auto',
      body: continueBody(source.body, plan),
      provider: source.provider,
      pins: source.pins,
      sketches: source.sketches,
      files: source.files,
      continuesPlanId: id,
    };
    for (const name of [
      'model',
      'effort',
      'accountProfileId',
      'executionLimits',
      'host',
      'baseRequestId',
      'conversationId',
      'linkedTargets',
      'coordinateBasis',
      'routing',
    ] as const)
      if (source[name] !== undefined) input[name] = source[name];
    const saved = this.workspace.submit(projectId, input);
    if (saved.created) this.start(saved.request);
    return this.workspace.get(projectId, saved.request.id);
  }
  cancel(projectId: string, id: string) {
    const active = this.active.get(id);
    if (active?.projectId === projectId) active.controller.abort();
    else {
      // A request waiting in line is withdrawn; the ones behind it move up.
      const request = this.workspace.get(projectId, id);
      if (waitingOf(request)) {
        this.workspace.update(projectId, id, 'cancelled', {
          ...request.result,
          code: 'CANCELLED',
        });
        this.pump(projectId);
      }
    }
    return this.workspace.get(projectId, id);
  }
  async close() {
    this.closing = true;
    const active = [...this.active.values()];
    active.forEach((x) => x.controller.abort());
    await Promise.all(active.map((x) => x.completion));
    // Codex app-server processes kept between turns (flag) do not outlive the engine.
    if (codexAppServerEnabled()) await closeCodexAppServers().catch(() => {});
  }
}
