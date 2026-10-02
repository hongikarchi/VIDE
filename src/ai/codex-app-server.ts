// Codex through `codex app-server` (stdio JSON-RPC; SPIKE-2026-09-30-codex-app-server): an
// alternative to one `codex exec` run per turn. One process per conversation keeps the thread
// loaded between turns; a question the model asks with its own tool (`item/tool/requestUserInput`)
// becomes VIDE's question card. On by default (2026-10-01 user decision, like Claude's own
// questions, ADR-026 4); `VIDE_CODEX_APP_SERVER=0` or Settings → AI 「AI가 작업 도중에 묻기」 off sends
// Codex through `codex exec` again. The isolation of `exec` is asserted here too, from what the server
// reports: read-only sandbox, no approvals, no user MCP servers (only VIDE's, with this turn's
// tools), no shell, web, apps or plugins, the developer instructions exactly the bundle's.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentConnection, WorkFolders } from './agent-connection.ts';
import { builtinRule, instructionFor } from './agent-connection.ts';
import { withRules } from './instructions/index.ts';
import { defaultLogin } from './account-usage.ts';
import {
  IdleClock,
  MAX_EVENT_LINE,
  MODE_CHANGED,
  ProviderError,
  SESSION_LOST,
  USAGE_LIMIT,
  buildPacket,
  killOwnedProcess,
  outputSchemaOf,
  withTurnRules,
  type CliOptions,
  type NativeQuestionAnswer,
  type NativeQuestionCard,
  type NativeQuestionHandler,
  type PacketImage,
  type Progress,
  type ProviderContext,
  type ProviderResult,
} from './claude-cli.ts';
import {
  CodexCli,
  codexDisabled,
  codexInstructions,
  codexSandbox,
  codexWritableRoots,
  codexIsolationConfig,
  makeOutputSchema,
  removeCodexTranscript,
  withDraftFiles,
} from './codex-cli.ts';

const error = (code: string) => new ProviderError(code);

/** The flag (config): on unless `VIDE_CODEX_APP_SERVER=0`, which forces the `exec` path. */
export const CODEX_APP_SERVER_FLAG = 'VIDE_CODEX_APP_SERVER';
export function codexAppServerEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env[CODEX_APP_SERVER_FLAG] !== '0';
}

// --- process arguments -------------------------------------------------------------------------

/**
 * The app-server's arguments: the `exec` isolation (shared builders in codex-cli.ts) at process
 * level, and the model's own question tool on. `app-server` has no `--ignore-user-config`: the
 * user's MCP servers are switched off per thread (`appServerThreadConfig`) and checked after.
 * A turn with VIDE's MCP connection needs code mode (the installed Codex routes MCP through it,
 * as in `configureAgentArguments`); shell stays off either way.
 */
export function appServerArguments({
  codeMode = false,
  files,
}: { codeMode?: boolean; files?: WorkFolders } = {}) {
  const args = ['app-server', '--listen', 'stdio://'];
  for (const value of codexIsolationConfig) args.push('-c', value);
  args.push('-c', 'sandbox_mode="read-only"');
  // A turn with a work folder keeps Codex's shell and image viewer (ADR-031 8); the thread's
  // sandbox and approvals then scope them.
  for (const flag of codexDisabled(files))
    if (!(codeMode && (flag === 'code_mode' || flag === 'code_mode_host')))
      args.push('--disable', flag);
  if (codeMode) args.push('--enable', 'code_mode', '--enable', 'code_mode_host');
  args.push('--enable', 'skip_host_skill_discovery', '--enable', 'default_mode_request_user_input');
  return args;
}
/** The process arguments carry the isolation (asserted before spawning). */
export function appServerIsolated(args: readonly string[], codeMode: boolean, shell = false) {
  const configs = args.filter((_, index) => args[index - 1] === '-c');
  const disabled = (flag: string) =>
    args.some((value, index) => value === flag && args[index - 1] === '--disable');
  const enabled = (flag: string) =>
    args.some((value, index) => value === flag && args[index - 1] === '--enable');
  return (
    args[0] === 'app-server' &&
    args[1] === '--listen' &&
    args[2] === 'stdio://' &&
    codexIsolationConfig.every((value) => configs.includes(value)) &&
    configs.includes('sandbox_mode="read-only"') &&
    !configs.some((value) => value.startsWith('mcp_servers') && value !== 'mcp_servers={}') &&
    !configs.some((value) => value.startsWith('developer_instructions')) &&
    ['unified_exec', 'apps', 'plugins', 'hooks', 'browser_use', 'computer_use'].every(disabled) &&
    (shell ? !disabled('shell_tool') : disabled('shell_tool')) &&
    (codeMode
      ? enabled('code_mode') && enabled('code_mode_host')
      : disabled('code_mode') && disabled('code_mode_host')) &&
    enabled('default_mode_request_user_input')
  );
}

// --- thread parameters -------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** VIDE's MCP server entry: this turn's URL, token (in memory, not on the command line) and tools. */
export function videServerConfig(connection: AgentConnection): { [key: string]: Json } {
  return {
    url: connection.url,
    http_headers: { Authorization: `Bearer ${connection.token}` },
    enabled_tools: [...connection.tools],
    default_tools_approval_mode: 'approve',
    required: true,
    tool_timeout_sec: 60,
  };
}
/**
 * The thread's config overrides: web search off, every MCP server of the user's config off, and
 * VIDE's server with this turn's tools when the turn has a connection.
 */
/**
 * The work folder sandbox's config (ADR-031 8): the folder's other roots writable, no network, and
 * the temporary folders left out (Codex adds them by default, so a write there would not ask).
 */
export function workspaceWriteConfig(files?: WorkFolders): { [key: string]: Json } {
  return {
    writable_roots: codexWritableRoots(files),
    network_access: false,
    exclude_tmpdir_env_var: true,
    exclude_slash_tmp: true,
  };
}
export function appServerThreadConfig(
  userServers: readonly string[],
  connection?: AgentConnection,
  effort?: string,
  web = false,
  files?: WorkFolders,
) {
  const config: { [key: string]: Json } = {
    // Web search only for a turn that has it (Settings → AI 「AI 웹 검색」, ADR-028).
    web_search: web && connection ? 'live' : 'disabled',
    project_doc_max_bytes: 0,
  };
  // Writes in the work folder only, without network (ADR-031 8).
  if (codexSandbox(files) === 'workspace-write')
    config.sandbox_workspace_write = workspaceWriteConfig(files);
  for (const name of userServers) {
    if (!SERVER_NAME.test(name)) throw error('UNEXPECTED_TOOL_ACCESS');
    if (!(connection && name === 'vide')) config[`mcp_servers.${name}.enabled`] = false;
  }
  if (connection) config['mcp_servers.vide'] = videServerConfig(connection);
  if (effort) config.model_reasoning_effort = effort;
  return config;
}
export interface ThreadParams {
  threadId?: string;
  cwd: string;
  sandbox: string;
  approvalPolicy: string;
  developerInstructions: string;
  model?: string;
  ephemeral?: boolean;
  excludeTurns?: boolean;
  config: { [key: string]: Json };
}
/** The thread parameters carry the isolation (asserted before they are sent). */
export function threadParamsIsolated(
  params: ThreadParams,
  expected: {
    instructions: string;
    userServers: readonly string[];
    connection?: AgentConnection;
    web?: boolean;
    files?: WorkFolders;
  },
) {
  const { config } = params;
  const sandbox = codexSandbox(expected.files);
  const serverKeys = Object.keys(config).filter((key) => key.startsWith('mcp_servers'));
  const wanted = new Set(
    expected.userServers
      .filter((name) => !(expected.connection && name === 'vide'))
      .map((name) => `mcp_servers.${name}.enabled`),
  );
  if (expected.connection) wanted.add('mcp_servers.vide');
  return (
    params.sandbox === sandbox &&
    // A work folder asks the user outside it (Codex's approvals reach VIDE's permission handler).
    params.approvalPolicy === (expected.files ? 'untrusted' : 'never') &&
    (sandbox === 'workspace-write'
      ? JSON.stringify(config.sandbox_workspace_write) ===
        JSON.stringify(workspaceWriteConfig(expected.files))
      : !('sandbox_workspace_write' in config)) &&
    params.developerInstructions === expected.instructions &&
    !('baseInstructions' in params) &&
    config.web_search === (expected.web && expected.connection ? 'live' : 'disabled') &&
    config.project_doc_max_bytes === 0 &&
    serverKeys.length === wanted.size &&
    serverKeys.every((key) => wanted.has(key)) &&
    serverKeys.every((key) =>
      key === 'mcp_servers.vide'
        ? JSON.stringify(config[key]) === JSON.stringify(videServerConfig(expected.connection!))
        : config[key] === false,
    )
  );
}
interface ThreadResponse {
  thread?: { id?: unknown };
  sandbox?: { type?: unknown; networkAccess?: unknown };
  approvalPolicy?: unknown;
  instructionSources?: unknown;
}
/**
 * What the server says the thread runs with: read-only (a work folder: writes there), no network,
 * no approvals (a work folder: asked outside it), no AGENTS.md.
 */
export function threadResponseIsolated(response: ThreadResponse, files?: WorkFolders) {
  return (
    typeof response?.thread?.id === 'string' &&
    response.sandbox?.type ===
      (codexSandbox(files) === 'workspace-write' ? 'workspaceWrite' : 'readOnly') &&
    response.sandbox.networkAccess !== true &&
    response.approvalPolicy === (files ? 'untrusted' : 'never') &&
    Array.isArray(response.instructionSources) &&
    response.instructionSources.length === 0
  );
}
interface McpStatus {
  name: string;
  runtimeStatus: string | null;
  httpOrigin: string | null;
  tools?: Record<string, unknown>;
}
/**
 * The thread's MCP servers as the server reports them: every server but VIDE's is disabled; VIDE's
 * runs at this turn's origin with no tool outside the turn's list, or is absent/disabled.
 */
export function mcpStatusIsolated(servers: readonly McpStatus[], connection?: AgentConnection) {
  const vide = servers.filter((server) => server.name === 'vide');
  return (
    servers.every((server) => server.name === 'vide' || server.runtimeStatus === 'disabled') &&
    (connection
      ? vide.length === 1 &&
        vide[0].runtimeStatus !== 'disabled' &&
        vide[0].httpOrigin === new URL(connection.url).origin &&
        Object.keys(vide[0].tools ?? {}).every((name) => connection.tools.includes(name))
      : vide.every((server) => server.runtimeStatus === 'disabled'))
  );
}

// --- question cards ----------------------------------------------------------------------------

/** One requestUserInput question (EXPERIMENTAL in Codex 0.157). */
export interface NativeQuestion {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: { label: string; description?: string }[] | null;
}
/**
 * VIDE's question card (turn-output.ts `TurnQuestion`, the SCR question card), in the shape the
 * Claude path hands to the same handler (claude-cli.ts `NativeQuestionCard`).
 */
export interface QuestionCard extends NativeQuestionCard {
  options: { id: string; label: string; hint?: string; recommended: boolean }[];
  blocks: string | null;
}
const RECOMMENDED = /\s*\((recommended|권장|추천)\)\s*/i;
const MAX_CARDS = 3;
const clip = (value: string, max: number) => value.trim().slice(0, max);
/**
 * The cards of a requestUserInput request (at most three). The option marked "(Recommended)" (or
 * the first) is the recommended one and comes first; a question without two options gets a free
 * answer. A secret question is never shown: VIDE does not collect secrets.
 */
export function questionCards(questions: readonly NativeQuestion[]) {
  const cards: QuestionCard[] = [];
  const sources = new Map<string, NativeQuestion>();
  for (const [index, question] of questions.entries()) {
    if (cards.length >= MAX_CARDS || question.isSecret) continue;
    let id = String(question.id ?? '')
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 40);
    if (!id || sources.has(id)) id = `question-${index + 1}`;
    const listed = (question.options ?? []).slice(0, 5).map((option, i) => ({
      id: `option-${i + 1}`,
      label: clip(String(option.label ?? '').replace(RECOMMENDED, ' '), 80) || `선택 ${i + 1}`,
      ...(option.description && clip(String(option.description), 200)
        ? { hint: clip(String(option.description), 200) }
        : {}),
      recommended: RECOMMENDED.test(String(option.label ?? '')),
    }));
    const options =
      listed.length >= 2
        ? listed
        : [
            { id: 'free', label: '직접 입력', recommended: true },
            { id: 'skip', label: '넘어가기', hint: '판단을 AI에게 맡깁니다', recommended: false },
          ];
    const marked = Math.max(
      0,
      options.findIndex((option) => option.recommended),
    );
    const ordered = [options[marked], ...options.filter((_, i) => i !== marked)].map(
      (option, i) => ({ ...option, recommended: i === 0 }),
    );
    const title = clip(question.question || question.header || '', 200) || '확인이 필요합니다';
    cards.push({
      id,
      title,
      options: ordered,
      blocks: question.header ? clip(question.header, 200) || null : null,
      allowFree: listed.length < 2 || question.isOther === true,
    });
    sources.set(id, question);
  }
  return { cards, sources };
}
/** The requestUserInput response: each card's option label and/or free text by the question's id. */
export function nativeAnswers(
  questions: readonly NativeQuestion[],
  cards: readonly QuestionCard[],
  sources: ReadonlyMap<string, NativeQuestion>,
  answers: readonly NativeQuestionAnswer[],
) {
  const out: Record<string, { answers: string[] }> = {};
  for (const question of questions) out[question.id] = { answers: [] };
  for (const answer of answers) {
    const card = cards.find((entry) => entry.id === answer.id);
    const question = sources.get(answer.id);
    if (!card || !question) continue;
    const option = card.options.find((entry) => entry.id === answer.option);
    const values: string[] = [];
    if (option && option.id !== 'free' && option.id !== 'skip') {
      const original = question.options?.[Number(option.id.slice('option-'.length)) - 1]?.label;
      values.push(original ?? option.label);
    }
    if (answer.text && card.allowFree) values.push(clip(answer.text, 2000));
    out[question.id] = { answers: values };
  }
  return { answers: out };
}

// --- JSON-RPC over stdio -----------------------------------------------------------------------

interface Message {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string; code?: number };
}

/**
 * One app-server process: requests with ids, notifications and server requests to listeners. The
 * process lives between turns, so nothing it does may take the engine down (RESEARCH-13): every
 * stream and the child carry an 'error' listener for their whole life, and an exit nobody asked for
 * fails the running turn with PROVIDER_EXITED (the next turn starts a fresh process).
 */
export class AppServerRpc {
  child: ChildProcessWithoutNullStreams;
  closed = false;
  exitError?: ProviderError;
  /** Settles when the process was told to stop (true: it is gone). */
  stopped: Promise<boolean> = Promise.resolve(true);
  private next = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  private listeners = new Set<(message: Message) => void>();
  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        // One message per line: only a single line past the cap ends the process (ADR-028).
        if (line.length > MAX_EVENT_LINE) return this.fail('OUTPUT_TOO_LARGE');
        if (line.trim()) this.receive(line);
        if (this.closed) return;
      }
      if (buffer.length > MAX_EVENT_LINE) return this.fail('OUTPUT_TOO_LARGE');
    });
    child.stderr.on('data', () => {});
    // `on`, not `once`: a second 'error' without a listener would throw in the engine.
    child.stdin.on('error', () => this.fail('INPUT_DELIVERY_FAILED'));
    child.stdout.on('error', () => this.fail('PROVIDER_EXITED'));
    child.stderr.on('error', () => {});
    child.on('error', () => this.fail(this.started ? 'PROVIDER_EXITED' : 'CLI_UNAVAILABLE'));
    child.on('close', () => this.fail('PROVIDER_EXITED'));
  }
  /** The process answered once (an 'error' before that is a spawn failure). */
  private started = false;
  private receive(line: string) {
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      return this.fail('INVALID_PROVIDER_OUTPUT');
    }
    if (!message || typeof message !== 'object') return this.fail('INVALID_PROVIDER_OUTPUT');
    this.started = true;
    if (message.id !== undefined && !message.method) {
      const waiting = this.pending.get(Number(message.id));
      if (!waiting) return;
      this.pending.delete(Number(message.id));
      if (message.error)
        waiting.reject(
          Object.assign(error('RPC_ERROR'), { detail: String(message.error.message ?? '') }),
        );
      else waiting.resolve(message.result);
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch {
        /* A listener cannot break the connection. */
      }
    }
  }
  private write(message: unknown) {
    if (this.closed) return;
    try {
      this.child.stdin.write(JSON.stringify(message) + '\n');
    } catch {
      // A stream already destroyed (the process went away between two checks).
      this.fail('INPUT_DELIVERY_FAILED');
    }
  }
  fail(code: string) {
    if (this.closed) return;
    this.closed = true;
    this.exitError = error(code);
    for (const waiting of this.pending.values()) waiting.reject(this.exitError);
    this.pending.clear();
    for (const listener of [...this.listeners]) listener({ method: 'vide/closed' });
    this.stopped = killOwnedProcess(this.child);
  }
  request<T = unknown>(method: string, params: unknown, timeoutMs = 60000): Promise<T> {
    if (this.closed) return Promise.reject(this.exitError ?? error('PROVIDER_FAILED'));
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(error('TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }
  respond(id: number | string, result: unknown) {
    this.write({ id, result });
  }
  refuse(id: number | string, message: string) {
    this.write({ id, error: { code: -32000, message } });
  }
  listen(listener: (message: Message) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close() {
    this.fail('PROVIDER_FAILED');
    return this.stopped;
  }
}

// --- live threads ------------------------------------------------------------------------------

interface Live {
  rpc: AppServerRpc;
  processKey: string;
  threadKey: string;
  threadId: string;
  userServers: string[];
  cwd: string;
  busy: boolean;
  idle?: ReturnType<typeof setTimeout>;
}
/** One process per conversation thread, kept between turns until idle. */
const live = new Map<string, Live>();
export const APP_SERVER_IDLE_MS = 10 * 60 * 1000;
async function dispose(entry: Live) {
  clearTimeout(entry.idle);
  if (live.get(entry.threadId) === entry) live.delete(entry.threadId);
  await entry.rpc.close();
  // Windows keeps the folder busy for a moment after the process tree is ended.
  await rm(entry.cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
    () => {},
  );
}
/** Closes every kept process (server shutdown, tests). */
export async function closeCodexAppServers() {
  await Promise.all([...live.values()].map(dispose));
}
/** Closes the kept processes no turn is using (the questions setting was turned off). */
export async function closeIdleCodexAppServers() {
  await Promise.all([...live.values()].filter((entry) => !entry.busy).map(dispose));
}
/** The threads that have a process right now (diagnostics, tests). */
export function liveCodexThreads() {
  return [...live.keys()];
}

// --- the provider ------------------------------------------------------------------------------

/**
 * The model may ask with its own question tool (`request_user_input`): the turn rules and the
 * instructions otherwise forbid every tool, and the model then asks in plain text (spike,
 * 2026-09-30). It goes after the developer instructions and after a session turn's rules.
 */
export const questionRule =
  "Exception to the tool rules: you may ask the user with the request_user_input tool when a decision would change the result a lot and nothing supplied settles it: 1-3 questions in plain practical Korean, each with 2-5 options, the recommended option first and marked '(Recommended)'. It only asks the user; it is not a host, file, shell or web tool and grants nothing else. Never ask again what the ledger already holds.";
/** A session turn's rules item with the question tool allowed. */
export function withQuestionRule(context: ProviderContext): ProviderContext {
  return {
    ...context,
    items: context.items.map((item) =>
      item.id === 'turn-rules' && typeof item.data === 'string'
        ? { ...item, data: item.data + ' ' + questionRule }
        : item,
    ),
  };
}
type RunOptions = {
  signal?: AbortSignal;
  onProgress?: (event: Progress) => void;
  /**
   * Answers the model's own question mid-turn (the card is shown, the turn waits; null: closed
   * without answers, the model goes on); the provider's `nativeQuestions` option when left out.
   * With neither, the turn stops at the question and returns the cards as a `question` turn output; the answer then
   * comes in the next turn of the same thread (turn-output.ts formatAnswers).
   */
  onQuestion?: NativeQuestionHandler;
};
/** Items that are the model's own text (anything else is a tool item, reported or refused). */
const ALLOWED_ITEMS = new Set([
  'userMessage',
  'agentMessage',
  'reasoning',
  'plan',
  'contextCompaction',
]);
/** Codex's own tool items of a turn with a work folder (ADR-031 8). */
const WORK_ITEMS: Record<string, string> = {
  commandExecution: 'shell',
  fileChange: 'apply_patch',
  imageView: 'view_image',
};
/** The approval requests a work folder turn answers (each goes to VIDE's permission handler). */
const APPROVALS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);

/**
 * Who Codex's default login is (account and email of `~/.codex/auth.json`), '' when unreadable.
 * AccountSwitch may change it between turns (ADR-025); a kept process signed in as the earlier
 * account must not answer the next turn with that account's tokens.
 */
export function codexLoginKey(home = homedir()) {
  const login = defaultLogin('codex-cli', home);
  return login.token ? [login.account ?? '', login.email ?? ''].join('\0') : '';
}

export class CodexAppServer extends CodexCli {
  idleMs: number;
  /** Who the default login is now (test seam; default: `codexLoginKey`). */
  loginKey: () => string;
  constructor(options: CliOptions & { idleMs?: number; loginKey?: () => string } = {}) {
    super(options);
    this.idleMs = options.idleMs ?? APP_SERVER_IDLE_MS;
    this.loginKey = options.loginKey ?? (() => codexLoginKey());
  }
  /** The app-server answers Codex's approvals, so its turns get the work folder (ADR-031 8). */
  workFoldersSupported() {
    return true;
  }
  /**
   * The developer instructions: the session's neutral ones, or the bundle with the tool rules; the
   * question tool's rule after either.
   */
  developerInstructions() {
    let base: string;
    if (this.session || !this.agent)
      base = codexInstructions(this.session, this.instructions, this.builtin?.files);
    else {
      const own = instructionFor(this.agent, 'codex') + builtinRule(this.builtin, 'codex');
      base = this.instructions ? withRules(this.instructions, own) : own;
    }
    return `${base}\n\n${questionRule}`;
  }
  /** A kept process serves the next turn only for the same executable, login and tool mode. */
  private processKey() {
    return JSON.stringify([this.executable, this.loginKey(), !!this.agent, !!this.builtin?.files]);
  }
  private threadKey() {
    return JSON.stringify([
      this.developerInstructions(),
      this.model ?? '',
      this.effort ?? '',
      this.agent ? [this.agent.url, this.agent.token, this.agent.tools] : null,
      !!this.builtin?.web,
      this.builtin?.files ?? null,
    ]);
  }
  private async spawnServer(): Promise<{ rpc: AppServerRpc; userServers: string[]; cwd: string }> {
    const files = this.builtin?.files;
    // The installed Codex runs VIDE's MCP tools and its own shell through the code-mode host.
    const codeMode = !!this.agent || !!files;
    const args = appServerArguments({ codeMode, files });
    if (!appServerIsolated(args, codeMode, !!files)) throw error('UNEXPECTED_TOOL_ACCESS');
    const cwd = await mkdtemp(join(tmpdir(), 'vide-codex-'));
    let rpc: AppServerRpc | undefined;
    try {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(this.executable, args, {
          cwd,
          env: this.environment(),
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as ChildProcessWithoutNullStreams;
      } catch {
        // Spawning itself threw (bad path, no permission): the same as a missing executable.
        throw error('CLI_UNAVAILABLE');
      }
      rpc = new AppServerRpc(child);
      await rpc.request('initialize', {
        clientInfo: { name: 'vide', title: 'VIDE', version: '1' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      rpc.notify('initialized');
      const read = await rpc.request<{ config?: { mcp_servers?: Record<string, unknown> } }>(
        'config/read',
        { includeLayers: false, cwd },
      );
      return { rpc, userServers: Object.keys(read?.config?.mcp_servers ?? {}), cwd };
    } catch (cause) {
      rpc?.close();
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
      throw cause;
    }
  }
  /** Starts, resumes or reconfigures the thread; asserts parameters, response and MCP servers. */
  private async openThread(
    rpc: AppServerRpc,
    userServers: string[],
    cwd: string,
    resumeId: string | undefined,
  ) {
    const instructions = this.developerInstructions();
    const files = this.builtin?.files;
    const params: ThreadParams = {
      ...(resumeId ? { threadId: resumeId, excludeTurns: true } : { ephemeral: !this.session }),
      // The project work folder is the thread's working directory (ADR-031 8).
      cwd: files?.cwd ?? cwd,
      sandbox: codexSandbox(files),
      // Codex asks before every command it does not know as safe and every file change, so each
      // reaches VIDE's gate: inside the work folder allowed at once, outside asked. Codex's own
      // sandbox is not relied on (on this platform it did not stop a write outside its roots).
      approvalPolicy: files ? 'untrusted' : 'never',
      developerInstructions: instructions,
      ...(this.model ? { model: this.model } : {}),
      config: appServerThreadConfig(
        userServers,
        this.agent,
        this.effort,
        !!this.builtin?.web,
        files,
      ),
    };
    if (
      !threadParamsIsolated(params, {
        instructions,
        userServers,
        connection: this.agent,
        web: !!this.builtin?.web,
        files,
      })
    )
      throw error('UNEXPECTED_TOOL_ACCESS');
    let response: ThreadResponse;
    try {
      response = await rpc.request<ThreadResponse>(
        resumeId ? 'thread/resume' : 'thread/start',
        params,
      );
    } catch (cause) {
      const detail = String((cause as { detail?: unknown })?.detail ?? '');
      if (resumeId && SESSION_LOST.test(detail)) throw error('SESSION_LOST');
      throw cause;
    }
    if (!threadResponseIsolated(response, files)) throw error('UNEXPECTED_TOOL_ACCESS');
    const threadId = response.thread!.id as string;
    if (resumeId && threadId !== resumeId) throw error('SESSION_LOST');
    const servers: McpStatus[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const list: { data?: McpStatus[]; nextCursor?: string | null } = await rpc.request(
        'mcpServerStatus/list',
        { threadId, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) },
      );
      servers.push(...(list?.data ?? []));
      cursor = list?.nextCursor ?? null;
      if (!cursor) break;
    }
    if (cursor || !mcpStatusIsolated(servers, this.agent)) throw error('UNEXPECTED_TOOL_ACCESS');
    return threadId;
  }
  /** A kept process for a resumed conversation, or a new one (which resumes the thread from disk). */
  private async acquire(): Promise<{ entry: Live; opened: boolean }> {
    const resumeId = this.session?.resume ? this.session.id : undefined;
    let kept = resumeId ? live.get(resumeId) : undefined;
    // One running turn per conversation: a second one never shares or kills the first's process.
    if (kept?.busy) throw error('CONVERSATION_BUSY');
    if (kept && (kept.rpc.closed || kept.processKey !== this.processKey())) {
      await dispose(kept);
      kept = undefined;
    }
    if (kept) {
      clearTimeout(kept.idle);
      kept.busy = true;
      try {
        if (kept.threadKey !== this.threadKey()) {
          // This turn's tools, token or instructions differ: reload the thread with them.
          await kept.rpc.request('thread/unsubscribe', { threadId: kept.threadId });
          await this.openThread(kept.rpc, kept.userServers, kept.cwd, kept.threadId);
          kept.threadKey = this.threadKey();
        }
      } catch (cause) {
        await dispose(kept);
        throw cause;
      }
      return { entry: kept, opened: false };
    }
    const auth = await this.cachedStatus();
    if (!auth.available) throw error(auth.reason ?? 'AUTH_INVALID');
    const { rpc, userServers, cwd } = await this.spawnServer();
    const entry: Live = {
      rpc,
      processKey: this.processKey(),
      threadKey: this.threadKey(),
      threadId: '',
      userServers,
      cwd,
      busy: true,
    };
    try {
      entry.threadId = await this.openThread(rpc, userServers, cwd, resumeId);
    } catch (cause) {
      await dispose(entry);
      throw cause;
    }
    return { entry, opened: !resumeId };
  }
  private async release(entry: Live, keep: boolean) {
    entry.busy = false;
    if (!keep || entry.rpc.closed) return dispose(entry);
    live.set(entry.threadId, entry);
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => void dispose(entry), this.idleMs);
    entry.idle.unref?.();
  }
  /** The turn input: the packet as text, images as local files in the turn's own folder. */
  private async input(packet: unknown, images: readonly PacketImage[], folder: string) {
    const input: Record<string, unknown>[] = [
      { type: 'text', text: JSON.stringify(packet), text_elements: [] },
    ];
    for (const [index, image] of images.entries()) {
      const path = join(
        folder,
        `image-${index + 1}.${image.mediaType === 'image/png' ? 'png' : 'jpg'}`,
      );
      await writeFile(path, Buffer.from(image.data, 'base64'));
      input.push({ type: 'localImage', path });
    }
    return input;
  }
  async run(context: ProviderContext, options: RunOptions = {}): Promise<ProviderResult> {
    const { signal, onProgress = () => {}, onQuestion = this.nativeQuestions } = options;
    const progress = (event: Progress) => {
      try {
        onProgress(event);
      } catch {
        /* UI cannot change execution state. */
      }
    };
    let prepared = this.session
      ? withTurnRules(context, this.agent, 'codex', this.builtin)
      : context;
    if (this.agent?.draftDir) prepared = await withDraftFiles(prepared, this.agent.draftDir);
    prepared = withQuestionRule(prepared);
    const selected = buildPacket(prepared);
    let schema = outputSchemaOf(context);
    if (schema && this.agent?.draftDir) schema = makeOutputSchema(schema);
    if (signal?.aborted) throw error('CANCELLED');
    await this.checkVersion();
    if (signal?.aborted) throw error('CANCELLED');
    progress({ state: 'starting' });
    const { entry, opened } = await this.acquire();
    let keep = !!this.session,
      removeThread = false,
      folder: string | undefined;
    try {
      folder = await mkdtemp(join(tmpdir(), 'vide-cli-'));
      return await this.turn(entry, selected, schema, folder, { signal, progress, onQuestion });
    } catch (cause) {
      const code = (cause as { code?: unknown })?.code;
      // A stop the process did not confirm, or a broken process: it is not reused.
      if (code === 'STOP_UNCONFIRMED' || entry.rpc.closed) keep = false;
      // A failed opening turn: nobody can resume it, and only this run knows its thread.
      if (opened && this.session && code !== 'STOP_UNCONFIRMED') {
        keep = false;
        removeThread = true;
      }
      throw cause;
    } finally {
      // The process lets go of the transcript before it is removed.
      await this.release(entry, keep);
      if (removeThread) await removeCodexTranscript(undefined, entry.threadId).catch(() => 0);
      if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }
  private async turn(
    entry: Live,
    selected: ReturnType<typeof buildPacket>,
    schema: string | undefined,
    folder: string,
    {
      signal,
      progress,
      onQuestion,
    }: {
      signal?: AbortSignal;
      progress: (event: Progress) => void;
      onQuestion?: RunOptions['onQuestion'];
    },
  ): Promise<ProviderResult> {
    const { rpc, threadId } = entry;
    const input = await this.input(selected.packet, selected.images, folder);
    let turnId: string | undefined;
    let finalText = '',
      lastText = '',
      failureText = '',
      stopReason: string | undefined,
      asked: { cards: QuestionCard[] } | undefined,
      usage: Record<string, number> | undefined;
    const questionAbort = new AbortController();
    const result = await new Promise<{ status: string }>((resolve, reject) => {
      let settled = false,
        grace: ReturnType<typeof setTimeout> | undefined;
      const finish = (err: Error | null, value?: { status: string }) => {
        if (settled) return;
        settled = true;
        clock.stop();
        clearTimeout(grace);
        signal?.removeEventListener('abort', abort);
        questionAbort.abort();
        unlisten();
        err ? reject(err) : resolve(value!);
      };
      const stop = (reason: string) => {
        if (settled || stopReason) return;
        stopReason = reason;
        clock.stop();
        if (reason !== 'QUESTION') progress({ state: 'stopping', reason });
        const interrupt = turnId
          ? rpc.request('turn/interrupt', { threadId, turnId }, this.stopGraceMs)
          : Promise.reject(error('NO_TURN'));
        interrupt.catch(() => {});
        grace = setTimeout(() => {
          rpc.close();
          finish(error('STOP_UNCONFIRMED'));
        }, this.stopGraceMs);
      };
      const abort = () => stop('CANCELLED');
      // Only time without output counts (ADR-031 8): every message of this thread re-arms it, and a
      // tool item that has not completed (a long host execute, a shell command) holds it.
      const clock = new IdleClock(this.timeoutMs, () => stop('TIMEOUT'));
      signal?.addEventListener('abort', abort, { once: true });
      // The paths of each file change item, for its approval request (which names only the item).
      const changes = new Map<string, string[]>();
      const handle = (message: Message) => {
        if (message.method === 'vide/closed') {
          if (asked && stopReason === 'QUESTION') return finish(null, { status: 'interrupted' });
          return finish(error(stopReason ?? rpc.exitError?.code ?? 'PROVIDER_FAILED'));
        }
        const params = (message.params ?? {}) as Record<string, any>;
        if (params.threadId !== undefined && params.threadId !== threadId) {
          if (message.id !== undefined) rpc.refuse(message.id, 'unknown thread');
          return;
        }
        const ownTurn = (id: unknown) => !turnId || id === turnId;
        if (!settled && !stopReason) clock.arm();
        if (message.id !== undefined && message.method) {
          // A work folder turn's approvals go to VIDE's permission handler: outside the folder the
          // user is asked; a refusal declines only that call and the turn goes on (ADR-031 8).
          if (APPROVALS.has(message.method) && ownTurn(params.turnId)) {
            const requestId = message.id;
            const answer = (allow: boolean) =>
              rpc.respond(
                requestId,
                message.method === 'item/permissions/requestApproval'
                  ? allow
                    ? { permissions: params.permissions ?? {}, scope: 'turn' }
                    : { permissions: {}, scope: 'turn' }
                  : { decision: allow ? 'accept' : 'decline' },
              );
            const permission = this.builtin?.files ? this.toolPermission : undefined;
            if (!permission) return answer(false);
            const request =
              message.method === 'item/commandExecution/requestApproval'
                ? {
                    tool: 'Bash',
                    input: { command: String(params.command ?? ''), cwd: params.cwd ?? null },
                    // Network access is always the user's question.
                    escalation: !!params.networkApprovalContext,
                  }
                : message.method === 'item/fileChange/requestApproval'
                  ? {
                      tool: 'Write',
                      input: {
                        paths: [
                          ...(changes.get(String(params.itemId)) ?? []),
                          ...(typeof params.grantRoot === 'string' ? [params.grantRoot] : []),
                        ],
                      },
                      // Paths unknown: the user is asked about the change itself.
                      escalation: !(changes.get(String(params.itemId)) ?? []).length,
                    }
                  : {
                      tool: 'permissions',
                      input: {
                        read: params.permissions?.fileSystem?.read ?? [],
                        write: params.permissions?.fileSystem?.write ?? [],
                        network: !!params.permissions?.network?.enabled,
                      },
                      escalation: true,
                    };
            clock.hold();
            void permission(request, questionAbort.signal).then(
              (decision) => {
                if (settled || stopReason) return;
                clock.release();
                answer(decision.allow);
              },
              () => {
                if (settled || stopReason) return;
                clock.release();
                answer(false);
              },
            );
            return;
          }
          // Any other server request is refused; only the model's question tool is answered.
          if (message.method !== 'item/tool/requestUserInput' || !ownTurn(params.turnId)) {
            rpc.refuse(message.id, 'not allowed');
            return;
          }
          const questions = (Array.isArray(params.questions) ? params.questions : []).filter(
            (question: unknown): question is NativeQuestion =>
              !!question &&
              typeof (question as NativeQuestion).id === 'string' &&
              typeof (question as NativeQuestion).question === 'string',
          );
          const { cards, sources } = questionCards(questions);
          const requestId = message.id;
          progress({ state: 'running', phase: 'question' });
          if (!cards.length)
            return rpc.respond(requestId, nativeAnswers(questions, [], sources, []));
          if (!onQuestion) {
            asked = { cards };
            return stop('QUESTION');
          }
          // The time the person takes is not run time (as on Claude): the turn's clock stops
          // while the card waits and starts over with the answer.
          clock.hold();
          void onQuestion(cards, questionAbort.signal).then(
            (answers) => {
              if (settled || stopReason) return;
              clock.release();
              // Closed without answers (null): the model goes on without them, as on Claude.
              rpc.respond(requestId, nativeAnswers(questions, cards, sources, answers ?? []));
              progress({ state: 'running', phase: 'model' });
            },
            () => stop('QUESTION_FAILED'),
          );
          return;
        }
        switch (message.method) {
          case 'turn/started':
            if (!turnId && typeof params.turn?.id === 'string') turnId = params.turn.id;
            progress({ state: 'running', phase: 'model' });
            return;
          case 'item/started':
          case 'item/completed': {
            if (!ownTurn(params.turnId)) return;
            const item = params.item ?? {};
            const type = String(item.type ?? '');
            // A tool item holds the idle clock until it completes.
            if (!ALLOWED_ITEMS.has(type) && typeof item.id === 'string') {
              if (message.method === 'item/started') clock.toolStarted(item.id);
              else clock.toolEnded(item.id);
            }
            if (type === 'fileChange' && typeof item.id === 'string' && Array.isArray(item.changes))
              changes.set(
                item.id,
                item.changes
                  .map((change: { path?: unknown }) => change?.path)
                  .filter((path: unknown): path is string => typeof path === 'string'),
              );
            const known =
              (type === 'mcpToolCall' &&
                !!this.agent &&
                item.server === 'vide' &&
                this.agent.tools.includes(String(item.tool ?? ''))) ||
              (type === 'webSearch' && !!this.builtin?.web) ||
              (!!WORK_ITEMS[type] && !!this.builtin?.files);
            if (!ALLOWED_ITEMS.has(type)) {
              // A tool the turn does not have was refused by Codex's own configuration; it is
              // reported and the turn goes on (ADR-031 8).
              if (message.method === 'item/started')
                progress({
                  state: 'running',
                  phase: 'tool',
                  tool:
                    type === 'mcpToolCall'
                      ? String(item.tool ?? 'mcp').slice(0, 100)
                      : (WORK_ITEMS[type] ?? (type === 'webSearch' ? 'web_search' : type)).slice(
                          0,
                          100,
                        ),
                  ...(known ? {} : { reason: 'TOOL_REFUSED' }),
                });
              return;
            }
            if (message.method !== 'item/completed') return;
            if (item.type === 'agentMessage' && typeof item.text === 'string') {
              lastText = item.text;
              if (item.phase === 'final_answer' || item.phase == null) finalText = item.text;
              if (item.text)
                progress({ state: 'running', phase: 'model', kind: 'message', text: item.text });
            }
            if (item.type === 'reasoning' && Array.isArray(item.summary) && item.summary.length)
              progress({
                state: 'running',
                phase: 'model',
                kind: 'thinking',
                text: item.summary.join('\n'),
              });
            return;
          }
          case 'thread/tokenUsage/updated':
            if (ownTurn(params.turnId) && params.tokenUsage?.last)
              usage = params.tokenUsage.last as Record<string, number>;
            return;
          case 'error':
            if (ownTurn(params.turnId)) {
              failureText += ' ' + String(params.error?.message ?? '');
              if (!params.willRetry) progress({ state: 'provider-warning' });
            }
            return;
          case 'turn/completed':
            if (!ownTurn(params.turn?.id)) return;
            if (params.turn?.error?.message) failureText += ' ' + String(params.turn.error.message);
            return finish(null, { status: String(params.turn?.status ?? '') });
        }
      };
      const unlisten = rpc.listen(handle);
      const files = this.builtin?.files;
      rpc
        .request<{ turn?: { id?: unknown } }>('turn/start', {
          threadId,
          input,
          ...(schema ? { outputSchema: JSON.parse(schema) } : {}),
          // The work folder sandbox of this turn (ADR-031 8): writes there, no network.
          ...(files?.cwd ? { cwd: files.cwd } : {}),
          ...(codexSandbox(files) === 'workspace-write'
            ? {
                sandboxPolicy: {
                  type: 'workspaceWrite',
                  writableRoots: [...(files?.cwd ? [files.cwd] : []), ...codexWritableRoots(files)],
                  networkAccess: false,
                  excludeTmpdirEnvVar: true,
                  excludeSlashTmp: true,
                },
              }
            : {}),
        })
        .then(
          (started) => {
            if (!turnId && typeof started?.turn?.id === 'string') turnId = started.turn.id;
            if (stopReason && turnId)
              rpc.request('turn/interrupt', { threadId, turnId }, this.stopGraceMs).catch(() => {});
          },
          (cause) => finish(cause instanceof ProviderError ? cause : error('PROVIDER_FAILED')),
        );
    });
    if (asked) return this.questionResult(selected, asked.cards, lastText, !!schema, threadId);
    if (stopReason) {
      progress({ state: 'stopped', reason: stopReason });
      throw error(stopReason);
    }
    if (result.status !== 'completed') {
      const failed = MODE_CHANGED.test(failureText)
        ? 'CLI_MODE_CHANGED'
        : USAGE_LIMIT.test(failureText)
          ? 'PROVIDER_LIMIT'
          : 'PROVIDER_FAILED';
      // The remembered login is asked again on the next run.
      if (failed !== 'PROVIDER_FAILED') this.forgetAuth();
      throw error(failed);
    }
    return {
      text: finalText || lastText,
      revision: selected.packet.revision,
      manifest: selected.manifest,
      usage: this.usageOf(usage),
      ...(this.session ? { sessionId: threadId } : {}),
    };
  }
  private usageOf(usage?: Record<string, number>): ProviderResult['usage'] {
    const count = (key: string) => (Number.isFinite(usage?.[key]) ? usage![key] : null);
    return {
      inputTokens: count('inputTokens'),
      outputTokens: count('outputTokens'),
      cacheReadTokens: count('cachedInputTokens'),
      cacheCreationTokens: count('cacheWriteInputTokens'),
      subscriptionRemaining: null,
    };
  }
  /**
   * A turn stopped at the model's question: the cards as the turn's output (a structured turn gets
   * the turn-output JSON, which turn-output.ts checks as any other), `questions` for the caller.
   */
  private questionResult(
    selected: ReturnType<typeof buildPacket>,
    cards: QuestionCard[],
    partial: string,
    structured: boolean,
    threadId: string,
  ): ProviderResult {
    const text = clip(partial, 4000);
    return {
      text: structured
        ? JSON.stringify({ status: 'question', text, questions: cards })
        : [text, ...cards.map((card) => `- ${card.title}`)].filter(Boolean).join('\n'),
      revision: selected.packet.revision,
      manifest: selected.manifest,
      usage: this.usageOf(),
      questions: cards,
      questionSource: 'codex-native',
      ...(this.session ? { sessionId: threadId } : {}),
    };
  }
}
