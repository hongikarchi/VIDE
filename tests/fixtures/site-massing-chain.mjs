// The whole 규모검토 chain in one engine (PLAN-45 T-214): `vide/site-model` on a public-data
// service (the synthetic one of tests/fixtures/site-data.mjs, or the real one with this PC's keys),
// the legal service on a cLAWde server (the fake one) reading that site model, `vide/buildable-mass`
// assembled from the site model's layers with `legal.constraints` as its `legal` input, and
// `vide/building-summary` reading both earlier results. Used by the core chain test (no host: the
// layers are the site model's bake items read back as rows), the browser chain test and the Rhino
// chain test (the layers read from a VIDE-owned Rhino). Nothing here holds a key or a response.
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { SecretStore } from '../../src/services/secrets.ts';
import { ServiceSettings } from '../../src/services/settings.ts';
import { ClawdeClient } from '../../src/services/clawde.ts';
import { LegalService } from '../../src/services/legal.ts';
import { siteModelSource } from '../../src/server/legal-model-source.ts';
import {
  closeJigRuntime,
  jigRoutes,
  jigRuntimeFor,
  provideJigOutput,
} from '../../src/server/jig-routes.ts';
import { siteModelRoutes } from '../../src/server/site-model-routes.ts';
import { SiteDataSettings } from '../../src/server/site-data-routes.ts';
import { PublicDataKeyStore } from '../../src/server/public-data-keys.ts';
import { SITE_DATA_NOTICE } from '../../src/contracts/site-data.ts';
import { extractItems } from '../../src/jigs/bake/plan.ts';
import { officialJigRoot } from '../../src/jigs/runtime/loader.ts';

const manifest = (name) =>
  JSON.parse(readFileSync(join(officialJigRoot(), name, 'jig.json'), 'utf8'));

/**
 * The 매스 settings a person types for the chain (the `rect` case's values without the 일조 ones,
 * which the legal answer gives), one basement, 조경·주차 산정 방식. Not a legal reading.
 */
export const CHAIN_PARAMS = {
  roadSetbackState: 'apply',
  roadSetback: 1,
  civilSetbackState: 'apply',
  civilSetback: 0.5,
  chamferLengthState: 'none',
  openSpaceRoadState: 'none',
  openSpaceAdjacentState: 'none',
  otherSetbackState: 'none',
  sunDatumRoad: 'across-road',
  sunDistance: 'euclidean',
  heightMaxState: 'apply',
  heightMax: 30,
  streetHeightState: 'none',
  altitudeHeightState: 'none',
  floorsMaxState: 'none',
  coverageState: 'apply',
  coverage: 0.6,
  mainUse: '업무시설',
  floorHeightGround: 4.5,
  floorHeightTypical: 3.3,
  studyHeight: 60,
  northBasis: 'true',
  segmentTolerance: 0.05,
  farBaseState: 'apply',
  farBase: 4,
  incentiveState: 'apply',
  incentiveFar: 0.5,
  chosenAlternative: 'base',
  basementFloors: 1,
  landscapeRatioState: 'apply',
  landscapeRatio: 0.15,
  publicOpenSpaceState: 'none',
  parkingState: 'apply',
  parkingRounding: 'half-up',
  parkingRoundScope: 'sum',
  parkingAreaBasis: 'gross',
};
/** The person's table: 업무시설 150 ㎡당 1대 (a test value). */
export const CHAIN_OVERRIDES = [
  {
    target: { kind: 'regulation', identity: { id: 'parkingRule', target: '업무시설' } },
    op: 'set',
    fields: { value: 150, applies: '적용', basis: { note: '합성 시험 값' } },
  },
];

/** The site model's layers as the mass jig assembles them: role → layer under the root. */
export const SITE_LAYERS = { boundary: '대상 필지', roads: '도로', neighbors: '주변 필지' };

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/**
 * The rows a read of the site model's layers gives when its bakes are made as declared (no host):
 * each `vide.bake.curves@1` item's points as a flat line, on `<root>::<layer>`.
 */
export function siteLayerRows(outputs, root) {
  const m = manifest('site-model');
  const rows = [];
  for (const id of ['targets', 'outline', 'parcels', 'roads']) {
    const decl = m.bake.find((b) => b.id === id);
    const step = decl.items.replace(/^step\./, '').split('.')[0];
    const { items, problems } = extractItems(decl, outputs[step]);
    if (problems.length) throw new Error(`${id}: ${JSON.stringify(problems)}`);
    for (const item of items) {
      const points = item.curve.points;
      rows.push({
        id: `${id}:${item.key}`,
        nativeId: `${id}:${item.key}`,
        layer64: b64(`${root}::${decl.layer}`),
        line: points.flatMap((p) => [p[0], p[1], p[2] ?? 0]),
      });
    }
  }
  return rows;
}

/**
 * One engine with the chain's services: a project, the jig runtime, the site-data routes on
 * `fetch` with `keys`, the legal service on the cLAWde at `clawde` (url, token), and
 * `legal.constraints` provided to `vide/buildable-mass`. `jigContext` adds host parts (links, sdk,
 * execution) to the jig routes. `notice: false` leaves the FR-18 notice unconfirmed.
 */
export async function chainEngine({
  root,
  keys,
  fetch,
  clawde,
  notice = true,
  jigContext = {},
  now,
}) {
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(root, 'workspace.sqlite'));
  const workspace = new Workspace(store);
  const project = store.createProject('합성 규모검토 프로젝트');
  const runtime = jigRuntimeFor(workspace, dataDir);
  const siteSettings = new SiteDataSettings(join(dataDir, 'site-data-settings.json'));
  if (notice)
    await siteSettings.update(project.id, () => ({
      confirmed: { version: SITE_DATA_NOTICE.version, at: new Date().toISOString() },
    }));
  const serviceSettings = new ServiceSettings({
    directory: undefined,
    secrets: new SecretStore(undefined),
  });
  await serviceSettings.update({ clawde: { baseUrl: clawde.url, token: clawde.token } });
  const client = new ClawdeClient({ settings: serviceSettings, version: 'test' });
  const legal = new LegalService({
    store,
    client,
    settings: serviceSettings,
    model: siteModelSource(() => runtime),
  });
  provideJigOutput(workspace, { jig: 'vide/legal', output: 'constraints' }, (projectId) =>
    legal.constraints(projectId),
  );
  const services = { fetch, keys };
  const site = async (method, path, payload) => {
    let out;
    const handled = await siteModelRoutes(new URL(path, 'http://127.0.0.1'), method, {
      workspace,
      dataDirectory: dataDir,
      keys: new PublicDataKeyStore(undefined, services.keys),
      settings: siteSettings,
      body: async () => payload ?? {},
      send: (status, data) => (out = { status, data }),
      context: { fetch: (...args) => services.fetch(...args), ...(now ? { now } : {}) },
    });
    if (!handled) throw new Error(`not a site-data route: ${path}`);
    return out.data;
  };
  const jig = async (method, path, payload) => {
    let out;
    const request = Object.assign(Readable.from([]), { method, headers: {} });
    const handled = await jigRoutes(new URL(path, 'http://127.0.0.1'), request, {
      workspace,
      body: async () => payload ?? {},
      send: (status, data) => (out = { status, data }),
      dataDirectory: dataDir,
      ...jigContext,
    });
    if (!handled) throw new Error(`not a jig route: ${path}`);
    return out;
  };
  const base = `/api/v1/projects/${project.id}/jig-instances`;
  return {
    store,
    workspace,
    project,
    runtime,
    legal,
    client,
    siteSettings,
    services,
    site,
    jig,
    base,
    dataDir,
    async close() {
      await closeJigRuntime(workspace);
      store.close();
    },
  };
}

export const stepOf = (report, id) => report.steps.find((s) => s.id === id);
export const statusOf = (report, id) => stepOf(report, id)?.status;

/** Asks, and when the '보낼 정보' card comes, confirms it as shown. */
export async function askConfirmed(legal, projectId, question) {
  const first = await legal.askProject(projectId, { question });
  if (!first.needsConfirm) return first;
  return legal.askProject(projectId, { question, confirmSendHash: first.needsConfirm.hash });
}

/**
 * A site-model instance from an address or PNUs: lookup (or the PNUs as the person's targets),
 * collect, compute, and the person's confirmation of the target lot. Returns the steps' report.
 */
export async function siteModel(f, { query, pnus, radius, layerRoot = 'VIDE::대지' } = {}) {
  const view = await f.runtime.createInstance(f.project.id, {
    jig: 'vide/site-model',
    title: '대지',
    layerRoot,
  });
  const base = `${f.base}/${view.id}/site-data/site`;
  const timings = {};
  let t = performance.now();
  if (query) {
    const found = await f.site('POST', `${base}/lookup`, { query });
    timings.lookupMs = Math.round(performance.now() - t);
    if (found.status !== 'ok') return { id: view.id, base, found, timings };
    if (pnus) await f.site('PUT', `${base}/targets`, { pnus });
  } else await f.site('PUT', `${base}/targets`, { pnus });
  if (radius !== undefined)
    await f.runtime.setParams(f.project.id, view.id, {
      values: [{ key: 'radius', value: radius }],
      by: 'user',
    });
  t = performance.now();
  const collected = await f.site('POST', `${base}/collect`);
  timings.collectMs = Math.round(performance.now() - t);
  t = performance.now();
  let report = await f.runtime.run(f.project.id, view.id, { mode: 'confirmed' });
  const confirm = stepOf(report, 'confirmTarget');
  if (confirm?.status === 'waiting') {
    await f.runtime.confirmStep(f.project.id, view.id, 'confirmTarget', confirm.inputHash);
    report = await f.runtime.run(f.project.id, view.id, { mode: 'confirmed' });
  }
  timings.computeMs = Math.round(performance.now() - t);
  return { id: view.id, base, collected, report, timings };
}

/**
 * A buildable-mass instance assembled from the site model's layers in `model` (a read: `{scene}`)
 * or from a host read (`readFrom(instanceId, layers)` → its read id), with the chain's settings and table, computed, the 고른 대안
 * confirmed by the person and computed again.
 */
export async function buildableMass(
  f,
  {
    model,
    readId,
    siteRoot = 'VIDE::대지',
    layerRoot = 'VIDE::매스',
    title = '매스 검토',
    boundary = SITE_LAYERS.boundary,
    params = {},
    readFrom,
  },
) {
  const view = await f.runtime.createInstance(f.project.id, {
    jig: 'vide/buildable-mass',
    title,
    layerRoot,
    params: Object.entries({ ...CHAIN_PARAMS, ...params }).map(([key, value]) => ({
      key,
      value,
    })),
  });
  const layers = Object.fromEntries(
    Object.entries({ ...SITE_LAYERS, boundary }).map(([role, name]) => [
      role,
      `${siteRoot}::${name}`,
    ]),
  );
  let id = readId ?? (readFrom ? await readFrom(view.id, Object.values(layers)) : undefined);
  if (!id)
    id = f.runtime.recordRead(f.project.id, view.id, {
      linkId: 'link-site',
      revisionKey: 'rhino-1|1|1',
      layers: Object.values(layers),
      includeHidden: false,
      purpose: 'assembly',
      model: { definitions: {}, ...model },
    }).id;
  for (const [role, name] of Object.entries(layers))
    await f.runtime.setAssembly(f.project.id, view.id, `site.${role}`, {
      sources: [{ readId: id, layers: [name] }],
      confirm: true,
      by: 'user',
    });
  await f.runtime.setOverrides(f.project.id, view.id, {
    add: CHAIN_OVERRIDES.map((o, i) => ({ id: `o${i}`, origin: 'table', by: 'user', ...o })),
  });
  const t = performance.now();
  let report = await f.runtime.run(f.project.id, view.id, { mode: 'confirmed' });
  const confirm = stepOf(report, 'confirmChoice');
  if (confirm?.status === 'waiting') {
    await f.runtime.confirmStep(f.project.id, view.id, 'confirmChoice', confirm.inputHash);
    report = await f.runtime.run(f.project.id, view.id, { mode: 'confirmed' });
  }
  return { id: view.id, report, computeMs: Math.round(performance.now() - t) };
}

/** A building-summary instance computed on the latest site model and mass of the project. */
export async function buildingSummary(f, { title = '건축개요' } = {}) {
  const view = await f.runtime.createInstance(f.project.id, {
    jig: 'vide/building-summary',
    title,
    layerRoot: 'VIDE::개요',
  });
  const t = performance.now();
  const report = await f.runtime.run(f.project.id, view.id, { mode: 'confirmed' });
  const computeMs = Math.round(performance.now() - t);
  const page = (await f.jig('GET', `${f.base}/${view.id}/reports/summary`)).data;
  return { id: view.id, report, page, computeMs };
}
