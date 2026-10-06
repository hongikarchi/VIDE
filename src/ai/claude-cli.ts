import { z } from 'zod';
import { launchable } from './paths.ts';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentConnection, AgentFormat, BuiltinTools } from './agent-connection.ts';
import { workFolders } from './agent-connection.ts';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  agentConnection,
  configureAgentArguments,
  allowedAgentEvent,
  builtinAllowed,
  neutralInstruction,
  noToolsInstruction,
  turnRules,
  instructionModeFor,
  workFolderArguments,
} from './agent-connection.ts';
import {
  bundleFor,
  withRules,
  type InstructionHost,
  type InstructionMode,
} from './instructions/index.ts';
import compat from './cli-compat.json' with { type: 'json' };
import { watchedSpawn } from './cli-log.ts';

export class ProviderError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const error = (code: string) => new ProviderError(code);

export interface ContextItem {
  id: string;
  label?: string;
  type?: string;
  data: unknown;
}
export interface ProviderContext {
  goal: string;
  items: ContextItem[];
  includedIds: string[];
  revision: number;
}
export interface ProviderStatus {
  available: boolean;
  reason?: string;
  method?: string;
}
export interface Progress {
  state: string;
  phase?: string;
  reason?: string;
  tool?: string;
  /** Visible model text (reasoning summary or intermediate message) for the activity log. */
  text?: string;
  kind?: 'thinking' | 'message';
}
export interface ProviderResult {
  text: string;
  revision: number;
  manifest: { id: string; label?: string; type?: string }[];
  /** Tokens as each CLI reports them: Claude's inputTokens excludes cache reads and writes,
   * Codex's includes cache reads. */
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    subscriptionRemaining: null;
  };
  [key: string]: unknown;
}
/**
 * The provider session a turn belongs to (ADR-021, ARCH-01 §2): one CLI run per turn, the
 * transcript kept under VIDE's own UUID. The first turn opens it, later turns resume it.
 */
export interface SessionOptions {
  id: string;
  /** The session already has turns: resume instead of opening. */
  resume: boolean;
}
export interface CliOptions {
  executable?: string;
  model?: string;
  effort?: string;
  agent?: unknown;
  session?: SessionOptions;
  /**
   * The instruction bundle (PLAN-24 지침 묶음) appended to the provider's default prompt: its mode
   * (default: what the connection implies), the host of a modeling bundle, and the project's
   * addendum (sanitised as data by `bundleFor`).
   */
  instructionMode?: InstructionMode;
  instructionHost?: InstructionHost;
  projectInstructions?: string;
  timeoutMs?: number;
  stopGraceMs?: number;
  spawnProcess?: typeof spawn;
  /**
   * (SPIKE-2026-09-30-native-questions-claude; on for conversation turns, ADR-026 4) When set, a Claude run offers the CLI's own
   * AskUserQuestion and routes it over stdio (`--permission-prompt-tool stdio`) to this handler,
   * which shows the question cards and returns the answers (null: the user closed them).
   */
  nativeQuestions?: NativeQuestionHandler;
  /**
   * The provider's own tools the turn may use beside VIDE's (ADR-028, T-105): subagents and the
   * to-do list (`work`), the public web (`web`). Only a turn with a VIDE connection gets them.
   */
  builtinTools?: BuiltinTools;
  /**
   * The engine's answer to a built-in file or shell tool use the CLI asks about (ADR-031 8): inside
   * the project work folder it allows, outside it asks the user. Without it every such use is
   * refused.
   */
  toolPermission?: ToolPermissionHandler;
}
/** One built-in tool use the CLI asks VIDE about (Claude `can_use_tool`, Codex approvals). */
export interface ToolPermissionRequest {
  /** Claude's tool name; Codex approvals as `Bash` (a command), `Write` (file changes) or `permissions`. */
  tool: string;
  input: Record<string, unknown>;
  /** The path the CLI named as outside its working directories, when it named one. */
  blockedPath?: string;
  /** Codex asked to leave its sandbox (always a question for the user). */
  escalation?: boolean;
}
export type ToolPermissionAnswer = { allow: true } | { allow: false; message: string };
export type ToolPermissionHandler = (
  request: ToolPermissionRequest,
  signal: AbortSignal,
) => Promise<ToolPermissionAnswer>;
const sessionSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  resume: z.boolean(),
});
/**
 * A resumed session whose transcript is gone (another account profile, deleted, never opened):
 * Claude "No conversation found", Codex "no rollout found for thread id" (SPIKE-2026-09-30 ④).
 */
export const SESSION_LOST = /No conversation found|no rollout found for thread/i;
const usageSchema = z
  .object({
    input_tokens: z.number().nonnegative().optional(),
    output_tokens: z.number().nonnegative().optional(),
    // Claude
    cache_read_input_tokens: z.number().nonnegative().optional(),
    cache_creation_input_tokens: z.number().nonnegative().optional(),
    // Codex
    cached_input_tokens: z.number().nonnegative().optional(),
    cache_write_input_tokens: z.number().nonnegative().optional(),
  })
  .passthrough();
const eventSchema = z
  .object({
    type: z.string(),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    usage: usageSchema.optional(),
    item: z
      .object({
        type: z.string(),
        server: z.string().optional(),
        tool: z.string().optional(),
        text: z.string().optional(),
      })
      .passthrough()
      .optional(),
    tools: z.array(z.string()).optional(),
    mcp_servers: z.array(z.object({ name: z.string(), status: z.string() })).optional(),
    // Claude: the assistant message; Codex "error" events: the error text.
    message: z
      .union([
        z
          .object({
            content: z
              .array(z.object({ type: z.string(), name: z.string().optional() }).passthrough())
              .optional(),
          })
          .passthrough(),
        z.string(),
      ])
      .optional(),
  })
  .passthrough();
/** A subscription usage/rate limit, as the CLIs word it (Claude and Codex). */
export const USAGE_LIMIT =
  /usage limit|rate limit|rate_limit|limit reached|limit_reached|hit your (usage )?limit|quota|too many requests|\b429\b/i;
/**
 * The run sent no subscription login although `auth status` had just reported one: the CLI changed how
 * it logs in (e.g. `--bare` becoming the `-p` default). Claude bare mode answers "Not logged in", Codex
 * without credentials "Missing bearer or basic authentication" (SPIKE-2026-09-30-cli-session-resume §0).
 */
export const MODE_CHANGED = /Not logged in|Missing bearer or basic authentication/i;

export type CliProvider = 'claude-cli' | 'codex-cli';
const versionRange = z.object({ minimum: z.string(), below: z.string() }).passthrough();
/** Verified version ranges; a CLI outside its range is not run. */
export const cliCompat = z
  .object({ 'claude-cli': versionRange, 'codex-cli': versionRange })
  .passthrough()
  .parse(compat);
const versionPattern = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;
/** Semantic version order: numeric core, then a prerelease before its release. NaN if unreadable. */
export function compareVersions(a: string, b: string) {
  const x = versionPattern.exec(a),
    y = versionPattern.exec(b);
  if (!x || !y) return NaN;
  for (let i = 1; i <= 3; i++)
    if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
  if (x[4] === y[4]) return 0;
  if (x[4] === undefined || y[4] === undefined) return x[4] === undefined ? 1 : -1;
  const p = x[4].split('.'),
    q = y[4].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1;
    const numeric = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    if (numeric[0] && numeric[1]) return Number(p[i]) < Number(q[i]) ? -1 : 1;
    if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}
/** In range when `minimum <= version` and the release core is `< below` (so a prerelease of `below` is out). */
export function supportedCliVersion(provider: CliProvider, version: string) {
  const range = cliCompat[provider];
  const core = versionPattern.exec(version)?.slice(1, 4).join('.');
  return (
    core !== undefined &&
    compareVersions(version, range.minimum) >= 0 &&
    compareVersions(core, range.below) < 0
  );
}
const VERSION_TTL_MS = 60000;
const versionCache = new Map<string, { at: number; version: string }>();
/**
 * A confirmed subscription login is reused for ten minutes per provider and executable (each
 * `auth status` / `login status` spawn is ~0.2 s before every turn). Only a login that was
 * available is kept; a refused run (changed login mode, subscription limit) clears it
 * (`clearAuthStatus`). VIDE runs on each CLI's default login (ADR-025): AccountSwitch changes it.
 */
export const AUTH_TTL_MS = 10 * 60_000;
const authCache = new WeakMap<object, Map<string, { at: number; status: ProviderStatus }>>();
let authGeneration = 0;
/** Forgets every remembered login (a refused run). */
export function clearAuthStatus() {
  authGeneration++;
}
const errorText = (event: Record<string, unknown>) => {
  const parts: string[] = [];
  const collect = (value: unknown, depth = 0) => {
    if (typeof value === 'string') parts.push(value);
    else if (value && typeof value === 'object' && depth < 3)
      for (const [key, inner] of Object.entries(value))
        if (['message', 'error', 'result', 'text', 'code', 'type'].includes(key))
          collect(inner, depth + 1);
  };
  collect(event);
  return parts.join(' ').slice(0, 2000);
};
export type ProviderEvent = z.infer<typeof eventSchema>;
/** One stdout line as a provider event; undefined when it is not one. */
export function parseProviderEvent(line: string): ProviderEvent | undefined {
  try {
    const event = eventSchema.parse(JSON.parse(line));
    return event && typeof event.type === 'string' ? event : undefined;
  } catch {
    return undefined;
  }
}
/** The error words of a failed event (classification only; never shown). */
export { errorText as providerErrorText };

/** Select only data explicitly included by the local controller; never attach project directories. */
export function buildPacket({ goal, items, includedIds, revision }: ProviderContext) {
  if (
    typeof goal !== 'string' ||
    !goal.trim() ||
    goal.length > 20000 ||
    !Array.isArray(items) ||
    !Array.isArray(includedIds) ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    throw error('INVALID_CONTEXT');
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || ids.has(item.id)) throw error('INVALID_CONTEXT');
    ids.add(item.id);
  }
  if (new Set(includedIds).size !== includedIds.length || includedIds.some((id) => !ids.has(id)))
    throw error('INVALID_CONTEXT');
  const included = new Set(includedIds);
  const data = items
    .filter((item) => included.has(item.id))
    .map((item) => ({
      id: item.id,
      label: item.label,
      type: item.type,
      data: item.data,
    }));
  // Image items (PLAN-24) go to the model as images; the packet keeps their place and metadata.
  // Past the provider's own limits an image is left out with a note instead of failing the turn
  // (ADR-031 3): the model is told and can ask for a smaller one.
  const images: PacketImage[] = [];
  for (const entry of data)
    if (entry.type === 'image') {
      const { dataUrl, ...meta } = (entry.data ?? {}) as { dataUrl?: unknown };
      const image = packetImage(dataUrl);
      if (!image || images.length >= MAX_PACKET_IMAGES) {
        entry.data = {
          ...meta,
          omitted: !image
            ? `This image is larger than ${MAX_PACKET_IMAGE_BYTES / 1e6} MB and was not sent; ask the user for a smaller one if you need it.`
            : `Only ${MAX_PACKET_IMAGES} images go with one turn; this one was not sent.`,
        };
        continue;
      }
      images.push(image);
      entry.data = { ...meta, image: images.length };
    }
  const packet = { goal, revision, items: data };
  const serialized = JSON.stringify(packet);
  if (Buffer.byteLength(serialized) > 256 * 1024) throw error('CONTEXT_TOO_LARGE');
  return {
    packet: z
      .object({
        goal: z.string(),
        revision: z.number(),
        items: z.array(
          z.object({
            id: z.string(),
            label: z.string().optional(),
            type: z.string().optional(),
            data: z.unknown(),
          }),
        ),
      })
      .parse(JSON.parse(serialized)),
    manifest: data.map(({ id, label, type }) => ({ id, label, type })),
    images,
  };
}
/**
 * A picture for the model (PLAN-24): base64 PNG or JPEG. A turn carries up to 20 of them, each up to
 * the provider's per-image size (ADR-031 3); more or larger ones are left out with a note.
 */
export interface PacketImage {
  mediaType: 'image/png' | 'image/jpeg';
  data: string;
}
export const MAX_PACKET_IMAGES = 20;
export const MAX_PACKET_IMAGE_BYTES = 5_000_000;
/** A data URL of an image item (undefined when too large); anything else is an invalid context. */
export function packetImage(dataUrl: unknown): PacketImage | undefined {
  const match =
    typeof dataUrl === 'string' &&
    /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw error('INVALID_CONTEXT');
  if (Buffer.byteLength(match[2], 'base64') > MAX_PACKET_IMAGE_BYTES) return undefined;
  return { mediaType: match[1] as PacketImage['mediaType'], data: match[2] };
}

export function subscriptionEnvironment(source = process.env) {
  // Preserve ordinary OS/proxy settings and the official subscription login, never API fallback credentials.
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      // TYPESAFE_*: the Jev key is VIDE's own and never reaches the CLI.
      // CLAUDE_CONFIG_DIR set on this PC is the CLI's default login and stays (PLAN-38 T-175).
      /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_ENV_FILE$|TYPESAFE_)/i.test(key)
    )
      delete env[key];
  }
  return env;
}

/**
 * Single-run isolation arguments. The default Claude Code system prompt is kept and VIDE's text is
 * appended: the instruction `bundle` and this run's rules (no tools unless a connection's rules
 * replace them).
 */
export function cliArguments(bundle = '') {
  return [
    '-p',
    '--safe-mode',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--no-chrome',
    '--disable-slash-commands',
    '--permission-mode',
    'dontAsk',
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    bundle ? withRules(bundle, noToolsInstruction) : noToolsInstruction,
  ];
}
/**
 * Turns the single-run isolation arguments into one turn of a session (SPIKE-2026-09-30 ①⑦):
 * only session persistence is switched on, the appended prompt is the bundle with the neutral
 * session rules (the default prompt stays) and is not replayed from the transcript (`--system-prompt-snapshot off`), so every turn's tools, MCP servers and
 * rules are the ones passed with it.
 */
export function sessionArguments(args: string[], session: SessionOptions, bundle = '') {
  const { id, resume } = sessionSchema.parse(session);
  const persistence = args.indexOf('--no-session-persistence');
  if (persistence >= 0) args.splice(persistence, 1);
  args[args.indexOf('--append-system-prompt') + 1] = bundle
    ? withRules(bundle, neutralInstruction)
    : neutralInstruction;
  args.push(resume ? '--resume' : '--session-id', id, '--system-prompt-snapshot', 'off');
  return args;
}
/**
 * The JSON Schema a turn asks for (PLAN-24 T-062): the included `turn-output` packet item names
 * it; the CLI enforces it (Claude `--json-schema`, Codex `--output-schema <file>`).
 */
export function outputSchemaOf(context: ProviderContext): string | undefined {
  const item = context.items?.find(
    (entry) => entry?.type === 'turn-output' && context.includedIds?.includes(entry.id),
  );
  const schema = (item?.data as { schema?: unknown } | undefined)?.schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const text = JSON.stringify(schema);
  if (Buffer.byteLength(text) > 16 * 1024) throw error('INVALID_CONTEXT');
  return text;
}
/** The packet of a session turn carries the turn's rules; the neutral prompt names none. */
export function withTurnRules(
  context: ProviderContext,
  connection?: AgentConnection,
  format: AgentFormat = 'claude',
  builtin?: BuiltinTools,
) {
  const item = {
    id: 'turn-rules',
    type: 'turn-rules',
    data: turnRules(connection, format, builtin),
  };
  return {
    ...context,
    items: [item, ...context.items],
    includedIds: [item.id, ...context.includedIds],
  };
}
/**
 * Removes the transcript of one VIDE session from Claude's folder (ARCH-01 §2 record management):
 * `<folder>/projects/<project>/<sessionId>.jsonl` with its `<sessionId>/` folder (subagents),
 * wherever the first turn ran, and the project
 * folder when it is left empty. Nothing else is touched. `configDirectory` is the default login's
 * `~/.claude` unless a test names another.
 */
export async function removeClaudeTranscript(
  configDirectory: string | undefined,
  sessionId: string,
) {
  const id = sessionSchema.shape.id.parse(sessionId);
  const projects = join(configDirectory ?? join(homedir(), '.claude'), 'projects');
  let folders: string[] = [];
  try {
    folders = await readdir(projects);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const folder of folders) {
    const file = join(projects, folder, id + '.jsonl');
    try {
      await unlink(file);
      removed++;
    } catch {
      continue;
    }
    // The session's own folder: its subagents' transcripts (`<id>/subagents/`, ADR-028).
    await rm(join(projects, folder, id), { recursive: true, force: true }).catch(() => {});
    try {
      if (!(await readdir(join(projects, folder))).length) await rmdir(join(projects, folder));
    } catch {
      /* Another session's files keep the folder. */
    }
  }
  return removed;
}

// --- native questions (SPIKE-2026-09-30-native-questions-claude) --------------------------------
/** The Claude Code tool that asks the user; its answers come back as `updatedInput.answers`. */
export const NATIVE_QUESTION_TOOL = 'AskUserQuestion';
/** One question card in the shape of the turn-output question card (turn-output.ts). */
export interface NativeQuestionCard {
  id: string;
  title: string;
  options: { id: string; label: string; hint?: string; recommended?: boolean }[];
  allowFree: boolean;
}
/** The user's answer to one card: an option id, a free answer, or both. */
export interface NativeQuestionAnswer {
  id: string;
  option?: string;
  text?: string;
}
export type NativeQuestionHandler = (
  cards: NativeQuestionCard[],
  signal: AbortSignal,
) => Promise<NativeQuestionAnswer[] | null>;
const nativeQuestionInput = z
  .object({
    questions: z
      .array(
        z
          .object({
            question: z.string().trim().min(1).max(1000),
            header: z.string().optional(),
            multiSelect: z.boolean().optional(),
            options: z
              .array(
                z
                  .object({
                    label: z.string().trim().min(1).max(200),
                    description: z.string().optional(),
                  })
                  .passthrough(),
              )
              .min(2)
              .max(5),
          })
          .passthrough(),
      )
      .min(1)
      .max(3),
  })
  .passthrough();
const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max - 1) + '…' : text;
/** The CLI's AskUserQuestion input as question cards; undefined when it does not fit the cards. */
export function nativeQuestionCards(input: unknown): NativeQuestionCard[] | undefined {
  const parsed = nativeQuestionInput.safeParse(input);
  if (!parsed.success) return undefined;
  return parsed.data.questions.map((question, index) => ({
    id: `q${index + 1}`,
    title: clip(question.question, 200),
    options: question.options.map((option, at) => ({
      id: `o${at + 1}`,
      label: clip(option.label, 80),
      ...(option.description?.trim() ? { hint: clip(option.description.trim(), 200) } : {}),
    })),
    // The CLI's own dialog always offers a free answer.
    allowFree: true,
  }));
}
/** The answers as the CLI reads them: `answers[question text] = chosen label or free text`. */
export function nativeQuestionInputWithAnswers(input: unknown, answers: NativeQuestionAnswer[]) {
  const parsed = nativeQuestionInput.parse(input);
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const values: Record<string, string> = {};
  parsed.questions.forEach((question, index) => {
    const answer = byId.get(`q${index + 1}`);
    const option = answer?.option
      ? question.options[Number(answer.option.slice(1)) - 1]
      : undefined;
    const text = answer?.text?.trim().slice(0, 2000);
    const value = [option?.label, text].filter(Boolean).join(' — ');
    if (value) values[question.question] = value;
  });
  return { ...(input as Record<string, unknown>), answers: values };
}
/**
 * The arguments of a run that routes AskUserQuestion to VIDE: the tool is offered, permission
 * prompts reach the host over stdio (so stdin is stream-json and stays open), and the mode is
 * `default` because `dontAsk` denies the tool before any prompt. Every other tool keeps its
 * `--allowedTools` entry; anything else that would prompt is denied by the run.
 */
export function nativeQuestionArguments(args: string[], enabled = true) {
  if (!enabled) return args;
  const tools = args.indexOf('--tools');
  if (tools >= 0)
    args[tools + 1] = [...args[tools + 1].split(',').filter(Boolean), NATIVE_QUESTION_TOOL].join(
      ',',
    );
  const mode = args.indexOf('--permission-mode');
  if (mode >= 0 && args[mode + 1] === 'dontAsk') args[mode + 1] = 'default';
  args.push('--permission-prompt-tool', 'stdio');
  if (!args.includes('--input-format')) args.push('--input-format', 'stream-json');
  return args;
}
/** The control_response line for one control request id. */
export function controlResponse(requestId: string, response: Record<string, unknown> | string) {
  return (
    JSON.stringify({
      type: 'control_response',
      response:
        typeof response === 'string'
          ? { subtype: 'error', request_id: requestId, error: response }
          : { subtype: 'success', request_id: requestId, response },
    }) + '\n'
  );
}
/**
 * The answer to one `can_use_tool` request: AskUserQuestion goes to the cards, a built-in file or
 * shell tool to the engine's permission handler (ADR-031 8), anything else is denied (VIDE's own
 * tools are pre-allowed and never prompt). A denial only refuses that call; the turn goes on.
 */
export async function answerToolRequest(
  request: { tool_name?: unknown; input?: unknown; blocked_path?: unknown },
  handler: NativeQuestionHandler | undefined,
  signal: AbortSignal,
  permission?: ToolPermissionHandler,
): Promise<Record<string, unknown>> {
  const input = (request.input && typeof request.input === 'object' ? request.input : {}) as Record<
    string,
    unknown
  >;
  // The CLI's own structured-output tool (a turn's --json-schema answer) writes nothing; in the
  // `default` mode a native-question run uses, it may ask before it answers.
  if (request.tool_name === 'StructuredOutput') return { behavior: 'allow', updatedInput: input };
  if (request.tool_name !== NATIVE_QUESTION_TOOL || !handler) {
    if (!permission || typeof request.tool_name !== 'string' || !request.tool_name)
      return { behavior: 'deny', message: 'This tool is not available in VIDE.' };
    const answer = await permission(
      {
        tool: request.tool_name,
        input,
        ...(typeof request.blocked_path === 'string' ? { blockedPath: request.blocked_path } : {}),
      },
      signal,
    );
    return answer.allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: answer.message };
  }
  const cards = nativeQuestionCards(request.input);
  if (!cards)
    return {
      behavior: 'deny',
      message: 'Ask 1 to 3 questions with 2 to 5 options each.',
    };
  const answers = await handler(cards, signal);
  if (!answers || !answers.length)
    return {
      behavior: 'deny',
      message: 'The user closed the questions without answering. Continue without asking again.',
    };
  return {
    behavior: 'allow',
    updatedInput: nativeQuestionInputWithAnswers(request.input, answers),
  };
}

/**
 * The largest single stdout line (one stream-json event or JSON-RPC message) a run accepts
 * (ADR-028): a turn as a whole has no output cap, only each event has.
 */
export const MAX_EVENT_LINE = 16 * 1024 * 1024;

/**
 * A turn's clock (ADR-031 8): only time without any output counts. Every event re-arms it; it is
 * held while the person answers a question card and while a tool call has not answered (a long
 * host execute or a subagent is work, not silence). `stop()` ends it for good.
 */
export class IdleClock {
  #ms: number;
  #onIdle: () => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #held = 0;
  #tools = new Set<string>();
  #stopped = false;
  constructor(ms: number, onIdle: () => void) {
    this.#ms = ms;
    this.#onIdle = onIdle;
    this.arm();
  }
  arm() {
    clearTimeout(this.#timer);
    if (this.#stopped || this.#held || this.#tools.size) return;
    this.#timer = setTimeout(() => {
      if (!this.#stopped) this.#onIdle();
    }, this.#ms);
  }
  hold() {
    this.#held++;
    clearTimeout(this.#timer);
  }
  release() {
    this.#held = Math.max(0, this.#held - 1);
    this.arm();
  }
  /** A tool call started (`id`) or answered. */
  toolStarted(id: string) {
    this.#tools.add(id);
    this.arm();
  }
  toolEnded(id: string) {
    this.#tools.delete(id);
    this.arm();
  }
  /** A Claude stream event: its tool calls (assistant) and tool results (user) are tracked. */
  claudeEvent(event: ProviderEvent) {
    const content = typeof event.message === 'object' ? event.message.content : undefined;
    for (const item of content ?? []) {
      if (item.type === 'tool_use' && typeof item.id === 'string') this.#tools.add(item.id);
      if (item.type === 'tool_result' && typeof item.tool_use_id === 'string')
        this.#tools.delete(item.tool_use_id);
    }
    // The turn's end clears what the stream never answered (a call the CLI dropped).
    if (event.type === 'result') this.#tools.clear();
    this.arm();
  }
  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }
}

export function killOwnedProcess(child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    if (!child.pid) return resolve(false);
    if (process.platform !== 'win32') return resolve(child.kill('SIGTERM'));
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => resolve(false));
    killer.once('exit', (code) => resolve(code === 0));
  });
}

/** No raw provider logs/identity are returned. Stopping means requested; stopped requires process exit. */
export class ClaudeCli {
  executable: string;
  timeoutMs: number;
  stopGraceMs: number;
  spawnProcess: typeof spawn;
  model?: string;
  effort?: string;
  agent?: AgentConnection;
  session?: SessionOptions;
  nativeQuestions?: NativeQuestionHandler;
  /**
   * The provider's own tools of this turn: subagents, to-do and web (ADR-028) only with a VIDE
   * connection; the work folder's file and shell tools (ADR-031 8) with or without one.
   */
  builtin?: BuiltinTools;
  /** The engine's answer to a file or shell tool use outside what the CLI allows itself. */
  toolPermission?: ToolPermissionHandler;
  /** The instruction bundle of every run of this provider (PLAN-24 지침 묶음). */
  instructions: string;
  /** The spawn function given (the login cache is kept per spawn function: tests inject fakes). */
  private readonly spawnIdentity: object;
  /** Milliseconds of the last run's steps (diagnostic log): login check, CLI start, first output. */
  timing: {
    authMs?: number;
    authCached?: boolean;
    /** When the CLI started, or (a kept process) when the turn was written to it. */
    spawnAt?: number;
    firstOutputAt?: number;
    /** The turn ran in a process kept from an earlier turn (ADR-028). */
    processReused?: boolean;
  } = {};
  constructor({
    executable,
    model,
    effort,
    agent,
    session,
    instructionMode,
    instructionHost,
    projectInstructions,
    timeoutMs = 60000,
    stopGraceMs = 5000,
    spawnProcess = spawn,
    nativeQuestions,
    builtinTools,
    toolPermission,
  }: CliOptions = {}) {
    if (typeof executable !== 'string' || !isAbsolute(executable)) throw error('CLI_PATH_REQUIRED');
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 1 ||
      !Number.isFinite(stopGraceMs) ||
      stopGraceMs < 1
    )
      throw error('INVALID_LIMIT');
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.stopGraceMs = stopGraceMs;
    // Every CLI process this provider starts is logged: version, exit, error tail (T-126).
    // An npm install's `cli.js` or `.cmd` shim starts on Node (PLAN-38 T-175, launchTarget).
    this.spawnProcess = watchedSpawn(launchable(spawnProcess), () => ({
      provider: this.provider,
      version: versionCache.get(`${this.provider}\0${this.executable}`)?.version,
      model: this.model,
      effort: this.effort,
    }));
    this.spawnIdentity = spawnProcess;
    if (nativeQuestions !== undefined && typeof nativeQuestions !== 'function')
      throw error('INVALID_NATIVE_QUESTIONS');
    this.nativeQuestions = nativeQuestions;
    if (
      model !== undefined &&
      (typeof model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}(?:\[1m\])?$/.test(model))
    )
      throw error('INVALID_MODEL');
    if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
      throw error('INVALID_EFFORT');
    this.model = model;
    this.effort = effort;
    this.agent = agentConnection(agent);
    // Subagents, to-do and web come only with a VIDE connection; the work folder's file and shell
    // tools (ADR-031 8) also in a turn without one.
    const files = workFolders(builtinTools?.files);
    const work = !!this.agent && !!builtinTools?.work,
      web = !!this.agent && !!builtinTools?.web;
    this.builtin =
      work || web || files ? Object.freeze({ work, web, ...(files ? { files } : {}) }) : undefined;
    if (toolPermission !== undefined && typeof toolPermission !== 'function')
      throw error('INVALID_TOOL_PERMISSION');
    this.toolPermission = toolPermission;
    if (session !== undefined && !sessionSchema.safeParse(session).success)
      throw error('INVALID_SESSION');
    this.session = session;
    this.instructions = bundleFor(
      instructionMode ?? instructionModeFor(this.agent),
      projectInstructions,
      {
        host: instructionHost,
      },
    );
  }
  /** The CLI's default login (ADR-025): no config folder is named. */
  environment() {
    return subscriptionEnvironment();
  }
  arguments() {
    const args = cliArguments(this.instructions);
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    return this.session ? sessionArguments(args, this.session, this.instructions) : args;
  }
  /** A turn with images reads its input as one stream-json user message (text packet + images). */
  async withImages(args: string[], images: readonly PacketImage[], _cwd: string) {
    if (images.length) args.push('--input-format', 'stream-json');
    return args;
  }
  /** What the run writes to stdin: the packet, or with images a stream-json user message. */
  inputOf(packet: unknown, images: readonly PacketImage[], stream = images.length > 0) {
    const text = JSON.stringify(packet);
    if (!stream) return text;
    return (
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text },
            ...images.map((image) => ({
              type: 'image',
              source: { type: 'base64', media_type: image.mediaType, data: image.data },
            })),
          ],
        },
      }) + '\n'
    );
  }
  /** Adds the structured-output flag of a turn that asks for one (keeps every other argument). */
  async withOutputSchema(args: string[], schema: string | undefined, _cwd: string) {
    if (schema) args.push('--json-schema', schema);
    return args;
  }
  get eventFormat(): AgentFormat {
    return 'claude';
  }
  get provider(): CliProvider {
    return this.eventFormat === 'codex' ? 'codex-cli' : 'claude-cli';
  }
  /** Refuses a CLI outside its verified range; `--version` is read at most once a minute per executable. */
  async checkVersion(): Promise<string> {
    const key = `${this.provider}\0${this.executable}`;
    let entry = versionCache.get(key);
    if (!entry || Date.now() - entry.at >= VERSION_TTL_MS) {
      entry = { at: Date.now(), version: await this.readVersion() };
      versionCache.set(key, entry);
    }
    if (!supportedCliVersion(this.provider, entry.version)) {
      const range = cliCompat[this.provider];
      throw Object.assign(error('CLI_VERSION_UNSUPPORTED'), {
        version: entry.version,
        supported: `>=${range.minimum} <${range.below}`,
      });
    }
    return entry.version;
  }
  readVersion(): Promise<string> {
    const child = this.spawnProcess(this.executable, ['--version'], {
      env: this.environment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise<string>((resolve, reject) => {
      let output = '',
        settled = false;
      const finish = (err: Error | null, version?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(version!);
      };
      const timer = setTimeout(() => {
        void killOwnedProcess(child);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(error('CLI_VERSION_UNSUPPORTED'));
      }, 10000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (output.length < 4096) output += chunk.toString('utf8');
      });
      child.stderr.on('data', () => {});
      child.once('error', () => finish(error('CLI_UNAVAILABLE')));
      child.once('close', (code) => {
        const version = code === 0 ? versionPattern.exec(output)?.[0] : undefined;
        finish(version ? null : error('CLI_VERSION_UNSUPPORTED'), version);
      });
    });
  }
  private authKey() {
    return `${authGeneration}\0${this.provider}\0${this.executable}`;
  }
  /** `status()` before a run: a login confirmed in the last ten minutes is not asked again. */
  async cachedStatus(): Promise<ProviderStatus> {
    const started = performance.now();
    let entries = authCache.get(this.spawnIdentity);
    if (!entries) authCache.set(this.spawnIdentity, (entries = new Map()));
    const key = this.authKey();
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at < AUTH_TTL_MS) {
      this.timing.authMs = Math.round(performance.now() - started);
      this.timing.authCached = true;
      return hit.status;
    }
    const status = await this.status();
    if (status.available) entries.set(key, { at: Date.now(), status });
    else entries.delete(key);
    this.timing.authMs = Math.round(performance.now() - started);
    this.timing.authCached = false;
    return status;
  }
  /** Forgets this provider's remembered login (a run refused for its login or its limit). */
  forgetAuth() {
    authCache.get(this.spawnIdentity)?.delete(this.authKey());
  }
  async status(): Promise<ProviderStatus> {
    const child = this.spawnProcess(this.executable, ['auth', 'status', '--json'], {
      env: this.environment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise<ProviderStatus>((resolve) => {
      let stdout = '',
        tooLarge = false,
        finished = false;
      const finish = (value: ProviderStatus) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(value!);
      };
      const timer = setTimeout(() => {
        void killOwnedProcess(child);
        finish({ available: false, reason: 'AUTH_TIMEOUT' });
      }, 10000);
      child.stdout.on('data', (chunk) => {
        if (tooLarge) return;
        stdout += chunk.toString('utf8');
        if (stdout.length > 65536) {
          tooLarge = true;
          void killOwnedProcess(child);
          finish({ available: false, reason: 'AUTH_INVALID' });
        }
      });
      child.stderr.on('data', () => {});
      child.once('error', () => finish({ available: false, reason: 'CLI_UNAVAILABLE' }));
      child.once('close', (code) => {
        let auth;
        try {
          auth = z
            .object({ loggedIn: z.boolean(), authMethod: z.string().optional() })
            .parse(JSON.parse(stdout));
        } catch {
          return finish({ available: false, reason: 'AUTH_INVALID' });
        }
        finish(
          code === 0 && auth.loggedIn && auth.authMethod === 'claude.ai'
            ? { available: true, method: 'subscription' }
            : { available: false, reason: 'SUBSCRIPTION_LOGIN_REQUIRED' },
        );
      });
    });
  }
  /**
   * A Claude `system/init` event names only tools this turn may have: none without a connection,
   * else VIDE's MCP tools of the turn, its file tools (make), its built-in tools (ADR-028) and the
   * CLI's own output/question tools when the run asked for them (`extra`). VIDE's MCP server is
   * the only one and connected.
   */
  initValid(event: ProviderEvent, extra: (name: string) => boolean) {
    const tools = Array.isArray(event.tools)
      ? event.tools.filter((name) => !extra(name))
      : undefined;
    return this.agent
      ? Array.isArray(tools) &&
          tools.every((name) => allowedAgentEvent({ name }, 'claude', this.agent, this.builtin)) &&
          Array.isArray(event.mcp_servers) &&
          event.mcp_servers.length === 1 &&
          event.mcp_servers[0].name === 'vide' &&
          event.mcp_servers[0].status === 'connected'
      : Array.isArray(tools) &&
          tools.every((name) => allowedAgentEvent({ name }, 'claude', undefined, this.builtin)) &&
          Array.isArray(event.mcp_servers) &&
          !event.mcp_servers.length;
  }
  /**
   * The init check no longer ends a turn (ADR-031 8): the CLI itself refuses every tool the turn
   * did not allow (`--tools`, the permission mode and VIDE's permission handler), so an unexpected
   * entry is reported as a warning and the turn goes on.
   */
  initChecked(
    event: ProviderEvent,
    extra: (name: string) => boolean,
    progress: (event: Progress) => void,
  ) {
    if (!this.initValid(event, extra))
      progress({ state: 'provider-warning', reason: 'UNEXPECTED_TOOL_ACCESS' });
  }
  /**
   * A Claude `assistant` event (a subagent's too): its text and thinking go to the activity log, a
   * tool call is reported. A call of a tool this turn does not have is refused by the CLI itself
   * (only that call; ADR-031 8): it is reported as refused and the turn goes on.
   */
  assistantEvent(
    event: ProviderEvent,
    progress: (event: Progress) => void,
    outputTool: (name: unknown) => boolean,
    questionTool: (name: unknown) => boolean,
  ) {
    for (const item of (typeof event.message === 'object' ? event.message.content : undefined) ||
      []) {
      if (
        (item.type === 'text' || item.type === 'thinking') &&
        typeof (item.text ?? item.thinking) === 'string'
      )
        progress({
          state: 'running',
          phase: 'model',
          kind: item.type === 'thinking' ? 'thinking' : 'message',
          text: String(item.text ?? item.thinking),
        });
      if (item.type === 'tool_use') {
        if (questionTool(item.name)) continue;
        if (
          !outputTool(item.name) &&
          !allowedAgentEvent(item, 'claude', this.agent, this.builtin)
        ) {
          progress({
            state: 'running',
            phase: 'tool',
            tool: typeof item.name === 'string' ? item.name.slice(0, 100) : 'unknown',
            reason: 'TOOL_REFUSED',
          });
          continue;
        }
        progress({
          state: 'running',
          phase: 'tool',
          tool: builtinAllowed(item.name, this.builtin)
            ? item.name
            : item.name?.slice('mcp__vide__'.length),
        });
      }
    }
    return true;
  }
  /**
   * Why a run failed, from its error texts: a changed login mode stops here (another account would
   * fail the same way); a subscription limit is told apart so another account can take the next
   * request; a resumed session without its transcript is reopened by hand-over (SPEC-02.19 5).
   * The remembered login is asked again after the first two.
   */
  failureCode(failureText: string, errorOutput: string) {
    const failed = MODE_CHANGED.test(failureText)
      ? 'CLI_MODE_CHANGED'
      : USAGE_LIMIT.test(failureText)
        ? 'PROVIDER_LIMIT'
        : this.session?.resume && SESSION_LOST.test(failureText + ' ' + errorOutput)
          ? 'SESSION_LOST'
          : 'PROVIDER_FAILED';
    if (failed === 'CLI_MODE_CHANGED' || failed === 'PROVIDER_LIMIT') this.forgetAuth();
    return failed;
  }
  /** The turn's answer from its final result event (`usage`: a sum over several, else its own). */
  resultOf(
    final: ProviderEvent & { result: string },
    selected: ReturnType<typeof buildPacket>,
    usage = final.usage,
  ): ProviderResult {
    return {
      text: final.result,
      revision: selected.packet.revision,
      manifest: selected.manifest,
      ...(final.structured_output !== undefined ? { structured: final.structured_output } : {}),
      usage: {
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        cacheReadTokens: usage?.cache_read_input_tokens ?? usage?.cached_input_tokens ?? null,
        cacheCreationTokens:
          usage?.cache_creation_input_tokens ?? usage?.cache_write_input_tokens ?? null,
        subscriptionRemaining: null,
      },
    };
  }
  async run(
    context: ProviderContext,
    {
      signal,
      onProgress = () => {},
    }: { signal?: AbortSignal; onProgress?: (event: Progress) => void } = {},
  ): Promise<ProviderResult> {
    const selected = buildPacket(
      this.session ? withTurnRules(context, this.agent, this.eventFormat, this.builtin) : context,
    );
    if (signal?.aborted) throw error('CANCELLED');
    this.timing = {};
    await this.checkVersion();
    const auth = await this.cachedStatus();
    if (!auth.available) throw error(auth.reason ?? 'AUTH_INVALID');
    if (signal?.aborted) throw error('CANCELLED');
    const cwd = await mkdtemp(join(tmpdir(), 'vide-cli-'));
    // With --json-schema the CLI may list and call its own output tool (no file, shell or network
    // access; SPIKE-2026-09-30-instruction-bundle): it is accepted only in a run that asked for it.
    const schema = outputSchemaOf(context);
    const outputTool = (name: unknown) => !!schema && name === 'StructuredOutput';
    // Native questions (flag): AskUserQuestion is offered and answered over the control channel.
    const questions = this.eventFormat === 'claude' ? this.nativeQuestions : undefined;
    const questionTool = (name: unknown) => !!questions && name === NATIVE_QUESTION_TOOL;
    // The work folder's file and shell tools ask VIDE over the same channel (ADR-031 8).
    const files = this.eventFormat === 'claude' ? this.builtin?.files : undefined;
    const prompts = !!questions || !!files;
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      const env = this.environment();
      delete env.VIDE_AGENT_TOKEN;
      if (this.agent) env.VIDE_AGENT_TOKEN = this.agent.token;
      const args = nativeQuestionArguments(
        configureAgentArguments(
          await this.withImages(
            await this.withOutputSchema(this.arguments(), schema, cwd),
            selected.images,
            cwd,
          ),
          this.eventFormat,
          this.agent,
          {
            neutral: !!this.session,
            bundle: this.instructions,
            builtin: this.builtin,
          },
        ),
        !!questions,
      );
      child = this.spawnProcess(
        this.executable,
        this.eventFormat === 'claude'
          ? workFolderArguments(args, files, { neutral: !!this.session, connected: !!this.agent })
          : args,
        {
          // The work folder is the CLI's own working directory; the temporary folder keeps the
          // run's files (images, schema) either way.
          cwd: this.builtin?.files?.cwd ?? cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      this.timing.spawnAt = Date.now();
      const result = await new Promise<ProviderResult>((resolve, reject) => {
        const decoder = new StringDecoder('utf8');
        let buffer = '',
          final: ProviderEvent | undefined,
          initialized = false,
          stopReason: string | undefined,
          settled = false,
          grace: ReturnType<typeof setTimeout> | undefined;
        const processChild = child!;
        // Aborted when the run ends, so an open question card is withdrawn.
        const asking = new AbortController();
        let codexText = '',
          codexFailed = false,
          failureText = '',
          // Only for classifying a failed run (a lost session is reported on stderr); never output.
          errorOutput = '';
        const progress = (event: Progress) => {
          try {
            onProgress(event);
          } catch {
            /* UI cannot change execution state. */
          }
        };
        const finish = (err: Error | null, value?: ProviderResult) => {
          if (settled) return;
          settled = true;
          asking.abort();
          clock.stop();
          clearTimeout(grace);
          signal?.removeEventListener('abort', abort);
          err ? reject(err) : resolve(value!);
        };
        const stop = (reason: string) => {
          if (settled || stopReason) return;
          stopReason = reason;
          clock.stop();
          asking.abort();
          progress({ state: 'stopping', reason });
          void killOwnedProcess(processChild);
          grace = setTimeout(() => {
            // Preserve the working directory if an unconfirmed process may still use it.
            processChild.stdout.destroy();
            processChild.stderr.destroy();
            processChild.unref();
            finish(error('STOP_UNCONFIRMED'));
          }, this.stopGraceMs);
        };
        const abort = () => stop('CANCELLED');
        // Only time without output counts (ADR-031 8).
        const clock = new IdleClock(this.timeoutMs, () => stop('TIMEOUT'));
        signal?.addEventListener('abort', abort, { once: true });
        // A control request (a question card, a file permission): the time the user takes is not
        // run time.
        const control = (event: ProviderEvent) => {
          const id = typeof event.request_id === 'string' ? event.request_id : undefined;
          const request = (event.request ?? {}) as {
            subtype?: unknown;
            tool_name?: unknown;
            input?: unknown;
            blocked_path?: unknown;
          };
          if (!id || !prompts) return stop('INVALID_PROVIDER_OUTPUT');
          const reply = (response: Record<string, unknown> | string) => {
            if (!settled && !stopReason) processChild.stdin.write(controlResponse(id, response));
          };
          if (request.subtype !== 'can_use_tool') return reply('unsupported');
          clock.hold();
          const asks = request.tool_name === NATIVE_QUESTION_TOOL && !!questions;
          if (asks) progress({ state: 'running', phase: 'question' });
          answerToolRequest(request, questions, asking.signal, this.toolPermission).then(
            (response) => {
              if (settled || stopReason) return;
              clock.release();
              if (asks) progress({ state: 'running', phase: 'model' });
              reply(response);
            },
            () => stop('QUESTION_FAILED'),
          );
        };
        const parse = (line: string) => {
          let event: ProviderEvent;
          try {
            event = eventSchema.parse(JSON.parse(line));
          } catch {
            stop('INVALID_PROVIDER_OUTPUT');
            return;
          }
          if (!event || typeof event.type !== 'string') {
            stop('INVALID_PROVIDER_OUTPUT');
            return;
          }
          if (stopReason) return;
          if (event.type === 'control_request') return control(event);
          if (this.eventFormat === 'codex') {
            if (event.type === 'turn.started') {
              initialized = true;
              progress({ state: 'running', phase: 'model' });
            }
            if (event.type.startsWith('item.')) {
              // A tool the turn does not have is refused by Codex's own configuration; the event
              // is reported and the turn goes on (ADR-031 8).
              if (
                !['agent_message', 'reasoning', 'plan', 'error'].includes(event.item?.type ?? '') &&
                !allowedAgentEvent(event, 'codex', this.agent, this.builtin)
              )
                progress({
                  state: 'running',
                  phase: 'tool',
                  tool: String(event.item?.type ?? 'unknown').slice(0, 100),
                  reason: 'TOOL_REFUSED',
                });
              if (event.item?.type === 'mcp_tool_call')
                progress({ state: 'running', phase: 'tool', tool: event.item.tool });
              if (event.item?.type === 'error') progress({ state: 'provider-warning' });
              if (event.type === 'item.completed' && event.item?.type === 'agent_message')
                codexText = event.item.text ?? '';
              if (
                event.type === 'item.completed' &&
                ['agent_message', 'reasoning'].includes(event.item?.type ?? '') &&
                event.item?.text
              )
                progress({
                  state: 'running',
                  phase: 'model',
                  kind: event.item.type === 'reasoning' ? 'thinking' : 'message',
                  text: event.item.text,
                });
            }
            if (event.type === 'turn.failed' || event.type === 'error') {
              codexFailed = true;
              failureText += ' ' + errorText(event);
            }
            if (event.item?.type === 'error') failureText += ' ' + errorText(event.item);
            if (event.type === 'turn.completed')
              final = {
                type: 'result',
                subtype: 'success',
                result: codexText,
                usage: event.usage,
                is_error: codexFailed,
              };
            return;
          }
          if (event.type === 'system' && event.subtype === 'init') {
            this.initChecked(event, (name) => outputTool(name) || questionTool(name), progress);
            initialized = true;
            progress({ state: 'running', phase: 'model' });
          }
          if (event.type === 'assistant')
            this.assistantEvent(event, progress, outputTool, questionTool);
          clock.claudeEvent(event);
          if (event.type === 'result') {
            // The stream-json input of a run with prompts stays open until the result.
            if (prompts) processChild.stdin.end();
            final = event;
            if (event.is_error) failureText += ' ' + errorText(event);
          }
        };
        processChild.stdout.on('data', (chunk) => {
          if (settled || stopReason) return;
          this.timing.firstOutputAt ??= Date.now();
          clock.arm();
          buffer += decoder.write(chunk);
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (line.length > MAX_EVENT_LINE) return stop('OUTPUT_TOO_LARGE');
            if (line.trim()) parse(line);
            if (settled || stopReason) return;
          }
          // One event per line: only a single line past the cap stops the run (ADR-028).
          if (buffer.length > MAX_EVENT_LINE) return stop('OUTPUT_TOO_LARGE');
        });
        processChild.stderr.on('data', (chunk: Buffer) => {
          if (errorOutput.length < 4096) errorOutput += chunk.toString('utf8');
        });
        processChild.stdin.on('error', () => stop('INPUT_DELIVERY_FAILED'));
        processChild.once('error', () => finish(error('CLI_UNAVAILABLE')));
        processChild.once('exit', () => {
          if (stopReason) progress({ state: 'stopped', reason: stopReason });
        });
        processChild.once('close', (code) => {
          const tail = buffer + decoder.end();
          if (!stopReason && tail.trim()) parse(tail);
          if (stopReason) return finish(error(stopReason));
          if (code !== 0 || final?.is_error || codexFailed) {
            // A changed login mode stops here (another account would fail the same way); a
            // subscription limit is told apart so another account can take the next request; a
            // resumed session without its transcript is reopened by hand-over (SPEC-02.19 5).
            return finish(error(this.failureCode(failureText, errorOutput)));
          }
          if (!initialized || final?.subtype !== 'success' || typeof final.result !== 'string')
            return finish(error('INCOMPLETE_RESULT'));
          finish(null, this.resultOf(final as ProviderEvent & { result: string }, selected));
        });
        if (signal?.aborted) abort();
        if (!stopReason) {
          progress({ state: 'starting' });
          if (prompts)
            processChild.stdin.write(this.inputOf(selected.packet, selected.images, true));
          else processChild.stdin.end(this.inputOf(selected.packet, selected.images));
        }
      });
      return result;
    } finally {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
        await rm(cwd, { recursive: true, force: true });
    }
  }
}
