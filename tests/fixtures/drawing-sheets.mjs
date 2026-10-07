// Synthetic drawings for 도곽 미리보기 (SPEC-14.15, PLAN-47 T-235) and a fake title block reader.
// Each `.dwg` holds a DWG header and then the JSON its reads should give (the xref read of 도면
// 관계 and the title block read), so both fakes answer from the copy they are handed. Metres.
// No ZWCAD, no real drawing. The layout mirrors the real-ZWCAD fixture (DrawingSheets.cs):
//  - sheets.dwg: TB-A1 (attributed A1 at 1/100) ×3, NOTE-BOX (attributed, not an A ratio), the
//    model tab plotted by window around a plain border with label/value text, Layout1 with content
//    and a window, Layout2 empty; xref\frames.dwg at (0, -100 m); gone.dwg (missing) in frame 2;
//  - xref\frames.dwg: FRAME-A3 (no attributes, A3 at 1/100) with label/value text inside.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { insertTransform } from './xref.mjs';

const MM = 0.001;
const rect = (id, [x0, y0, x1, y1], ci = 7) => ({
  id,
  nativeId: id.slice(4),
  nativeType: 'Polyline',
  segments: [
    [x0, y0, x1, y0],
    [x1, y0, x1, y1],
    [x1, y1, x0, y1],
    [x0, y1, x0, y0],
  ].flatMap(([a, b, c, d]) => [a, b, 0, c, d, 0]),
  colorIndex: ci,
  lineWeight: 0.25,
  valid: true,
});
const text = (s, x, y, h) => ({ s, p: [x, y, 0], h, r: 0, ax: 0, ay: 0 });
const textRow = (id, texts) => ({
  id,
  nativeId: id.slice(4),
  nativeType: 'DBText',
  segments: [],
  texts,
  colorIndex: 3,
});
const objects = (scene) =>
  scene.map((row) => ({
    id: row.id,
    nativeId: row.nativeId,
    kind: 'polyline',
    name: '0 / ' + row.nativeId,
  }));
const layout = (
  name,
  tab,
  plotType,
  window,
  entities,
  styleSheet = 'company.ctb',
  model = false,
) => ({
  name,
  model,
  tab,
  plotType,
  window,
  paper: [841, 594],
  media: 'ISO_A1_(841.00_x_594.00_MM)',
  styleSheet,
  limits: null,
  extents: null,
  entities,
});
const tbFrame = (i) => ({
  name: 'TB-A1',
  handle: 'F' + i,
  space: 'model',
  layout: null,
  box: [i * 100, 0, i * 100 + 84.1, 59.4],
  attributes: [
    { tag: 'DWG_NO', value: 'A-10' + (i + 1) },
    { tag: 'DWG_TITLE', value: '평면도 ' + (i + 1) },
    { tag: 'SCALE', value: '1/100' },
  ],
});
const xrefInsert = (name, position) => ({
  name,
  handle: 'X' + name,
  space: 'model',
  layout: 'Model',
  block: null,
  nested: false,
  position,
  rotation: 0,
  scale: [1, 1, 1],
  transform: insertTransform(position, 0, 1),
});

export function sheetsDrawings(folder) {
  const rootScene = [
    rect('cad-F0', [0, 0, 84.1, 59.4]),
    rect('cad-F1', [100, 0, 184.1, 59.4], 1),
    rect('cad-F2', [200, 0, 284.1, 59.4]),
    rect('cad-W', [300, 0, 384.1, 59.4]),
    textRow('cad-T1', [
      text('도면번호', 370, 3, 0.3),
      text('A-401', 374, 3, 0.4),
      text('도면명', 370, 6, 0.3),
      text('창 범위 시트', 374, 6, 0.5),
    ]),
    rect('cad-FAR', [1000, 1000, 1001, 1001]),
  ];
  const paperScene = [
    rect('cad-P1', [0, 0, 0.42, 0.297]),
    textRow('cad-P2', [
      text('도면번호', 0.33, 0.01, 0.003),
      text('A-501', 0.37, 0.01, 0.004),
      text('도면명', 0.33, 0.02, 0.003),
      text('배치 시트', 0.37, 0.02, 0.005),
    ]),
  ];
  const childScene = [
    rect('cad-C1', [0, 0, 42, 29.7]),
    textRow('cad-C2', [
      text('도면명', 30, 2, 0.3),
      text('단면도', 34, 2, 0.5),
      text('도면번호', 30, 0.8, 0.3),
      text('A-201', 34, 0.8, 0.4),
    ]),
  ];
  return {
    'sheets.dwg': {
      units: 4,
      scale: MM,
      unitsAssumed: false,
      error: null,
      xrefs: [
        { name: 'frames', path: 'xref\\frames.dwg', overlay: false, status: 'Unresolved' },
        { name: 'gone', path: join(folder, 'gone.dwg'), overlay: false, status: 'Unresolved' },
      ],
      inserts: [xrefInsert('frames', [0, -100000, 0]), xrefInsert('gone', [150000, 30000, 0])],
      layouts: [
        layout('Model', 0, 'Window', [300, 0, 384.1, 59.4], 0, 'company.ctb', true),
        layout('Layout1', 1, 'Window', [0, 0, 0.42, 0.297], 2),
        layout('Layout2', 2, 'Layout', null, 0),
      ],
      frames: [
        tbFrame(0),
        tbFrame(1),
        tbFrame(2),
        {
          name: 'NOTE-BOX',
          handle: 'N1',
          space: 'model',
          layout: null,
          box: [0, 70, 5, 71],
          attributes: [{ tag: 'NOTE', value: '합성 메모' }],
        },
      ],
      display: {
        model: { objects: objects(rootScene), scene: rootScene },
        paper: { Layout1: { objects: objects(paperScene), scene: paperScene }, Layout2: {} },
      },
    },
    'xref/frames.dwg': {
      units: 4,
      scale: MM,
      unitsAssumed: false,
      error: null,
      xrefs: [],
      inserts: [],
      layouts: [layout('Model', 0, 'Extents', null, 0, 'other.ctb', true)],
      frames: [
        {
          name: 'FRAME-A3',
          handle: 'G1',
          space: 'model',
          layout: null,
          box: [0, 0, 42, 29.7],
          attributes: [],
        },
      ],
      display: { model: { objects: objects(childScene), scene: childScene }, paper: {} },
    },
  };
}

export async function writeSheetsDrawings(folder) {
  await mkdir(join(folder, 'xref'), { recursive: true });
  const files = sheetsDrawings(folder);
  for (const [name, read] of Object.entries(files))
    await writeFile(join(folder, name), 'AC1032' + JSON.stringify(read));
  return files;
}

/** Answers from the copies; writes each display file into the run's work folder. */
export function fakeSheetsReader({ available = true } = {}) {
  const calls = [];
  return {
    calls,
    async available() {
      return available;
    },
    async read(files, work, blocks, progress) {
      calls.push({ files: files.length, blocks: [...blocks] });
      const out = new Map();
      for (const file of files) {
        const { display, ...read } = JSON.parse((await readFile(file.path, 'utf8')).slice(6));
        const path = join(work, `fake-${file.id}.json`);
        await writeFile(path, JSON.stringify(file.root ? display : { model: display.model }));
        out.set(file.id, { ...read, display: path });
        progress(out.size);
      }
      return out;
    },
  };
}
