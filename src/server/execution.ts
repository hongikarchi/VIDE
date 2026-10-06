import {
  CONTEXT_LIMIT,
  selectContext,
  type ContextCandidate,
  type ContextChoice,
} from '../ai/context-selector.ts';
import { isDwgSdkEditMode } from '../contracts/dwg-edit-mode.ts';
import { executionLimits } from '../contracts/execution-limits.ts';
import { modelContext, pinContext } from './model-context.ts';
import { CLAUDE_MODELS, claudeEfforts, modelName } from './model-capabilities.ts';
import {
  documentHolder,
  hostUse,
  unresolvedFor,
  unresolvedOn,
  waitingOf,
} from '../contracts/request-scope.ts';
import { z } from 'zod';
import { runLinked } from './linked-execution.ts';
// Jig review gates (sync-review rows, structure-draft-review members/nodes; SPEC-06.9).
import { factCitations, jigCheck } from './jig-gates.ts';
import {
  HOST_TURN_PROJECT_TOOLS,
  agendaHandlers,
  conversationHandlers,
  conversationSources,
  type AgentTools,
  type ProjectToolHandlers,
} from './agent-tools.ts';
import {
  WorkFolderGate,
  ownProjectData,
  workFolderScope,
  turnGrants,
  type FileContext,
  type PermissionAction,
  type PermissionAnswer,
  type TurnGrants,
} from './project-files.ts';
import type { ProjectFolders } from '../core/project-folders.ts';
import type { GrasshopperMethod } from '../../hosts/rhino/editor-channel.ts';
import { Agenda } from '../core/agenda.ts';
import { activityLog, type ActivityEntry } from './activity.ts';
import { readableAttachments, type AttachmentStore } from './attachments.ts';
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
import { defaultConversationId, type ConversationService, type Turn } from './conversations.ts';
import { takeReferenceBlock, turnOutputResult } from './turn-output.ts';
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
  afterRequestUndo,
  continueBody,
  documentKey,
  documentAfter,
  hostLeftUnknown,
  lockRefusal,
  displayQuery,
  overlayDisplay,
  executionsOf,
  publicRecord,
  queuedDriver,
  runDirectTurn,
  takePlan,
  undoExecutions,
  PLAN_RULES,
  type DirectDriver,
  type ExecutionRecord,
  unresolvedNote,
} from './direct-mode.ts';
import { directRefusal } from '../contracts/direct-refusal.ts';
import { DocumentLinks, isFileLink } from '../core/document-links.ts';
import { zwcadAnsweredCodes } from './zwcad-sdk-execution.ts';
import { followOpenDocuments, liveLinksOf, type LiveLink } from './live-links.ts';
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
  tools?: AgentTools;
  providerFactory?: (options: CliOptions & { provider: string }) => Provider;
  host?: Host;
  hosts?: Partial<Record<'rhino' | 'zwcad', Host>>;
  settings?: { get: () => { paths: Partial<Record<string, string | null>> } };
  sdk?: SdkExecution;
  zwcadSdk?: ZwcadSdkExecution;
  /**
   * A request stopped on the default login's subscription limit: shown as limited; nothing is
   * sent again by itself (the user changes the account in AccountSwitch, ADR-025).
   */
  onProviderLimit?: (provider: string) => void;
  /** Start/end, duration and failure code of every run (diagnostic log). */
  diagnostics?: Diagnostics;
  /**
   * Settings → AI 「AI가 작업 도중에 묻기」 (T-075): the provider's own question tool in a turn (Claude's
   * AskUserQuestion, Codex's app-server). Default on; the environment still forces each one off.
   */
  questions?: () => boolean;
  /**
   * Settings → AI 「AI 웹 검색」 (ADR-028, T-105): the provider's own web tools in conversation, host
   * and make turns. Default on.
   */
  web?: () => boolean;
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
  /** Composer attachments (SPEC-01.12): read at their path by the CLI's own Read (ADR-031 8). */
  attachments?: AttachmentStore;
  /** Project folders (SPEC-01.13): the work folder of the CLI's own file and shell tools. */
  folders?: ProjectFolders;
  /** Where the data folder is (never reached by the file tools). */
  fileContext?: FileContext;
  /** Every run's end with its stored request (reference boards read their turns, T-090). */
  onFinished?: (request: StoredWork) => void | Promise<void>;
  /**
   * The project's linked files and their open attached documents now (ADR-027); default: the
   * links table matched to the Rhino and ZWCAD connections like the links list.
   */
  liveLinks?: (projectId: string) => Promise<LiveLink[]>;
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
/**
 * A stored model result checked without copying its display geometry: the schema's parse copies
 * every vertex array, which for a large document's Sync (78 MB JSON) took 0.25 s and ~230 MB more
 * heap per call. `scene` and `definitions` keep their stored (host-validated) arrays.
 */
function parsedModel(result: unknown) {
  const { scene, definitions, ...rest } = (result ?? {}) as Record<string, unknown>;
  const parsed = executionResultSchema.parse(rest);
  const geometry = z
    .object({
      scene: z.array(z.object({ id: z.string() }).passthrough()).optional(),
      definitions: z.record(z.string(), z.object({}).passthrough()).optional(),
    })
    .parse({ scene, definitions });
  return {
    ...parsed,
    ...(geometry.scene ? { scene: geometry.scene } : {}),
    ...(geometry.definitions ? { definitions: geometry.definitions } : {}),
  } as z.infer<typeof executionResultSchema>;
}
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
import { withTrace } from '../core/breadcrumbs.ts';
import { clearAuthStatus } from '../ai/claude-cli.ts';
import {
  KeptClaudeCli,
  claudePersistentEnabled,
  closeClaudeProcesses,
} from '../ai/claude-process.ts';

export { HOST_TURN_PROJECT_TOOLS };
/**
 * The handlers of HOST_TURN_PROJECT_TOOLS for a turn of `conversation`, to spread into a host
 * scope's handler list (the host's own handlers win on a name clash). No ledger: they record nothing.
 */
export function hostTurnProjectHandlers(
  workspace: Workspace,
  conversation: Parameters<typeof conversationSources>[1],
  requestId?: string,
): ProjectToolHandlers {
  const all = conversationHandlers(conversationSources(workspace, conversation, { requestId }));
  return Object.fromEntries(
    HOST_TURN_PROJECT_TOOLS.flatMap((name) => (all[name] ? [[name, all[name]]] : [])),
  ) as ProjectToolHandlers;
}

/** The card id of the file permission question (SPEC-01.13 3). */
export const FILE_PERMISSION_CARD = 'file-access';
/**
 * How long a file permission question waits for the person (both CLIs now wait on their own
 * permission request, not on an MCP tool call with a timeout).
 */
export const PERMISSION_WAIT_MS = 300_000;
/** `entries` added to an activity list once each, in time order. */
export function mergeActivity(current: unknown, entries: readonly ActivityEntry[]) {
  const list = Array.isArray(current) ? (current as ActivityEntry[]) : [];
  const seen = new Set(list.map((entry) => `${entry.at}|${entry.text}`));
  return [...list, ...entries.filter((entry) => !seen.has(`${entry.at}|${entry.text}`))].sort(
    (a, b) => String(a.at).localeCompare(String(b.at)),
  );
}

/** Claude's AskUserQuestion on the question cards: on unless VIDE_NATIVE_QUESTIONS=0. */
export const nativeQuestionsEnabled = () => process.env.VIDE_NATIVE_QUESTIONS !== '0';

export class Execution {
  workspace: Workspace;
  applyAttached?: Options['applyAttached'];
  onProviderLimit?: Options['onProviderLimit'];
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
  attachments?: AttachmentStore;
  private injectedDirect?: Options['directDriver'];
  private injectedLinks?: Options['liveLinks'];
  /** Requests an intervention cut (SPEC-02.8): a stopped multi-file turn keeps its changes. */
  private readonly intervened = new Set<string>();
  /**
   * Questions a Claude turn asks with its own AskUserQuestion tool (ADR-026 4, SPIKE-2026-09-30-
   * native-questions-claude), waiting for the person's answer in the same run: request id → cards.
   */
  private readonly nativeQuestions = new Map<
    string,
    {
      projectId: string;
      cards: NativeQuestionCard[];
      answer: (answers: NativeQuestionAnswer[] | null, remote?: boolean) => void;
    }
  >();
  /** Project folders (SPEC-01.13): the work folder of every instructed turn (ADR-031 8). */
  folders?: ProjectFolders;
  fileContext?: FileContext;
  /** One request's permission answers and file tool lines, until the request ends. */
  private readonly fileGrants = new Map<string, TurnGrants>();
  private readonly fileUses = new Map<string, ActivityEntry[]>();
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
      applyAttached,
      onProviderLimit,
      diagnostics,
      conversations,
      projectInstructions,
      directDriver,
      attachments,
      folders,
      fileContext,
      onFinished,
      liveLinks,
      questions,
      web,
      selectContext: choose = (body, candidates) =>
        selectContext(body, candidates, { key: () => '' }),
    }: Options = {},
  ) {
    this.injectedDirect = directDriver;
    this.injectedLinks = liveLinks;
    this.workspace = workspace;
    this.onProviderLimit = onProviderLimit;
    this.applyAttached = applyAttached;
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
    this.attachments = attachments;
    this.folders = folders;
    this.fileContext = fileContext;
    this.onFinished = onFinished;
    this.questions = questions;
    this.web = web;
  }
  private readonly web?: Options['web'];
  /** AI 웹 검색 is on (an unreadable setting counts as off). */
  webOn() {
    try {
      return this.web?.() ?? true;
    } catch {
      return false;
    }
  }
  private readonly questions?: Options['questions'];
  /** AI가 작업 도중에 묻기 is on (an unreadable setting counts as off). */
  questionsOn() {
    try {
      return this.questions?.() ?? true;
    } catch {
      return false;
    }
  }
  private readonly onFinished?: Options['onFinished'];
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
      'provider' | 'model' | 'effort' | 'executionLimits' | 'conversationId'
    > & {
      id?: string;
      files?: readonly unknown[];
      /** Plan or Auto (a host turn's agenda tools: Plan reads only). */
      mode?: unknown;
      permission?: unknown;
    },
    agent?: unknown,
    session?: SessionOptions,
    /** The instruction bundle's mode, the project whose addendum it carries, and its host. */
    instructions?: {
      mode: InstructionMode;
      projectId: string;
      host?: InstructionHost;
      /** The request the turn runs for (its file permission questions and activity). */
      requestId?: string;
    },
    /** Claude's own question tool, answered on the question cards (conversation turns). */
    nativeQuestions?: NativeQuestionHandler,
  ) {
    const executable = this.executable(input.provider);
    // Codex through `codex app-server` (its own questions mid-turn, SPIKE-2026-09-30-codex-app-
    // server) by default; `codex exec` when AI가 작업 도중에 묻기 is off or VIDE_CODEX_APP_SERVER=0.
    // Only replaces the default factory (tests keep their injected one).
    // Claude's conversation turns run in the conversation's kept process (ADR-028, T-104) unless
    // VIDE_CLAUDE_PERSISTENT=0; single runs keep one process per run.
    const factory =
      input.provider === 'codex-cli' &&
      codexAppServerEnabled() &&
      this.questionsOn() &&
      this.providerFactory === createProvider
        ? (options: CliOptions) => new CodexAppServer(options)
        : input.provider === 'claude-cli' &&
            session &&
            claudePersistentEnabled() &&
            this.providerFactory === createProvider
          ? (options: CliOptions) => new KeptClaudeCli(options)
          : this.providerFactory;
    // The provider's own tools (ADR-028, T-105): subagents and the to-do list in conversation,
    // host (modeling) and make turns of a conversation; the public web there too while AI 웹 검색
    // is on. A jig's AI review and single runs (a host request outside a conversation included)
    // get none. Effective only with a VIDE connection.
    const builtinTools =
      instructions &&
      input.conversationId &&
      (instructions.mode === 'modeling' ||
        instructions.mode === 'make' ||
        (instructions.mode === 'data' && session))
        ? { work: true, web: this.webOn() }
        : undefined;
    // A jig's AI review reads only its attached table: no project file tools there. A make turn
    // keeps its draft folder's own file tools (T-063) and gets no work folder.
    if (instructions)
      agent = this.readAgent(
        input,
        agent,
        instructions.projectId,
        instructions.mode === 'review' ? undefined : instructions.requestId,
        instructions.mode === 'modeling',
      );
    const work =
      instructions && instructions.mode !== 'review' && instructions.mode !== 'make'
        ? this.workFolders(input, instructions.projectId, instructions.requestId)
        : undefined;
    const tools =
      builtinTools || work
        ? { ...(builtinTools ?? {}), ...(work ? { files: work.files } : {}) }
        : undefined;
    return factory({
      provider: input.provider,
      executable,
      session,
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
      // Either provider's own question tool (SPEC-02.19 6): Claude's AskUserQuestion, Codex's
      // requestUserInput on the app-server. Without it Codex stops at a question (answer next turn).
      ...(nativeQuestions ? { nativeQuestions } : {}),
      ...(tools ? { builtinTools: tools } : {}),
      ...(work ? { toolPermission: work.permission } : {}),
    });
  }
  /**
   * The turn's project work folder (ADR-031 8, SPEC-01.13): the CLI's own Read, Glob, Grep, Edit,
   * Write and Bash (Codex: shell, apply_patch, view_image) run in the first project folder and
   * reach the project's other folders; the turn's stored attachments are read at their path. A
   * use outside asks the user on the request's card (conversation turns; elsewhere it is refused).
   * Plan turns write no file. Undefined without the folder store.
   */
  private workFolders(
    input: Parameters<Execution['provider']>[0],
    projectId: string,
    requestId: string | undefined,
  ) {
    let others: { files?: readonly unknown[]; conversationId?: string }[] = [];
    if (input.conversationId)
      try {
        others = this.workspace.list(projectId).map((row) => row.input);
      } catch {
        others = [];
      }
    const allowed = this.attachments ? readableAttachments(input, others) : new Map();
    const attachments: string[] = [];
    for (const id of allowed.keys()) {
      const stored = this.attachments!.get(projectId, id);
      if (stored) attachments.push(stored.path);
    }
    // Neither a folder store nor anything attached: the turn has no file tools.
    if (!this.folders && !attachments.length) return undefined;
    const readOnly = requestMode(input) === 'plan';
    const gate = this.fileGate(input, projectId, requestId, attachments, readOnly);
    const scope = gate.scope();
    return {
      files: {
        ...(scope.cwd ? { cwd: scope.cwd } : {}),
        dirs: [...scope.write.slice(1), ...scope.read],
        attachments,
        ...(readOnly ? { readOnly: true } : {}),
        // The project's own records, read without a question (ADR-031 6, ADR-032).
        ...(ownProjectData(projectId, this.fileContext)
          ? { records: ownProjectData(projectId, this.fileContext) }
          : {}),
      },
      permission: (request: Parameters<WorkFolderGate['decide']>[0], signal: AbortSignal) =>
        gate.decide(request, signal),
    };
  }
  /**
   * The turn's read tools (ARCH-01 §3): attachment_read for this request's and its conversation's
   * stored attachments (SPEC-01.12), and file_list/file_read on the project's folders with the
   * permission question outside them (SPEC-01.13). A host (modeling) turn of a conversation also
   * gets the project's 할 일 (SPEC-01.14 6): agenda_list, and in Auto agenda_add/agenda_set
   * recorded in the conversation's ledger (a hostless turn has them among its conversation tools).
   * They join the turn's tool scope, or get a scope of their own when the turn has no tools.
   */
  private readAgent(
    input: Parameters<Execution['provider']>[0],
    agent: unknown,
    projectId: string,
    requestId?: string,
    hostTurn = false,
  ): unknown {
    if (!this.tools) return agent;
    const handlers: Parameters<AgentTools['issue']>[0]['handlers'] = {};
    const conversationId = input.conversationId;
    if (hostTurn && conversationId && this.conversations) {
      const conversations = this.conversations;
      const agenda = agendaHandlers({
        projectId,
        requestId,
        agenda: new Agenda(this.workspace.store),
        ledger: (item) => conversations.addLedger(projectId, conversationId, item),
      });
      // Plan reads only (PLAN_MODE_TOOLS).
      if (requestMode(input) === 'plan') handlers.agenda_list = agenda.agenda_list;
      else Object.assign(handlers, agenda);
    }
    const names = Object.keys(handlers);
    if (!names.length) return agent;
    const current = z
      .object({ token: z.string(), tools: z.array(z.string()) })
      .passthrough()
      .safeParse(agent);
    if (current.success) {
      if (!this.tools.extend(current.data.token, handlers)) return agent;
      const added = names.filter((name) => !current.data.tools.includes(name));
      return added.length ? { ...current.data, tools: [...current.data.tools, ...added] } : agent;
    }
    if (agent !== undefined) return agent;
    const origin =
      typeof this.tools.origin === 'function' ? this.tools.origin() : this.tools.origin;
    if (!origin) return agent;
    const scope = this.tools.issue({
      targetRef: `attachments:${requestId ?? input.id ?? randomUUID()}`,
      handlers,
      isCurrent: () => true,
    });
    return { url: new URL('/mcp', origin).href, token: scope.token, tools: names };
  }
  /**
   * One turn's work folder gate (SPEC-01.13, ADR-031 8): the request's permission answers, the
   * question on the request's cards (conversation turns only: elsewhere no card is shown, so a use
   * outside the folder is refused) and each asked or refused use in the request's activity.
   */
  private fileGate(
    input: Parameters<Execution['provider']>[0],
    projectId: string,
    requestId: string | undefined,
    attachments: readonly string[],
    readOnly: boolean,
  ) {
    let grants = requestId ? this.fileGrants.get(requestId) : undefined;
    if (!grants) {
      grants = turnGrants();
      if (requestId) this.fileGrants.set(requestId, grants);
    }
    return new WorkFolderGate({
      ...(this.folders ? { folders: this.folders } : {}),
      projectId,
      context: this.fileContext,
      grants,
      attachments,
      readOnly,
      ask:
        typeof input.conversationId === 'string' && requestId
          ? (folder, path, signal, action) =>
              this.askFilePermission(
                projectId,
                requestId,
                folder,
                path,
                signal,
                PERMISSION_WAIT_MS,
                action,
              )
          : undefined,
      onUse: (text) => {
        if (requestId) this.noteFileUse(projectId, requestId, text);
      },
    });
  }
  /** One line of the request's activity per file tool call (path only), shown while it runs. */
  private noteFileUse(projectId: string, requestId: string, text: string) {
    const log = activityLog(this.fileUses.get(requestId) ?? [], 200);
    log.add('query', text);
    this.fileUses.set(requestId, log.entries);
    try {
      const running = this.workspace.get(projectId, requestId);
      if (running.state === 'running')
        this.workspace.update(projectId, requestId, 'running', {
          ...(running.result ?? {}),
          activity: mergeActivity(running.result?.activity, log.entries),
        });
    } catch {
      /* The request ended meanwhile: the end of the run merges the lines. */
    }
  }
  /** The file lines merged into the finished request's activity (in time order). */
  private settleFileUses(projectId: string, requestId: string) {
    this.fileGrants.delete(requestId);
    const uses = this.fileUses.get(requestId);
    this.fileUses.delete(requestId);
    if (!uses?.length) return;
    try {
      const done = this.workspace.get(projectId, requestId);
      if (!done.result || done.state === 'running') return;
      this.workspace.update(projectId, requestId, done.state, {
        ...done.result,
        activity: mergeActivity(done.result.activity, uses),
      });
    } catch {
      /* The project is gone. */
    }
  }
  /**
   * The permission question for a path outside the project folders (SPEC-01.13 3): one card on the
   * running request, answered like the provider's own questions (`answerQuestions`). An answer
   * from a remote session never adds a folder for good.
   */
  private askFilePermission(
    projectId: string,
    requestId: string,
    folder: string,
    path: string,
    signal: AbortSignal,
    waitMs: number,
    action: PermissionAction = 'read',
  ): Promise<PermissionAnswer> {
    // Reading may be allowed for good ([이 폴더는 항상]); writing and running are asked each time.
    const card =
      action === 'read'
        ? {
            id: FILE_PERMISSION_CARD,
            title: `AI가 프로젝트 작업 폴더 밖의 파일을 읽으려 합니다 · ${path}`,
            blocks: 'AI 파일 읽기',
            options: [
              { id: 'once', label: '이번만', hint: `이 요청 동안 ${folder} 읽기 허용` },
              { id: 'always', label: '이 폴더는 항상', hint: `${folder}를 읽기 허용 폴더에 추가` },
              { id: 'deny', label: '거절', hint: '읽지 않고 AI에 거절로 알림', recommended: true },
            ],
            allowFree: false,
          }
        : {
            id: FILE_PERMISSION_CARD,
            title:
              action === 'write'
                ? `AI가 프로젝트 작업 폴더 밖에 파일을 쓰려 합니다 · ${path}`
                : `AI가 프로젝트 작업 폴더 밖에서 명령을 실행하려 합니다 · ${path}`,
            blocks: action === 'write' ? 'AI 파일 쓰기' : 'AI 명령 실행',
            options: [
              {
                id: 'once',
                label: '이번만',
                hint:
                  action === 'write'
                    ? `이 요청 동안 ${folder}에 쓰기 허용`
                    : `이 요청 동안 ${folder}에서 실행 허용`,
              },
              { id: 'deny', label: '거절', hint: '하지 않고 AI에 거절로 알림', recommended: true },
            ],
            allowFree: false,
          };
    let before: Record<string, unknown> | null = null;
    try {
      before = this.workspace.get(projectId, requestId).result;
    } catch {
      return Promise.resolve(null);
    }
    const run = this.active.get(requestId)?.controller.signal;
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), waitMs);
      const stop = () => done(null);
      const done = (answers: NativeQuestionAnswer[] | null, remote = false) => {
        if (this.nativeQuestions.get(requestId)?.answer !== done) return;
        this.nativeQuestions.delete(requestId);
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        run?.removeEventListener('abort', stop);
        try {
          const now = this.workspace.get(projectId, requestId);
          if (now.state === 'running')
            this.workspace.update(projectId, requestId, 'running', {
              ...(before ?? { phase: 'model', hostExecuted: false }),
              activity: mergeActivity(before?.activity, this.fileUses.get(requestId) ?? []),
            });
        } catch {
          /* The request ended meanwhile. */
        }
        const option = answers?.find((answer) => answer.id === FILE_PERMISSION_CARD)?.option;
        resolve(
          option === 'always'
            ? remote
              ? 'once'
              : 'always'
            : option === 'once'
              ? 'once'
              : option === 'deny'
                ? 'deny'
                : null,
        );
      };
      if (signal.aborted || run?.aborted) return done(null);
      signal.addEventListener('abort', stop, { once: true });
      run?.addEventListener('abort', stop, { once: true });
      this.nativeQuestions.set(requestId, { projectId, cards: [card], answer: done });
      this.workspace.update(projectId, requestId, 'running', {
        ...(before ?? {}),
        phase: 'question',
        hostExecuted: false,
        questions: [card],
      });
    });
  }
  /**
   * The handler of one turn's native questions: the cards go on the request (phase `question`,
   * shown on the question cards) until the person answers (`answerQuestions`) or the turn stops.
   */
  private questionHandler(projectId: string, requestId: string): NativeQuestionHandler {
    return (cards, signal) =>
      new Promise((resolve) => {
        // What the request showed before the question (a host turn's activity) stays on it.
        let before: Record<string, unknown> | null = null;
        try {
          before = this.workspace.get(projectId, requestId).result;
        } catch {
          return resolve(null);
        }
        const { questions: _shown, ...kept } = before ?? {};
        const done = (answers: NativeQuestionAnswer[] | null) => {
          if (this.nativeQuestions.get(requestId)?.answer !== done) return;
          this.nativeQuestions.delete(requestId);
          signal.removeEventListener('abort', stop);
          try {
            this.workspace.update(projectId, requestId, 'running', {
              ...kept,
              phase: 'model',
              hostExecuted: false,
            });
          } catch {
            /* The request ended meanwhile. */
          }
          resolve(answers);
        };
        const stop = () => done(null);
        if (signal.aborted) return resolve(null);
        signal.addEventListener('abort', stop, { once: true });
        this.nativeQuestions.set(requestId, { projectId, cards, answer: done });
        this.workspace.update(projectId, requestId, 'running', {
          ...kept,
          phase: 'question',
          hostExecuted: false,
          questions: cards,
        });
      });
  }
  /**
   * The mid-run question handler of one turn (SPEC-02.19 6, ADR-026 4), the same rule for both
   * providers: a conversation turn (host or not) with AI가 작업 도중에 묻기 on asks with the provider's
   * own tool — Claude's AskUserQuestion, Codex's requestUserInput on the app-server — and goes on
   * in the same run with the answer. Elsewhere, or with the switch off, the run finishes first and
   * the answer goes to the next turn. VIDE_NATIVE_QUESTIONS=0 turns Claude's off and
   * VIDE_CODEX_APP_SERVER=0 Codex's (`codex exec` cannot ask mid-run); an injected provider
   * factory (tests) opts in with VIDE_NATIVE_QUESTIONS=1.
   */
  midRunQuestions(
    provider: string,
    conversationTurn: boolean,
    projectId: string,
    requestId: string,
  ): NativeQuestionHandler | undefined {
    if (!conversationTurn || !this.questionsOn()) return undefined;
    if (provider === 'codex-cli' ? !codexAppServerEnabled() : provider !== 'claude-cli')
      return undefined;
    if (this.providerFactory !== createProvider)
      return process.env.VIDE_NATIVE_QUESTIONS === '1'
        ? this.questionHandler(projectId, requestId)
        : undefined;
    if (provider === 'claude-cli' && !nativeQuestionsEnabled()) return undefined;
    return this.questionHandler(projectId, requestId);
  }
  /**
   * The person's answers to a running turn's native questions or file permission question (the
   * question cards); `remote` marks an answer from a remote session.
   */
  answerQuestions(
    projectId: string,
    requestId: string,
    answers: NativeQuestionAnswer[],
    remote = false,
  ): { ok: true } {
    const waiting = this.nativeQuestions.get(requestId);
    if (!waiting || waiting.projectId !== projectId) throw new DomainError('NOT_FOUND');
    const known = new Set(waiting.cards.map((card) => card.id));
    waiting.answer(
      answers.filter((answer) => known.has(answer.id)),
      remote,
    );
    return { ok: true };
  }
  async models() {
    // Explicit models only: a "CLI default" entry hid which model actually ran. ChatGPT models
    // come from the Codex CLI's own catalog; Claude Code keeps none, so the current family is listed.
    // `images`: the model reads images (SPEC-09.3 6); the Claude family does, Codex says per model.
    const catalog: {
      id: string;
      name: string;
      provider: string;
      efforts: string[];
      images: boolean;
    }[] = [];
    for (const [id, name] of CLAUDE_MODELS)
      catalog.push({ id, name, provider: 'claude-cli', efforts: claudeEfforts(id), images: true });
    // The Codex CLI keeps its model list in its folder (the default login's); without one, the
    // CLI's own default model.
    const codexCache = z.object({
      models: z
        .array(
          z.object({
            slug: z.string(),
            visibility: z.string().optional(),
            display_name: z.string().optional(),
            supported_reasoning_levels: z.array(z.object({ effort: z.string() })).optional(),
            input_modalities: z.array(z.string()).optional(),
          }),
        )
        .optional(),
    });
    for (const folder of [join(homedir(), '.codex')]) {
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
              images: model.input_modalities ? model.input_modalities.includes('image') : true,
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
        images: true,
      });
    try {
      const settings = z
        .object({ model: z.string().optional() })
        .parse(JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8')));
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
          images: true,
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
    const completion = this.traced(
      request,
      withTrace({ requestId: request.id }, () => this.run(request, controller)),
    ).finally(async () => {
      this.active.delete(request.id);
      this.pump(request.projectId);
      if (this.onFinished)
        try {
          await this.onFinished(this.workspace.get(request.projectId, request.id));
        } catch {
          /* A listener's failure never changes the run's outcome. */
        }
    });
    this.active.set(request.id, { controller, completion, projectId: request.projectId });
  }
  private closing = false;
  /** A write outside the request table ended (a jig's direct bake): the waiting requests go on. */
  resume(projectId: string) {
    this.pump(projectId);
  }
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
        // The file tools' lines join the finished request's activity (SPEC-01.13 2).
        this.settleFileUses(request.projectId, request.id);
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
      this.intervened.delete(predecessorId);
      if (controller.signal.aborted) {
        this.workspace.update(projectId, request.id, 'cancelled');
        return;
      }
      const previous = this.workspace.get(projectId, predecessorId);
      const children = this.workspace
        .list(projectId)
        .filter((row) => row.input.parentRequestId === predecessorId);
      // A legacy linked predecessor's partial result cannot be resumed safely; an unresolved
      // result of a direct one does not stop it (SPEC-02.13 7, T-102): its turn is told instead.
      if (children.some((row) => row.state === 'unknown' || row.result?.hostExecuted)) {
        this.workspace.update(projectId, request.id, 'interrupted', {
          code: 'INTERVENTION_REVIEW_REQUIRED',
        });
        return;
      }
      // Its own turn now (SPEC-02.9): a busy document or a full AI turn limit puts it in line
      // (started by `pump`).
      const admission = this.workspace.admission(projectId, request.id);
      if (admission.code) {
        this.workspace.update(projectId, request.id, 'interrupted', { code: admission.code });
        return;
      }
      if (admission.waitingFor) {
        this.workspace.wait(projectId, request.id, admission.waitingFor);
        return;
      }
      await this.traced(
        request,
        withTrace({ requestId: request.id }, () => this.run(request, controller)),
      );
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
    this.intervened.add(predecessorId);
    predecessor.controller.abort();
    return request;
  }
  /**
   * The project read tools of a host modeling turn (SPEC-02.6, T-062): other linked files' layers
   * and Sync samples and the project's facts, read from VIDE's own records. A turn outside an
   * explicit conversation belongs to the project's default conversation. Undefined without the
   * tool server or when the project's records cannot be opened (the turn keeps its host tools).
   */
  private projectTools(projectId: string, requestId: string, turn?: Turn) {
    if (!this.tools) return undefined;
    try {
      const conversation = turn?.conversation ?? this.conversations?.defaultRow(projectId);
      return hostTurnProjectHandlers(
        this.workspace,
        {
          // Only the reads: never the make tools of a jig-make conversation.
          id: conversation?.id ?? defaultConversationId(projectId),
          projectId,
          jigInstanceId: conversation?.jigInstanceId ?? null,
          targets: conversation?.targets ?? null,
        },
        requestId,
      );
    } catch (error) {
      this.diagnostics?.write('host-project-tools-failed', {
        requestId,
        projectId,
        ...Diagnostics.error(error),
      });
      return undefined;
    }
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
      let done = this.workspace.get(projectId, id);
      // A host or jig turn's reference-board correction (T-090): the fenced block leaves the
      // text the user and the ledger read, and is kept checked for the board.
      if (
        turn.referenceBlock &&
        (done.state === 'succeeded' || done.state === 'needs-confirmation') &&
        done.result
      ) {
        const taken = takeReferenceBlock(done.result.text);
        if (taken) {
          const { text, ...fields } = taken;
          done = this.workspace.update(projectId, id, done.state, {
            ...done.result,
            text,
            ...fields,
            ...(fields.reference && turn.referenceBoard
              ? { referenceBoard: turn.referenceBoard }
              : {}),
          });
        }
      }
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
        const { previous: bakeBasis } = this.previousOf(projectId, input, false);
        let result: Record<string, unknown>;
        try {
          result = await this.sdk.runFixed({
            input,
            previous: bakeBasis,
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
        ...pinContext(pins),
        ...input.sketches.map((data, i) => ({ id: `sketch-${i}`, type: 'sketch', data })),
        ...input.files.map((data, i) => ({ id: `file-${i}`, type: 'file', data })),
        // Images go to the model as image content (PLAN-24; the CLI adapters split them out).
        ...(input.images ?? []).map((data, i) => ({ id: `image-${i}`, type: 'image', data })),
      ];
      // An earlier request whose host answer was lost on this turn's documents does not stop it
      // (SPEC-02.13 7, T-102): the turn is told so, to read the document before acting.
      if (!jigReview) {
        const note = unresolvedNote(unresolvedFor(input, this.workspace.claimRows(projectId)));
        if (note) items.push(note);
      }
      // Outside a conversation the run stays synchronous up to the provider call (no await).
      const pending = this.beginTurn(request);
      if (pending) turn = await pending;
      // Every host modeling turn reads the project beside its target (SPEC-02.6, T-062).
      const projectTools = jigReview ? undefined : this.projectTools(projectId, id, turn);
      if (input.linkedTargets) {
        if (!this.sdk || !this.zwcadSdk || !this.tools) throw { code: 'EXECUTOR_NOT_READY' };
        if (turn) items.push(...turn.items);
        await runLinked({
          request,
          workspace: this.workspace,
          tools: this.tools,
          drivers: { rhino: this.sdk, zwcad: this.zwcadSdk },
          items,
          projectTools,
          signal: controller.signal,
          provider: (agent) =>
            this.timed(
              id,
              this.provider(
                input,
                agent,
                turn?.session,
                {
                  mode: 'modeling',
                  projectId,
                  requestId: id,
                },
                this.midRunQuestions(input.provider, !!turn, projectId, id),
              ),
            ),
        });
        return;
      }
      const sdk = jigReview ? undefined : target === 'rhino' ? this.sdk : this.zwcadSdk;
      // The basis without its model when it is a display Sync (T-123); the old host path without
      // an SDK compares and builds from the whole model.
      const { previous, view: previousView } = jigReview
        ? { previous: undefined, view: undefined }
        : this.previousOf(projectId, input, !sdk && !!host);
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
      // A pin needs its source's object row, not its display model (PLAN-27, 2026-10-02).
      const referenced = pins.map((pin) => {
        const source = this.workspace.summary(projectId, pin.basis),
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
      if (sdk)
        items.push(
          ...modelContext(
            previous?.result,
            pins.filter((pin) => pin.basis === previous?.id).map((pin) => pin.id),
            previousView,
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
          projectTools,
          holder: this.holderOf(projectId, input.conversationId),
          targetName:
            typeof (previous.result.sourceDocument as { name?: unknown } | undefined)?.name ===
            'string'
              ? (previous.result.sourceDocument as { name: string }).name
              : undefined,
          linked: {
            list: () => this.liveLinks(projectId, { host: direct.host, ...direct.target }),
            driver: (host, document) => this.directDriverFor(host, document, false),
            // Another file is locked on its first write; held by a write that does not take turns
            // per execute it is refused, never waited for (ADR-027 5, SPEC-02.9 3).
            claim: (document) =>
              documentHolder(id, document, this.workspace.claimRows(projectId), {
                serialized: true,
              })?.code,
            unresolved: (document) =>
              unresolvedNote(unresolvedOn(id, document, this.workspace.claimRows(projectId)))?.data,
            intervened: () => this.intervened.has(id),
          },
          // gh_open / gh_save reach only the project work folder (ADR-033 6, ADR-031 8).
          workFolders: () => workFolderScope(this.folders, projectId, this.fileContext).write,
          protectedIds: pins
            .filter((pin) => pin.role !== 'target' && pin.basis === previous.id)
            .map((pin) => pin.id),
          provider: (agent) =>
            this.timed(
              id,
              this.provider(
                input,
                agent,
                turn?.session,
                {
                  mode: 'modeling',
                  projectId,
                  requestId: id,
                  host: target,
                },
                this.midRunQuestions(input.provider, !!turn, projectId, id),
              ),
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
          projectTools,
          signal: controller.signal,
          provider: (agent) =>
            this.timed(
              id,
              this.provider(
                input,
                agent,
                turn?.session,
                {
                  mode: 'modeling',
                  projectId,
                  requestId: id,
                  host: target,
                },
                this.midRunQuestions(input.provider, !!turn, projectId, id),
              ),
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
            requestId: id,
            ...(host ? { host: target } : {}),
          },
          this.midRunQuestions(input.provider, !!turn, projectId, id),
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
      if (error.code === 'PROVIDER_LIMIT') this.onProviderLimit?.(String(request.input.provider));
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

  /** A request's conversation and its title, shown to a turn waiting behind its execute. */
  private holderOf(projectId: string, conversationId: unknown) {
    const id = typeof conversationId === 'string' ? conversationId : null;
    let title: string | undefined;
    try {
      title = this.conversations?.list(projectId).find((entry) => entry.id === id)?.title;
    } catch {
      /* No title: the wait text says '다른 대화'. */
    }
    return { conversationId: id, ...(title ? { title } : {}) };
  }

  /**
   * The newest stored display Sync of an attached Rhino document (any project: the document is the
   * same), with its lazy view and the document revision it shows (T-123 `query`).
   */
  private storedDisplay(target: { instance: string; documentId: number }) {
    // Each project DB gives its newest; the newest of those (by creation time) is the one.
    const [row] = this.workspace.store
      .databases()
      .map(
        (db) =>
          db
            // Only requests stored per object are looked at (one manifest per Sync, newest first):
            // CROSS JOIN keeps sync_manifests the outer loop.
            .prepare(
              `SELECT w.id, w.projectId, w.createdAt, json_extract(w.result,'$.sourceDocument') AS source
          FROM sync_manifests m CROSS JOIN workspace_requests w ON w.id=m.requestId
          WHERE w.state='succeeded' AND json_extract(w.result,'$.displayOnly')=1
            AND json_extract(w.result,'$.sourceDocument.instance')=?
            AND json_extract(w.result,'$.sourceDocument.documentId')=?
          ORDER BY w.rowid DESC LIMIT 1`,
            )
            .get(target.instance, target.documentId) as
            | { id: string; projectId: string; createdAt: string; source: string }
            | undefined,
      )
      .filter((found) => found !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!row) return undefined;
    const sourceDocument = JSON.parse(row.source) as Record<string, unknown>;
    const view = this.workspace.model(row.projectId, row.id);
    if (!view || typeof sourceDocument.revision !== 'number') return undefined;
    return { view, revision: sourceDocument.revision, sourceDocument };
  }
  /**
   * A turn's basis (T-123). A display Sync stored per object gives its small result and a lazy view
   * (`Workspace.model`): nothing of its model is decoded. Any other basis (a work copy candidate, a
   * DWG import) and `needsModel` read the stored model once, as protection checks compare it.
   */
  private previousOf(
    projectId: string,
    input: Pick<RequestInput, 'id' | 'baseRequestId' | 'host'>,
    needsModel: boolean,
  ) {
    const base = this.workspace.baseline(projectId, input);
    if (!base) return { previous: undefined, view: undefined };
    const view = needsModel ? undefined : this.workspace.model(projectId, base.id);
    if (view && (base.result as { displayOnly?: unknown } | null)?.displayOnly === true) {
      const brief = this.workspace.brief(projectId, base.id);
      return { previous: { ...brief, result: parsedModel(brief.result) }, view };
    }
    const full = this.workspace.get(projectId, base.id);
    return { previous: { ...full, result: parsedModel(full.result) }, view: undefined };
  }
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
      // A query reads the document's stored Sync and asks Rhino only for what changed since it
      // (T-123); without a stored Sync, or when Rhino cannot tell the changes, the whole document.
      const reads = displayQuery(async () => {
        const stored = this.storedDisplay(target);
        if (stored)
          try {
            const changed = await sdk.liveSync(target, stored, stored.revision);
            const entries = stored.view.entries({ limit: Infinity });
            return {
              ...overlayDisplay(entries, changed.delta as never),
              units: changed.result.sourceDocument.units,
            };
          } catch {
            /* Rhino cannot tell (RESYNC_REQUIRED) or the read failed: read the document. */
          }
        // As the stored path gives it: rows without coordinate arrays or block definitions.
        const {
          sourceDocument,
          objects,
          scene,
          definitions: _definitions,
          ...model
        } = (await sdk.readLayers(target, {})) as Awaited<ReturnType<typeof sdk.readLayers>> & {
          objects?: Record<string, unknown>[];
          scene?: Record<string, unknown>[];
          definitions?: unknown;
        };
        return {
          ...model,
          ...overlayDisplay([], { objects: objects ?? [], scene: scene ?? [], removed: [] }),
          units: sourceDocument.units,
        };
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
        query: (options, token) => reads.page(options, token),
        vision: () => sdk.directView(target),
        fingerprint: () => sdk.fingerprint(target),
        // Grasshopper of that Rhino (ADR-033), when the executor has the method.
        ...(typeof sdk.grasshopper === 'function'
          ? {
              grasshopper: (method: GrasshopperMethod, params?: Record<string, unknown>) =>
                sdk.grasshopper(target, method, params),
            }
          : {}),
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
        execute: async (command) => {
          const started = Date.now();
          const result = await attached.directExecute(target, command);
          // Like runAttached: a failure that is neither a known answer nor a refusal before the
          // drawing was touched (a slow HOST_BUSY, HOST_READ_FAILED) leaves the drawing unknown.
          const code = (result as { code?: unknown }).code;
          if (
            !result.ok &&
            !result.guarded &&
            !(typeof code === 'string' && zwcadAnsweredCodes.has(code)) &&
            !directRefusal('zwcad', result, Date.now() - started)
          )
            return { ...result, code: 'HOST_RESULT_UNKNOWN' };
          return result;
        },
        undo: (undoId) => attached.directUndo(target, undoId),
        fingerprint: () => attached.fingerprint(target),
        // Another file's reads in a Rhino turn (ADR-027): entity pages by handle, like runAttached.
        query: (options) =>
          attached.query(target, {
            offset: options.offset ?? 0,
            limit: options.limit ?? 100,
            ...(options.objectIds
              ? { handles: options.objectIds.map((id) => id.replace(/^cad-/, '')) }
              : {}),
          }),
      };
    }
    return undefined;
  }
  /**
   * The project's linked files with the document each has open in a connected (plugin) window
   * right now (ADR-027): what a direct turn may read and edit beside its target. Only the hosts
   * the project links are asked (a project without host links asks none), at the same time.
   * `prefer`: the turn's target, for a file open in two windows.
   */
  async liveLinks(
    projectId: string,
    prefer?: { host: string; instance: string; documentId: number },
  ): Promise<LiveLink[]> {
    if (this.injectedLinks) return this.injectedLinks(projectId);
    const documentLinks = new DocumentLinks(this.workspace.store);
    const links = documentLinks.list(projectId);
    const hosts = new Set(links.filter((link) => !isFileLink(link)).map((link) => link.host));
    const [rhino, zwcad] = await Promise.all([
      hosts.has('rhino')
        ? this.sdk?.editors
            .list(true)
            .then((answer) => answer?.documents ?? [])
            .catch(() => [])
        : undefined,
      hosts.has('zwcad') ? this.zwcadSdk?.editors.attached.list().catch(() => []) : undefined,
    ]);
    // The links list's own matching and follow step (live-links.ts): a Save As since its last
    // poll is seen here too, and one window is one live row.
    const { rows, matched, ownedOpen } = await followOpenDocuments(
      documentLinks,
      projectId,
      [...(rhino ?? []), ...(zwcad ?? [])],
      async (link) =>
        link.host === 'rhino'
          ? await this.sdk?.editors.has(link.instance)
          : await this.zwcadSdk?.editors.has(link.instance),
      prefer,
    );
    return liveLinksOf(rows, matched, ownedOpen);
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
    const { code: _code, body: _body, changes, ...entry } = record;
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
    // In the document's execute turn (SPEC-02.9 3): never between another conversation's execute
    // and its record.
    const answer = await queuedDriver(driver, {
      requestId: id,
      ...this.holderOf(projectId, request.input.conversationId),
    }).undo(entry.undoId);
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
   * [확인함] (POST …/requests/:rid/acknowledge, SPEC-02.13 7, T-102): the user has looked at the
   * document and closes an unresolved request. It settles to the state an undo would have restored
   * (`settles`), else `interrupted`, keeping its record, its code and `acknowledgedAt`. Later turns
   * are no longer told about it. Any other state answers as it is (already settled).
   */
  acknowledge(projectId: string, id: string) {
    const request = this.workspace.get(projectId, id);
    // A legacy linked request ends succeeded or failed while a host child of it stays unknown
    // (children are not listed on their own): its [확인함] closes those children.
    for (const child of this.workspace.list(projectId))
      if (child.input.parentRequestId === id && child.state === 'unknown')
        this.acknowledge(projectId, child.id);
    if (request.state !== 'unknown') return request;
    // An application to the source has its own command row and reconcile ('결과 다시 확인'):
    // closing only the request would leave that row unknown and its document refused.
    if (typeof request.result?.applicationId === 'string') return request;
    if (this.active.has(id)) throw new DomainError('REVISION_CONFLICT');
    const {
      heldOnly: _heldOnly,
      settles,
      ...rest
    } = (request.result ?? {}) as Record<string, unknown>;
    const back = settles as { state?: unknown; code?: unknown } | undefined;
    const state =
      typeof back?.state === 'string' && back.state !== 'unknown'
        ? (back.state as typeof request.state)
        : 'interrupted';
    return this.workspace.update(projectId, id, state, {
      ...rest,
      phase: undefined,
      code:
        state === 'interrupted'
          ? 'HOST_RESULT_UNKNOWN'
          : typeof back?.code === 'string'
            ? back.code
            : undefined,
      acknowledgedAt: new Date().toISOString(),
    });
  }
  /**
   * [되돌리기] of a whole request (POST …/requests/:rid/undo {all: true}, ADR-027 2): every applied
   * execution, in every file, last first. A file whose undo the host refuses keeps its remaining
   * executions (named in `files` and the result's `undo`); a lost undo answer leaves the request
   * unknown on that file until a later [되돌리기] the host answers there (`afterRequestUndo`).
   */
  async undoRequest(projectId: string, id: string) {
    const request = this.workspace.get(projectId, id);
    if (this.active.has(id) || ['queued', 'running'].includes(request.state))
      throw new DomainError('REVISION_CONFLICT');
    const records = executionsOf(request.result);
    // An unresolved request without any execution record has nothing an undo could settle: the
    // [되돌리기] closes it as [확인함] does (T-102), instead of leaving it unknown for good.
    if (request.state === 'unknown' && !records.length)
      return { ok: true, files: [], request: this.acknowledge(projectId, id) };
    // An unresolved request runs it anyway: an unknown it can settle may have nothing left to undo.
    if (
      request.state !== 'unknown' &&
      !records.some((entry) => entry.state === 'applied' && entry.undoId)
    )
      return { ok: true, already: true, files: [], request };
    const hostOf = (record: ExecutionRecord) =>
      record.host ?? (request.result?.host === 'zwcad' ? 'zwcad' : 'rhino');
    const who = { requestId: id, ...this.holderOf(projectId, request.input.conversationId) };
    const outcome = await undoExecutions(records, (record) => {
      const driver = this.directDriverFor(
        hostOf(record),
        record.target ?? request.result?.sourceDocument,
        false,
      );
      return driver && queuedDriver(driver, who);
    });
    // Re-read: the request may have changed while the hosts answered.
    const now = this.workspace.get(projectId, id);
    const target = hostTargetSchema.safeParse(now.result?.sourceDocument).data;
    const next = afterRequestUndo(now, outcome, (record) =>
      documentKey(hostOf(record), record.target ?? target ?? { instance: '', documentId: -1 }),
    );
    const updated = this.workspace.update(
      projectId,
      id,
      next.state as typeof now.state,
      next.result,
    );

    for (const entry of records)
      if (outcome.undone.has(entry.executionId))
        this.ledgerExecution(updated, { ...entry, state: 'undone' });
    return {
      ok: outcome.files.every((file) => file.state === 'undone'),
      files: outcome.files,
      request: updated,
    };
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
    // An earlier refusal of this [진행] no longer describes the request once it runs again.
    const { refused: _refused, ...base } = (request.result ?? {}) as Record<string, unknown>;
    if (entry?.code && entry.target && !driver) {
      // The held body's document is closed or reopened as another window: re-running the whole
      // turn with every guard released would approve guards the user never saw (saves, exports
      // in other files). Nothing runs; the card stays with the reason (review finding, 2026-10-02).
      const host = entry.host ?? 'rhino';
      const name = entry.file?.name ?? `${host === 'zwcad' ? 'ZWCAD' : 'Rhino'} 문서`;
      const refusal = directRefusal(host, { code: 'STALE_CONNECTION' })!;
      return this.workspace.update(projectId, id, 'needs-confirmation', {
        ...base,
        phase: undefined,
        refused: { code: refusal.code, reason: refusal.reason, file: name },
      });
    }
    if (!entry?.code || !driver) {
      this.start({ ...request, input: { ...request.input, guardConfirmed: true } });
      return this.workspace.get(projectId, id);
    }
    const name = entry.file?.name ?? `${driver.host === 'zwcad' ? 'ZWCAD' : 'Rhino'} 문서`;
    // A multi-file request waiting on its card holds no document (SPEC-02.13 4): the document is
    // checked again before the re-run, refused at once when another request writes it (SPEC-02.9
    // 3, ADR-027 5). A one-file request on its target runs as before.
    const multi = base.multiFile === true;
    const target = hostTargetSchema.safeParse(base.sourceDocument).data;
    const elsewhere =
      target?.instance !== driver.target.instance ||
      target?.documentId !== driver.target.documentId;
    const held =
      multi || elsewhere
        ? documentHolder(
            id,
            { host: driver.host, ...driver.target },
            this.workspace.claimRows(projectId),
            { serialized: true },
          )
        : undefined;
    if (held)
      return this.workspace.update(projectId, id, 'needs-confirmation', {
        ...base,
        phase: undefined,
        refused: { code: held.code, reason: lockRefusal(held.code, name).reason, file: name },
      });
    this.workspace.update(projectId, id, 'running', { ...base, phase: 'host' });
    const runId = randomUUID();
    const started = Date.now();
    let outcome: Awaited<ReturnType<DirectDriver['execute']>> | undefined;
    let lost: unknown;
    try {
      // The re-run takes the document's execute turn (SPEC-02.9 3); no stale check: the user
      // confirmed this body.
      outcome = await queuedDriver(driver, {
        requestId: id,
        ...this.holderOf(projectId, request.input.conversationId),
      }).execute({
        requestId: runId,
        code: entry.code,
        ...(entry.language ? { language: entry.language } : {}),
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
    // The answer was lost, or the host could not revert a change: the document may or may not hold
    // the record (fingerprint decides). A multi-file request rolls the other files back.
    if (!outcome || hostLeftUnknown(outcome)) {
      if (multi) return this.rollBackConfirmed(request, base, entry, driver, 'HOST_RESULT_UNKNOWN');
      return this.workspace.update(projectId, id, 'unknown', {
        ...base,
        phase: 'host',
        code: 'HOST_RESULT_UNKNOWN',
      });
    }
    if (!outcome.ok) {
      const failed = {
        code: typeof outcome.code === 'string' ? outcome.code : 'EXECUTION_FAILED',
        ...(outcome.diagnostics ? { diagnostics: outcome.diagnostics } : {}),
      };
      // All or nothing (ADR-027 3): the request ends failed, so what it applied elsewhere goes.
      if (multi) return this.rollBackConfirmed(request, base, entry, driver, undefined, failed);
      // The held row ends failed with the request (no card is left to press again).
      const { guarded: _held, ...ended } = base;
      return this.workspace.update(projectId, id, 'failed', {
        ...ended,
        phase: undefined,
        ...failed,
        executions: executions.map((e) =>
          e.executionId === entry.executionId ? publicRecord({ ...e, state: 'failed' }) : e,
        ),
      });
    }
    const applied: ExecutionRecord = {
      executionId: runId,
      host: driver.host,
      target: driver.target,
      ...(entry.file ? { file: entry.file } : {}),
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
   * A multi-file request whose confirmed re-run failed (ADR-027 3·6, SPEC-02.13 6): its applied
   * executes are undone in every file, last first, like the turn's own rollback. `lost`: the re-run's
   * answer was lost, so its document is left alone and stays unknown.
   */
  private async rollBackConfirmed(
    request: StoredWork,
    base: Record<string, unknown>,
    entry: ExecutionRecord,
    driver: DirectDriver,
    lost?: 'HOST_RESULT_UNKNOWN',
    failed: Record<string, unknown> = {},
  ) {
    const { projectId, id } = request;
    const executions = executionsOf(request.result);
    const here = documentKey(driver.host, driver.target);
    const hostOf = (record: ExecutionRecord) =>
      record.host ?? (request.result?.host === 'zwcad' ? 'zwcad' : 'rhino');
    const who = { requestId: id, ...this.holderOf(projectId, request.input.conversationId) };
    const outcome = await undoExecutions(
      executions,
      (record) => {
        const target = this.directDriverFor(
          hostOf(record),
          record.target ?? request.result?.sourceDocument,
          false,
        );
        return target && queuedDriver(target, who);
      },
      { skip: lost ? new Set([here]) : undefined },
    );
    const name = entry.file?.name ?? `${driver.host === 'zwcad' ? 'ZWCAD' : 'Rhino'} 문서`;
    if (lost && !outcome.files.some((file) => documentKey(file.host, file.target) === here))
      outcome.files.push({
        host: driver.host,
        target: driver.target,
        ...(entry.file?.linkId ? { linkId: entry.file.linkId } : {}),
        name,
        state: 'unknown',
        undone: 0,
        kept: 0,
        reason: 'HOST_RESULT_UNKNOWN',
      });
    const unknown = outcome.files.filter((file) => file.state === 'unknown');
    const left = outcome.files.filter((file) => file.state !== 'undone');
    const activity = activityLog(Array.isArray(base.activity) ? base.activity : []);
    activity.add(
      left.length ? 'error' : 'result',
      left.length
        ? `실패해서 자동으로 되돌림 · 되돌리지 못한 파일 ${left.map((file) => file.name).join(', ')}`
        : `실패해서 자동으로 되돌림 · 파일 ${outcome.files.length}개`,
    );
    // The held row ends failed with the request (no card is left to press again).
    const { guarded: _held, ...ended } = base;
    const result: Record<string, unknown> = {
      ...ended,
      ...failed,
      phase: unknown.length ? 'host' : undefined,
      activity: activity.entries,
      executions: executions.map((record) =>
        outcome.undone.has(record.executionId)
          ? { ...record, state: 'undone' as const, undoneAt: outcome.at }
          : record.executionId === entry.executionId
            ? publicRecord({ ...record, state: 'failed' })
            : record,
      ),
      rollback: { at: outcome.at, reason: 'failed', files: outcome.files },
    };
    if (unknown.length) {
      Object.assign(result, {
        code: 'HOST_RESULT_UNKNOWN',
        documents: unknown.map((file) => ({
          host: file.host,
          ...file.target,
          ...(file.linkId ? { linkId: file.linkId } : {}),
          name: file.name,
          pending: lost && documentKey(file.host, file.target) === here ? 'execute' : 'undo',
        })),
        heldOnly: true,
        settles: {
          state: 'failed',
          ...(typeof failed.code === 'string' ? { code: failed.code } : {}),
        },
      });
    }
    const updated = this.workspace.update(
      projectId,
      id,
      unknown.length ? 'unknown' : 'failed',
      result,
    );
    for (const record of executions)
      if (outcome.undone.has(record.executionId))
        this.ledgerExecution(updated, { ...record, state: 'undone' });
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
    // Codex app-server processes kept between turns do not outlive the engine (whatever the
    // setting is now: it may have been on when they started).
    await closeCodexAppServers().catch(() => {});
    await closeClaudeProcesses().catch(() => {});
  }
}
