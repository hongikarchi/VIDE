// vide/building-summary (PLAN-45 T-213, SPEC-12.13·12.14): the official 건축개요 jig on the synthetic
// chain site-model → buildable-mass → summary. Totals are checked by hand; every cell carries its
// 출처 (계산 · 공부 · 사람 입력 · 법규 결과) and empty ones say '사람 입력 필요'; a number that does not
// match its sources empties the tables to export and the report refuses to export; the CSV keeps
// SPEC-07.11's form and the exported HTML has no script and no outside request. The `jig-output`
// input reads the latest computed instance (or the chosen one), and shows '다시 계산 필요' when that
// earlier result moved. Synthetic data only; no host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigRegistry, officialJigRoot } from '../../src/jigs/runtime/loader.ts';
import { selftestJig, validateJig } from '../../src/jigs/runtime/pack.ts';
import { validateManifest } from '../../src/jigs/runtime/manifest.ts';
import { parseReportTemplate, resolveReport } from '../../src/jigs/runtime/report-format.ts';
import { closeJigRuntime, jigRoutes, jigRuntimeFor } from '../../src/server/jig-routes.ts';
import { renderJigReport } from '../../src/server/report.ts';
import { toCsv } from '../../src/ui/jig-panel/bindings.ts';
import { JIGS } from '../../src/jigs/catalog.ts';
import { check } from '../../src/jigs/official/jigs/building-summary/steps/check.ts';
import {
  CHAIN_MASS,
  CHAIN_MASS_OVERRIDES,
  CHAIN_MASS_PARAMS,
  CHAIN_SITE,
  runFixture,
  seedMassInstance,
} from '../fixtures/summary-chain.mjs';

const DIR = join(officialJigRoot(), 'building-summary');
const json = (file) => JSON.parse(readFileSync(join(DIR, file), 'utf8'));
const cell = (outputs, key) => outputs.summary.overview.find((r) => r.key === key);

test('the official jig is built in: registry, validation, self-test; J-04 and J-11 in the catalog', async () => {
  const registry = new JigRegistry({ dataDir: tmpdir() });
  const entry = (await registry.list()).find((e) => e.id === 'vide/building-summary');
  assert.equal(entry?.stage, 'official');
  assert.equal(entry?.source, 'builtin');
  assert.equal(entry?.kind, 'tool');
  assert.deepEqual(
    (await validateJig(DIR, { source: 'builtin' })).issues.filter((i) => i.level === 'error'),
    [],
  );
  const report = await selftestJig(DIR, { source: 'builtin' });
  assert.deepEqual(
    report.cases.map((c) => [c.name, c.ok]),
    [
      ['chain', true],
      ['no-site', true],
    ],
    JSON.stringify(report.cases.filter((c) => !c.ok).map((c) => [c.name, c.error, c.mismatches])),
  );
  const byCode = Object.fromEntries(JIGS.map((j) => [j.code, j]));
  assert.equal(byCode['J-04'].id, 'vide/buildable-mass');
  assert.equal(byCode['J-04'].status, 'available');
  assert.equal(byCode['J-11'].id, 'vide/building-summary');
  assert.equal(byCode['J-11'].status, 'available');
  assert.equal(new Set(JIGS.map((j) => j.code)).size, JIGS.length, 'codes stay unique');
});

test('a declared output must name an existing step', () => {
  const manifest = json('jig.json');
  const bad = validateManifest({
    ...manifest,
    outputs: [{ key: 'x', from: 'step.nowhere', schema: 'schemas/x.json' }],
  });
  assert.ok(
    bad.issues.some((i) => i.code === 'JIG_REF_MISSING' && i.path.startsWith('outputs.0')),
    JSON.stringify(bad.issues),
  );
});

test('the fixture inputs are what the chain computes now (site-model single → buildable-mass rect)', async () => {
  const mass = await CHAIN_MASS();
  const site = await CHAIN_SITE();
  assert.equal(mass.steps.find((s) => s.id === 'handoff').status, 'done');
  const input = json('fixtures/chain/input.json');
  assert.deepEqual(
    input.mass.value,
    mass.outputs.handoff,
    'node tests/fixtures/summary-chain.mjs --write',
  );
  assert.deepEqual(input.site.value, site.outputs.summary);
});

test('hand-checked overview and 층별 면적표 with the 출처 of every value', async () => {
  const { outputs, steps } = await runFixture('building-summary', 'chain');
  assert.deepEqual(
    steps.map((s) => [s.id, s.status]),
    [
      ['sources', 'done'],
      ['summary', 'done'],
      ['check', 'done'],
    ],
  );
  // 대지 20 × 30 m = 600 ㎡ (공부 and 계산 side by side, never merged).
  assert.deepEqual(
    [cell(outputs, 'site-area-record').text, cell(outputs, 'site-area-record').origin],
    ['600.00 ㎡', '공부'],
  );
  assert.deepEqual(
    [cell(outputs, 'site-area').text, cell(outputs, 'site-area').origin],
    ['600.00 ㎡', '계산'],
  );
  assert.equal(cell(outputs, 'location').origin, '공부');
  // 기준 용적률 4.0 with 1F 제외 50 ㎡: 산정 2,400 = 472.5 + 522.5 + 445.55 + 414.2 + 382.85 + 162.4,
  // 지상 2,450 = 2,400 + 50, 지하 B1 = 대지 600 (지하 이격 0), 합계 3,050.
  const floors = outputs.summary.floors.filter((f) => f.kind === 'floor');
  assert.deepEqual(
    floors.map((f) => [f.floor, f.area, f.exclusion, f.farArea]),
    [
      ['B1', 600, 0, 0],
      ['1F', 522.5, 50, 472.5],
      ['2F', 522.5, 0, 522.5],
      ['3F', 445.55, 0, 445.55],
      ['4F', 414.2, 0, 414.2],
      ['5F', 382.85, 0, 382.85],
      ['6F', 162.4, 0, 162.4],
    ],
  );
  assert.equal(
    floors.slice(1).reduce((s, f) => s + f.farArea, 0),
    472.5 + 522.5 + 445.55 + 414.2 + 382.85 + 162.4,
  );
  const value = (key) => cell(outputs, key).value;
  assert.equal(value('gfa-above'), 2450);
  assert.equal(value('gfa-below'), 600);
  assert.equal(value('gfa-total'), 3050);
  assert.equal(value('far-area'), 2400);
  assert.equal(value('building-area'), 522.5);
  assert.equal(cell(outputs, 'coverage').text, '87.08 %'); // 522.5 / 600
  assert.equal(cell(outputs, 'far').text, '400.00 %'); // 2,400 / 600
  assert.equal(value('floors-above'), 6);
  assert.equal(value('floors-below'), 1);
  assert.equal(value('height'), 21); // 4.5 + 5 × 3.3
  assert.equal(cell(outputs, 'gfa-total').py, 922.63); // 3,050 × 121/400
  // 조경 0.15 × 600 = 90 ㎡; 주차 3,050 ㎡ ÷ 150 ㎡/대 = 20.33 → 0.5 이상 올림 20대.
  assert.equal(value('landscape-legal'), 90);
  assert.equal(value('parking-legal'), 20);
  // 출처와 확정 상태: the person's 규제 조건 in the mass jig, '사람 입력 필요', 미적용.
  const legal = cell(outputs, 'coverage-legal');
  assert.deepEqual([legal.text, legal.origin, legal.status], ['60.00 %', '사람 입력', '확정']);
  assert.deepEqual(
    [cell(outputs, 'far-allowed').text, cell(outputs, 'far-allowed').origin],
    ['사람 입력 필요', '사람 입력 필요'],
  );
  assert.equal(cell(outputs, 'open-space-required').origin, '미적용');
  assert.equal(cell(outputs, 'landscape-plan').text, '사람 입력 필요');
  assert.equal(cell(outputs, 'structure').text, '철근콘크리트조');
  assert.equal(cell(outputs, 'name').text, '사람 입력 필요');
  for (const row of outputs.summary.overview)
    assert.ok(
      ['계산', '공부', '사람 입력', '법규 결과', '사람 입력 필요', '미적용'].includes(row.origin),
      `${row.item}: ${row.origin}`,
    );
  // The totals: floor rows add up to the 연면적 and the check passes.
  const total = (key) => outputs.summary.floors.find((f) => f.key === key);
  assert.equal(total('total:above').area, 2450);
  assert.equal(total('total:all').area, 3050);
  assert.equal(outputs.check.ok, true, JSON.stringify(outputs.check.mismatches));
  assert.equal(outputs.check.overview.length, outputs.summary.overview.length);
  assert.ok(outputs.check.checked > 40);
});

test('without the site summary the site cells are 사람 입력 필요 and nothing is invented', async () => {
  const { outputs } = await runFixture('building-summary', 'no-site');
  for (const key of ['location', 'zones', 'site-area-record', 'roads'])
    assert.deepEqual(
      [cell(outputs, key).text, cell(outputs, key).origin],
      ['사람 입력 필요', '사람 입력 필요'],
      key,
    );
  assert.equal(outputs.sources.siteReason, '사이트 모델링 작업본이 없습니다');
  assert.equal(outputs.check.ok, true);
});

test('a number out of line: the tables to export are emptied, the cells listed, the report refused', async () => {
  const { outputs } = await runFixture('building-summary', 'chain');
  const input = json('fixtures/chain/input.json');
  const tamper = (change) => {
    const summary = structuredClone(outputs.summary);
    change(summary);
    return check({ mass: input.mass, site: input.site, steps: { summary } });
  };
  // 연면적 3,050 → 3,051: not in the sources, its text no longer the value, the floors' sum differs.
  const total = tamper((s) => {
    s.overview.find((r) => r.key === 'gfa-total').value = 3051;
  });
  assert.equal(total.ok, false);
  assert.deepEqual(total.overview, []);
  assert.deepEqual(total.floors, []);
  assert.ok(
    total.mismatches.some((m) => m.cell === '연면적(합계)' && /출처에 없습니다/.test(m.reason)),
  );
  assert.ok(total.mismatches.some((m) => m.cell === '연면적(합계)' && m.expected === '3050'));
  // One floor 0.01 ㎡ off: that floor and the sums are listed.
  const floor = tamper((s) => {
    s.floors.find((f) => f.floor === '3F').area = 445.56;
  });
  assert.ok(floor.mismatches.some((m) => m.cell === '층별 3F 바닥면적'));
  assert.ok(floor.mismatches.some((m) => m.cell === '층별 지상 합계'));
  // Text written differently from its value.
  const text = tamper((s) => {
    s.overview.find((r) => r.key === 'far').text = '410.00 %';
  });
  assert.ok(text.mismatches.some((m) => m.cell === '용적률(계획)' && m.expected === '400.00 %'));

  const frame = parseReportTemplate(json('reports/summary.json')).template;
  assert.ok(frame, 'the report frame parses');
  const ctx = (checkOutput) => ({
    outputs: { ...outputs, check: checkOutput },
    params: {},
    final: { sources: true, summary: true, check: true },
  });
  const refused = resolveReport(frame, ctx(total));
  assert.ok(refused.exportRefused?.length, 'export refused');
  assert.match(refused.headline.text, /맞지 않아 내보내지 않습니다/);
  const fine = resolveReport(frame, ctx(outputs.check));
  assert.equal(fine.exportRefused, undefined, JSON.stringify(fine.gates));
  assert.ok(
    fine.gates.every((g) => g.ok),
    JSON.stringify(fine.gates),
  );
});

test('CSV (SPEC-07.11) and the exported HTML: BOM, headers with units, no script, no outside request', async () => {
  const { outputs } = await runFixture('building-summary', 'chain');
  const panel = json('panel.json');
  const tab = (title) => panel.drawer.tabs.find((t) => t.title === title);
  const overview = toCsv(outputs.check.overview, tab('건축개요').columns);
  assert.ok(overview.startsWith('﻿항목,세부,값,평,출처,확정 상태,근거·비고,자료\r\n'));
  assert.ok(overview.includes('연면적,합계,"3,050.00 ㎡",922.63,계산,'));
  assert.ok(overview.includes('용적률,법정(허용),사람 입력 필요,,사람 입력 필요,사람 입력 필요'));
  const floors = toCsv(outputs.check.floors, tab('층별 면적표').columns);
  const lines = floors.trimEnd().split('\r\n');
  assert.equal(
    lines[0],
    '﻿층,용도,바닥면적 (m²),산정 제외 면적 (m²),용적률 산정 포함 면적 (m²),평,비고',
  );
  assert.equal(lines.length, 1 + 10);
  assert.ok(
    lines.includes(
      '1F,업무시설,522.50,50.00,472.50,158.06,제외 근거: 필로티(합성 시험) · 용도 미검토',
    ),
  );
  assert.ok(lines.includes('합계,,3050.00,50.00,2400.00,922.63,'));

  const frame = parseReportTemplate(json('reports/summary.json')).template;
  const model = resolveReport(frame, {
    outputs,
    params: {},
    final: { sources: true, summary: true, check: true },
  });
  const html = renderJigReport(model, {
    project: '합성 프로젝트',
    instance: '건축개요 1',
    version: '건축개요 0.1.0',
    at: '2026-10-08T03:00:00Z',
  });
  assert.ok(!/<script/i.test(html));
  assert.ok(!/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html), 'no outside request');
  assert.ok(html.includes('3,050.00 ㎡'));
  assert.ok(html.includes('사람 입력 필요'));
});

test('미확정 조건 n개 and the list lead the report when the chosen alternative has open conditions', async () => {
  const mass = await runFixture('buildable-mass', 'rect', {
    params: { ...CHAIN_MASS_PARAMS, farAllowedState: 'undecided', farAllowed: 4.5 },
    overrides: CHAIN_MASS_OVERRIDES,
  });
  const handoff = mass.outputs.handoff;
  assert.ok(handoff.unconfirmed.some((u) => u.title === '허용 용적률' && u.status === '판단 필요'));
  const { chainInputs } = await import('../fixtures/summary-chain.mjs');
  const { executeSteps, EngineRunner, MemoryCache } =
    await import('../../src/jigs/runtime/runner.ts');
  const { loadJig } = await import('../../src/jigs/runtime/loader.ts');
  const { initialParams } = await import('../../src/jigs/runtime/params.ts');
  const jig = await loadJig(DIR, { source: 'builtin' });
  const runner = new EngineRunner();
  const report = await executeSteps({
    jig,
    runner,
    cache: new MemoryCache(),
    mode: 'selftest',
    inputs: chainInputs(handoff, null),
    params: initialParams(jig.manifest),
  });
  await runner.close();
  const s = report.outputs.summary;
  assert.equal(s.unconfirmedCount, handoff.unconfirmed.length);
  const far = s.overview.find((r) => r.key === 'far-allowed');
  assert.deepEqual([far.text, far.status], ['450.00 %', '판단 필요']);
  const frame = parseReportTemplate(json('reports/summary.json')).template;
  const model = resolveReport(frame, {
    outputs: report.outputs,
    params: {},
    final: { sources: true, summary: true, check: true },
  });
  assert.match(model.headline.text, new RegExp(`미확정 조건 ${s.unconfirmedCount}개`));
  assert.ok(model.unchecked.some((u) => u.includes('허용 용적률')));
});

// --- the jig-output input through the runtime ----------------------------------------------------

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'vide-building-summary-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(root, 'workspace.sqlite'));
  const workspace = new Workspace(store);
  const project = store.createProject('건축개요 시험');
  const runtime = jigRuntimeFor(workspace, dataDir);
  t.after(async () => {
    await closeJigRuntime(workspace);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (method, path, payload) => {
    let out;
    const request = Object.assign(Readable.from([]), { method, headers: {} });
    const handled = await jigRoutes(new URL(path, 'http://127.0.0.1'), request, {
      workspace,
      body: async () => payload ?? {},
      send: (status, data) => (out = { status, data }),
      dataDirectory: dataDir,
    });
    assert.ok(handled, path);
    return out.data;
  };
  return { project, runtime, call };
}

const massInstance = (f, title) => seedMassInstance(f.runtime, f.project.id, title);

test('jig-output: the latest computed instance, its source kept, 다시 계산 필요, choosing another', async (t) => {
  const f = setup(t);
  const summary = await f.runtime.createInstance(f.project.id, {
    jig: 'vide/building-summary',
    title: '건축개요 1',
    layerRoot: 'VIDE::개요',
  });
  const base = `/api/v1/projects/${f.project.id}/jig-instances/${summary.id}`;
  // Nothing to read yet: the first step says why.
  let report = await f.runtime.run(f.project.id, summary.id, { mode: 'confirmed' });
  const first = report.steps.find((s) => s.id === 'sources');
  assert.equal(first.status, 'failed');
  assert.match(first.error.message, /건축 가능 영역·매스 작업본이 없습니다/);
  // Nothing checked yet: the report says why and gives no page to save.
  const empty = await f.call('GET', `${base}/reports/summary`);
  assert.equal(empty.html, '');
  assert.ok(empty.model.exportRefused?.length);

  const massA = await massInstance(f, '매스 A');
  let state = await f.call('GET', `${base}/jig-outputs/mass`);
  assert.equal(state.ready, true);
  assert.equal(state.current.instanceId, massA);
  assert.equal(state.chosen, null);
  report = await f.runtime.run(f.project.id, summary.id, { mode: 'confirmed' });
  assert.equal(report.outputs.summary.gfaTotal, 3050);
  assert.equal(report.outputs.check.ok, true);
  assert.equal(report.outputs.sources.mass.title, '매스 A');
  assert.equal(report.outputs.sources.site, null);
  state = await f.call('GET', `${base}/jig-outputs/mass`);
  assert.equal(state.stale, false);
  assert.equal(state.used.instanceId, massA);

  // The mass jig changes (덜어 내는 방식): its handed-over result is stale → 다시 계산 필요 here.
  await f.runtime.setParams(f.project.id, massA, {
    values: [{ key: 'trimMethod', value: 'drop-floors' }],
    by: 'user',
  });
  state = await f.call('GET', `${base}/jig-outputs/mass`);
  assert.equal(state.ready, false);
  assert.equal(state.stale, true);
  assert.match(state.reason, /다시 계산 필요/);
  report = await f.runtime.run(f.project.id, summary.id, { mode: 'confirmed' });
  assert.match(report.steps.find((s) => s.id === 'sources').error.message, /다시 계산 필요/);

  // A second instance: the latest computed one is read; the person can pin the first again.
  const massB = await massInstance(f, '매스 B');
  state = await f.call('GET', `${base}/jig-outputs/mass`);
  assert.equal(state.current.instanceId, massB);
  assert.equal(state.candidates.length, 2);
  state = await f.call('PUT', `${base}/jig-outputs/mass`, { instanceId: massA });
  assert.equal(state.chosen.instanceId, massA);
  assert.equal(state.ready, false, 'the chosen one is still stale');
  await assert.rejects(f.call('PUT', `${base}/jig-outputs/mass`, { instanceId: summary.id }), {
    code: 'INVALID_INPUT',
  });
  state = await f.call('PUT', `${base}/jig-outputs/mass`, { instanceId: null });
  assert.equal(state.current.instanceId, massB);
  report = await f.runtime.run(f.project.id, summary.id, { mode: 'confirmed' });
  assert.equal(report.outputs.sources.mass.title, '매스 B');

  // The report route: exported page when the numbers agree.
  const page = await f.call('GET', `${base}/reports/summary`);
  assert.equal(page.model.exportRefused, undefined);
  assert.ok(page.html.length > 0 && !/<script/i.test(page.html));
});
