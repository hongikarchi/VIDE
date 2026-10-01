import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuestionSettings } from '../../src/ai/question-settings.ts';
import { CodexAppServer } from '../../src/ai/codex-app-server.ts';
import { CodexCli } from '../../src/ai/codex-cli.ts';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { startServer } from '../../src/server/server.ts';

// Settings → AI 「AI가 작업 도중에 묻기」 (PLAN-24 T-075, 2026-10-01 "codex도 기본으로 켜야"): one
// switch for Claude's own questions and the Codex app-server, on by default; the environment still
// forces each provider off.

test('the switch is on without a file, keeps what the user chose, and reads a broken file as off', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vide-questions-'));
  try {
    const file = join(directory, 'question-settings.json');
    const settings = new QuestionSettings(file);
    assert.deepEqual(settings.get(), { native: true });
    assert.deepEqual(settings.set({ native: false }), { native: false });
    assert.deepEqual(new QuestionSettings(file).get(), { native: false });
    writeFileSync(file, '{broken');
    assert.deepEqual(settings.get(), { native: false });
    assert.deepEqual(new QuestionSettings().get(), { native: true }, 'in memory: on');
    assert.deepEqual(new QuestionSettings().view({}).forcedOff, {
      'claude-cli': false,
      'codex-cli': false,
    });
    assert.deepEqual(
      new QuestionSettings().view({ VIDE_NATIVE_QUESTIONS: '0', VIDE_CODEX_APP_SERVER: '0' })
        .forcedOff,
      { 'claude-cli': true, 'codex-cli': true },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex goes through the app-server by default, through exec when the switch or the env is off', () => {
  const store = new Store(':memory:');
  const previous = process.env.VIDE_CODEX_APP_SERVER;
  try {
    let on = true;
    const execution = new Execution(new Workspace(store), { questions: () => on });
    const codex = () => execution.provider({ provider: 'codex-cli' });
    delete process.env.VIDE_CODEX_APP_SERVER;
    assert.ok(codex() instanceof CodexAppServer, 'default: app-server');
    on = false;
    assert.ok(!(codex() instanceof CodexAppServer), 'switch off: exec');
    assert.ok(codex() instanceof CodexCli);
    on = true;
    process.env.VIDE_CODEX_APP_SERVER = '0';
    assert.ok(!(codex() instanceof CodexAppServer), 'env off: exec');
    // A setting that cannot be read counts as off.
    const broken = new Execution(new Workspace(store), {
      questions: () => {
        throw new Error('unreadable');
      },
    });
    delete process.env.VIDE_CODEX_APP_SERVER;
    assert.ok(!(broken.provider({ provider: 'codex-cli' }) instanceof CodexAppServer));
  } finally {
    if (previous === undefined) delete process.env.VIDE_CODEX_APP_SERVER;
    else process.env.VIDE_CODEX_APP_SERVER = previous;
    store.close();
  }
});

test('/settings/questions reads and sets the switch with what the environment forces off', async () => {
  const app = await startServer({ filename: ':memory:', host: { status: async () => ({}) } });
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
    const api = async (method = 'GET', data) => {
      const response = await fetch(app.origin + '/api/v1/settings/questions', {
        method,
        headers,
        body: data ? JSON.stringify(data) : undefined,
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    };
    const first = await api();
    assert.equal(first.status, 200);
    assert.equal(first.json.native, true);
    assert.deepEqual(Object.keys(first.json.forcedOff).sort(), ['claude-cli', 'codex-cli']);
    assert.equal((await api('PUT', { native: false })).json.native, false);
    assert.equal((await api()).json.native, false);
    assert.ok((await api('PUT', { native: 'no' })).status >= 400);
    assert.equal((await api('PUT', { native: true })).json.native, true);
  } finally {
    await app.close();
  }
});

test('mid-run questions follow one rule for Claude and Codex: conversation turns, switch on, env not off', () => {
  const store = new Store(':memory:');
  const saved = {
    native: process.env.VIDE_NATIVE_QUESTIONS,
    codex: process.env.VIDE_CODEX_APP_SERVER,
  };
  const restore = (key, value) =>
    value === undefined ? delete process.env[key] : (process.env[key] = value);
  try {
    delete process.env.VIDE_NATIVE_QUESTIONS;
    delete process.env.VIDE_CODEX_APP_SERVER;
    let on = true;
    const execution = new Execution(new Workspace(store), { questions: () => on });
    const asks = (provider, conversationTurn) =>
      typeof execution.midRunQuestions(provider, conversationTurn, 'p', 'r') === 'function';
    for (const provider of ['claude-cli', 'codex-cli']) {
      assert.equal(asks(provider, true), true, `${provider}: a conversation turn asks mid-run`);
      assert.equal(asks(provider, false), false, `${provider}: outside a conversation it does not`);
    }
    on = false;
    for (const provider of ['claude-cli', 'codex-cli'])
      assert.equal(asks(provider, true), false, `${provider}: the switch off`);
    on = true;
    process.env.VIDE_NATIVE_QUESTIONS = '0';
    assert.deepEqual([asks('claude-cli', true), asks('codex-cli', true)], [false, true]);
    delete process.env.VIDE_NATIVE_QUESTIONS;
    process.env.VIDE_CODEX_APP_SERVER = '0';
    assert.deepEqual([asks('claude-cli', true), asks('codex-cli', true)], [true, false]);
  } finally {
    restore('VIDE_NATIVE_QUESTIONS', saved.native);
    restore('VIDE_CODEX_APP_SERVER', saved.codex);
    store.close();
  }
});
