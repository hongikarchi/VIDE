// T-298 (SPEC-07.5 7, SPEC-01.11 4): a closed linked file's last Sync is not where a jig role reads
// from by default, and a view action's notice counts the open file's targets, per file when the
// targets span several files.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOSED_SOURCE_NOTE,
  findOrder,
  linkClosed,
  fromClosedLink,
  pickOrder,
  roleSyncs,
} from '../../src/ui/jig-panel/role-sources.ts';
import { viewCount } from '../../src/ui/request-route.ts';

// Round 5 shape: the round-1 link (closed) has an older and a latest Sync, the open link one Sync.
const sources = [
  { id: 's-old', linkId: 'L-closed', latest: false, closed: true, at: '2026-10-10T01:00:00Z' },
  { id: 's-closed', linkId: 'L-closed', latest: true, closed: true, at: '2026-10-10T02:00:00Z' },
  { id: 's-open', linkId: 'L-open', latest: true, closed: false, at: '2026-10-14T05:00:00Z' },
  { id: 's-open-old', linkId: 'L-open', latest: false, closed: false, at: '2026-10-14T04:00:00Z' },
];

test('a role reads the open link first; the closed link only as a fallback', () => {
  const syncs = roleSyncs(sources);
  assert.deepEqual(syncs, { open: ['s-open'], closed: ['s-closed'] });
  assert.deepEqual(pickOrder(syncs), ['s-open', 's-closed']);
  assert.deepEqual(findOrder(syncs), ['s-open']);
  // No file open: the closed files' latest Syncs are the only place to look.
  const allClosed = roleSyncs(sources.map((s) => ({ ...s, closed: true })));
  assert.deepEqual(findOrder(allClosed), ['s-open', 's-closed']);
});

test('several open links: newest latest Sync first, older Syncs never', () => {
  const syncs = roleSyncs([
    { id: 'a', linkId: 'A', latest: true, closed: false, at: '2026-10-14T01:00:00Z' },
    { id: 'b', linkId: 'B', latest: true, closed: false, at: '2026-10-14T03:00:00Z' },
    { id: 'b0', linkId: 'B', latest: false, closed: false, at: '2026-10-14T02:00:00Z' },
  ]);
  assert.deepEqual(syncs, { open: ['b', 'a'], closed: [] });
});

test('a list without linked files keeps every Sync, newest first', () => {
  assert.deepEqual(roleSyncs([{ id: 'x' }, { id: 'y' }]), { open: ['y', 'x'], closed: [] });
});

test('a role read from a closed link is marked', () => {
  assert.equal(CLOSED_SOURCE_NOTE, '닫힌 연결 기준');
  assert.equal(fromClosedLink([{ linkId: 'sync:s-closed' }], sources), true);
  assert.equal(fromClosedLink([{ linkId: 'sync:s-open' }], sources), false);
  // Read by link id (the conversation path).
  assert.equal(fromClosedLink([{ linkId: 'L-closed' }], sources), true);
  assert.equal(fromClosedLink([{ linkId: 'L-open' }], sources), false);
  assert.equal(fromClosedLink(undefined, sources), false);
});

test('a view notice counts the open file and names each file', () => {
  // 5 Rhino rows drawn: 453 beams each, only r5-small.3dm open (R1-HIDE: 2,265 = 453 × 5).
  const files = ['r5', 'p1', 'p2', 'r3', 'r4'];
  const objects = files.flatMap((key) =>
    Array.from({ length: 453 }, (_, i) => ({
      id: `${key}::b${i}`,
      documentKey: key,
      documentName: `${key}-small.3dm`,
    })),
  );
  const ids = objects.map((o) => o.id);
  const counted = viewCount(ids, objects, new Set(['r5']));
  assert.equal(counted.count, 453);
  assert.equal(
    counted.files,
    '파일별 r5-small.3dm 453 · p1-small.3dm(닫힘) 453 · p2-small.3dm(닫힘) 453 · 외 2개 파일 906',
  );
  // One file: no per-file list.
  const one = viewCount(ids.slice(0, 10), objects, new Set(['r5']));
  assert.deepEqual(one, { count: 10, files: '' });
  // Targets only in closed files: the whole count.
  const closedOnly = viewCount(ids.slice(453, 463), objects, new Set(['r5']));
  assert.deepEqual(closedOnly, { count: 10, files: '' });
  const twoClosed = viewCount([ids[453], ids[906]], objects, new Set(['r5']));
  assert.equal(twoClosed.count, 2);
  assert.equal(twoClosed.files, '파일별 p1-small.3dm(닫힘) 1 · p2-small.3dm(닫힘) 1');
});

// Review of wave 5: a file entry (kind 'file': a 3DM/DWG opened in VIDE, a file put in by
// [모델에 반영]) has no connection by nature and is never a closed link (SPEC-07.5 7, SPEC-01.11 4).
test('an open Rhino link and a file entry: both are role sources, neither is marked closed', () => {
  assert.equal(linkClosed({ kind: 'file', connection: null }), false);
  assert.equal(linkClosed({ kind: 'host', connection: null }), true);
  assert.equal(linkClosed({ kind: 'host', connection: { instance: 'r' } }), false);
  assert.equal(linkClosed({ connection: undefined }), true);
  const links = [
    { id: 'L-open', kind: 'host', connection: { instance: 'r' } },
    { id: 'L-file', kind: 'file', connection: null },
  ];
  const syncs = roleSyncs([
    {
      id: 's-open',
      linkId: 'L-open',
      latest: true,
      closed: linkClosed(links[0]),
      at: '2026-10-14T05:00:00Z',
    },
    {
      id: 's-file',
      linkId: 'L-file',
      latest: true,
      closed: linkClosed(links[1]),
      at: '2026-10-14T06:00:00Z',
    },
  ]);
  assert.deepEqual(findOrder(syncs), ['s-file', 's-open']);
  assert.equal(
    fromClosedLink(
      [{ linkId: 'sync:s-file' }],
      [{ id: 's-file', linkId: 'L-file', latest: true, closed: linkClosed(links[1]) }],
    ),
    false,
  );
  // A view notice counts the file entry's targets as open (no '(닫힘)').
  const objects = [
    { id: 'a', documentKey: 'L-open', documentName: 'open.3dm' },
    { id: 'b', documentKey: 'L-file', documentName: '배치.3dm' },
  ];
  const openKeys = new Set(links.filter((l) => !linkClosed(l)).map((l) => l.id));
  const counted = viewCount(['a', 'b'], objects, openKeys);
  assert.equal(counted.count, 2);
  assert.doesNotMatch(counted.files, /닫힘/);
});
