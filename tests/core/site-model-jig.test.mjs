// vide/site-model (PLAN-45 T-207, SPEC-12.3~12.6·12.14·12.16): the official tool jig loads from the
// built-in folder; its self-test passes on the synthetic fixtures (single, 합필, 떨어진 필지, several
// candidates, SHP only with terrain); and the instance's site-data routes keep the read-copies —
// nothing sent before the FR-18 notice, proposal → '대상 필지 미확정' with Rhino에 만들기 blocked,
// confirmation, [다시 가져오기] with the changed items and the earlier copy kept, keyless sources
// only 'no-key', public data off → the SHP put in. Synthetic services only; nothing leaves the PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigRegistry, officialJigRoot } from '../../src/jigs/runtime/loader.ts';
import { selftestJig, validateJig } from '../../src/jigs/runtime/pack.ts';
import { runGates } from '../../src/jigs/runtime/gates.ts';
import { closeJigRuntime, jigRuntimeFor } from '../../src/server/jig-routes.ts';
import { siteModelRoutes } from '../../src/server/site-model-routes.ts';
import { SiteDataSettings } from '../../src/server/site-data-routes.ts';
import { PublicDataKeyStore } from '../../src/server/public-data-keys.ts';
import { addressFromRequest } from '../../src/contracts/site-data.ts';
import { JIGS } from '../../src/jigs/catalog.ts';
import { KEYS, P1, P2, ROAD, fakeSiteData } from '../fixtures/site-data.mjs';
import { SHP_TARGET, siteShapefiles } from '../fixtures/site-shp.mjs';

const DIR = join(officialJigRoot(), 'site-model');
const now = () => new Date('2026-10-08T03:00:00Z');

test('the official tool jig is built in: registry, validation, self-test on the fixtures', async () => {
  const registry = new JigRegistry({ dataDir: tmpdir() });
  const entry = (await registry.list()).find((e) => e.id === 'vide/site-model');
  assert.equal(entry?.stage, 'official');
  assert.equal(entry?.source, 'builtin');
  assert.equal(entry?.kind, 'tool');
  const jig = await registry.resolve('vide/site-model');
  assert.equal(jig.source, 'builtin');
  assert.deepEqual(
    (await validateJig(DIR, { source: 'builtin' })).issues.filter((i) => i.level === 'error'),
    [],
  );
  const report = await selftestJig(DIR, { source: 'builtin' });
  assert.deepEqual(
    report.cases.map((c) => [c.name, c.ok]),
    [
      ['ambiguous', true],
      ['merged', true],
      ['separated', true],
      ['shp-terrain', true],
      ['single', true],
    ],
    JSON.stringify(report.cases.filter((c) => !c.ok).map((c) => [c.name, c.error, c.mismatches])),
  );
  // J-01 is this jig now.
  const j01 = JIGS.find((j) => j.code === 'J-01');
  assert.equal(j01.id, 'vide/site-model');
  assert.equal(j01.status, 'available');
});

test('the address in a request that opens site modeling', () => {
  assert.equal(addressFromRequest('가나동 123-4 대지 모델링해 줘'), '가나동 123-4');
  assert.equal(
    addressFromRequest('서울 중구 세종대로 110 사이트 모델 만들어'),
    '서울 중구 세종대로 110',
  );
  assert.equal(addressFromRequest('용산동2가 산 1-3번지 대지 모델링'), '용산동2가 산 1-3');
  assert.equal(addressFromRequest('1199910100100010000 대지 모델링'), '1199910100100010000');
  assert.equal(addressFromRequest('대지 모델링해 줘, 반경 300 m'), null);
});

test('gates: a missing target stops with the jig sentence; Rhino에 만들기 waits for the target', () => {
  const manifest = { steps: [], params: [], inputs: [] };
  const empty = runGates(
    [{ use: 'non-empty', args: { items: 'targets', message: '대상 필지 경계가 없습니다' } }],
    'after-run',
    { manifest, stepId: 'collect', inputs: {}, params: {}, output: { targets: [] } },
  );
  assert.deepEqual(empty.blocked, ['non-empty']);
  assert.equal(empty.results[0].message, '대상 필지 경계가 없습니다');
  const bake = (confirmed) =>
    runGates([{ use: 'target-confirmed' }], 'before-bake', {
      manifest,
      stepId: 'make',
      inputs: {},
      params: {},
      hooks: { targetConfirmed: () => confirmed },
    });
  assert.deepEqual(bake(false).blocked, ['target-confirmed']);
  assert.deepEqual(bake(true).blocked, []);
});

function setup(t, { keys = KEYS, fake = fakeSiteData() } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vide-site-model-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(root, 'workspace.sqlite'));
  const workspace = new Workspace(store);
  const project = store.createProject('사이트 모델링 시험');
  const settings = new SiteDataSettings(join(dataDir, 'site-data-settings.json'));
  const runtime = jigRuntimeFor(workspace, dataDir);
  const services = { fake };
  t.after(async () => {
    await closeJigRuntime(workspace);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (method, path, payload) => {
    let out;
    const handled = await siteModelRoutes(new URL(path, 'http://127.0.0.1'), method, {
      workspace,
      dataDirectory: dataDir,
      keys: new PublicDataKeyStore(undefined, keys),
      settings,
      body: async () => payload ?? {},
      send: (status, data) => (out = { status, data }),
      context: { fetch: (...args) => services.fake.fetch(...args), now },
    });
    assert.ok(handled, path);
    return out.data;
  };
  return { project, runtime, settings, call, services };
}

async function instance(f) {
  const view = await f.runtime.createInstance(f.project.id, {
    jig: 'vide/site-model',
    title: '대지',
    layerRoot: 'VIDE::대지',
  });
  const base = `/api/v1/projects/${f.project.id}/jig-instances/${view.id}/site-data/site`;
  const run = async () => f.runtime.run(f.project.id, view.id, { mode: 'confirmed' });
  const status = (report, id) => report.steps.find((s) => s.id === id)?.status;
  return { iid: view.id, base, run, status };
}

test('flow: notice first, proposal, 대상 필지 미확정, confirmation, re-fetch with changes kept apart', async (t) => {
  const f = setup(t);
  const i = await instance(f);

  // Nothing is sent before the project confirmed the notice; the address is kept.
  const asked = await f.call('POST', `${i.base}/lookup`, { query: '합성시 가나구 가나동 1' });
  assert.ok(asked.needsConfirm);
  assert.equal(f.services.fake.calls.length, 0, 'no request before the notice');
  assert.equal(asked.state.query, '합성시 가나구 가나동 1');
  await f.settings.update(f.project.id, () => ({
    confirmed: { version: asked.needsConfirm.version, at: 'x' },
  }));

  // One fitting candidate: proposed, not confirmed; collect has nothing yet → later steps stop.
  const found = await f.call('POST', `${i.base}/lookup`, { query: '합성시 가나구 가나동 1' });
  assert.equal(found.status, 'ok');
  assert.deepEqual(found.state.targets.pnus, [P1]);
  assert.equal(found.state.targets.by, 'proposal');
  let report = await i.run();
  assert.equal(i.status(report, 'candidates'), 'done');
  assert.equal(i.status(report, 'confirmTarget'), 'waiting');
  assert.equal(i.status(report, 'collect'), 'gate-failed');
  assert.equal(i.status(report, 'frame'), 'blocked');

  // Collect: every step computes while the target is unconfirmed; only Rhino에 만들기 waits.
  const collected = await f.call('POST', `${i.base}/collect`);
  assert.equal(collected.blocked, false);
  assert.equal(collected.state.collection.pnus[0], P1);
  report = await i.run();
  for (const id of ['collect', 'frame', 'roads', 'terrain', 'buildings', 'summary'])
    assert.equal(i.status(report, id), 'done', id);
  assert.equal(i.status(report, 'confirmTarget'), 'waiting');
  assert.equal(i.status(report, 'make'), 'blocked');
  assert.equal(report.outputs.summary.computedArea_m2, 600);
  assert.equal(report.outputs.roads.roads[0].pnu, ROAD);
  // The provenance of the read-copy is the collector's, with no key in it.
  const kept = await f.runtime.siteData(f.project.id, i.iid, 'site');
  const copy = kept.read(kept.state.collection);
  assert.equal(copy.target.provenance.service, 'vide/site-data');
  for (const key of Object.values(KEYS)) assert.ok(!JSON.stringify(copy).includes(key));

  // The person confirms; changing the parcels afterwards asks again.
  const confirmHash = report.steps.find((s) => s.id === 'confirmTarget').inputHash;
  await f.runtime.confirmStep(f.project.id, i.iid, 'confirmTarget', confirmHash);
  report = await i.run();
  assert.equal(i.status(report, 'confirmTarget'), 'confirmed');
  assert.equal(i.status(report, 'make'), 'waiting');
  const both = await f.call('PUT', `${i.base}/targets`, { pnus: [P1, P2] });
  assert.equal(both.state.targets.by, 'user');
  report = await i.run();
  assert.equal(i.status(report, 'confirmTarget'), 'reconfirm');
  assert.ok(report.outputs.collect.checks.includes('대상 필지가 바뀌었습니다. 다시 가져오세요'));
  await f.call('PUT', `${i.base}/targets`, { pnus: [P1] });
  report = await i.run();
  assert.equal(i.status(report, 'confirmTarget'), 'confirmed', 'back to the confirmed parcels');

  // [다시 가져오기]: a changed 공부 면적 waits with the list; the old copy stays in use.
  f.services.fake = fakeSiteData({ officialArea: 610 });
  const again = await f.call('POST', `${i.base}/collect`);
  assert.equal(again.waiting, true);
  assert.ok(
    again.changes.some((c) => c.startsWith('공부 면적 600 → 610')),
    again.changes.join(),
  );
  assert.equal(again.state.pending.changes.length, again.changes.length);
  report = await i.run();
  assert.equal(report.outputs.summary.officialArea_m2, 600, 'still the copy in use');
  const taken = await f.call('POST', `${i.base}/pending`, { take: true });
  assert.equal(taken.state.pending, null);
  assert.equal(taken.state.previous.length, 1, 'the earlier copy is kept');
  report = await i.run();
  assert.equal(report.outputs.summary.officialArea_m2, 610);
  // The same answer again: taken at once, nothing to decide.
  const same = await f.call('POST', `${i.base}/collect`);
  assert.equal(same.unchanged, true);
  assert.equal(same.state.previous.length, 2);
});

test('several candidates: a question card with [PNU 직접 입력]; no choice is made for the person', async (t) => {
  const f = setup(t);
  const { SITE_DATA_NOTICE } = await import('../../src/contracts/site-data.ts');
  await f.settings.update(f.project.id, () => ({
    confirmed: { version: SITE_DATA_NOTICE.version, at: 'x' },
  }));
  const i = await instance(f);
  const found = await f.call('POST', `${i.base}/lookup`, { query: '합성시 가나구 가나로 10' });
  assert.equal(found.status, 'ambiguous');
  assert.equal(found.state.targets, null);
  const report = await i.run();
  const question = report.outputs.candidates.question;
  assert.equal(question.options.length, 2);
  assert.equal(question.allowFree, true);
  assert.ok(!question.options.some((o) => o.recommended));
  await assert.rejects(f.call('POST', `${i.base}/collect`), { code: 'SITE_TARGETS_MISSING' });
});

test('missing keys: only those sources say 키 없음; the rest is collected and computed', async (t) => {
  const { SITE_DATA_NOTICE } = await import('../../src/contracts/site-data.ts');
  const f = setup(t, { keys: { VWORLD_KEY: KEYS.VWORLD_KEY } });
  await f.settings.update(f.project.id, () => ({
    confirmed: { version: SITE_DATA_NOTICE.version, at: 'x' },
  }));
  const i = await instance(f);
  await f.call('PUT', `${i.base}/targets`, { pnus: [P1] });
  await f.call('POST', `${i.base}/collect`);
  const report = await i.run();
  const register = report.outputs.collect.sources.find((s) => s.key === 'register');
  assert.equal(register.status, 'no-key');
  assert.equal(report.outputs.collect.sources.find((s) => s.key === 'target').status, 'ok');
  assert.equal(i.status(report, 'summary'), 'done');
});

test('public data off: nothing is sent; the SHP put in answers the lot and builds the site', async (t) => {
  const f = setup(t);
  await f.settings.update(f.project.id, () => ({ off: true }));
  const i = await instance(f);
  const off = await f.call('POST', `${i.base}/lookup`, { query: '12-4' });
  assert.equal(off.off, true);
  await assert.rejects(f.call('PUT', `${i.base}/targets`, { pnus: ['bad'] }));
  const put = await f.call('POST', `${i.base}/shp`, {
    files: siteShapefiles().map((file) => ({
      name: file.name,
      data: Buffer.from(file.bytes).toString('base64'),
    })),
  });
  assert.deepEqual(put.layers.map((l) => l.role).sort(), [
    'building',
    'contour',
    'parcel',
    'spot-height',
  ]);
  assert.deepEqual(put.rejected, []);
  let report = await i.run();
  assert.equal(report.outputs.candidates.source, 'shp');
  assert.equal(report.outputs.candidates.proposal, SHP_TARGET);
  await f.call('PUT', `${i.base}/targets`, { pnus: [SHP_TARGET] });
  await assert.rejects(f.call('POST', `${i.base}/collect`), { code: 'SITE_DATA_OFF' });
  report = await i.run();
  assert.equal(i.status(report, 'summary'), 'done');
  assert.equal(report.outputs.buildings.estimated, 2);
  assert.equal(report.outputs.terrain.included, false, 'terrain is off by default');
  assert.equal(f.services.fake.calls.length, 0, 'nothing was sent');
  // Clearing the SHP takes the site away again.
  await f.call('POST', `${i.base}/shp`, { clear: true });
  report = await i.run();
  assert.equal(i.status(report, 'collect'), 'gate-failed');
});
