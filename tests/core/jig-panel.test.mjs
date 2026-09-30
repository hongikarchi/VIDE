// Declarative jig panel v0 (PLAN-22 T-048, SPEC-07.10, ARCH-03 §5.1): the panel check refuses
// parts outside the Design list, unknown properties, colours that are not token names and bindings
// the jig does not declare; bindings, verdict bands, overlay items, tables and CSV read the
// example jig's real step outputs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { scopeOf, validatePanel } from '../../src/ui/jig-panel/spec.ts';
import {
  bandCounts,
  bandOf,
  bandsOf,
  cellText,
  columnsOf,
  fromDisplay,
  layerItems,
  resolve,
  rowsOf,
  toCsv,
  toDisplay,
} from '../../src/ui/jig-panel/bindings.ts';
import { PART_NAMES } from '../../src/ui/kit/registry.ts';
import { grid } from '../../extensions/jigs/example-grid/steps/grid.ts';
import { beams } from '../../extensions/jigs/example-grid/steps/beams.ts';
import { summary } from '../../extensions/jigs/example-grid/steps/summary.ts';

const EXAMPLE = join(import.meta.dirname, '..', '..', 'extensions', 'jigs', 'example-grid');
const read = (file) => JSON.parse(readFileSync(join(EXAMPLE, file), 'utf8'));
const manifest = read('jig.json');
const panel = read('panel.json');
const scope = scopeOf(manifest);
const clone = () => structuredClone(panel);
const codes = (raw) => validatePanel(raw, scope).issues.map((issue) => issue.code);

test('the Design part list is the registry, and the example panel passes', () => {
  assert.deepEqual(PART_NAMES.slice(0, 3), ['step-rail', 'param-group', 'slider']);
  const result = validatePanel(panel, scope);
  assert.deepEqual(result.issues, []);
  assert.equal(result.spec.layout, 'jig-run');
  assert.deepEqual(
    result.spec.left.map((p) => p.part),
    ['step-rail', 'role-card', 'param-group'],
  );
  assert.deepEqual(
    result.spec.center.views.map((p) => p.part),
    ['viewport-overlay', 'plan-map'],
  );
  assert.equal(result.spec.drawer.tabs[1].title, '보');
  assert.equal(result.spec.actions[0].tier, 'T1');
});

test('parts outside the list, out of place, not ready or custom are refused', () => {
  const unknown = clone();
  unknown.left.push({ part: 'plan-view', points: 'step.grid.columns' });
  assert.deepEqual(codes(unknown), ['PANEL_PART_UNKNOWN']);
  const custom = clone();
  custom.center.views.push({ part: 'custom-view', view: 'x', reason: '설명' });
  assert.deepEqual(codes(custom), ['PANEL_PART_UNKNOWN']);
  const placed = clone();
  placed.left.push({ part: 'slider-board' });
  assert.deepEqual(codes(placed), ['PANEL_PART_PLACE']);
  // The report frame parts are built since T-057, so a report view is accepted.
  const report = clone();
  report.center.views.push({ part: 'report', report: 'study' });
  assert.deepEqual(codes(report), []);
  const tab = clone();
  tab.drawer.tabs.push({ title: '막대', part: 'kpi-strip', items: [] });
  assert.deepEqual(codes(tab), ['PANEL_PART_PLACE']);
  // The whole panel is refused, not just the bad part.
  assert.equal(validatePanel(unknown, scope).spec, undefined);
});

test('unknown properties, colours and non-token tones are refused', () => {
  const property = clone();
  property.left[0].color = 'ok';
  assert.deepEqual(codes(property), ['PANEL_PROPERTY']);
  const hex = clone();
  hex.center.views[0].layers[0].tone = '#ff0000';
  assert.deepEqual(codes(hex), ['PANEL_COLOR']);
  const rgb = clone();
  rgb.center.kpis.items[0].note = 'rgb(200, 0, 0)';
  assert.deepEqual(codes(rgb), ['PANEL_COLOR']);
  const hsl = clone();
  hsl.drawer.tabs[0].title = 'hsl(0 50% 50%)';
  assert.ok(codes(hsl).includes('PANEL_COLOR'));
  const token = clone();
  token.center.views[1].layers[0].tone = 'red';
  assert.ok(codes(token).includes('PANEL_TOKEN'));
  const top = clone();
  top.theme = 'dark';
  assert.deepEqual(codes(top), ['PANEL_PROPERTY']);
});

test('bindings name only declared steps, settings and inputs, never code', () => {
  const step = clone();
  step.center.kpis.items[0].from = 'step.nowhere.count';
  assert.deepEqual(codes(step), ['PANEL_BINDING']);
  const setting = clone();
  setting.center.board.params = ['$spacingZ'];
  assert.deepEqual(codes(setting), ['PANEL_BINDING']);
  const input = clone();
  input.left[1].input = 'inputs.roof';
  assert.deepEqual(codes(input), ['PANEL_BINDING']);
  const code = clone();
  code.center.kpis.items[0].from = 'step.summary.columns.map(x => x * 2)';
  assert.deepEqual(codes(code), ['PANEL_PROPERTY']);
  const layer = clone();
  layer.drawer.tabs[0].overlay = 'walls';
  assert.deepEqual(codes(layer), ['PANEL_BINDING']);
  const action = clone();
  action.actions.push({ id: 'bake', label: '만들기', tier: 'T2' });
  assert.deepEqual(codes(action), ['PANEL_PROPERTY']);
  const tier = clone();
  tier.actions[0].tier = 'M';
  assert.deepEqual(codes(tier), ['PANEL_PROPERTY']);
  const missingStep = clone();
  missingStep.actions[0].step = 'bake';
  assert.deepEqual(codes(missingStep), ['PANEL_BINDING']);
  // Without a scope the structure is still checked.
  assert.deepEqual(validatePanel(step).issues, []);
});

// The example jig's steps on its fixture: the outputs the panel binds to.
const input = read('fixtures/basic/input.json');
const params = read('fixtures/basic/params.json');
const outputs = { grid: grid(input, params) };
outputs.beams = beams({ steps: { grid: outputs.grid } }, params);
outputs.summary = summary({ steps: { grid: outputs.grid, beams: outputs.beams } });
const settings = manifest.params.map((p) => ({
  key: p.key,
  title: p.title,
  group: p.group,
  type: p.type,
  unit: p.unit ?? (p.type === 'ratio' || p.type === 'choice' ? '' : 'm'),
  displayUnit: p.display?.unit ?? p.unit ?? '',
  decimals: p.display?.decimals,
  value: params[p.key],
  displayValue: params[p.key],
  by: 'default',
  at: '2026-09-30T00:00:00.000Z',
}));
const data = { outputs, params: settings };
const spec = validatePanel(panel, scope).spec;

test('bindings read step outputs and settings', () => {
  assert.equal(resolve('step.summary.columns', data), outputs.summary.columns);
  assert.equal(resolve('step.grid.columns.0.mark', data), outputs.grid.columns[0].mark);
  assert.equal(resolve('$spacingX', data), 6);
  assert.equal(resolve('step.nowhere.x', data), undefined);
  assert.equal(resolve('params', data), settings);
  // KPI strip: every item has a value on the fixture.
  for (const item of spec.center.kpis.items)
    assert.equal(typeof resolve(item.from, data), 'number', item.label);
});

test('verdict bands come from the jig, with ✓ ! ✕ ? as the screen draws them', () => {
  assert.deepEqual(bandsOf([7, 10], data), [7, 10]);
  assert.equal(bandsOf('step.summary.columns', data), undefined);
  assert.equal(bandOf(6.99, [7, 10]), 'ok');
  assert.equal(bandOf(7, [7, 10]), 'warn');
  assert.equal(bandOf(10, [7, 10]), 'ng');
  assert.equal(bandOf(undefined, [7, 10]), 'na');
  assert.equal(bandOf(5, undefined), 'na');
  const rows = rowsOf(outputs.beams.beams);
  const counts = bandCounts(rows, 'span_m', [5.5, 10]);
  assert.equal(counts.ok + counts.warn + counts.ng + counts.na, rows.length);
  assert.ok(counts.ok > 0 && counts.warn > 0, JSON.stringify(counts));
});

test('overlay items for the 3D view and the plan', () => {
  const [site, beamLayer, columnLayer] = spec.center.views[0].layers;
  const columns = layerItems(columnLayer, data, { verdict: true });
  assert.equal(columns.length, outputs.grid.columns.length);
  assert.deepEqual(columns[0], {
    id: outputs.grid.columns[0].key,
    tone: 'ov-new',
    label: outputs.grid.columns[0].mark,
    kind: 'point',
    at: [...outputs.grid.columns[0].at, 0],
  });
  const outline = layerItems(site, data, { verdict: true });
  assert.equal(outline.length, 1);
  assert.equal(outline[0].kind, 'polygon');
  assert.equal(outline[0].id, 'site');
  const lines = layerItems(beamLayer, data, { verdict: true });
  assert.equal(lines.length, outputs.beams.beams.length);
  assert.equal(lines[0].kind, 'polyline');
  assert.equal(lines[0].points.length, 2);
  const bands = new Set(lines.map((line) => line.tone));
  assert.ok([...bands].every((tone) => ['ok', 'warn', 'ng'].includes(tone)));
  // 판정색 끄기: the layer's own tone; 그 판정만 보기: one band.
  assert.ok(layerItems(beamLayer, data, { verdict: false }).every((l) => l.tone === 'ov-new'));
  const only = layerItems(beamLayer, data, { verdict: true, only: 'ok' });
  assert.equal(only.length, bandCounts(rowsOf(outputs.beams.beams), 'span_m', [7, 10]).ok);
  // Rows without geometry are left out, never drawn at the origin.
  const broken = { outputs: { grid: { columns: [{ key: 'x', at: ['a', 1] }] } }, params: [] };
  assert.deepEqual(layerItems(columnLayer, broken, { verdict: true }), []);
});

test('tables: columns, cell text, CSV with units and formula-safe text', () => {
  const rows = rowsOf(outputs.beams.beams);
  const tab = spec.drawer.tabs[1];
  const columns = columnsOf(rows, tab.columns);
  assert.deepEqual(
    columns.map((c) => c.field),
    ['key', 'span_m', 'depth_m'],
  );
  assert.deepEqual(
    columnsOf([{ key: 'a', n: 1, at: [1, 2], nested: { x: 1 } }]).map((c) => c.field),
    ['key', 'n', 'at'],
  );
  assert.equal(cellText([12, 5.25], 2), '12.00, 5.25');
  assert.equal(cellText(0.123456), '0.123');
  assert.equal(cellText(undefined), '—');
  assert.equal(cellText(true), '예');
  const csv = toCsv(
    [
      { key: '=HYPERLINK("x")', span_m: -6, depth_m: 0.45 },
      { key: 'G:C1-1>C2-1', span_m: 6.123, depth_m: undefined },
    ],
    columns,
  );
  const lines = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(csv[0], '﻿');
  assert.equal(lines[0], '부호,경간 (m),보 춤 (m)');
  assert.equal(lines[1], `"'=HYPERLINK(""x"")",-6.00,0.45`);
  assert.equal(lines[2], 'G:C1-1>C2-1,6.12,');
});

test('settings show in their display unit and travel in storage units', () => {
  const size = settings.find((s) => s.key === 'columnSize');
  assert.equal(toDisplay(size, 0.6), 600);
  assert.equal(fromDisplay(size, 750), 0.75);
  const ratio = settings.find((s) => s.key === 'beamDepthRatio');
  assert.equal(toDisplay(ratio, 0.07), 7);
  assert.equal(fromDisplay(ratio, 6.5), 0.065);
});

// The engine runs the same check at registration (ARCH-03 §5.1): `jig:validate`, import and the
// registry refuse a package whose panel uses a part outside the list.
test('the loader refuses a package whose panel.json uses an unknown part', async () => {
  const { cpSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { validateJig } = await import('../../src/jigs/runtime/pack.ts');
  const root = mkdtempSync(join(tmpdir(), 'vide-jig-panel-'));
  try {
    const dir = join(root, 'example-grid');
    cpSync(EXAMPLE, dir, { recursive: true });
    assert.equal((await validateJig(dir)).ok, true);
    const bad = clone();
    bad.left.unshift({ part: 'custom-view', src: 'x.html' });
    writeFileSync(join(dir, 'panel.json'), JSON.stringify(bad));
    const report = await validateJig(dir);
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.issues.map((issue) => [issue.code, issue.path]),
      [['JIG_PANEL', 'panel.json:panel.left[0]']],
    );
    writeFileSync(join(dir, 'panel.json'), '{');
    assert.deepEqual(
      (await validateJig(dir)).issues.map((issue) => issue.code),
      ['JIG_PANEL'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
