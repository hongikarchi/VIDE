import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadJig } from '../../src/jigs/runtime/loader.ts';
import { EngineRunner, MemoryCache, executeSteps } from '../../src/jigs/runtime/runner.ts';
import { initialParams } from '../../src/jigs/runtime/params.ts';
import { selftestJig, validateJig } from '../../src/jigs/runtime/pack.ts';
import { scopeOf, validatePanel } from '../../src/ui/jig-panel/spec.ts';
import { assemble } from '../../extensions/jigs/s06-frame/steps/assemble.ts';
import { diagnoseStep } from '../../extensions/jigs/s06-frame/steps/diagnose-step.ts';
import { axes } from '../../extensions/jigs/s06-frame/steps/axes.ts';
import { columns } from '../../extensions/jigs/s06-frame/steps/columns.ts';
import { footprints } from '../../extensions/jigs/s06-frame/steps/footprints.ts';
import { interference } from '../../extensions/jigs/s06-frame/steps/interference.ts';
import { chooseLines, letters } from '../../extensions/jigs/s06-frame/steps/layout.ts';
import {
  CASES,
  fixtureFiles,
  gridRot21M1,
} from '../../extensions/jigs/s06-frame/fixtures/cases.ts';
import { buildCase, roleInputs } from '../../extensions/jigs/s06-frame/fixtures/synthetic.ts';

// S-06 frame jig 0.1, steps ⓪ input assembly → ④ foundation interference (PLAN-23 T-051) on the
// synthetic fixtures only (결정 A12): the package validates, the panel binds only to declared
// steps, the layout search keeps every span (diagonals included) within the limit while listing
// what it had to give up, twin columns sit on new expansion joints, heights are floored to whole
// steps, and the interference judgement is the M0 diagnosis run on the generated caps.
const JIG = join(import.meta.dirname, '..', '..', 'extensions', 'jigs', 's06-frame');
const read = (file) => JSON.parse(readFileSync(join(JIG, file), 'utf8'));
const caseOf = (name) => CASES.find((c) => c.name === name);
const files = (name) => fixtureFiles(caseOf(name));
const close = (actual, expected, eps = 1e-3, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} ≠ ${expected}`);

/** ⓪ → ④ on a fixture's inputs, the way the runner feeds each step. */
function chain(input, params) {
  const a = assemble(input, params);
  const x = axes({ ...input, steps: { assemble: a } }, params);
  const c = columns({ ...input, steps: { axes: x, assemble: a } }, params);
  const f = footprints({ ...input, steps: { columns: c, assemble: a } }, params);
  const i = interference(
    { ...input, steps: { columns: c, footprints: f, axes: x, assemble: a } },
    params,
  );
  return { assemble: a, axes: x, columns: c, footprints: f, interference: i };
}

test('the package validates, its fixtures are current, and the panel binds only what the jig declares', async () => {
  const validation = await validateJig(JIG);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  assert.deepEqual(
    validation.issues.filter((i) => i.level === 'error'),
    [],
  );
  const manifest = read('jig.json');
  const panel = validatePanel(read('panel.json'), scopeOf(manifest));
  assert.deepEqual(panel.issues, []);
  assert.deepEqual(
    panel.spec.left.map((p) => p.part),
    ['step-rail', 'role-card', ...Array(8).fill('param-group'), 'bake-card'],
  );
  assert.equal(panel.spec.drawer.tabs.length, 12);
  // The fixture files on disk are what `cases.ts` builds (regenerate with the cases when they change).
  for (const entry of CASES) {
    const built = files(entry.name);
    assert.deepEqual(
      read(`fixtures/${entry.name}/input.json`),
      JSON.parse(JSON.stringify(built.input)),
      entry.name,
    );
    assert.deepEqual(read(`fixtures/${entry.name}/params.json`), built.params, entry.name);
    assert.deepEqual(read(`fixtures/${entry.name}/expect.json`), built.expect, entry.name);
  }
  // Generic defaults only: nothing in the manifest is a decision of the real project.
  for (const decl of manifest.params) assert.notEqual(decl.basis?.status, 'confirmed', decl.key);
});

test('⓪ assembly reads the slab, the footings and their frame, the grid, the joints and the crossings without a footing', () => {
  const { input, params } = files('grid-rot21');
  const out = assemble(input, params);
  assert.equal(out.frame.source, 'footings');
  close(out.frame.angleDeg, -21, 1e-6);
  assert.deepEqual(
    [out.existing.count, out.existing.readable, out.existing.angleDeg, out.existing.topZ],
    [6, 6, -21, -1],
  );
  close(out.existing.side_m, 2.7, 1e-3);
  close(out.slab.area_m2, 20 * 16, 1e-6);
  assert.equal(out.slab.source, 'curve');
  assert.deepEqual(
    out.grid.lines.map((l) => [l.name, l.family]),
    [
      ['X1', 'u'],
      ['X2', 'u'],
      ['X3', 'u'],
      ['Y1', 'v'],
      ['Y2', 'v'],
    ],
  );
  assert.equal(out.joints.newEJ.length, 1);
  assert.equal(out.joints.existingEJ.length, 1);
  assert.deepEqual(out.zones, { fireRoute: 1, requestedZones: 1 });
  // Five grid crossings have no footing within 1 m; X2 × Y1 sits on one.
  assert.deepEqual(out.possibleMissing.map((m) => m.grid).sort(), [
    'X1 × Y1',
    'X1 × Y2',
    'X2 × Y2',
    'X3 × Y1',
    'X3 × Y2',
  ]);
  assert.ok(out.possibleMissing.every((m) => m.nearest_m > 1));
  assert.ok(out.notes.some((n) => /모델 누락 가능/.test(n)));
  const roles = Object.fromEntries(out.roles.map((r) => [r.role, r]));
  assert.equal(roles.slab.present, true);
  assert.match(roles.existingFootings.summary, /발자국 6개/);
  assert.equal(roles.voids.present, false);
  assert.equal(roles.voids.summary, '지정하지 않음');
  // The frame can be taken from the grid lines or set by hand.
  assert.equal(assemble(input, { ...params, gridAngleSource: 'grid' }).frame.source, 'grid');
  const manual = assemble(input, { ...params, gridAngleSource: 'manual', gridAngle: 7.5 });
  assert.deepEqual([manual.frame.source, manual.frame.angleDeg], ['manual', 7.5]);
});

test('① the diagnosis step gives the M0 numbers from the assembled roles, with panel geometry', () => {
  const { input, params } = files('grid-rot21');
  const out = diagnoseStep(input, params);
  assert.deepEqual(
    [
      out.summary.columns,
      out.summary.cap.count,
      out.summary.openCut.count,
      out.summary.basin.count,
    ],
    [10, 4, 7, 2],
  );
  assert.deepEqual(
    [out.summary.spans.total, out.summary.spans.over, out.summary.curves.over],
    [12, 2, 4],
  );
  assert.ok(
    out.tables.interference.every(
      (r) => r.at.length === 3 && /불가|협의|경고|통과/.test(r.judgement),
    ),
  );
  assert.ok(out.tables.spans.every((r) => r.line.length >= 2));
  assert.equal(out.fills.capClash.length, 4);
  assert.equal(out.fills.spanOver.length, 2);
  assert.equal(out.shapes.caps.length, 10);
  assert.deepEqual(out.bands.span, [11, 12 + 1e-6]);
  // Roles left out stay '미완' rather than failing the step.
  const partial = diagnoseStep(
    { site: { columns: input.site.columns, girders: input.site.girders } },
    params,
  );
  assert.ok(partial.missing.some((m) => m.judgement === 'cap'));
  assert.equal(partial.summary.spans.over, 2);
});

test('② grid-rot21: an orthogonal grid keeps every girder, diagonals included, within 12 m with no cap on a footing', () => {
  const { input, params } = files('grid-rot21');
  const a = assemble(input, params);
  const out = axes({ ...input, steps: { assemble: a } }, params);
  assert.equal(out.chosen, 'orthogonal');
  assert.deepEqual([out.objective.spanOver, out.objective.cap, out.objective.basin], [0, 0, 0]);
  assert.equal(out.summary.columns, 6);
  assert.ok(out.spans.every((s) => s.length <= 12 + 1e-9 && s.verdict === 'pass'));
  assert.ok(
    out.spans.some((s) => s.kind === 'diagonal'),
    'cell diagonals are girders too',
  );
  assert.deepEqual(
    out.axes.map((l) => l.name),
    ['N1', 'N2', 'N3', 'N4', 'NA', 'NB'],
  );
  assert.equal(out.axes.find((l) => l.name === 'N2').existing, 'X1–X2 사이');
  assert.match(out.axes.find((l) => l.name === 'N1').existing, /X1 밖/);
  assert.ok(out.points.every((q) => /^col:N\d+-N[A-Z]+$/.test(q.key)));
  // Every column is inside the slab and outside the fire route on the right.
  const local = out.points.map((q) => q.local);
  assert.ok(local.every(([u, v]) => u >= 0.5 && u <= 18 && v >= 0.5 && v <= 15.5));
  // Alternatives: the staggered grid covers the slab too and is shown beside the chosen one.
  const ids = out.alternatives.map((x) => x.id);
  assert.ok(ids.includes('orthogonal') && ids.includes('staggered'), ids.join());
  assert.ok(out.alternatives.every((x) => !x.edgeRelaxed));
  assert.equal(out.alternatives.filter((x) => x.chosen).length, 1);
  // The person picks the pattern; the same inputs give the same result.
  const staggered = axes(
    { ...input, steps: { assemble: a } },
    { ...params, layoutPattern: 'staggered' },
  );
  assert.equal(staggered.chosen, 'staggered');
  assert.equal(staggered.objective.spanOver, 0);
  assert.ok(staggered.spans.some((s) => s.kind === 'stagger'));
  assert.ok(
    staggered.points.every((q) => /^col:N[A-Z]+-\d+$/.test(q.key) || /^col:N\d+-\d+$/.test(q.key)),
  );
  assert.deepEqual(axes({ ...input, steps: { assemble: a } }, params), out);
  // Footings read with float noise (±1 mm) keep the same lines and keys (ids-stable).
  const jittered = structuredClone(input);
  jittered.site.existingFootings.rows.forEach((row, k) => {
    row.block.transform[3] += k % 2 ? 0.001 : -0.001;
    row.block.transform[7] += k % 3 ? -0.001 : 0.001;
  });
  const again = axes({ ...jittered, steps: { assemble: assemble(jittered, params) } }, params);
  assert.deepEqual(
    again.points.map((q) => q.key),
    out.points.map((q) => q.key),
  );
  assert.deepEqual(
    again.axes.map((l) => [l.name, l.at]),
    out.axes.map((l) => [l.name, l.at]),
  );
});

test('② grid-4m-bay and priority-conflict: one-direction clearance passes; the span is kept and the caps are listed', () => {
  const bay = files('grid-4m-bay');
  const bayOut = chain(bay.input, bay.params);
  assert.deepEqual([bayOut.axes.objective.spanOver, bayOut.axes.objective.cap], [0, 0]);
  assert.ok(bayOut.axes.summary.columns >= 2);
  assert.equal(bayOut.interference.summary.cap.count, 0);
  // The drawn row of the M0 case (caps 0.15 m beside footings in one direction) is clear too.
  const drawn = diagnoseStep(bay.input, bay.params);
  assert.deepEqual([drawn.summary.cap.count, drawn.summary.openCut.count], [0, 3]);

  const conflict = files('priority-conflict');
  const out = chain(conflict.input, conflict.params);
  assert.equal(out.axes.objective.spanOver, 0, 'the span is never given up');
  assert.ok(out.axes.objective.cap > 0, 'caps on footings are unavoidable here');
  assert.deepEqual(out.axes.relaxed, ['openCut', 'cap']);
  assert.ok(out.axes.violations.some((v) => v.objective === 'cap'));
  assert.ok(out.axes.notes.some((n) => /완화 순서/.test(n)));
  assert.ok(out.axes.spans.every((s) => s.length <= 12 + 1e-9));
  // ④ judges the same caps 불가 and finds no nudge within 0.6 m; nothing is applied.
  assert.ok(out.interference.summary.cap.count > 0);
  assert.ok(out.interference.tables.nudges.length > 0);
  assert.ok(out.interference.tables.nudges.every((n) => n.to === null && n.judgement === '없음'));
  assert.ok(out.interference.tables.review.some((r) => r.kind === '파일캡'));
  assert.equal(out.interference.fills.nudges.length, 0);
});

test('③ columns: twin columns on the new joint, requested zone judged, fire route empty, heights floored to whole steps', () => {
  const { input, params } = files('grid-rot21');
  const out = chain(input, params);
  const cols = out.columns;
  assert.equal(cols.count, 10);
  assert.equal(cols.pairs.length, 2);
  for (const pair of cols.pairs) {
    assert.equal(pair.columns.length, 2);
    close(pair.spacing, 0.5 + 0.6, 1e-9, 'twin spacing = column + joint width');
    const [a, b] = pair.columns.map((key) => cols.columns.find((c) => c.key === key));
    close(Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]), 1.1, 1e-6);
    assert.equal(a.pair, pair.key);
  }
  assert.ok(
    cols.columns.every((c) => c.bottom[2] === -1),
    'bottom on the existing footing top',
  );
  const sample = cols.heights[0];
  assert.deepEqual(
    [sample.girderTop, sample.girderBottom, sample.length, sample.top, sample.gap],
    [6, 5.1, 6, 5, 0.1],
  );
  assert.deepEqual(cols.requested, [
    {
      key: 'req:req-1',
      zone: 'req-1',
      columns: 1,
      verdict: 'pass',
      judgement: '✓ 있음',
      reason: '',
    },
  ]);
  assert.deepEqual(cols.fireConflicts, []);
  const built = buildCase(gridRot21M1);
  const fireU = (p) => {
    // Back into the fixture's local frame: the fire strip is u ≥ 15.
    const [dx, dy] = [p[0] - 5000, p[1] - 3000];
    const a = (-21 * Math.PI) / 180;
    return dx * Math.cos(a) + dy * Math.sin(a);
  };
  assert.ok(
    cols.columns.every((c) => fireU(c.at) < 15),
    'no column in the fire route',
  );
  assert.ok(built.toSite);
  // A joint detail of one column with a sliding bearing keeps one column per crossing.
  const single = columns(
    { ...input, steps: { axes: out.axes, assemble: out.assemble } },
    { ...params, ejDetail: 'single' },
  );
  assert.equal(single.pairs.length, 2);
  assert.ok(single.pairs.every((p) => p.columns.length === 1 && p.spacing === 0));
  // A different step or a slab that is too low: floored lengths and '미완' with the reason.
  const half = columns(
    { ...input, steps: { axes: out.axes, assemble: out.assemble } },
    { ...params, heightStep: 0.5 },
  );
  assert.deepEqual([half.heights[0].length, half.heights[0].gap], [6, 0.1]);
  const low = columns(
    { ...input, steps: { axes: out.axes, assemble: out.assemble } },
    { ...params, topSource: 'manual', girderTopLevel: 0.5 },
  );
  assert.ok(low.columns.every((c) => c.verdict === 'incomplete' && /미완/.test(c.judgement)));
  // Overrides by stable key survive: remove one, move one, add one.
  const key = out.axes.points[0].key;
  const edited = columns({ ...input, steps: { axes: out.axes, assemble: out.assemble } }, params, [
    { target: { kind: 'column', identity: { key } }, op: 'remove', fields: {} },
    {
      target: { kind: 'column', identity: { key: out.axes.points[1].key } },
      op: 'move',
      fields: { at: [5001, 3001] },
    },
    {
      target: { kind: 'column', identity: { key: 'col:extra' } },
      op: 'add',
      fields: { at: [5002, 3002] },
    },
  ]);
  assert.equal(edited.count, cols.count);
  assert.ok(!edited.columns.some((c) => c.key === key));
  assert.equal(edited.columns.find((c) => c.key === out.axes.points[1].key).overridden, 'move');
  assert.equal(edited.columns.find((c) => c.key === 'col:extra').overridden, 'add');
});

test('foundation footprints and ④ interference: caps as blocks, common caps, joint warnings, review list', () => {
  const { input, params } = files('grid-rot21');
  const out = chain(input, params);
  const feet = out.footprints;
  assert.equal(feet.caps.length, 8);
  assert.equal(feet.caps.filter((c) => c.kind === 'common').length, 2);
  const common = feet.caps.find((c) => c.kind === 'common');
  const sides = common.polygon.map((p, i) => {
    const q = common.polygon[(i + 1) % 4];
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
  assert.deepEqual(sides.map((s) => Number(s.toFixed(3))).sort(), [2, 2, 3.1, 3.1]);
  assert.equal(feet.openCuts.length, 8);
  assert.equal(feet.existing.length, 6);
  assert.equal(feet.basin.length, 2);
  for (const cap of feet.caps) {
    const definition = feet.definitions[cap.key];
    assert.equal(definition.vertices.length, 8 * 3);
    assert.equal(definition.segments.length, 4 * 6);
  }
  const i = out.interference;
  assert.equal(i.tables.interference.length, 10);
  assert.ok(
    i.tables.interference.every((r) => r.key.startsWith('col:')),
    'rows carry the layout keys',
  );
  assert.deepEqual(
    [i.summary.cap.count, i.summary.basin.count, i.summary.spans.total, i.summary.spans.over],
    [0, 0, 9, 0],
  );
  assert.ok(i.summary.openCut.count >= 4, 'open cuts over footings are listed for consultation');
  assert.equal(i.tables.ejCross.length, 2, 'both new segments straddle the existing joint');
  assert.ok(i.tables.ejCross.every((r) => r.judgement === '! 경고' && r.left > 0 && r.right > 0));
  assert.equal(i.tables.review.filter((r) => r.kind === '모델 누락 가능').length, 5);
  assert.equal(i.tables.review.filter((r) => r.kind === '기존 E.J.').length, 2);
  assert.equal(i.tables.nudges.length, 0);
  assert.ok(i.fills.cutClash.length > 0 && i.fills.cutClash.every((f) => f.key.startsWith('col:')));
  assert.deepEqual(i.missing, []);
  // With a stricter clearance the twin caps near the joint footing become 불가 and get nudges.
  const strict = interference(
    {
      ...input,
      steps: { columns: out.columns, footprints: feet, axes: out.axes, assemble: out.assemble },
    },
    { ...params, capClearance: 1.0 },
  );
  assert.ok(strict.summary.cap.count > 0);
  assert.equal(strict.tables.nudges.length, strict.summary.cap.count);
  assert.ok(strict.tables.nudges.every((n) => n.column.startsWith('col:')));
});

test('the whole jig runs in the engine runner: the human step waits without blocking, unconfirmed roles are flagged', async () => {
  const jig = await loadJig(JIG);
  const { input, params } = files('grid-rot21');
  const changed = Object.fromEntries(
    Object.entries(initialParams(jig.manifest)).map(([key, value]) => [
      key,
      params[key] !== undefined ? { ...value, value: params[key] } : value,
    ]),
  );
  const report = await executeSteps({
    jig,
    runner: new EngineRunner(),
    cache: new MemoryCache(),
    mode: 'geometry',
    inputs: input,
    params: changed,
    assembly: {
      'site.slab': { role: 'slab', sources: [], confirmed: { by: 'user', at: 't' } },
      'site.existingFootings': { role: 'existingFootings', sources: [] },
    },
  });
  assert.deepEqual(
    report.steps.map((s) => [s.id, s.status]),
    [
      ['assemble', 'done'],
      ['confirmInputs', 'waiting'],
      ['diagnose', 'done'],
      ['girders', 'done'],
      ['axes', 'done'],
      ['cells', 'done'],
      ['columns', 'done'],
      ['beams', 'done'],
      ['footprints', 'done'],
      ['model', 'done'],
      ['interference', 'done'],
      ['analysis', 'done'],
      ['confirmAnalysis', 'waiting'],
      ['sizing', 'done'],
      ['analysisConfirmed', 'blocked'],
      ['schedule', 'done'],
      ['heights', 'done'],
      ['applySections', 'waiting'],
      ['bakePlan', 'done'],
      ['sectionsApplied', 'blocked'],
      ['bakeMembers', 'blocked'],
    ],
  );
  const flagged = report.steps
    .find((s) => s.id === 'assemble')
    .gates.find((g) => g.name === 'inputs-confirmed');
  assert.deepEqual(
    [flagged.ok, flagged.level, flagged.failed],
    [false, 'warn', ['site.existingFootings']],
  );
  assert.equal(report.blocked, false);
  assert.ok(report.steps.find((s) => s.id === 'axes').gates.find((g) => g.name === 'span-max').ok);
  assert.equal(report.outputs.columns.count, 10);
  // The self-test in the engine runner agrees with `jig:test` (child runner).
  const selftest = await selftestJig(jig, { runner: 'engine' });
  assert.equal(
    selftest.ok,
    true,
    JSON.stringify(selftest.cases.map((c) => [c.name, c.mismatches, c.error])),
  );
  assert.deepEqual(
    selftest.cases.map((c) => c.name),
    ['drawn-two-bay', 'grid-4m-bay', 'grid-rot21', 'priority-conflict'],
  );
});

test('bad input: invalid settings, unreadable footings and a self-crossing slab are refused or named, never guessed', () => {
  const { input, params } = files('grid-rot21');
  assert.throws(
    () =>
      axes({ ...input, steps: { assemble: assemble(input, params) } }, { ...params, spanMax: -1 }),
    RangeError,
  );
  assert.throws(() => columns({ ...input, steps: {} }, params), /AXES_MISSING/);
  assert.throws(() => assemble(input, { gridAngle: NaN }), RangeError);
  // A footing whose transform has NaN is left out with the reason; the rest is read.
  const broken = structuredClone(input);
  broken.site.existingFootings.rows[0].block.transform[3] = NaN;
  const out = assemble(broken, params);
  assert.deepEqual([out.existing.readable, out.existing.count], [5, 6]);
  assert.ok(
    out.roles.find((r) => r.role === 'existingFootings').reasons.some((r) => /숫자가 아닌/.test(r)),
  );
  // A bow-tie slab is not a region: assembly says so and the layout step stops with the reason.
  const bowtie = structuredClone(input);
  const [x0, y0] = [5000, 3000];
  bowtie.site.slab.rows[0].line = [
    x0,
    y0,
    6,
    x0 + 20,
    y0 + 16,
    6,
    x0 + 20,
    y0,
    6,
    x0,
    y0 + 16,
    6,
    x0,
    y0,
    6,
  ];
  const bad = assemble(bowtie, params);
  assert.equal(bad.slab, null);
  assert.ok(bad.notes.some((n) => /슬래브 경계 1개는 읽지 못했습니다/.test(n)));
  assert.throws(() => axes({ ...bowtie, steps: { assemble: bad } }, params), /SLAB_MISSING/);
  // The DP itself: no line set satisfies the spacing → null (the caller relaxes the edge).
  assert.equal(
    chooseLines([0, 10], [[0], [0]], [0, 10], { dMax: 5, edgeMax: 1, minSpacing: 3 }),
    null,
  );
  assert.deepEqual(
    chooseLines([0, 4, 8], [[1], [0], [1]], [0, 8], { dMax: 5, edgeMax: 1, minSpacing: 3 })
      .positions,
    [0, 4, 8],
  );
  assert.deepEqual([letters(0), letters(25), letters(26), letters(27)], ['A', 'Z', 'AA', 'AB']);
});

test('scale: a 60 × 40 m slab over 70 footings and three basin beams lays out in well under three seconds', () => {
  const columnsAt = [];
  const existing = [];
  for (let i = 0; i < 10; i++)
    for (let j = 0; j < 7; j++) existing.push({ at: [i * 6 + 1.3, j * 6 + 1.1] });
  const layout = {
    angleDeg: -21,
    origin: [200000, 450000],
    columnZ: [-5.5, 5.5],
    columns: columnsAt,
    girders: [],
    caps: [],
    existing,
    bands: [
      { from: [-2, 9.4], to: [62, 9.4], width: 2.0 },
      { from: [-2, 21.4], to: [62, 21.4], width: 2.0 },
      { from: [-2, 33.4], to: [62, 33.4], width: 2.0 },
    ],
    slab: [
      [-2, -2],
      [58, -2],
      [58, 38],
      [-2, 38],
    ],
    fire: [
      [
        [20, -2],
        [24, -2],
        [24, 38],
        [20, 38],
      ],
    ],
  };
  const built = buildCase(layout);
  const input = roleInputs(built, layout);
  const params = { spanMax: 12, capClearance: 0.2 };
  const start = performance.now();
  const out = chain(input, params);
  const ms = performance.now() - start;
  console.log(
    `s06 layout 60×40 m, 70 footings: ${ms.toFixed(0)} ms, ${out.axes.chosen}, columns ${out.columns.count}, cap ${out.axes.objective.cap}, spans ${out.axes.spans.length}`,
  );
  assert.ok(ms < 3000, `${ms} ms`);
  assert.equal(out.axes.objective.spanOver, 0);
  assert.ok(out.columns.count >= 20);
  assert.ok(out.axes.spans.every((s) => s.length <= 12 + 1e-9));
});
