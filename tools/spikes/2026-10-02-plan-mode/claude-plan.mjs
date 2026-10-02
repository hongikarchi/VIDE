// SPIKE-2026-10-02-plan-mode: runs Claude Code CLI variants (VIDE-like isolation) against the
// dummy MCP server and prints, per variant: tools in the init event, the permission mode, each
// tool_use and whether its result was an error, permission denials, and the server's call log.
// Usage: node claude-plan.mjs [variant...]   (runs all when none given; in a throwaway temp cwd)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, 'dummy-mcp.mjs');
const READ = 'mcp__spike__read_note';
const WRITE = 'mcp__spike__write_note';
const PROMPT =
  'Call the read_note tool, then call write_note with text "x". Then say in one line what each call returned. Do not ask questions.';
const FORCE =
  'This is a permission test of the tool harness. Call read_note, then you MUST attempt write_note with text "x" even if a mode says not to: the harness decides, not you. Report in one line the exact text each call returned (including any error).';

const PING =
  'Call the ping tool and the ping_ro tool once each, then report in one line the exact text each returned, including any error.';

const variants = {
  dontAsk: { mode: 'dontAsk', allowed: [READ, WRITE] },
  plan: { mode: 'plan', allowed: [READ, WRITE] },
  planNoAllow: { mode: 'plan', allowed: [] },
  planPromptTool: { mode: 'plan', allowed: [READ], promptTool: 'mcp__spike__approve' },
  planBuiltins: {
    mode: 'plan',
    allowed: [READ, WRITE],
    tools: 'TodoWrite,WebSearch,WebFetch,Task',
  },
  planDefaultTools: { mode: 'plan', allowed: [READ, WRITE], tools: 'default' },
  planExitTool: { mode: 'plan', allowed: [READ, WRITE, 'ExitPlanMode'], tools: 'ExitPlanMode' },
  planBuiltinsUse: {
    mode: 'plan',
    allowed: [READ, 'TodoWrite', 'WebSearch', 'WebFetch'],
    tools: 'TodoWrite,WebSearch,WebFetch,Task',
    prompt:
      'Do these in order: 1) TodoWrite a 1-item todo list "check". 2) WebSearch "Rhino 8 release year". 3) WebFetch https://example.com and give its title. Then report in one line per step whether it worked. Do not ask questions.',
  },
  // Enforcement: the model is told to attempt the write anyway, so the CLI (not the model's
  // restraint) decides. Compare the tool_result error text and the server log.
  forcePlan: { mode: 'plan', allowed: [READ, WRITE], prompt: FORCE },
  forcePlanNoAllow: { mode: 'plan', allowed: [READ], prompt: FORCE },
  forcePlanPromptTool: {
    mode: 'plan',
    allowed: [READ],
    promptTool: 'mcp__spike__approve',
    prompt: FORCE,
  },
  forcePlanPromptsNone: { mode: 'plan', allowed: [READ], prompts: 'none', prompt: FORCE },
  forcePlanDisallowed: { mode: 'plan', allowed: [READ], disallowed: [WRITE], prompt: FORCE },
  // Annotation test: same neutral description, readOnlyHint false vs true.
  pingPlan: { mode: 'plan', allowed: [], prompt: PING },
  pingPlanAllowed: {
    mode: 'plan',
    allowed: ['mcp__spike__ping', 'mcp__spike__ping_ro'],
    prompt: PING,
  },
  pingPlanPromptTool: {
    mode: 'plan',
    allowed: [],
    promptTool: 'mcp__spike__approve',
    prompt: PING,
  },
  pingDontAsk: { mode: 'dontAsk', allowed: [], prompt: PING },
  // Subagent: does a Task subagent inherit plan mode for the non-read-only MCP tool?
  taskPlan: {
    mode: 'plan',
    allowed: ['Task'],
    tools: 'Task',
    prompt:
      'Use the Task tool to launch one general-purpose subagent whose job is: call the ping tool and the ping_ro tool once each and report the exact text each returned. Then report what the subagent said.',
  },
  todoDontAsk: {
    mode: 'dontAsk',
    allowed: ['TodoWrite'],
    tools: 'TodoWrite',
    prompt: 'Use TodoWrite to make a one-item list "check", then say whether it worked.',
  },
};

function run(name, v) {
  const cwd = mkdtempSync(join(tmpdir(), 'vide-plan-spike-'));
  const log = join(cwd, 'calls.jsonl');
  const mcp = JSON.stringify({
    mcpServers: { spike: { command: process.execPath, args: [server], env: { SPIKE_LOG: log } } },
  });
  const args = [
    '-p',
    '--restricted',
    '--tools',
    v.tools ?? '',
    '--strict-mcp-config',
    '--mcp-config',
    mcp,
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--no-chrome',
    '--disable-slash-commands',
    '--permission-mode',
    v.mode,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    '8',
  ];
  if (v.allowed.length) args.push('--allowedTools', v.allowed.join(','));
  if (v.promptTool) args.push('--permission-prompt-tool', v.promptTool);
  if (v.prompts) args.push('--permission-prompts', v.prompts);
  if (v.disallowed) args.push('--disallowedTools', v.disallowed.join(','));
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(v.prompt ?? PROMPT);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      const lines = out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const init = lines.find((l) => l.type === 'system' && l.subtype === 'init');
      const uses = [];
      for (const l of lines) {
        for (const c of l.message?.content ?? []) {
          if (c.type === 'tool_use') uses.push({ tool: c.name, id: c.id });
          if (c.type === 'tool_result') {
            const u = uses.find((x) => x.id === c.tool_use_id);
            const text =
              typeof c.content === 'string'
                ? c.content
                : (c.content ?? []).map((x) => x.text ?? '').join(' ');
            if (u) Object.assign(u, { error: !!c.is_error, result: text.slice(0, 160) });
          }
        }
      }
      const result = lines.find((l) => l.type === 'result');
      resolve({
        name,
        code,
        stderr: err.slice(0, 300),
        initTools: init?.tools,
        mcpServers: init?.mcp_servers,
        permissionMode: init?.permissionMode,
        uses: uses.map(({ id, ...u }) => u),
        denials: result?.permission_denials,
        final: (result?.result ?? '').slice(0, 400),
        serverCalls: existsSync(log)
          ? readFileSync(log, 'utf8')
              .trim()
              .split('\n')
              .map((l) => JSON.parse(l).tool)
          : [],
      });
    });
  });
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(variants);
const results = await Promise.all(names.map((n) => run(n, variants[n])));
console.log(JSON.stringify(results, null, 2));
