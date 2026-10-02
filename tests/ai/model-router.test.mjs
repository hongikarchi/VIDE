import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOMAINS, ModelRouter, choose, readJevKey } from '../../src/ai/model-router.ts';
import { subscriptionEnvironment } from '../../src/ai/claude-cli.ts';
import { codexEnvironment } from '../../src/ai/codex-cli.ts';

const all = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const catalog = [
  { id: 'claude-opus-5-5', provider: 'claude-cli', efforts: all },
  { id: 'claude-sonnet-5', provider: 'claude-cli', efforts: all },
  { id: 'gpt-6-luna', provider: 'codex-cli', efforts: ['default', 'low', 'medium', 'high'] },
  { id: 'gpt-6-astra', provider: 'codex-cli', efforts: all },
  { id: 'auto', provider: 'claude-cli', efforts: ['default'] },
];
const both = ['claude-cli', 'codex-cli'];
const pick = (task, available, list = catalog, domain) => {
  const choice = choose(task, list, available, domain);
  return choice && `${choice.provider}:${choice.model ?? '(CLI 기본)'}:${choice.effort}`;
};
const reply = (choice, confidence, domain) => async (_url, init) => {
  reply.last = JSON.parse(init.body);
  return new Response(
    JSON.stringify({ answers: { task: { choice, confidence }, ...(domain ? { domain } : {}) } }),
  );
};

test('every sign-in combination has a choice; geometry changes on ChatGPT, lookups on Claude', () => {
  // Both signed in: lookups go to Claude (Sonnet 5) even about geometry (user, 2026-10-02);
  // creating or changing geometry goes to ChatGPT (GPT-6-Astra).
  assert.equal(pick('lookup', both), 'claude-cli:claude-sonnet-5:low');
  assert.equal(pick('lookup', both, catalog, 'geometry'), 'claude-cli:claude-sonnet-5:low');
  assert.equal(pick('simple_edit', both), 'codex-cli:gpt-6-astra:low');
  assert.equal(pick('complex', both), 'codex-cli:gpt-6-astra:medium');
  assert.equal(pick('analysis', both), 'codex-cli:gpt-6-astra:high');
  // Only Claude: Sonnet for questions, Opus for the rest.
  assert.equal(pick('lookup', ['claude-cli']), 'claude-cli:claude-sonnet-5:low');
  assert.equal(pick('simple_edit', ['claude-cli']), 'claude-cli:claude-opus-5-5:low');
  assert.equal(pick('complex', ['claude-cli']), 'claude-cli:claude-opus-5-5:medium');
  assert.equal(pick('analysis', ['claude-cli']), 'claude-cli:claude-opus-5-5:high');
  // Only ChatGPT.
  assert.equal(pick('lookup', ['codex-cli']), 'codex-cli:gpt-6-luna:low');
  assert.equal(pick('analysis', ['codex-cli']), 'codex-cli:gpt-6-astra:high');
  // Data, information, organising and jig work prefer Claude when both are signed in; ChatGPT otherwise.
  assert.equal(pick('simple_edit', both, catalog, 'data'), 'claude-cli:claude-opus-5-5:low');
  assert.equal(pick('lookup', both, catalog, 'data'), 'claude-cli:claude-sonnet-5:low');
  assert.equal(pick('complex', both, catalog, 'data'), 'claude-cli:claude-opus-5-5:medium');
  assert.equal(pick('analysis', both, catalog, 'data'), 'claude-cli:claude-opus-5-5:high');
  assert.equal(pick('lookup', ['codex-cli'], catalog, 'data'), 'codex-cli:gpt-6-luna:low');
  assert.equal(pick('analysis', ['codex-cli'], catalog, 'data'), 'codex-cli:gpt-6-astra:high');
  // 3D analysis stays on GPT-6-Astra when both are signed in.
  assert.equal(pick('analysis', both, catalog, 'geometry'), 'codex-cli:gpt-6-astra:high');
  // Nothing signed in: no choice (the request keeps its own service and reports it).
  assert.equal(pick('complex', []), undefined);
  // ChatGPT without Luna listed: the next candidate in the list for that task.
  const noLuna = catalog.filter((model) => model.id !== 'gpt-6-luna');
  assert.equal(pick('lookup', ['codex-cli'], noLuna), 'codex-cli:gpt-6-astra:low');
  // ChatGPT without a model catalog (only its CLI placeholder): the CLI's own model.
  const placeholder = [{ id: 'codex-cli', provider: 'codex-cli', efforts: ['default'] }];
  assert.equal(pick('complex', ['codex-cli'], placeholder), 'codex-cli:(CLI 기본):default');
  // An effort the model lacks falls to the nearest lower one.
  const limited = [
    { id: 'gpt-6-astra', provider: 'codex-cli', efforts: ['default', 'low', 'high'] },
  ];
  assert.equal(pick('complex', ['codex-cli'], limited), 'codex-cli:gpt-6-astra:low');
});

test('Jev decides when confident; no key, low confidence or errors fall back to the complex row', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'vide-router-'));
  try {
    const input = { body: '선택한 기둥 개수 알려줘', permission: 'review', pins: [{}] };
    const jev = new ModelRouter({
      dataDirectory,
      key: () => 'k',
      fetchImpl: reply('lookup', 0.92),
    });
    const decision = await jev.route(input, catalog, Promise.resolve(['claude-cli']));
    assert.deepEqual(
      [decision.by, decision.provider, decision.model, decision.effort, decision.available],
      ['jev', 'claude-cli', 'claude-sonnet-5', 'low', ['claude-cli']],
    );
    assert.match(reply.last.state, /선택한 기둥 개수/);
    assert.match(reply.last.state, /review only/);
    assert.equal(reply.last.model, 'jev-1.13.0');

    const route = (options, available = both) =>
      new ModelRouter({ dataDirectory, key: () => 'k', ...options }).route(
        input,
        catalog,
        available,
      );
    const unsure = await route({ fetchImpl: reply('lookup', 0.3) });
    assert.deepEqual(
      [unsure.by, unsure.reason, unsure.provider, unsure.model, unsure.effort],
      ['fallback', 'LOW_CONFIDENCE:lookup', 'codex-cli', 'gpt-6-astra', 'medium'],
    );
    assert.equal((await route({ key: () => '' })).reason, 'NO_KEY');
    assert.equal(
      (await route({ fetchImpl: async () => new Response('x', { status: 529 }) })).reason,
      'HTTP_529',
    );
    const thrown = await route({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(thrown.reason, 'ERROR');
    // Sign-in check failing counts as nothing signed in; the requested service is kept.
    const none = await new ModelRouter({ dataDirectory, key: () => '' }).route(
      input,
      catalog,
      Promise.reject(new Error('x')),
      'codex-cli',
    );
    assert.deepEqual([none.provider, none.model, none.reason], ['codex-cli', undefined, 'NO_KEY']);
    const data = await route({
      fetchImpl: reply('analysis', 0.8, { choice: 'data', confidence: 0.9 }),
    });
    assert.deepEqual(
      [data.domain, data.provider, data.model, data.effort],
      ['data', 'claude-cli', 'claude-opus-5-5', 'high'],
    );
    assert.deepEqual(Object.keys(reply.last.questions), ['task', 'domain']);
    // An unsure domain falls back by task: a lookup counts as data (Claude), the rest as geometry.
    const vague = await route({
      fetchImpl: reply('analysis', 0.8, { choice: 'data', confidence: 0.4 }),
    });
    assert.deepEqual([vague.domain, vague.provider], ['geometry', 'codex-cli']);
    const vagueLookup = await route({
      fetchImpl: reply('lookup', 0.8, { choice: 'geometry', confidence: 0.4 }),
    });
    assert.deepEqual(
      [vagueLookup.domain, vagueLookup.provider, vagueLookup.model],
      ['data', 'claude-cli', 'claude-sonnet-5'],
    );
    // Organising layers (2026-10-02 request) is data: Claude even when it renames or moves layers.
    const organise = await route({
      fetchImpl: reply('simple_edit', 0.8, { choice: 'data', confidence: 0.8 }),
    });
    assert.deepEqual([organise.domain, organise.provider], ['data', 'claude-cli']);
    assert.match(DOMAINS.data, /organising layers/);
    assert.doesNotMatch(DOMAINS.geometry, /layers/);
    const nobody = await route({ fetchImpl: reply('complex', 0.9) }, []);
    assert.deepEqual(
      [nobody.by, nobody.reason, nobody.provider],
      ['jev', 'NO_SERVICE', 'claude-cli'],
    );

    jev.record({ event: 'routed', requestId: 'r1' });
    jev.record({ event: 'finished', requestId: 'r1', state: 'succeeded' });
    const lines = (await readFile(join(dataDirectory, 'logs', 'model-routing.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => l.event),
      ['routed', 'finished'],
    );
    new ModelRouter({ dataDirectory: join(dataDirectory, 'none'), log: false }).record({
      event: 'x',
    });
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('the key comes from the environment or the data folder, and never reaches the CLIs', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'vide-router-key-'));
  try {
    assert.equal(readJevKey(dataDirectory, {}), '');
    await writeFile(join(dataDirectory, 'typesafe.env'), '# local\nTYPESAFE_API_KEY="abc"\n');
    assert.equal(readJevKey(dataDirectory, {}), 'abc');
    assert.equal(readJevKey(dataDirectory, { TYPESAFE_API_KEY: 'env' }), 'env');
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
  const source = { TYPESAFE_API_KEY: 'secret', TYPESAFE_BASE_URL: 'x', PATH: 'p' };
  assert.deepEqual(subscriptionEnvironment(source), { PATH: 'p' });
  assert.deepEqual(codexEnvironment(source), { PATH: 'p' });
});

// SPEC-02.17 2 (PLAN-24 T-049): screen, setting, app and jig routes run without the AI.
test('no model is chosen for routes VIDE carries out itself', async () => {
  const { needsModel } = await import('../../src/ai/model-router.ts');
  assert.deepEqual(['view', 'param', 'app', 'jig'].map(needsModel), [false, false, false, false]);
  assert.deepEqual(['ask', 'document', 'make', null, undefined].map(needsModel), [
    true,
    true,
    true,
    true,
    true,
  ]);
});
