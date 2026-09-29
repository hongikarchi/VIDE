import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../src/server/server.ts';

// "자동 (Jev)" is one model entry; the server replaces it with a concrete service, model and effort
// among the signed-in services before the request is stored, and a retry keeps that choice.
test('automatic model choice resolves to a signed-in service at submission and survives a retry', async () => {
  delete process.env.TYPESAFE_API_KEY;
  const seen = [];
  const app = await startServer({
    filename: ':memory:',
    host: { status: async () => ({ available: true }) },
    // Only Claude is signed in here.
    providerFactory: (options) => ({
      status: async () => ({ available: options.provider === 'claude-cli' }),
      run: async () => {
        seen.push({ provider: options.provider, model: options.model, effort: options.effort });
        return { text: JSON.stringify({ message: '검토 결과', operations: [] }) };
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
    const models = await (await api('/models')).json();
    assert.equal(models.filter((m) => m.id === 'auto').length, 1);
    const project = await (await api('/projects', 'POST', { name: 'auto' })).json();
    // The entry carries a service, but the server decides it: ChatGPT is not signed in.
    const input = {
      id: 'auto-one',
      provider: 'codex-cli',
      model: 'auto',
      effort: 'default',
      permission: 'review',
      body: '검토',
      pins: [],
      sketches: [],
      files: [],
    };
    const path = `/projects/${project.id}/requests`;
    assert.equal((await api(path, 'POST', input)).status, 202);
    assert.equal((await api(path, 'POST', input)).status, 200, 'retry is the same request');
    const saved = await (await api(path + '/auto-one')).json();
    // No Jev key in tests: the fallback row (top model, medium effort) of the signed-in service.
    assert.equal(saved.input.provider, 'claude-cli');
    assert.equal(saved.input.model, 'claude-opus-5-5');
    assert.equal(saved.input.effort, 'medium');
    assert.equal(saved.input.routing.by, 'fallback');
    assert.equal(saved.input.routing.reason, 'NO_KEY');
    assert.deepEqual(saved.input.routing.available, ['claude-cli']);
    assert.deepEqual(seen, [
      { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' },
    ]);
  } finally {
    await app.close();
  }
});
