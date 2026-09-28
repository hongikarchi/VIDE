// Sync jig (J-SYNC): relate a Rhino model and a CAD drawing of one project and list what does not
// match. Alignment and matching are computed (reproducible, thousands of objects); judging what a
// difference means is left to the AI review, which may cite only these rows and numbers.
// All coordinates are metres (both Sync results are stored in metres).

export type Point = [number, number, number];
export interface Element {
  id: string;
  nativeId: string;
  host: 'rhino' | 'zwcad';
  layer: string;
  type: string;
  name?: string;
  /** Straight pieces of the element (a line has one). */
  segments: [Point, Point][];
  /** Ordered points when the element is one polyline (Rhino curves). */
  points?: Point[];
  length: number;
}
export interface Transform {
  /** Rhino → CAD in the XY plane: rotate by `rotation` (radians) about the origin, then translate. */
  rotation: number;
  translation: [number, number];
  /** Median height difference CAD − Rhino of matched pairs (CAD drawings are usually at Z = 0). */
  dz: number;
}
export interface Alignment extends Transform {
  pairs: number;
  residual: { max: number; rms: number };
  ambiguous: boolean;
  candidates: (Transform & { votes: number })[];
  source: 'computed' | 'anchor' | 'candidate' | 'identity';
}
export type RowState = 'match' | 'offset' | 'rhino-only' | 'cad-only';
export interface Row {
  id: string;
  state: RowState;
  rhino?: { id: string; nativeId: string; layer: string; name?: string; type: string };
  cad?: { id: string; nativeId: string; layer: string; type: string };
  /** Largest distance between the matched shapes after alignment (metres). */
  deviation?: number;
  /** Rhino end points mapped into the drawing, and the drawing's own (metres), for straight pairs. */
  ends?: { rhino: [Point, Point]; cad: [Point, Point] };
  /** The drawing's end points in model coordinates (for making the model follow the drawing). */
  inRhino?: [Point, Point];
  length?: number;
}
export interface SyncOptions {
  /** Within this distance a pair counts as matching (metres; default 1 mm). */
  tolerance?: number;
  /** Beyond this distance no counterpart is searched (metres; default 100 mm). */
  search?: number;
  /** Only straight elements at least this long take part in the alignment (metres). */
  minLength?: number;
  /** Force the relation from one known pair (Rhino id ↔ CAD id). */
  anchor?: { rhino: string; cad: string };
  /** Use one of a previous run's candidates (when the alignment was ambiguous). */
  candidate?: Transform;
}

const b64 = (value: unknown) => {
  if (typeof value !== 'string' || !value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
};
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Elements of a stored Sync result (Rhino curves as polylines, CAD entities as segment pairs). */
export function elements(result: Record<string, unknown>, host: 'rhino' | 'zwcad'): Element[] {
  const scene = Array.isArray(result.scene) ? (result.scene as Record<string, unknown>[]) : [];
  const names = new Map(
    (Array.isArray(result.objects) ? (result.objects as Record<string, unknown>[]) : []).map(
      (object) => [String(object.id), typeof object.name === 'string' ? object.name : undefined],
    ),
  );
  const out: Element[] = [];
  for (const row of scene) {
    const flat =
      Array.isArray(row.line) && (row.line as number[]).length >= 6
        ? (row.line as number[])
        : undefined;
    const pairs = Array.isArray(row.segments) ? (row.segments as number[]) : [];
    const segments: [Point, Point][] = [];
    let points: Point[] | undefined;
    if (flat) {
      points = [];
      for (let i = 0; i + 2 < flat.length; i += 3) points.push([flat[i], flat[i + 1], flat[i + 2]]);
      for (let i = 1; i < points.length; i++) segments.push([points[i - 1], points[i]]);
    } else if (host === 'zwcad' || !row.vertices || !(row.vertices as number[]).length)
      for (let i = 0; i + 5 < pairs.length; i += 6)
        segments.push([
          [pairs[i], pairs[i + 1], pairs[i + 2]],
          [pairs[i + 3], pairs[i + 4], pairs[i + 5]],
        ]);
    const useful = segments.filter(([a, b]) => distance(a, b) > 1e-6);
    if (!useful.length) continue;
    out.push({
      id: String(row.id),
      nativeId: String(row.nativeId ?? row.id),
      host,
      layer: b64(row.layer64),
      type: String(row.nativeType ?? 'Object'),
      name: names.get(String(row.id)),
      segments: useful,
      points,
      length: useful.reduce((sum, [a, b]) => sum + distance(a, b), 0),
    });
  }
  return out;
}

/** A straight element: one segment, or a polyline whose points stay on its chord. */
function straight(element: Element): [Point, Point] | undefined {
  const first = element.segments[0][0],
    last = element.segments[element.segments.length - 1][1];
  const chord = distance(first, last);
  if (chord < 1e-6) return undefined;
  if (element.segments.length === 1) return [first, last];
  if (element.host === 'zwcad') return undefined;
  const dx = (last[0] - first[0]) / chord,
    dy = (last[1] - first[1]) / chord;
  for (const [a] of element.segments) {
    const off = Math.abs((a[0] - first[0]) * dy - (a[1] - first[1]) * dx);
    if (off > 1e-4) return undefined;
  }
  return Math.abs(element.length - chord) < 1e-4 ? [first, last] : undefined;
}
const angle = ([a, b]: [Point, Point]) => {
  const value = Math.atan2(b[1] - a[1], b[0] - a[0]);
  return ((value % Math.PI) + Math.PI) % Math.PI;
};
const mid = ([a, b]: [Point, Point]): Point => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
  (a[2] + b[2]) / 2,
];
export function apply(t: Transform, p: Point): Point {
  const c = Math.cos(t.rotation),
    s = Math.sin(t.rotation);
  return [
    c * p[0] - s * p[1] + t.translation[0],
    s * p[0] + c * p[1] + t.translation[1],
    p[2] + t.dz,
  ];
}
/** CAD → Rhino (for edits made in the model). */
export function invert(t: Transform, p: Point): Point {
  const x = p[0] - t.translation[0],
    y = p[1] - t.translation[1];
  const c = Math.cos(t.rotation),
    s = Math.sin(t.rotation);
  return [c * x + s * y, -s * x + c * y, p[2] - t.dz];
}

/** Dominant directions (length-weighted, 1° bins) of straight elements. */
function directions(lines: [Point, Point][]) {
  const bins = new Map<number, number>();
  for (const line of lines) {
    const bin = Math.round((angle(line) * 180) / Math.PI) % 180;
    bins.set(bin, (bins.get(bin) ?? 0) + distance(line[0], line[1]));
  }
  return [...bins.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([bin]) => (bin * Math.PI) / 180);
}

/** The Rhino → CAD relation from pairs of equally long, parallel straight elements. */
export function align(rhino: Element[], cad: Element[], options: SyncOptions = {}): Alignment {
  const minLength = options.minLength ?? 0.3;
  const tolerance = Math.max(options.tolerance ?? 0.001, 0.0005);
  const lineA = rhino
    .map((e) => ({ e, s: straight(e) }))
    .filter((x) => x.s && distance(x.s[0], x.s[1]) >= minLength) as {
    e: Element;
    s: [Point, Point];
  }[];
  const lineB = cad
    .map((e) => ({ e, s: straight(e) }))
    .filter((x) => x.s && distance(x.s[0], x.s[1]) >= minLength) as {
    e: Element;
    s: [Point, Point];
  }[];
  const identity: Alignment = {
    rotation: 0,
    translation: [0, 0],
    dz: 0,
    pairs: 0,
    residual: { max: 0, rms: 0 },
    ambiguous: false,
    candidates: [],
    source: 'identity',
  };
  if (options.anchor) {
    const a = rhino.find(
      (e) => e.id === options.anchor!.rhino || e.nativeId === options.anchor!.rhino,
    );
    const b = cad.find((e) => e.id === options.anchor!.cad || e.nativeId === options.anchor!.cad);
    const sa = a && (straight(a) ?? [a.segments[0][0], a.segments[a.segments.length - 1][1]]);
    const sb = b && (straight(b) ?? [b.segments[0][0], b.segments[b.segments.length - 1][1]]);
    if (sa && sb) {
      let rotation = angle(sb) - angle(sa);
      const base: Transform = { rotation, translation: [0, 0], dz: 0 };
      const ma = apply(base, mid(sa)),
        mb = mid(sb);
      const t: Transform = {
        rotation,
        translation: [mb[0] - ma[0], mb[1] - ma[1]],
        dz: mb[2] - mid(sa)[2],
      };
      return {
        ...refine(t, lineA, lineB, tolerance),
        candidates: [],
        ambiguous: false,
        source: 'anchor',
      };
    }
  }
  if (options.candidate)
    return {
      ...refine(options.candidate, lineA, lineB, tolerance),
      candidates: [],
      ambiguous: false,
      source: 'candidate',
    };
  if (!lineA.length || !lineB.length) return identity;
  // Rotation candidates: no rotation, and the difference of the dominant directions.
  const rotations = new Set<number>([0]);
  const da = directions(lineA.map((x) => x.s)),
    db = directions(lineB.map((x) => x.s));
  for (const a of da.slice(0, 2))
    for (const b of db.slice(0, 2)) {
      const r = Math.round(((((b - a) % Math.PI) + Math.PI) % Math.PI) * 1e6) / 1e6;
      rotations.add(r);
      rotations.add(Math.round((r - Math.PI) * 1e6) / 1e6);
    }
  // CAD lines bucketed by length (1 mm) for pair lookup.
  const byLength = new Map<number, typeof lineB>();
  for (const x of lineB) {
    const key = Math.round(distance(x.s[0], x.s[1]) * 1000);
    for (const k of [key - 1, key, key + 1]) byLength.set(k, [...(byLength.get(k) ?? []), x]);
  }
  const cell = Math.max(tolerance * 5, 0.005);
  const results: (Transform & { votes: number })[] = [];
  for (const rotation of rotations) {
    const votes = new Map<string, { n: number; x: number; y: number; z: number[] }>();
    for (const a of lineA) {
      const candidates = byLength.get(Math.round(distance(a.s[0], a.s[1]) * 1000)) ?? [];
      const ra: [Point, Point] = [
        apply({ rotation, translation: [0, 0], dz: 0 }, a.s[0]),
        apply({ rotation, translation: [0, 0], dz: 0 }, a.s[1]),
      ];
      const aa = angle(ra);
      for (const b of candidates.slice(0, 400)) {
        const diff = Math.abs(aa - angle(b.s));
        if (Math.min(diff, Math.PI - diff) > 0.002) continue;
        const ma = mid(ra),
          mb = mid(b.s);
        const tx = mb[0] - ma[0],
          ty = mb[1] - ma[1];
        const key = Math.round(tx / cell) + ':' + Math.round(ty / cell);
        const slot = votes.get(key) ?? { n: 0, x: 0, y: 0, z: [] };
        slot.n++;
        slot.x += tx;
        slot.y += ty;
        slot.z.push(mb[2] - mid(a.s)[2]);
        votes.set(key, slot);
      }
    }
    for (const slot of votes.values())
      results.push({
        rotation,
        translation: [slot.x / slot.n, slot.y / slot.n],
        dz: slot.z.sort((p, q) => p - q)[Math.floor(slot.z.length / 2)],
        votes: slot.n,
      });
  }
  if (!results.length) return identity;
  results.sort((a, b) => b.votes - a.votes);
  // Distinct candidates (merge the same relation found through neighbouring cells).
  const distinct: typeof results = [];
  for (const r of results) {
    if (
      distinct.some(
        (d) =>
          Math.abs(d.rotation - r.rotation) < 1e-4 &&
          Math.hypot(d.translation[0] - r.translation[0], d.translation[1] - r.translation[1]) <
            cell * 2,
      )
    )
      continue;
    distinct.push(r);
    if (distinct.length === 4) break;
  }
  const best = refine(distinct[0], lineA, lineB, tolerance);
  const scored = distinct.map((c) => ({ ...c, votes: refine(c, lineA, lineB, tolerance).pairs }));
  scored.sort((a, b) => b.votes - a.votes);
  const ambiguous = scored.length > 1 && scored[1].votes >= Math.max(2, scored[0].votes * 0.8);
  return {
    ...best,
    ambiguous,
    candidates: ambiguous ? scored.slice(0, 3) : [],
    source: 'computed',
  };
}

/** Least-squares translation over the pairs a relation explains; its pair count and residuals. */
function refine(
  t: Transform,
  lineA: { e: Element; s: [Point, Point] }[],
  lineB: { e: Element; s: [Point, Point] }[],
  tolerance: number,
) {
  const grid = index(
    lineB.map((x) => ({ key: x, at: mid(x.s) })),
    0.05,
  );
  const pairs: { da: [Point, Point]; db: [Point, Point] }[] = [];
  for (const a of lineA) {
    const ra: [Point, Point] = [apply(t, a.s[0]), apply(t, a.s[1])];
    let best: { d: number; s: [Point, Point] } | undefined;
    for (const b of near(grid, mid(ra), 0.05)) {
      const d = ends(ra, b.key.s);
      if (d < (best?.d ?? Math.max(tolerance * 20, 0.02))) best = { d, s: b.key.s };
    }
    if (best) pairs.push({ da: ra, db: best.s });
  }
  if (!pairs.length) return { ...t, pairs: 0, residual: { max: 0, rms: 0 } };
  // Median end-point offsets: one drifted element does not pull the whole relation.
  const xs: number[] = [],
    ys: number[] = [];
  for (const { da, db } of pairs) {
    const [a0, a1] = order(da, db);
    xs.push(db[0][0] - a0[0], db[1][0] - a1[0]);
    ys.push(db[0][1] - a0[1], db[1][1] - a1[1]);
  }
  const median = (values: number[]) => {
    const sorted = [...values].sort((p, q) => p - q);
    const half = sorted.length / 2;
    return sorted.length % 2 ? sorted[Math.floor(half)] : (sorted[half - 1] + sorted[half]) / 2;
  };
  const sx = median(xs),
    sy = median(ys);
  const refined: Transform = { ...t, translation: [t.translation[0] + sx, t.translation[1] + sy] };
  const residuals = pairs.map(({ da, db }) => {
    const moved: [Point, Point] = [
      [da[0][0] + sx, da[0][1] + sy, da[0][2]],
      [da[1][0] + sx, da[1][1] + sy, da[1][2]],
    ];
    return ends(moved, db);
  });
  return {
    ...refined,
    pairs: pairs.length,
    residual: {
      max: Math.max(...residuals),
      rms: Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / residuals.length),
    },
  };
}
/** End points of `a` in the order that best matches `b`. */
const order = (a: [Point, Point], b: [Point, Point]): [Point, Point] =>
  distance(a[0], b[0]) + distance(a[1], b[1]) <= distance(a[0], b[1]) + distance(a[1], b[0])
    ? a
    : [a[1], a[0]];
/** Largest end point distance of two segments (either direction). */
const ends = (a: [Point, Point], b: [Point, Point]) => {
  const [p, q] = order(a, b);
  return Math.max(distance(p, b[0]), distance(q, b[1]));
};

interface Grid<T> {
  size: number;
  cells: Map<string, { key: T; at: Point }[]>;
}
function index<T>(items: { key: T; at: Point }[], size: number): Grid<T> {
  const cells = new Map<string, { key: T; at: Point }[]>();
  for (const item of items) {
    const k = Math.floor(item.at[0] / size) + ':' + Math.floor(item.at[1] / size);
    cells.set(k, [...(cells.get(k) ?? []), item]);
  }
  return { size, cells };
}
function near<T>(grid: Grid<T>, at: Point, radius: number) {
  const out: { key: T; at: Point }[] = [];
  const r = Math.ceil(radius / grid.size);
  const cx = Math.floor(at[0] / grid.size),
    cy = Math.floor(at[1] / grid.size);
  for (let x = cx - r; x <= cx + r; x++)
    for (let y = cy - r; y <= cy + r; y++) out.push(...(grid.cells.get(x + ':' + y) ?? []));
  return out;
}

/** Sampled outline of an element (for curves and multi-segment entities). */
function samples(element: Element, t?: Transform): Point[] {
  const pts: Point[] = [];
  for (const [a, b] of element.segments) {
    pts.push(t ? apply(t, a) : a);
    if (pts.length > 400) break;
  }
  const last = element.segments[element.segments.length - 1][1];
  pts.push(t ? apply(t, last) : last);
  return pts;
}
/** Largest distance from any point of `a` to the polyline `b` (one-sided Hausdorff, XY). */
function spread(a: Point[], b: [Point, Point][]) {
  let worst = 0;
  for (const p of a) {
    let best = Infinity;
    for (const [s, e] of b) {
      const dx = e[0] - s[0],
        dy = e[1] - s[1];
      const len = dx * dx + dy * dy || 1;
      const k = Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / len));
      best = Math.min(best, Math.hypot(s[0] + k * dx - p[0], s[1] + k * dy - p[1]));
      if (best === 0) break;
    }
    worst = Math.max(worst, best);
    if (worst > 10) break;
  }
  return worst;
}

/** Pair every Rhino element with its drawing counterpart after alignment and classify the pair. */
export function compare(rhino: Element[], cad: Element[], t: Transform, options: SyncOptions = {}) {
  const tolerance = options.tolerance ?? 0.001;
  const search = options.search ?? 0.1;
  const centre = (e: Element, tr?: Transform) => {
    const pts = samples(e, tr);
    const xs = pts.map((p) => p[0]),
      ys = pts.map((p) => p[1]);
    return [
      (Math.min(...xs) + Math.max(...xs)) / 2,
      (Math.min(...ys) + Math.max(...ys)) / 2,
      0,
    ] as Point;
  };
  const grid = index(
    cad.map((e) => ({ key: e, at: centre(e) })),
    Math.max(search, 0.5),
  );
  const used = new Set<string>();
  const candidates: { a: Element; b: Element; d: number }[] = [];
  for (const a of rhino) {
    const pa = samples(a, t);
    const reach = Math.max(search, a.length / 2 + search);
    for (const { key: b } of near(grid, centre(a, t), reach)) {
      if (Math.abs(b.length - a.length) > Math.max(search * 2, a.length * 0.2)) continue;
      const d = Math.max(
        spread(pa, b.segments),
        spread(
          samples(b),
          a.segments.map(([p, q]) => [apply(t, p), apply(t, q)] as [Point, Point]),
        ),
      );
      if (d <= search) candidates.push({ a, b, d });
    }
  }
  // Closest pairs first, each element used once.
  candidates.sort((x, y) => x.d - y.d);
  const rows: Row[] = [];
  const paired = new Set<string>();
  for (const c of candidates) {
    if (paired.has(c.a.id) || used.has(c.b.id)) continue;
    paired.add(c.a.id);
    used.add(c.b.id);
    const sa = straight(c.a),
      sb = straight(c.b);
    rows.push({
      id: '',
      state: c.d <= tolerance ? 'match' : 'offset',
      rhino: {
        id: c.a.id,
        nativeId: c.a.nativeId,
        layer: c.a.layer,
        name: c.a.name,
        type: c.a.type,
      },
      cad: { id: c.b.id, nativeId: c.b.nativeId, layer: c.b.layer, type: c.b.type },
      deviation: c.d,
      length: c.a.length,
      ...(sa && sb
        ? {
            ends: { rhino: order([apply(t, sa[0]), apply(t, sa[1])], sb), cad: sb },
            inRhino: order([invert(t, sb[0]), invert(t, sb[1])], sa),
          }
        : {}),
    });
  }
  for (const a of rhino)
    if (!paired.has(a.id))
      rows.push({
        id: '',
        state: 'rhino-only',
        rhino: { id: a.id, nativeId: a.nativeId, layer: a.layer, name: a.name, type: a.type },
        length: a.length,
        ...(straight(a)
          ? {
              ends: {
                rhino: straight(a)!.map((p) => apply(t, p)) as [Point, Point],
                cad: straight(a)!.map((p) => apply(t, p)) as [Point, Point],
              },
            }
          : {}),
      });
  for (const b of cad)
    if (!used.has(b.id))
      rows.push({
        id: '',
        state: 'cad-only',
        cad: { id: b.id, nativeId: b.nativeId, layer: b.layer, type: b.type },
        length: b.length,
        ...(straight(b)
          ? {
              ends: { rhino: straight(b)!, cad: straight(b)! },
              inRhino: straight(b)!.map((p) => invert(t, p)) as [Point, Point],
            }
          : {}),
      });
  const rank: Record<RowState, number> = { offset: 0, 'rhino-only': 1, 'cad-only': 2, match: 3 };
  rows.sort((x, y) => rank[x.state] - rank[y.state] || (y.deviation ?? 0) - (x.deviation ?? 0));
  rows.forEach((row, i) => (row.id = 'R' + (i + 1)));
  // Which Rhino layer corresponds to which drawing layer (by matched pairs).
  const mapping = new Map<string, number>();
  for (const row of rows)
    if (row.rhino && row.cad) {
      const key = row.rhino.layer + '\u0000' + row.cad.layer;
      mapping.set(key, (mapping.get(key) ?? 0) + 1);
    }
  const layers = [...mapping.entries()]
    .map(([key, pairs]) => {
      const [rhinoLayer, cadLayer] = key.split('\u0000');
      return { rhino: rhinoLayer, cad: cadLayer, pairs };
    })
    .sort((a, b) => b.pairs - a.pairs);
  const count = (state: RowState) => rows.filter((row) => row.state === state).length;
  return {
    rows,
    layers,
    summary: {
      match: count('match'),
      offset: count('offset'),
      rhinoOnly: count('rhino-only'),
      cadOnly: count('cad-only'),
    },
  };
}

/** The whole jig run: elements (optionally only some layers), relation, comparison. */
export function runSync(
  rhinoResult: Record<string, unknown>,
  cadResult: Record<string, unknown>,
  options: SyncOptions & { rhinoLayers?: string[]; cadLayers?: string[] } = {},
) {
  const allRhino = elements(rhinoResult, 'rhino'),
    allCad = elements(cadResult, 'zwcad');
  const pick = (list: Element[], layers?: string[]) =>
    layers?.length ? list.filter((e) => layers.includes(e.layer)) : list;
  const rhino = pick(allRhino, options.rhinoLayers),
    cad = pick(allCad, options.cadLayers);
  const alignment = align(rhino, cad, options);
  const comparison = compare(rhino, cad, alignment, options);
  const layerList = (list: Element[]) =>
    [...list.reduce((m, e) => m.set(e.layer, (m.get(e.layer) ?? 0) + 1), new Map<string, number>())]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  return {
    alignment,
    ...comparison,
    rhinoLayers: layerList(allRhino),
    cadLayers: layerList(allCad),
    counts: { rhino: rhino.length, cad: cad.length },
  };
}
