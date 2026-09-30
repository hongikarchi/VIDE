import { z } from 'zod';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentConnection, AgentFormat } from './agent-connection.ts';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  agentConnection,
  configureAgentArguments,
  allowedAgentEvent,
  neutralInstruction,
  noToolsInstruction,
  turnRules,
  instructionModeFor,
} from './agent-connection.ts';
import {
  bundleFor,
  withRules,
  type InstructionHost,
  type InstructionMode,
} from './instructions/index.ts';
import compat from './cli-compat.json' with { type: 'json' };

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
  configDirectory?: string;
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
}
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
type ProviderEvent = z.infer<typeof eventSchema>;

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
  const images: PacketImage[] = [];
  for (const entry of data)
    if (entry.type === 'image') {
      const { dataUrl, ...meta } = (entry.data ?? {}) as { dataUrl?: unknown };
      images.push(packetImage(dataUrl));
      entry.data = { ...meta, image: images.length };
    }
  if (images.length > MAX_PACKET_IMAGES) throw error('CONTEXT_TOO_LARGE');
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
/** A picture for the model (PLAN-24): base64 PNG or JPEG, at most 3 per turn and 1 MB each. */
export interface PacketImage {
  mediaType: 'image/png' | 'image/jpeg';
  data: string;
}
export const MAX_PACKET_IMAGES = 3;
export const MAX_PACKET_IMAGE_BYTES = 1_000_000;
/** A data URL of an image item; anything else is an invalid context. */
export function packetImage(dataUrl: unknown): PacketImage {
  const match =
    typeof dataUrl === 'string' &&
    /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw error('INVALID_CONTEXT');
  if (Buffer.byteLength(match[2], 'base64') > MAX_PACKET_IMAGE_BYTES)
    throw error('CONTEXT_TOO_LARGE');
  return { mediaType: match[1] as PacketImage['mediaType'], data: match[2] };
}

export function subscriptionEnvironment(source = process.env) {
  // Preserve ordinary OS/proxy settings and the official subscription login, never API fallback credentials.
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      // TYPESAFE_*: the Jev key is VIDE's own and never reaches the CLI.
      /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|CLAUDE_AGENT_SDK_|CLAUDE_ENV_FILE$|TYPESAFE_)/i.test(
        key,
      )
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
) {
  const item = { id: 'turn-rules', type: 'turn-rules', data: turnRules(connection, format) };
  return {
    ...context,
    items: [item, ...context.items],
    includedIds: [item.id, ...context.includedIds],
  };
}
/**
 * Removes the transcript of one VIDE session from a Claude profile (ARCH-01 §2 record
 * management): `<profile>/projects/<folder>/<sessionId>.jsonl`, wherever the first turn ran, and
 * the project folder when it is left empty. Nothing else in the profile is touched.
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
    try {
      if (!(await readdir(join(projects, folder))).length) await rmdir(join(projects, folder));
    } catch {
      /* Another session's files keep the folder. */
    }
  }
  return removed;
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
  configDirectory?: string;
  agent?: AgentConnection;
  session?: SessionOptions;
  /** The instruction bundle of every run of this provider (PLAN-24 지침 묶음). */
  instructions: string;
  constructor({
    executable,
    configDirectory,
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
  }: CliOptions = {}) {
    if (typeof executable !== 'string' || !isAbsolute(executable)) throw error('CLI_PATH_REQUIRED');
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 1 ||
      !Number.isFinite(stopGraceMs) ||
      stopGraceMs < 1
    )
      throw error('INVALID_LIMIT');
    if (
      configDirectory !== undefined &&
      (!isAbsolute(configDirectory) || configDirectory.includes('\0'))
    )
      throw error('INVALID_PROFILE_DIRECTORY');
    this.configDirectory = configDirectory;
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.stopGraceMs = stopGraceMs;
    this.spawnProcess = spawnProcess;
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
  environment() {
    const env = subscriptionEnvironment();
    if (this.configDirectory) env.CLAUDE_CONFIG_DIR = this.configDirectory;
    return env;
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
  inputOf(packet: unknown, images: readonly PacketImage[]) {
    const text = JSON.stringify(packet);
    if (!images.length) return text;
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
  async run(
    context: ProviderContext,
    {
      signal,
      onProgress = () => {},
    }: { signal?: AbortSignal; onProgress?: (event: Progress) => void } = {},
  ): Promise<ProviderResult> {
    const selected = buildPacket(
      this.session ? withTurnRules(context, this.agent, this.eventFormat) : context,
    );
    if (signal?.aborted) throw error('CANCELLED');
    await this.checkVersion();
    const auth = await this.status();
    if (!auth.available) throw error(auth.reason ?? 'AUTH_INVALID');
    if (signal?.aborted) throw error('CANCELLED');
    const cwd = await mkdtemp(join(tmpdir(), 'vide-cli-'));
    // With --json-schema the CLI may list and call its own output tool (no file, shell or network
    // access; SPIKE-2026-09-30-instruction-bundle): it is accepted only in a run that asked for it.
    const schema = outputSchemaOf(context);
    const outputTool = (name: unknown) => !!schema && name === 'StructuredOutput';
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      const env = this.environment();
      delete env.VIDE_AGENT_TOKEN;
      if (this.agent) env.VIDE_AGENT_TOKEN = this.agent.token;
      child = this.spawnProcess(
        this.executable,
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
          },
        ),
        {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const result = await new Promise<ProviderResult>((resolve, reject) => {
        const decoder = new StringDecoder('utf8');
        let buffer = '',
          bytes = 0,
          final: ProviderEvent | undefined,
          initialized = false,
          stopReason: string | undefined,
          settled = false,
          grace: ReturnType<typeof setTimeout> | undefined;
        const processChild = child!;
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
          clearTimeout(timer);
          clearTimeout(grace);
          signal?.removeEventListener('abort', abort);
          err ? reject(err) : resolve(value!);
        };
        const stop = (reason: string) => {
          if (settled || stopReason) return;
          stopReason = reason;
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
        const timer = setTimeout(() => stop('TIMEOUT'), this.timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
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
          if (this.eventFormat === 'codex') {
            if (event.type === 'turn.started') {
              initialized = true;
              progress({ state: 'running', phase: 'model' });
            }
            if (event.type.startsWith('item.')) {
              if (
                !['agent_message', 'reasoning', 'plan', 'error'].includes(event.item?.type ?? '') &&
                !allowedAgentEvent(event, 'codex', this.agent)
              ) {
                stop('UNEXPECTED_TOOL_CALL');
                return;
              }
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
            const tools = Array.isArray(event.tools)
              ? event.tools.filter((name) => !outputTool(name))
              : undefined;
            const valid = this.agent
              ? Array.isArray(tools) &&
                tools.every((name) => allowedAgentEvent({ name }, 'claude', this.agent)) &&
                Array.isArray(event.mcp_servers) &&
                event.mcp_servers.length === 1 &&
                event.mcp_servers[0].name === 'vide' &&
                event.mcp_servers[0].status === 'connected'
              : Array.isArray(tools) &&
                !tools.length &&
                Array.isArray(event.mcp_servers) &&
                !event.mcp_servers.length;
            if (!valid) {
              stop('UNEXPECTED_TOOL_ACCESS');
              return;
            }
            initialized = true;
            progress({ state: 'running', phase: 'model' });
          }
          if (event.type === 'assistant')
            for (const item of (typeof event.message === 'object'
              ? event.message.content
              : undefined) || []) {
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
                if (!outputTool(item.name) && !allowedAgentEvent(item, 'claude', this.agent)) {
                  stop('UNEXPECTED_TOOL_CALL');
                  return;
                }
                progress({
                  state: 'running',
                  phase: 'tool',
                  tool: item.name?.slice('mcp__vide__'.length),
                });
              }
            }
          if (event.type === 'result') {
            final = event;
            if (event.is_error) failureText += ' ' + errorText(event);
          }
        };
        processChild.stdout.on('data', (chunk) => {
          if (settled || stopReason) return;
          bytes += chunk.length;
          if (bytes > 1024 * 1024) return stop('OUTPUT_TOO_LARGE');
          buffer += decoder.write(chunk);
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (line.trim()) parse(line);
          }
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
          if (code !== 0 || final?.is_error || codexFailed)
            // A changed login mode stops here (another account would fail the same way); a
            // subscription limit is told apart so another account can take the next request; a
            // resumed session without its transcript is reopened by hand-over (SPEC-02.19 5).
            return finish(
              error(
                MODE_CHANGED.test(failureText)
                  ? 'CLI_MODE_CHANGED'
                  : USAGE_LIMIT.test(failureText)
                    ? 'PROVIDER_LIMIT'
                    : this.session?.resume && SESSION_LOST.test(failureText + ' ' + errorOutput)
                      ? 'SESSION_LOST'
                      : 'PROVIDER_FAILED',
              ),
            );
          if (!initialized || final?.subtype !== 'success' || typeof final.result !== 'string')
            return finish(error('INCOMPLETE_RESULT'));
          finish(null, {
            text: final.result,
            revision: selected.packet.revision,
            manifest: selected.manifest,
            ...(final.structured_output !== undefined
              ? { structured: final.structured_output }
              : {}),
            usage: {
              inputTokens: final.usage?.input_tokens ?? null,
              outputTokens: final.usage?.output_tokens ?? null,
              cacheReadTokens:
                final.usage?.cache_read_input_tokens ?? final.usage?.cached_input_tokens ?? null,
              cacheCreationTokens:
                final.usage?.cache_creation_input_tokens ??
                final.usage?.cache_write_input_tokens ??
                null,
              subscriptionRemaining: null,
            },
          });
        });
        if (signal?.aborted) abort();
        if (!stopReason) {
          progress({ state: 'starting' });
          processChild.stdin.end(this.inputOf(selected.packet, selected.images));
        }
      });
      return result;
    } finally {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
        await rm(cwd, { recursive: true, force: true });
    }
  }
}
