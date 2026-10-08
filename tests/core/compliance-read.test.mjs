import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { classifiedModelSchema } from '../../src/contracts/compliance.ts';
import {
  readClassifiedModel,
  unitsToMeters,
} from '../../src/jigs/official/compliance-kit/read-model.ts';
import { LAYER_NAMES, layerRule } from '../../src/jigs/official/compliance-kit/conventions.ts';
import {
  checkComplianceRoles,
  complianceRolesRequest,
  unroledGroups,
} from '../../src/jigs/official/compliance-kit/proposals.ts';

// PLAN-48 T-237: the 법규 체크 model reader on synthetic display rows (the form the host's jig input
// read gives: metres, base64 layer and attributes). No host, no user data, no legal values.

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const SOURCE = {
  linkId: 'link-1',
  documentKey: 'link-1',
  readId: 'read-1',
  revisionKey: 'inst|1|r1',
  readAt: '2026-10-08T00:00:00.000Z',
};

/** A closed box as a render mesh: each face its own four vertices (as Rhino meshes a brep). */
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
const hashOf = (n) => n.toString(16).padStart(64, '0');
let serial = 1;
function row(layer, geometry, { attrs = {}, type = 'Brep', id = randomUUID(), hidden } = {}) {
  return {
    id,
    nativeId: id,
    nativeType: type,
    geometryHash: hashOf(serial++),
    layer64: b64(layer),
    attributes64: Object.entries(attrs).map(([k, v]) => [b64(k), b64(v)]),
    vertices: [],
    indices: [],
    line: [],
    origin: [0, 0, 0],
    ...geometry,
    ...(hidden ? { hidden: true } : {}),
  };
}
const box = (layer, a, b, options) => row(layer, boxMesh(a, b), options);
const curve = (layer, points, options) =>
  row(layer, { line: points.flat() }, { type: 'Curve', ...options });
const rect = (x0, y0, x1, y1, z = 0) => [
  [x0, y0, z],
  [x1, y0, z],
  [x1, y1, z],
  [x0, y1, z],
  [x0, y0, z],
];
const read = (rows, extra = {}) =>
  readClassifiedModel({
    rows,
    source: SOURCE,
    units: 'Meters',
    records: [],
    rolesVersion: 0,
    chosenOption: null,
    includeHidden: false,
    ...extra,
  });
const objectOf = (out, id) => out.model.objects.find((o) => o.objectId === id);
const unusedOf = (out, id) => out.model.unclassified.find((o) => o.objectId === id);

test('① role order: attribute > person object > person layer > jig tag > layer name', () => {
  const byAttr = box('건물', [0, 0, 0], [10, 10, 9], {
    attrs: { 'vide-check-role': 'rooftop', 'vide-floor': 'B1' },
  });
  const byObject = box('건물', [20, 0, 0], [30, 10, 9]);
  const byLayer = curve('기타::윤곽', rect(0, 0, 10, 10, 3));
  const byJig = box('VIDE::대안 매스', [0, 20, 0], [10, 30, 3], {
    attrs: {
      'vide-jig': 'vide/buildable-mass',
      'vide-key': 'alt:A:1F:0',
      'vide-option': '대안 A',
      'vide-floor': '1F',
    },
  });
  const jigButPerson = box('VIDE::대안 매스', [40, 0, 0], [50, 10, 3], {
    attrs: { 'vide-jig': 'vide/buildable-mass', 'vide-key': 'alt:B:1F:0', 'vide-option': '대안 B' },
  });
  const byName = box('외부::MASS', [60, 0, 0], [70, 10, 30]);
  const records = [
    {
      documentKey: 'link-1',
      scope: 'object',
      key: byObject.nativeId.toUpperCase(),
      role: 'mass',
      floor: null,
      use: '업무시설',
      by: 'person',
      at: SOURCE.readAt,
      geometryHash: byObject.geometryHash,
    },
    {
      documentKey: 'link-1',
      scope: 'layer',
      key: '기타',
      role: 'floor',
      floor: '4F',
      use: null,
      by: 'ai-accepted',
      at: SOURCE.readAt,
      geometryHash: null,
    },
    {
      documentKey: 'link-1',
      scope: 'object',
      key: jigButPerson.nativeId,
      role: 'ignore',
      floor: null,
      use: null,
      by: 'person',
      at: SOURCE.readAt,
      geometryHash: null,
    },
  ];
  const out = read([byAttr, byObject, byLayer, byJig, jigButPerson, byName], {
    records,
    chosenOption: '대안 A',
  });
  assert.deepEqual(
    [byAttr, byObject, byLayer, byJig, jigButPerson, byName].map((r) => {
      const o = objectOf(out, r.nativeId);
      return o && [o.role, o.roleSource, o.floor];
    }),
    [
      ['rooftop', 'attribute', 'B1'],
      ['mass', 'person-object', null],
      ['floor', 'ai-accepted', '4F'],
      ['floor', 'jig-tag', '1F'],
      ['ignore', 'person-object', null],
      ['mass', 'layer-rule', null],
    ],
  );
  assert.equal(objectOf(out, byObject.nativeId).use, '업무시설');
  assert.equal(objectOf(out, byObject.nativeId).geometryChanged, false);
  assert.equal(objectOf(out, byLayer.nativeId).shape.kind, 'region');
  assert.equal(objectOf(out, byLayer.nativeId).shape.z, 3);
  assert.ok(Math.abs(objectOf(out, byAttr.nativeId).shape.volume - 900) < 1e-6);
  assert.ok(classifiedModelSchema.safeParse(out.model).success);
});

test('② a millimetre document: metres in the model, raw document coordinates scaled, origin moved', () => {
  assert.equal(unitsToMeters('Millimeters'), 0.001);
  assert.equal(unitsToMeters('Feet'), 0.3048);
  const display = curve('조경', rect(100, 200, 110, 205, 0));
  const out = read([display], { units: 'Millimeters', origin: [100, 200, 0] });
  assert.equal(out.model.source.toMeters, 0.001);
  assert.deepEqual(objectOf(out, display.nativeId).shape.region.outer[0], [0, 0]);
  // The same outline in raw millimetres (a reader that takes document units).
  const raw = curve('조경', rect(100000, 200000, 110000, 205000, 0));
  const scaled = read([raw], {
    units: 'Millimeters',
    coordinates: 'document',
    origin: [100, 200, 0],
  });
  const ring = objectOf(scaled, raw.nativeId).shape.region.outer;
  assert.deepEqual(
    ring.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]),
    [
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
    ],
  );
});

test('③ an open mesh is 닫히지 않음 with its role and shape; ④ a tilted outline is 평면이 아님', () => {
  const open = box('건물', [0, 0, 0], [10, 10, 9]);
  open.indices = open.indices.slice(6); // the bottom face gone
  const tilted = curve('조경', [
    [0, 0, 0],
    [10, 0, 0.5],
    [10, 10, 0.5],
    [0, 10, 0],
    [0, 0, 0],
  ]);
  const unclosed = curve('공개공지', [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ]);
  const flat = row('건물', {
    vertices: [0, 0, 0, 5, 0, 0, 5, 5, 0, 0, 5, 0],
    indices: [0, 1, 2, 0, 2, 3],
  });
  const out = read([open, tilted, unclosed, flat]);
  assert.deepEqual(
    [open, tilted, unclosed, flat].map((r) => {
      const u = unusedOf(out, r.nativeId);
      return [u.reason, u.role, u.shape];
    }),
    [
      ['닫히지 않음', 'mass', 'open-solid'],
      ['평면이 아님', 'landscape', 'curve'],
      ['닫히지 않음', 'open-space', 'curve'],
      ['역할과 모양이 맞지 않음', 'mass', 'region'],
    ],
  );
});

test('⑤ site-model objects are context; ⑥ only the chosen alternative reads as floor', () => {
  const site = box('VIDE::주변 건물', [0, 0, 0], [10, 10, 20], {
    attrs: { 'vide-jig': 'vide/site-model', 'vide-key': 'bldg:1', 'vide-floors': '5' },
  });
  const alt = (option, floor, x) =>
    box('VIDE::대안 매스', [x, 0, 0], [x + 10, 10, 3], {
      attrs: {
        'vide-jig': 'vide/buildable-mass',
        'vide-key': `alt:${option}:${floor}:0`,
        'vide-option': option,
        'vide-floor': floor,
        'vide-use': '업무시설',
      },
    });
  const a = alt('대안 A', '1F', 0);
  const b = alt('대안 B', '1F', 20);
  const c = alt('대안 C', '1F', 40);
  const park = box('VIDE::대안 매스', [0, 0, -3], [10, 10, 0], {
    attrs: { 'vide-jig': 'vide/buildable-mass', 'vide-key': 'park:under:B1:0', 'vide-floor': 'B1' },
  });
  const out = read([site, a, b, c, park], { chosenOption: '대안 B' });
  assert.equal(unusedOf(out, site.nativeId).reason, '다른 jig의 결과');
  assert.equal(unusedOf(out, park.nativeId).reason, '다른 jig의 결과');
  assert.equal(unusedOf(out, a.nativeId).reason, '고르지 않은 대안');
  assert.equal(unusedOf(out, c.nativeId).reason, '고르지 않은 대안');
  const chosen = objectOf(out, b.nativeId);
  assert.deepEqual(
    [chosen.role, chosen.roleSource, chosen.floor, chosen.use],
    ['floor', 'jig-tag', '1F', '업무시설'],
  );
  // No alternative chosen: one in the model reads, several read none.
  const one = read([a]);
  assert.equal(objectOf(one, a.nativeId).role, 'floor');
  assert.deepEqual(one.notes, ['고른 대안 없음 · 모델의 대안 하나로 읽음']);
  const many = read([a, b]);
  assert.equal(many.model.objects.length, 0);
  assert.equal(unusedOf(many, b.nativeId).reason, '고르지 않은 대안');
});

test('⑦ layer names: the deeper step wins; two roles at one depth decide nothing', () => {
  assert.equal(layerRule('건물::주차').role, 'parking');
  assert.equal(layerRule(' Building :: 2층 ').role, 'mass');
  assert.equal(layerRule('A::slab').role, 'floor');
  assert.equal(layerRule('도면::기타').role, null);
  const table = {
    ...LAYER_NAMES,
    landscape: [...LAYER_NAMES.landscape, '녹지'],
    'open-space': ['녹지'],
  };
  assert.deepEqual(layerRule('외부::녹지', table), { role: null, depth: 1, conflict: true });
  const out = read([curve('기타::미정', rect(0, 0, 1, 1))]);
  assert.equal(out.model.unclassified[0].reason, '역할 없음');
  assert.equal(out.model.unclassified[0].role, null);
  assert.equal(out.model.unclassified[0].shape, 'region');
});

test('⑧ unknown units never fail the read; ⑨ a hidden object with a role is kept as hidden', () => {
  const mass = box('건물', [0, 0, 0], [10, 10, 9]);
  const unknown = read([mass], { units: 'CustomUnits' });
  assert.equal(unknown.model.source.toMeters, null);
  assert.equal(unknown.model.objects.length, 1);
  assert.equal(read([mass], { units: undefined }).model.source.toMeters, null);

  const hiddenMass = box('건물', [0, 0, 0], [10, 10, 9]);
  const hiddenLoose = box('기타', [20, 0, 0], [25, 5, 3]);
  const offLayer = curve('끈 레이어::조경', rect(0, 0, 3, 3));
  const out = read([hiddenMass, hiddenLoose, offLayer], {
    hiddenIds: [hiddenMass.nativeId, hiddenLoose.nativeId],
    layers: [{ fullPath: '끈 레이어', visible: false }],
  });
  assert.equal(objectOf(out, hiddenMass.nativeId).hidden, true);
  assert.equal(objectOf(out, offLayer.nativeId).hidden, true);
  assert.equal(unusedOf(out, hiddenLoose.nativeId).reason, '숨김');
  assert.equal(unusedOf(out, hiddenLoose.nativeId).shape, 'closed-solid');
  // With 숨긴 객체 포함 the loose one is simply without a role.
  const included = read([hiddenLoose], { hiddenIds: [hiddenLoose.nativeId], includeHidden: true });
  assert.equal(unusedOf(included, hiddenLoose.nativeId).reason, '역할 없음');
});

test('changed geometry, missing records, parking blocks and counts, hatch fills', () => {
  const mass = box('건물', [0, 0, 0], [10, 10, 9]);
  const stall = row(
    '주차',
    {
      block: {
        definition: randomUUID(),
        transform: [1, 0, 0, 3, 0, 1, 0, 4, 0, 0, 1, 0, 0, 0, 0, 1],
      },
    },
    { type: 'InstanceReference', attrs: { 'vide-count': '2' } },
  );
  // A hatch: its fill mesh, a 6 × 4 square with a 2 × 2 hole (eight triangles around the hole).
  const outer = [
    [0, 0, 0],
    [6, 0, 0],
    [6, 4, 0],
    [0, 4, 0],
  ];
  const inner = [
    [2, 1, 0],
    [4, 1, 0],
    [4, 3, 0],
    [2, 3, 0],
  ];
  const v = [...outer, ...inner].flat();
  const f = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  const hatch = row('조경', { vertices: v, indices: f }, { type: 'Hatch' });
  const gone = randomUUID();
  const records = [
    {
      documentKey: 'link-1',
      scope: 'object',
      key: mass.nativeId,
      role: 'mass',
      floor: null,
      use: null,
      by: 'person',
      at: SOURCE.readAt,
      geometryHash: 'f'.repeat(64),
    },
    {
      documentKey: 'link-1',
      scope: 'object',
      key: gone,
      role: 'parking',
      floor: null,
      use: null,
      by: 'person',
      at: SOURCE.readAt,
      geometryHash: null,
    },
  ];
  const out = read([mass, stall, hatch], { records });
  assert.equal(objectOf(out, mass.nativeId).geometryChanged, true);
  assert.deepEqual(
    out.missingRecords.map((r) => r.key),
    [gone],
  );
  const parking = objectOf(out, stall.nativeId);
  assert.deepEqual(
    [parking.role, parking.count, parking.shape],
    ['parking', 2, { kind: 'point', at: [3, 4, 0] }],
  );
  const region = objectOf(out, hatch.nativeId).shape.region;
  assert.equal(region.holes.length, 1);
  const area = (r) =>
    r.reduce(
      (s, p, i) => s + (p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1]),
      0,
    ) / 2;
  assert.equal(area(region.outer), 24);
  assert.equal(area(region.holes[0]), -4);
});

test('AI proposal: group summaries without coordinates, answer gate drops what is not there', () => {
  const stalls = [0, 1, 2].map((i) => curve('Default', rect(i * 2.5, 0, i * 2.5 + 2.5, 5)));
  const tower = box('Default', [100, 100, 0], [120, 115, 40]);
  const ctx = box('Layer 01', [300, 0, 0], [310, 10, 3]);
  const jig = box('VIDE::주변', [0, 50, 0], [5, 55, 3], {
    attrs: { 'vide-jig': 'vide/site-model' },
  });
  const rows = [...stalls, tower, ctx, jig];
  const out = read(rows);
  const groups = unroledGroups(out.model, out.facts);
  assert.equal(groups.length, 3);
  const stallGroup = groups.find((g) => g.count === 3);
  assert.equal(stallGroup.size, '2.5 × 5.0 m');
  assert.equal(stallGroup.kind, 'region');
  assert.ok(
    !groups.some((g) => g.objectIds.includes(jig.nativeId)),
    'another jig is never proposed',
  );
  const request = complianceRolesRequest({ groups, layers: [{ name: 'Default', count: 4 }] });
  assert.equal(request.permission, 'review');
  const attached = request.files[0].text;
  assert.ok(!attached.includes('120'), 'no coordinate goes to the AI');
  assert.ok(attached.includes('2.5 × 5.0 m'));
  const tg = groups.find((g) => g.kind === 'closed-solid' && g.layer === 'Default');
  const answer = JSON.stringify({
    proposals: [
      { group: stallGroup.id, role: 'parking', reason: '2.5 × 5 m 사각형 묶음' },
      { group: tg.id, role: 'mass', floor: '3층', reason: '큰 닫힌 솔리드' },
      { group: 'G99', role: 'mass' },
      { layer: '없는 레이어', role: 'landscape' },
      { layer: 'Layer 01', role: 'tower' },
      { layer: 'Default', role: 'ignore' },
      { role: 'mass' },
    ],
  });
  const checked = checkComplianceRoles('설명\n```json\n' + answer + '\n```', groups);
  assert.deepEqual(
    checked.proposals.map((p) => [p.scope, p.role, p.objectIds.length, p.floor]),
    [
      ['group', 'parking', 3, null],
      ['group', 'mass', 1, null],
    ],
  );
  assert.deepEqual(
    checked.rejected.map((r) => r.why),
    ['UNKNOWN_GROUP', 'UNKNOWN_LAYER', 'UNKNOWN_ROLE', 'DUPLICATE', 'NO_TARGET'],
  );
  assert.deepEqual(checkComplianceRoles('잘 모르겠습니다', groups).rejected[0].why, 'NOT_JSON');
});

test('an AI-accepted layer record never reaches jig objects or a deeper layer name (L1)', () => {
  const tower = box('Default', [0, 0, 0], [10, 10, 30]);
  const neighbour = box('Default', [20, 0, 0], [30, 10, 30], {
    attrs: { 'vide-jig': 'vide/site-model', 'vide-key': 'bldg:2' },
  });
  const garden = curve('Default::조경', rect(0, 20, 10, 30, 0));
  const record = (by) => ({
    documentKey: 'link-1',
    scope: 'layer',
    key: 'Default',
    role: 'mass',
    floor: null,
    use: null,
    by,
    at: SOURCE.readAt,
    geometryHash: null,
  });
  const ai = read([tower, neighbour, garden], { records: [record('ai-accepted')] });
  assert.deepEqual(
    [objectOf(ai, tower.nativeId).role, objectOf(ai, tower.nativeId).roleSource],
    ['mass', 'ai-accepted'],
  );
  assert.equal(unusedOf(ai, neighbour.nativeId).reason, '다른 jig의 결과');
  assert.deepEqual(
    [objectOf(ai, garden.nativeId).role, objectOf(ai, garden.nativeId).roleSource],
    ['landscape', 'layer-rule'],
  );
  // A person's layer record is the person's decision and stands above both.
  const person = read([tower, neighbour, garden], { records: [record('person')] });
  assert.equal(objectOf(person, neighbour.nativeId).roleSource, 'person-layer');
  assert.deepEqual(
    [unusedOf(person, garden.nativeId).role, unusedOf(person, garden.nativeId).reason],
    ['mass', '역할과 모양이 맞지 않음'],
  );
});

/** A rectangular ring prism with a rectangular courtyard (genus 1), outward. */
function courtyard(o, i, z0, z1) {
  const O = [
    [o[0], o[1]],
    [o[2], o[1]],
    [o[2], o[3]],
    [o[0], o[3]],
  ];
  const I = [
    [i[0], i[1]],
    [i[2], i[1]],
    [i[2], i[3]],
    [i[0], i[3]],
  ];
  const vertices = [];
  for (const z of [z0, z1]) {
    for (const p of O) vertices.push(p[0], p[1], z);
    for (const p of I) vertices.push(p[0], p[1], z);
  }
  const ob = (k) => k,
    ib = (k) => 4 + k,
    ot = (k) => 8 + k,
    it = (k) => 12 + k;
  const indices = [];
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    indices.push(ot(k), ot(j), it(j), ot(k), it(j), it(k));
    indices.push(ob(k), ib(j), ob(j), ob(k), ib(k), ib(j));
    indices.push(ob(k), ob(j), ot(j), ob(k), ot(j), ot(k));
    indices.push(ib(k), it(j), ib(j), ib(k), it(k), it(j));
  }
  return { vertices, indices };
}

test('a mass with a courtyard and a mass of two shells read as closed solids', () => {
  const ring = row('건물', courtyard([2, 10, 18, 29], [6, 14, 14, 27], 0, 12));
  const a = boxMesh([0, 0, 0], [5, 5, 5]);
  const b = boxMesh([10, 0, 0], [15, 5, 5]);
  const twin = row('건물', {
    vertices: [...a.vertices, ...b.vertices],
    indices: [...a.indices, ...b.indices.map((i) => i + a.vertices.length / 3)],
  });
  const out = read([ring, twin]);
  const r = objectOf(out, ring.nativeId);
  assert.equal(r?.role, 'mass', JSON.stringify(unusedOf(out, ring.nativeId)));
  assert.equal(r.shape.closed, true);
  assert.ok(Math.abs(r.shape.volume - (16 * 19 - 8 * 13) * 12) < 1e-6);
  const t = objectOf(out, twin.nativeId);
  assert.equal(t?.role, 'mass', JSON.stringify(unusedOf(out, twin.nativeId)));
  assert.ok(Math.abs(t.shape.volume - 250) < 1e-6);
});
