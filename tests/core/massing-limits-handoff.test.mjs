import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { closeJigRuntime, jigRuntimeFor } from '../../src/server/jig-routes.ts';
import { complianceLimitsSchema } from '../../src/contracts/compliance.ts';
import { prepareMesh, solidMesh } from '../../src/jigs/official/compliance-kit/geometry.ts';
import { runCheck } from '../../src/jigs/official/compliance-kit/check.ts';
import { prismSolid } from '../../src/jigs/official/geometry-kit/index.ts';
import { runFixture, seedMassInstance } from '../fixtures/summary-chain.mjs';

// PLAN-48 T-238: the 건축 가능 영역·매스 output '한계' (`limitsHandoff`, buildable-mass 0.5.0) on the
// synthetic `rect` lot — the values are the earlier steps' own, the shapes pass the closed check the
// 법규 체크 uses, each band region names its 구간, and a check against it judges a box inside and a
// box over the 일조 사선. Synthetic data only; no host.

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rect = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

test('limitsHandoff moves the steps’ values into ComplianceLimits; shapes are closed', async () => {
  const report = await runFixture('buildable-mass', 'rect');
  const step = report.steps.find((s) => s.id === 'limitsHandoff');
  assert.equal(step?.status, 'done', JSON.stringify(step?.error));
  const out = report.outputs;
  const limits = complianceLimitsSchema.parse(out.limitsHandoff);
  assert.equal(limits.site.area_m2, out.site.area_m2);
  assert.equal(limits.site.northDeg, out.site.northDeg);
  assert.deepEqual(
    limits.regulations.map((r) => [r.id, r.value, r.applies, r.status]),
    out.regulations.items.map((r) => [r.id, r.value, r.applies, r.status]),
  );
  assert.equal(limits.plan.mainUse, out.plan.mainUse);
  assert.equal(limits.plan.floorHeightTypical, out.plan.floorHeightTypical);
  assert.equal(limits.plan.chosenOption, '기준 용적률', 'the chosen alternative’s title');
  assert.equal(limits.frame.linkId, null, 'a fixture read has no Link');
  const [base] = limits.variants;
  const env = out.envelope.variants[0];
  assert.deepEqual(base.heightCap, { value: env.height, items: ['heightMax'] });
  const prepared = prepareMesh(base.envelope);
  assert.equal(prepared.ok, true, prepared.reasons.join());
  const max = env.envelopes.find((e) => e.kind === 'max');
  assert.ok(Math.abs(prepared.volume - max.volume) <= 1e-6 * max.volume, 'same 최대 외피');
  assert.equal(base.envelopeVolume, max.volume);
  assert.ok(base.sunCut, '일조 금지 부피');
  assert.equal(prepareMesh(base.sunCut).ok, true, prepareMesh(base.sunCut).reasons.join());
  const road = limits.zones.find((z) => z.rule === 'roadSetback');
  assert.ok(road && road.regions.length > 0);
  assert.equal(road.regionSegments.length, road.regions.length);
  assert.ok(road.regionSegments.every((s) => s && road.segments.includes(s)));
  assert.deepEqual(
    road.regionSegments,
    out.limits.cutters.filter((c) => c.rule === 'road-setback').map((c) => c.target),
  );

  // The 법규 체크 against it: a box inside every limit, then a box over the 일조 사선.
  const model = (objects) => ({
    schema: 'vide.compliance.model@1',
    source: {
      linkId: 'l',
      documentKey: 'l',
      readId: 'r',
      revisionKey: 'k',
      readAt: '2026-10-08T00:00:00.000Z',
      toMeters: 1,
    },
    objects,
    unclassified: [],
    rolesVersion: 0,
  });
  const mass = (n, x0, y0, x1, y1, h) => ({
    objectId: uuid(n),
    layer: '건물',
    role: 'mass',
    roleSource: 'layer-rule',
    floor: null,
    use: null,
    hidden: false,
    geometryHash: null,
    shape: {
      kind: 'solid',
      mesh: solidMesh(prismSolid(rect(x0, y0, x1, y1), 0, h)),
      closed: true,
      volume: null,
    },
  });
  const settings = {
    groundLevel: 0,
    groundBasis: '시험',
    exclusionsComplete: true,
    noneParking: true,
    noneLandscape: true,
    noneOpenSpace: true,
    includeHidden: false,
  };
  const ground = { value: null, basis: null, candidate: null };
  const frame = { ...limits, frame: { ...limits.frame, linkId: 'l', documentKey: 'l' } };
  const inside = runCheck(model([mass(1, 5, 5, 15, 20, 9)]), frame, ground, settings, []);
  for (const id of ['zone:roadSetback', 'zone:civilSetback', 'sun', 'envelope', 'outside-site'])
    assert.equal(inside.items.find((i) => i.id === id)?.state, '적합', id);
  const over = runCheck(model([mass(1, 5, 5, 15, 29, 20)]), frame, ground, settings, []);
  assert.equal(over.items.find((i) => i.id === 'sun').state, '위반');
});

test('a computed instance hands over its limits with the Link the site was read from', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vide-limits-'));
  const store = new Store(join(root, 'workspace.sqlite'));
  const workspace = new Workspace(store);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  t.after(async () => {
    await closeJigRuntime(workspace);
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const project = store.createProject('한계 시험');
  const runtime = jigRuntimeFor(workspace, dataDir);
  const id = await seedMassInstance(runtime, project.id, '매스 검토 1');
  const limits = complianceLimitsSchema.parse(runtime.output(project.id, id, 'limitsHandoff'));
  assert.deepEqual(limits.frame, {
    linkId: 'link-1',
    documentKey: 'link-1',
    origin: [0, 0, 0],
    groundZ: 0,
  });
});
