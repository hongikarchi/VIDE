// T-285: while a ZWCAD Sync reads its pages, the connection list answers with the status that Sync
// read at its start instead of asking the plugin again between pages (HOST-ZWCAD §1.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AttachedZwcadDocuments } from '../../hosts/zwcad/attached-documents.ts';

const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const instance = `1:2:${session}`;
const target = { instance, documentId: 1 };
const status = (revision) => ({
  ok: true,
  name: 'A.dwg',
  path: 'C:/d/A.dwg',
  units: 'Millimeters',
  objectCount: 1,
  modified: false,
  documentHash: String(revision).padStart(64, '0'),
  revision,
  generation: 1,
  live: false,
  hostBusy: false,
});
const page = (params) => ({
  ok: true,
  offset: params.offset,
  total: 1,
  next: 1,
  revision: 6,
  objects: [],
  scene: [],
  displayed: 0,
  omitted: 1,
  omittedTypes: { Hidden: 1 },
  displayWarnings: {},
});

function adapter() {
  const calls = [];
  let release;
  const paged = new Promise((resolve) => (release = resolve));
  const zwcad = new AttachedZwcadDocuments('unused');
  zwcad.discover = async () => {};
  zwcad.connections = new Map([[instance, {}]]);
  zwcad.call = async (_target, method, params) => {
    calls.push(method);
    if (method === 'attachedStatus') return status(6);
    await paged;
    return page(params);
  };
  return { zwcad, calls, release };
}

test('the list does not ask the plugin for status while a Sync reads that drawing', async () => {
  const { zwcad, calls, release } = adapter();
  const sync = zwcad.capture(target);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['attachedStatus', 'displayPage']);
  const [row] = await zwcad.list();
  assert.equal(row.name, 'A.dwg');
  assert.equal(row.objectCount, 1);
  assert.deepEqual(calls, ['attachedStatus', 'displayPage'], 'no status call between pages');
  release();
  const captured = await sync;
  assert.equal(captured.displayCoverage.total, 1);
  await zwcad.list();
  assert.equal(
    calls.filter((method) => method === 'attachedStatus').length,
    3,
    'asked again after',
  );
});

test('a failed Sync stops answering the list from its status', async () => {
  const { zwcad, calls } = adapter();
  zwcad.call = async (_target, method) => {
    calls.push(method);
    if (method === 'attachedStatus') return status(6);
    throw Object.assign(new Error('SOURCE_CHANGED'), { code: 'SOURCE_CHANGED' });
  };
  await assert.rejects(zwcad.capture(target), { code: 'SOURCE_CHANGED' });
  await zwcad.list();
  assert.deepEqual(calls, ['attachedStatus', 'displayPage', 'attachedStatus']);
});
