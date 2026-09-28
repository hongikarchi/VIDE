import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { queryPageFields } from './query-page.ts';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const failure = (code: string) => Object.assign(new Error(code), { code });
const target = z.string().min(1).max(256);
const definitions = {
  query: {
    description:
      'Read a bounded page of the current task target. Use page.nextOffset with expectedRevision for subsequent pages, or objectIds for specific objects. Never treat one page as the whole model.',
    schema: z.object({ targetRef: target, ...queryPageFields }).strict(),
  },
  execute: {
    description:
      'Run SDK code on the task target. The task goal says whether that is a working copy or the open user document.',
    schema: z.object({ targetRef: target, code: z.string().min(1).max(65536) }).strict(),
  },
  status: { description: 'Read the current task execution status.', schema: z.object({}).strict() },
  cancel: {
    description:
      'Request cancellation of the current task. The result determines whether stopping was confirmed.',
    schema: z.object({}).strict(),
  },
};
type ToolName = keyof typeof definitions;
type ToolArgs<N extends ToolName> = z.infer<(typeof definitions)[N]['schema']>;
type Handler<N extends ToolName> = (
  args: ToolArgs<N>,
  context: { signal: AbortSignal },
) => unknown | Promise<unknown>;
type Handlers = { [N in ToolName]?: Handler<N> };
interface ScopeOptions {
  targetRef: string | string[];
  handlers: Handlers;
  isCurrent: () => boolean | Promise<boolean>;
  maxCalls?: number;
  ttlMs?: number;
}
interface Run {
  targets: Set<string>;
  handlers: Handlers;
  isCurrent: ScopeOptions['isCurrent'];
  remaining: number;
  expires: number;
  abort: AbortController;
  busy: boolean;
}
function toolName(value: string): value is ToolName {
  return Object.hasOwn(definitions, value);
}
function invoke(name: ToolName, handlers: Handlers, args: unknown, signal: AbortSignal) {
  switch (name) {
    case 'query':
      return handlers.query!(definitions.query.schema.parse(args), { signal });
    case 'execute':
      return handlers.execute!(definitions.execute.schema.parse(args), { signal });
    case 'status':
      return handlers.status!(definitions.status.schema.parse(args), { signal });
    case 'cancel':
      return handlers.cancel!(definitions.cancel.schema.parse(args), { signal });
  }
}
const knownErrors = new Set([
  'INVALID_INPUT',
  'QUERY_RESULT_TOO_LARGE',
  'STALE_REFERENCE',
  'HOST_OWNERSHIP_MISMATCH',
  'HOST_LEASE_EXPIRED',
  'HOST_UNAVAILABLE',
  'HOST_RESULT_UNKNOWN',
  'HOST_REJECTED',
  'HOST_COMMAND_LIMIT',
  'EXECUTOR_NOT_READY',
  'CANCELLED',
]);

/** Internal controller capability, never minted by browser/agent input. No CAD executor is installed by default. */
export class AgentTools {
  #runs = new Map<string, Run>();
  #now: () => number;
  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  issue({ targetRef, handlers, isCurrent, maxCalls = 20, ttlMs = 120000 }: ScopeOptions) {
    const targets = Array.isArray(targetRef) ? targetRef : [targetRef];
    if (
      targets.length < 1 ||
      targets.length > 8 ||
      new Set(targets).size !== targets.length ||
      targets.some((value) => !target.safeParse(value).success) ||
      typeof isCurrent !== 'function' ||
      !handlers ||
      !Object.keys(handlers).length ||
      Object.entries(handlers).some(
        ([name, handler]) => !toolName(name) || typeof handler !== 'function',
      ) ||
      !Number.isInteger(maxCalls) ||
      maxCalls < 1 ||
      maxCalls > 100 ||
      !Number.isFinite(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 600000
    )
      throw failure('INVALID_AGENT_SCOPE');
    // Bound retained capabilities even when callers forget to release completed runs.
    for (const [key, run] of this.#runs) if (run.expires <= this.#now()) this.#revoke(key);
    if (this.#runs.size >= 32) throw failure('AGENT_CAPACITY');
    const token = randomBytes(32).toString('hex'),
      key = digest(token);
    const run = {
      targets: new Set(targets),
      handlers: { ...handlers },
      isCurrent,
      remaining: maxCalls,
      expires: this.#now() + ttlMs,
      abort: new AbortController(),
      busy: false,
    };
    this.#runs.set(key, run);
    return { token, revoke: () => this.#revoke(key) };
  }

  #revoke(key: string) {
    const run = this.#runs.get(key);
    if (run) {
      run.abort.abort();
      this.#runs.delete(key);
    }
  }
  close() {
    for (const key of this.#runs.keys()) this.#revoke(key);
  }

  /** Controller-only dispatch; applies the same checks as MCP without a loopback HTTP hop. */
  async call(token: string, name: ToolName, raw: unknown): Promise<CallToolResult> {
    const run = this.#runs.get(digest(token));
    if (!run)
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: 'AGENT_UNAUTHORIZED' }) }],
      };
    if (!toolName(name) || !run.handlers[name])
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: 'AGENT_TOOL_UNAVAILABLE' }) }],
      };
    const parsed = definitions[name].schema.safeParse(raw);
    if (!parsed.success)
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: 'INVALID_INPUT' }) }],
      };
    return this.#invoke(run, name, parsed.data);
  }
  async #invoke(run: Run, name: ToolName, args: { targetRef?: string }): Promise<CallToolResult> {
    const error = (code: string): CallToolResult => ({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ code }) }],
    });
    if (run.abort.signal.aborted || run.expires <= this.#now()) return error('AGENT_SCOPE_EXPIRED');
    if (args.targetRef && !run.targets.has(args.targetRef)) return error('TARGET_MISMATCH');
    const controlled = name === 'execute' || name === 'query';
    if (controlled && run.busy) return error('AGENT_BUSY');
    if (run.remaining <= 0) return error('AGENT_CALL_LIMIT');
    run.remaining--;
    if (controlled) run.busy = true;
    try {
      if (controlled && !(await run.isCurrent())) return error('STALE_REFERENCE');
      // Conditions may change while the revision check is awaiting storage.
      if (run.abort.signal.aborted || run.expires <= this.#now())
        return error('AGENT_SCOPE_EXPIRED');
      const result = await invoke(name, run.handlers, args, run.abort.signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (cause) {
      const code =
        cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
          ? cause.code
          : '';
      return error(knownErrors.has(code) ? code : 'AGENT_TOOL_FAILED');
    } finally {
      if (controlled) run.busy = false;
    }
  }
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    readBody: (request: IncomingMessage) => Promise<unknown>,
  ) {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '')?.[1];
    const key = token && digest(token),
      run = key && this.#runs.get(key);
    if (!run || run.expires <= this.#now()) {
      if (run && key) this.#revoke(key);
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 'AGENT_UNAUTHORIZED' }));
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return;
    }
    const input = await readBody(request);
    const server = new McpServer({ name: 'vide-task', version: '0.1.0' });
    for (const name of Object.keys(run.handlers)) {
      if (!toolName(name)) continue;
      const definition = definitions[name];
      server.registerTool(
        name,
        { description: definition.description, inputSchema: definition.schema },
        async (args: { targetRef?: string }): Promise<CallToolResult> => {
          return this.#invoke(run, name, args);
        },
      );
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.once('close', () => {
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, input);
    } catch (error) {
      await server.close();
      throw error;
    }
  }
}
