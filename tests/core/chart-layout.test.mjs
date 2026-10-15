// Row × time chart layout (PLAN-52 T-319, src/ui/chart/layout.ts — shared with PLAN-53): label
// lanes, the connected chain of a chosen item, the cursor's split of links and events, the density
// strip and the time scale. Pure functions; no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  atCursor,
  connectedSet,
  densityStrip,
  layoutChart,
  linksWithin,
  packLanes,
  stepCursor,
  timeAt,
  timeDomain,
  timeScale,
  timeTicks,
} from '../../src/ui/chart/layout.ts';

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 9, 1);

test('packLanes: overlapping labels take the next lane; a freed lane is reused', () => {
  const lanes = packLanes([
    { id: 'a', x: 0, width: 50 },
    { id: 'b', x: 20, width: 50 },
    { id: 'c', x: 40, width: 10 },
    { id: 'd', x: 60, width: 10 },
    { id: 'e', x: 200, width: 10 },
  ]);
  assert.deepEqual(
    ['a', 'b', 'c', 'd', 'e'].map((id) => lanes.get(id)),
    [0, 1, 2, 0, 0],
  );
});

test('layoutChart: rows stack, items sit at their time, a crowded row grows', () => {
  const model = {
    rows: [
      { id: 'model', label: '모델' },
      { id: 'drawing', label: '도면' },
    ],
    items: [
      { id: 'm1', row: 'model', t: t0, kind: 'model', label: 'main.3dm' },
      { id: 'd1', row: 'drawing', t: t0 + DAY, kind: 'drawing', label: 'A-평면.dwg' },
      { id: 'd2', row: 'drawing', t: t0 + DAY, kind: 'drawing', label: 'B-입면.dwg' },
      { id: 'd3', row: 'drawing', t: null, kind: 'drawing', label: '시간 없음.dwg' },
    ],
    links: [],
    milestones: [],
  };
  const layout = layoutChart(model, { width: 400 });
  assert.equal(layout.rows.length, 2);
  assert.equal(layout.rows[1].y, layout.rows[0].height);
  assert.ok(layout.rows[1].height > layout.rows[0].height, 'two labels at one time need a lane');
  assert.equal(layout.items.get('m1').x, 12);
  assert.equal(layout.items.get('d1').x, 388);
  assert.notEqual(layout.items.get('d1').lane, layout.items.get('d2').lane);
  assert.equal(layout.items.get('d3').x, 12);
  assert.equal(layout.height, layout.rows[0].height + layout.rows[1].height);
});

test('connectedSet: the whole chain both ways, with the kind each was reached by', () => {
  const links = [
    { from: 'model', to: 'plan', kind: 'sync-pair' },
    { from: 'plan', to: 'base', kind: 'xref' },
    { from: 'model', to: 'result', kind: 'jig-io', t: t0 + 5 * DAY },
    { from: 'note', to: 'plan', kind: 'mention' },
    { from: 'other', to: 'alone', kind: 'xref' },
  ];
  const chain = connectedSet(links, 'plan');
  assert.deepEqual([...chain.keys()].sort(), ['base', 'model', 'note', 'plan', 'result']);
  assert.equal(chain.get('plan'), null);
  assert.equal(chain.get('model'), 'sync-pair');
  assert.equal(chain.get('result'), 'jig-io');
  assert.deepEqual([...connectedSet(links, 'plan', { maxDepth: 1 }).keys()].sort(), [
    'base',
    'model',
    'note',
    'plan',
  ]);
  // Up to a time: a relation not there yet does not tie.
  assert.equal(connectedSet(links, 'plan', { until: t0 }).has('result'), false);
  assert.equal(linksWithin(links, chain).length, 4);
  assert.deepEqual([...connectedSet(links, ['alone', 'base']).keys()].sort(), [
    'alone',
    'base',
    'model',
    'note',
    'other',
    'plan',
    'result',
  ]);
});

test('cursor: links and events after it are later; play steps to the end', () => {
  const entries = [{ t: t0 }, { t: t0 + DAY }, { t: null }, { t: t0 + 3 * DAY }];
  const split = atCursor(entries, t0 + DAY);
  assert.equal(split.on.length, 3);
  assert.deepEqual(split.later, [{ t: t0 + 3 * DAY }]);
  const domain = { start: t0, end: t0 + 60 * DAY };
  assert.equal(stepCursor(t0, domain, 60), t0 + DAY);
  assert.equal(stepCursor(domain.end - 1, domain, 60), domain.end);
});

test('time: domain, scale and its inverse, density strip, ticks', () => {
  const domain = timeDomain({
    items: [{ t: t0 }, { t: null }],
    milestones: [{ t: t0 + 40 * DAY }],
  });
  assert.deepEqual(domain, { start: t0, end: t0 + 40 * DAY });
  // One instant widens to a day around it.
  const one = timeDomain({ items: [{ t: t0 }], milestones: [] });
  assert.equal(one.end - one.start, DAY);
  const x = timeScale(domain, 424);
  assert.equal(x(t0), 12);
  assert.equal(x(domain.end), 412);
  assert.equal(timeAt(domain, 424, 212), t0 + 20 * DAY);
  assert.deepEqual(
    densityStrip([t0, t0 + DAY, t0 + 39 * DAY, t0 + 99 * DAY], domain, 4),
    [2, 0, 0, 1],
  );
  const ticks = timeTicks({ start: t0 - DAY, end: t0 + 70 * DAY });
  assert.ok(ticks.length >= 2);
  assert.match(ticks[0].label, /^2026-1[01]$/);
  const days = timeTicks({ start: t0, end: t0 + 5 * DAY });
  assert.ok(days.length >= 4);
  assert.match(days[0].label, /^\d\d-\d\d$/);
});
