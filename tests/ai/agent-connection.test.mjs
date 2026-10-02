import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentConnection,
  configureAgentArguments,
  allowedAgentEvent,
  builtinRule,
  turnRules,
} from '../../src/ai/agent-connection.ts';
import { codexArguments } from '../../src/ai/codex-cli.ts';
import { cliArguments } from '../../src/ai/claude-cli.ts';
const scope = { url: 'http://127.0.0.1:1234/mcp', token: 'a'.repeat(64), tools: ['query'] };

test('agent configuration only connects to a local controller and token is never a command line argument', () => {
  const connection = agentConnection(scope);
  for (const [format, args] of [
    ['codex', codexArguments()],
    ['claude', cliArguments()],
  ]) {
    const result = configureAgentArguments(args, format, connection);
    assert.ok(!result.join(' ').includes(scope.token));
    assert.ok(result.join(' ').includes('VIDE_AGENT_TOKEN'));
    assert.ok(!result.some((arg) => arg.includes('dangerously')));
  }
  for (const url of [
    'https://foreign.example/mcp',
    'http://localhost:12/mcp',
    'http://127.0.0.1:12/api/v1/projects',
    'http://x:y@127.0.0.1:12/mcp',
  ]) {
    assert.throws(() => agentConnection({ ...scope, url }), { code: 'INVALID_AGENT_CONNECTION' });
  }
  assert.throws(() => agentConnection({ ...scope, tools: ['shell'] }), {
    code: 'INVALID_AGENT_CONNECTION',
  });
});

test('only the granted VIDE MCP tool events are accepted; legacy path still rejects all tools', () => {
  const connection = agentConnection(scope),
    codex = { item: { type: 'mcp_tool_call', server: 'vide', tool: 'query' } };
  assert.equal(allowedAgentEvent(codex, 'codex', connection), true);
  assert.equal(allowedAgentEvent(codex, 'codex'), false);
  assert.equal(
    allowedAgentEvent({ item: { ...codex.item, server: 'foreign' } }, 'codex', connection),
    false,
  );
  assert.equal(
    allowedAgentEvent({ item: { type: 'command_execution' } }, 'codex', connection),
    false,
  );
  assert.equal(allowedAgentEvent({ name: 'mcp__vide__query' }, 'claude', connection), true);
  assert.equal(allowedAgentEvent({ name: 'mcp__vide__execute' }, 'claude', connection), false);
  assert.equal(allowedAgentEvent({ name: 'Bash' }, 'claude', connection), false);
});

test('built-in tools (ADR-028): listed and pre-allowed, named in the rules, accepted only with them', () => {
  const connection = agentConnection(scope);
  const args = configureAgentArguments(cliArguments(), 'claude', connection, {
    builtin: { work: true, web: true },
  });
  const tools = args[args.indexOf('--tools') + 1].split(',');
  const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
  for (const name of ['Task', 'TodoWrite', 'TaskCreate', 'WebSearch', 'WebFetch']) {
    assert.ok(tools.includes(name), name);
    assert.ok(allowed.includes(name), name);
  }
  assert.ok(allowed.includes('mcp__vide__query'));
  assert.ok(!tools.includes('Bash') && !tools.includes('Read'));
  const prompt = args[args.indexOf('--append-system-prompt') + 1];
  assert.match(prompt, /Exception to the tool rules/);
  assert.match(prompt, /WebSearch and WebFetch/);
  // Work only: no web tools, no web in the rules.
  const work = configureAgentArguments(cliArguments(), 'claude', connection, {
    builtin: { work: true },
  });
  assert.ok(!work[work.indexOf('--tools') + 1].includes('Web'));
  assert.match(turnRules(connection, 'claude', { work: true }), /subagent/);
  assert.doesNotMatch(turnRules(connection, 'claude', { work: true }), /WebFetch/);
  assert.equal(builtinRule(undefined), '');
  // Events: the subagent call is named Agent; web tools only when the turn has them.
  const both = { work: true, web: true };
  assert.equal(allowedAgentEvent({ name: 'Agent' }, 'claude', connection, both), true);
  assert.equal(allowedAgentEvent({ name: 'Task' }, 'claude', connection, both), true);
  assert.equal(
    allowedAgentEvent({ name: 'WebFetch' }, 'claude', connection, { work: true }),
    false,
  );
  assert.equal(allowedAgentEvent({ name: 'Agent' }, 'claude', connection), false);
  assert.equal(allowedAgentEvent({ name: 'Agent' }, 'claude', undefined, both), false);
  assert.equal(allowedAgentEvent({ name: 'Bash' }, 'claude', connection, both), false);
  // Codex: web_search turns live and its items pass only with the web tools.
  const codex = configureAgentArguments(codexArguments(), 'codex', connection, { builtin: both });
  assert.ok(codex.includes('web_search="live"') && !codex.includes('web_search="disabled"'));
  assert.ok(
    configureAgentArguments(codexArguments(), 'codex', connection).includes(
      'web_search="disabled"',
    ),
  );
  const search = { item: { type: 'web_search' } };
  assert.equal(allowedAgentEvent(search, 'codex', connection, both), true);
  assert.equal(allowedAgentEvent(search, 'codex', connection), false);
  assert.match(turnRules(connection, 'codex', both), /web_search reads the public web/);
  assert.doesNotMatch(turnRules(connection, 'codex', both), /subagent/);
});
