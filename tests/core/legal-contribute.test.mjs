// 되돌려 보내기 VIDE → cLAWde (SPEC-13.10, OQ-17, PLAN-46 T-224) against the fake cLAWde server:
// only the ticked items go, nothing is ticked by default, assumptions / AI estimates / unconfirmed
// values are refused, the same idempotencyKey is received once, a partial refusal shows each item
// with its reason, 503 marks nothing sent and nothing is resent, and a remote session gets 403.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { SecretStore } from '../../src/services/secrets.ts';
import { ServiceSettings } from '../../src/services/settings.ts';
import { ClawdeClient } from '../../src/services/clawde.ts';
import { LegalService } from '../../src/services/legal.ts';
import { projectRef } from '../../src/services/legal-contribute.ts';
import { legalRoutes } from '../../src/server/service-routes.ts';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';

let fake;
before(async () => {
  fake = await startFakeClawde();
});
after(() => fake.close());
beforeEach(() => fake.reset());

const posted = () => fake.received.filter((r) => r.path === '/v1/contributions');

async function setup(t, { fetcher } = {}) {
  const store = new Store(':memory:');
  const project = store.createProject('합성 역전송');
  const settings = new ServiceSettings({
    directory: undefined,
    secrets: new SecretStore(undefined),
  });
  await settings.update({ clawde: { baseUrl: fake.url, token: fake.token } });
  const client = new ClawdeClient({ settings, version: 'test', fetcher, timeoutMs: 2000 });
  await client.meta();
  const legal = new LegalService({ store, client, settings });
  legal.updateProfile(project.id, {
    values: {
      'site.zoning': { value: '제2종일반주거지역' },
      'site.area': { value: 420, unit: '㎡' },
      'plan.mainUse': { value: '업무시설' },
    },
  });
  legal.profile.offer(project.id, 'plan.gfa', { value: 1200, unit: '㎡', source: 'ai' });
  legal.profile.offer(project.id, 'plan.floorsAbove', { value: 5, source: 'assumed' });
  legal.profile.offer(project.id, 'plan.height', { value: 18, unit: 'm', source: 'model' });
  t.after(() => store.close());
  return { store, project, legal, settings };
}

test('the list: every value, nothing ticked; only user-confirmed values can be chosen', async (t) => {
  const { legal, project } = await setup(t);
  const items = legal.contributions.view(project.id);
  assert.deepEqual(
    items.map((i) => [i.key, i.selectable, i.blocked ?? null, i.sent]),
    [
      ['plan.floorsAbove', false, 'assumed', null],
      ['plan.gfa', false, 'ai', null],
      ['plan.height', false, 'model', null],
      ['plan.mainUse', true, null, null],
      ['site.area', true, null, null],
      ['site.zoning', true, null, null],
    ],
  );
  assert.equal(posted().length, 0, 'listing sends nothing');
});

test('only the ticked items go, once; they show 보냄 until the value changes', async (t) => {
  const { legal, project } = await setup(t);
  const result = await legal.contributions.send(project.id, { keys: ['site.zoning', 'site.area'] });
  assert.equal(posted().length, 1);
  const body = posted()[0].body;
  assert.deepEqual(
    body.items.map((i) => [i.key, i.value, i.unit ?? null, i.basis]),
    [
      ['site.area', 420, '㎡', 'user'],
      ['site.zoning', '제2종일반주거지역', null, 'user'],
    ],
  );
  assert.equal(body.projectRef, projectRef(project.id));
  assert.ok(!JSON.stringify(body).includes(project.id), 'no project id or name');
  assert.ok(!JSON.stringify(body).includes('합성 역전송'));
  assert.deepEqual(result.accepted.sort(), ['site.area', 'site.zoning']);
  assert.deepEqual(result.rejected, []);
  const view = Object.fromEntries(result.items.map((i) => [i.key, i]));
  assert.equal(view['site.zoning'].blocked, 'sent');
  assert.equal(view['site.zoning'].sent.receiptId, result.receiptId);
  assert.equal(view['plan.mainUse'].selectable, true, 'not ticked, not sent');
  assert.equal(fake.stored.length, 2);

  // The same value cannot be chosen again; a changed value can.
  await assert.rejects(legal.contributions.send(project.id, { keys: ['site.zoning'] }), {
    code: 'LEGAL_NOT_CONTRIBUTABLE',
  });
  legal.updateProfile(project.id, { values: { 'site.zoning': { value: '제3종일반주거지역' } } });
  const changed = legal.contributions.view(project.id).find((i) => i.key === 'site.zoning');
  assert.equal(changed.selectable, true);
  assert.equal(changed.sent, null);
});

test('assumptions, AI estimates and unconfirmed values are refused before anything goes', async (t) => {
  const { legal, project } = await setup(t);
  for (const key of ['plan.floorsAbove', 'plan.gfa', 'plan.height', 'plan.unknown'])
    await assert.rejects(legal.contributions.send(project.id, { keys: ['site.zoning', key] }), {
      code: 'LEGAL_NOT_CONTRIBUTABLE',
    });
  await assert.rejects(legal.contributions.send(project.id, { keys: [] }));
  assert.equal(posted().length, 0);
});

test('a partial refusal shows each refused item with its reason; only the accepted are 보냄', async (t) => {
  const { legal, project } = await setup(t);
  fake.control({ rejectKeys: ['plan.mainUse'] });
  const result = await legal.contributions.send(project.id, {
    keys: ['plan.mainUse', 'site.area'],
  });
  assert.deepEqual(result.accepted, ['site.area']);
  assert.deepEqual(result.rejected, [
    { key: 'plan.mainUse', label: '주용도', reason: 'rejected by service review' },
  ]);
  const view = Object.fromEntries(result.items.map((i) => [i.key, i]));
  assert.equal(view['site.area'].blocked, 'sent');
  assert.equal(view['plan.mainUse'].selectable, true, 'refused: may be chosen again');
});

test('the same selection resent after a lost answer is received once (idempotencyKey)', async (t) => {
  // The first answer is lost on the way back: the service took it, VIDE saw a failure.
  let lose = true;
  const fetcher = async (url, init) => {
    const response = await fetch(url, init);
    if (lose && String(url).endsWith('/v1/contributions')) {
      lose = false;
      await response.body?.cancel();
      throw new TypeError('connection reset');
    }
    return response;
  };
  const { legal, project } = await setup(t, { fetcher });
  await assert.rejects(legal.contributions.send(project.id, { keys: ['site.zoning'] }), {
    code: 'SERVICE_UNAVAILABLE',
  });
  assert.equal(
    legal.contributions.view(project.id).find((i) => i.key === 'site.zoning').sent,
    null,
  );
  const again = await legal.contributions.send(project.id, { keys: ['site.zoning'] });
  assert.equal(posted().length, 2);
  assert.equal(posted()[0].body.idempotencyKey, posted()[1].body.idempotencyKey);
  assert.equal(fake.stored.length, 1, 'the service stored it once');
  assert.equal(again.receiptId, 'fake-receipt-1', 'the first receipt');
});

test('503: nothing is 보냄 and nothing is resent by itself', async (t) => {
  const { legal, project } = await setup(t);
  fake.control({ failStatus: 503 });
  await assert.rejects(legal.contributions.send(project.id, { keys: ['site.zoning'] }), {
    code: 'SERVICE_UNAVAILABLE',
  });
  fake.control({ failStatus: null });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(posted().length, 1);
  assert.ok(legal.contributions.view(project.id).every((i) => i.sent === null));
  assert.equal(fake.stored.length, 0);
});

test('HTTP: the list and the send; a remote session gets 403; a project switched off is refused', async (t) => {
  const { legal, project, settings } = await setup(t);
  const call = async (method, payload, remote = false) => {
    let status, data;
    const url = new URL(`http://x/api/v1/projects/${project.id}/legal/contribute`);
    try {
      await legalRoutes(url, method, {
        legal,
        body: async () => payload,
        send: (s, d) => ((status = s), (data = d)),
        remote,
      });
    } catch (error) {
      return { code: error.code };
    }
    return { status, data };
  };
  const list = await call('GET');
  assert.equal(list.status, 200);
  assert.equal(list.data.items.length, 6);
  assert.deepEqual(await call('POST', { keys: ['site.zoning'] }, true), { code: 'FORBIDDEN' });
  assert.equal(posted().length, 0);
  const sent = await call('POST', { keys: ['site.zoning'] });
  assert.deepEqual(sent.data.accepted, ['site.zoning']);
  await settings.update({ clawde: { projectsOff: [project.id] } });
  assert.deepEqual(await call('POST', { keys: ['site.area'] }), { code: 'LEGAL_PROJECT_OFF' });
});
