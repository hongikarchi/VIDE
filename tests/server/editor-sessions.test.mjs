import { createServer } from 'node:net';
import { resumeEditor } from '../../hosts/rhino/editor-channel.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';

test('editor sessions route duplicate document IDs by process and never close editing windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-editors-'));
  let detached = 0,
    stopped = 0;
  const workers = [];
  try {
    const sessions = new EditorSessions({
      directory,
      executable: 'rhino',
      plugin: 'plugin',
      bootstrap: 'bootstrap',
      launch: async (options) => {
        assert.equal(options.mode, 'editor');
        assert.equal(options.visible, true);
        const pid = workers.length + 1;
        const worker = {
          identity: { pid, startTicks: '100', documentId: 7 },
          failure: null,
          detach() {
            detached++;
          },
          stop() {
            stopped++;
          },
          async inspectEditor() {
            if (this.failure) throw Object.assign(Error(this.failure), { code: this.failure });
            return {
              documentId: 7,
              name: 'Same.3dm',
              units: 'Meters',
              objectCount: 1,
              modified: true,
              documentHash: 'a'.repeat(64),
              selectedIds: [],
            };
          },
          async captureEditor() {
            return { pid };
          },
        };
        workers.push(worker);
        return worker;
      },
    });
    const first = await sessions.open({ filename: 'first', fileHash: 'a'.repeat(64) }),
      second = await sessions.open({ filename: 'second', fileHash: 'b'.repeat(64) });
    assert.equal(detached, 2);
    assert.deepEqual(
      (await sessions.list()).documents.map((row) => row.instance),
      ['1:100', '2:100'],
    );
    assert.deepEqual(await sessions.capture(second), { pid: 2 });
    await assert.rejects(sessions.capture({ ...first, documentId: 8 }), {
      code: 'STALE_CONNECTION',
    });
    workers[0].failure = 'HOST_RESULT_UNKNOWN';
    assert.equal((await sessions.list()).documents.length, 1);
    assert.equal(await sessions.has(first.instance), true);
    workers[0].failure = null;
    assert.equal((await sessions.list()).documents.length, 2);
    workers[0].failure = 'HOST_LEASE_EXPIRED';
    await sessions.list();
    assert.equal(await sessions.has(first.instance), false);
    assert.equal(stopped, 0);
  } finally {
    await rm(directory + '.editors.json', { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('persisted editors restore without launching or replaying and malformed registry fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-editors-resume-')),
    registry = directory + '.editors.json';
  const connection = {
    identity: {
      pid: 42,
      startTicks: '123456789',
      sessionId: '356ff01d-b586-460c-8e2b-8c9f3c083e96',
      documentId: 7,
      revision: 0,
      port: 12345,
    },
    token: 'a'.repeat(64),
    executable: resolve('Rhino.exe'),
  };
  let resumes = 0;
  try {
    await writeFile(registry, JSON.stringify([connection]));
    const sessions = new EditorSessions({
      directory,
      executable: connection.executable,
      plugin: 'p',
      bootstrap: 'b',
      launch: async () => {
        throw Error('Must not launch');
      },
      resume: (saved, executable) => {
        resumes++;
        assert.deepEqual(saved, connection);
        assert.equal(executable, connection.executable);
        return {
          identity: saved.identity,
          editorConnection: saved,
          inspectEditor: async () => ({
            documentId: 7,
            name: 'Editing',
            units: 'Meters',
            objectCount: 1,
            modified: true,
          }),
          captureEditor: async () => ({ filename: 'captured' }),
        };
      },
    });
    assert.equal(await sessions.has('42:123456789'), true);
    assert.equal((await sessions.list()).documents[0].modified, true);
    assert.deepEqual(await sessions.capture({ instance: '42:123456789', documentId: 7 }), {
      filename: 'captured',
    });
    assert.equal(resumes, 1);
    await writeFile(registry, '{"broken":true}');
    const broken = new EditorSessions({
      directory,
      executable: connection.executable,
      plugin: 'p',
      bootstrap: 'b',
    });
    await assert.rejects(() => broken.has('42:123456789'), { code: 'EDITOR_REGISTRY_INVALID' });
  } finally {
    await rm(registry, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('reconnected editor refuses reused PID or foreign listener before sending its token', async () => {
  let bytes = 0;
  const sockets = new Set(),
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('data', (chunk) => (bytes += chunk.length));
      socket.on('close', () => sockets.delete(socket));
    });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const executable = resolve('Rhino.exe'),
    connection = {
      identity: {
        pid: 42,
        startTicks: '100',
        sessionId: '356ff01d-b586-460c-8e2b-8c9f3c083e96',
        documentId: 7,
        revision: 0,
        port: server.address().port,
      },
      token: 'a'.repeat(64),
      executable,
    };
  try {
    for (const observed of [
      { pid: 42, startTicks: '101', executable, listeners: [42] },
      { pid: 42, startTicks: '100', executable, listeners: [43] },
    ]) {
      const editor = resumeEditor(connection, executable, async () => observed);
      assert.equal(editor.stop, undefined);
      assert.equal(editor.execute, undefined);
      await assert.rejects(() => editor.inspectEditor(), { code: 'HOST_OWNERSHIP_MISMATCH' });
    }
    assert.equal(bytes, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
