// 객체에서 기록으로 (PLAN-53 T-324, SPEC-17.5, ARCH-01 §5 「프로젝트 기록」): the object → request
// index keeps undone requests (marked), keeps the same id in two linked files apart (ADR-027),
// leaves document Syncs out, and reaches records through a part's layer or object mapping.
// All sentences are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildObjectRecordIndex,
  indexKey,
  objectEntries,
  objectRecords,
} from '../../src/core/object-record-index.ts';

const execution = (state, linkId, changes) => ({
  executionId: `x-${Math.random()}`,
  host: 'rhino',
  state,
  file: { linkId, name: `${linkId}.3dm` },
  changes,
});

const rows = [
  // A direct turn in file A: one beam added, one wall changed (host report shape).
  {
    id: 'req-1',
    input: { source: 'prompt' },
    result: {
      executions: [
        execution('applied', 'link-a', {
          added: [{ nativeId: 'beam-1', layer: 'S-BEAM' }],
          changed: [{ nativeId: 'wall-1', layer: 'A-WALL' }],
          removed: [],
        }),
      ],
    },
  },
  // The same wall changed again, then undone.
  {
    id: 'req-2',
    input: { source: 'prompt' },
    result: {
      executions: [
        execution('undone', 'link-a', {
          added: [],
          changed: [{ nativeId: 'wall-1', layer: 'A-WALL' }],
          removed: [],
        }),
      ],
    },
  },
  // File B has an object with the same id (a CAD handle reused across files).
  {
    id: 'req-3',
    input: { source: 'prompt', linkId: 'link-b' },
    result: { changes: { added: [], removed: ['wall-1'], modified: [] } },
  },
  // A document Sync lists every object; it is not a change.
  {
    id: 'sync-1',
    input: { source: 'document', linkId: 'link-a' },
    result: { changes: { added: ['beam-1', 'wall-1'], removed: [], modified: [] } },
  },
  // Model changes (`modified` with ids) under the request's own link.
  {
    id: 'req-4',
    input: { source: 'prompt', linkId: 'link-a' },
    result: {
      changes: {
        added: [],
        removed: [],
        modified: [{ id: 'beam-1', geometry: true, attributes: false, nativeIdentity: false }],
      },
    },
  },
  { id: 'req-5', input: { source: 'prompt' }, result: null },
];

test('undone requests stay in the index, marked undone', () => {
  const index = buildObjectRecordIndex(rows);
  const wall = index.get(indexKey('link-a', 'wall-1'));
  assert.deepEqual(wall.requestIds, ['req-1', 'req-2']);
  assert.deepEqual(wall.kinds, ['modified']);
  assert.equal(wall.undone, false);
  assert.deepEqual(
    wall.requests.map((ref) => [ref.requestId, ref.undone, ref.layer]),
    [
      ['req-1', false, 'A-WALL'],
      ['req-2', true, 'A-WALL'],
    ],
  );
  const onlyUndone = buildObjectRecordIndex([rows[1]]);
  assert.equal(onlyUndone.get(indexKey('link-a', 'wall-1')).undone, true);
});

test('the same id in two linked files does not collide', () => {
  const index = buildObjectRecordIndex(rows);
  assert.deepEqual(index.get(indexKey('link-b', 'wall-1')).requestIds, ['req-3']);
  assert.deepEqual(index.get(indexKey('link-b', 'wall-1')).kinds, ['removed']);
  assert.deepEqual(
    objectEntries(index, 'wall-1', 'link-b').flatMap((entry) => entry.requestIds),
    ['req-3'],
  );
  assert.deepEqual(
    objectEntries(index, 'wall-1', 'link-a').flatMap((entry) => entry.requestIds),
    ['req-1', 'req-2'],
  );
  // No file named: every file's entries.
  assert.equal(objectEntries(index, 'wall-1').length, 2);
});

test('document Syncs are left out; change kinds merge per object', () => {
  const index = buildObjectRecordIndex(rows);
  const beam = index.get(indexKey('link-a', 'beam-1'));
  assert.deepEqual(beam.requestIds, ['req-1', 'req-4']);
  assert.deepEqual(beam.kinds, ['added', 'modified']);
  for (const entry of index.values()) assert.ok(!entry.requestIds.includes('sync-1'));
});

const row = (id, date, time, extra = {}) => ({
  id,
  date,
  time,
  source: 'request',
  type: 'D',
  text: `${id} 기록`,
  state: 'kept',
  by: 'user',
  chapter: null,
  parts: [],
  follows: [],
  followedBy: [],
  attachments: {},
  undone: false,
  createdAt: `${date}T00:00:00.000Z`,
  updatedAt: `${date}T00:00:00.000Z`,
  ...extra,
});

test('records reach the object through its requests and its part mapping, by date', () => {
  const index = buildObjectRecordIndex(rows);
  const parts = [
    {
      id: 'part-wall',
      name: '외벽',
      grp: '기존',
      roleFrom: null,
      roleTo: null,
      chapter: null,
      mapping: [{ kind: 'layer', linkId: 'link-a', layer: 'A-WALL' }],
      seenAt: null,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'part-b',
      name: '다른 파일 벽',
      grp: null,
      roleFrom: null,
      roleTo: null,
      chapter: null,
      mapping: [{ kind: 'layer', linkId: 'link-b', layer: 'A-WALL' }],
      seenAt: null,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'part-group',
      name: '고른 객체',
      grp: null,
      roleFrom: null,
      roleTo: null,
      chapter: null,
      mapping: [{ kind: 'objects', linkId: 'link-a', ids: ['wall-1'] }],
      seenAt: null,
      createdAt: '',
      updatedAt: '',
    },
  ];
  const records = [
    row('r-late', '2026-09-03', '10:00', { attachments: { requestId: 'req-1' } }),
    row('r-undone', '2026-09-02', null, { attachments: { requestId: 'req-2' }, undone: true }),
    row('r-part', '2026-09-01', '09:00', { parts: ['part-wall'] }),
    row('r-group', '2026-09-04', null, { parts: ['part-group'] }),
    row('r-other-file', '2026-09-01', null, { parts: ['part-b'] }),
    row('r-dropped', '2026-09-01', null, { attachments: { requestId: 'req-1' }, state: 'dropped' }),
    row('r-unrelated', '2026-09-01', null, { attachments: { requestId: 'req-3' } }),
  ];
  const result = objectRecords({
    index,
    objectId: 'wall-1',
    linkId: 'link-a',
    records,
    parts,
    objectLayer: 'A-WALL',
  });
  assert.deepEqual(
    result.records.map((one) => one.id),
    ['r-part', 'r-undone', 'r-late', 'r-group'],
  );
  assert.equal(result.records[1].undone, true);
  assert.deepEqual(result.via, {
    requestIds: ['req-1', 'req-2'],
    partIds: ['part-wall', 'part-group'],
  });
  // Without a layer, only the object group and the requests reach it.
  const noLayer = objectRecords({ index, objectId: 'wall-1', linkId: 'link-a', records, parts });
  assert.deepEqual(noLayer.via.partIds, ['part-group']);
});
