// Answer prose and its quality control (SPEC-13.13, PLAN-46 T-236) against the fake cLAWde server
// with a fake CLI runner (no real model is called): the recipe's model is run once with the
// recipe's prompt only; the local checks (shape, refs, numbers, verdict lock, length) and
// `/v1/verify` decide; a failed prose is stored for the audit but never shown and never rewritten
// by itself; no qualifying model means no run; a stale recipe is replaced by the current one;
// model certification runs the golden set and a failed model stops writing.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { SecretStore } from '../../src/services/secrets.ts';
import { ServiceSettings } from '../../src/services/settings.ts';
import { ClawdeClient } from '../../src/services/clawde.ts';
import { LegalService } from '../../src/services/legal.ts';
import {
  LegalWriter,
  ModelCerts,
  checkProse,
  fillPrompt,
  proseNumbers,
} from '../../src/services/legal-writer.ts';
import { startServer } from '../../src/server/server.ts';
import { CASES, RECIPES, buildAnswer, startFakeClawde } from '../fixtures/fake-clawde/server.mjs';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';

let fake;
before(async () => {
  fake = await startFakeClawde();
});
after(() => fake.close());
beforeEach(() => fake.reset());

const verifies = () => fake.received.filter((r) => r.path === '/v1/verify');
const COVERAGE = '건폐율은 얼마까지인가요?';
const ZONE_REF = 'law:국토계획법 시행령/제84조/①/4';
const OPUS = { provider: 'claude', model: 'claude-opus-5', effort: 'high' };
const SONNET = { provider: 'claude', model: 'claude-sonnet-5', effort: 'high' };
const coverageCase = CASES.find((c) => c.name === 'recipe-coverage');
const recipe = (version) => RECIPES.find((r) => r.version === version);

/** A prose that keeps to the coverage answer's evidence and numbers. */
const goodProse = () => ({
  verdict: 'applies',
  conclusion: '건폐율 60% 이하가 적용됩니다.',
  reasons: [{ text: '제2종일반주거지역의 건폐율은 60퍼센트 이하입니다.', refs: [ZONE_REF] }],
  interpretation: [{ text: '이 대지의 건축면적은 252㎡까지입니다.', refs: [ZONE_REF] }],
});

/** The fake CLI: records each call and replies with `reply(call)` (text or an object as JSON). */
function fakeRunner(reply = () => goodProse()) {
  const calls = [];
  return {
    calls,
    reply,
    async run(call) {
      calls.push(call);
      const value = await this.reply(call);
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
  };
}

async function setup({ signedIn = ['claude', 'codex'], codexModels = [], runner, directory } = {}) {
  const store = new Store(':memory:');
  const project = store.createProject('합성 문장 프로젝트');
  const settings = new ServiceSettings({
    directory: undefined,
    secrets: new SecretStore(undefined),
  });
  await settings.update({ clawde: { baseUrl: fake.url, token: fake.token } });
  const client = new ClawdeClient({ settings, version: 'test' });
  await client.meta();
  const fakeCli = runner ?? fakeRunner();
  const writer = new LegalWriter({
    client,
    runner: fakeCli,
    availability: async () => ({ signedIn, codexModels }),
    certs: new ModelCerts(directory),
  });
  const legal = new LegalService({ store, client, settings, writer });
  const ask = (question) =>
    legal.ask(project.id, question, { stage: 'scale-review', profile: {} }).then((r) => r.answer);
  return { store, project, client, writer, legal, runner: fakeCli, ask };
}

const auditRow = (store, projectId, number) =>
  store
    .db(projectId)
    .prepare(
      'SELECT prose_json, recipe_id, recipe_version, writer_provider, writer_model, writer_effort, verify_json FROM legal_answers WHERE projectId=? AND number=?',
    )
    .get(projectId, number);

test('a passing prose: the recipe model runs once with the filled recipe prompt only, passes both checks and is stored and shown', async () => {
  const { store, project, ask, runner } = await setup();
  const answer = await ask(COVERAGE);

  assert.equal(runner.calls.length, 1);
  const [call] = runner.calls;
  assert.deepEqual(call.writer, OPUS, "the recipe's first model, not the conversation's");
  assert.equal(
    call.prompt,
    fillPrompt(recipe('1.1.0'), answer.answer, COVERAGE),
    'the recipe template with its five slots, nothing appended',
  );
  assert.ok(call.prompt.startsWith('[시험 레시피]'));
  assert.ok(call.prompt.includes(`[${ZONE_REF}] (시행 2026-01-01)`));
  assert.ok(call.prompt.includes('coverage.maxArea = 252 ㎡'));
  assert.ok(!/\{\{|VIDE|turn-rules/.test(call.prompt));

  assert.equal(answer.proseStatus, 'verified');
  assert.equal(answer.prose.verify, 'server');
  assert.equal(answer.prose.conclusion, '건폐율 60% 이하가 적용됩니다.');
  assert.deepEqual(answer.prose.recipe, { id: 'answer-prose', version: '1.1.0' });
  assert.deepEqual(answer.prose.writer, OPUS);
  assert.equal(answer.answer.conclusion, '[시험 문구] 건폐율 60% 이하가 적용됩니다.', 'kept');

  const [verify] = verifies();
  assert.equal(verify.body.answerId, 'fake-recipe-coverage');
  assert.deepEqual(verify.body.writer, OPUS);
  assert.deepEqual(verify.body.recipe, { id: 'answer-prose', version: '1.1.0' });

  const row = auditRow(store, project.id, answer.number);
  assert.equal(row.recipe_id, 'answer-prose');
  assert.equal(row.recipe_version, '1.1.0');
  assert.deepEqual(
    [row.writer_provider, row.writer_model, row.writer_effort],
    ['claude', 'claude-opus-5', 'high'],
  );
  assert.equal(JSON.parse(row.verify_json).status, 'verified');
  assert.deepEqual(JSON.parse(row.prose_json), goodProse());

  // A cached answer is shown with its stored prose: nothing is written again.
  const again = await ask(COVERAGE);
  assert.equal(again.prose.conclusion, answer.prose.conclusion);
  assert.equal(runner.calls.length, 1);
});

test('local check failures are stored for the audit, hidden from the card, not sent to /v1/verify and not retried', async (t) => {
  const cases = [
    [
      'REF_OUTSIDE',
      () => ({
        ...goodProse(),
        reasons: [{ text: '일조 사선을 봅니다.', refs: ['law:건축법/제61조/①'] }],
      }),
    ],
    [
      'NUMBER_UNSUPPORTED',
      () => ({
        ...goodProse(),
        interpretation: [{ text: '건축면적은 300㎡까지입니다.', refs: [ZONE_REF] }],
      }),
    ],
    [
      'NUMBER_UNSUPPORTED',
      () => ({
        ...goodProse(),
        conclusion: '건폐율 60㎡ 이하가 적용됩니다.',
      }),
    ],
    ['VERDICT_CHANGED', () => ({ ...goodProse(), verdict: 'not-applies' })],
    ['SCHEMA', () => ({ verdict: 'applies', conclusion: '적용됩니다.', reasons: [] })],
    ['SCHEMA', () => '죄송합니다. 문장을 쓸 수 없습니다.'],
    [
      'SCHEMA',
      () => ({ ...goodProse(), interpretation: [{ text: '가'.repeat(1600), refs: [ZONE_REF] }] }),
    ],
  ];
  for (const [code, reply] of cases)
    await t.test(code, async () => {
      fake.reset();
      const { store, project, ask, runner } = await setup({ runner: fakeRunner(reply) });
      const answer = await ask(COVERAGE);
      assert.equal(runner.calls.length, 1, 'one run, no automatic retry');
      assert.equal(answer.proseStatus, 'failed');
      assert.equal(answer.prose, null, 'the failed prose is not shown');
      assert.ok(
        answer.proseFailures.some((f) => f.code === code),
        JSON.stringify(answer.proseFailures),
      );
      assert.equal(answer.verdict, 'applies', 'the deterministic fields stay');
      assert.equal(verifies().length, 0, 'a local failure is not sent to the service');
      const row = auditRow(store, project.id, answer.number);
      assert.equal(JSON.parse(row.verify_json).status, 'failed');
      assert.equal(row.writer_model, 'claude-opus-5', 'the writer is recorded');
    });
});

test('a conditional answer is never upgraded: applies is VERDICT_CHANGED', async () => {
  const { writer, runner } = await setup();
  const answer = buildAnswer(coverageCase);
  answer.verdict = 'conditional';
  runner.reply = () => goodProse();
  const record = await writer.write(answer, COVERAGE);
  assert.equal(record.status, 'failed');
  assert.deepEqual(
    record.failures.map((f) => f.code),
    ['VERDICT_CHANGED'],
  );
  runner.reply = () => ({ ...goodProse(), verdict: 'conditional' });
  const kept = checkProse(runner.reply(), answer, recipe('1.1.0'));
  assert.deepEqual(kept, [], 'the same verdict passes locally');
  answer.verdict = 'unknown';
  assert.equal(checkProse(goodProse(), answer, recipe('1.1.0'))[0].code, 'VERDICT_CHANGED');
});

test('numbers: article and paragraph names are not values; units must agree', () => {
  assert.deepEqual(
    proseNumbers(
      '제2종일반주거지역은 건축법 제61조 3항과 별표1에 따라 60퍼센트, 1,200㎡, 2.5m',
    ).map((n) => [n.value, n.unit]),
    [
      [60, '%'],
      [1200, '㎡'],
      [2.5, 'm'],
    ],
  );
});

test('/v1/verify failure: the prose is stored as failed and hidden; MODEL_NOT_QUALIFIED from the service', async () => {
  const { store, project, client, ask, writer } = await setup();
  const verify = client.verify.bind(client);
  client.verify = async () => ({
    pass: false,
    recipeCurrent: true,
    failures: [{ code: 'NUMBER_UNSUPPORTED', path: 'conclusion', message: 'server says no' }],
  });
  const answer = await ask(COVERAGE);
  assert.equal(answer.proseStatus, 'failed');
  assert.equal(answer.prose, null);
  assert.deepEqual(
    answer.proseFailures.map((f) => f.message),
    ['server says no'],
  );
  const audit = JSON.parse(auditRow(store, project.id, answer.number).verify_json);
  assert.deepEqual(audit.server, { pass: false, recipeCurrent: true });

  // The real fake server: a writer outside the recipe's models.
  client.verify = verify;
  const record = await writer.write(buildAnswer(coverageCase), COVERAGE, {
    writer: { provider: 'claude', model: 'claude-haiku-4-5', effort: 'low' },
  });
  assert.equal(record.status, 'failed');
  assert.deepEqual(
    record.failures.map((f) => f.code),
    ['MODEL_NOT_QUALIFIED'],
  );
});

test('an unreachable service after the local pass shows the prose as local-only', async () => {
  const { project, legal, ask, runner } = await setup();
  const first = await ask(COVERAGE);
  assert.equal(first.proseStatus, 'verified');
  fake.control({ failStatus: 503 });
  // [다시 쓰기]: the recipe is cached, the CLI runs, /v1/verify cannot be reached.
  const rewritten = await legal.rewrite(project.id, first.number);
  assert.equal(runner.calls.length, 2);
  assert.equal(rewritten.proseStatus, 'local-only');
  assert.equal(rewritten.prose.verify, 'local-only');
  assert.equal(rewritten.prose.conclusion, goodProse().conclusion);
});

test('no qualifying model on this PC: no CLI run and the answer shows 자격 모델 없음', async () => {
  for (const [signedIn, codexModels] of [
    [[], []],
    [['codex'], ['gpt-5.4']],
  ]) {
    fake.reset();
    const { ask, runner } = await setup({ signedIn, codexModels });
    const answer = await ask(COVERAGE);
    assert.equal(runner.calls.length, 0);
    assert.equal(answer.proseStatus, 'no-model');
    assert.equal(answer.prose, null);
    assert.equal(verifies().length, 0);
  }
  // Codex alone with the model in its catalog writes.
  fake.reset();
  const codex = await setup({ signedIn: ['codex'], codexModels: ['gpt-5.5'] });
  const answer = await codex.ask(COVERAGE);
  assert.deepEqual(codex.runner.calls[0].writer, {
    provider: 'codex',
    model: 'gpt-5.5',
    effort: 'high',
  });
  assert.equal(answer.proseStatus, 'verified');
});

test('an answer without a recipe gets no prose and no CLI run', async () => {
  const { ask, runner } = await setup();
  const answer = await ask('일조 사선 제한을 받나요?');
  assert.equal(answer.proseStatus, 'none');
  assert.equal(answer.prose, null);
  assert.equal(runner.calls.length, 0);
  assert.equal(verifies().length, 0);
});

test('a stale recipe (1.0.0) is replaced by the current one and written again once', async () => {
  const { writer, runner, client } = await setup();
  const answer = buildAnswer(coverageCase);
  answer.recipe.version = '1.0.0';
  const record = await writer.write(answer, COVERAGE);
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(
    verifies().map((v) => v.body.recipe.version),
    ['1.0.0', '1.1.0'],
  );
  assert.equal(record.status, 'verified');
  assert.deepEqual(record.recipe, { id: 'answer-prose', version: '1.1.0' });

  // The current version cannot be fetched: the stale prose is a failure.
  fake.reset();
  client.meta = async () => {
    throw Object.assign(new Error('SERVICE_UNAVAILABLE'), { code: 'SERVICE_UNAVAILABLE' });
  };
  const stale = await writer.write(answer, COVERAGE);
  assert.equal(stale.status, 'failed');
  assert.ok(stale.failures.some((f) => f.code === 'RECIPE_STALE'));
  assert.equal(runner.calls.length, 3, 'no second run without the new version');
});

test('model certification runs the golden set; a failed model is skipped until it passes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-legal-cert-'));
  try {
    const { writer, ask, legal, runner } = await setup({ directory });
    const result = await legal.certify(OPUS);
    // Only the coverage question carries a recipe in the fake server: 1 of 3.
    assert.equal(result.total, 3);
    assert.equal(result.passed, 1);
    assert.deepEqual(
      result.items.map((i) => [i.goldenId, i.pass]),
      [
        ['g-coverage', true],
        ['g-sunlight', false],
        ['g-parking', false],
      ],
    );
    const saved = JSON.parse(await readFile(join(directory, 'legal-model-cert.json'), 'utf8'));
    assert.equal(saved['claude/claude-opus-5/high'].passed, 1);
    assert.equal(saved['claude/claude-opus-5/high'].goldenVersion, '2026-10-01');

    const view = await legal.certView();
    assert.deepEqual(
      view.models.map((m) => [m.model, m.cert?.passed ?? null]),
      [
        ['claude-opus-5', 1],
        ['claude-sonnet-5', null],
        ['gpt-5.5', null],
      ],
    );

    runner.calls.length = 0;
    const answer = await ask(COVERAGE);
    assert.deepEqual(runner.calls[0].writer, SONNET, 'the failed model is not used');
    assert.deepEqual(answer.prose.writer, SONNET);

    // Passing again puts it back.
    await writer.certs.record(OPUS, { ...saved['claude/claude-opus-5/high'], passed: 3 });
    assert.deepEqual(await writer.chooseWriter([OPUS, SONNET]), OPUS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP: [다시 쓰기] writes again on request only; [모델 인증] lists the writers and checks its input', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-legal-writer-http-'));
  let fail = true;
  const runner = fakeRunner(() =>
    fail ? { ...goodProse(), verdict: 'not-applies' } : goodProse(),
  );
  const app = await startServer({
    filename: join(directory, 'data', 'store.sqlite'),
    serviceOptions: {
      protector: testProtector,
      proseRunner: runner,
      writers: async () => ({ signedIn: ['claude'], codexModels: [] }),
    },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
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
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, json: await response.json() };
  };
  await api('/settings/services', 'PUT', { clawde: { baseUrl: fake.url, token: fake.token } });
  const project = (await api('/projects', 'POST', { name: '문장 HTTP' })).json;
  const base = `/projects/${project.id}/legal`;
  const card = await api(`${base}/ask`, 'POST', { question: COVERAGE });
  const asked = await api(`${base}/ask`, 'POST', {
    question: COVERAGE,
    confirmSendHash: card.json.needsConfirm.hash,
  });
  assert.equal(asked.status, 200);
  assert.equal(asked.json.answer.proseStatus, 'failed');
  assert.equal(asked.json.answer.prose, null);
  assert.equal(runner.calls.length, 1);

  // Reading the answers runs nothing.
  const list = await api(`${base}/answers`);
  assert.equal(list.json.answers[0].proseStatus, 'failed');
  assert.equal(runner.calls.length, 1);

  fail = false;
  const rewritten = await api(`${base}/answers/${asked.json.number}/rewrite`, 'POST');
  assert.equal(rewritten.status, 200);
  assert.equal(rewritten.json.answer.proseStatus, 'verified');
  assert.equal(rewritten.json.answer.prose.conclusion, goodProse().conclusion);
  assert.equal(runner.calls.length, 2);

  const missing = await api(`${base}/answers/99/rewrite`, 'POST');
  assert.equal(missing.status, 404);

  const view = await api('/legal/model-cert');
  assert.equal(view.status, 200);
  assert.equal(view.json.models.length, 3);
  assert.equal(view.json.running, false);
  const bad = await api('/legal/model-cert', 'POST', { provider: 'gemini' });
  assert.equal(bad.status, 400);
});
