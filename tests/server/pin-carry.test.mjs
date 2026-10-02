import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinCarryError, carryPins } from '../../src/server/pin-carry.ts';
import { startServer } from '../../src/server/server.ts';

// SPEC-02.16 (user decision 2026-10-02): pins on a Sync of a closed Rhino window move to the newest
// Sync of the same link in the reopened window; only pinned objects missing there refuse the request.
const OLD = '1:1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW = '2:2:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sync = (id, instance, objects, link = 'l1', extra = {}) => ({
  id,
  state: 'succeeded',
  input: { host: 'rhino', linkId: link, body: '열린 Rhino 문서 가져오기', pins: [] },
  result: {
    host: 'rhino',
    hostExecuted: true,
    displayOnly: true,
    sourceDocument: { connection: 'attached-editor', instance, documentId: 7, id, linkId: link },
    objects: objects.map((o) => (typeof o === 'string' ? { id: o, nativeId: o } : o)),
    ...extra,
  },
});
const store = (rows) => ({
  list: () => rows,
  summary: (_project, id) => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error('NOT_FOUND');
    return row;
  },
});
const pin = (id, basis = 's-old') => ({ id, basis, role: 'target', label: '고정1' });

test('pins on an older Rhino window move to the newest Sync of the same link', () => {
  const rows = [sync('s-old', OLD, ['a', 'b', 'c']), sync('s-new', NEW, ['b', 'a', 'x'])];
  const input = { baseRequestId: 's-old', pins: [pin('a'), pin('b')] };
  assert.equal(carryPins(store(rows), 'p', input), 2);
  assert.equal(input.baseRequestId, 's-new');
  assert.deepEqual(
    input.pins.map((p) => [p.id, p.basis, p.label]),
    [
      ['a', 's-new', '고정1'],
      ['b', 's-new', '고정1'],
    ],
  );
  // A turn result after the reopened Sync names its snapshot; the pins land on that Sync.
  const turn = {
    id: 't1',
    state: 'succeeded',
    input: { host: 'rhino', linkId: 'l1', body: '…', pins: [] },
    result: {
      host: 'rhino',
      hostExecuted: true,
      sourceDocument: { connection: 'attached-editor', instance: NEW, documentId: 7, id: 's-new' },
    },
  };
  const later = { baseRequestId: 's-old', pins: [pin('a')] };
  assert.equal(carryPins(store([...rows, turn]), 'p', later), 1);
  assert.equal(later.pins[0].basis, 's-new');
  // An object found by its native id takes the new row's id.
  const native = [
    sync('s-old', OLD, [{ id: 'o1', nativeId: 'n1' }]),
    sync('s-new', NEW, [{ id: 'o2', nativeId: 'n1' }]),
  ];
  const byNative = { baseRequestId: 's-old', pins: [pin('o1')] };
  carryPins(store(native), 'p', byNative);
  assert.deepEqual([byNative.pins[0].id, byNative.pins[0].basis], ['o2', 's-new']);
});

test('the same window, another link or no pins leave the request as it is', () => {
  const same = [sync('s-old', OLD, ['a']), sync('s-2', OLD, ['a'])];
  const input = { baseRequestId: 's-old', pins: [pin('a')] };
  assert.equal(carryPins(store(same), 'p', input), 0);
  assert.deepEqual([input.baseRequestId, input.pins[0].basis], ['s-old', 's-old']);
  const other = [sync('s-old', OLD, ['a']), sync('s-new', NEW, ['a'], 'l2')];
  assert.equal(carryPins(store(other), 'p', { pins: [pin('a')] }), 0);
  assert.equal(carryPins(store(other), 'p', { pins: [] }), 0);
  // A basis the store does not know is left for the workspace to refuse.
  assert.equal(carryPins(store(other), 'p', { pins: [pin('a', 'gone')] }), 0);
});

test('pinned objects missing from the reopened Sync refuse the request, naming how many', () => {
  const rows = [sync('s-old', OLD, ['a', 'b', 'c']), sync('s-new', NEW, ['a'])];
  const input = { baseRequestId: 's-old', pins: [pin('a'), pin('b'), pin('c')] };
  assert.throws(
    () => carryPins(store(rows), 'p', input),
    (error) =>
      error instanceof PinCarryError &&
      error.code === 'PINS_NOT_FOUND' &&
      /3개 중 2개를 찾지 못했습니다/.test(error.reason) &&
      /다시 고정하세요/.test(error.reason),
  );
  // Nothing was rewritten.
  assert.equal(input.pins[1].basis, 's-old');
});

test('POST requests answers PINS_NOT_FOUND with the Korean reason', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-pin-carry-'));
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
        body: data ? JSON.stringify(data) : undefined,
      });
      return { status: reply.status, body: await reply.json() };
    };
    const project = (await api('/projects', 'POST', { name: 'P' })).body;
    const now = Date.now();
    for (const [i, row] of [sync('s-old', OLD, ['a', 'b']), sync('s-new', NEW, ['a'])].entries())
      app.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
        row.id,
        project.id,
        JSON.stringify({
          ...row.input,
          id: row.id,
          provider: 'codex-cli',
          source: 'document',
          permission: 'candidate',
          sketches: [],
          files: [],
        }),
        row.state,
        JSON.stringify(row.result),
        new Date(now + i).toISOString(),
      );
    const refused = await api(`/projects/${project.id}/requests`, 'POST', {
      host: 'rhino',
      baseRequestId: 's-old',
      body: '[고정1 · 2개] 이 기둥 스터디',
      pins: [pin('a'), pin('b')],
      sketches: [],
      files: [],
      provider: 'claude-cli',
      permission: 'candidate',
      mode: 'auto',
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'PINS_NOT_FOUND');
    assert.match(refused.body.reason, /2개 중 1개를 찾지 못했습니다\. 다시 고정하세요\./);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
