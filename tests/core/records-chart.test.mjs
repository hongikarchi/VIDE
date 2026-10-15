// 부위×시간 차트 data and layout (PLAN-53 T-327, src/core/records-chart.ts): rows in the three
// modes, chains and roots, the 알려짐 선, numbers and the index, label lanes with no overlaps, and
// the same output for the same input. The fixture is made up: 80 records over six months on eight
// parts (four new, four existing), six stories joined by follows, three milestones.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecordsChart,
  chainMembers,
  labelWidth,
  labelsOverlap,
  layoutRecordsChart,
  recordChains,
  shortText,
} from '../../src/core/records-chart.ts';

const PART_NAMES = [
  ['p1', '지붕 트러스', '신설'],
  ['p2', '북측 계단실', '신설'],
  ['p3', '남측 창호', '신설'],
  ['p4', '2층 슬래브', '신설'],
  ['p5', '동측 옹벽', '기존'],
  ['p6', '기초', '기존'],
  ['p7', '서측 외벽', '기존'],
  ['p8', '지하 기계실', '기존'],
];
const TYPES = ['R', 'I', 'K', 'E', 'D'];
const CHAPTERS = ['계획', '설계', '시공'];

function fixture() {
  const parts = PART_NAMES.map(([id, name, grp], i) => ({
    id,
    name,
    grp,
    roleFrom: i % 2 ? '창고' : null,
    roleTo: i % 2 ? '거실' : null,
    chapter: CHAPTERS[i % 3],
    mapping: [],
    seenAt: id === 'p6' ? '2026-05-20' : null,
    createdAt: `2026-04-01T00:00:0${i}Z`,
    updatedAt: `2026-04-01T00:00:0${i}Z`,
  }));
  const records = [];
  for (let i = 0; i < 80; i++) {
    const day = new Date(Date.UTC(2026, 3, 1 + Math.floor(i * 2.2)));
    const date = day.toISOString().slice(0, 10);
    const part = PART_NAMES[i % 8][0];
    records.push({
      id: `r${String(i).padStart(3, '0')}`,
      date,
      time:
        i % 3
          ? `${String(9 + (i % 8)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`
          : null,
      source: 'note',
      type: TYPES[i % 5],
      text: `${PART_NAMES[i % 8][1]} 검토 메모 ${i + 1}번 — 두께와 마감을 다시 본다`,
      state: i % 9 === 4 ? 'candidate' : 'kept',
      by: 'user',
      chapter: CHAPTERS[Math.floor(i / 27)],
      parts: i % 10 === 7 ? [part, PART_NAMES[(i + 3) % 8][0]] : i % 13 === 12 ? [] : [part],
      follows: [],
      followedBy: [],
      attachments: {},
      undone: false,
      createdAt: `2026-04-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`,
      updatedAt: '2026-04-01T00:00:00Z',
    });
  }
  // Six stories: records 8 apart on the same part, five long each (all kept).
  const byId = new Map(records.map((row) => [row.id, row]));
  const join = (a, b) => {
    byId.get(a).follows.push(b);
    byId.get(b).followedBy.push(a);
  };
  const stories = [];
  for (let s = 0; s < 6; s++) {
    const ids = [0, 1, 2, 3, 4].map((k) => `r${String(s * 3 + 1 + k * 8).padStart(3, '0')}`);
    for (const id of ids) byId.get(id).state = 'kept';
    for (let k = 0; k + 1 < ids.length; k++) join(ids[k], ids[k + 1]);
    stories.push(ids);
  }
  const milestones = [
    { id: 'm1', label: '당선', date: '2026-04-20' },
    { id: 'm2', label: '납품', date: '2026-06-30' },
    { id: 'm3', label: '착공', date: '2026-08-15' },
  ];
  return { records, parts, milestones, stories };
}

test('chains: one per story, rooted at its first record, in list order', () => {
  const { records, stories } = fixture();
  const chains = recordChains(records);
  assert.equal(chains.length, 6);
  assert.deepEqual(
    chains.map((chain) => chain.root),
    stories.map((ids) => ids[0]),
  );
  assert.deepEqual(chains[2].ids, stories[2]);
  assert.deepEqual([...chainMembers(chains, stories[1][2])].sort(), [...stories[1]].sort());
  assert.deepEqual([...chainMembers(chains, 'r000')], ['r000']);
});

test('model: 남김 only by default, numbers by date and time, roots marked, links dashed per story', () => {
  const { records, parts, milestones } = fixture();
  const kept = records.filter((row) => row.state === 'kept');
  const model = buildRecordsChart({ records, parts, milestones, rowMode: 'part' });
  assert.equal(model.index.length, kept.length);
  assert.deepEqual(
    model.index.map((entry) => entry.number),
    kept.map((_, i) => i + 1),
  );
  assert.ok(model.index.every((entry, i, all) => !i || all[i - 1].date <= entry.date));
  assert.equal(model.chains.length, 6);
  assert.equal(new Set(model.items.filter((item) => item.root).map((item) => item.record)).size, 6);
  assert.ok(model.items.every((item) => !item.hollow));
  assert.equal(model.links.length, 24);
  assert.ok(model.links.every((link) => link.kind === 'follows'));
  const dashed = buildRecordsChart({
    records,
    parts,
    milestones,
    rowMode: 'part',
    chainStyle: 'dashed',
  });
  assert.deepEqual([...new Set(dashed.links.map((link) => link.kind))].sort(), [
    'follows-0',
    'follows-1',
    'follows-2',
    'follows-3',
  ]);
  // Candidates on: hollow items join.
  const both = buildRecordsChart({
    records,
    parts,
    milestones,
    rowMode: 'part',
    states: ['candidate', 'kept'],
  });
  assert.equal(both.index.length, 80);
  assert.ok(both.items.some((item) => item.hollow));
  // Type toggles: counts stay those before the toggle.
  const onlyD = buildRecordsChart({ records, parts, milestones, rowMode: 'type', types: ['D'] });
  assert.equal(onlyD.typeCounts.R, model.typeCounts.R);
  assert.ok(onlyD.items.every((item) => item.kind === 'record:D'));
  assert.equal(milestones.length, model.milestones.length);
  assert.ok(model.monthGrid.length >= 5);
  assert.ok(model.density.every((entry) => entry.count > 0 && CHAPTERS.includes(entry.chapter)));
});

test('rows: part (new then existing, then 부위 없음), type and chapter modes place y by row', () => {
  const { records, parts, milestones } = fixture();
  for (const [mode, expected] of [
    ['part', [...PART_NAMES.map(([, name]) => name), '부위 없음']],
    ['type', ['요구', '의도', '앎', '근거', '결정']],
    ['chapter', ['계획', '설계', '시공']],
  ]) {
    const model = buildRecordsChart({ records, parts, milestones, rowMode: mode });
    assert.deepEqual(
      model.rows.map((row) => row.label),
      expected,
      mode,
    );
    const layout = layoutRecordsChart(model, { width: 1100 });
    const rowY = new Map(layout.rows.map((row) => [row.id, row]));
    for (let i = 1; i < layout.rows.length; i++)
      assert.equal(layout.rows[i].y, layout.rows[i - 1].y + layout.rows[i - 1].height);
    for (const item of model.items) {
      const placed = layout.items.get(item.id);
      const row = rowY.get(item.row);
      assert.ok(placed.y > row.y && placed.y < row.y + row.height, `${mode} ${item.id}`);
    }
    assert.equal(labelsOverlap(layout), 0, mode);
  }
  // Multi-part records sit on both rows, one number.
  const model = buildRecordsChart({ records, parts, milestones, rowMode: 'part' });
  const multi = model.items.filter((item) => item.record === 'r007');
  assert.equal(multi.length, 2);
  assert.equal(multi[0].number, multi[1].number);
  // Ungrouped: the dictionary's order.
  const flat = buildRecordsChart({
    records,
    parts,
    milestones,
    rowMode: 'part',
    groupByGrp: false,
  });
  assert.equal(flat.rows[0].group, null);
});

test('known line: existing parts dashed before the opening day (seenAt, else first K), solid after', () => {
  const { records, parts, milestones } = fixture();
  const model = buildRecordsChart({ records, parts, milestones, rowMode: 'part' });
  assert.deepEqual(
    model.known.map((line) => line.row),
    ['p5', 'p6', 'p7', 'p8'],
  );
  const p6 = model.known.find((line) => line.row === 'p6');
  assert.equal(p6.solid[0], new Date(2026, 4, 20).getTime());
  assert.equal(p6.dashed[1], p6.solid[0]);
  assert.ok(model.known.every((line) => line.solid || line.dashed));
});

test('labels: lanes above then below, no overlaps even when crowded; crowded labels become numbers', () => {
  const { records, parts, milestones } = fixture();
  const crowded = buildRecordsChart({
    records,
    parts,
    milestones,
    rowMode: 'chapter',
    states: ['candidate', 'kept'],
  });
  const narrow = layoutRecordsChart(crowded, { width: 420 });
  assert.equal(labelsOverlap(narrow), 0);
  assert.ok(narrow.numbered.size > 0);
  const sides = [...narrow.items.values()].map((item) => item.label?.side).filter(Boolean);
  assert.ok(sides.includes('above') && sides.includes('below'));
  for (const mode of ['text', 'number', 'episodes']) {
    const model = buildRecordsChart({
      records,
      parts,
      milestones,
      rowMode: 'part',
      labelMode: mode,
    });
    const layout = layoutRecordsChart(model, { width: 900 });
    assert.equal(labelsOverlap(layout), 0, mode);
    if (mode === 'episodes') assert.equal(model.items.filter((item) => item.text).length > 0, true);
  }
  assert.equal(labelWidth('지붕 A'), 11 * 2 + 6.5 * 2);
  assert.equal(shortText('가'.repeat(30)), `${'가'.repeat(24)}…`);
});

test('deterministic: the same input gives the same chart', () => {
  const a = fixture();
  const b = fixture();
  const one = buildRecordsChart({ ...a, rowMode: 'part', chainStyle: 'dashed' });
  const two = buildRecordsChart({
    ...b,
    records: [...b.records].reverse(),
    rowMode: 'part',
    chainStyle: 'dashed',
  });
  assert.deepEqual(one, two);
  const la = layoutRecordsChart(one, { width: 800 });
  const lb = layoutRecordsChart(two, { width: 800 });
  assert.deepEqual([...la.items.entries()], [...lb.items.entries()]);
  assert.equal(la.height, lb.height);
});
