// 모델과 잇기 (SPEC-13.8, PLAN-46 T-220) against the fake cLAWde server and a synthetic site model
// (the official `vide/site-model` jig run on the synthetic public-data service): the 대지 요약 fills
// the legal profile as '모델에서 읽음' with its run, never over a user value (a notice instead), and a
// recomputed site model changes the value with a '바뀐 값' notice and marks the answers that used it;
// an answer's targets resolve to the objects the site-model bakes made (Link ID) or '모델에 없음';
// `legal.constraints` carries only constraints whose every article is cited with its text, with
// 근거 조항 · 출처 표시 · 적용 여부; and `vide/buildable-mass` takes it as its `legal` input, the
// person's value still winning. Nothing real leaves the PC.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import { SecretStore } from '../../src/services/secrets.ts';
import { ServiceSettings } from '../../src/services/settings.ts';
import { ClawdeClient } from '../../src/services/clawde.ts';
import { LegalService } from '../../src/services/legal.ts';
import {
  constraintsOutput,
  profileFromSiteModel,
  targetChips,
} from '../../src/services/legal-model.ts';
import { regulationsFromLegal } from '../../src/jigs/official/massing-kit/legal-adapter.ts';
import { siteModelSource } from '../../src/server/legal-model-source.ts';
import { closeJigRuntime, jigRuntimeFor, provideJigOutput } from '../../src/server/jig-routes.ts';
import { siteModelRoutes } from '../../src/server/site-model-routes.ts';
import { SiteDataSettings } from '../../src/server/site-data-routes.ts';
import { PublicDataKeyStore } from '../../src/server/public-data-keys.ts';
import { SITE_DATA_NOTICE } from '../../src/contracts/site-data.ts';
import { KEYS, P1, fakeSiteData } from '../fixtures/site-data.mjs';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';

let fake;
before(async () => {
  fake = await startFakeClawde();
});
after(() => fake.close());
beforeEach(() => fake.reset());

const now = () => new Date('2026-10-08T03:00:00Z');

/** A project with a site-model instance, the legal service reading it and the jig runtime. */
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'vide-legal-model-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(root, 'workspace.sqlite'));
  const workspace = new Workspace(store);
  const project = store.createProject('합성 법규·대지 프로젝트');
  const runtime = jigRuntimeFor(workspace, dataDir);
  const siteSettings = new SiteDataSettings(join(dataDir, 'site-data-settings.json'));
  await siteSettings.update(project.id, () => ({
    confirmed: { version: SITE_DATA_NOTICE.version, at: 'x' },
  }));
  const services = { fake: fakeSiteData() };
  const settings = new ServiceSettings({
    directory: undefined,
    secrets: new SecretStore(undefined),
  });
  await settings.update({ clawde: { baseUrl: fake.url, token: fake.token } });
  const client = new ClawdeClient({ settings, version: 'test' });
  await client.meta();
  const legal = new LegalService({
    store,
    client,
    settings,
    model: siteModelSource(() => runtime),
  });
  t.after(async () => {
    await closeJigRuntime(workspace);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (method, path, payload) => {
    let out;
    await siteModelRoutes(new URL(path, 'http://127.0.0.1'), method, {
      workspace,
      dataDirectory: dataDir,
      keys: new PublicDataKeyStore(undefined, KEYS),
      settings: siteSettings,
      body: async () => payload ?? {},
      send: (status, data) => (out = { status, data }),
      context: { fetch: (...args) => services.fake.fetch(...args), now },
    });
    return out.data;
  };
  /** A computed site model: the target confirmed by the person, collected, all steps run. */
  const siteModel = async () => {
    const view = await runtime.createInstance(project.id, {
      jig: 'vide/site-model',
      title: '대지',
      layerRoot: 'VIDE::대지',
    });
    const base = `/api/v1/projects/${project.id}/jig-instances/${view.id}/site-data/site`;
    await call('PUT', `${base}/targets`, { pnus: [P1] });
    await call('POST', `${base}/collect`);
    const report = await runtime.run(project.id, view.id, { mode: 'confirmed' });
    assert.equal(report.steps.find((s) => s.id === 'summary').status, 'done');
    return { id: view.id, base, report };
  };
  return { store, workspace, project, runtime, legal, call, siteModel, services };
}

/** Asks, and when the '보낼 정보' card comes, confirms it as shown. */
async function askConfirmed(legal, projectId, question) {
  const first = await legal.askProject(projectId, { question });
  if (!first.needsConfirm) return first;
  return legal.askProject(projectId, { question, confirmSendHash: first.needsConfirm.hash });
}

test('the site model fills the profile as 모델에서 읽음; a user value stays with a notice; a recomputed model changes with 바뀐 값', async (t) => {
  const f = await setup(t);
  // No site model yet: nothing is read, nothing breaks.
  assert.deepEqual(await f.legal.syncModel(f.project.id), []);

  f.legal.updateProfile(f.project.id, {
    values: { 'site.zoning': { value: '사용자가 정한 지역' } },
  });
  const site = await f.siteModel();
  const changed = await f.legal.syncModel(f.project.id);
  const items = Object.fromEntries(f.legal.profile.items(f.project.id).map((i) => [i.key, i]));
  // 대지 요약 values with the source 'model' and the run they came from.
  assert.equal(items['site.pnu'].value, P1);
  assert.equal(items['site.pnu'].source, 'model');
  assert.match(items['site.pnu'].version, /^대지 모델 대지 · [0-9a-f]{8}$/);
  assert.equal(items['site.area'].value, 600);
  assert.equal(items['site.area'].unit, '㎡');
  assert.equal(items['model.siteArea'].value, 600);
  assert.equal(items['site.roadWidth'].value, 10);
  assert.equal(items['site.roadWidth'].unit, 'm');
  assert.match(String(items['site.roadAccess'].value), /남/);
  assert.equal(items['model.northBasis'].source, 'model');
  assert.equal(items['model.surroundingBuildings'].value, site.report.outputs.summary.buildings);
  assert.ok(changed.includes('site.area'));
  // The user's value is not replaced: the model's value is a notice.
  assert.equal(items['site.zoning'].value, '사용자가 정한 지역');
  assert.equal(items['site.zoning'].source, 'user');
  assert.equal(items['site.zoning'].notice.source, 'model');
  assert.notEqual(items['site.zoning'].notice.value, '사용자가 정한 지역');
  // Reading the same model again changes nothing.
  assert.deepEqual(await f.legal.syncModel(f.project.id), []);

  // An answer that used the area, then the site model is computed again with another 공부 면적.
  f.legal.updateProfile(f.project.id, { values: { 'site.zoning': null } });
  await f.legal.syncModel(f.project.id);
  const asked = await askConfirmed(f.legal, f.project.id, '조경 기준을 받나요?');
  assert.equal(asked.answer.stale, false);
  f.services.fake = fakeSiteData({ officialArea: 610 });
  const again = await f.call('POST', `${site.base}/collect`);
  assert.equal(again.waiting, true);
  await f.call('POST', `${site.base}/pending`, { take: true });
  await f.runtime.run(f.project.id, site.id, { mode: 'confirmed' });
  assert.deepEqual(await f.legal.syncModel(f.project.id), ['site.area']);
  const area = f.legal.profile.items(f.project.id).find((i) => i.key === 'site.area');
  assert.equal(area.value, 610);
  assert.deepEqual(
    [area.notice.replaced, area.notice.value, area.notice.source],
    [true, 600, 'model'],
  );
  assert.equal((await f.legal.get(f.project.id, asked.number)).stale, true, '다시 확인 필요');
  // The changed value is new send information: the next question shows the card again.
  const next = await f.legal.askProject(f.project.id, { question: '일조 사선 제한을 받나요?' });
  assert.ok(next.needsConfirm);
  assert.ok(next.needsConfirm.items.some((i) => i.key === 'site.area' && i.value === 610));
});

test('target chips resolve to the site-model objects by Link ID, or 모델에 없음', async (t) => {
  const f = await setup(t);
  // No site model: both targets of the answer show '모델에 없음'.
  const bare = await askConfirmed(f.legal, f.project.id, '일조 사선 제한을 받나요?');
  assert.deepEqual(
    bare.answer.targets.map((c) => [c.kind, c.label, c.found]),
    [
      ['site', '대지', false],
      ['adjacent', '인접 대지', false],
    ],
  );
  // The site model made its outline and target lot in one linked file; no lots around yet.
  const site = await f.siteModel();
  const jigs = new JigStore(f.workspace.store);
  const made = (bakeId, ids) => {
    const record = jigs.addBake(site.id, {
      bakeId,
      linkId: 'link-a',
      requestId: `req-${bakeId}`,
      runId: 'run-1',
      items: Object.fromEntries(
        ids.map((id, i) => [`${bakeId}:${i}`, { nativeId: id, state: 'jig', runId: 'run-1' }]),
      ),
    });
    jigs.updateBake(site.id, record.id, { appliedAt: now().toISOString() });
    return record;
  };
  made('outline', ['g-outline']);
  made('targets', ['g-target']);
  // A deleted object (state 'deleted') and an undone bake are not pointed at.
  const roads = jigs.addBake(site.id, {
    bakeId: 'roads',
    linkId: 'link-a',
    requestId: 'req-roads',
    runId: 'run-1',
    items: { 'road:0': { nativeId: 'g-road', state: 'jig', runId: 'run-1' } },
    baselineReadId: 'read-1',
  });
  assert.equal(roads.appliedAt, null);
  const view = await f.legal.get(f.project.id, bare.number);
  assert.deepEqual(view.targets, [
    {
      kind: 'site',
      label: '대지',
      found: true,
      objects: [{ linkId: 'link-a', nativeIds: ['g-outline', 'g-target'] }],
    },
    { kind: 'adjacent', label: '인접 대지', found: false, objects: [] },
  ]);
  // The list shows the same chips; an answer without targets has none.
  const list = await f.legal.list(f.project.id);
  assert.deepEqual(list.answers[0].targets, view.targets);
  const other = await askConfirmed(f.legal, f.project.id, '대지 안의 공지를 띄워야 하나요?');
  assert.equal(other.answer.targets, undefined);
  // The pure resolution: a road chip over an undone bake is not found.
  assert.equal(
    targetChips(['road'], { made: f.runtime.madeObjects(f.project.id, site.id) })[0].found,
    false,
  );
});

test('legal.constraints: only fully cited constraints, with 근거 조항 · 출처 표시 · 적용 여부; stale and unverified ones left out', async (t) => {
  const f = await setup(t);
  f.legal.updateProfile(f.project.id, {
    values: {
      'site.zoning': { value: '제2종일반주거지역' },
      'site.area': { value: 420, unit: '㎡' },
    },
  });
  const sun = await askConfirmed(f.legal, f.project.id, '일조 사선 제한을 받나요?');
  await askConfirmed(f.legal, f.project.id, '조경 기준을 받나요?');
  const out = await f.legal.constraints(f.project.id);
  assert.equal(out.schema, 'vide.legal.constraints@1');
  assert.deepEqual(
    out.constraints.map((c) => [c.key, c.value, c.unit, c.origin, c.applies, c.answer]),
    [
      ['sunlight.baseHeight', 10, 'm', '서비스 확정', '적용', sun.answer.ref],
      ['sunlight.setbackUpTo10m', 1.5, 'm', '서비스 확정', '적용', sun.answer.ref],
      ['sunlight.setbackRatioAbove10m', 0.5, 'ratio', '서비스 확정', '적용', sun.answer.ref],
    ],
  );
  const [first] = out.constraints;
  assert.deepEqual(first.clauses, [
    {
      ref: 'law:건축법 시행령/제86조/①',
      text: `${sun.answer.answer.citations[1].lawName} ${sun.answer.answer.citations[1].article}`,
      link: sun.answer.answer.citations[1].sourceUrl,
    },
  ]);
  assert.ok(first.clauses[0].link, 'the 원문 link');
  // 조경 has no citation with its text (shown 판단 불가): its constraint is left out with why.
  assert.deepEqual(out.left, [{ key: 'landscape.ratio', answer: 'L2', reason: '판단 불가' }]);

  // The zoning changes: the 일조 answer is '다시 확인 필요' and its constraints leave the output.
  f.legal.updateProfile(f.project.id, { values: { 'site.zoning': { value: '일반상업지역' } } });
  const stale = await f.legal.constraints(f.project.id);
  assert.deepEqual(stale.constraints, []);
  assert.ok(
    stale.left.some((l) => l.key === 'sunlight.baseHeight' && l.reason === '다시 확인 필요'),
  );

  // The pure rules: no citation text → '원문 없음'; a downgraded answer → '판단 불가'; 'draft' →
  // 서비스 해석; conditional → 판단 필요; the newest answer decides a key.
  const article = (ref, excerpt = '원문') => ({
    ref,
    lawName: '건축법',
    article: '제1조',
    title: '',
    excerpt,
    effectiveDate: '2026-01-01',
    sourceUrl: 'https://law.example.test/1',
    lawDbDate: '2026-09-01',
  });
  const view = (ref, verdict, constraints, citations = [article('law:건축법/제1조')]) => ({
    ref,
    question: 'q',
    fetchedAt: '2026-10-08T00:00:00Z',
    lawDbDate: '2026-09-01',
    stale: false,
    verdict,
    noExcerpt: citations.filter((c) => !c.excerpt).map((c) => c.ref),
    answer: { citations, constraints },
  });
  const pure = constraintsOutput([
    view('L9', 'conditional', [
      { key: 'height.max', value: 30, unit: 'm', refs: ['law:건축법/제1조'], basis: 'draft' },
    ]),
    view('L8', 'applies', [
      { key: 'height.max', value: 40, unit: 'm', refs: ['law:건축법/제1조'] },
      { key: 'setback.civil', value: 0.5, unit: 'm', refs: ['law:건축법/제2조'] },
    ]),
    view(
      'L7',
      'applies',
      [{ key: 'density.coverageRatio', value: 0.6, unit: 'ratio', refs: ['law:건축법/제3조'] }],
      [article('law:건축법/제3조', null)],
    ),
    view('L6', 'unknown', [
      { key: 'height.street', value: 20, unit: 'm', refs: ['law:건축법/제1조'] },
    ]),
  ]);
  assert.deepEqual(
    pure.constraints.map((c) => [c.key, c.value, c.origin, c.applies, c.answer]),
    [['height.max', 30, '서비스 해석', '판단 필요', 'L9']],
  );
  assert.deepEqual(
    pure.left.map((l) => [l.key, l.answer, l.reason]),
    [
      ['setback.civil', 'L8', '근거 미확인'],
      ['density.coverageRatio', 'L7', '원문 없음'],
      ['height.street', 'L6', '판단 불가'],
    ],
  );
  // '판단 필요' stays '판단 필요' in the 규제 조건 item, never 적용 or 미적용.
  const mapped = regulationsFromLegal(pure).items.find((i) => i.id === 'heightMax');
  assert.deepEqual(
    [mapped.applies, mapped.status, mapped.origin],
    ['판단 필요', '판단 필요', '서비스 해석'],
  );
});

test('vide/buildable-mass reads legal.constraints as its legal input; the person still wins', async (t) => {
  const f = await setup(t);
  provideJigOutput(f.workspace, { jig: 'vide/legal', output: 'constraints' }, (projectId) =>
    f.legal.constraints(projectId),
  );
  const mass = await f.runtime.createInstance(f.project.id, {
    jig: 'vide/buildable-mass',
    title: '가능 매스',
    layerRoot: 'VIDE::매스',
  });
  const regulations = async () => {
    const report = await f.runtime.run(f.project.id, mass.id, {
      mode: 'confirmed',
      until: 'regulations',
    });
    assert.equal(
      report.steps.find((s) => s.id === 'regulations')?.status,
      'done',
      JSON.stringify(report.steps.map((s) => [s.id, s.status, s.error])),
    );
    return report.outputs.regulations;
  };
  // No answer yet: '법규 결과 없음' is not shown as wired; the output is empty.
  let out = await regulations();
  assert.equal(out.legal.available, true);
  assert.equal(out.legal.reason, '법규 결과에 연결된 수치 제한 없음');

  await askConfirmed(f.legal, f.project.id, '일조 사선 제한을 받나요?');
  // The person left 일조 empty: the cited values and the answer's 적용 fill it, as given.
  out = await regulations();
  let item = (id) => out.items.find((i) => i.id === id);
  assert.deepEqual(
    [item('sunNearDistance').value, item('sunNearDistance').origin, item('sunNearDistance').status],
    [1.5, '서비스 확정', '확정'],
  );
  assert.match(item('sunNearDistance').basis.clause, /제86조/);
  assert.ok(item('sunNearDistance').basis.link);
  assert.equal(item('sunNearDistance').applies, '적용');
  assert.deepEqual([item('sunBaseHeight').value, item('sunRatio').value], [10, 0.5]);
  assert.deepEqual([item('sun').value, item('sun').origin], ['적용', '서비스 확정']);
  assert.deepEqual(out.differences, []);
  assert.deepEqual(out.legal.unmapped, []);

  // The person enters 일조 values of their own: theirs win, the legal values are differences, and
  // the one they left empty (비율) still comes from the legal result.
  await f.runtime.setParams(f.project.id, mass.id, {
    values: [
      { key: 'sunState', value: 'apply' },
      { key: 'sunBaseHeight', value: 12 },
      { key: 'sunNearDistance', value: 2 },
    ],
    by: 'user',
  });
  out = await regulations();
  item = (id) => out.items.find((i) => i.id === id);
  assert.deepEqual(
    [item('sunBaseHeight').value, item('sunBaseHeight').origin],
    [12, '사용자가 확정함'],
  );
  assert.equal(item('sunNearDistance').value, 2);
  assert.deepEqual([item('sunRatio').value, item('sunRatio').origin], [0.5, '서비스 확정']);
  assert.deepEqual(out.differences, [
    { id: 'sunBaseHeight', person: 12, legal: 10 },
    { id: 'sunNearDistance', person: 2, legal: 1.5 },
  ]);
});

test('profileFromSiteModel leaves out what the site model does not know', () => {
  const offers = profileFromSiteModel({
    summary: {
      pnus: ['1'],
      addresses: [''],
      officialArea_m2: null,
      computedArea_m2: 99.5,
      landCategories: '미확인',
      zones: '용도지역 미확인',
      roads: '접한 도로 없음',
      buildings: 0,
      maxHeight_m: 0,
      siteInfo: [{ summary: '{"north":"grid","convergenceDeg":-0.2,"roads":[]}' }],
    },
  });
  assert.deepEqual(
    offers.map((o) => [o.key, o.value, o.unit]),
    [
      ['site.pnu', '1', undefined],
      ['model.siteArea', 99.5, '㎡'],
      ['model.northBasis', '도북', undefined],
      ['model.convergenceDeg', -0.2, '°'],
      ['model.surroundingBuildings', 0, undefined],
    ],
  );
});
