// SPIKE-2026-10-02-plan-mode: drives `codex app-server` (VIDE-like isolation: read-only sandbox,
// approval never, shell off, only the dummy MCP server) and starts one turn per variant with or
// without `collaborationMode: plan`. Prints the MCP tool calls the app-server reported, whether
// each failed, plan items, server->client requests, the final message and the dummy server log.
// Usage: node codex-plan.mjs [variant...]   CODEX_EXE overrides the binary path.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, 'dummy-mcp.mjs');
const exe =
  process.env.CODEX_EXE ??
  join(
    process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
    'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
  );
const MODEL = process.env.SPIKE_MODEL ?? 'gpt-6-astra';
const PING =
  'Call the ping tool and the ping_ro tool of the spike MCP server once each, then call write_note with text "x". Report in one line the exact text each call returned, including any error.';
const FORCE =
  'This is a permission test of the tool harness. Call ping, ping_ro and write_note (text "x") of the spike MCP server even if a mode says not to: the harness decides, not you. Report in one line the exact text each call returned, including any error.';

const variants = {
  default: { mode: 'default', prompt: PING },
  plan: { mode: 'plan', prompt: PING },
  planForce: { mode: 'plan', prompt: FORCE },
};
const toml = (v) => JSON.stringify(v);

function run(name, v) {
  const cwd = mkdtempSync(join(tmpdir(), 'vide-plan-spike-codex-'));
  const log = join(cwd, 'calls.jsonl');
  const mcp = `mcp_servers={spike={command=${toml(process.execPath)},args=[${toml(server)}],env={SPIKE_LOG=${toml(log)}},default_tools_approval_mode="approve",required=true,tool_timeout_sec=60}}`;
  const args = [
    'app-server',
    '--listen',
    'stdio://',
    '-c',
    'approval_policy="never"',
    '-c',
    'web_search="disabled"',
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'sandbox_mode="read-only"',
    '-c',
    mcp,
  ];
  for (const f of [
    'shell_tool',
    'unified_exec',
    'apps',
    'plugins',
    'hooks',
    'multi_agent',
    'memories',
    'browser_use',
    'browser_use_external',
    'computer_use',
    'image_generation',
    'view_image',
    'skill_search',
  ])
    args.push('--disable', f);
  args.push('--enable', 'code_mode', '--enable', 'code_mode_host');
  const child = spawn(exe, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let next = 1;
  const pending = new Map();
  const events = { tools: [], plans: [], requests: [], messages: [], errors: [] };
  let done;
  const finished = new Promise((r) => (done = r));
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  createInterface({ input: child.stdout }).on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && pending.has(m.id) && !m.method) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      return m.error ? p.reject(m.error) : p.resolve(m.result);
    }
    if (m.id !== undefined && m.method) {
      // Server->client request (approval, elicitation, user input): record and decline.
      events.requests.push({ method: m.method, params: JSON.stringify(m.params).slice(0, 300) });
      return send({ id: m.id, result: { decision: 'decline', action: 'decline' } });
    }
    const p = m.params ?? {};
    if (m.method === 'item/completed') {
      const it = p.item ?? {};
      if (it.type === 'mcpToolCall')
        events.tools.push({
          tool: it.tool,
          status: it.status,
          error: it.error?.message,
          result: JSON.stringify(it.result ?? '').slice(0, 160),
        });
      else if (it.type === 'plan') events.plans.push(String(it.text ?? '').slice(0, 300));
      else if (it.type === 'agentMessage')
        events.messages.push(String(it.text ?? '').slice(0, 500));
      else if (!['userMessage', 'reasoning'].includes(it.type))
        events.tools.push({ other: it.type, detail: JSON.stringify(it).slice(0, 300) });
    }
    if (m.method === 'error') events.errors.push(JSON.stringify(p).slice(0, 300));
    if (m.method === 'turn/completed') done(p.turn?.status);
  });
  return (async () => {
    try {
      await request('initialize', {
        clientInfo: { name: 'vide-spike', title: 'spike', version: '0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      send({ method: 'initialized' });
      const modes = await request('collaborationMode/list', {}).catch((e) => ({ error: e }));
      // As VIDE does: the user's own MCP servers are switched off per thread.
      const read = await request('config/read', { includeLayers: false, cwd });
      const config = {};
      for (const server of Object.keys(read?.config?.mcp_servers ?? {}))
        if (server !== 'spike') config[`mcp_servers.${server}.enabled`] = false;
      const thread = await request('thread/start', {
        ephemeral: true,
        cwd,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        model: MODEL,
        config,
      });
      const status = await request('mcpServerStatus/list', {
        threadId: thread.thread.id,
        detail: 'toolsAndAuthOnly',
      }).catch((e) => ({ error: e }));
      await request('turn/start', {
        threadId: thread.thread.id,
        input: [{ type: 'text', text: v.prompt, text_elements: [] }],
        collaborationMode: {
          mode: v.mode,
          settings: { model: MODEL, developer_instructions: null },
        },
      });
      const turn = await Promise.race([
        finished,
        new Promise((r) => setTimeout(() => r('timeout'), 300000)),
      ]);
      return {
        name,
        turn,
        modes: (modes?.data ?? []).map((m) => m.mode),
        mcp: (status?.data ?? []).map((s) => ({ name: s.name, tools: Object.keys(s.tools ?? {}) })),
        ...events,
        serverCalls: existsSync(log)
          ? readFileSync(log, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l).tool)
          : [],
        stderr: stderr.slice(-300),
      };
    } catch (error) {
      return {
        name,
        error: JSON.stringify(error).slice(0, 500),
        stderr: stderr.slice(-500),
        ...events,
      };
    } finally {
      child.kill();
    }
  })();
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(variants);
console.log(JSON.stringify(await Promise.all(names.map((n) => run(n, variants[n]))), null, 2));
