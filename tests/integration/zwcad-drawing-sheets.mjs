// 도곽 미리보기 with the real ZWCAD 2023 (SPEC-14.15, PLAN-47 T-235). Skipped when ZWCAD 2023 or the
// built worker is missing. A hidden ZWCAD that this test starts writes SYNTHETIC drawings
// (VIDEDRAWINGSHEETSFIXTURE) into a new folder under .vide/; the engine reads their copies through
// 도면 관계 ([다시 읽기]) and [도곽 찾기] (VIDEDRAWINGSHEETS) with hidden ZWCADs it starts and stops
// itself, then registers the title block list, picks the xref's candidate frame, previews every
// sheet and registers a synthetic .ctb. The drawings stay unchanged; no file is written for the
// person. No user drawing is opened; the user's own ZWCAD is never touched.
// Run: node tests/integration/zwcad-drawing-sheets.mjs
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { writeSheetsFixture, zwcadSheetsReader } from '../../hosts/zwcad/drawing-sheets.ts';
import { syntheticCtbText, writeCtb } from '../../src/core/ctb.ts';
import { runDirectory } from './run-directory.mjs';

if (!(await zwcadSheetsReader().available())) {
  console.log(JSON.stringify({ skipped: 'ZWCAD 2023 or the built worker is not available' }));
  process.exit(0);
}
const run = runDirectory('zwcad-drawing-sheets');
const folder = join(run, 'drawings');
await mkdir(folder, { recursive: true });
const timings = {};
let at = Date.now();
const fixture = await writeSheetsFixture(folder);
timings.fixtureMs = Date.now() - at;
await writeFile(
  join(folder, 'synthetic.ctb'),
  writeCtb(
    syntheticCtbText((aci) =>
      aci === 1
        ? { color: String(0xc2ff0000 >> 0), lineweight: 7 }
        : { color: '-1', lineweight: 255 },
    ),
  ),
);
const hashes = async () => {
  const out = {};
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else
        out[path] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
    }
  };
  await walk(folder);
  return out;
};
const before = await hashes();
const app = await startServer({
  filename: join(run, 'data', 'vide.sqlite'),
  ctbSupportFolders: async () => [],
});
try {
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const headers = {
    Origin: app.origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, json: await response.json() };
  };
  const settle = async (path) => {
    for (;;) {
      const state = (await api(path)).json;
      if (state.state !== 'reading') return state;
      await new Promise((accept) => setTimeout(accept, 500));
    }
  };
  const project = (await api('/projects', 'POST', { name: '도곽 실호스트' })).json;
  await api(`/projects/${project.id}/folders`, 'POST', { path: folder });
  at = Date.now();
  await api(`/projects/${project.id}/xref/read`, 'POST', {});
  const xref = await settle(`/projects/${project.id}/xref`);
  timings.xrefMs = Date.now() - at;
  assert.equal(xref.state, 'done', xref.error);
  const base = `/projects/${project.id}/drawing/sheets`;
  const root = (await api(base)).json.drawings.find((d) => d.name === 'sheets.dwg').path;
  at = Date.now();
  await api(`${base}/read`, 'POST', { root });
  const first = await settle(base);
  timings.sheetsMs = Date.now() - at;
  assert.equal(first.state, 'done', first.error);
  // An empty list: the model tab window and Layout1 are sheets; A-ratio blocks are candidates.
  assert.deepEqual(
    first.result.sheets.map((s) => [s.source, s.number, s.title]),
    [
      ...(fixture.modelWindow ? [['window', 'A-401', '창 범위 시트']] : []),
      ['layout', 'A-501', '배치 시트'],
    ],
  );
  assert.deepEqual(
    first.result.candidates.map((c) => [c.block, c.count, c.attributed, c.xref]),
    [
      ['TB-A1', 3, true, false],
      ['FRAME-A3', 1, false, true],
    ],
  );
  assert.deepEqual(first.result.missingXrefs, ['gone']);
  let state = (await api(`${base}/settings`, 'PUT', { blocks: ['TB-A1'] })).json;
  assert.deepEqual(
    state.result.sheets.filter((s) => s.source === 'list').map((s) => [s.number, s.title]),
    [
      ['A-101', '평면도 1'],
      ['A-102', '평면도 2'],
      ['A-103', '평면도 3'],
    ],
  );
  assert.equal(state.result.sheets.find((s) => s.number === 'A-101').paper, 'A1 · 1/100');
  assert.deepEqual(state.result.sheets.find((s) => s.number === 'A-102').missingXrefs, ['gone']);
  state = (await api(`${base}/pick`, 'POST', { block: 'FRAME-A3' })).json;
  const section = state.result.sheets.find((s) => s.block === 'FRAME-A3');
  assert.deepEqual(
    [section.number, section.title, section.xref, section.paper],
    ['A-201', '단면도', true, 'A3 · 1/100'],
  );
  const previews = {};
  for (const sheet of state.result.sheets) {
    const preview = (await api(`${base}/preview?sheet=${encodeURIComponent(sheet.id)}`)).json;
    previews[sheet.number] = preview.scene.length;
    assert.ok(preview.scene.length > 0, sheet.number);
  }
  const placed = (await api(`${base}/preview?sheet=${encodeURIComponent(section.id)}`)).json;
  assert.ok(placed.scene.every((row) => row.placement?.length === 16));
  state = (await api(`${base}/settings`, 'PUT', { ctb: join(folder, 'synthetic.ctb') })).json;
  assert.equal(state.plotStyle.source, 'project');
  const table = (await api(`${base}/plot-style`)).json.table;
  assert.deepEqual(table.pens[1], { color: '#ff0000', lineWeight: 0.5 });
  assert.deepEqual(table.pens[2], { color: 'object', lineWeight: 'object' });
  assert.deepEqual(await hashes(), before, 'the synthetic drawings are unchanged');
  console.log(JSON.stringify({ fixture, sheets: state.result.sheets.length, previews, timings }));
} finally {
  await app.close();
}
