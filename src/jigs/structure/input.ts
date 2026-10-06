// Structure jig input (SPEC-06.1, ARCH-02): stored Rhino/CAD Syncs → analysis-model draft.
// The deterministic part lives here: pieces from curves, solids and CAD lines; node merging,
// T-junction and crossing splits; roles; joint rule; supports; default material and loads.
// Every item carries its provenance; anything guessed is marked `assumed`.

import { elements, type Element, type Point } from '../sync.ts';
import type { StructureModelInput } from '../../contracts/structure-model.ts';
import { hId, hName, matchOuterSize, parseSectionName, type HSize } from './sections.ts';

export type Role = 'column' | 'girder' | 'beam' | 'brace' | 'other';
type Provenance = { by: 'auto' | 'ai' | 'user'; assumed: boolean; note?: string };

export interface DraftSource {
  syncId: string;
  documentId?: string;
  host: 'rhino' | 'zwcad';
  /** curves = centre lines, breps = member solids, cad = plan drawing lines. */
  mode: 'curves' | 'breps' | 'cad';
  result: Record<string, unknown>;
  layers?: string[];
  objectIds?: string[];
  /** CAD only: beam levels (m), base level and the layers that hold beams and columns. */
  cad?: { levels_m: number[]; base_m?: number; beamLayers: string[]; columnLayers: string[] };
}

export interface DraftOptions {
  mergeTolerance_m?: number;
  /** Dangling ends within this distance of another member are joined to it. */
  snap_m?: number;
  baseFixity?: 'pin' | 'fixed';
  /** Member/end joint exceptions (SPEC-06.4), applied after the default rule. */
  jointExceptions?: { member: string; end: 'i' | 'j'; value: 'rigid' | 'pin' }[];
  /** Role and section hints by layer, e.g. from the AI draft or the user. */
  layerHints?: Record<string, { role?: Role; section?: string }>;
}

export interface DraftIssue {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  nodes?: string[];
  members?: string[];
}

interface Piece {
  a: Point;
  b: Point;
  source: { documentId: string; objectId: string };
  layer: string;
  name?: string;
  roleHint?: Role;
  section?: { shape: 'H' | 'BH'; dims: HSize; provenance: Provenance };
}

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Point, s: number): Point => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Point) => Math.sqrt(dot(a, a));
const dist = (a: Point, b: Point) => len(sub(a, b));

const ROLE_WORDS: [RegExp, Role][] = [
  [/(기둥|column|\bcol\b|^c\d)/i, 'column'],
  [/(거더|girder|\bgir\b|^g\d)/i, 'girder'],
  [/(가새|브레이스|brace|bracing|\bbr\b)/i, 'brace'],
  [/(작은\s*보|beam|\bbm\b|보|^b\d)/i, 'beam'],
];
export function roleFromText(text: string): Role | undefined {
  return ROLE_WORDS.find(([pattern]) => pattern.test(text))?.[1];
}

const decode = (value: unknown) => {
  if (typeof value !== 'string' || !value) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
    );
  } catch {
    return '';
  }
};

function attributes(row: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(row.attributes64))
    for (const pair of row.attributes64 as unknown[])
      if (Array.isArray(pair) && pair.length === 2)
        out.set(decode(pair[0]).toLowerCase(), decode(pair[1]));
  return out;
}

function sectionHint(texts: string[]): Piece['section'] {
  for (const text of texts) {
    const parsed = parseSectionName(text);
    if (parsed)
      return {
        ...parsed,
        provenance: { by: 'auto', assumed: false, note: `이름·속성 "${text.slice(0, 60)}"` },
      };
  }
  return undefined;
}

/** Straight runs of a polyline: consecutive segments within 1° are merged. */
function straightRuns(points: Point[]): [Point, Point][] {
  const runs: [Point, Point][] = [];
  let start = points[0];
  for (let i = 1; i < points.length; i++) {
    const next = points[i + 1];
    if (next) {
      const d1 = sub(points[i], start);
      const d2 = sub(next, points[i]);
      const cos = dot(d1, d2) / (len(d1) * len(d2) || 1);
      if (cos > Math.cos(Math.PI / 180)) continue;
    }
    runs.push([start, points[i]]);
    start = points[i];
  }
  return runs.filter(([a, b]) => dist(a, b) > 1e-6);
}

/** Principal axis of a solid's mesh vertices and its cross-section extents. */
export function solidAxis(
  vertices: number[],
): { a: Point; b: Point; depth: number; width: number; webAlongY: boolean } | null {
  const n = Math.floor(vertices.length / 3);
  if (n < 4) return null;
  const c: Point = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += vertices[i * 3 + k] / n;
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < n; i++) {
    const d = [0, 1, 2].map((k) => vertices[i * 3 + k] - c[k]);
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) cov[r][s] += d[r] * d[s];
  }
  let v: Point = [1, 0.5, 0.25];
  for (let it = 0; it < 100; it++) {
    const w: Point = [0, 1, 2].map(
      (r) => cov[r][0] * v[0] + cov[r][1] * v[1] + cov[r][2] * v[2],
    ) as Point;
    const l = len(w);
    if (!l) return null;
    v = mul(w, 1 / l);
  }
  const vertical = Math.abs(v[2]) >= 0.85;
  // Cross-section axes: for beams, "up" and horizontal; for columns, X and Y.
  let u: Point;
  if (vertical) u = [1, 0, 0];
  else {
    const up: Point = [0, 0, 1];
    u = sub(up, mul(v, dot(up, v)));
    u = mul(u, 1 / len(u));
  }
  u = sub(u, mul(v, dot(u, v)));
  u = mul(u, 1 / len(u));
  const w: Point = [
    v[1] * u[2] - v[2] * u[1],
    v[2] * u[0] - v[0] * u[2],
    v[0] * u[1] - v[1] * u[0],
  ];
  let [tMin, tMax, uMin, uMax, wMin, wMax] = [
    Infinity,
    -Infinity,
    Infinity,
    -Infinity,
    Infinity,
    -Infinity,
  ];
  for (let i = 0; i < n; i++) {
    const d: Point = [
      vertices[i * 3] - c[0],
      vertices[i * 3 + 1] - c[1],
      vertices[i * 3 + 2] - c[2],
    ];
    const [t, s, q] = [dot(d, v), dot(d, u), dot(d, w)];
    [tMin, tMax] = [Math.min(tMin, t), Math.max(tMax, t)];
    [uMin, uMax] = [Math.min(uMin, s), Math.max(uMax, s)];
    [wMin, wMax] = [Math.min(wMin, q), Math.max(wMax, q)];
  }
  // Point the axis upward (columns) or toward +X/+Y (beams) so i→j is stable.
  const flip = vertical ? v[2] < 0 : v[0] < -1e-9 || (Math.abs(v[0]) <= 1e-9 && v[1] < 0);
  const a = add(c, mul(v, tMin));
  const b = add(c, mul(v, tMax));
  const [du, dw] = [uMax - uMin, wMax - wMin];
  // Beams: depth is vertical (u). Columns: the larger extent is the section depth (web direction).
  const depth = vertical ? Math.max(du, dw) : du;
  const width = vertical ? Math.min(du, dw) : dw;
  return { a: flip ? b : a, b: flip ? a : b, depth, width, webAlongY: vertical && dw > du };
}

/** Scene or object rows: an array, or a stored list read one row at a time (T-129). */
const listOf = (value: unknown): Iterable<Record<string, unknown>> =>
  value && typeof value === 'object' && Symbol.iterator in value
    ? (value as Iterable<Record<string, unknown>>)
    : [];

function collectPieces(
  source: DraftSource,
  issues: DraftIssue[],
  hints: DraftOptions['layerHints'],
): Piece[] {
  // Members point back to the Sync record and its scene row, so the screen can select them.
  const documentId = source.syncId;
  const pieces: Piece[] = [];
  const wantLayer = (layer: string) => !source.layers?.length || source.layers.includes(layer);
  const wantObject = (id: string, nativeId?: string) =>
    !source.objectIds?.length ||
    source.objectIds.includes(id) ||
    (!!nativeId && source.objectIds.includes(nativeId));
  const hintFor = (layer: string, texts: string[]) => {
    const hint = hints?.[layer];
    const role = hint?.role ?? texts.map(roleFromText).find(Boolean);
    const section = hint?.section ? sectionHint([hint.section]) : sectionHint(texts);
    return { role, section };
  };
  if (source.mode === 'curves') {
    // 3D polylines straight from the scene (the plan-view Sync helper drops vertical curves).
    const names = new Map<string, string>();
    for (const o of listOf(source.result.objects))
      names.set(String(o.id), typeof o.name === 'string' ? o.name : '');
    for (const row of listOf(source.result.scene)) {
      // Layer and object first: a stored row decodes its coordinates only when it is taken.
      const id = String(row.id);
      const nativeId = String(row.nativeId ?? row.id);
      const layer = decode(row.layer64);
      if (!wantLayer(layer) || !wantObject(id, nativeId)) continue;
      const flat = Array.isArray(row.line) ? (row.line as number[]) : [];
      if (flat.length < 6) continue;
      const points: Point[] = [];
      for (let i = 0; i + 2 < flat.length; i += 3) points.push([flat[i], flat[i + 1], flat[i + 2]]);
      const name = decode(row.name64) || names.get(id) || '';
      const attrs = attributes(row);
      const texts = [layer, name, ...attrs.values(), ...[...attrs.keys()]];
      const { role, section } = hintFor(layer, texts);
      for (const [a, b] of straightRuns(points))
        pieces.push({
          a,
          b,
          source: { documentId, objectId: id },
          layer,
          name,
          roleHint: role,
          section,
        });
    }
  } else if (source.mode === 'breps') {
    for (const row of listOf(source.result.scene)) {
      const layer = decode(row.layer64);
      if (!wantLayer(layer) || !wantObject(String(row.id), String(row.nativeId ?? ''))) continue;
      const vertices = Array.isArray(row.vertices) ? (row.vertices as number[]) : [];
      if (vertices.length < 12) continue;
      const axis = solidAxis(vertices);
      if (!axis) continue;
      const attrs = attributes(row);
      const name = decode(row.name64);
      const texts = [layer, name, ...attrs.values(), ...[...attrs.keys()]];
      const { role, section: named } = hintFor(layer, texts);
      let section = named;
      if (!section) {
        const size = matchOuterSize(axis.depth * 1e3, axis.width * 1e3);
        section = size
          ? {
              shape: 'H',
              dims: size,
              provenance: {
                by: 'auto',
                assumed: true,
                note: `외곽 ${Math.round(axis.depth * 1e3)}×${Math.round(axis.width * 1e3)} mm로 가장 가까운 ${hName(size)} 추정`,
              },
            }
          : undefined;
        if (!size)
          issues.push({
            level: 'warning',
            code: 'SECTION_UNKNOWN',
            message: `부재 솔리드 ${name || String(row.id)}의 단면을 외곽 ${Math.round(axis.depth * 1e3)}×${Math.round(axis.width * 1e3)} mm로 추정할 수 없음`,
          });
      }
      pieces.push({
        a: axis.a,
        b: axis.b,
        source: { documentId, objectId: String(row.id) },
        layer,
        name,
        roleHint: role,
        section,
      });
    }
  } else {
    const cad = source.cad;
    if (!cad?.levels_m.length) {
      issues.push({
        level: 'error',
        code: 'CAD_LEVELS',
        message: 'CAD 입력에는 보 레벨(층 높이)이 필요함',
      });
      return pieces;
    }
    const all = elements(source.result, 'zwcad', [...cad.beamLayers, ...cad.columnLayers]);
    const levels = [...cad.levels_m].sort((x, y) => x - y);
    const base = cad.base_m ?? 0;
    for (const e of all.filter((x) => cad.beamLayers.includes(x.layer)))
      for (const z of levels)
        for (const [a, b] of e.segments)
          pieces.push({
            a: [a[0], a[1], z],
            b: [b[0], b[1], z],
            source: { documentId, objectId: e.id },
            layer: e.layer,
            roleHint: hints?.[e.layer]?.role,
            section: hints?.[e.layer]?.section ? sectionHint([hints[e.layer].section!]) : undefined,
          });
    for (const e of all.filter((x) => cad.columnLayers.includes(x.layer))) {
      const pts = e.segments.flat();
      const c = mul(
        pts.reduce((s, p) => add(s, p), [0, 0, 0] as Point),
        1 / pts.length,
      );
      let lower = base;
      for (const z of levels) {
        pieces.push({
          a: [c[0], c[1], lower],
          b: [c[0], c[1], z],
          source: { documentId, objectId: e.id },
          layer: e.layer,
          roleHint: 'column',
          section: hints?.[e.layer]?.section ? sectionHint([hints[e.layer].section!]) : undefined,
        });
        lower = z;
      }
    }
  }
  return pieces;
}

/** Closest point parameter of p on segment ab (unclamped) and the distance to the infinite line. */
function project(p: Point, a: Point, b: Point) {
  const d = sub(b, a);
  const t = dot(sub(p, a), d) / dot(d, d);
  return { t, distance: dist(p, add(a, mul(d, t))) };
}

export interface Draft {
  model: StructureModelInput;
  issues: DraftIssue[];
}

export function buildDraft(sources: DraftSource[], options: DraftOptions = {}): Draft {
  const tol = options.mergeTolerance_m ?? 0.01;
  const snap = options.snap_m ?? 0.3;
  const issues: DraftIssue[] = [];
  const pieces = sources
    .flatMap((s) => collectPieces(s, issues, options.layerHints))
    .filter((p) => dist(p.a, p.b) > tol);

  // 1. Join dangling ends to the nearest other piece (T-junctions, ends at a column face).
  const endCount = new Map<string, number>();
  const key = (p: Point) => p.map((v) => Math.round(v / tol)).join(',');
  for (const p of pieces)
    for (const e of [p.a, p.b]) endCount.set(key(e), (endCount.get(key(e)) ?? 0) + 1);
  for (const p of pieces)
    for (const end of ['a', 'b'] as const) {
      if ((endCount.get(key(p[end])) ?? 0) > 1) continue;
      let best: { point: Point; d: number } | null = null;
      for (const q of pieces) {
        if (q === p) continue;
        const { t, distance } = project(p[end], q.a, q.b);
        const lq = dist(q.a, q.b);
        if (t < -tol / lq || t > 1 + tol / lq || distance > snap) continue;
        const point = add(q.a, mul(sub(q.b, q.a), Math.min(1, Math.max(0, t))));
        const d = dist(point, p[end]);
        if (d <= snap && (!best || d < best.d)) best = { point, d };
      }
      if (best && best.d > tol) {
        p[end] = best.point;
        issues.push({
          level: 'info',
          code: 'END_SNAPPED',
          message: `끝점을 ${(best.d * 1e3).toFixed(0)} mm 옮겨 다른 부재에 연결`,
        });
      }
    }

  // 2. Nodes: merge endpoints; split pieces at nodes lying on their interior.
  const nodes: Point[] = [];
  const grid = new Map<string, number[]>();
  const cell = (p: Point) => p.map((v) => Math.floor(v / (tol * 2)));
  const nodeAt = (p: Point) => {
    const [x, y, z] = cell(p);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const n of grid.get(`${x + dx},${y + dy},${z + dz}`) ?? [])
            if (dist(nodes[n], p) <= tol) return n;
    nodes.push(p);
    const k = `${x},${y},${z}`;
    grid.set(k, [...(grid.get(k) ?? []), nodes.length - 1]);
    return nodes.length - 1;
  };
  const raw = pieces.map((p) => ({ piece: p, i: nodeAt(p.a), j: nodeAt(p.b) }));
  // Crossings in 3D (within tolerance) become shared nodes too.
  for (let x = 0; x < raw.length; x++)
    for (let y = x + 1; y < raw.length; y++) {
      const [p, q] = [raw[x].piece, raw[y].piece];
      const d1 = sub(p.b, p.a),
        d2 = sub(q.b, q.a),
        r = sub(p.a, q.a);
      const a = dot(d1, d1),
        e = dot(d2, d2),
        f = dot(d2, r),
        c = dot(d1, r),
        b = dot(d1, d2);
      const den = a * e - b * b;
      if (den <= 1e-12 * a * e) continue;
      const s = (b * f - c * e) / den,
        t = (a * f - b * c) / den;
      if (s <= 1e-6 || s >= 1 - 1e-6 || t <= 1e-6 || t >= 1 - 1e-6) continue;
      const pp = add(p.a, mul(d1, s)),
        qq = add(q.a, mul(d2, t));
      if (dist(pp, qq) <= tol) nodeAt(mul(add(pp, qq), 0.5));
    }
  const members: { piece: Piece; i: number; j: number; ends: [number, number] }[] = [];
  for (const { piece, i, j } of raw) {
    const along = nodes
      .map((n, index) => ({ index, ...project(n, nodes[i], nodes[j]) }))
      .filter(
        (x) => x.index !== i && x.index !== j && x.distance <= tol && x.t > 1e-6 && x.t < 1 - 1e-6,
      )
      .sort((u, v) => u.t - v.t);
    let from = i;
    for (const stop of [...along.map((x) => x.index), j]) {
      members.push({ piece, i: from, j: stop, ends: [i, j] });
      from = stop;
    }
  }
  // Duplicates (same two nodes) keep the first.
  const seen = new Set<string>();
  const unique = members.filter((m) => {
    const k = [m.i, m.j].sort((x, y) => x - y).join('-');
    if (seen.has(k)) {
      issues.push({
        level: 'warning',
        code: 'DUPLICATE',
        message: `같은 두 절점을 잇는 중복 부재 제거 (${m.piece.layer})`,
      });
      return false;
    }
    seen.add(k);
    return m.i !== m.j;
  });

  // 3. Roles.
  const roleOf = (m: (typeof unique)[number]): Role => {
    const d = sub(nodes[m.j], nodes[m.i]);
    const slope = Math.abs(d[2]) / len(d);
    if (m.piece.roleHint === 'column' || (slope >= 0.85 && !m.piece.roleHint)) return 'column';
    if (m.piece.roleHint) return m.piece.roleHint;
    return slope <= 0.1 ? 'beam' : 'brace';
  };
  const roles = unique.map(roleOf);
  const hasColumn = new Set<number>();
  unique.forEach((m, k) => {
    if (roles[k] === 'column') [m.i, m.j].forEach((n) => hasColumn.add(n));
  });
  // A horizontal run whose two original ends frame into columns is a girder, even after it is split
  // at T-junctions. A generic "beam" layer (보/beam) does not prevent this.
  unique.forEach((m, k) => {
    if (roles[k] === 'beam' && hasColumn.has(m.ends[0]) && hasColumn.has(m.ends[1]))
      roles[k] = 'girder';
  });

  // 4. Supports: lowest column ends.
  const zMin = Math.min(
    ...unique
      .filter((_, k) => roles[k] === 'column')
      .flatMap((m) => [nodes[m.i][2], nodes[m.j][2]]),
  );
  const base =
    options.baseFixity === 'fixed'
      ? { dx: true, dy: true, dz: true, rx: true, ry: true, rz: true }
      : { dx: true, dy: true, dz: true, rz: true };
  const supported = new Set<number>();
  if (Number.isFinite(zMin))
    for (const n of hasColumn) if (Math.abs(nodes[n][2] - zMin) <= tol) supported.add(n);
  if (!supported.size)
    issues.push({
      level: 'error',
      code: 'NO_SUPPORT',
      message: '기둥 하단을 찾지 못해 지점이 없음 — 지점을 지정해야 함',
    });

  // 5. Sections.
  const sections = new Map<string, NonNullable<StructureModelInput['sections']>[number]>();
  const sectionFor = (piece: Piece): string => {
    if (piece.section) {
      const id =
        piece.section.shape === 'BH' ? `B${hId(piece.section.dims)}` : hId(piece.section.dims);
      if (!sections.has(id))
        sections.set(id, {
          id,
          name: (piece.section.shape === 'BH' ? 'B' : '') + hName(piece.section.dims),
          shape: piece.section.shape,
          dims_mm: piece.section.dims.r
            ? { ...piece.section.dims }
            : {
                h: piece.section.dims.h,
                b: piece.section.dims.b,
                tw: piece.section.dims.tw,
                tf: piece.section.dims.tf,
              },
          source: piece.section.provenance.by === 'ai' ? 'ai' : 'KS D 3502',
          provenance: piece.section.provenance,
        });
      return id;
    }
    return 'UNASSIGNED';
  };
  const unassigned: string[] = [];

  // 6. Members with the joint rule (SPEC-06.4).
  const ids = nodes.map((_, n) => `N${n + 1}`);
  const outMembers = unique.map((m, k) => {
    const role = roles[k];
    const id = `M${k + 1}`;
    const section = sectionFor(m.piece);
    if (section === 'UNASSIGNED') unassigned.push(id);
    const releases: Record<string, Record<string, boolean>> = {};
    if (role === 'beam' || role === 'girder') {
      for (const [end, n] of [
        ['i', m.i],
        ['j', m.j],
      ] as const) {
        const onGirder = unique.some(
          (o, q) => q !== k && roles[q] === 'girder' && (o.i === n || o.j === n),
        );
        if (role === 'beam' && !hasColumn.has(n) && onGirder)
          releases[end] = { ry: true, rz: true };
      }
    }
    const exception = options.jointExceptions?.filter((x) => x.member === id) ?? [];
    for (const x of exception) {
      if (x.value === 'pin') releases[x.end] = { ry: true, rz: true };
      else delete releases[x.end];
    }
    const d = sub(nodes[m.j], nodes[m.i]);
    return {
      id,
      i: ids[m.i],
      j: ids[m.j],
      section,
      material: 'SM355',
      role,
      kind: role === 'brace' ? ('truss' as const) : ('frame' as const),
      betaDeg: 0,
      ...(Object.keys(releases).length ? { releases } : {}),
      source: m.piece.source,
      provenance: {
        by: 'auto' as const,
        assumed: !m.piece.roleHint && role !== 'column' && Math.abs(d[2]) / len(d) > 0.1,
        note: m.piece.roleHint
          ? `레이어·이름으로 역할 판정 (${m.piece.layer})`
          : '기울기로 역할 판정',
      },
    };
  });
  if (unassigned.length) {
    sections.set('UNASSIGNED', {
      id: 'UNASSIGNED',
      name: '단면 미지정',
      shape: 'H',
      dims_mm: { h: 400, b: 200, tw: 8, tf: 13, r: 16 },
      source: 'user',
      provenance: {
        by: 'auto',
        assumed: true,
        note: '단면을 알 수 없어 임시 H-400x200x8x13 — 지정 필요',
      },
    });
    issues.push({
      level: 'warning',
      code: 'SECTION_ASSUMED',
      message: `${unassigned.length}개 부재의 단면이 없어 임시 단면을 넣음 — 확정 전에 지정 필요`,
      members: unassigned.slice(0, 50),
    });
  }

  const model: StructureModelInput = {
    schema: 'vide.structure.model/1',
    meta: {
      name: 'structure draft',
      sources: sources.map((s) => ({
        kind: s.mode === 'cad' ? ('cad' as const) : ('rhino' as const),
        documentId: s.documentId ?? s.syncId,
        syncId: s.syncId,
      })),
      mergeTolerance_m: tol,
    },
    materials: [
      {
        id: 'SM355',
        grade: 'SM355',
        E_MPa: 210000,
        G_MPa: 81000,
        density_kNpm3: 77,
        Fy_MPa: 355,
        Fu_MPa: 490,
        fyByThickness: [
          { tMax_mm: 16, Fy_MPa: 355 },
          { tMax_mm: 40, Fy_MPa: 345 },
          { tMax_mm: 75, Fy_MPa: 335 },
          { tMax_mm: 100, Fy_MPa: 325 },
        ],
        provenance: {
          by: 'auto',
          assumed: true,
          note: '기본 강종 SM355, 두께별 항복강도·E = 210,000 MPa는 기준 원문 확인 전 가정',
        },
      },
    ],
    sections: [...sections.values()],
    nodes: nodes.map((p, n) => ({
      id: ids[n],
      xyz_m: p,
      ...(supported.has(n)
        ? {
            support: base,
            provenance: {
              by: 'auto' as const,
              assumed: true,
              note: '최하단 기둥 끝 = 핀 지점 가정',
            },
          }
        : {}),
    })),
    members: outMembers,
    loadPatterns: [
      { id: 'D', nature: 'D', selfWeight: true },
      { id: 'L', nature: 'L' },
    ],
    loads: [],
    areaLoads: [],
    combinations: [
      {
        id: '1.2D+1.6L',
        terms: [
          { pattern: 'D', factor: 1.2 },
          { pattern: 'L', factor: 1.6 },
        ],
        limitState: 'strength',
      },
      {
        id: 'D+L',
        terms: [
          { pattern: 'D', factor: 1 },
          { pattern: 'L', factor: 1 },
        ],
        limitState: 'service',
      },
    ],
    analysis: { kind: 'linearStatic' },
  };
  if (!outMembers.length)
    issues.push({ level: 'error', code: 'NO_MEMBERS', message: '입력에서 부재를 찾지 못함' });
  return { model, issues };
}

export type { Element };
