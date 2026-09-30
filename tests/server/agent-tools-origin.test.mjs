import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';

// SPEC-02.19 / PLAN-24 T-062: a conversation turn gets tools only when AgentTools knows the engine
// origin. The server must hand it over, or every conversation in the installed app runs without tools.
test('the engine passes its own origin to AgentTools so conversation turns get the MCP endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-agent-origin-'));
  const app = await startServer({
    filename: join(directory, 'workspace.sqlite'),
    host: { status: async () => ({ available: true }) },
  });
  try {
    const issued = app.agentTools.issueConversation({
      projectId: 'project-1',
      conversationId: 'conversation-1',
      openInstanceId: null,
      workspace: { list: () => [], get: () => undefined },
    });
    assert.ok(issued, 'conversation tools are issued');
    assert.equal(issued.connection.url, new URL('/mcp', app.origin).href);
    assert.match(issued.connection.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.ok(issued.connection.token);
    assert.ok(issued.connection.tools.length > 0);
    issued.revoke();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
