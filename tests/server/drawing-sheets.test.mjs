// 도곽 미리보기 over HTTP (SPEC-14.15, PLAN-47 T-235): a drawing that 도면 관계 read is copied and
// read with its xrefs; sheets in order (window and layout with an empty list, listed blocks once
// registered); a candidate becomes a sheet only when picked; the preview gives the rows inside a
// sheet (xref rows carry their placement); the plot style table is the registered .ctb, else the
// one the drawing names when found, else monochrome with the reason (missing, corrupt, .stb).
// Originals are unchanged and nothing is written into the project folder. Synthetic data and fake
// readers; no ZWCAD.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startServer } from '../../src/server/server.ts';
import { fakeXrefReader } from '../fixtures/xref.mjs';
import { fakeSheetsReader, writeSheetsDrawings } from '../fixtures/drawing-sheets.mjs';
import { syntheticCtbText, writeCtb } from '../../src/core/ctb.ts';

async function session(app) {
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
  return async (path, method = 'GET', data) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
}
const settle = async (api, path, busy) => {
  for (let i = 0; i < 200; i++) {
    const state = (await api(path)).json;
    if (!busy.includes(state.state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error('job did not end');
};
const hashes = async (folder) => {
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

test('title blocks of a drawing, candidates, preview rows and the plot style table', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-sheets-http-'));
  const folder = join(directory, '합성 도면');
  const support = join(directory, 'cad-support');
  await mkdir(folder);
  await mkdir(support);
  await writeSheetsDrawings(folder);
  // The drawing names company.ctb; a CAD support folder has it. The project has its own table.
  await writeFile(
    join(support, 'company.ctb'),
    writeCtb(syntheticCtbText(() => ({ color: String(0xc2000000 >> 0), lineweight: 5 }))),
  );
  await writeFile(
    join(folder, 'project.ctb'),
    writeCtb(
      syntheticCtbText((aci) =>
        aci === 1
          ? { color: String(0xc2ff0000 >> 0), lineweight: 7 }
          : { color: '-1', lineweight: 255 },
      ),
    ),
  );
  const broken = writeCtb(syntheticCtbText(() => ({ color: '-1', lineweight: 1 })));
  broken[70] ^= 0xff;
  await writeFile(join(folder, 'broken.ctb'), broken);
  const reader = fakeSheetsReader();
  const app = await startServer({
    filename: join(directory, 'data', 'store.sqlite'),
    xrefReader: fakeXrefReader(),
    sheetsReader: reader,
    ctbSupportFolders: async () => [support],
    collectOptions: { dwgReader: null },
  });
  const none = await startServer({
    filename: join(directory, 'data2', 'store.sqlite'),
    xrefReader: fakeXrefReader(),
    sheetsReader: null,
    ctbSupportFolders: async () => [],
    collectOptions: { dwgReader: null },
  });
  t.after(async () => {
    await app.close();
    await none.close();
    await rm(directory, { recursive: true, force: true });
  });
  const api = await session(app);
  const project = (await api('/projects', 'POST', { name: '도곽' })).json;
  const base = `/projects/${project.id}/drawing/sheets`;
  const idle = (await api(base)).json;
  assert.deepEqual([idle.state, idle.drawings, idle.result], ['idle', [], null]);
  assert.equal(idle.plotStyle.source, 'builtin');
  assert.equal(idle.plotStyle.notice, 'NO_CTB');
  await api(`/projects/${project.id}/folders`, 'POST', { path: folder });
  const root = join(folder, 'sheets.dwg');
  // Not read by 도면 관계 yet.
  assert.equal((await api(`${base}/read`, 'POST', { root })).status, 404);
  await api(`/projects/${project.id}/xref/read`, 'POST', {});
  await settle(api, `/projects/${project.id}/xref`, ['reading']);
  const before = await hashes(folder);

  const ready = (await api(base)).json;
  assert.deepEqual(ready.drawings.map((d) => d.name).sort(), ['frames.dwg', 'sheets.dwg']);
  assert.deepEqual(
    ready.ctbChoices.map((c) => [c.name, c.where]),
    [
      ['broken.ctb', 'project'],
      ['project.ctb', 'project'],
      ['company.ctb', 'cad'],
    ],
  );
  assert.equal((await api(`${base}/read`, 'POST', { root })).status, 200);
  const first = await settle(api, base, ['reading']);
  assert.equal(first.state, 'done', first.error);
  assert.deepEqual(reader.calls, [{ files: 2, blocks: [] }], 'the root and the xref it shows');
  assert.deepEqual(
    first.result.sheets.map((s) => [s.source, s.number]),
    [
      ['window', 'A-401'],
      ['layout', 'A-501'],
    ],
  );
  assert.deepEqual(
    first.result.candidates.map((c) => [c.block, c.count]),
    [
      ['TB-A1', 3],
      ['FRAME-A3', 1],
    ],
  );
  assert.deepEqual(first.result.missingXrefs, ['gone']);
  assert.deepEqual(first.result.styleNames, ['company.ctb']);
  // No registered table: the one the drawing names, found in the CAD folder.
  assert.deepEqual([first.plotStyle.source, first.plotStyle.name], ['drawing', 'company.ctb']);

  // Register the title block list; then pick the xref's frame.
  let state = (await api(`${base}/settings`, 'PUT', { blocks: ['TB-A1', 'tb-a1 '] })).json;
  assert.deepEqual(state.settings.blocks, ['tb-a1']);
  assert.deepEqual(
    state.result.sheets.map((s) => s.number),
    ['A-101', 'A-102', 'A-103', 'A-401', 'A-501'],
  );
  assert.equal((await api(`${base}/pick`, 'POST', { block: 'NOTE-BOX' })).status, 404);
  state = (await api(`${base}/pick`, 'POST', { block: 'FRAME-A3' })).json;
  assert.deepEqual(state.settings.blocks, ['tb-a1', 'FRAME-A3']);
  const section = state.result.sheets.find((s) => s.block === 'FRAME-A3');
  assert.deepEqual([section.number, section.title, section.xref], ['A-201', '단면도', true]);
  assert.equal(state.result.candidates.length, 0);

  // Preview rows: inside the sheet only; xref rows carry their placement.
  const sheet2 = state.result.sheets.find((s) => s.number === 'A-102');
  const preview2 = (await api(`${base}/preview?sheet=${encodeURIComponent(sheet2.id)}`)).json;
  assert.deepEqual(
    preview2.scene.map((r) => r.id),
    ['cad-F1'],
  );
  assert.deepEqual(preview2.sheet.missingXrefs, ['gone']);
  const preview3 = (await api(`${base}/preview?sheet=${encodeURIComponent(section.id)}`)).json;
  assert.deepEqual(
    preview3.scene.map((r) => r.id),
    ['x1-cad-C1', 'x1-cad-C2'],
  );
  assert.equal(preview3.scene[0].placement.length, 16);
  const layoutSheet = state.result.sheets.find((s) => s.source === 'layout');
  const paper = (await api(`${base}/preview?sheet=${encodeURIComponent(layoutSheet.id)}`)).json;
  assert.deepEqual(
    paper.scene.map((r) => r.id),
    ['cad-P1', 'cad-P2'],
  );
  assert.equal((await api(`${base}/preview?sheet=nope`)).status, 404);

  // The registered table wins; a corrupt one falls back with the reason; only listed choices.
  state = (await api(`${base}/settings`, 'PUT', { ctb: join(folder, 'project.ctb') })).json;
  assert.deepEqual([state.plotStyle.source, state.plotStyle.name], ['project', 'project.ctb']);
  const table = (await api(`${base}/plot-style`)).json;
  assert.deepEqual(table.table.pens[1], { color: '#ff0000', lineWeight: 0.5 });
  assert.deepEqual(table.table.pens[2], { color: 'object', lineWeight: 'object' });
  state = (await api(`${base}/settings`, 'PUT', { ctb: join(folder, 'broken.ctb') })).json;
  assert.deepEqual([state.plotStyle.source, state.plotStyle.notice], ['builtin', 'CTB_CORRUPT']);
  assert.equal((await api(`${base}/plot-style`)).json.table, null);
  assert.equal(
    (await api(`${base}/settings`, 'PUT', { ctb: join(directory, 'elsewhere.ctb') })).status,
    404,
  );
  await rm(join(folder, 'broken.ctb'));
  state = (await api(base)).json;
  assert.deepEqual([state.plotStyle.source, state.plotStyle.notice], ['builtin', 'CTB_MISSING']);
  state = (await api(`${base}/settings`, 'PUT', { ctb: null })).json;
  assert.equal(state.plotStyle.source, 'drawing');

  // Originals unchanged; nothing new in the project folder (the removed table aside).
  const after = await hashes(folder);
  delete before[join(folder, 'broken.ctb')];
  assert.deepEqual(after, before);

  // No ZWCAD at another engine.
  const other = await session(none);
  const otherProject = (await other('/projects', 'POST', { name: 'x' })).json;
  await other(`/projects/${otherProject.id}/folders`, 'POST', { path: folder });
  const noZwcad = await other(`/projects/${otherProject.id}/drawing/sheets/read`, 'POST', { root });
  assert.deepEqual([noZwcad.status, noZwcad.json.code], [409, 'NO_ZWCAD']);
});
