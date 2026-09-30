// S-06 frame jig ② 축선·배치 (PLAN-23 T-051, SPEC-06.11 1, 결정 D5·D6): new column lines in the
// frame of the existing footings, found by the allowed-window search of `layout.ts`. Two candidate
// patterns — an orthogonal grid and a staggered grid — are compared by the lexicographic objective
// (span > pile cap vs existing footing > basin beams > open cut > column count); the span limit
// holds for every girder of the implied network, diagonals included. What could not be satisfied
// is listed as violations with the relaxation order; the person picks the pattern in `layoutPattern`
// and sees the other alternatives beside it. New axes carry the nearest existing grid names.

import type { Vec2, Vec3 } from '../../../../src/jigs/official/geometry-kit/index.ts';
import type { AssembleOutput } from './assemble.ts';
import {
  DEFAULT_ORDER,
  OBJECTIVE_TITLE,
  Search,
  lexLess,
  objectiveVector,
  orthogonal,
  staggered,
  swapSite,
  unswap,
  type Layout,
  type LayoutSpan,
  type ObjectiveKey,
  type SearchSite,
} from './layout.ts';
import {
  bandsOf,
  footprintsOf,
  slabOf,
  toLocal,
  toWorld,
  type Frame,
  type SiteInput,
  type ZoneInput,
} from './roles.ts';

export interface AxesInputs {
  site: SiteInput;
  fireRoute?: ZoneInput[];
  steps: { assemble: AssembleOutput };
}
export interface AxesParams {
  spanMax: number;
  spanRule: 'all' | 'orthogonal';
  layoutPattern: 'auto' | 'orthogonal' | 'staggered';
  capSize: number;
  openCutOffset: number;
  capClearance: number;
  columnEdgeMin: number;
  cantileverMax: number;
}
export const DEFAULT_AXES_PARAMS: AxesParams = {
  spanMax: 12,
  spanRule: 'all',
  layoutPattern: 'auto',
  capSize: 2.0,
  openCutOffset: 0.8,
  capClearance: 0.2,
  columnEdgeMin: 0.5,
  cantileverMax: 3.5,
};

export interface AxisRow {
  key: string;
  name: string;
  axis: 'u' | 'v';
  at: number;
  line: [Vec3, Vec3];
  /** Nearest existing grid names ('X12–X13 사이', 'X12 위'), when a grid was read. */
  existing: string;
}
export interface PointRow {
  key: string;
  at: Vec2;
  local: Vec2;
  lineU?: string;
  lineV?: string;
  cap: number;
  basin: number;
  openCut: number;
}
export interface SpanOut extends LayoutSpan {
  verdict: 'pass' | 'over';
  judgement: string;
  line: [Vec3, Vec3];
}
export interface AlternativeRow {
  id: string;
  title: string;
  pattern: Layout['pattern'];
  chosen: boolean;
  chosenText: string;
  columns: number;
  maxSpan: number;
  spanOver: number;
  cap: number;
  basin: number;
  openCut: number;
  edgeRelaxed: boolean;
  vector: number[];
}
export interface AxesOutput {
  schema: 'vide.s06.axes/1';
  frame: Frame;
  chosen: string;
  alternatives: AlternativeRow[];
  axes: AxisRow[];
  points: PointRow[];
  spans: SpanOut[];
  objective: Layout['objective'];
  summary: {
    columns: number;
    maxSpan: number | null;
    spanOver: number;
    cap: number;
    basin: number;
    openCut: number;
  };
  violations: { key: string; objective: ObjectiveKey | 'span' | 'edge'; text: string }[];
  /** Objectives that ended above zero, in the order they were given up (last priority first). */
  relaxed: ObjectiveKey[];
  bands: { span: [number, number] };
  notes: string[];
}

const round = (v: number, digits = 3) => Number(v.toFixed(digits));

function resolveParams(params: Partial<AxesParams>): AxesParams {
  const out = { ...DEFAULT_AXES_PARAMS };
  for (const key of Object.keys(DEFAULT_AXES_PARAMS) as (keyof AxesParams)[])
    if (params[key] !== undefined) Object.assign(out, { [key]: params[key] });
  for (const key of [
    'spanMax',
    'capSize',
    'openCutOffset',
    'capClearance',
    'columnEdgeMin',
    'cantileverMax',
  ] as const)
    if (!Number.isFinite(out[key]) || out[key] < 0)
      throw new RangeError(`${key} ${String(out[key])}`);
  if (!(out.spanMax > 0) || !(out.capSize > 0))
    throw new RangeError('spanMax and capSize must be positive');
  if (out.spanRule !== 'all' && out.spanRule !== 'orthogonal')
    throw new RangeError(`spanRule ${String(out.spanRule)}`);
  if (!['auto', 'orthogonal', 'staggered'].includes(out.layoutPattern))
    throw new RangeError(`layoutPattern ${String(out.layoutPattern)}`);
  return out;
}

/** Existing grid names around a new line's local position. */
function existingText(at: number, family: { name: string; at: number }[]) {
  if (!family.length) return '';
  const sorted = [...family].sort((a, b) => a.at - b.at);
  const on = sorted.find((g) => Math.abs(g.at - at) <= 0.05);
  if (on) return `${on.name} 위`;
  const below = [...sorted].reverse().find((g) => g.at < at);
  const above = sorted.find((g) => g.at > at);
  if (below && above) return `${below.name}–${above.name} 사이`;
  if (below) return `${below.name} 밖 ${round(at - below.at, 2)} m`;
  if (above) return `${above.name} 밖 ${round(above.at - at, 2)} m`;
  return '';
}

export function axes(inputs: AxesInputs, params: Partial<AxesParams> = {}): AxesOutput {
  const p = resolveParams(params);
  const assembled = inputs.steps?.assemble;
  if (!assembled) throw new Error('ASSEMBLE_MISSING: 입력 조립 결과가 없습니다');
  const notes: string[] = [];
  const site = inputs.site ?? {};
  const frame = assembled.frame;
  const slab = slabOf(site.slab, site.voids).region;
  if (!slab) throw new Error('SLAB_MISSING: 슬래브 경계를 읽지 못해 축선을 둘 범위가 없습니다');
  const local = (ring: readonly Vec2[]) => ring.map((q) => toLocal(frame, q));
  const existing = footprintsOf('existingFootings', site.existingFootings, 'base').shapes;
  const basin = bandsOf('basinGirders', site.basinGirders).shapes;
  const searchSite: SearchSite = {
    region: { outer: local(slab.outer), holes: slab.holes.map(local) },
    forbidden: (inputs.fireRoute ?? [])
      .filter((z) => z.shape?.length >= 3)
      .map((z) => local(z.shape)),
    existing: existing.map((s) => local(s.hull)),
    basin: basin.map((s) => local(s.hull)),
  };
  const options = {
    spanMax: p.spanMax,
    spanRule: p.spanRule,
    capSize: p.capSize,
    openCutSize: p.capSize + 2 * p.openCutOffset,
    clearance: p.capClearance,
    edgeMin: p.columnEdgeMin,
    edgeMax: p.cantileverMax,
    minSpacing: Math.max(p.capSize + 1.0, 3.0),
  };

  // Candidates: the orthogonal grid, the staggered grid (rows either way), and an orthogonal grid
  // that avoids open cuts before basin beams — a different objective, so a different alternative.
  const layouts: {
    id: string;
    title: string;
    layout: Layout | null;
    order: readonly ObjectiveKey[];
  }[] = [];
  const run = (
    id: string,
    title: string,
    order: readonly ObjectiveKey[],
    make: (search: Search) => Layout | null,
  ) => {
    const search = new Search(searchSite, { ...options, order });
    let layout: Layout | null = null;
    try {
      layout = make(search);
    } catch (error) {
      notes.push(`${title}: ${String((error as Error)?.message ?? error)}`);
    }
    layouts.push({ id, title, layout, order });
  };
  run('orthogonal', '직교 격자', DEFAULT_ORDER, orthogonal);
  run('staggered', '엇갈림 격자', DEFAULT_ORDER, (search) => {
    const rowsAlongU = staggered(search);
    const swapped = staggered(new Search(swapSite(searchSite), search.options));
    const rowsAlongV = swapped ? unswap(swapped) : null;
    if (rowsAlongU && rowsAlongV)
      return lexLess(rowsAlongV.vector, rowsAlongU.vector) ? rowsAlongV : rowsAlongU;
    return rowsAlongU ?? rowsAlongV;
  });
  run(
    'orthogonal-opencut',
    '직교 격자 · 오픈컷 우선',
    ['cap', 'openCut', 'basin', 'columns'],
    orthogonal,
  );
  const available = layouts.filter((l): l is typeof l & { layout: Layout } => !!l.layout);
  if (!available.length)
    throw new Error(
      'LAYOUT_NONE: 슬래브 안에 축선을 둘 자리가 없습니다(외곽 여유·소방 동선을 확인)',
    );
  // Alternatives are compared by the default order; the open-cut variant stays only when it differs.
  const defaultVector = (layout: Layout) =>
    objectiveVector(layout.objective, layout.edgeRelaxed, DEFAULT_ORDER);
  // A pattern that only covers the slab with an uncovered edge is not offered beside one that
  // covers it; the open-cut variant stays only when it differs from the default grid.
  const covered = available.filter((entry) => !entry.layout.edgeRelaxed);
  for (const entry of available)
    if (entry.layout.edgeRelaxed && covered.length)
      notes.push(
        `${entry.title}: 슬래브 끝을 ${p.cantileverMax} m 안에 받치는 배치가 없어 대안에서 뺐습니다.`,
      );
  const distinct = (covered.length ? covered : available).filter(
    (entry, index, list) =>
      entry.id !== 'orthogonal-opencut' ||
      !list.some((other, j) => j < index && sameLines(other.layout, entry.layout)),
  );
  let chosen: (typeof distinct)[number];
  if (p.layoutPattern === 'auto')
    chosen = distinct.reduce((a, b) =>
      lexLess(defaultVector(b.layout), defaultVector(a.layout)) ? b : a,
    );
  else {
    const wanted = distinct.find((l) => l.layout.pattern === p.layoutPattern);
    if (!wanted) {
      chosen = distinct[0];
      notes.push(
        `${p.layoutPattern === 'staggered' ? '엇갈림' : '직교'} 격자를 만들지 못해 ${chosen.title}를 보입니다.`,
      );
    } else chosen = wanted;
  }
  const layout = chosen.layout;

  // World geometry of the chosen layout.
  const zAxes = slab.z[0];
  const box = { uMin: Infinity, uMax: -Infinity, vMin: Infinity, vMax: -Infinity };
  for (const q of searchSite.region.outer) {
    box.uMin = Math.min(box.uMin, q[0]);
    box.uMax = Math.max(box.uMax, q[0]);
    box.vMin = Math.min(box.vMin, q[1]);
    box.vMax = Math.max(box.vMax, q[1]);
  }
  const gridU: { name: string; at: number }[] = [];
  const gridV: { name: string; at: number }[] = [];
  for (const line of assembled.grid?.lines ?? []) {
    const a = toLocal(frame, line.line[0]);
    if (line.family === 'u') gridU.push({ name: line.name, at: a[0] });
    else if (line.family === 'v') gridV.push({ name: line.name, at: a[1] });
  }
  const world3 = (q: Vec2): Vec3 => {
    const w = toWorld(frame, q);
    return [round(w[0], 6), round(w[1], 6), round(zAxes, 6)];
  };
  const axisRows: AxisRow[] = layout.lines.map((line) => ({
    key: `axis:${line.name}`,
    name: line.name,
    axis: line.axis,
    at: round(line.at),
    line:
      line.axis === 'u'
        ? [world3([line.at, box.vMin - 1]), world3([line.at, box.vMax + 1])]
        : [world3([box.uMin - 1, line.at]), world3([box.uMax + 1, line.at])],
    existing: existingText(line.at, line.axis === 'u' ? gridU : gridV),
  }));
  const points: PointRow[] = layout.points.map((q) => {
    const w = toWorld(frame, q.local);
    return {
      key: q.key,
      at: [round(w[0], 6), round(w[1], 6)],
      local: [round(q.local[0]), round(q.local[1])],
      ...(q.lineU ? { lineU: q.lineU } : {}),
      ...(q.lineV ? { lineV: q.lineV } : {}),
      cap: q.cap,
      basin: q.basin,
      openCut: q.openCut,
    };
  });
  const at = new Map(points.map((q) => [q.key, q.at]));
  const spans: SpanOut[] = layout.spans.map((span) => {
    const over = span.length > p.spanMax + 1e-6;
    const a = at.get(span.from)!,
      b = at.get(span.to)!;
    return {
      ...span,
      length: round(span.length),
      verdict: over ? 'over' : 'pass',
      judgement: over ? '✕ 초과' : '✓ 통과',
      line: [
        [a[0], a[1], round(zAxes, 6)],
        [b[0], b[1], round(zAxes, 6)],
      ],
    };
  });

  // Violations and the relaxation order (RESEARCH-10 §14.4 ② 5): the span is never given up.
  const violations: AxesOutput['violations'] = [];
  for (const span of spans)
    if (span.verdict === 'over')
      violations.push({
        key: span.key,
        objective: 'span',
        text: `경간 ${span.length} m > ${p.spanMax} m`,
      });
  for (const q of points) {
    if (q.cap)
      violations.push({
        key: q.key,
        objective: 'cap',
        text: `파일캡이 기존 기초 ${q.cap}개와 ${p.capClearance} m 안`,
      });
    if (q.basin)
      violations.push({
        key: q.key,
        objective: 'basin',
        text: `파일캡이 유수지 보 ${q.basin}개 위`,
      });
    if (q.openCut)
      violations.push({
        key: q.key,
        objective: 'openCut',
        text: `오픈컷이 기존 기초 ${q.openCut}개와 겹침`,
      });
  }
  if (layout.edgeRelaxed)
    violations.push({
      key: 'edge',
      objective: 'edge',
      text: `슬래브 끝이 바깥 축선에서 ${p.cantileverMax} m를 넘습니다`,
    });
  const relaxed = [...DEFAULT_ORDER]
    .reverse()
    .filter((k) => layout.objective[k] > 0 && k !== 'columns');
  if (layout.objective.cap)
    notes.push(
      `경간을 지키면 파일캡 간섭 ${layout.objective.cap}곳을 피할 수 없습니다. 목록으로 보입니다(완화 순서: ${relaxed.map((k) => OBJECTIVE_TITLE[k]).join(' → ')}).`,
    );
  const maxSpan = spans.length ? Math.max(...spans.map((s) => s.length)) : null;

  const alternatives: AlternativeRow[] = distinct.map((entry) => {
    const spansOf = entry.layout.spans;
    return {
      id: entry.id,
      title: entry.title,
      pattern: entry.layout.pattern,
      chosen: entry === chosen,
      chosenText: entry === chosen ? '● 선택' : '',
      columns: entry.layout.objective.columns,
      maxSpan: spansOf.length ? round(Math.max(...spansOf.map((s) => s.length))) : 0,
      spanOver: entry.layout.objective.spanOver,
      cap: entry.layout.objective.cap,
      basin: entry.layout.objective.basin,
      openCut: entry.layout.objective.openCut,
      edgeRelaxed: entry.layout.edgeRelaxed,
      vector: defaultVector(entry.layout),
    };
  });
  return {
    schema: 'vide.s06.axes/1',
    frame,
    chosen: chosen.id,
    alternatives,
    axes: axisRows,
    points,
    spans,
    objective: { ...layout.objective, spanExcess: round(layout.objective.spanExcess) },
    summary: {
      columns: points.length,
      maxSpan: maxSpan === null ? null : round(maxSpan),
      spanOver: layout.objective.spanOver,
      cap: layout.objective.cap,
      basin: layout.objective.basin,
      openCut: layout.objective.openCut,
    },
    violations,
    relaxed,
    bands: { span: [p.spanMax - 1, p.spanMax + 1e-6] },
    notes,
  };
}

const sameLines = (a: Layout, b: Layout) =>
  a.pattern === b.pattern &&
  a.lines.length === b.lines.length &&
  a.lines.every(
    (line, i) => line.axis === b.lines[i].axis && Math.abs(line.at - b.lines[i].at) < 1e-6,
  );
