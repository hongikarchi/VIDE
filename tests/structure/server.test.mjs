import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';

// Structure jig over HTTP: a stored Rhino Sync → draft → section edits → confirm & analyse → stale.
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const curve = (id, layer, points) => ({
  id,
  nativeId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
  nativeType: 'Curve',
  layer64: b64(layer),
  name64: '',
  line: points.flat(),
  vertices: [],
  indices: [],
  attributes64: [],
});
const scene = [
  ...[
    [0, 0],
    [6, 0],
    [0, 5],
    [6, 5],
  ].map(([x, y], k) =>
    curve(`1${k}`, '기둥', [
      [x, y, 0],
      [x, y, 4],
    ]),
  ),
  curve('20', '보', [
    [0, 0, 4],
    [6, 0, 4],
  ]),
  curve('21', '보', [
    [0, 5, 4],
    [6, 5, 4],
  ]),
  curve('22', '보', [
    [0, 0, 4],
    [0, 5, 4],
  ]),
  curve('23', '보', [
    [6, 0, 4],
    [6, 5, 4],
  ]),
];

test('structure jig: draft, edits, confirmation, stored result and staleness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-structure-'));
  const app = await startServer({ filename: join(directory, 'workspace.sqlite') });
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
      const reply = await fetch(app.origin + '/api/v1' + path, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(data ?? {}) : undefined,
      });
      return { status: reply.status, body: await reply.json() };
    };
    const project = (await api('/projects', 'POST', { name: '구조' })).body;
    const insert = (id, createdAt) =>
      app.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
        id,
        project.id,
        JSON.stringify({
          id,
          body: 'rhino sync',
          pins: [],
          sketches: [],
          files: [],
          provider: 'codex-cli',
          model: 'codex-cli',
          effort: 'default',
          permission: 'review',
          host: 'rhino',
        }),
        'succeeded',
        JSON.stringify({
          hostExecuted: true,
          host: 'rhino',
          sourceDocument: { documentId: 'doc-1', instance: 'i-1', name: 'frame.3dm' },
          scene,
          objects: scene.map((row) => ({ id: row.id })),
        }),
        createdAt,
      );
    insert('sync-1', '2026-09-29T01:00:00.000Z');

    assert.equal((await api(`/projects/${project.id}/jigs/structure`)).body.draft, null);
    const draft = await api(`/projects/${project.id}/jigs/structure/draft`, 'POST', {
      sources: [{ syncId: 'sync-1', mode: 'curves' }],
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    assert.equal(draft.body.model.members.length, 8);
    assert.ok(draft.body.checks.some((i) => i.code === 'SECTION_ASSUMED' && i.level === 'error'));

    // Confirming with a placeholder section is refused with the blocking issues.
    const refused = await api(`/projects/${project.id}/jigs/structure/analyze`, 'POST', {
      confirm: true,
    });
    assert.equal(refused.status, 422);
    assert.ok(refused.body.issues.some((i) => i.code === 'SECTION_ASSUMED'));

    const members = draft.body.model.members;
    const edited = await api(`/projects/${project.id}/jigs/structure/edit`, 'POST', {
      sections: [
        {
          members: members.filter((m) => m.role === 'column').map((m) => m.id),
          name: 'H-300x300x10x15',
        },
        {
          members: members.filter((m) => m.role !== 'column').map((m) => m.id),
          name: 'H-400x200x8x13',
        },
      ],
      areaLoads: [
        {
          id: 'roof',
          pattern: 'L',
          polygon_m: [
            [0, 0, 4],
            [6, 0, 4],
            [6, 5, 4],
            [0, 5, 4],
          ],
          value_kPa: 3,
        },
      ],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.ok(
      !edited.body.checks.some((i) => i.level === 'error'),
      JSON.stringify(edited.body.checks),
    );

    const analysed = await api(`/projects/${project.id}/jigs/structure/analyze`, 'POST', {
      confirm: true,
    });
    assert.equal(analysed.status, 200, JSON.stringify(analysed.body).slice(0, 400));
    assert.equal(analysed.body.result.status, 'ok');
    assert.equal(analysed.body.result.checks.length, 8);
    assert.ok(analysed.body.ledger[0].input_kN > 0);
    assert.ok(
      existsSync(join(directory, 'structure', `${project.id}.json`)),
      'record is kept on disk',
    );

    let state = (await api(`/projects/${project.id}/jigs/structure`)).body;
    assert.equal(state.stale, false);
    assert.equal(state.confirmed.modelHash, analysed.body.modelHash);
    // A newer Sync of the same document makes the confirmed result out of date.
    insert('sync-2', '2026-09-29T02:00:00.000Z');
    state = (await api(`/projects/${project.id}/jigs/structure`)).body;
    assert.equal(state.stale, true);
    assert.equal(state.draftStale, true);

    const bad = await api(`/projects/${project.id}/jigs/structure/edit`, 'POST', { nope: 1 });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
