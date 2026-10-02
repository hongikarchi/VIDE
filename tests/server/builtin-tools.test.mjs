import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../src/server/server.ts';

// ADR-028 / T-105: conversation, host and make turns get the provider's own subagent and to-do
// tools, and its web tools while Settings → AI 「AI 웹 검색」 is on (default); ADR-031 8 / T-122:
// and the work folder's file and shell tools. Synthetic provider.

test('conversation turns get the work tools and the web tools while AI 웹 검색 is on', async () => {
  const runs = [];
  const app = await startServer({
    filename: ':memory:',
    host: { status: async () => ({ available: true }) },
    providerFactory: (options) => ({
      run: async (context) => {
        runs.push({ options, context });
        return {
          text: JSON.stringify({ message: '답변', operations: [] }),
          usage: { inputTokens: 10, outputTokens: 2 },
        };
      },
    }),
  });
  try {
    const login = await fetch(app.origin + '/api/v1/session', {
      method: 'POST',
      headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
    });
    const headers = {
      Origin: app.origin,
      'Content-Type': 'application/json',
      Cookie: login.headers.get('set-cookie').split(';')[0],
    };
    const api = async (path, method = 'GET', data) =>
      fetch(app.origin + '/api/v1' + path, {
        method,
        headers,
        body: data ? JSON.stringify(data) : undefined,
      });
    assert.deepEqual(await (await api('/settings/web')).json(), { web: true });
    const project = await (await api('/projects', 'POST', { name: 'w' })).json();
    const conversation = await (
      await api(`/projects/${project.id}/conversations`, 'POST', {
        title: '질문',
        provider: 'claude-cli',
        kind: 'ask',
      })
    ).json();
    const requests = `/projects/${project.id}/requests`;
    const input = {
      provider: 'claude-cli',
      model: 'auto',
      permission: 'review',
      body: '이 대지의 건폐율은?',
      pins: [],
      sketches: [],
      files: [],
      conversationId: conversation.id,
    };
    const send = async (id) => {
      assert.equal((await api(requests, 'POST', { ...input, id })).status, 202);
      for (let i = 0; i < 100; i++) {
        const row = await (await api(`${requests}/${id}`)).json();
        if (['succeeded', 'failed'].includes(row.state)) return row;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('turn did not finish');
    };
    await send('turn-1');
    // The work folder's own file and shell tools (ADR-031 8): this project has no folder yet, so
    // the CLI works in a temporary folder; a Plan turn (review) writes no file.
    const files = { dirs: [], attachments: [], readOnly: true };
    assert.deepEqual(runs.at(-1).options.builtinTools, { work: true, web: true, files });
    assert.equal(typeof runs.at(-1).options.toolPermission, 'function');
    assert.ok(runs.at(-1).options.session, 'a conversation turn has a session');
    // Off: the next turn keeps the work tools and has no web.
    assert.deepEqual(await (await api('/settings/web', 'PUT', { web: false })).json(), {
      web: false,
    });
    await send('turn-2');
    assert.deepEqual(runs.at(-1).options.builtinTools, { work: true, web: false, files });
    assert.equal((await api('/settings/web', 'PUT', { web: 'yes' })).status, 400);
  } finally {
    await app.close();
  }
});
