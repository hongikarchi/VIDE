// The synthetic chain of the 규모검토 jigs for the 건축개요 (PLAN-45 T-213): the site-model fixture
// `single` (a synthetic 20 × 30 m lot) → its 대지 요약, and the buildable-mass fixture `rect` (the same
// size of lot drawn in the document) → its handed-over 고른 대안, each computed by the jig's own
// steps without a host. `jigOutput` wraps a value as a `jig-output` input receives it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { officialJigRoot, loadJig } from '../../src/jigs/runtime/loader.ts';
import { applyChanges, initialParams } from '../../src/jigs/runtime/params.ts';
import { EngineRunner, executeSteps, MemoryCache } from '../../src/jigs/runtime/runner.ts';

const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Run one jig's fixture case (optionally with more settings and 수정 사항) and return its outputs. */
export async function runFixture(jigName, caseName, { params = {}, overrides = [] } = {}) {
  const dir = join(officialJigRoot(), jigName);
  const jig = await loadJig(dir, { source: 'builtin' });
  const folder = join(dir, 'fixtures', caseName);
  const values = { ...json(join(folder, 'params.json')), ...params };
  const { next } = applyChanges(
    jig.manifest,
    initialParams(jig.manifest),
    Object.entries(values).map(([key, value]) => ({ key, value })),
    { by: 'user', atPin: true },
  );
  const runner = new EngineRunner();
  try {
    const report = await executeSteps({
      jig,
      runner,
      cache: new MemoryCache(),
      mode: 'selftest',
      inputs: json(join(folder, 'input.json')),
      params: next,
      overrides: overrides.map((o, i) => ({
        id: `o${i}`,
        origin: 'table',
        by: 'user',
        at: '2026-10-08T00:00:00Z',
        ...o,
      })),
    });
    return report;
  } finally {
    await runner.close();
  }
}

/** A value as a `jig-output` input hands it to a step (ARCH-03 §8.5). */
export const jigOutput = (value, source) => ({
  source: {
    status: 'done',
    at: '2026-10-08T03:00:00.000Z',
    hash: `${source.instanceId}:${source.step}:0`,
    updatedAt: '2026-10-08T03:00:00.000Z',
    ...source,
  },
  value,
  snapshot: { hash: `${source.instanceId}:${source.step}:0` },
});

/**
 * The chain's 매스 settings on top of the `rect` case: one basement, 조경 비율, 공개공지 미적용, the
 * 주차 산정 방식 — and the person's table: 1F 제외 면적 50 ㎡ (필로티) and 업무시설 150 ㎡당 1대.
 */
export const CHAIN_MASS_PARAMS = {
  basementFloors: 1,
  landscapeRatioState: 'apply',
  landscapeRatio: 0.15,
  publicOpenSpaceState: 'none',
  parkingState: 'apply',
  parkingRounding: 'half-up',
  parkingRoundScope: 'sum',
  parkingAreaBasis: 'gross',
};
export const CHAIN_MASS_OVERRIDES = [
  {
    target: { kind: 'floor-exclusion', identity: { floor: '1F' } },
    op: 'set',
    fields: { area: 50, basis: '필로티(합성 시험)' },
  },
  {
    target: { kind: 'regulation', identity: { id: 'parkingRule', target: '업무시설' } },
    op: 'set',
    fields: { value: 150, applies: '적용', basis: { note: '합성 시험 값' } },
  },
];
export const CHAIN_MASS = () =>
  runFixture('buildable-mass', 'rect', {
    params: CHAIN_MASS_PARAMS,
    overrides: CHAIN_MASS_OVERRIDES,
  });
export const CHAIN_SITE = () => runFixture('site-model', 'single');

/** The 건축개요 inputs of the chain (`site` null → as when no site-model instance exists). */
export const chainInputs = (handoff, summary) => ({
  mass: jigOutput(handoff, {
    instanceId: 'mass-1',
    title: '매스 검토 1',
    jig: 'vide/buildable-mass',
    version: '0.3.0',
    step: 'handoff',
  }),
  site: summary
    ? jigOutput(summary, {
        instanceId: 'site-1',
        title: '대지',
        jig: 'vide/site-model',
        version: '0.2.0',
        step: 'summary',
      })
    : // No site-model instance in the project: the runtime gives null.
      null,
});

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/**
 * A buildable-mass instance of the chain in a runtime: the `rect` lot as a read of three layers
 * assembled as 대지 경계 · 도로 · 인접 대지, the chain's settings and table, computed, the choice
 * confirmed by the person and computed again — so its handed-over 고른 대안 is ready.
 */
export async function seedMassInstance(runtime, projectId, title) {
  const rect = join(officialJigRoot(), 'buildable-mass', 'fixtures', 'rect');
  const params = json(join(rect, 'params.json'));
  // 주용도 is fixed when the instance is made.
  const view = await runtime.createInstance(projectId, {
    jig: 'vide/buildable-mass',
    title,
    layerRoot: 'VIDE::매스',
    params: Object.entries({ ...params, ...CHAIN_MASS_PARAMS }).map(([key, value]) => ({
      key,
      value,
    })),
  });
  const input = json(join(rect, 'input.json')).site;
  const layer = { boundary: '대지 경계', roads: '도로', neighbors: '인접 대지' };
  const scene = Object.entries(layer).flatMap(([role, name]) =>
    input[role].rows.map((r) => ({ id: r.id, nativeId: r.id, layer64: b64(name), line: r.line })),
  );
  const read = runtime.recordRead(projectId, view.id, {
    linkId: 'link-1',
    revisionKey: 'rhino-1|1|1',
    layers: Object.values(layer),
    includeHidden: false,
    purpose: 'assembly',
    model: { scene, definitions: {} },
  });
  for (const [role, name] of Object.entries(layer))
    await runtime.setAssembly(projectId, view.id, `site.${role}`, {
      sources: [{ readId: read.id, layers: [name] }],
      confirm: true,
      by: 'user',
    });
  await runtime.setOverrides(projectId, view.id, {
    add: CHAIN_MASS_OVERRIDES.map((o, i) => ({ id: `o${i}`, origin: 'table', by: 'user', ...o })),
  });
  let report = await runtime.run(projectId, view.id, { mode: 'confirmed' });
  const confirm = report.steps.find((s) => s.id === 'confirmChoice');
  if (confirm?.status !== 'waiting') throw new Error(`고른 대안 확정 단계: ${confirm?.status}`);
  await runtime.confirmStep(projectId, view.id, 'confirmChoice', confirm.inputHash);
  report = await runtime.run(projectId, view.id, { mode: 'confirmed' });
  const handoff = report.steps.find((s) => s.id === 'handoff');
  if (handoff?.status !== 'done') throw new Error(`넘겨줄 결과: ${handoff?.status}`);
  return view.id;
}

/** Write the building-summary fixture inputs from the chain (`node tests/fixtures/summary-chain.mjs --write`). */
export async function writeChainFixtures() {
  const mass = await CHAIN_MASS();
  const site = await CHAIN_SITE();
  const root = join(officialJigRoot(), 'building-summary', 'fixtures');
  for (const [name, withSite] of [
    ['chain', true],
    ['no-site', false],
  ]) {
    mkdirSync(join(root, name), { recursive: true });
    const inputs = chainInputs(mass.outputs.handoff, withSite ? site.outputs.summary : null);
    writeFileSync(join(root, name, 'input.json'), JSON.stringify(inputs, null, 2) + '\n');
  }
}
if (process.argv.includes('--write') && resolve(process.argv[1] ?? '') === import.meta.filename)
  await writeChainFixtures();
