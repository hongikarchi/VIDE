// 부위별 모델 묶음 (PLAN-53 T-333, src/core/records-scene.ts): the shown objects grouped by the 부위
// 사전's mappings — exact layer paths (no sub-layers), listed own ids, files apart (two files with the
// same layer and the same ids), unresolved jig outputs and files not drawn, 그 밖 — then the cursor's
// levels, the [분리] offsets, the episodes, the same output for the same input, and 20,000 objects
// under 200 ms. The fixture is made up: 15 parts and 500 objects on two linked files and one result.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVEL_DIM,
  LEVEL_ON,
  LEVEL_OTHER,
  bundleParts,
  layerIndexOf,
  objectLevels,
  partLevels,
  sceneEpisodes,
  sceneGroups,
  separationVectors,
} from '../../src/core/records-scene.ts';
import { dayNumber } from '../../src/core/records-chart.ts';

function objects() {
  const out = [];
  // File A: 300 objects o0…o299 on L0…L19; every 60th sits on the sub-layer L0::sub.
  for (let i = 0; i < 300; i++)
    out.push({
      id: `link-a::o${i}`,
      sourceId: `o${i}`,
      documentKey: 'link-a',
      layerName: i % 60 === 0 ? 'L0::sub' : `L${i % 20}`,
    });
  // File B: 180 objects with the same own ids o0…o179 and the same layer names L0…L17.
  for (let j = 0; j < 180; j++)
    out.push({
      id: `link-b::o${j}`,
      sourceId: `o${j}`,
      documentKey: 'link-b',
      layerName: `L${j % 18}`,
    });
  // A result that belongs to no file: always 그 밖.
  for (let k = 0; k < 20; k++)
    out.push({
      id: `result:r1::x${k}`,
      sourceId: `x${k}`,
      documentKey: 'result:r1',
      layerName: 'L0',
    });
  return out;
}
const part = (id, grp, mapping) => ({
  id,
  name: `부위 ${id}`,
  grp,
  roleFrom: null,
  roleTo: null,
  chapter: null,
  mapping,
  seenAt: null,
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-01T00:00:00Z',
});
function parts() {
  const out = [];
  for (let i = 0; i < 10; i++)
    out.push(
      part(`p${i}`, i < 7 ? '신설' : '기존', [{ kind: 'layer', linkId: 'link-a', layer: `L${i}` }]),
    );
  for (let i = 0; i < 3; i++)
    out.push(part(`p${10 + i}`, '기존', [{ kind: 'layer', linkId: 'link-b', layer: `L${i}` }]));
  out.push(
    part('p13', '증축', [
      { kind: 'objects', linkId: 'link-b', ids: ['o0', 'o1', 'o2', 'o3', 'o4', 'o999'] },
    ]),
  );
  out.push(
    part('p14', null, [
      { kind: 'jig-output', instanceId: 'jig-1', outputId: 'out-1' },
      { kind: 'layer', linkId: 'link-z', layer: 'L0' },
    ]),
  );
  return out;
}
const record = (id, date, partIds, extra = {}) => ({
  id,
  date,
  time: null,
  source: 'note',
  type: 'D',
  text: `기록 ${id} — 두께 다시 보기`,
  state: 'kept',
  by: '설계자',
  chapter: null,
  parts: partIds,
  follows: [],
  followedBy: [],
  attachments: {},
  undone: false,
  createdAt: `${date}T09:00:00Z`,
  updatedAt: `${date}T09:00:00Z`,
  ...extra,
});

test('bundles: exact layers, listed ids, files apart, unresolved and 그 밖', () => {
  const shown = objects();
  const scene = bundleParts({ parts: parts(), objects: shown, layerIndex: layerIndexOf(shown) });
  assert.equal(scene.bundles.length, 15);
  const sizes = Object.fromEntries(scene.bundles.map((b) => [b.partId, b.objectIds.length]));
  // L0 of file A loses the five objects on L0::sub (sub-layers are not included).
  assert.equal(sizes.p0, 10);
  for (let i = 1; i < 10; i++) assert.equal(sizes[`p${i}`], 15);
  for (let i = 10; i < 13; i++) assert.equal(sizes[`p${i}`], 10);
  // o0…o4 of file B only (file A's o0…o4 are other objects); o999 is not drawn.
  assert.deepEqual(
    scene.bundles[13].objectIds,
    ['o0', 'o1', 'o2', 'o3', 'o4'].map((o) => `link-b::${o}`),
  );
  assert.equal(sizes.p14, 0);
  assert.deepEqual(scene.bundles[14].unresolved, [0, 1]);
  assert.ok(scene.bundles.slice(0, 14).every((b) => b.unresolved.length === 0));
  // No object of one file lands in a part mapped to the other.
  for (const b of scene.bundles.slice(0, 10))
    assert.ok(b.objectIds.every((id) => id.startsWith('link-a::')));
  for (const b of scene.bundles.slice(10, 14))
    assert.ok(b.objectIds.every((id) => id.startsWith('link-b::')));
  // 145 (file A) + 30 (file B layers) + 2 (o3, o4 of file B) bundled; the rest is 그 밖.
  const bundled = new Set(scene.bundles.flatMap((b) => b.objectIds));
  assert.equal(bundled.size, 177);
  assert.equal(scene.unmapped.length, 500 - 177);
  assert.ok(scene.unmapped.includes('result:r1::x0'));
  assert.ok(scene.unmapped.includes('link-a::o0'));
  // An object in two parts is in both bundles.
  assert.deepEqual(scene.partsOf.get('link-b::o0'), ['p10', 'p13']);
});

test('same input, same bundles; the layer index is optional', () => {
  const a = bundleParts({ parts: parts(), objects: objects() });
  const b = bundleParts({
    parts: parts(),
    objects: objects(),
    layerIndex: layerIndexOf(objects()),
  });
  assert.deepEqual(a, b);
  assert.deepEqual(bundleParts({ parts: parts(), objects: objects() }), a);
});

test('levels: records up to the cursor light their parts; brightest part wins; 그 밖', () => {
  const scene = bundleParts({ parts: parts(), objects: objects() });
  const records = [
    record('r1', '2026-04-01', ['p0']),
    record('r2', '2026-05-01', ['p10']),
    record('r3', '2026-04-01', ['p1'], { state: 'candidate' }),
    record('r4', '2026-04-01', ['p2'], { supersededBy: 'r9' }),
    record('r5', '2026-06-01', ['p13']),
  ];
  const lit = (levels) => [...levels].filter(([, level]) => level === 'on').map(([id]) => id);
  assert.deepEqual(lit(partLevels(scene, records, dayNumber('2026-03-31'))), []);
  assert.deepEqual(lit(partLevels(scene, records, dayNumber('2026-04-15'))), ['p0']);
  assert.deepEqual(lit(partLevels(scene, records, dayNumber('2026-06-01'))), ['p0', 'p10', 'p13']);
  assert.equal(lit(partLevels(scene, records, 0, { all: true })).length, 15);
  assert.deepEqual(lit(partLevels(scene, records, 0, { episode: new Set(['p3', 'p13']) })), [
    'p3',
    'p13',
  ]);

  const may = objectLevels(scene, partLevels(scene, records, dayNumber('2026-05-01')));
  assert.equal(Object.keys(may).length, 500);
  assert.equal(may['link-b::o0'], LEVEL_ON); // p10 on, p13 dim → the brighter
  assert.equal(may['link-b::o3'], LEVEL_DIM); // p13 only
  assert.equal(may['link-a::o1'], LEVEL_DIM);
  assert.equal(may['link-a::o0'], LEVEL_OTHER); // L0::sub
  assert.equal(may['result:r1::x3'], LEVEL_OTHER);
  const june = objectLevels(scene, partLevels(scene, records, dayNumber('2026-06-01')));
  assert.equal(june['link-b::o3'], LEVEL_ON);
});

test('[분리]: 신설 in place, the next groups 1.2 model widths apart along x', () => {
  const scene = bundleParts({ parts: parts(), objects: objects() });
  assert.deepEqual(sceneGroups(scene), ['신설', '기존', '증축']);
  const vectors = separationVectors(scene, { min: [0, 0, 0], max: [10, 4, 3] });
  assert.equal(vectors['link-a::o1'], undefined); // p1 신설
  assert.deepEqual(vectors['link-a::o7'], [12, 0, 0]); // p7 기존
  assert.deepEqual(vectors['link-b::o0'], [12, 0, 0]); // p10 기존 before p13 증축
  assert.deepEqual(vectors['link-b::o3'], [24, 0, 0]); // p13 증축 only
  assert.equal(vectors['result:r1::x0'], undefined);
});

test('episodes: chapters first, then joined records', () => {
  const records = [
    record('a', '2026-04-01', ['p0'], { chapter: '설계', follows: ['b'] }),
    record('b', '2026-04-03', ['p1'], { follows: ['c'] }),
    record('c', '2026-04-05', ['p2'], { chapter: '설계' }),
    record('d', '2026-04-02', ['p3'], { chapter: '계획' }),
    record('e', '2026-04-02', [], { chapter: '계획' }),
    record('f', '2026-04-02', ['p4'], { chapter: '시공', state: 'candidate' }),
  ];
  const episodes = sceneEpisodes(records);
  assert.deepEqual(
    episodes.map((e) => [e.kind, e.name, e.recordIds.join(','), e.partIds.join(',')]),
    [
      ['chapter', '계획', 'd', 'p3'],
      ['chapter', '설계', 'a,c', 'p0,p2'],
      ['chain', '이야기 · 기록 a — 두께 다시…', 'a,b,c', 'p0,p1,p2'],
    ],
  );
});

test('20,000 objects and 30 parts bundle under 200 ms (median of 5)', () => {
  const shown = [];
  for (let i = 0; i < 20_000; i++)
    shown.push({
      id: `link-${i % 2}::${i}`,
      sourceId: String(i),
      documentKey: `link-${i % 2}`,
      layerName: `건물::층${i % 40}`,
    });
  const many = [];
  for (let p = 0; p < 30; p++)
    many.push(
      part(`q${p}`, p % 2 ? '기존' : '신설', [
        { kind: 'layer', linkId: `link-${p % 2}`, layer: `건물::층${p}` },
        ...(p === 29
          ? [
              {
                kind: 'objects',
                linkId: 'link-1',
                ids: Array.from({ length: 500 }, (_, k) => String(k * 2 + 1)),
              },
            ]
          : []),
      ]),
    );
  const runs = [];
  let scene;
  for (let run = 0; run < 6; run++) {
    const began = performance.now();
    scene = bundleParts({ parts: many, objects: shown, layerIndex: layerIndexOf(shown) });
    if (run) runs.push(performance.now() - began);
  }
  runs.sort((a, b) => a - b);
  const median = runs[2];
  console.log(`bundle 20,000 objects × 30 parts: median ${median.toFixed(1)} ms`);
  assert.ok(median <= 200, `${median} ms`);
  assert.equal(scene.ids.length, 20_000);
  const levelsRuns = [];
  for (let run = 0; run < 6; run++) {
    const began = performance.now();
    objectLevels(scene, partLevels(scene, [], 0, { all: run % 2 === 0 }));
    if (run) levelsRuns.push(performance.now() - began);
  }
  levelsRuns.sort((a, b) => a - b);
  console.log(`levels 20,000 objects: median ${levelsRuns[2].toFixed(1)} ms`);
});
