import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyWatch } from '../../src/server/read-only-watch.ts';

const target = {
  instance: '34792:639264181986160187:96be63f4-6fea-46eb-8f18-33ebeb553815',
  documentId: 7,
};

// 2026-10-01: a document Rhino opened read-only is logged once per document per Rhino session,
// in the background, with what could explain it. Writable documents leave nothing.
test('a read-only document is logged once, with the file evidence; writable ones never', async () => {
  const lines = [],
    queried = [];
  const watch = new ReadOnlyWatch({
    write: (event, fields) => lines.push({ event, ...fields }),
    describe: async () => ({ name: '구조.3dm', path: 'D:\\work\\구조.3dm' }),
    lockExists: async (path) => path === 'D:\\work\\구조.rhl',
    query: async (path) => {
      queried.push(path);
      return {
        attributes: 'ReadOnly, Archive',
        rhino: [{ pid: 34792, started: '2026-10-01T02:23:18Z', file: '구조.3dm' }],
        holders: [{ pid: 34792, name: 'Rhinoceros 8', started: '2026-10-01T02:23:18Z' }],
      };
    },
  });
  assert.equal(watch.note(target, { readOnly: false, name: '구조.3dm' }), false);
  assert.equal(watch.note(target, { name: '구조.3dm' }), false);
  assert.equal(watch.note(target, { readOnly: true, name: '구조.3dm' }), true);
  assert.equal(watch.note(target, { readOnly: true, name: '구조.3dm' }), false);
  // Another document, or the same one in another Rhino session, is its own entry.
  assert.equal(watch.note({ ...target, documentId: 8 }, { readOnly: true }), true);
  await watch.settled();
  assert.equal(lines.length, 2);
  assert.deepEqual(queried, ['D:\\work\\구조.3dm', 'D:\\work\\구조.3dm']);
  const [line] = lines;
  assert.equal(line.event, 'document-read-only');
  assert.equal(line.host, 'rhino');
  assert.equal(line.documentId, 7);
  assert.equal(line.path, 'D:\\work\\구조.3dm');
  assert.equal(line.attributes, 'ReadOnly, Archive');
  assert.deepEqual(line.lockFiles, [
    { path: 'D:\\work\\구조.rhl', exists: true },
    { path: 'D:\\work\\구조.3dm.rhl', exists: false },
  ]);
  assert.equal(line.holders[0].pid, 34792);
  assert.equal(line.errors, undefined);
});

test('the log never waits for or fails with the evidence query', async () => {
  const lines = [];
  let release;
  const watch = new ReadOnlyWatch({
    write: (event, fields) => lines.push({ event, ...fields }),
    describe: async () => {
      throw new Error('HOST_BUSY');
    },
    query: () =>
      new Promise((_, reject) => (release = () => reject(new Error('powershell timed out')))),
  });
  // Returns at once; nothing is written until the query settles.
  assert.equal(watch.note(target, { readOnly: true, name: 'a.3dm' }), true);
  assert.equal(lines.length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await watch.settled();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].name, 'a.3dm');
  assert.equal(lines[0].path, undefined);
  assert.deepEqual(lines[0].lockFiles, []);
  assert.deepEqual(lines[0].errors, ['describe: HOST_BUSY', 'query: powershell timed out']);
});
