// T-283: the Sync jig route reads both Syncs from their stored objects (per-object manifest,
// T-083) and counts Rhino lines; a Rhino Sync of solids only reports what it read instead of 0.
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
const rhinoSolids = beams.map(([x0, y0], i) => ({
  id: 's' + i,
  nativeId: 's' + i,
  nativeType: i % 2 ? 'Extrusion' : 'Brep',
  vertices: [x0, y0, 0, x0 + 1, y0, 0, x0 + 1, y0 + 1, 0],
  indices: [0, 1, 2],
  layer64: b64('철골'),
}));
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
  seed('cad', 'zwcad', 9, cadLines);
  // Stored per object, as a real display Sync: the request row holds no scene.
  for (const id of ['rhino-lines', 'rhino-solids', 'cad'])
    assert.ok(workspace.model(p, id), `${id} is stored per object`);

  const lines = await api(`/projects/${p}/jigs/sync`, 'POST', { rhino: 'rhino-lines', cad: 'cad' });
  assert.deepEqual(lines.counts, { rhino: 5, cad: 5 });
  assert.equal(lines.alignment.source, 'computed');
  assert.ok(lines.alignment.pairs >= 3, `pairs ${lines.alignment.pairs}`);
  assert.equal(lines.summary.match, 5);
  assert.deepEqual(lines.rhinoLayers, [{ name: '구조::보', count: 5 }]);
  assert.deepEqual(lines.read.rhino, { objects: 5, comparable: 5, skipped: [] });

  const solids = await api(`/projects/${p}/jigs/sync`, 'POST', {
    rhino: 'rhino-solids',
    cad: 'cad',
  });
  assert.equal(solids.counts.rhino, 0);
  assert.deepEqual(solids.read.rhino, {
    objects: 5,
    comparable: 0,
    skipped: [
      { type: 'Brep', count: 3 },
      { type: 'Extrusion', count: 2 },
    ],
  });
  assert.equal(solids.read.cad.comparable, 5);
});
