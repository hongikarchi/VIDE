// Claude conversation turns in a kept process (ADR-028, T-104; 2026-10-02 user decision "Claude도
// 대화마다 프로세스 하나를 띄워 두고 턴을 입력 스트림으로 넣는 방식으로 바꾸자"). One `claude -p
// --input-format stream-json` process per conversation session; each turn is one user message on
// its stdin and ends with the turn's `result` event (after the subagents it started have reported).
// Everything fixed when the process starts — model, effort, appended prompt, MCP server and tools,
// built-in tools, plan or auto, the question tool, the output schema, the login — makes up the
// process key: a turn with another key ends the kept process and starts one that resumes the same
// session (`--resume`). `VIDE_CLAUDE_PERSISTENT=0` sends Claude back to one process per turn.

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { configureAgentArguments, workFolderArguments } from './agent-connection.ts';
import { bindAgentRelay, unbindAgentRelay } from './agent-relay.ts';
import { defaultLogin } from './account-usage.ts';
import {
  ClaudeCli,
  IdleClock,
  MAX_EVENT_LINE,
  NATIVE_QUESTION_TOOL,
  ProviderError,
  answerToolRequest,
  buildPacket,
  controlResponse,
  killOwnedProcess,
  nativeQuestionArguments,
  outputSchemaOf,
  parseProviderEvent,
  providerErrorText,
  withTurnRules,
  type CliOptions,
  type Progress,
  type ProviderContext,
  type ProviderEvent,
  type ProviderResult,
} from './claude-cli.ts';

const error = (code: string) => new ProviderError(code);

/** The flag (config): on unless `VIDE_CLAUDE_PERSISTENT=0`, which runs one process per turn. */
export const CLAUDE_PERSISTENT_FLAG = 'VIDE_CLAUDE_PERSISTENT';
export function claudePersistentEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env[CLAUDE_PERSISTENT_FLAG] !== '0';
}
export const CLAUDE_PROCESS_IDLE_MS = 10 * 60 * 1000;
/**
 * After the last subagent of a turn reported, the CLI starts a turn of its own to read the report
 * (SPIKE-2026-10-02 ②). If none starts within this time the last result is the answer.
 */
export const BACKGROUND_SETTLE_MS = 5000;
/** How long a stopped turn waits for the CLI to end it itself before the process is ended. */
export const INTERRUPT_WAIT_MS = 2000;

/** Who Claude's default login is (its e-mail), '' when unreadable: AccountSwitch may change it. */
export function claudeLoginKey(home = homedir()) {
  return defaultLogin('claude-cli', home).email ?? '';
}
/** The arguments without the session flag pair (`--session-id`/`--resume` and the id). */
export function processArguments(args: readonly string[]) {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-id' || args[i] === '--resume') {
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

type Signal = { event: ProviderEvent } | { closed: number | null } | { failed: string };
type Kill = (child: ChildProcessWithoutNullStreams) => Promise<boolean>;

/** One kept process: its line reader, the turn listening to it, and what it was started with. */
class Kept {
  readonly child: ChildProcessWithoutNullStreams;
  readonly key: string;
  readonly cwd: string;
  readonly sessionId: string;
  /** The MCP bearer token the process carries (it stands for the running turn's, agent-relay.ts). */
  readonly token?: string;
  busy = true;
  closed = false;
  /** A turn failed or was ended by force: the process is not used again. */
  broken = false;
  /** An earlier turn's init event passed the tool check (same key, same tools). */
  validated = false;
  idle?: ReturnType<typeof setTimeout>;
  errorOutput = '';
  readonly kill: Kill;
  private listener?: (signal: Signal) => void;
  constructor(
    child: ChildProcessWithoutNullStreams,
    key: string,
    cwd: string,
    sessionId: string,
    kill: Kill,
    token?: string,
  ) {
    this.child = child;
    this.kill = kill;
    this.key = key;
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.token = token;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.length > MAX_EVENT_LINE) return this.fail('OUTPUT_TOO_LARGE');
        if (!line.trim()) continue;
        const event = parseProviderEvent(line);
        if (!event) return this.fail('INVALID_PROVIDER_OUTPUT');
        // Output while no turn listens (a turn the CLI opened itself after VIDE ended the last
        // one): its events would be read as the next turn's answer. The process is not used again.
        if (!this.listener) return this.stale();
        this.listener({ event });
      }
      if (buffer.length > MAX_EVENT_LINE) this.fail('OUTPUT_TOO_LARGE');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.errorOutput.length < 4096) this.errorOutput += chunk.toString('utf8');
    });
    // `on`, not `once`: the process lives between turns and a second 'error' must not throw.
    child.stdin.on('error', () => this.fail('INPUT_DELIVERY_FAILED'));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.on('error', () => this.fail('CLI_UNAVAILABLE'));
    child.on('close', (code: number | null) => {
      this.closed = true;
      this.listener?.({ closed: code });
      if (!this.busy) void dispose(this);
    });
  }
  /** A failure of the process itself: the running turn ends with it and the process is ended. */
  failure?: string;
  fail(code: string) {
    if (this.closed || this.failure) return;
    this.failure = code;
    this.broken = true;
    if (this.listener) this.listener({ failed: code });
    else void this.kill(this.child);
  }
  /** Output no turn reads: the process is ended (now if idle, else when its turn releases it). */
  stale() {
    if (this.closed) return;
    this.broken = true;
    if (!this.busy) void dispose(this);
  }
  listen(listener?: (signal: Signal) => void) {
    this.listener = listener;
  }
  write(line: string) {
    if (this.closed) return false;
    try {
      this.child.stdin.write(line);
      return true;
    } catch {
      this.fail('INPUT_DELIVERY_FAILED');
      return false;
    }
  }
}

const live = new Map<string, Kept>();
async function dispose(entry: Kept) {
  clearTimeout(entry.idle);
  if (live.get(entry.sessionId) === entry) live.delete(entry.sessionId);
  if (entry.token) unbindAgentRelay(entry.token);
  entry.listen(undefined);
  if (!entry.closed) await entry.kill(entry.child);
  // Windows keeps the folder busy for a moment after the process tree is ended.
  await rm(entry.cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
    () => {},
  );
}
/** Ends every kept process (engine shutdown, tests). */
export async function closeClaudeProcesses() {
  await Promise.all([...live.values()].map(dispose));
}
/** The sessions that have a kept process right now (diagnostics, tests). */
export function liveClaudeSessions() {
  return [...live.keys()];
}

type RunOptions = { signal?: AbortSignal; onProgress?: (event: Progress) => void };
const TASK_DONE = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'error']);
type Usage = NonNullable<ProviderEvent['usage']>;
const USAGE_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;
function addUsage(sum: Usage | undefined, usage: Usage | undefined): Usage | undefined {
  if (!usage) return sum;
  const out: Record<string, number> = { ...(sum ?? {}) } as Record<string, number>;
  for (const key of USAGE_KEYS)
    if (typeof usage[key] === 'number') out[key] = (out[key] ?? 0) + (usage[key] as number);
  return out as Usage;
}

/**
 * Claude with one kept process per conversation session (ADR-028). A run without a session (a
 * single run) goes through `ClaudeCli` as before: one process per run.
 */
export interface KeptOptions extends CliOptions {
  idleMs?: number;
  /** Test seams: who the default login is, how long to wait after the last subagent report, how a process is ended. */
  loginKey?: () => string;
  settleMs?: number;
  killProcess?: Kill;
}
export class KeptClaudeCli extends ClaudeCli {
  idleMs: number;
  settleMs: number;
  /** Who the default login is now (default: `claudeLoginKey`). */
  loginKey: () => string;
  killProcess: Kill;
  constructor(options: KeptOptions = {}) {
    super(options);
    const idleMs = options.idleMs ?? CLAUDE_PROCESS_IDLE_MS;
    const settleMs = options.settleMs ?? BACKGROUND_SETTLE_MS;
    if (!Number.isFinite(idleMs) || idleMs < 1 || !Number.isFinite(settleMs) || settleMs < 0)
      throw error('INVALID_LIMIT');
    this.idleMs = idleMs;
    this.settleMs = settleMs;
    this.loginKey = options.loginKey ?? (() => claudeLoginKey());
    this.killProcess = options.killProcess ?? killOwnedProcess;
  }
  /** The turn's process arguments: the session turn's, always reading stream-json input. */
  private async processArgs(schema: string | undefined) {
    const args = workFolderArguments(
      nativeQuestionArguments(
        configureAgentArguments(
          await this.withOutputSchema(this.arguments(), schema, ''),
          'claude',
          this.agent,
          { neutral: true, bundle: this.instructions, builtin: this.builtin },
        ),
        !!this.nativeQuestions,
      ),
      this.builtin?.files,
      { neutral: true, connected: !!this.agent },
    );
    if (!args.includes('--input-format')) args.push('--input-format', 'stream-json');
    return args;
  }
  async run(context: ProviderContext, options: RunOptions = {}): Promise<ProviderResult> {
    if (!this.session) return super.run(context, options);
    const { signal, onProgress = () => {} } = options;
    const progress = (event: Progress) => {
      try {
        onProgress(event);
      } catch {
        /* UI cannot change execution state. */
      }
    };
    const selected = buildPacket(withTurnRules(context, this.agent, 'claude', this.builtin));
    if (signal?.aborted) throw error('CANCELLED');
    this.timing = {};
    await this.checkVersion();
    if (signal?.aborted) throw error('CANCELLED');
    const schema = outputSchemaOf(context);
    const args = await this.processArgs(schema);
    // The working directory (the project work folder) is part of what the process started with.
    const key = JSON.stringify([
      this.executable,
      this.loginKey(),
      this.builtin?.files?.cwd ?? '',
      processArguments(args),
    ]);
    progress({ state: 'starting' });
    const { entry, reused } = await this.acquire(args, key);
    this.timing.processReused = reused;
    // The process token stands for this turn's scope while the turn runs (agent-relay.ts).
    if (entry.token && this.agent) bindAgentRelay(entry.token, this.agent.token);
    let keep = false;
    try {
      const value = await this.turn(entry, selected, !!schema, signal, progress);
      keep = true;
      return value;
    } catch (cause) {
      // A turn the CLI ended itself on a stop keeps its process; anything else does not.
      const code = (cause as { code?: unknown })?.code;
      keep = !entry.broken && (code === 'CANCELLED' || code === 'TIMEOUT');
      throw cause;
    } finally {
      if (entry.token) unbindAgentRelay(entry.token);
      await this.release(entry, keep);
    }
  }
  /** The session's kept process when its key matches, else a new one (resuming the session). */
  private async acquire(args: string[], key: string): Promise<{ entry: Kept; reused: boolean }> {
    const sessionId = this.session!.id;
    let entry = live.get(sessionId);
    // One running turn per conversation: a second one never shares or ends the first's process.
    if (entry?.busy) throw error('CONVERSATION_BUSY');
    if (entry && (entry.closed || entry.broken || entry.key !== key)) {
      await dispose(entry);
      entry = undefined;
    }
    if (entry) {
      clearTimeout(entry.idle);
      entry.busy = true;
      return { entry, reused: true };
    }
    const auth = await this.cachedStatus();
    if (!auth.available) throw error(auth.reason ?? 'AUTH_INVALID');
    const cwd = await mkdtemp(join(tmpdir(), 'vide-claude-'));
    const token = this.agent ? randomBytes(32).toString('hex') : undefined;
    const env = this.environment();
    delete env.VIDE_AGENT_TOKEN;
    if (token) env.VIDE_AGENT_TOKEN = token;
    // The MCP server is asked for its tools when the process starts: the token stands for this
    // turn's scope from the start.
    if (token && this.agent) bindAgentRelay(token, this.agent.token);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(this.executable, args, {
        // The project work folder (ADR-031 8); the temporary folder otherwise.
        cwd: this.builtin?.files?.cwd ?? cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch {
      if (token) unbindAgentRelay(token);
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
      throw error('CLI_UNAVAILABLE');
    }
    entry = new Kept(child, key, cwd, sessionId, this.killProcess, token);
    live.set(sessionId, entry);
    return { entry, reused: false };
  }
  private async release(entry: Kept, keep: boolean) {
    entry.busy = false;
    entry.listen(undefined);
    if (!keep || entry.closed || entry.broken) return dispose(entry);
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => void dispose(entry), this.idleMs);
    entry.idle.unref?.();
  }
  /** One turn: the user message in, the events read until the turn's result. */
  private turn(
    entry: Kept,
    selected: ReturnType<typeof buildPacket>,
    structured: boolean,
    signal: AbortSignal | undefined,
    progress: (event: Progress) => void,
  ): Promise<ProviderResult> {
    const questions = this.nativeQuestions;
    // Question cards and the work folder's file permissions come over the control channel.
    const prompts = !!questions || !!this.builtin?.files;
    const outputTool = (name: unknown) => structured && name === 'StructuredOutput';
    const questionTool = (name: unknown) => !!questions && name === NATIVE_QUESTION_TOOL;
    return new Promise<ProviderResult>((resolve, reject) => {
      let settled = false,
        stopReason: string | undefined,
        initialized = entry.validated,
        final: ProviderEvent | undefined,
        usage: Usage | undefined,
        failureText = '',
        settle: ReturnType<typeof setTimeout> | undefined,
        grace: ReturnType<typeof setTimeout> | undefined;
      // Subagents the turn started in the background (task ids), until each reports.
      const pending = new Set<string>();
      // A subagent reported since the last init: the CLI may open a turn of its own to read the
      // report (SPIKE-2026-10-02 ②), even when the report came before the result.
      let reported = false;
      const waitOrComplete = () => {
        clearTimeout(settle);
        if (reported && !final?.is_error) settle = setTimeout(complete, this.settleMs);
        else complete();
      };
      const asking = new AbortController();
      const finish = (err: Error | null, value?: ProviderResult) => {
        if (settled) return;
        settled = true;
        asking.abort();
        clock.stop();
        clearTimeout(settle);
        clearTimeout(grace);
        signal?.removeEventListener('abort', abort);
        entry.listen(undefined);
        if (err) {
          // A failed turn's process is not used again; a stop the CLI ended itself may be.
          if (!stopReason) entry.broken = true;
          reject(err);
        } else resolve(value!);
      };
      const stopped = () => {
        // The CLI ended the stopped turn itself; subagents still running would outlive it.
        if (pending.size) entry.broken = true;
        progress({ state: 'stopped', reason: stopReason });
        finish(error(stopReason!));
      };
      // Ends the process by force; the turn ends when its exit is seen (else unconfirmed).
      const end = () => {
        entry.broken = true;
        clearTimeout(grace);
        void entry.kill(entry.child);
        grace = setTimeout(() => finish(error('STOP_UNCONFIRMED')), this.stopGraceMs);
      };
      const halt = (reason: string) => {
        if (settled || stopReason) return false;
        stopReason = reason;
        asking.abort();
        clock.stop();
        clearTimeout(settle);
        progress({ state: 'stopping', reason });
        return true;
      };
      // A stop (cancel, time-out): ask the CLI to end the turn and keep the process; if it does
      // not within a moment, end the process.
      const stop = (reason: string) => {
        if (!halt(reason)) return;
        const asked =
          !entry.closed &&
          entry.write(
            JSON.stringify({
              type: 'control_request',
              request_id: `vide-interrupt-${randomBytes(6).toString('hex')}`,
              request: { subtype: 'interrupt' },
            }) + '\n',
          );
        grace = setTimeout(end, asked ? Math.min(INTERRUPT_WAIT_MS, this.stopGraceMs) : 0);
      };
      // A broken rule or stream: the process is ended at once and not used again.
      const fail = (reason: string) => {
        if (halt(reason)) end();
      };
      const abort = () => stop('CANCELLED');
      // Only time without output counts (ADR-031 8).
      const clock = new IdleClock(this.timeoutMs, () => stop('TIMEOUT'));
      signal?.addEventListener('abort', abort, { once: true });
      const complete = () => {
        if (settled || stopReason) return;
        if (final?.is_error) {
          entry.broken = true;
          return finish(error(this.failureCode(failureText, entry.errorOutput)));
        }
        if (!initialized || final?.subtype !== 'success' || typeof final.result !== 'string') {
          entry.broken = true;
          return finish(error('INCOMPLETE_RESULT'));
        }
        finish(null, this.resultOf(final as ProviderEvent & { result: string }, selected, usage));
      };
      const control = (event: ProviderEvent) => {
        const id = typeof event.request_id === 'string' ? event.request_id : undefined;
        const request = (event.request ?? {}) as {
          subtype?: unknown;
          tool_name?: unknown;
          input?: unknown;
          blocked_path?: unknown;
        };
        if (!id || !prompts) return fail('INVALID_PROVIDER_OUTPUT');
        const reply = (response: Record<string, unknown> | string) => {
          if (!settled && !stopReason) entry.write(controlResponse(id, response));
        };
        if (request.subtype !== 'can_use_tool') return reply('unsupported');
        // The time the person takes is not run time.
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
          () => fail('QUESTION_FAILED'),
        );
      };
      const handle = (signalled: Signal) => {
        if ('failed' in signalled) {
          if (signalled.failed === 'CLI_UNAVAILABLE') return finish(error(signalled.failed));
          return fail(signalled.failed);
        }
        if ('closed' in signalled) {
          entry.broken = true;
          if (stopReason) return stopped();
          // The process ended between the turn's last result and its completion.
          if (final && !pending.size) return complete();
          return finish(
            error(
              signalled.closed !== 0 || final?.is_error
                ? this.failureCode(failureText, entry.errorOutput)
                : 'INCOMPLETE_RESULT',
            ),
          );
        }
        const { event } = signalled;
        clock.claudeEvent(event);
        if (event.type === 'control_response') return;
        if (stopReason) {
          if (event.type === 'result') stopped();
          return;
        }
        if (event.type === 'control_request') return control(event);
        if (event.type === 'system') {
          if (event.subtype === 'init') {
            clearTimeout(settle);
            reported = false;
            if (typeof event.session_id === 'string' && event.session_id !== entry.sessionId)
              return fail('SESSION_LOST');
            // An unexpected tool list is a warning; the CLI refuses what the turn did not allow.
            this.initChecked(event, (name) => outputTool(name) || questionTool(name), progress);
            initialized = true;
            entry.validated = true;
            progress({ state: 'running', phase: 'model' });
            return;
          }
          const task = typeof event.task_id === 'string' ? event.task_id : undefined;
          if (event.subtype === 'task_started' && task) pending.add(task);
          if (
            task &&
            (event.subtype === 'task_notification' ||
              (event.subtype === 'task_updated' &&
                TASK_DONE.has(String((event as { status?: unknown }).status))))
          ) {
            pending.delete(task);
            reported = true;
            // The CLI reads the report in a turn of its own; without one the last result stands.
            if (final && !pending.size) waitOrComplete();
          }
          return;
        }
        if (event.type === 'assistant') {
          clearTimeout(settle);
          this.assistantEvent(event, progress, outputTool, questionTool);
          return;
        }
        if (event.type === 'result') {
          final = event;
          usage = addUsage(usage, event.usage);
          if (event.is_error) failureText += ' ' + providerErrorText(event);
          if (!pending.size) waitOrComplete();
        }
      };
      if (signal?.aborted) {
        // Nothing was sent: the process is as the last turn left it.
        stopReason = 'CANCELLED';
        progress({ state: 'stopped', reason: stopReason });
        return finish(error(stopReason));
      }
      // The first output of this turn (a kept process answered earlier turns already).
      entry.listen((signalled) => {
        this.timing.firstOutputAt ??= Date.now();
        handle(signalled);
      });
      if (entry.closed) return handle({ closed: entry.child.exitCode });
      this.timing.spawnAt = Date.now();
      if (!entry.write(this.inputOf(selected.packet, selected.images, true)))
        return handle({ closed: entry.child.exitCode });
    });
  }
}
