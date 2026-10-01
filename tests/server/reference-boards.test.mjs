import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { regionLetter } from '../../src/contracts/reference-board.ts';
import { ReferenceBoards } from '../../src/server/reference-boards.ts';
import { startServer } from '../../src/server/server.ts';

// Reference-image boards (SPEC-09.3·09.9, PLAN-26 T-090 (a)): regions over an image attachment,
// kept per project and attachment as vector shapes, and the flattened input image beside them.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const ID = 'a'.repeat(24);
async function* chunks(bytes) {
  yield bytes;
}
const board = (count) => ({
  regions: Array.from({ length: count }, (_, i) => ({
    letter: regionLetter(i),
    note: i === 0 ? '루버 간격과 깊이만' : '',
    shapes: [
      { kind: 'brush', width: 0.02, points: [i / count, 0.1, i / count + 0.01, 0.2] },
      { kind: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.3 },
      { kind: 'lasso', points: [0.5, 0.5, 0.6, 0.5, 0.55, 0.6] },
      { kind: 'erase', width: 0.01, points: [0.15, 0.15] },
    ],
  })),
  nextIndex: count,
  stage: 'mask',
  width: 1600,
  height: 1120,
});

test('a board round-trips as vector shapes, with letters past Z, and keeps its masked image', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-reference-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const boards = new ReferenceBoards(directory);
  assert.deepEqual(boards.get('p1', ID).regions, [], 'an unknown board is empty');
  const saved = await boards.save('p1', ID, board(30));
  assert.equal(saved.regions[26].letter, 'AA');
  const read = boards.get('p1', ID);
  assert.deepEqual(read.regions, board(30).regions);
  assert.equal(read.nextIndex, 30);
  assert.equal(read.masked, null);
  // The flattened input image is a PNG; anything else is refused.
  await assert.rejects(boards.saveMasked('p1', ID, chunks(Buffer.from('nope'))), /INVALID_INPUT/);
  const withImage = await boards.saveMasked('p1', ID, chunks(PNG));
  assert.equal(withImage.masked.size, PNG.length);
  assert.deepEqual(await boards.masked('p1', ID), PNG);
  // Saving the regions again keeps the image's note; the stage is part of the record.
  const checked = await boards.save('p1', ID, { ...board(2), stage: 'check' });
  assert.equal(checked.masked.size, PNG.length);
  assert.equal(boards.get('p1', ID).stage, 'check');
  // Two regions with one letter, or a raster, are refused.
  await assert.rejects(
    boards.save('p1', ID, { ...board(2), regions: [board(1).regions[0], board(1).regions[0]] }),
    /INVALID_INPUT/,
  );
  await assert.rejects(boards.save('p1', ID, { ...board(1), pixels: 'AAAA' }));
  await assert.rejects(boards.save('../x', ID, board(1)));
  await boards.remove('p1', ID);
  assert.equal(existsSync(join(directory, 'p1', ID + '.json')), false);
  assert.equal(await boards.masked('p1', ID), undefined);
});

test('over HTTP: only image attachments of the project get a board', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-reference-http-'));
  const app = await startServer({ filename: join(directory, 'store.sqlite') });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (path, method = 'GET', body, type = 'application/json') =>
    fetch(app.origin + '/api/v1' + path, {
      method,
      headers: { Origin: app.origin, Cookie: cookie, ...(body ? { 'Content-Type': type } : {}) },
      body,
    });
  const project = await (await call('/projects', 'POST', JSON.stringify({ name: 'p' }))).json();
  const upload = async (name, bytes) =>
    (
      await call(
        `/projects/${project.id}/attachments?name=${encodeURIComponent(name)}`,
        'POST',
        bytes,
        'application/octet-stream',
      )
    ).json();
  const image = await upload('facade.png', PNG);
  const text = await upload('note.txt', Buffer.from('메모'));
  const path = (id) => `/projects/${project.id}/reference-boards/${id}`;
  const empty = await (await call(path(image.id))).json();
  assert.deepEqual([empty.regions, empty.stage, empty.masked], [[], 'mask', null]);
  assert.equal((await call(path(text.id))).status, 404, 'a text file has no board');
  assert.equal((await call(path('b'.repeat(24)))).status, 404);
  const put = await call(path(image.id), 'PUT', JSON.stringify(board(3)));
  assert.equal(put.status, 200);
  assert.deepEqual((await (await call(path(image.id))).json()).regions, board(3).regions);
  assert.equal((await call(path(image.id), 'PUT', JSON.stringify({ regions: 1 }))).status, 400);
  const masked = await call(path(image.id) + '/masked', 'POST', PNG, 'application/octet-stream');
  assert.equal(masked.status, 200);
  const served = await call(path(image.id) + '/masked');
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
  // Deleting the project deletes its boards.
  assert.ok(existsSync(join(directory, 'reference-boards', project.id)));
  assert.equal((await call(`/projects/${project.id}`, 'DELETE')).status, 200);
  assert.equal(existsSync(join(directory, 'reference-boards', project.id)), false);
});
