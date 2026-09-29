import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../../extensions/jigs/s06-frame/steps/diagnose.ts';
import { diagnoseCsv } from '../../extensions/jigs/s06-frame/steps/diagnose-csv.ts';
import {
  guessRoles,
  roleRows,
  syncLayers,
} from '../../extensions/jigs/s06-frame/steps/sync-input.ts';
import {
  CAP,
  DEFINITION_ID,
  LAYERS,
  OLD,
  buildCase,
  curveSplit,
  grid4mBay,
  gridRot21,
} from '../../extensions/jigs/s06-frame/fixtures/synthetic.ts';

// S-06 M0 diagnosis (PLAN-23 T-044) on synthetic layouts only (결정 A12).
const close = (actual, expected, eps = 1e-3, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} ≠ ${expected}`);

/** Diagnosis inputs from the two synthetic Syncs, as the engine route builds them. */
function inputsOf(built, roles = Object.keys(LAYERS)) {
  const inputs = { definitions: {} };
  const home = { structure: ['columns', 'girders', 'newFootings'], civil: [] };
  for (const role of roles) {
    const document = home.structure.includes(role) ? 'structure' : 'civil';
    const { rows, definitions } = roleRows(built[document], document, [LAYERS[role]]);
    inputs[role] = rows;
    inputs.definitions[document] = { ...inputs.definitions[document], ...definitions };
  }
  return inputs;
}
/** The interference row of the column standing at local grid point `at`. */
function rowAt(output, built, at) {
  const [x, y] = built.toSite(at);
  const row = output.tables.interference.find(
    (r) => Math.hypot(r.bottom[0] - x, r.bottom[1] - y) < 1e-6,
  );
  assert.ok(row, `column at ${at}`);
  return row;
}

test('grid-rot21: real rotated footprints give the expected interference and spans', () => {
  const built = buildCase(gridRot21);
  const output = diagnose(inputsOf(built));
  const { summary, tables } = output;
  assert.deepEqual(output.missing, []);
  assert.equal(summary.columns, 10);
  assert.deepEqual(
    [summary.cap.count, summary.openCut.count, summary.basin.count],
    [4, 7, 2],
    'cap 불가 · open cut 협의 · basin 경고',
  );
  assert.equal(summary.cap.incomplete + summary.openCut.incomplete + summary.basin.incomplete, 0);

  // Hand-checked distances in the grid frame (all shapes turned −21°, footprints read from blocks).
  const c00 = rowAt(output, built, [0, 0]);
  assert.equal(c00.cap.verdict, 'forbidden');
  close(c00.cap.distance, -0.85, 1e-6, 'cap depth');
  close(c00.cap.area, 2 * 0.85, 1e-6, 'cap overlap area');
  assert.equal(c00.openCut.verdict, 'consult');
  close(c00.openCut.distance, -1.65, 1e-6);
  assert.equal(c00.verdict, 'forbidden');
  const c40 = rowAt(output, built, [4, 0]);
  assert.equal(c40.cap.verdict, 'pass');
  close(c40.cap.distance, 0.45, 1e-6);
  close(c40.openCut.distance, -0.35, 1e-6);
  assert.equal(c40.top[2], 6, 'a column drawn top → bottom keeps its top');
  assert.equal(c40.bottom[2], 0);
  const c95 = rowAt(output, built, [9.559, 0]);
  close(c95.cap.distance, Math.hypot(0.65, 0.65), 1e-6, 'corner gap');
  close(c95.openCut.distance, -0.15, 1e-6);
  const c0m = rowAt(output, built, [0, 5.559]);
  assert.equal(c0m.basin.verdict, 'warning');
  close(c0m.basin.distance, -0.15, 1e-6, 'column square into the basin beam');
  assert.equal(c0m.basin.target.layer, LAYERS.basinGirders);
  const c13m = rowAt(output, built, [13.559, 5.559]);
  assert.equal(c13m.verdict, 'pass');
  close(c13m.openCut.distance, 0.209, 1e-6);
  close(rowAt(output, built, [9.559, 0]).basin.distance, 1.391, 1e-6, 'one-direction gap');
  assert.equal(c00.footing.layer, LAYERS.newFootings);
  assert.equal(c00.cap.target.layer, LAYERS.existingFootings);

  // Spans: girders cut at column tops; diagonals count against 12 m too.
  assert.equal(summary.spans.total, 12);
  assert.equal(summary.spans.over, 2);
  assert.equal(summary.spans.overhangs, 1);
  assert.equal(summary.spans.unsupported, 0);
  close(summary.spans.max, Math.hypot(13.559, 9.559), 1e-9);
  const over = tables.spans.filter((s) => s.verdict === 'over').map((s) => s.length);
  over.sort((a, b) => a - b);
  close(over[0], 13.559, 1e-9);
  const overhang = tables.spans.find((s) => s.kind === 'overhang');
  close(overhang.length, 1.5, 1e-9);
  assert.equal(overhang.verdict, null, 'overhangs are shown, not judged');
  assert.equal(overhang.from, null);
  // The curve table is a separate reference: 4 curves are longer than 12 m, only 2 spans are.
  assert.equal(summary.curves.total, 6);
  assert.equal(summary.curves.over, 4);
  close(summary.curves.max, Math.hypot(13.559, 9.559), 1e-9);
  assert.ok(summary.curves.over !== summary.spans.over);

  // Overlays: existing footings and bands, caps and open cuts, overlap fills, long spans.
  const layer = (key) => output.overlays.find((o) => o.key === key).items;
  assert.equal(layer('s06-existing').length, 6 + 2);
  assert.equal(layer('s06-new').filter((i) => i.id.endsWith(':cap')).length, 10);
  const cuts = layer('s06-new').filter((i) => i.id.endsWith(':cut'));
  assert.equal(cuts.length, 10);
  assert.ok(cuts.every((i) => i.kind === 'polyline' && i.dashed && i.closed));
  const clash = layer('s06-clash');
  assert.ok(clash.every((i) => i.kind === 'polygon' && i.fill));
  assert.equal(clash.filter((i) => i.tone === 'ov-clash').length, 4, 'one fill per cap overlap');
  assert.deepEqual(
    clash
      .filter((i) => i.label)
      .map((i) => i.label)
      .sort(),
    [
      ...[c00, rowAt(output, built, [13.559, 0])],
      ...[
        [4, 5.559],
        [9.559, 5.559],
        [0, 5.559],
      ].map((at) => rowAt(output, built, at)),
    ]
      .map((r) => r.key)
      .sort(),
    'tags on 불가 and 경고 only',
  );
  assert.equal(layer('s06-spans').length, 2);
  assert.ok(layer('s06-spans').every((i) => i.tone === 'ng'));
  // Every row can be framed.
  for (const row of [...tables.interference, ...tables.spans, ...tables.curves])
    assert.ok(row.focus.min.every(Number.isFinite) && row.focus.max.every(Number.isFinite));
});

test('grid-4m-bay: clearing in one direction passes; a turned footing is not a bounding box', () => {
  const built = buildCase(grid4mBay);
  const output = diagnose(inputsOf(built));
  assert.equal(output.summary.cap.count, 0);
  assert.equal(output.summary.openCut.count, 3);
  assert.equal(output.summary.basin.count, 0);
  close(rowAt(output, built, [0, 0]).cap.distance, 0.15, 1e-6);
  close(rowAt(output, built, [4, 0]).cap.distance, 0.15, 1e-6);
  // Diamond (2.7 m square turned 45°) at (2.5, 2.5) from the cap centre: real gap, not −0.409.
  const turned = rowAt(output, built, [8, 0]);
  close(turned.cap.distance, (5 - 1.35 * Math.SQRT2 - 2) / Math.SQRT2, 1e-6, 'turned footing');
  assert.equal(turned.cap.verdict, 'pass');
  close(turned.openCut.distance, -(1.8 * Math.SQRT2 - (5 / Math.SQRT2 - 1.35)), 1e-6);
  close(rowAt(output, built, [4, 0]).basin.distance, 0.35, 1e-6);
  assert.equal(output.summary.spans.total, 2);
  assert.equal(output.summary.spans.over, 0);

  // A stricter clearance turns the 0.15 m gaps into 불가; '불가' for open cuts on request.
  const strict = diagnose(inputsOf(built), {
    capClearance: 0.2,
    openCutRule: 'forbid',
    spanmax: 3, // unknown key: neither applied nor echoed
  });
  assert.equal(strict.summary.cap.count, 2);
  assert.equal(rowAt(strict, built, [0, 0]).openCut.verdict, 'forbidden');
  assert.equal(strict.summary.spans.over, 0);
  assert.deepEqual(Object.keys(strict.params).sort(), Object.keys(output.params).sort());
  // A cap inside the clearance without touching is outlined and tagged; nothing to fill.
  const near = rowAt(strict, built, [0, 0]);
  assert.equal(near.cap.overlaps, 0);
  const marks = strict.overlays
    .find((o) => o.key === 's06-clash')
    .items.filter((i) => i.id.startsWith(`${near.key}:cap`));
  assert.equal(marks.length, 1);
  assert.equal(marks[0].kind, 'polyline');
  assert.equal(marks[0].closed, true);
  assert.equal(marks[0].tone, 'ov-clash');
  assert.equal(marks[0].label, near.key);
});

test('footprints drawn edge to edge touch: a sub-micrometre overlap is not 불가', () => {
  // Sync rounds coordinates to 1 µm; on real S-06 data one cap read 0.1 µm into a footing.
  const reach = (CAP.size + OLD.size) / 2;
  const built = buildCase({
    angleDeg: -22,
    origin: [6000, 2000],
    columnZ: [0, 6],
    columns: [{ at: [0, 0] }, { at: [10, 0] }, { at: [20, 0] }],
    girders: [
      [
        [0, 0],
        [20, 0],
      ],
    ],
    existing: [
      { at: [reach - 2e-7, 0] },
      { at: [10 + reach + 2e-7, 0] },
      { at: [20 + reach - 5e-5, 0] },
    ],
    bands: [],
  });
  const output = diagnose(inputsOf(built));
  for (const at of [
    [0, 0],
    [10, 0],
  ]) {
    const row = rowAt(output, built, at);
    assert.equal(row.cap.verdict, 'pass', `touching at ${at}`);
    assert.equal(row.cap.distance, 0);
    assert.equal(row.cap.overlaps, 0);
    assert.equal(row.cap.area, 0);
  }
  const into = rowAt(output, built, [20, 0]);
  assert.equal(into.cap.verdict, 'forbidden', 'a 0.05 mm overlap is still one');
  close(into.cap.distance, -5e-5, 1e-9);
  const caps = output.overlays
    .find((o) => o.key === 's06-clash')
    .items.filter((i) => i.id.includes(':cap'));
  assert.deepEqual(
    caps.map((i) => i.id.split(':')[0]),
    [into.key],
  );
});

test('girders are cut at column tops within the plan tolerance; spans are plan lengths', () => {
  const built = buildCase(curveSplit);
  const output = diagnose(inputsOf(built, ['columns', 'girders']));
  // Girder keys follow plan order (by the curve's middle): the arch comes first.
  const [archKey, straightKey] = output.tables.curves.map((c) => c.key);
  const straight = output.tables.spans.filter((s) => s.girderKey === straightKey);
  const arch = output.tables.spans.filter((s) => s.girderKey === archKey);
  // Stations at 0, 6 (0.29 m off), 12 and the end (0.25 m past it); 9 (0.31 m off) is not one.
  assert.deepEqual(
    straight.map((s) => s.kind),
    ['overhang', 'span', 'span', 'span'],
  );
  straight.forEach((s, k) => close(s.length, [2, 6, 6, 4][k], 1e-9, `piece ${k}`));
  close(straight[2].length3d, 2 + Math.hypot(4, 0.5), 1e-9, 'sloped part along the curve');
  assert.ok(straight.at(-1).to, 'the last span ends on the column past the end');
  assert.equal(straight[1].from, straight[0].to, 'pieces meet at the same column');
  const curve = output.tables.curves.find((c) => c.key === straightKey);
  close(curve.planLength, 18, 1e-9);
  assert.equal(curve.supports, 4);
  assert.equal(curve.overLimit, true, 'an 18 m curve is over 12 m …');
  assert.ok(
    straight.every((s) => s.verdict !== 'over'),
    '… but none of its spans is',
  );
  // A vertical-plane arch: the span is its plan length (chord), longer along the curve.
  assert.equal(arch.length, 1);
  close(arch[0].length, 10, 1e-9);
  assert.ok(arch[0].length3d > 10.2);
  // Roles not given are '미완' with the reason; spans still run.
  for (const judgement of ['cap', 'openCut', 'basin'])
    assert.ok(output.missing.some((m) => m.judgement === judgement));
  assert.ok(output.tables.interference.every((r) => r.verdict === 'incomplete'));
  assert.match(
    output.summary.cap.reason,
    /신설 기초\(파일캡·오픈컷\) 레이어를 지정하지 않았습니다/,
  );
});

test('a missing role or block definition leaves only that judgement 미완', () => {
  const built = buildCase(gridRot21);
  const noExisting = diagnose(
    inputsOf(built, ['columns', 'girders', 'newFootings', 'basinGirders']),
  );
  assert.match(noExisting.summary.cap.reason, /기존 기초 레이어를 지정하지 않았습니다/);
  assert.equal(noExisting.summary.cap.incomplete, 10);
  assert.ok(noExisting.tables.interference.every((r) => r.cap.verdict === 'incomplete'));
  assert.ok(noExisting.tables.interference.every((r) => r.openCut.verdict === 'incomplete'));
  assert.equal(noExisting.summary.basin.count, 2, 'the basin check still runs');
  assert.equal(noExisting.summary.spans.over, 2, 'spans still run');
  const noColumns = diagnose(inputsOf(built, ['girders', 'newFootings', 'existingFootings']));
  assert.equal(noColumns.tables.interference.length, 0);
  assert.equal(noColumns.tables.spans.length, 0);
  assert.equal(noColumns.summary.curves.over, 4, 'curve lengths need no columns');
  assert.match(noColumns.summary.spans.reason, /신설 기둥/);

  // One cap block without its definition and one existing footing without its definition.
  const broken = buildCase({
    ...gridRot21,
    caps: gridRot21.columns.map((c, k) => ({
      at: c.at,
      definition: k === gridRot21.columns.length - 1 ? 'missing' : 'cap',
    })),
    existing: [...gridRot21.existing, { at: [-2, 11.559], definition: 'missing' }],
  });
  const output = diagnose(inputsOf(broken));
  assert.equal(output.summary.cap.count, 4, 'readable judgements are unchanged');
  assert.equal(output.summary.cap.incomplete, 2);
  const lastCap = rowAt(output, broken, [13.559, 9.559]);
  assert.equal(lastCap.cap.verdict, 'incomplete');
  assert.match(lastCap.cap.reason, /블록 정의를 읽지 못함/);
  assert.equal(lastCap.openCut.verdict, 'incomplete');
  assert.equal(lastCap.basin.verdict, 'pass');
  const nearUnknown = rowAt(output, broken, [0, 9.559]);
  assert.equal(nearUnknown.cap.verdict, 'incomplete');
  assert.match(nearUnknown.cap.reason, /경계 상자로 대신하지 않음/);
  close(nearUnknown.cap.distance, Math.hypot(0.25, 1.65), 1e-6, 'measured part still shown');
  assert.ok(output.notes.some((n) => /신설 기초 1개/.test(n)));
  assert.ok(output.notes.some((n) => /기존 기초 1개.*블록 정의를 읽지 못함/.test(n)));
  // A cap without an open cut outline: only the open cut check is 미완.
  const solidOnly = buildCase({
    ...gridRot21,
    caps: gridRot21.columns.map((c) => ({ at: c.at, definition: 'cap-solid' })),
  });
  const partial = diagnose(inputsOf(solidOnly));
  assert.equal(partial.summary.cap.count, 4);
  assert.equal(partial.summary.openCut.incomplete, 10);
  assert.match(rowAt(partial, solidOnly, [0, 0]).openCut.reason, /오픈컷 외곽선이 없음/);
  // Asked for, the open cut is a square of the set size on the cap, turned with it (a stated
  // assumption, never an unrotated box): the same result as the drawn 3.6 m outlines.
  const assumed = diagnose(inputsOf(solidOnly), { openCutSize: 3.6 });
  assert.equal(assumed.summary.openCut.count, 7);
  assert.equal(assumed.summary.openCut.incomplete, 0);
  close(rowAt(assumed, solidOnly, [4, 0]).openCut.distance, -0.35, 1e-6);
  assert.ok(assumed.notes.some((n) => /3\.6 m 정사각\(파일캡 중심·회전\)으로 가정/.test(n)));
  assert.equal(DEFINITION_ID.missing in solidOnly.structure.definitions, false);
});

test('layers, role guesses and CSV', () => {
  const built = buildCase(gridRot21);
  const sources = [
    { syncId: 'a', document: '합성-구조.3dm', layers: syncLayers(built.structure) },
    { syncId: 'b', document: '합성-토목.3dm', layers: syncLayers(built.civil) },
  ];
  assert.deepEqual(
    sources[0].layers.map((l) => [l.name, l.count, l.kinds]),
    [
      [LAYERS.columns, 10, { curve: 10 }],
      [LAYERS.girders, 6, { curve: 6 }],
      [LAYERS.newFootings, 10, { block: 10 }],
    ],
  );
  assert.deepEqual(guessRoles(sources), {
    columns: { syncId: 'a', layer: LAYERS.columns },
    girders: { syncId: 'a', layer: LAYERS.girders },
    newFootings: { syncId: 'a', layer: LAYERS.newFootings },
    existingFootings: { syncId: 'b', layer: LAYERS.existingFootings },
    basinGirders: { syncId: 'b', layer: LAYERS.basinGirders },
  });
  // English layer names and a structure model that also holds a basin layer.
  assert.deepEqual(
    guessRoles([
      {
        syncId: 's',
        document: 's',
        layers: [
          { name: 'S-COLUMN', count: 3, kinds: { curve: 3 } },
          { name: 'S-GIRDER', count: 3, kinds: { curve: 3 } },
          { name: 'S-BEAM', count: 3, kinds: { curve: 3 } },
          { name: 'S-FOOTING', count: 3, kinds: { block: 3 } },
        ],
      },
      {
        syncId: 'c',
        document: 'c',
        layers: [
          { name: 'EX-FOOTING', count: 3, kinds: { block: 3 } },
          { name: 'BASIN-BEAM', count: 3, kinds: { mesh: 3 } },
          { name: 'TEXT', count: 3, kinds: { other: 3 } },
        ],
      },
    ]),
    {
      columns: { syncId: 's', layer: 'S-COLUMN' },
      girders: { syncId: 's', layer: 'S-GIRDER' },
      newFootings: { syncId: 's', layer: 'S-FOOTING' },
      existingFootings: { syncId: 'c', layer: 'EX-FOOTING' },
      basinGirders: { syncId: 'c', layer: 'BASIN-BEAM' },
    },
  );

  const output = diagnose(inputsOf(built));
  const lines = (text) => text.replace(/^﻿/, '').trimEnd().split('\r\n');
  const interference = lines(diagnoseCsv(output, 'interference'));
  assert.equal(interference.length, 1 + 10);
  assert.match(interference[0], /^"기둥","이름","레이어"/);
  assert.ok(interference.some((line) => line.includes('"불가"') && line.includes('"-0.85"')));
  assert.equal(lines(diagnoseCsv(output, 'spans')).length, 1 + 13);
  assert.equal(lines(diagnoseCsv(output, 'curves')).length, 1 + 6);
  // Text that a spreadsheet would run is quoted as text; numbers stay numbers.
  const named = diagnose({
    ...inputsOf(built),
    columns: inputsOf(built).columns.map((r, k) => (k ? r : { ...r, name: '=HYPERLINK("x")' })),
  });
  assert.match(diagnoseCsv(named, 'interference'), /"'=HYPERLINK\(""x""\)"/);
});

test('scale: 1,000 columns, footings and girders stay well under a second', () => {
  const columns = [],
    existing = [],
    girders = [];
  for (let i = 0; i < 40; i++)
    for (let j = 0; j < 25; j++) {
      columns.push({ at: [i * 5.559, j * 4] });
      existing.push({ at: [i * 5.559 + 2.4, j * 4 + 2.1] });
    }
  for (let j = 0; j < 25; j++)
    for (let i = 0; i < 40; i++)
      girders.push([
        [i * 5.559, j * 4],
        [(i + 1) * 5.559, j * 4],
      ]);
  const built = buildCase({
    angleDeg: -21,
    origin: [200000, 450000],
    columnZ: [0, 6],
    columns,
    girders,
    existing,
    bands: [{ from: [-1, 49.9], to: [230, 49.9], width: 0.6 }],
  });
  const inputs = inputsOf(built);
  const times = [];
  let output;
  for (let k = 0; k < 3; k++) {
    const start = performance.now();
    output = diagnose(inputs);
    times.push(performance.now() - start);
  }
  console.log(
    `s06 diagnose 1,000 columns: first ${times[0].toFixed(0)} ms, best ${Math.min(...times).toFixed(0)} ms`,
  );
  assert.equal(output.summary.columns, 1000);
  assert.equal(output.summary.spans.total, 25 * 39);
  assert.ok(Math.min(...times) < 1000);
});
