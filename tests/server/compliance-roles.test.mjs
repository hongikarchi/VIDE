import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { closeJigRuntime, jigRoutes, provideJigOutput } from '../../src/server/jig-routes.ts';
import { complianceRoutes } from '../../src/server/compliance-routes.ts';
import { ComplianceRoles } from '../../src/services/compliance-roles.ts';
import { importPack, packJig } from '../../src/jigs/runtime/pack.ts';

// PLAN-48 T-237: the 법규 체크 read and classification routes with a fake Rhino — the whole document
// read (hidden objects found by a second read), records saved per document with a version, a
// changed object marked, the AI proposal (a fake answer) kept as a proposal until a person takes
// it, the `host-document` input a step reads, and remote sessions refused. No host, no user data.

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const INSTANCE = '100:200:' + randomUUID();
const DOCUMENT = 3;

function boxMesh([x0, y0, z0], [x1, y1, z1]) {
  const P = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const vertices = [];
  const indices = [];
  for (const face of faces) {
    const base = vertices.length / 3;
    for (const i of face) vertices.push(...P[i]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { vertices, indices };
}
const rectLine = (x0, y0, x1, y1, z = 0) => [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z, x0, y0, z];

/** The fake linked document: rows the fake `readLayers` lists (hidden ones only when asked). */
function fakeDocument() {
  const doc = { revision: 1, rows: new Map(), units: 'Meters' };
  const add = (layer, geometry, { attrs = {}, type = 'Brep', hidden = false } = {}) => {
    const nativeId = randomUUID();
    doc.rows.set(nativeId, { nativeId, layer, geometry, attrs, type, hidden, hash: 1 });
    return nativeId;
  };
  const model = (scope = {}) => {
    const rows = [...doc.rows.values()].filter((row) => scope.includeHidden || !row.hidden);
    return {
      objects: rows.map((row) => ({
        id: row.nativeId,
        nativeId: row.nativeId,
        kind: 'native',
        name: 'o',
        origin: [0, 0, 0],
      })),
      scene: rows.map((row) => ({
        id: row.nativeId,
        nativeId: row.nativeId,
        nativeType: row.type,
        geometryHash: row.hash.toString(16).padStart(64, '0'),
        layer64: b64(row.layer),
        attributes64: Object.entries(row.attrs).map(([k, v]) => [b64(k), b64(v)]),
        vertices: [],
        indices: [],
        line: [],
        origin: [0, 0, 0],
        ...row.geometry,
      })),
      layers: [],
      sourceDocument: {
        connection: 'attached-editor',
        instance: INSTANCE,
        documentId: DOCUMENT,
        documentHash: `rev-${doc.revision}`,
        revision: doc.revision,
        name: 'synthetic.3dm',
        units: doc.units,
        capturedAt: new Date().toISOString(),
      },
    };
  };
  return { doc, add, model };
}

/** A project jig with one `host-document` input and the limits input; its step counts roles. */
function complianceTestJig(root) {
  const dir = join(root, 'jigs', 'compliance-read-test');
  mkdirSync(join(dir, 'steps'), { recursive: true });
  writeFileSync(
    join(dir, 'jig.json'),
    JSON.stringify(
      {
        contractVersion: 3,
        id: 'project/compliance-read-test',
        version: '0.1.0',
        kind: 'tool',
        name: '법규 체크 읽기 시험',
        summary: '연결 문서를 법규 체크 역할로 읽은 결과를 세는 시험용 jig(합성 자료용).',
        icon: 'list-checks',
        inputs: [
          { key: 'model', title: '설계 모델', kind: 'host-document', host: 'rhino' },
          {
            key: 'limits',
            title: '규제 조건과 외피',
            kind: 'jig-output',
            from: { jig: 'vide/buildable-mass', output: 'limits' },
          },
        ],
        params: [],
        steps: [
          {
            id: 'count',
            title: '역할 세기',
            kind: 'code',
            entry: 'steps/count.ts#count',
            reads: ['input.model'],
            writes: 'count',
            speed: 'live',
          },
        ],
        capabilities: [
          { name: 'sync.read', reason: '연결 Rhino 문서를 읽습니다' },
          { name: 'jig.read', reason: '매스 작업본의 한계를 읽습니다' },
        ],
        panel: 'panel.json',
        selftest: { fixtures: 'fixtures', requiresHost: false },
        skill: 'skill.md',
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, 'steps', 'count.ts'),
    `export function count(inputs: { model: { objects: { role: string }[] } | null }) {
  const roles: Record<string, number> = {};
  for (const o of inputs.model?.objects ?? []) roles[o.role] = (roles[o.role] ?? 0) + 1;
  return { read: inputs.model !== null, roles };
}
`,
  );
  writeFileSync(
    join(dir, 'panel.json'),
    JSON.stringify({
      layout: 'jig-run',
      left: [{ part: 'step-rail' }],
      center: { views: [] },
    }),
  );
  mkdirSync(join(dir, 'fixtures', 'empty'), { recursive: true });
  writeFileSync(join(dir, 'fixtures', 'empty', 'input.json'), JSON.stringify({ model: null }));
  writeFileSync(join(dir, 'fixtures', 'empty', 'params.json'), '{}');
  writeFileSync(
    join(dir, 'fixtures', 'empty', 'expect.json'),
    JSON.stringify({ steps: { count: { read: false, roles: {} } } }),
  );
  writeFileSync(
    join(dir, 'skill.md'),
    '---\nname: 법규 체크 읽기 시험\nintent_en: count compliance roles\nwords: [시험]\nnot_for: [실제 검토]\ntools: []\nlimits: [시험용]\n---\n\n# 시험\n\n합성 자료만 읽는다.\n',
  );
  return dir;
}

const LIMITS = (linkId) => ({
  schema: 'vide.compliance.limits@1',
  frame: { linkId, documentKey: linkId, origin: [100, 200, 0], groundZ: 0 },
  site: {
    ring: [
      [0, 0],
      [40, 0],
      [40, 30],
      [0, 30],
    ],
    area_m2: 1200,
    areaSource: '시험 값',
    otherArea_m2: null,
    northDeg: 0,
    northSource: '시험 값',
  },
  regulations: [],
  unapplied: [],
  zones: [],
  variants: [
    {
      id: 'base',
      heightCap: null,
      sunCut: null,
      envelope: {
        v: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        f: [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2],
      },
      envelopeVolume: 1 / 6,
      unconfirmed: [],
    },
  ],
  plan: { mainUse: null, floorHeightGround: 4, floorHeightTypical: 3, chosenOption: '대안 A' },
});

async function fixture(t, { propose } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vide-compliance-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(root, 'workspace.sqlite'));
  const workspace = new Workspace(store);
  const links = new DocumentLinks(store);
  const roles = new ComplianceRoles(store, { now: () => new Date('2026-10-08T01:00:00.000Z') });
  const project = store.createProject('법규 체크 시험');
  const document = fakeDocument();
  const reads = [];
  const sdk = {
    readLayers: async (target, scope) => {
      assert.equal(target.instance, INSTANCE);
      reads.push(scope);
      return document.model(scope);
    },
    importFile: async () => assert.fail('a host link never imports'),
  };
  const asked = [];
  const proposeFn =
    propose &&
    (async (request) => {
      asked.push(request);
      return propose(request);
    });
  const call = async (method, path, payload, { remote = false } = {}) => {
    let last;
    const url = new URL(path, 'http://127.0.0.1');
    const send = (status, data) => (last = { status, data });
    try {
      const handled =
        (await complianceRoutes(url, method, {
          workspace,
          dataDirectory: dataDir,
          body: async () => payload ?? {},
          send,
          remote,
          roles,
          links,
          sdk,
          propose: proposeFn,
        })) ||
        (await jigRoutes(url, Object.assign(Readable.from([]), { method, headers: {} }), {
          workspace,
          body: async () => payload ?? {},
          send,
          dataDirectory: dataDir,
          links,
          sdk,
          remote,
        }));
      return handled ? last : { status: 0 };
    } catch (error) {
      return { status: 'error', code: error.code ?? error.message };
    }
  };
  t.after(async () => {
    await closeJigRuntime(workspace);
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const packed = await packJig(complianceTestJig(root), {
    dataDir,
    bundle: false,
    skipTests: true,
  });
  await importPack(packed.bytes, { store: new JigStore(store), dataDir });
  const link = links.link(project.id, {
    host: 'rhino',
    name: 'synthetic.3dm',
    instance: INSTANCE,
    documentId: DOCUMENT,
  });
  provideJigOutput(workspace, { jig: 'vide/buildable-mass', output: 'limits' }, () =>
    LIMITS(link.id),
  );
  const base = `/api/v1/projects/${project.id}`;
  const created = await call('POST', `${base}/jig-instances`, {
    jig: 'project/compliance-read-test',
    version: '0.1.0',
    title: '법규 체크 시험 작업본',
    layerRoot: 'VIDE::법규 체크',
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  return { project, link, document, reads, asked, call, base, iid: created.data.id, roles };
}

test('the check read classifies the whole document, keeps it as the step input, and versions records', async (t) => {
  const f = await fixture(t);
  const { document, call, base, iid, link } = f;
  const mass = document.add('건물', boxMesh([100, 200, 0], [110, 210, 12]));
  const hiddenMass = document.add('건물', boxMesh([120, 200, 0], [125, 205, 3]), { hidden: true });
  const loose = document.add(
    'Default',
    { line: rectLine(100, 220, 102.5, 225) },
    { type: 'Curve' },
  );
  const altA = document.add('VIDE::대안 매스', boxMesh([100, 200, 0], [110, 210, 4]), {
    attrs: {
      'vide-jig': 'vide/buildable-mass',
      'vide-key': 'alt:A:1F:0',
      'vide-option': '대안 A',
      'vide-floor': '1F',
    },
  });
  const altB = document.add('VIDE::대안 매스', boxMesh([100, 200, 0], [110, 210, 4]), {
    attrs: { 'vide-jig': 'vide/buildable-mass', 'vide-key': 'alt:B:1F:0', 'vide-option': '대안 B' },
  });

  // Not read yet: the step sees no model.
  const before = await call('POST', `${base}/jig-instances/${iid}/run`, { mode: 'confirmed' });
  assert.equal(before.status, 200, JSON.stringify(before));
  assert.deepEqual(before.data.outputs.count, { read: false, roles: {} });

  const first = await call('POST', `${base}/compliance/read`, { instanceId: iid });
  assert.equal(first.status, 200, JSON.stringify(first));
  // Whole document, hidden objects included, then the visible read that tells them apart.
  assert.deepEqual(f.reads.slice(-2), [{ includeHidden: true }, {}]);
  assert.equal(first.data.linkId, link.id);
  assert.equal(first.data.toMeters, 1);
  assert.equal(first.data.byRole.mass, 2);
  assert.equal(first.data.byRole.floor, 1);
  assert.equal(first.data.hiddenWithRole, 1);
  assert.equal(first.data.unusedByReason['고르지 않은 대안'], 1);
  assert.equal(first.data.unusedByReason['역할 없음'], 1);
  assert.equal(first.data.rolesVersion, 0);
  assert.equal(first.data.rows.find((r) => r.objectId === altB).reason, '고르지 않은 대안');

  // The step reads the kept ClassifiedModel; its coordinates are local to the massing frame.
  const run = await call('POST', `${base}/jig-instances/${iid}/run`, { mode: 'confirmed' });
  assert.deepEqual(run.data.outputs.count, { read: true, roles: { mass: 2, floor: 1 } });
  const reads = await call('GET', `${base}/jig-instances/${iid}/reads`);
  assert.equal(reads.data.reads.at(-1).purpose, 'check');

  // A person's records: object record with the read's fingerprint, layer record for Default.
  const put = await call('PUT', `${base}/compliance/roles`, {
    documentKey: link.id,
    instanceId: iid,
    set: [
      { scope: 'object', key: mass, role: 'mass', use: '업무시설' },
      { scope: 'layer', key: 'Default', role: 'landscape' },
    ],
  });
  assert.equal(put.status, 200, JSON.stringify(put));
  assert.equal(put.data.version, 1);
  const massRecord = put.data.records.find((r) => r.scope === 'object');
  assert.equal(massRecord.geometryHash, '1'.padStart(64, '0'));
  assert.equal(massRecord.by, 'person');

  // The object changes in Rhino: the record stays and the read marks it.
  document.doc.rows.get(mass).hash = 2;
  document.doc.revision++;
  const second = await call('POST', `${base}/compliance/read`, { instanceId: iid });
  assert.equal(second.data.rolesVersion, 1);
  assert.equal(second.data.geometryChanged, 1);
  assert.equal(second.data.byRole.landscape, 1);
  const kept = second.data.rows.find((r) => r.objectId === mass);
  assert.deepEqual([kept.roleSource, kept.geometryChanged], ['person-object', true]);
  assert.equal(second.data.rows.find((r) => r.objectId === loose).roleSource, 'person-layer');
  assert.equal(second.data.rows.find((r) => r.objectId === altA).roleSource, 'jig-tag');
  assert.equal(second.data.rows.find((r) => r.objectId === hiddenMass).hidden, true);

  // An object deleted in Rhino: its record shows as missing.
  document.doc.rows.delete(mass);
  const third = await call('POST', `${base}/compliance/read`, { instanceId: iid });
  assert.deepEqual(
    third.data.missingRecords.map((r) => r.key),
    [mass],
  );
  const removed = await call('PUT', `${base}/compliance/roles`, {
    documentKey: link.id,
    remove: [{ scope: 'object', key: mass.toUpperCase() }],
  });
  assert.equal(removed.data.version, 2);
  assert.equal(removed.data.records.length, 1);
  const view = await call('GET', `${base}/compliance/roles?documentKey=${link.id}`);
  assert.deepEqual(
    view.data.records.map((r) => r.key),
    ['Default'],
  );

  // Unknown units never fail the check read.
  document.doc.units = 'CustomUnits';
  const unknown = await call('POST', `${base}/compliance/read`, { instanceId: iid });
  assert.equal(unknown.data.toMeters, null);
  const model = await call('GET', `${base}/jig-instances/${iid}`);
  assert.equal(model.status, 200);
});

test('AI proposals stay proposals until a person takes them; gate drops what is not there', async (t) => {
  let answer = '';
  const f = await fixture(t, { propose: async () => answer });
  const { document, call, base, iid } = f;
  const stalls = [0, 1, 2, 3].map((i) =>
    document.add(
      'Default',
      { line: rectLine(100 + i * 2.5, 200, 102.5 + i * 2.5, 205) },
      { type: 'Curve' },
    ),
  );
  const tower = document.add('Layer 01', boxMesh([110, 210, 0], [130, 225, 40]));
  await call('POST', `${base}/compliance/read`, { instanceId: iid });
  answer = JSON.stringify({
    proposals: [
      { group: 'G1', role: 'parking', reason: '2.5 × 5 m 사각형 4개' },
      { layer: 'Layer 01', role: 'mass', reason: '큰 닫힌 솔리드' },
      { group: 'G7', role: 'mass' },
      { layer: 'Layer 01', role: 'pool' },
    ],
  });
  const proposed = await call('POST', `${base}/compliance/proposals`, { instanceId: iid });
  assert.equal(proposed.status, 200, JSON.stringify(proposed));
  assert.equal(f.asked.length, 1);
  const attached = f.asked[0].files[0].text;
  assert.ok(!attached.includes('225') && !attached.includes('102.5'), 'no coordinates are sent');
  assert.deepEqual(
    proposed.data.proposals.map((p) => [p.scope, p.role, p.objectIds.length, p.state]),
    [
      ['group', 'parking', 4, 'proposed'],
      ['layer', 'mass', 1, 'proposed'],
    ],
  );
  assert.deepEqual(
    proposed.data.rejected.map((r) => r.why),
    ['UNKNOWN_GROUP', 'UNKNOWN_ROLE'],
  );
  // Not taken yet: the read still has no role for them.
  const still = await call('POST', `${base}/compliance/read`, { instanceId: iid });
  assert.equal(still.data.byRole.parking, 0);
  assert.equal(still.data.rolesVersion, 0);

  const [parking, mass] = proposed.data.proposals;
  // Take the stalls but one; drop the tower proposal.
  const taken = await call('POST', `${base}/compliance/proposals/${parking.id}`, {
    action: 'accept',
    exclude: [stalls[3]],
  });
  assert.equal(taken.status, 200, JSON.stringify(taken));
  assert.equal(taken.data.proposal.state, 'accepted');
  assert.equal(taken.data.version, 1);
  assert.equal(taken.data.records.length, 3);
  assert.ok(taken.data.records.every((r) => r.by === 'ai-accepted' && r.scope === 'object'));
  const dropped = await call('POST', `${base}/compliance/proposals/${mass.id}`, {
    action: 'reject',
  });
  assert.equal(dropped.data.proposal.state, 'rejected');
  assert.equal(dropped.data.version, 1);
  const again = await call('POST', `${base}/compliance/proposals/${mass.id}`, { action: 'accept' });
  assert.equal(again.code, 'REVISION_CONFLICT');

  const after = await call('POST', `${base}/compliance/read`, { instanceId: iid });
  assert.equal(after.data.byRole.parking, 3);
  assert.equal(after.data.aiAccepted, 3);
  assert.equal(after.data.rows.find((r) => r.objectId === stalls[3]).reason, '역할 없음');
  assert.equal(after.data.rows.find((r) => r.objectId === tower).reason, '역할 없음');

  // A changed role is the person's decision: a layer proposal taken as landscape.
  answer = JSON.stringify({ proposals: [{ layer: 'Layer 01', role: 'mass', reason: '솔리드' }] });
  const next = await call('POST', `${base}/compliance/proposals`, { instanceId: iid });
  const changed = await call('POST', `${base}/compliance/proposals/${next.data.proposals[0].id}`, {
    action: 'accept',
    role: 'rooftop',
  });
  const layerRecord = changed.data.records.find((r) => r.scope === 'layer');
  assert.deepEqual(
    [layerRecord.key, layerRecord.role, layerRecord.by],
    ['Layer 01', 'rooftop', 'person'],
  );
});

test('failures: no AI answer, units unknown, nothing read, no link, remote sessions', async (t) => {
  const f = await fixture(t, {
    propose: async () => {
      throw new Error('CLI exited');
    },
  });
  const { document, call, base, iid } = f;
  document.add('Default', { line: rectLine(100, 200, 105, 205) }, { type: 'Curve' });
  assert.equal(
    (await call('POST', `${base}/compliance/proposals`, { instanceId: iid })).code,
    'COMPLIANCE_NOT_READ',
  );
  await call('POST', `${base}/compliance/read`, { instanceId: iid });
  const failed = await call('POST', `${base}/compliance/proposals`, { instanceId: iid });
  assert.deepEqual(failed.data.proposals, []);
  assert.equal(failed.data.rejected[0].why, 'AI_FAILED');

  document.doc.units = 'None';
  await call('POST', `${base}/compliance/read`, { instanceId: iid });
  assert.equal(
    (await call('POST', `${base}/compliance/proposals`, { instanceId: iid })).code,
    'COMPLIANCE_UNITS_UNKNOWN',
  );

  for (const [method, path, payload] of [
    ['POST', `${base}/compliance/read`, { instanceId: iid }],
    ['POST', `${base}/compliance/proposals`, { instanceId: iid }],
    ['PUT', `${base}/compliance/roles`, { documentKey: 'x', set: [] }],
    ['POST', `${base}/compliance/proposals/abc`, { action: 'reject' }],
  ])
    assert.equal((await call(method, path, payload, { remote: true })).code, 'FORBIDDEN', path);
  const remoteView = await call('GET', `${base}/compliance/roles?documentKey=x`, undefined, {
    remote: true,
  });
  assert.equal(remoteView.status, 200);
  assert.deepEqual(remoteView.data, { records: [], version: 0, proposals: [] });
});

test('no linked Rhino: HOST_NOT_CONNECTED', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vide-compliance-'));
  const store = new Store(join(root, 'workspace.sqlite'));
  const workspace = new Workspace(store);
  t.after(async () => {
    await closeJigRuntime(workspace);
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const project = store.createProject('연결 없음');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const packed = await packJig(complianceTestJig(root), {
    dataDir,
    bundle: false,
    skipTests: true,
  });
  await importPack(packed.bytes, { store: new JigStore(store), dataDir });
  let last;
  const send = (status, data) => (last = { status, data });
  await jigRoutes(
    new URL(`/api/v1/projects/${project.id}/jig-instances`, 'http://127.0.0.1'),
    Object.assign(Readable.from([]), { method: 'POST', headers: {} }),
    {
      workspace,
      body: async () => ({
        jig: 'project/compliance-read-test',
        version: '0.1.0',
        title: '시험',
        layerRoot: 'VIDE::법규 체크',
      }),
      send,
      dataDirectory: dataDir,
      links: new DocumentLinks(store),
    },
  );
  await assert.rejects(
    complianceRoutes(
      new URL(`/api/v1/projects/${project.id}/compliance/read`, 'http://127.0.0.1'),
      'POST',
      {
        workspace,
        dataDirectory: dataDir,
        body: async () => ({ instanceId: last.data.id }),
        send,
        remote: false,
        roles: new ComplianceRoles(store),
        links: new DocumentLinks(store),
      },
    ),
    { code: 'HOST_NOT_CONNECTED' },
  );
});
