// T-362: a document Rhino opened read-only. The plugin's snapshot (`readOnly`) or a
// DOCUMENT_READ_ONLY refusal marks the attached document; the open-documents list carries
// `readOnly: true` (the links list and the panel show '읽기 전용으로 열림 · 저장 불가'); a snapshot
// that says writable clears it. Fake attached connection, no Rhino.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { READ_ONLY_SAVE_NOTICE, READ_ONLY_STATUS } from '../../src/contracts/direct-refusal.ts';

const sessionId = '0f6c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const hash = 'b'.repeat(64);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-readonly-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const connections = join(directory, 'rhino-connections');
  await mkdir(connections);
  const identity = {
    port: 40123,
    pid: 4321,
    startTicks: '99',
    sessionId,
    documentId: 3,
    revision: 0,
  };
  await writeFile(
    join(connections, sessionId + '.json'),
    JSON.stringify({ identity, token: 'c'.repeat(64), executable: join(directory, 'Rhino.exe') }),
  );
  const host = { readOnly: true, refuse: false };
  const snapshot = () => ({
    ok: true,
    documentId: 3,
    name: '191MB.3dm',
    units: 'Millimeters',
    objectCount: 5,
    modified: false,
    readOnly: host.readOnly,
    documentHash: hash,
    selectedIds: [],
  });
  const worker = {
    identity,
    async attachedStatus() {
      const { readOnly: _readOnly, documentHash: _hash, ...rest } = snapshot();
      return { ...rest, path: 'C:/work/191MB.3dm', generation: 1, live: false, busy: false };
    },
    async inspectEditor() {
      return snapshot();
    },
    async directExecute() {
      if (host.refuse)
        throw Object.assign(new Error('DOCUMENT_READ_ONLY'), { code: 'DOCUMENT_READ_ONLY' });
      return { ok: true };
    },
  };
  const sessions = new EditorSessions({
    directory: join(directory, 'editors'),
    executable: join(directory, 'Rhino.exe'),
    resume: () => worker,
  });
  const target = { instance: `4321:99:${sessionId}`, documentId: 3 };
  const listed = async () => (await sessions.list(true)).documents[0];
  return { sessions, host, target, listed };
}

test('read-only snapshot → listed readOnly; writable snapshot → cleared', async (t) => {
  const { sessions, host, target, listed } = await fixture(t);
  // Not known before Rhino reported a snapshot.
  assert.equal((await listed()).readOnly, undefined);
  await sessions.inspect(target);
  assert.equal(sessions.readOnly(target), true);
  assert.equal((await listed()).readOnly, true);
  // Rhino closed and reopened the file writable: the next snapshot clears it.
  host.readOnly = false;
  await sessions.inspect(target);
  assert.equal(sessions.readOnly(target), false);
  assert.equal((await listed()).readOnly, undefined);
});

test('a DOCUMENT_READ_ONLY refusal marks the document too', async (t) => {
  const { sessions, host, target } = await fixture(t);
  host.refuse = true;
  await assert.rejects(sessions.directExecute(target, {}), { code: 'DOCUMENT_READ_ONLY' });
  assert.equal(sessions.readOnly(target), true);
});

test('the status and the notice say what the user sees', () => {
  assert.equal(READ_ONLY_STATUS, '읽기 전용으로 열림 · 저장 불가');
  assert.match(READ_ONLY_SAVE_NOTICE, /읽기 전용으로 열려 있어 Rhino에서 저장할 수 없습니다/);
  assert.match(READ_ONLY_SAVE_NOTICE, /다른 이름으로 저장하거나 Rhino를 완전히 닫고 다시 여세요/);
});
