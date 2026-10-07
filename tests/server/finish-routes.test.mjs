// 마감 일람표 jig over HTTP (SPEC-11.6, PLAN-43 T-198): the library route, a project's rooms and
// sheet saved and read back, a list breaking a room rule refused whole, assigning adopts, and the
// state kept per project. Synthetic room names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';

test('finish routes: library, rooms, sheet, refusal and per-project state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-finish-http-'));
  const app = await startServer({ filename: join(directory, 'data', 'store.sqlite') });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
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
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  const library = (await api('/finish/library')).json;
  assert.equal(Object.keys(library.codes).length, 477);
  assert.equal(library.projects, undefined);

  const a = (await api('/projects', 'POST', { name: '마감 합성 A' })).json;
  const b = (await api('/projects', 'POST', { name: '마감 합성 B' })).json;
  const empty = (await api(`/projects/${a.id}/finish`)).json;
  assert.deepEqual(empty.rooms, []);
  assert.deepEqual(empty.sheet.adopted, []);

  const rooms = [
    { id: 'r1', floor: '1층', no: '101', name: '합성 로비', F: ['F0002'], W: ['W3101'], C: [] },
    { id: 'r2', floor: '1층', no: '102', name: '합성 창고', F: [], W: [], C: ['C0001'] },
  ];
  const saved = await api(`/projects/${a.id}/finish/rooms`, 'PUT', { rooms });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.rooms, rooms);
  assert.deepEqual(saved.json.sheet.adopted, ['C0001', 'F0002', 'W3101'], 'assigning adopts');

  // A wall code in a floor cell: the whole list is refused and nothing changes.
  const wrong = await api(`/projects/${a.id}/finish/rooms`, 'PUT', {
    rooms: [...rooms, { id: 'r3', floor: '', no: '', name: 'x', F: ['W3101'], W: [], C: [] }],
  });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.json.code ?? wrong.json.error, 'FINISH_CODE_INVALID');
  assert.equal((await api(`/projects/${a.id}/finish`)).json.rooms.length, 2);
  const malformed = await api(`/projects/${a.id}/finish/rooms`, 'PUT', { rooms: [{ id: 'x' }] });
  assert.equal(malformed.status, 400);

  // The sheet: adjustments, title and notes; assigned codes stay adopted.
  const sheet = {
    adopted: ['F0103'],
    thk: { F0103: { 1: 12 } },
    notes: ['합성 일반사항'],
    title: {
      project: '합성 공사',
      drawingNo: 'A-901',
      date: '2026-10-07',
      drawn: '작성',
      check: '',
      approved: '',
    },
  };
  const put = await api(`/projects/${a.id}/finish/sheet`, 'PUT', sheet);
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.sheet.adopted, ['C0001', 'F0002', 'F0103', 'W3101']);
  assert.deepEqual(put.json.sheet.thk, { F0103: { 1: 12 } });
  assert.equal(put.json.sheet.title.drawingNo, 'A-901');
  const badLayer = await api(`/projects/${a.id}/finish/sheet`, 'PUT', {
    ...sheet,
    thk: { F0103: { 9: 1 } },
  });
  assert.equal(badLayer.status, 422);

  // Per project.
  assert.deepEqual((await api(`/projects/${b.id}/finish`)).json.rooms, []);
  assert.equal((await api(`/projects/missing/finish`)).status, 404);
});
