// The stage checklist and the back-question answers (SPEC-13.6·13.7·13.9, PLAN-46 T-221·T-222)
// against the fake cLAWde server: the checklist needs the confirmed send list like a question; a
// kept list for the same stage and sent information is shown without a call; an unreachable
// service shows the kept list as offline; a changed profile marks it stale; back-question answers
// confirm themselves and go out as '사용자 확정' or '가정'; `GET …/legal/checklist` and
// `POST …/legal/confirm` over HTTP.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { SecretStore } from '../../src/services/secrets.ts';
import { ServiceSettings } from '../../src/services/settings.ts';
import { ClawdeClient } from '../../src/services/clawde.ts';
import { LegalService } from '../../src/services/legal.ts';
import { startServer } from '../../src/server/server.ts';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';

let fake;
before(async () => {
  fake = await startFakeClawde();
});
after(() => fake.close());
beforeEach(() => fake.reset());

const calls = (path) => fake.received.filter((r) => r.path === path);

async function setup() {
  const store = new Store(':memory:');
  const project = store.createProject('합성 단계 목록');
  const settings = new ServiceSettings({
    directory: undefined,
    secrets: new SecretStore(undefined),
  });
  await settings.update({ clawde: { baseUrl: fake.url, token: fake.token } });
  const client = new ClawdeClient({ settings, version: 'test', timeoutMs: 2000 });
  await client.meta();
  const legal = new LegalService({ store, client, settings });
  return { store, project, legal, settings };
}

test('the checklist asks for the send card first, then is kept per stage and sent information', async () => {
  const { project, legal } = await setup();
  legal.updateProfile(project.id, { values: { 'site.zoning': { value: '제2종일반주거지역' } } });
  const card = await legal.checklist(project.id, {});
  assert.ok(card.needsConfirm, 'the first send shows the card');
  assert.equal(card.needsConfirm.stage, 'scale-review');
  assert.equal(calls('/v1/checklist').length, 0, 'nothing sent before the card');

  // A wrong hash is not a confirmation.
  const wrong = legal.confirm(project.id, { hash: 'a'.repeat(64) });
  assert.ok(wrong.needsConfirm);
  assert.deepEqual(legal.confirm(project.id, { hash: card.needsConfirm.hash }), {
    confirmed: true,
  });

  const first = await legal.checklist(project.id, {});
  assert.equal(first.cached, false);
  assert.equal(first.stage, 'scale-review');
  assert.equal(first.items.length, 6, 'every stage comes back; the screen folds the others');
  assert.equal(calls('/v1/checklist').length, 1);
  assert.deepEqual(calls('/v1/checklist')[0].body, {
    stage: 'scale-review',
    profile: { 'site.zoning': { value: '제2종일반주거지역', source: 'user' } },
  });
  const bf = first.items.find((i) => i.topic === 'BF 인증');
  assert.equal(bf.stage, 'design-development', 'BF 인증 is not a 규모검토 item');
  assert.deepEqual(bf.permitPhases, ['permit', 'occupancy']);

  // Same stage and sent information: kept, no call.
  const again = await legal.checklist(project.id, {});
  assert.equal(again.cached, true);
  assert.equal(again.offline, false);
  assert.equal(calls('/v1/checklist').length, 1);

  // Another stage asks again (the confirmed send list needs no new card).
  const dd = await legal.checklist(project.id, { stage: 'design-development' });
  assert.equal(dd.stage, 'design-development');
  assert.equal(calls('/v1/checklist').length, 2);
  assert.equal(calls('/v1/checklist')[1].body.stage, 'design-development');

  // [다시 받기] asks even when kept.
  await legal.checklist(project.id, { refresh: true });
  assert.equal(calls('/v1/checklist').length, 3);
});

test('unreachable: the kept list is shown offline; nothing kept is an error; a changed profile is stale', async () => {
  const { project, legal, settings } = await setup();
  const card = await legal.checklist(project.id, {});
  legal.confirm(project.id, { hash: card.needsConfirm.hash });
  await legal.checklist(project.id, {});

  fake.control({ failStatus: 503 });
  const offline = await legal.checklist(project.id, { refresh: true });
  assert.equal(offline.cached, true);
  assert.equal(offline.offline, true, 'kept list shown as offline');
  assert.equal(offline.items.length, 6);
  await assert.rejects(legal.checklist(project.id, { stage: 'schematic' }), {
    code: 'SERVICE_UNAVAILABLE',
  });

  // The profile changes while offline: the kept list stays visible, marked stale.
  legal.updateProfile(project.id, { values: { 'plan.gfa': { value: 2400, unit: '㎡' } } });
  const stale = await legal.checklist(project.id, {});
  assert.equal(stale.cached, true);
  assert.equal(stale.stale, true);

  // Project switched off: the kept list, never a call.
  fake.control({ failStatus: null });
  await settings.update({ clawde: { projectsOff: [project.id] } });
  const sentBefore = fake.received.length;
  const off = await legal.checklist(project.id, { refresh: true });
  assert.equal(off.cached, true);
  assert.equal(fake.received.length, sentBefore, 'nothing sent for a project switched off');
});

test('back-question answers confirm themselves: user-confirmed or assumed, sent without a new card', async () => {
  const { project, legal } = await setup();
  legal.updateProfile(project.id, { values: { 'site.zoning': { value: '제2종일반주거지역' } } });
  const question = '부설주차장은 몇 대인가요?';
  const card = await legal.askProject(project.id, { question });
  const first = await legal.askProject(project.id, {
    question,
    confirmSendHash: card.needsConfirm.hash,
  });
  assert.equal(first.answer.answer.needs[0].key, 'plan.mainUse');

  // [권장값으로 진행]: the value is '가정' and goes out without another card.
  const view = legal.updateProfile(project.id, {
    values: { 'plan.mainUse': { value: '업무시설', assumed: true } },
    answered: true,
  });
  assert.equal(view.items.find((i) => i.key === 'plan.mainUse').source, 'assumed');
  const second = await legal.askProject(project.id, { question });
  assert.ok(!second.needsConfirm, 'the answer was the confirmation');
  assert.equal(second.answer.answer.needs.length, 0, 'not asked again');
  const sent = calls('/v1/ask').at(-1).body.profile['plan.mainUse'];
  assert.deepEqual(sent, { value: '업무시설', source: 'assumed' });

  // A left-out key answered later goes out again; a plain profile edit still needs the card.
  legal.updateProfile(project.id, { exclude: { 'plan.mainUse': true } });
  legal.profile.setConfirmed(project.id, legal.profile.payload(project.id).hash);
  legal.updateProfile(project.id, {
    values: { 'plan.mainUse': { value: '제1종 근린생활시설' } },
    answered: true,
  });
  const item = legal.profileView(project.id).items.find((i) => i.key === 'plan.mainUse');
  assert.equal(item.excluded, false);
  assert.equal(item.source, 'user');
  legal.updateProfile(project.id, { values: { 'plan.gfa': { value: 1200, unit: '㎡' } } });
  const edited = await legal.askProject(project.id, { question: '일조 사선 제한을 받나요?' });
  assert.ok(edited.needsConfirm, 'an edit outside a back-question shows the card');
});

test('over HTTP: GET …/legal/checklist and POST …/legal/confirm', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-legal-checklist-'));
  const app = await startServer({
    filename: join(directory, 'data', 'store.sqlite'),
    serviceOptions: { protector: testProtector },
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
  const project = (await api('/projects', 'POST', { name: '단계 목록 HTTP' })).json;
  const base = `/projects/${project.id}/legal`;
  const notConnected = await api(`${base}/checklist`);
  assert.equal(notConnected.status, 409);
  assert.equal(notConnected.json.code, 'SERVICE_NOT_CONNECTED');

  await api('/settings/services', 'PUT', { clawde: { baseUrl: fake.url, token: fake.token } });
  const profile = await api(`${base}/profile`);
  assert.deepEqual(
    profile.json.permitPhases.map((p) => p.label),
    ['심의', '허가', '착공', '사용승인'],
  );
  assert.ok(profile.json.profileKeys.some((k) => k.key === 'plan.mainUse'));
  const card = await api(`${base}/checklist?stage=schematic`);
  assert.equal(card.status, 200);
  assert.equal(card.json.needsConfirm.stage, 'schematic');
  const confirmed = await api(`${base}/confirm`, 'POST', { hash: card.json.needsConfirm.hash });
  assert.deepEqual(confirmed.json, { confirmed: true });
  const list = await api(`${base}/checklist?stage=schematic`);
  assert.equal(list.json.stage, 'schematic');
  assert.equal(list.json.items.length, 6);
  const kept = await api(`${base}/checklist?stage=schematic`);
  assert.equal(kept.json.cached, true);
  const bad = await api(`${base}/checklist?stage=permit`);
  assert.equal(bad.status, 400);
  const badConfirm = await api(`${base}/confirm`, 'POST', { hash: 'x' });
  assert.equal(badConfirm.status, 400);
});
