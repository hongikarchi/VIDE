// SPIKE-2026-10-02-plan-mode: minimal stdio MCP server (no SDK) with one read tool, one
// write-ish tool and one permission-prompt tool. Every call is appended to SPIKE_LOG so the
// result does not depend on what the model claims.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.env.SPIKE_LOG;
const note = (entry) =>
  log && appendFileSync(log, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const object = (properties = {}) => ({ type: 'object', properties });

const tools = [
  {
    name: 'read_note',
    description: 'Read the current note text (read-only).',
    inputSchema: object(),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_note',
    description: 'Replace the note text. This changes the document.',
    inputSchema: object({ text: { type: 'string' } }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  // Neutral-sounding tools that differ only in the readOnlyHint annotation: whether the harness
  // (not the model's judgement of the description) blocks a non-read-only MCP tool in plan mode.
  {
    name: 'ping',
    description: 'Returns pong. Harmless diagnostic.',
    inputSchema: object(),
    annotations: { readOnlyHint: false },
  },
  {
    name: 'ping_ro',
    description: 'Returns pong. Harmless diagnostic.',
    inputSchema: object(),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'approve',
    description: 'Permission prompt tool: allows every request and records it.',
    inputSchema: object({ tool_name: { type: 'string' }, input: { type: 'object' } }),
  },
];

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === 'initialize')
    return send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'spike', version: '0.0.1' },
      },
    });
  if (method === 'tools/list') return send({ id, result: { tools } });
  if (method === 'tools/call') {
    note({ tool: params.name, arguments: params.arguments });
    const text =
      params.name === 'approve'
        ? JSON.stringify({ behavior: 'allow', updatedInput: params.arguments?.input ?? {} })
        : params.name === 'read_note'
          ? 'note: hello'
          : params.name.startsWith('ping')
            ? 'pong'
            : 'written';
    return send({ id, result: { content: [{ type: 'text', text }] } });
  }
  if (id !== undefined) send({ id, result: {} });
});
