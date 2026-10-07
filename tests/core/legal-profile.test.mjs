// The legal profile and the send confirmation (SPEC-13.3·13.4, PLAN-46 T-219) against the fake
// cLAWde server: the first question sends nothing before the card; after [보내기] the server gets
// exactly the confirmed items; left-out items stay out; a changed value asks again; AI estimates
// cannot be chosen; statements, names and paths never leave; user values are not overwritten.
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
import { legalRoutes } from '../../src/server/service-routes.ts';
import { startServer } from '../../src/server/server.ts';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';

let fake;
before(async () => {
  fake = await startFakeClawde();
});
after(() => fake.close());
beforeEach(() => fake.reset());

const asks = () => fake.received.filter((r) => r.path === '/v1/ask');

async function setup() {
  const store = new Store(':memory:');
  const project = store.createProject('합성 법규 프로젝트');
  const settings = new ServiceSettings({
    directory: undefined,
    secrets: new SecretStore(undefined),
  });
  await settings.update({ clawde: { baseUrl: fake.url, token: fake.token } });
  const client = new ClawdeClient({ settings, version: 'test' });
  await client.meta();
  const legal = new LegalService({ store, client, settings });
  return { store, project, legal };
}

/** Asks, and when the card comes, confirms it as shown (optionally leaving keys out). */
async function askConfirmed(legal, projectId, question, exclude) {
  const first = await legal.askProject(projectId, { question });
  if (!first.needsConfirm) return { first, result: first };
  const result = await legal.askProject(projectId, {
    question,
    confirmSendHash: first.needsConfirm.hash,
    ...(exclude ? { exclude } : {}),
  });
  return { first, result };
}

test('the first question shows the card and sends nothing; after [보내기] the server gets exactly the confirmed items', async () => {
  const { project, legal } = await setup();
  legal.updateProfile(project.id, {
    values: {
      'site.zoning': { value: '제2종일반주거지역' },
      'site.area': { value: 420, unit: '㎡' },
    },
  });
  legal.profile.offer(project.id, 'plan.mainUse', {
    value: '업무시설',
    source: 'model',
    version: 'site-3',
  });

  const first = await legal.askProject(project.id, { question: '일조 사선 제한을 받나요?' });
  assert.ok(first.needsConfirm);
  assert.equal(asks().length, 0, 'nothing sent before the card');
  assert.deepEqual(
    first.needsConfirm.items.map((i) => [i.key, i.value, i.source, i.selectable, i.excluded]),
    [
      ['plan.mainUse', '업무시설', 'model', true, false],
      ['site.area', 420, 'user', true, false],
      ['site.zoning', '제2종일반주거지역', 'user', true, false],
    ],
  );
  assert.equal(
    first.needsConfirm.items.find((i) => i.key === 'site.area').label,
    '대지 면적',
    'labels from meta',
  );
  assert.equal(first.needsConfirm.stage, 'scale-review');

  // A wrong or old hash is not a confirmation.
  const wrong = await legal.askProject(project.id, {
    question: '일조 사선 제한을 받나요?',
    confirmSendHash: 'a'.repeat(64),
  });
  assert.equal(wrong.needsConfirm.hash, first.needsConfirm.hash);
  assert.equal(asks().length, 0);

  const done = await legal.askProject(project.id, {
    question: '일조 사선 제한을 받나요?',
    confirmSendHash: first.needsConfirm.hash,
  });
  assert.equal(done.number, 1);
  assert.equal(done.answer.verdict, 'applies');
  assert.equal(asks().length, 1);
  assert.deepEqual(asks()[0].body.profile, {
    'plan.mainUse': { value: '업무시설', source: 'model', version: 'site-3' },
    'site.area': { value: 420, unit: '㎡', source: 'user' },
    'site.zoning': { value: '제2종일반주거지역', source: 'user' },
  });
  assert.equal(asks()[0].body.stage, 'scale-review');

  // Unchanged information: no card for the next question.
  const next = await legal.askProject(project.id, { question: '대지 안의 공지를 띄워야 하나요?' });
  assert.equal(next.number, 2);
  assert.equal(asks().length, 2);
});

test('items left out stay out; a changed value asks again; AI estimates cannot be chosen', async () => {
  const { project, legal } = await setup();
  legal.updateProfile(project.id, {
    values: {
      'site.zoning': { value: '제2종일반주거지역' },
      'plan.gfa': { value: 1200, unit: '㎡' },
    },
  });
  legal.profile.offer(project.id, 'plan.height', { value: 21, unit: 'm', source: 'ai' });
  const { first } = await askConfirmed(legal, project.id, '일조 사선 제한을 받나요?', ['plan.gfa']);
  const ai = first.needsConfirm.items.find((i) => i.key === 'plan.height');
  assert.deepEqual([ai.selectable, ai.excluded], [false, true], 'greyed, not chosen');
  assert.deepEqual(Object.keys(asks()[0].body.profile), ['site.zoning']);

  // An AI estimate is not sent even when the card's [보내기] does not list it as left out.
  // Changing a value brings the card back; the left-out item stays out without being listed.
  legal.updateProfile(project.id, { values: { 'site.zoning': { value: '일반상업지역' } } });
  const again = await legal.askProject(project.id, { question: '건폐율은 얼마까지인가요?' });
  assert.ok(again.needsConfirm, 'a changed value is confirmed again');
  assert.equal(again.needsConfirm.items.find((i) => i.key === 'plan.gfa').excluded, true);
  await legal.askProject(project.id, {
    question: '건폐율은 얼마까지인가요?',
    confirmSendHash: again.needsConfirm.hash,
  });
  assert.deepEqual(asks()[1].body.profile, {
    'site.zoning': { value: '일반상업지역', source: 'user' },
  });
  // Put back through the card: the final list is what counts.
  legal.updateProfile(project.id, { values: { 'site.zoning': { value: '제2종일반주거지역' } } });
  const back = await legal.askProject(project.id, { question: '주차는?' });
  await legal.askProject(project.id, {
    question: '주차는?',
    confirmSendHash: back.needsConfirm.hash,
    exclude: [],
  });
  assert.deepEqual(Object.keys(asks()[2].body.profile).sort(), ['plan.gfa', 'site.zoning']);
  // The AI estimate confirmed by the user becomes a user value and is then sendable.
  legal.updateProfile(project.id, { values: { 'plan.height': { value: 21, unit: 'm' } } });
  const confirmed = legal.profileView(project.id).items.find((i) => i.key === 'plan.height');
  assert.equal(confirmed.source, 'user');
});

test('the sent body carries no statements, names, paths or project details', async () => {
  const { project, legal } = await setup();
  legal.profile.offer(project.id, 'site.area', {
    value: 420,
    unit: '㎡',
    source: 'model',
    version: 'site-3',
    basis: 'statement:17 C:\\Projects\\합성\\대지.dwg 홍길동',
  });
  legal.updateProfile(project.id, { values: { 'plan.mainUse': { value: '업무시설' } } });
  await askConfirmed(legal, project.id, '일조 사선 제한을 받나요?');
  const body = JSON.stringify(asks()[0].body);
  for (const secret of [
    'statement',
    'C:\\\\',
    '대지.dwg',
    '홍길동',
    project.id,
    '합성 법규 프로젝트',
  ])
    assert.ok(!body.includes(secret), `${secret} in ${body}`);
  assert.deepEqual(Object.keys(asks()[0].body).sort(), ['locale', 'profile', 'question', 'stage']);
  assert.equal(
    legal.profileView(project.id).items.find((i) => i.key === 'site.area').basis.length > 0,
    true,
    'kept locally',
  );
});

test('user values are not replaced by other sources: a notice instead; changes mark only their answers', async () => {
  const { project, legal } = await setup();
  legal.updateProfile(project.id, { values: { 'site.area': { value: 420, unit: '㎡' } } });
  assert.equal(
    legal.profile.offer(project.id, 'site.area', { value: 431.5, unit: '㎡', source: 'model' }),
    false,
  );
  const item = legal.profileView(project.id).items.find((i) => i.key === 'site.area');
  assert.deepEqual(
    [item.value, item.source, item.notice.value, item.notice.source],
    [420, 'user', 431.5, 'model'],
  );
  legal.updateProfile(project.id, { values: { 'site.zoning': { value: '제2종일반주거지역' } } });
  await askConfirmed(legal, project.id, '일조 사선 제한을 받나요?'); // L1 uses site.zoning
  await askConfirmed(legal, project.id, '조례로 정한 높이 제한은?'); // L2 uses nothing
  const changed = legal.updateProfile(project.id, {
    values: { 'site.zoning': { value: '일반상업지역' } },
  });
  assert.deepEqual(changed.changed, ['site.zoning']);
  assert.deepEqual(changed.stale, [1]);
  const { answers } = await legal.list(project.id);
  assert.deepEqual(
    answers.map((a) => [a.ref, a.stale]),
    [
      ['L2', false],
      ['L1', true],
    ],
  );
  // The same value again is no change.
  assert.deepEqual(
    legal.updateProfile(project.id, { values: { 'site.zoning': { value: '일반상업지역' } } })
      .changed,
    [],
  );
});

test('the stage is kept in the profile and sent; vide keys and bad input are refused', async () => {
  const { project, legal } = await setup();
  legal.updateProfile(project.id, { stage: 'design-development' });
  assert.equal(legal.profileView(project.id).stage, 'design-development');
  await askConfirmed(legal, project.id, '일조 사선 제한을 받나요?');
  assert.equal(asks()[0].body.stage, 'design-development');
  assert.ok(legal.profileView(project.id).stages.some((s) => s.id === 'construction-docs'));
  assert.throws(() =>
    legal.updateProfile(project.id, { values: { 'vide:confirmed': { value: 'x' } } }),
  );
  assert.throws(() => legal.updateProfile(project.id, { stage: 'feasibility' }));
  assert.throws(() => legal.updateProfile(project.id, { other: 1 }));
  await assert.rejects(legal.askProject(project.id, { question: '  ' }));
});

test('over HTTP: profile, ask with the card, answers; remote sessions cannot change the profile', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-legal-http-'));
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
  const project = (await api('/projects', 'POST', { name: '법규 HTTP' })).json;
  const base = `/projects/${project.id}/legal`;
  // Not connected: refused before any card.
  const off = await api(`${base}/ask`, 'POST', { question: '일조' });
  assert.equal(off.status, 409);
  assert.equal(off.json.code, 'SERVICE_NOT_CONNECTED');
  await api('/settings/services', 'PUT', { clawde: { baseUrl: fake.url, token: fake.token } });
  const put = await api(`${base}/profile`, 'PUT', {
    values: { 'site.zoning': { value: '제2종일반주거지역' } },
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.items[0].source, 'user');
  const card = await api(`${base}/ask`, 'POST', { question: '일조 사선 제한을 받나요?' });
  assert.equal(card.status, 200);
  assert.ok(card.json.needsConfirm.hash);
  assert.equal(asks().length, 0);
  const done = await api(`${base}/ask`, 'POST', {
    question: '일조 사선 제한을 받나요?',
    confirmSendHash: card.json.needsConfirm.hash,
  });
  assert.equal(done.json.number, 1);
  assert.equal(done.json.answer.ref, 'L1');
  const list = await api(`${base}/answers`);
  assert.deepEqual(
    list.json.answers.map((a) => a.ref),
    ['L1'],
  );
  assert.equal(
    (await api(`${base}/answers?number=1`)).json.answer.question,
    '일조 사선 제한을 받나요?',
  );
  assert.equal((await api(`${base}/answers?number=9`)).status, 404);
  assert.equal((await api(`${base}/answers?number=x`)).status, 400);
  // Switched off for this project: refused, the cache still answers.
  await api('/settings/services', 'PUT', { clawde: { projectsOff: [project.id] } });
  assert.equal(
    (await api(`${base}/ask`, 'POST', { question: '대지 안의 공지' })).json.code,
    'LEGAL_PROJECT_OFF',
  );
  assert.equal(
    (await api(`${base}/ask`, 'POST', { question: '일조 사선 제한을 받나요?' })).json.cached,
    true,
  );

  // Remote sessions: ask and read yes, profile writes no.
  const store = new Store(':memory:');
  const remoteProject = store.createProject('원격');
  const settings = new ServiceSettings({
    directory: undefined,
    secrets: new SecretStore(undefined),
  });
  const legal = new LegalService({
    store,
    client: new ClawdeClient({ settings, version: 'test' }),
    settings,
  });
  const route = (path, method, payload) =>
    legalRoutes(new URL(`http://x/api/v1/projects/${remoteProject.id}/legal/${path}`), method, {
      legal,
      body: async () => payload,
      send: () => {},
      remote: true,
    });
  await assert.rejects(
    route('profile', 'PUT', { values: { 'site.area': { value: 1 } } }),
    (error) => error.code === 'FORBIDDEN',
  );
  assert.equal(await route('profile', 'GET'), true);
  assert.equal(await route('answers', 'GET'), true);
});
