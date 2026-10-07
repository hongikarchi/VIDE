// 도곽 판정과 CTB 읽기 (SPEC-14.15, PLAN-47 T-235): the sheet sources in order (title block list,
// model tab window, paper layouts), candidates only after a pick, sheet information from attributes
// or text, xref placement, missing xrefs; .ctb pens and lineweights from the file's own table and
// the refusals. Synthetic data only (no ZWCAD, no real drawing or table).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipRow,
  findSheets,
  infoFromAttributes,
  infoFromText,
  instancesOf,
  isoRatio,
  paperOf,
  plainText,
  rowBox,
  transformBox,
} from '../../src/core/drawing-sheets.ts';
import { readCtb, syntheticCtbText, writeCtb, penColor } from '../../src/core/ctb.ts';
import { parsePlotStyleTable, plotPen } from '../../src/ui/plot-style.ts';
import { buildXrefGraph, placementsOf } from '../../src/core/xref-graph.ts';
import { sheetsDrawings } from '../fixtures/drawing-sheets.mjs';

const FOLDER = 'C:\\합성\\도면';
function input(blocks) {
  const drawings = sheetsDrawings(FOLDER);
  const reads = new Map(
    Object.entries(drawings).map(([name, { display, ...read }]) => [
      FOLDER + '\\' + name.replaceAll('/', '\\'),
      read,
    ]),
  );
  const root = FOLDER + '\\sheets.dwg';
  const graph = buildXrefGraph(reads, (path) => reads.has(path));
  const placements = placementsOf(graph, root);
  const texts = { model: [], paper: {} };
  const take = (scene, matrix) =>
    scene.flatMap((row) =>
      (row.texts ?? []).map((t) => {
        const [x, y] = matrix
          ? [
              matrix[0] * t.p[0] + matrix[1] * t.p[1] + matrix[3],
              matrix[4] * t.p[0] + matrix[5] * t.p[1] + matrix[7],
            ]
          : t.p;
        return { s: t.s, x, y, h: t.h };
      }),
    );
  texts.model.push(...take(drawings['sheets.dwg'].display.model.scene, null));
  texts.model.push(...take(drawings['xref/frames.dwg'].display.model.scene, placements[1].matrix));
  texts.paper.Layout1 = take(drawings['sheets.dwg'].display.paper.Layout1.scene, null);
  return {
    root,
    files: reads,
    placements,
    blocks,
    texts,
    missing: [{ name: 'gone', point: [150, 30] }],
  };
}

test('ISO A ratio, paper and scale, transforms and row boxes', () => {
  assert.equal(isoRatio([0, 0, 84.1, 59.4]), true);
  assert.equal(isoRatio([0, 0, 0.42, 0.297]), true);
  assert.equal(isoRatio([0, 0, 5, 1]), false);
  assert.equal(isoRatio([0, 0, 0.0841, 0.0594]), false, 'too small to be a sheet');
  assert.equal(paperOf([0, 0, 84.1, 59.4]), 'A1 · 1/100');
  assert.equal(paperOf([0, 0, 0.42, 0.297]), 'A3');
  assert.deepEqual(
    transformBox([1, 0, 0, 10, 0, 1, 0, -5, 0, 0, 1, 0, 0, 0, 0, 1], [0, 0, 2, 1]),
    [10, -5, 12, -4],
  );
  assert.deepEqual(
    rowBox({ segments: [0, 0, 0, 2, 3, 0], texts: [{ p: [-1, 1, 0] }] }),
    [-1, 0, 2, 3],
  );
  assert.equal(rowBox({}), null);
  assert.equal(plainText('{\\fArial|b1;도면\\P명}'), '도면 명');
});

test('a display row is cut to the sheet: segments with their style runs, fills, texts', () => {
  const row = {
    id: 'cad-1',
    segments: [0, 0, 0, 1, 0, 0, 10, 10, 0, 11, 10, 0, 0.5, 0.5, 0, 0.5, 0.7, 0],
    segmentStyles: [
      { n: 2, ci: 1 },
      { n: 1, ci: 3 },
    ],
    fills: [
      { loops: [[20, 20, 0, 21, 20, 0, 21, 21, 0]] },
      { loops: [[0, 0, 0, 1, 0, 0, 1, 1, 0]] },
    ],
    texts: [
      { s: '안', p: [0.2, 0.2, 0], h: 0.1 },
      { s: '밖', p: [50, 50, 0], h: 0.1 },
    ],
  };
  const cut = clipRow(row, null, [-0.1, -0.1, 2, 2]);
  assert.deepEqual(cut.segments, [0, 0, 0, 1, 0, 0, 0.5, 0.5, 0, 0.5, 0.7, 0]);
  assert.deepEqual(cut.segmentStyles, [
    { n: 1, ci: 1 },
    { n: 1, ci: 3 },
  ]);
  assert.equal(cut.fills.length, 1);
  assert.deepEqual(
    cut.texts.map((t) => t.s),
    ['안'],
  );
  // Placed by a matrix: the same row moved by (100, 0) misses that box and is dropped.
  const moved = [1, 0, 0, 100, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.equal(clipRow(row, moved, [-0.1, -0.1, 2, 2]), null);
  assert.equal(clipRow(row, moved, [109, 9, 112, 11]).segments.length, 6);
  assert.deepEqual(
    clipRow({ segments: [0.123456789, 0, 0, 1, 0, 0] }, null, [0, 0, 1, 1]).segments,
    [0.12346, 0, 0, 1, 0, 0],
  );
});

test('sheet information from attributes, or from label and value text', () => {
  assert.deepEqual(
    infoFromAttributes([
      { tag: '공사명', value: '합성 공사' },
      { tag: '도면번호', value: 'A-101' },
      { tag: '도면명', value: '1층 평면도' },
    ]),
    { number: 'A-101', title: '1층 평면도' },
  );
  const box = [0, 0, 42, 29.7];
  assert.deepEqual(
    infoFromText(box, [
      { s: '도면명', x: 30, y: 2, h: 0.3 },
      { s: '단면도', x: 34, y: 2, h: 0.5 },
      { s: '도면번호', x: 30, y: 0.8, h: 0.3 },
      { s: 'A-201', x: 34, y: 0.8, h: 0.4 },
      { s: '밖의 글', x: 100, y: 100, h: 9 },
    ]),
    { number: 'A-201', title: '단면도' },
  );
  // No labels: the number pattern and the largest text in the title block area.
  assert.deepEqual(
    infoFromText(box, [
      { s: 'S-03', x: 38, y: 1, h: 0.4 },
      { s: '구조 평면도', x: 33, y: 3, h: 0.6 },
      { s: '주석', x: 5, y: 25, h: 1 },
    ]),
    { number: 'S-03', title: '구조 평면도' },
  );
  assert.deepEqual(infoFromText(box, []), { number: null, title: null });
});

test('sheets: listed blocks, model tab window, paper layout; candidates only after a pick', () => {
  // An empty list: the window and the layout are sheets; A-ratio blocks are candidates only.
  const empty = findSheets(input([]));
  assert.deepEqual(
    empty.sheets.map((s) => [s.source, s.number, s.title, s.info]),
    [
      ['window', 'A-401', '창 범위 시트', 'text'],
      ['layout', 'A-501', '배치 시트', 'text'],
    ],
  );
  assert.deepEqual(
    empty.candidates.map((c) => [c.block, c.count, c.attributed, c.xref, c.paper]),
    [
      ['TB-A1', 3, true, false, 'A1 · 1/100'],
      ['FRAME-A3', 1, false, true, 'A3 · 1/100'],
    ],
    'NOTE-BOX (not an A ratio) is no candidate',
  );
  assert.equal(empty.sheets[0].styleSheet, 'company.ctb');

  const listed = findSheets(input(['tb-a1']));
  assert.deepEqual(
    listed.sheets.map((s) => [s.source, s.number, s.title]),
    [
      ['list', 'A-101', '평면도 1'],
      ['list', 'A-102', '평면도 2'],
      ['list', 'A-103', '평면도 3'],
      ['window', 'A-401', '창 범위 시트'],
      ['layout', 'A-501', '배치 시트'],
    ],
  );
  assert.deepEqual(listed.sheets[1].missingXrefs, ['gone'], 'the missing xref in frame 2');
  assert.deepEqual(listed.sheets[0].missingXrefs, []);
  assert.deepEqual(
    listed.candidates.map((c) => c.block),
    ['FRAME-A3'],
  );

  // Picking the xref's attribute-less frame: placed by the xref insert, info from its text.
  const picked = findSheets(input(['TB-A1', 'FRAME-A3']));
  assert.equal(picked.sheets.length, 6);
  const frame = picked.sheets.find((s) => s.block === 'FRAME-A3');
  assert.deepEqual(
    [frame.number, frame.title, frame.info, frame.xref, frame.paper],
    ['A-201', '단면도', 'text', true, 'A3 · 1/100'],
  );
  assert.deepEqual(
    frame.box.map((v) => Math.round(v * 10) / 10),
    [0, -100, 42, -70.3],
  );
  assert.equal(picked.candidates.length, 0);
});

test('a model tab window on a listed frame marks that frame instead of adding a sheet', () => {
  const data = input(['TB-A1']);
  const root = data.files.get(data.root);
  root.layouts[0] = { ...root.layouts[0], window: [0.5, 0, 84.1, 59.4] };
  const { sheets } = findSheets(data);
  assert.equal(sheets.filter((s) => s.source === 'window').length, 0);
  assert.equal(sheets.find((s) => s.number === 'A-101').plotWindow, true);
  // A layout with a listed frame is not a second sheet.
  root.frames.push({
    ...root.frames[0],
    handle: 'P',
    space: 'paper',
    layout: 'Layout1',
    box: [0, 0, 0.42, 0.297],
  });
  assert.equal(findSheets(data).sheets.filter((s) => s.space === 'paper').length, 1);
  assert.equal(findSheets(data).sheets.find((s) => s.space === 'paper').source, 'list');
});

test('a sheet xref inserted twice gives its frame twice; the plotted frame is the first candidate', () => {
  const data = input([]);
  const root = data.files.get(data.root);
  const second = {
    ...root.inserts[0],
    handle: 'Xframes2',
    position: [200000, -100000, 0],
    transform: [1, 0, 0, 200000, 0, 1, 0, -100000, 0, 0, 1, 0, 0, 0, 0, 1],
  };
  root.inserts.push(second);
  // The model tab plots the second insert's frame.
  root.layouts[0] = { ...root.layouts[0], window: [200, -100, 242, -70.3] };
  const graph = buildXrefGraph(data.files, (path) => data.files.has(path));
  const instances = instancesOf(graph, data.root);
  assert.equal(instances.length, 3, 'the root and two inserts of frames.dwg');
  assert.equal(placementsOf(graph, data.root).length, 2, 'one placement per linked file');
  data.placements = instances;
  const { sheets, candidates } = findSheets(data);
  assert.deepEqual(
    candidates.map((c) => [c.block, c.count, c.plotted]),
    [
      ['FRAME-A3', 2, true],
      ['TB-A1', 3, false],
    ],
  );
  // The window is its own sheet until the frame is picked; then the frame sheet carries it.
  assert.equal(sheets.filter((s) => s.source === 'window').length, 1);
  data.blocks = ['FRAME-A3'];
  const picked = findSheets(data).sheets;
  assert.equal(picked.filter((s) => s.block === 'FRAME-A3').length, 2);
  assert.equal(picked.filter((s) => s.source === 'window').length, 0);
  assert.equal(picked.find((s) => s.plotWindow && s.block === 'FRAME-A3').box[0], 200);
});

test('.ctb: pens from the file, lineweights from its own table, refusals', () => {
  // A: all pens black, lineweight index = ACI for 1–8, 'object' beyond. Company-style table with a
  // non-standard lineweight table: index 3 must read 0.006, not the standard 0.13.
  const a = writeCtb(
    syntheticCtbText(
      (aci) => ({ color: String(0xc2000000 >> 0), lineweight: aci <= 8 ? aci : 255 }),
      [0, 0.002, 0.004, 0.006, 0.18, 0.25, 0.35, 0.5, 0.7],
    ),
  );
  const ra = readCtb(a, 'a.ctb');
  assert.deepEqual(ra.table.pens[1], { color: '#000000', lineWeight: 0.002 });
  assert.deepEqual(ra.table.pens[3], { color: '#000000', lineWeight: 0.006 });
  assert.deepEqual(ra.table.pens[9], { color: '#000000', lineWeight: 'object' });
  assert.equal(Object.keys(ra.table.pens).length, 255);
  assert.deepEqual([ra.info.styles, ra.info.weights], [255, 9]);
  // B: ZWCAD style (-1 = object colour), ACI 1 red 0.5 mm.
  const b = writeCtb(
    syntheticCtbText((aci) =>
      aci === 1
        ? { color: String(0xc2ff0000 >> 0), lineweight: 7 }
        : { color: '-1', lineweight: 255 },
    ),
  );
  const rb = readCtb(b, 'b.ctb').table;
  assert.deepEqual(rb.pens[1], { color: '#ff0000', lineWeight: 0.5 });
  assert.deepEqual(rb.pens[2], { color: 'object', lineWeight: 'object' });
  assert.equal(penColor(String(0xc3ffffff)), 'object');
  // The UI takes the engine's JSON and plots with it.
  const table = parsePlotStyleTable(JSON.parse(JSON.stringify(rb)));
  assert.deepEqual(plotPen(table, { colorIndex: 1, screenColor: '#00ff00' }), {
    color: '#ff0000',
    lineWeight: 0.5,
  });
  assert.deepEqual(plotPen(table, { colorIndex: 5, screenColor: '#0000ff', lineWeight: 0.35 }), {
    color: '#0000ff',
    lineWeight: 0.35,
  });
  assert.equal(
    parsePlotStyleTable({ name: 'x', pens: { 300: rb.pens[1] }, fallback: rb.fallback }),
    undefined,
  );
  // Corrupt stream, cut file, wrong header, a named (.stb) table, an empty table.
  const broken = Buffer.from(a);
  broken[70] ^= 0xff;
  assert.throws(() => readCtb(broken), { code: 'CTB_CORRUPT' });
  assert.throws(() => readCtb(a.subarray(0, a.length - 10)), { code: 'CTB_LENGTH' });
  assert.throws(() => readCtb(Buffer.from('not a table at all, just some bytes'.repeat(3))), {
    code: 'CTB_HEADER',
  });
  assert.throws(
    () =>
      readCtb(
        writeCtb(
          syntheticCtbText(() => ({ color: '-1', lineweight: 0 })),
          'STBVER',
        ),
      ),
    {
      code: 'NOT_CTB',
    },
  );
  assert.throws(() => readCtb(writeCtb('description="empty\n')), { code: 'CTB_CORRUPT' });
  // The declared length must match the stream.
  const lying = Buffer.from(a);
  lying.writeUInt32LE(lying.readUInt32LE(52) + 1, 52);
  assert.throws(() => readCtb(lying), { code: 'CTB_LENGTH' });
});
