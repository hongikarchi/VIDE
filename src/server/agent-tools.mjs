import { createHash, randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const digest = token => createHash('sha256').update(token).digest('hex');
const failure = code => Object.assign(new Error(code), { code });
const target = z.string().min(1).max(256);
const definitions = {
  query: { description: 'Read the current task target. Returns observed host data.', schema: z.object({ targetRef: target }).strict() },
  execute: { description: 'Run SDK code in the task-owned working copy. Does not apply changes to the user document.',
    schema: z.object({ targetRef: target, code: z.string().min(1).max(65536) }).strict() },
  status: { description: 'Read the current task execution status.', schema: z.object({}).strict() },
  cancel: { description: 'Request cancellation of the current task. The result determines whether stopping was confirmed.', schema: z.object({}).strict() },
};
const knownErrors = new Set(['STALE_REFERENCE', 'HOST_OWNERSHIP_MISMATCH', 'HOST_LEASE_EXPIRED',
  'HOST_UNAVAILABLE', 'HOST_RESULT_UNKNOWN', 'HOST_REJECTED', 'EXECUTOR_NOT_READY', 'CANCELLED']);

/** Internal controller capability, never minted by browser/agent input. No CAD executor is installed by default. */
export class AgentTools {
  #runs = new Map();
  #now;
  constructor({ now = Date.now } = {}) { this.#now = now; }

  issue({ targetRef, handlers, isCurrent, maxCalls = 20, ttlMs = 120000 }) {
    if (typeof targetRef !== 'string' || !targetRef || typeof isCurrent !== 'function' ||
        !handlers || !Object.keys(handlers).length ||
        Object.entries(handlers).some(([name, handler]) => !definitions[name] || typeof handler !== 'function') ||
        !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 100 ||
        !Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 600000) throw failure('INVALID_AGENT_SCOPE');
    // Bound retained capabilities even when callers forget to release completed runs.
    for (const [key, run] of this.#runs) if (run.expires <= this.#now()) this.#revoke(key);
    if (this.#runs.size >= 32) throw failure('AGENT_CAPACITY');
    const token = randomBytes(32).toString('hex'), key = digest(token);
    const run = { targetRef, handlers: { ...handlers }, isCurrent, remaining: maxCalls,
      expires: this.#now() + ttlMs, abort: new AbortController(), busy: false };
    this.#runs.set(key, run);
    return { token, revoke: () => this.#revoke(key) };
  }

  #revoke(key) {
    const run = this.#runs.get(key);
    if (run) { run.abort.abort(); this.#runs.delete(key); }
  }
  close() { for (const key of this.#runs.keys()) this.#revoke(key); }

  async handle(request, response, readBody) {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '')?.[1];
    const key = token && digest(token), run = key && this.#runs.get(key);
    if (!run || run.expires <= this.#now()) {
      if (run) this.#revoke(key);
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 'AGENT_UNAUTHORIZED' })); return;
    }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }); response.end(); return; }
    const input = await readBody(request);
    const server = new McpServer({ name: 'vide-task', version: '0.1.0' });
    for (const [name, handler] of Object.entries(run.handlers)) {
      const definition = definitions[name];
      server.registerTool(name, { description: definition.description, inputSchema: definition.schema }, async args => {
        const error = code => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code }) }] });
        if (run.abort.signal.aborted || run.expires <= this.#now()) return error('AGENT_SCOPE_EXPIRED');
        if (args.targetRef && args.targetRef !== run.targetRef) return error('TARGET_MISMATCH');
        const controlled = name === 'execute' || name === 'query';
        if (controlled && run.busy) return error('AGENT_BUSY');
        if (run.remaining <= 0) return error('AGENT_CALL_LIMIT');
        run.remaining--;
        if (controlled) run.busy = true;
        try {
          if (controlled && !await run.isCurrent()) return error('STALE_REFERENCE');
          // Conditions may change while the revision check is awaiting storage.
          if (run.abort.signal.aborted || run.expires <= this.#now()) return error('AGENT_SCOPE_EXPIRED');
          const result = await handler(args, { signal: run.abort.signal });
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (cause) { return error(knownErrors.has(cause?.code) ? cause.code : 'AGENT_TOOL_FAILED'); }
        finally { if (controlled) run.busy = false; }
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once('close', () => { void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(request, response, input); }
    catch (error) { await server.close(); throw error; }
  }
}
