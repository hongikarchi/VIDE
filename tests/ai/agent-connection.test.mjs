import test from 'node:test';
import assert from 'node:assert/strict';
import { agentConnection, configureAgentArguments, allowedAgentEvent } from '../../src/ai/agent-connection.ts';
import { codexArguments } from '../../src/ai/codex-cli.ts';
import { cliArguments } from '../../src/ai/claude-cli.ts';
const scope = { url: 'http://127.0.0.1:1234/mcp', token: 'a'.repeat(64), tools: ['query'] };

test('agent configuration only connects to a local controller and token is never a command line argument', () => {
  const connection = agentConnection(scope);
  for(const [format,args] of [['codex',codexArguments()],['claude',cliArguments()]]){
    const result=configureAgentArguments(args,format,connection);
    assert.ok(!result.join(' ').includes(scope.token));
    assert.ok(result.join(' ').includes('VIDE_AGENT_TOKEN'));
    assert.ok(!result.some(arg=>arg.includes('dangerously')));
  }
  for(const url of ['https://foreign.example/mcp','http://localhost:12/mcp','http://127.0.0.1:12/api/v1/projects','http://x:y@127.0.0.1:12/mcp']){
    assert.throws(()=>agentConnection({...scope,url}),{code:'INVALID_AGENT_CONNECTION'});
  }
  assert.throws(()=>agentConnection({...scope,tools:['shell']}),{code:'INVALID_AGENT_CONNECTION'});
});

test('only the granted VIDE MCP tool events are accepted; legacy path still rejects all tools', () => {
  const connection=agentConnection(scope),codex={item:{type:'mcp_tool_call',server:'vide',tool:'query'}};
  assert.equal(allowedAgentEvent(codex,'codex',connection),true);
  assert.equal(allowedAgentEvent(codex,'codex'),false);
  assert.equal(allowedAgentEvent({item:{...codex.item,server:'foreign'}},'codex',connection),false);
  assert.equal(allowedAgentEvent({item:{type:'command_execution'}},'codex',connection),false);
  assert.equal(allowedAgentEvent({name:'mcp__vide__query'},'claude',connection),true);
  assert.equal(allowedAgentEvent({name:'mcp__vide__execute'},'claude',connection),false);
  assert.equal(allowedAgentEvent({name:'Bash'},'claude',connection),false);
});
