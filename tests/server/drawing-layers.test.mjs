// 도면 읽기와 레이어 대응 over HTTP (SPEC-14.3, PLAN-47 T-227): only drawings in the project folders
// are read, and only their copies; no ZWCAD, a missing file, a path outside the folders are
// refused; the list shows version, units and why a drawing is not a target (not mm, unreadable,
// changed after the read); a layer table maps same names, takes choices of existing layers only
// and is copied to another drawing. Synthetic drawings and a fake inspector: each `.dwg` holds a
// DWG header and then the JSON its read should give. Originals keep their hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';

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
const settle = async (api, path) => {
  for (let i = 0; i < 200; i++) {
    const state = (await api(path)).json;
    if (state.state !== 'reading') return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error('drawing read did not end');
};
const layer = (name) => ({ name, color: 7, linetype: 'Continuous', lineweight: -3 });
const drawing = (units, layers, extra = {}) => ({
  error: null,
  version: 'AC1032',
  units,
  layers: layers.map(layer),
  linetypes: [{ name: 'Continuous' }],
  textStyles: [{ name: 'Standard', font: 'txt.shx', bigFont: '' }],
  dimStyles: [{ name: 'ISO-25', textStyle: 'Standard', arrows: ['', '', ''] }],
  blocks: [{ name: '도곽', inserts: 1, attributes: true }],
  xrefs: [],
  ...extra,
});
/** Answers from the copy it is handed, as the real one reads only copies. */
function fakeInspector() {
  const calls = [];
  return {
    calls,
    async available() {
      return true;
    },
    async inspect(files, work, progress) {
      calls.push(files.map((file) => file.path));
      const results = new Map();
      for (const file of files) {
        assert.ok(file.path.startsWith(work), 'only copies in the work folder are read');
        const text = await readFile(file.path, 'utf8');
        if (text.includes('UNREADABLE')) continue;
        results.set(file.id, { ...JSON.parse(text.slice(6)), id: file.id });
      }
      progress(results.size);
      return results;
    },
  };
}
const sha = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

test('read project drawings and keep a layer table per drawing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-drawing-layers-'));
  const folder = join(directory, '합성 도면');
  const outside = join(directory, '다른 폴더');
  await mkdir(join(folder, 'XREF'), { recursive: true });
  await mkdir(outside);
  const files = {
    plan: join(folder, '평면.dwg'),
    section: join(folder, 'XREF', '단면.dwg'),
    inch: join(folder, 'inch.dwg'),
    none: join(folder, 'unitless.dwg'),
    broken: join(folder, 'broken.dwg'),
  };
  const write = (path, value) => writeFile(path, 'AC1032' + JSON.stringify(value));
  await write(files.plan, drawing(4, ['0', 'A-WALL', '창호', 'S-COL', 'xref|A-WALL']));
  await write(files.section, drawing(4, ['0', 'A-WALL', '창호']));
  await write(files.inch, drawing(1, ['0']));
  await write(files.none, drawing(0, ['0']));
  await writeFile(files.broken, 'AC1032 UNREADABLE');
  await writeFile(join(outside, 'x.dwg'), 'AC1032{}');
  const before = Object.fromEntries(
    await Promise.all(Object.entries(files).map(async ([k, p]) => [k, await sha(p)])),
  );
  const inspector = fakeInspector();
  const app = await startServer({
    filename: join(directory, 'data', 'store.sqlite'),
    drawingInspector: inspector,
  });
  const none = await startServer({
    filename: join(directory, 'data2', 'store.sqlite'),
    drawingInspector: null,
  });
  t.after(async () => {
    await app.close();
    await none.close();
    await rm(directory, { recursive: true, force: true });
  });
  const api = await session(app);
  const project = (await api('/projects', 'POST', { name: '도면 읽기' })).json;
  const base = `/projects/${project.id}/drawing/layers`;
  assert.deepEqual((await api(base)).json.drawings, []);
  const noFolder = await api(`${base}/read`, 'POST', { paths: [files.plan] });
  assert.deepEqual([noFolder.status, noFolder.json.code], [409, 'NO_PROJECT_FOLDER']);
  await api(`/projects/${project.id}/folders`, 'POST', { path: folder });
  // No ZWCAD at another engine.
  const other = await session(none);
  const otherProject = (await other('/projects', 'POST', { name: 'x' })).json;
  await other(`/projects/${otherProject.id}/folders`, 'POST', { path: folder });
  const noZwcad = await other(`/projects/${otherProject.id}/drawing/layers/read`, 'POST', {
    paths: [files.plan],
  });
  assert.deepEqual([noZwcad.status, noZwcad.json.code], [409, 'NO_ZWCAD']);
  // Outside the project folders, a missing file, not a drawing.
  const away = await api(`${base}/read`, 'POST', { paths: [join(outside, 'x.dwg')] });
  assert.deepEqual([away.status, away.json.code], [403, 'PATH_NOT_IN_PROJECT']);
  const gone = await api(`${base}/read`, 'POST', { paths: [join(folder, '없음.dwg')] });
  assert.deepEqual([gone.status, gone.json.code], [404, 'FILE_MISSING']);
  assert.equal((await api(`${base}/read`, 'POST', { paths: [join(folder, 'a.txt')] })).status, 400);
  assert.equal(inspector.calls.length, 0);

  assert.equal((await api(`${base}/read`, 'POST', { paths: Object.values(files) })).status, 200);
  const state = await settle(api, base);
  assert.equal(state.state, 'done');
  assert.equal(inspector.calls.length, 1);
  assert.equal(inspector.calls[0].length, 5);
  const byName = Object.fromEntries(state.drawings.map((d) => [d.name, d]));
  assert.deepEqual(
    [byName['평면.dwg'].release, byName['평면.dwg'].eligible, byName['평면.dwg'].counts.layers],
    ['2018', true, 5],
  );
  assert.deepEqual(
    [byName['inch.dwg'].eligible, byName['inch.dwg'].reason],
    [false, 'UNITS_NOT_MM'],
  );
  assert.deepEqual(
    [byName['unitless.dwg'].eligible, byName['unitless.dwg'].unitsAssumed],
    [true, true],
  );
  assert.deepEqual(
    [byName['broken.dwg'].reason, byName['broken.dwg'].error],
    ['READ_FAILED', 'NOT_READ'],
  );

  // One drawing in full: its read with layers, styles, blocks.
  const one = (await api(`${base}?path=${encodeURIComponent(files.plan)}`)).json;
  assert.equal(one.read.blocks[0].name, '도곽');
  assert.equal(one.map, null);

  // The layer table: same names, choices only of the drawing's own layers.
  const sources = ['건축::A-WALL', '건축::창호', '구조::기둥', '가구'];
  const missingLayer = await api(base, 'PUT', {
    path: files.plan,
    sources,
    chosen: { '구조::기둥': '새 레이어' },
  });
  assert.deepEqual([missingLayer.status, missingLayer.json.code], [422, 'LAYER_NOT_IN_DRAWING']);
  const xrefLayer = await api(base, 'PUT', {
    path: files.plan,
    sources,
    chosen: { '구조::기둥': 'xref|A-WALL' },
  });
  assert.equal(xrefLayer.json.code, 'LAYER_NOT_IN_DRAWING', 'an xref layer is not a target');
  const saved = await api(base, 'PUT', {
    path: files.plan,
    sources,
    chosen: { '구조::기둥': 'S-COL' },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(
    saved.json.entries.map((e) => [e.source, e.layer, e.how]),
    [
      ['건축::A-WALL', 'A-WALL', 'same'],
      ['건축::창호', '창호', 'same'],
      ['구조::기둥', 'S-COL', 'user'],
      ['가구', null, 'none'],
    ],
  );
  const stale = await api(base, 'PUT', { path: files.plan, sources, revision: 0 });
  assert.deepEqual([stale.status, stale.json.code], [409, 'REVISION_CONFLICT']);
  const refused = await api(base, 'PUT', { path: files.inch, sources });
  assert.deepEqual([refused.status, refused.json.code], [409, 'UNITS_NOT_MM']);
  const listed = (await api(base)).json.drawings.find((d) => d.name === '평면.dwg');
  assert.deepEqual(listed.map, { sources: 4, unmapped: 1, revision: 1 });

  // Copied to the section: S-COL is not there, so 구조::기둥 needs a layer again.
  const copied = await api(`${base}/copy`, 'POST', { from: files.plan, to: files.section });
  assert.equal(copied.status, 200);
  assert.deepEqual(copied.json.dropped, ['구조::기둥']);
  assert.deepEqual(
    copied.json.map.entries.map((e) => e.layer),
    ['A-WALL', '창호', null, null],
  );
  const noTable = await api(`${base}/copy`, 'POST', { from: files.none, to: files.section });
  assert.equal(noTable.status, 404);

  // A drawing changed after the read takes no table until it is read again.
  await utimes(files.section, new Date(), new Date(Date.now() + 60_000));
  const changed = await api(base, 'PUT', { path: files.section, sources });
  assert.deepEqual([changed.status, changed.json.code], [409, 'FILE_CHANGED']);
  await rm(files.broken);
  const after = Object.fromEntries((await api(base)).json.drawings.map((d) => [d.name, d]));
  assert.equal(after['단면.dwg'].reason, 'FILE_CHANGED');
  assert.equal(after['broken.dwg'].reason, 'READ_FAILED');

  // Originals unchanged; the copies are gone.
  for (const [key, path] of Object.entries(files))
    if (key !== 'broken') assert.equal(await sha(path), before[key], key);
});
