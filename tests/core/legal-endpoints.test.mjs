// cLAWde follow-ups on the VIDE side (PLAN-48 T-240, SPEC-13.12, ARCH-01 「cLAWde 연결 계약」):
// `meta.endpoints`·`plannedEndpoints` make the feature table; a feature that is off is never sent
// (SERVICE_NOT_IMPLEMENTED, 409) and the status stays '연결됨'; a 501 turns the feature off until the
// next `meta`; 503 NO_PUBLICATION·PUBLISHING is '서비스 준비 중', not '닿지 않음'; articles are kept
// under the requested ref and the service's stored ref; an older meta keeps every feature on.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { SecretStore } from '../../src/services/secrets.ts';
import {
  ServiceSettings,
  endpointName,
  serviceSettingsStatuses,
} from '../../src/services/settings.ts';
import { ClawdeClient } from '../../src/services/clawde.ts';
import { LegalService } from '../../src/services/legal.ts';
import { legalToolHandlers, legalTurn } from '../../src/server/legal-tools.ts';
import { startFakeClawde, storedRef } from '../fixtures/fake-clawde/server.mjs';

let fake;
before(async () => {
  fake = await startFakeClawde();
});
after(() => fake.close());
beforeEach(() => fake.reset());

const M1 = ['meta', 'articles', 'search'];
const ALL_ON = {
  ask: true,
  checklist: true,
  contribute: true,
  verify: true,
  golden: true,
  recipes: true,
};

async function setup() {
  const store = new Store(':memory:');
  const project = store.createProject('법규 합성');
  const settings = new ServiceSettings({
    directory: undefined,
    secrets: new SecretStore(undefined),
  });
  await settings.update({ clawde: { baseUrl: fake.url, token: fake.token } });
  const client = new ClawdeClient({ settings, version: 'test', timeoutMs: 2000 });
  const legal = new LegalService({ store, client, settings });
  const calls = (path) => fake.received.filter((r) => r.path.startsWith(path)).length;
  return { store, project, settings, client, legal, calls };
}
const code = (code) => (error) => error?.code === code;

test('endpoint names: bare, with method and path, with a path parameter', () => {
  assert.equal(endpointName('ask'), 'ask');
  assert.equal(endpointName('POST /v1/ask'), 'ask');
  assert.equal(endpointName('GET /v1/recipes/{id}'), 'recipes');
  assert.equal(endpointName('/v1/golden?recipe='), 'golden');
  assert.equal(serviceSettingsStatuses.SERVICE_NOT_IMPLEMENTED, 409);
  assert.equal(serviceSettingsStatuses.SERVICE_NOT_READY, 503);
});

test('meta without endpoints (an older service) keeps every feature on', async () => {
  const { project, settings, client, legal } = await setup();
  await client.meta();
  assert.deepEqual(settings.features(), ALL_ON);
  assert.deepEqual((await settings.view()).clawde.features, ALL_ON);
  // The answers list and the profile carry the table for the screen.
  assert.deepEqual((await legal.list(project.id)).features, ALL_ON);
  assert.deepEqual(legal.profileView(project.id).features, ALL_ON);
});

test("an M1 service: ask and checklist are off, nothing is sent, the status stays '연결됨', articles still read", async () => {
  fake.control({ endpoints: M1 });
  const { project, settings, client, legal, calls } = await setup();
  const meta = await client.meta();
  assert.deepEqual(meta.endpoints, M1);
  assert.ok(meta.plannedEndpoints.includes('ask'));
  assert.deepEqual(settings.features(), {
    ask: false,
    checklist: false,
    contribute: false,
    verify: false,
    golden: false,
    recipes: false,
  });
  // The question is refused before the '보낼 정보' card and before any call.
  await assert.rejects(
    legal.askProject(project.id, { question: '일조 사선 제한을 받나요?' }),
    code('SERVICE_NOT_IMPLEMENTED'),
  );
  await assert.rejects(legal.checklist(project.id, {}), code('SERVICE_NOT_IMPLEMENTED'));
  await assert.rejects(
    legal.contributions.send(project.id, { keys: ['site.area'] }),
    code('SERVICE_NOT_IMPLEMENTED'),
  );
  // The client itself refuses too (a direct call never reaches the service).
  await assert.rejects(
    client.ask({ question: 'x', stage: 'scale-review', profile: {}, locale: 'ko' }),
    code('SERVICE_NOT_IMPLEMENTED'),
  );
  assert.equal(calls('/v1/ask'), 0);
  assert.equal(calls('/v1/checklist'), 0);
  assert.equal(calls('/v1/contributions'), 0);
  assert.equal((await settings.view()).clawde.status, 'connected');

  const article = await legal.article(project.id, 'law:건축법/제61조/①');
  assert.equal(article.cached, false);
  assert.equal(article.article.ref, 'law:건축법/제61조/①');
  assert.equal((await settings.view()).clawde.status, 'connected');

  // The conversation tools leave out what the service does not offer.
  const tools = legalToolHandlers(project.id, { service: legal, turn: legalTurn() });
  assert.deepEqual(Object.keys(tools).sort(), ['legal_answers', 'legal_article']);

  // A later meta that lists ask turns it back on.
  fake.control({ endpoints: [...M1, 'ask'] });
  await client.meta();
  assert.equal(settings.features().ask, true);
  assert.equal(settings.features().checklist, false);
  assert.ok('legal_ask' in legalToolHandlers(project.id, { service: legal, turn: legalTurn() }));
});

test('a 501 without endpoints in meta turns that feature off until the next meta', async () => {
  const { project, settings, client, legal, calls } = await setup();
  await client.meta(); // an older meta: all on
  fake.control({ endpoints: M1 }); // …but the service answers ask with 501
  const sent = { stage: 'scale-review', profile: {} };
  await assert.rejects(legal.ask(project.id, '일조?', sent), code('SERVICE_NOT_IMPLEMENTED'));
  assert.equal(calls('/v1/ask'), 1);
  assert.equal((await settings.view()).clawde.status, 'connected', 'not unreachable');
  assert.equal(settings.features().ask, false);
  await assert.rejects(legal.ask(project.id, '일조?', sent), code('SERVICE_NOT_IMPLEMENTED'));
  assert.equal(calls('/v1/ask'), 1, 'not sent again');
  // Articles and search still answer after the 501.
  assert.equal((await legal.article(project.id, 'law:건축법/제58조')).cached, false);
  assert.ok((await client.search('일조')).hits.length >= 1);
  assert.equal((await settings.view()).clawde.status, 'connected');
  fake.control({ endpoints: null });
  await client.meta();
  assert.equal(settings.features().ask, true);
});

test("503 NO_PUBLICATION·PUBLISHING is '서비스 준비 중' and keeps the status; another 503 is '닿지 않음'", async () => {
  const { project, settings, client, legal } = await setup();
  await client.meta();
  for (const failCode of ['NO_PUBLICATION', 'PUBLISHING']) {
    fake.control({ failStatus: 503, failCode });
    await assert.rejects(legal.article(project.id, 'law:건축법/제55조'), code('SERVICE_NOT_READY'));
    const view = (await settings.view()).clawde;
    assert.equal(view.status, 'connected');
    assert.equal(view.notReady, true);
  }
  fake.control({ failStatus: 503, failCode: 'SERVICE_ERROR' });
  await assert.rejects(legal.article(project.id, 'law:건축법/제55조'), code('SERVICE_UNAVAILABLE'));
  assert.equal((await settings.view()).clawde.status, 'unreachable');
  // The next good answer clears both marks.
  fake.control({ failStatus: null });
  await client.meta();
  const view = (await settings.view()).clawde;
  assert.equal(view.status, 'connected');
  assert.equal(view.notReady, undefined);
});

test('an article asked by an abbreviated ref is kept under the stored ref too', async () => {
  fake.control({ storedRefs: true });
  const { project, legal, calls } = await setup();
  const asked = 'law:국토계획법 시행령/제84조/①/4';
  const stored = storedRef(asked);
  assert.equal(stored, 'law:국토의계획및이용에관한법률시행령/제84조/①/4');
  const first = await legal.article(project.id, asked);
  assert.equal(first.cached, false);
  assert.equal(first.article.ref, stored, 'the response ref as the service gave it');
  assert.equal(calls('/v1/articles/'), 1);
  const byAsked = await legal.article(project.id, asked);
  const byStored = await legal.article(project.id, stored);
  assert.equal(byAsked.cached, true);
  assert.equal(byStored.cached, true);
  assert.equal(byStored.article.ref, stored);
  assert.equal(calls('/v1/articles/'), 1, 'both refs hit the cache');
});

test('a kept checklist is shown when the feature turns off', async () => {
  const { project, settings, client, legal } = await setup();
  await client.meta();
  const card = await legal.checklist(project.id, {});
  assert.ok('needsConfirm' in card);
  legal.confirm(project.id, { hash: card.needsConfirm.hash });
  const first = await legal.checklist(project.id, {});
  assert.equal(first.cached, false);
  fake.control({ endpoints: M1 });
  await client.meta();
  assert.equal(settings.features().checklist, false);
  const kept = await legal.checklist(project.id, { refresh: true });
  assert.equal(kept.cached, true);
  assert.equal(kept.items.length, first.items.length);
});
