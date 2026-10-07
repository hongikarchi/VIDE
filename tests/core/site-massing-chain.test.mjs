// 규모검토 통합 검수 (PLAN-45 T-214, SPEC-12.1, SPEC-13.8): the three official jigs and the legal
// service in one engine, end to end on the synthetic public-data service and the fake cLAWde:
// 주소 → 대상 필지 → 대지 모델 → 법규 프로필('모델에서 읽음') → 법규 답 → `legal.constraints` →
// `vide/buildable-mass` assembled from the site model's own layers (no host: the bake items read
// back as rows) → 고른 대안 → `vide/building-summary` reading both earlier results → its page.
// Failure paths of the chain: no keys, the FR-18 notice not confirmed or turned off, an ambiguous
// address, the legal service down, open conditions carried to the summary, '다시 계산 필요' and
// the export refusal. Every value is synthetic; nothing leaves the PC.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JIGS } from '../../src/jigs/catalog.ts';
import { KEYS, P1, fakeSiteData } from '../fixtures/site-data.mjs';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';
import {
  askConfirmed,
  buildableMass,
  buildingSummary,
  chainEngine,
  siteLayerRows,
  siteModel,
  statusOf,
  stepOf,
} from '../fixtures/site-massing-chain.mjs';

let clawde;
before(async () => {
  clawde = await startFakeClawde();
});
after(() => clawde.close());
beforeEach(() => clawde.reset());

const ADDRESS = '합성시 가나구 가나동 1';

async function engine(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vide-site-massing-'));
  const fake = fakeSiteData();
  const f = await chainEngine({ root, keys: KEYS, fetch: fake.fetch, clawde, ...options });
  t.after(async () => {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { ...f, fake };
}

test('the catalog: 사이트 모델링 · 법규 · 가능 매스 · 건축개요 are available official jigs', () => {
  const byId = Object.fromEntries(JIGS.map((j) => [j.code, j]));
  for (const id of ['J-01', 'J-03', 'J-04', 'J-11'])
    assert.equal(byId[id]?.status, 'available', id);
});

test('synthetic chain: address → site model → legal → buildable mass → 건축개요 page', async (t) => {
  const f = await engine(t);
  await f.client.meta();

  // 사이트 모델링: one proposal, collected, every step computed, the person confirms the lot.
  const site = await siteModel(f, { query: ADDRESS });
  for (const id of ['candidates', 'collect', 'frame', 'roads', 'buildings', 'summary'])
    assert.equal(statusOf(site.report, id), 'done', id);
  assert.equal(statusOf(site.report, 'confirmTarget'), 'confirmed');
  assert.deepEqual(site.report.outputs.summary.pnus, [P1]);

  // 법규: the profile reads the site model; answers carry numbers with their articles.
  const read = await f.legal.syncModel(f.project.id);
  assert.ok(
    ['site.pnu', 'site.area', 'site.zoning', 'site.roadWidth'].every((k) => read.includes(k)),
  );
  const sun = await askConfirmed(f.legal, f.project.id, '일조 사선 제한을 받나요?');
  assert.equal(sun.answer.verdict, 'applies');
  await askConfirmed(f.legal, f.project.id, '조경 기준을 받나요?');
  const constraints = await f.legal.constraints(f.project.id);
  assert.deepEqual(
    constraints.constraints.map((c) => [c.key, c.value]),
    [
      ['sunlight.baseHeight', 10],
      ['sunlight.setbackUpTo10m', 1.5],
      ['sunlight.setbackRatioAbove10m', 0.5],
    ],
  );
  assert.deepEqual(constraints.left, [
    { key: 'landscape.ratio', answer: 'L2', reason: '판단 불가' },
  ]);

  // 가능 매스 from the site model's own layers: the road lot (also among 주변 필지) is the road.
  const rows = siteLayerRows(site.report.outputs, 'VIDE::대지');
  const mass = await buildableMass(f, { model: { scene: rows } });
  const out = mass.report.outputs;
  for (const id of ['site', 'regulations', 'limits', 'buildable', 'envelope', 'alternatives'])
    assert.equal(statusOf(mass.report, id), 'done', id);
  assert.equal(statusOf(mass.report, 'confirmChoice'), 'confirmed');
  assert.equal(statusOf(mass.report, 'handoff'), 'done');
  assert.deepEqual(
    out.site.segments.map((s) => `${s.id}:${s.kind}`),
    ['s0:road', 's1:adjacent', 's2:unknown', 's3:unknown'],
  );
  assert.equal(out.site.area_m2, 600);
  const item = (id) => out.regulations.items.find((i) => i.id === id);
  assert.deepEqual(
    [item('sunNearDistance').value, item('sunNearDistance').origin],
    [1.5, '서비스 확정'],
  );
  assert.match(item('sunNearDistance').basis.clause, /제86조/);
  assert.equal(item('roadSetback').origin, '사용자가 확정함');
  assert.deepEqual(out.regulations.legal.left, constraints.left);
  // Hand check (base 4.0 on 600 ㎡): 2,400 ㎡ above ground in 5 floors, 1 basement of 600 ㎡.
  const base = out.alternatives.rows.find((r) => r.id === 'base');
  assert.deepEqual([base.floorsAbove, base.farArea], [5, 2400]);

  // 건축개요: both earlier results read automatically; site cells from the site model.
  const summary = await buildingSummary(f);
  for (const id of ['sources', 'summary', 'check'])
    assert.equal(statusOf(summary.report, id), 'done', id);
  const s = summary.report.outputs.summary;
  assert.equal(summary.report.outputs.sources.site.title, '대지');
  assert.equal(summary.report.outputs.sources.mass.title, '매스 검토');
  const cell = (key) => s.overview.find((r) => r.key === key);
  assert.equal(cell('site-area-record').text, '600.00 ㎡');
  assert.match(cell('location').text, new RegExp(P1));
  assert.match(cell('zones').text, /제2종일반주거지역/);
  assert.match(cell('roads').text, /폭 최소 10.00 m/);
  assert.equal(cell('gfa-total').text, '3,000.00 ㎡');
  assert.equal(summary.report.outputs.check.ok, true);
  // Open conditions of the chain lead the report (the synthetic lot has no lots north and west).
  assert.equal(s.unconfirmedCount, 4);
  assert.match(summary.page.model.headline.text, /미확정 조건 4개/);
  assert.ok(s.unconfirmed.some((u) => /정북 쪽 구간 확인 필요/.test(u.title)));
  assert.equal(summary.page.model.exportRefused, undefined);
  assert.ok(summary.page.html.length > 0 && !/<script/i.test(summary.page.html));
  assert.ok(!/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(summary.page.html));
  // Nothing of the keys anywhere in what the chain keeps.
  const kept = JSON.stringify([site.report.outputs, out.handoff, s, summary.page.html]);
  for (const key of Object.values(KEYS)) assert.ok(!kept.includes(key), 'no key in the chain');

  // The legal input card: the service gives it (nothing to pick), current after the run.
  const legalCard = () => f.runtime.jigOutputState(f.project.id, mass.id, 'legal');
  const card = await legalCard();
  assert.deepEqual([card.service, card.ready, card.stale], [true, true, false]);
  assert.deepEqual(card.candidates, []);

  // The zoning changes: the 일조 answer is '다시 확인 필요', so `legal.constraints` moves and the
  // mass instance's legal card says '다시 계산 필요' before anything runs (VERIFY F-8).
  f.legal.updateProfile(f.project.id, { values: { 'site.zoning': { value: '일반상업지역' } } });
  assert.equal((await legalCard()).stale, true);
  // Computed again: the 일조 numbers leave, the envelope changes, the 고른 대안 waits for the
  // person again and its handed-over result is no longer current (stale, not 'done').
  const again = await f.runtime.run(f.project.id, mass.id, { mode: 'confirmed' });
  const regs = again.outputs.regulations;
  assert.equal(regs.items.find((i) => i.id === 'sunNearDistance').status, '사람 입력 필요');
  assert.ok(
    regs.legal.left.some((l) => l.key === 'sunlight.baseHeight' && l.reason === '다시 확인 필요'),
  );
  assert.equal(statusOf(again, 'confirmChoice'), 'reconfirm');
  assert.equal((await legalCard()).stale, false, 'computed on the new legal result');
  const view = await f.runtime.view(f.project.id, mass.id);
  assert.equal(view.steps.find((s) => s.id === 'handoff').status, 'stale');

  // The mass moved: the 건축개요 says '다시 계산 필요' and gives no page to save.
  const rerun = await f.runtime.run(f.project.id, summary.id, { mode: 'confirmed' });
  assert.equal(statusOf(rerun, 'sources'), 'failed');
  assert.match(stepOf(rerun, 'sources').error.message, /다시 계산 필요/);
  const refused = (await f.jig('GET', `${f.base}/${summary.id}/reports/summary`)).data;
  assert.ok(refused.model.exportRefused?.length, 'export refused');
});

test('F-9: the mass reads 정북 from the site model; a person who picks 진북·도북 overrides it', async (t) => {
  const f = await engine(t);
  await f.client.meta();
  const site = await siteModel(f, { query: ADDRESS });
  const summary = site.report.outputs.summary;
  assert.equal(summary.northBasis, 'true');
  assert.ok(Number.isFinite(summary.convergenceDeg));
  const rows = siteLayerRows(site.report.outputs, 'VIDE::대지');
  // '사이트 모델링 따름' (the default): the site model's 진북 and convergence, sign as its frame
  // (true north = +Y turned counter-clockwise by the convergence).
  const followed = await buildableMass(f, {
    model: { scene: rows },
    title: '따름',
    params: { northBasis: 'site', convergenceDeg: 3 },
  });
  const s = followed.report.outputs.site;
  assert.equal(s.northBasis, 'true');
  assert.ok(Math.abs(s.northDeg + summary.convergenceDeg) < 1e-12, `${s.northDeg}`);
  const frameNorth = site.report.outputs.frame.trueNorth;
  assert.ok(
    Math.abs(s.north[0] - frameNorth[0]) < 1e-8 && Math.abs(s.north[1] - frameNorth[1]) < 1e-8,
  );
  assert.match(s.northSource, /사이트 모델링/);
  const card = await f.runtime.jigOutputState(f.project.id, followed.id, 'siteModel');
  assert.deepEqual([card.ready, card.current.title, card.stale], [true, '대지', false]);
  // The person's choice wins: 도북 → +Y; 진북 → the typed convergence.
  const grid = await buildableMass(f, {
    model: { scene: rows },
    title: '도북',
    params: { northBasis: 'grid' },
  });
  assert.equal(grid.report.outputs.site.northDeg, 0);
  const typed = await buildableMass(f, {
    model: { scene: rows },
    title: '진북',
    params: { northBasis: 'true', convergenceDeg: 0.5 },
  });
  assert.equal(typed.report.outputs.site.northDeg, 0.5);
  assert.match(typed.report.outputs.site.northSource, /사람이 고른/);
});

test('F-7 stays as is but is named: a 일조 기준선 almost square to north is 판단 필요', async () => {
  const { limitStep, regulationStep, siteStep } =
    await import('../../src/jigs/official/massing-kit/index.ts');
  const { SITES, paramsOf } = await import('../fixtures/massing-sites.mjs');
  const rect = SITES[0];
  // The east boundary leans north by 0.001° under this north: it becomes a datum, as before.
  const params = { ...paramsOf(rect), sunDatumRoad: 'boundary', convergenceDeg: 0.001 };
  const own = rect.inputs.site;
  const s = siteStep({ site: own }, params);
  const limits = limitStep({
    site: own,
    steps: { site: s, regulations: regulationStep({}, params) },
  });
  const named = limits.unresolved.filter((u) => /정북과 거의 수직인 구간/.test(u.reason));
  assert.equal(named.length, 1);
  assert.match(named[0].reason, /^판단 필요 — /);
  assert.ok(limits.sun.datum.length >= 2, 'the near-square segment is still a datum');
});

test('no keys: the address is not looked up, a typed PNU collects nothing and the later steps wait', async (t) => {
  const f = await engine(t, { keys: {} });
  const looked = await siteModel(f, { query: ADDRESS });
  assert.equal(looked.found.status, 'no-key');
  assert.equal(f.fake.calls.length, 0);
  const typed = await siteModel(f, { pnus: [P1] });
  assert.equal(typed.collected.blocked, true);
  assert.equal(statusOf(typed.report, 'collect'), 'gate-failed');
  for (const id of ['frame', 'summary', 'make'])
    assert.equal(statusOf(typed.report, id), 'blocked');
  assert.equal(f.fake.calls.length, 0, 'no request without keys');
  // The legal profile has nothing from a model that did not compute.
  assert.deepEqual(await f.legal.syncModel(f.project.id), []);
});

test('the notice: nothing is sent before it is confirmed; a project that turned public data off is refused', async (t) => {
  const f = await engine(t, { notice: false });
  const asked = await siteModel(f, { query: ADDRESS });
  assert.ok(asked.found.needsConfirm, 'the notice card');
  assert.equal(f.fake.calls.length, 0, 'no request before the notice');
  await f.siteSettings.update(f.project.id, () => ({ off: true }));
  const off = await siteModel(f, { query: ADDRESS });
  assert.equal(off.found.off, true);
  await assert.rejects(siteModel(f, { pnus: [P1] }), { code: 'SITE_DATA_OFF' });
  assert.equal(f.fake.calls.length, 0);
});

test('an ambiguous address: a question card, no lot chosen for the person, nothing collected', async (t) => {
  const f = await engine(t);
  const found = await siteModel(f, { query: '합성시 가나구 가나로 10' });
  assert.equal(found.found.status, 'ambiguous');
  const report = await f.runtime.run(f.project.id, found.id, { mode: 'confirmed' });
  const question = report.outputs.candidates.question;
  assert.equal(question.options.length, 2);
  assert.ok(!question.options.some((o) => o.recommended));
  await assert.rejects(f.site('POST', `${found.base}/collect`), { code: 'SITE_TARGETS_MISSING' });
  assert.notEqual(statusOf(report, 'summary'), 'done');
});

test('the legal service down: the question fails with why; the mass and the 건축개요 go on with the person’s values and say what is open', async (t) => {
  const f = await engine(t);
  await f.client.meta();
  const site = await siteModel(f, { query: ADDRESS });
  clawde.control({ failStatus: 503 });
  await assert.rejects(askConfirmed(f.legal, f.project.id, '일조 사선 제한을 받나요?'), {
    code: 'SERVICE_UNAVAILABLE',
  });
  const constraints = await f.legal.constraints(f.project.id);
  assert.deepEqual([constraints.constraints, constraints.left], [[], []]);
  const mass = await buildableMass(f, {
    model: { scene: siteLayerRows(site.report.outputs, 'VIDE::대지') },
  });
  assert.equal(statusOf(mass.report, 'handoff'), 'done');
  const regs = mass.report.outputs.regulations;
  assert.equal(regs.legal.reason, '법규 결과에 연결된 수치 제한 없음');
  assert.ok(regs.needsInput.some((n) => n.id === 'sun'));
  const summary = await buildingSummary(f);
  assert.equal(summary.report.outputs.check.ok, true);
  assert.ok(
    summary.report.outputs.summary.unconfirmed.some((u) =>
      /정북 일조 적용 여부 사람 입력 필요/.test(u.title),
    ),
  );
  assert.equal(summary.page.model.exportRefused, undefined);
});

test('no mass yet: the 건축개요 says which jig to finish and refuses to export', async (t) => {
  const f = await engine(t);
  await siteModel(f, { query: ADDRESS });
  const summary = await buildingSummary(f);
  assert.equal(statusOf(summary.report, 'sources'), 'failed');
  assert.match(
    stepOf(summary.report, 'sources').error.message,
    /건축 가능 영역·매스 작업본이 없습니다/,
  );
  assert.ok(summary.page.model.exportRefused?.length);
  assert.equal(summary.page.html, '');
});
