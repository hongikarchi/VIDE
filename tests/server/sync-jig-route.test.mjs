// T-283: the Sync jig route reads both Syncs from their stored objects (per-object manifest,
// T-083) and counts Rhino lines; Rhino solids are compared by their plan section (SPEC-05.8,
// 2026-10-14), and a Sync with neither reports what it read instead of 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { captureInput } from '../../src/server/import-model.ts';

const b64 = (text) => Buffer.from(text).toString('base64');
// Beams of a plan, in metres; the model is offset by (125, 48, 3.2).
const beams = [
  [0, 0, 6, 0],
  [0, 3, 6, 3],
  [0, 6, 6, 6],
  [-1, -1, -1, 11.5],
  [0, 0, 0, 6],
];
const source = (host, documentId) => ({
  instance: '1:2:3',
  documentId,
  connection: 'attached-editor',
  documentHash: 'r'.repeat(64),
  revision: 4,
  name: host === 'zwcad' ? 'plan.dwg' : 'model.3dm',
  units: 'Meters',
  capturedAt: '2026-10-14T00:00:00Z',
});
const display = (host, documentId, scene) => ({
  hostExecuted: true,
  displayOnly: true,
  verified: true,
  executionMode: 'sdk',
  host,
  objects: scene.map((row) => ({
    id: row.id,
    nativeId: row.nativeId,
    kind: 'native',
    name: row.id,
  })),
  scene,
  sourceDocument: source(host, documentId),
});
const rhinoLines = beams.map(([x0, y0, x1, y1], i) => ({
  id: 'r' + i,
  nativeId: 'r' + i,
  nativeType: 'Curve',
  line: [x0 + 125, y0 + 48, 3.2, x1 + 125, y1 + 48, 3.2],
  layer64: b64('구조::보'),
}));
// Flat pieces (no height): nothing to cut, so nothing to compare.
const rhinoFlat = beams.map(([x0, y0], i) => ({
  id: 'f' + i,
  nativeId: 'f' + i,
  nativeType: i % 2 ? 'Extrusion' : 'Brep',
  vertices: [x0, y0, 0, x0 + 1, y0, 0, x0 + 1, y0 + 1, 0],
  indices: [0, 1, 2],
  layer64: b64('철골'),
}));
// Columns 400×400 (z 3.2–6.6, the model offset by 125/48/3.2) as Sync sends Breps: a render mesh
// per face. The section at the middle of their height range is each column's square.
function box([x0, y0, z0], [x1, y1, z1]) {
  const vertices = [],
    indices = [];
  const quad = (...corners) => {
    const o = vertices.length / 3;
    for (const c of corners) vertices.push(...c);
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
  quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
  return { vertices, indices };
}
const columns = [
  [0, 0],
  [6, 0],
  [0, 3],
  [6, 3],
  [3, 6],
];
const rhinoSolids = columns.map(([x, y], i) => ({
  id: 's' + i,
  nativeId: 's' + i,
  nativeType: i % 2 ? 'Extrusion' : 'Brep',
  ...box([x + 124.8, y + 47.8, 3.2], [x + 125.2, y + 48.2, 6.6]),
  origin: [x + 124.8, y + 47.8, 3.2],
  boundsSize: [0.4, 0.4, 3.4],
  layer64: b64('철골'),
}));
// The drawing has the squares of the first three columns (12 lines).
const cadColumns = columns.slice(0, 3).flatMap(([x, y], i) =>
  [
    [-0.2, -0.2, 0.2, -0.2],
    [0.2, -0.2, 0.2, 0.2],
    [0.2, 0.2, -0.2, 0.2],
    [-0.2, 0.2, -0.2, -0.2],
  ].map(([x0, y0, x1, y1], k) => ({
    id: `cc-${i}-${k}`,
    nativeId: String(100 + i * 4 + k),
    nativeType: 'Line',
    segments: [x + x0, y + y0, 0, x + x1, y + y1, 0],
    layer64: b64('S-COL'),
  })),
);
const cadLines = beams.map(([x0, y0, x1, y1], i) => ({
  id: 'cad-' + i,
  nativeId: String(20 + i),
  nativeType: 'Line',
  segments: [x0, y0, 0, x1, y1, 0],
  layer64: b64('S-BEAM'),
}));

test('the Sync jig compares stored Rhino objects and explains a side with no lines', async (t) => {
  const app = await startServer({ filename: ':memory:', host: { status: async () => ({}) } });
  t.after(() => app.close());
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
    const text = await response.text();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return JSON.parse(text);
  };
  const p = (await api('/projects', 'POST', { name: 'sync jig' })).id;
  const workspace = new Workspace(app.store);
  const seed = (id, host, documentId, scene) => {
    workspace.submit(p, captureInput({ id, instance: '1:2:3', documentId }, host));
    workspace.update(p, id, 'succeeded', display(host, documentId, scene));
  };
  seed('rhino-lines', 'rhino', 7, rhinoLines);
  seed('rhino-solids', 'rhino', 8, rhinoSolids);
  seed('rhino-flat', 'rhino', 10, rhinoFlat);
  seed('cad', 'zwcad', 9, cadLines);
  seed('cad-columns', 'zwcad', 11, cadColumns);
  // Stored per object, as a real display Sync: the request row holds no scene.
  for (const id of ['rhino-lines', 'rhino-solids', 'rhino-flat', 'cad', 'cad-columns'])
    assert.ok(workspace.model(p, id), `${id} is stored per object`);

  const lines = await api(`/projects/${p}/jigs/sync`, 'POST', { rhino: 'rhino-lines', cad: 'cad' });
  assert.deepEqual(lines.counts, { rhino: 5, cad: 5 });
  assert.equal(lines.alignment.source, 'computed');
  assert.ok(lines.alignment.pairs >= 3, `pairs ${lines.alignment.pairs}`);
  assert.equal(lines.summary.match, 5);
  assert.deepEqual(lines.rhinoLayers, [{ name: '구조::보', count: 5 }]);
  assert.deepEqual(lines.read.rhino, {
    objects: 5,
    comparable: 5,
    rules: { curves: 5, sections: 0, solids: 0 },
    skipped: [],
  });

  // Solids only: each column's section square (4 edges) at the middle of the height range.
  const solids = await api(`/projects/${p}/jigs/sync`, 'POST', {
    rhino: 'rhino-solids',
    cad: 'cad-columns',
  });
  assert.equal(solids.counts.rhino, 20);
  assert.deepEqual(solids.section, { heights: [4.9], source: 'range', levels: [] });
  assert.deepEqual(solids.read.rhino, {
    objects: 5,
    comparable: 20,
    rules: { curves: 0, sections: 20, solids: 5 },
    skipped: [],
  });
  assert.equal(solids.alignment.source, 'computed');
  assert.ok(solids.alignment.pairs >= 12, `pairs ${solids.alignment.pairs}`);
  assert.ok(Math.abs(solids.alignment.translation[0] + 125) < 1e-6);
  assert.ok(Math.abs(solids.alignment.translation[1] + 48) < 1e-6);
  assert.deepEqual(solids.summary, { match: 12, offset: 0, rhinoOnly: 8, cadOnly: 0 });
  const pair = solids.rows.find((row) => row.state === 'match' && row.cad.nativeId === '100');
  assert.deepEqual(pair.rhino, {
    id: 's0',
    nativeId: 's0',
    layer: '철골',
    name: 's0',
    type: 'Brep',
    rule: 'section',
    height: 4.9,
  });
  // The person's height: below the columns nothing is cut.
  const low = await api(`/projects/${p}/jigs/sync`, 'POST', {
    rhino: 'rhino-solids',
    cad: 'cad-columns',
    sectionHeight: 1,
  });
  assert.equal(low.counts.rhino, 0);
  assert.deepEqual(low.section, { heights: [1], source: 'person', levels: [] });

  const flat = await api(`/projects/${p}/jigs/sync`, 'POST', {
    rhino: 'rhino-flat',
    cad: 'cad',
  });
  assert.equal(flat.counts.rhino, 0);
  assert.deepEqual(flat.read.rhino, {
    objects: 5,
    comparable: 0,
    rules: { curves: 0, sections: 0, solids: 0 },
    skipped: [
      { type: 'Brep', count: 3 },
      { type: 'Extrusion', count: 2 },
    ],
  });
  assert.equal(flat.read.cad.comparable, 5);
});
