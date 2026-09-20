import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Synthetic input only. Never print auth identities, credentials or raw CLI logs.
const executable = process.env.VIDE_CLAUDE_PATH || 'C:\\Users\\user\\.local\\bin\\claude.exe';
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR)/i.test(key)) delete env[key];
}
const auth = spawnSync(executable, ['auth', 'status', '--json'], {
  env, encoding: 'utf8', timeout: 15000, windowsHide: true,
});
let authState;
try { authState = JSON.parse(auth.stdout); } catch { authState = {}; }
console.log(JSON.stringify({ phase: 'auth', exitCode: auth.status,
  loggedIn: authState.loggedIn ?? null, authMethod: authState.authMethod ?? null,
  subscriptionType: authState.subscriptionType ?? null }));
if (process.argv.includes('--auth-only') || !authState.loggedIn) process.exit(authState.loggedIn ? 0 : 2);
if (authState.authMethod !== 'claude.ai') {
  console.log(JSON.stringify({ phase: 'request', state: 'skipped', reason: 'subscription-auth-not-confirmed' }));
  process.exit(2);
}
const cwd = mkdtempSync(join(tmpdir(), 'vide-cli-probe-'));
const args = ['-p', '--safe-mode', '--tools', '', '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
  '--no-session-persistence', '--no-chrome', '--disable-slash-commands',
  '--permission-mode', 'dontAsk', '--output-format', 'stream-json', '--verbose',
  '--system-prompt', 'You are a synthetic connectivity test. Reply with VIDE_OK only. Do not use any tools.'];
const start = Date.now();
const child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false });
console.log(JSON.stringify({ phase: 'spawn', pid: child.pid }));
let buffer = '', bytes = 0, result = null, toolCalls = 0, expired = false;
child.stdin.end('Reply VIDE_OK. No project data is included.');
child.stderr.on('data', () => {});
child.on('error', error => console.log(JSON.stringify({ phase: 'spawn', code: error.code })));
child.stdout.on('data', chunk => {
  bytes += chunk.length;
  if (bytes > 1024 * 1024) { child.kill(); return; }
  buffer += chunk.toString('utf8');
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'system' && event.subtype === 'init') {
      console.log(JSON.stringify({ phase: 'init', tools: event.tools,
        mcpServerCount: event.mcp_servers?.length ?? null, model: event.model }));
    }
    if (event.type === 'assistant') toolCalls += (event.message?.content ?? []).filter(x => x.type === 'tool_use').length;
    if (event.type === 'result') result = event;
  }
});
const timer = setTimeout(() => {
  expired = true;
  const stopped = process.platform === 'win32'
    ? spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 5000 })
    : { status: child.kill() ? 0 : 1 };
  console.log(JSON.stringify({ phase: 'timeout', stopExitCode: stopped.status }));
  child.stdout.destroy(); child.stderr.destroy();
  if (stopped.status !== 0) process.exitCode = 3;
}, 45000);
child.on('close', code => {
  clearTimeout(timer);
  console.log(JSON.stringify({ phase: 'complete', code, elapsedMs: Date.now() - start,
    expired, toolCalls, subtype: result?.subtype ?? null, isError: result?.is_error ?? null,
    exactReply: result?.result?.trim() === 'VIDE_OK', inputTokens: result?.usage?.input_tokens ?? null,
    outputTokens: result?.usage?.output_tokens ?? null }));
  // This path is created exclusively by mkdtemp above, outside all project/user data.
  rmSync(cwd, { recursive: true, force: true });
  process.exitCode = code === 0 && !expired && toolCalls === 0 && result?.result?.trim() === 'VIDE_OK' ? 0 : 1;
});
