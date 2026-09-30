// Synthetic S-06-like layouts for the diagnosis tests (PLAN-23 결정 A12: never real S-06 data;
// only the kinds and sizes of its blocks). A case is drawn in a local grid frame (u along the new
// grid, v across), turned by the grid angle, moved to site coordinates and written as the two Sync
// results the diagnosis reads: the structure model (columns, girders, new footing blocks) and the
// civil model (existing footing blocks, the basin's beams as solids).

export type Local = [number, number];
type Xyz = [number, number, number];

export interface SyntheticLayout {
  /** Grid angle from +x (deg) and site position of the local origin. */
  angleDeg: number;
  origin: Local;
  /** Column bottom and top z. `reversed` draws the curve top → bottom. */
  columnZ: [number, number];
  columns: { at: Local; reversed?: boolean }[];
  /** Girder polylines in local u, v (and z; default the column top). */
  girders: (Local | Xyz)[][];
  /** New footing blocks; default one `cap` under every column. */
  caps?: { at: Local; definition: 'cap' | 'cap-solid' | 'missing' }[];
  /** Existing footing blocks: 2.7 m base slab with a pedestal; `turnDeg` adds to the grid angle. */
  existing: { at: Local; turnDeg?: number; definition?: 'old' | 'missing' }[];
  /** Basin beams: solids along from → to with a width (m), z range default −3.0 … −2.0. */
  bands: { from: Local; to: Local; width: number }[];
  /** Slab outline (local ring) drawn as a closed curve at the column top; voids likewise (M1). */
  slab?: Local[];
  voids?: Local[][];
  /** Existing grid lines with names, new and existing expansion joints (local segments). */
  grid?: { name: string; from: Local; to: Local }[];
  newEJ?: { name?: string; from: Local; to: Local }[];
  existingEJ?: { name?: string; from: Local; to: Local }[];
  /** Drawn zones of the instance (local rings): fire route (no columns) and requested areas. */
  fire?: Local[][];
  requested?: { id: string; ring: Local[] }[];
  /** Load zones of the instance (local rings, M2): planter and dry areas. */
  planter?: Local[][];
  dry?: Local[][];
}

export interface SyntheticSync {
  hostExecuted: true;
  executionMode: 'sdk';
  host: 'rhino';
  sourceDocument: { name: string; capturedAt: string; instance: string; documentId: number };
  scene: Record<string, unknown>[];
  definitions: Record<
    string,
    { hash: string; vertices: number[]; indices: number[]; segments: number[] }
  >;
  objects: { id: string; name: string; kind: string; nativeId: string }[];
}

/** Pile cap 2.0 m square (z −1.2 … 0) with its 3.6 m open cut outline at the cap bottom. */
export const CAP = { size: 2.0, openCut: 3.6, z: [-1.2, 0] as [number, number] };
/** Existing footing: 2.7 m base slab (z −3.0 … −2.4) under a 0.8 m pedestal (… −1.0). */
export const OLD = { size: 2.7, pedestal: 0.8 };
export const DEFINITION_ID = {
  cap: '00000000-0000-4000-8000-00000000ca01',
  'cap-solid': '00000000-0000-4000-8000-00000000ca02',
  old: '00000000-0000-4000-8000-00000000e001',
  missing: '00000000-0000-4000-8000-00000000dead',
} as const;
export const LAYERS = {
  columns: '기둥',
  girders: '거더',
  newFootings: '신설 기초',
  existingFootings: '기존 기초',
  basinGirders: '유수지 보',
  slab: '슬래브',
  voids: '보이드',
  existingGrid: '기존 그리드',
  newEJ: '신설 EJ',
  existingEJ: '기존 EJ',
} as const;
export type LayerRole = keyof typeof LAYERS;
/** Which synthetic document holds each role's layer. */
export const HOME: Record<LayerRole, 'structure' | 'civil'> = {
  columns: 'structure',
  girders: 'structure',
  newFootings: 'structure',
  slab: 'structure',
  voids: 'structure',
  newEJ: 'structure',
  existingFootings: 'civil',
  basinGirders: 'civil',
  existingGrid: 'civil',
  existingEJ: 'civil',
};

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

function box(sx: number, sy: number, z0: number, z1: number, center: Local = [0, 0]) {
  const vertices: number[] = [];
  for (const z of [z0, z1])
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ])
      vertices.push(center[0] + (x * sx) / 2, center[1] + (y * sy) / 2, z);
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  return { vertices, indices: quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]) };
}
function merge(...meshes: { vertices: number[]; indices: number[] }[]) {
  const vertices: number[] = [],
    indices: number[] = [];
  for (const mesh of meshes) {
    const base = vertices.length / 3;
    vertices.push(...mesh.vertices);
    indices.push(...mesh.indices.map((i) => i + base));
  }
  return { vertices, indices };
}
function squareOutline(size: number, z: number) {
  const h = size / 2;
  const corners: Local[] = [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ];
  return corners.flatMap((p, i) => {
    const q = corners[(i + 1) % 4];
    return [p[0], p[1], z, q[0], q[1], z];
  });
}

function definitions() {
  const cap = box(CAP.size, CAP.size, CAP.z[0], CAP.z[1]);
  const old = merge(box(OLD.size, OLD.size, -3.0, -2.4), box(OLD.pedestal, OLD.pedestal, -2.4, -1));
  return {
    [DEFINITION_ID.cap]: { hash: 'cap', ...cap, segments: squareOutline(CAP.openCut, CAP.z[0]) },
    [DEFINITION_ID['cap-solid']]: { hash: 'cap-solid', ...cap, segments: [] },
    [DEFINITION_ID.old]: { hash: 'old', ...old, segments: [] },
  };
}

/** Build both Sync results of a layout, and the local → site mapping for the expectations. */
export function buildCase(layout: SyntheticLayout, names = ['합성-구조.3dm', '합성-토목.3dm']) {
  const a = (layout.angleDeg * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const toSite = ([u, v]: Local): Local => [
    layout.origin[0] + c * u - s * v,
    layout.origin[1] + s * u + c * v,
  ];
  const transform = (at: Local, z: number, turnDeg = 0) => {
    const t = ((layout.angleDeg + turnDeg) * Math.PI) / 180;
    const [x, y] = toSite(at);
    return [
      Math.cos(t),
      -Math.sin(t),
      0,
      x,
      Math.sin(t),
      Math.cos(t),
      0,
      y,
      0,
      0,
      1,
      z,
      0,
      0,
      0,
      1,
    ];
  };
  const sync = (name: string, documentId: number): SyntheticSync => ({
    hostExecuted: true,
    executionMode: 'sdk',
    host: 'rhino',
    sourceDocument: { name, capturedAt: 'synthetic', instance: 'test', documentId },
    scene: [],
    definitions: definitions(),
    objects: [],
  });
  const structure = sync(names[0], 1),
    civil = sync(names[1], 2);
  const add = (target: SyntheticSync, layer: string, row: Record<string, unknown>, name = '') => {
    const n = target.scene.length + 1;
    const id = `${target === structure ? 's' : 'c'}${n}`;
    const nativeId = `00000000-0000-4000-8000-${String(target.sourceDocument.documentId * 100000 + n).padStart(12, '0')}`;
    target.scene.push({ id, nativeId, layer64: b64(layer), name64: name ? b64(name) : '', ...row });
    target.objects.push({ id, name, kind: 'native', nativeId });
  };

  const [z0, z1] = layout.columnZ;
  const closed = (ring: Local[], z: number) => [...ring, ring[0]].flatMap((p) => [...toSite(p), z]);
  if (layout.slab)
    add(structure, LAYERS.slab, { nativeType: 'Curve', line: closed(layout.slab, z1) });
  for (const ring of layout.voids ?? [])
    add(structure, LAYERS.voids, { nativeType: 'Curve', line: closed(ring, z1) });
  const segment = (from: Local, to: Local, z: number) => [...toSite(from), z, ...toSite(to), z];
  for (const line of layout.grid ?? [])
    add(
      civil,
      LAYERS.existingGrid,
      { nativeType: 'Curve', line: segment(line.from, line.to, 0) },
      line.name,
    );
  (layout.newEJ ?? []).forEach((line, k) =>
    add(
      structure,
      LAYERS.newEJ,
      { nativeType: 'Curve', line: segment(line.from, line.to, z1) },
      line.name ?? `EJ${k + 1}`,
    ),
  );
  (layout.existingEJ ?? []).forEach((line, k) =>
    add(
      civil,
      LAYERS.existingEJ,
      { nativeType: 'Curve', line: segment(line.from, line.to, 0) },
      line.name ?? `XEJ${k + 1}`,
    ),
  );
  for (const column of layout.columns) {
    const [x, y] = toSite(column.at);
    const ends = [
      [x, y, z0],
      [x, y, z1],
    ];
    if (column.reversed) ends.reverse();
    add(structure, LAYERS.columns, { nativeType: 'Curve', line: ends.flat() });
  }
  for (const girder of layout.girders)
    add(structure, LAYERS.girders, {
      nativeType: 'Curve',
      line: girder.flatMap((p) => [...toSite([p[0], p[1]]), p.length > 2 ? p[2]! : z1]),
    });
  const caps =
    layout.caps ?? layout.columns.map((col) => ({ at: col.at, definition: 'cap' as const }));
  for (const cap of caps)
    add(structure, LAYERS.newFootings, {
      nativeType: 'InstanceReference',
      block: { definition: DEFINITION_ID[cap.definition], transform: transform(cap.at, z0) },
    });
  for (const footing of layout.existing)
    add(civil, LAYERS.existingFootings, {
      nativeType: 'InstanceReference',
      block: {
        definition: DEFINITION_ID[footing.definition ?? 'old'],
        transform: transform(footing.at, 0, footing.turnDeg),
      },
    });
  for (const band of layout.bands) {
    const du = band.to[0] - band.from[0],
      dv = band.to[1] - band.from[1];
    const length = Math.hypot(du, dv);
    const [nu, nv] = [(-dv / length) * (band.width / 2), (du / length) * (band.width / 2)];
    const corners: Local[] = [
      [band.from[0] - nu, band.from[1] - nv],
      [band.to[0] - nu, band.to[1] - nv],
      [band.to[0] + nu, band.to[1] + nv],
      [band.from[0] + nu, band.from[1] + nv],
    ];
    const mesh = box(2, 2, -3, -2);
    // The unit box's corners are replaced by the band's, bottom ring then top ring.
    const vertices = [-3, -2].flatMap((z) => corners.flatMap((p) => [...toSite(p), z]));
    add(civil, LAYERS.basinGirders, { nativeType: 'Brep', vertices, indices: mesh.indices });
  }
  return { structure, civil, toSite };
}

/** Rows of one layer as a role snapshot `{ rows, definitions }` (the runtime decodes `layer`). */
export function roleSnapshot(sync: SyntheticSync, layer: string) {
  const wanted = b64(layer);
  const rows: Record<string, unknown>[] = sync.scene
    .filter((row) => row.layer64 === wanted)
    .map((row) => ({ ...row, layer }));
  const definitions: Record<string, unknown> = {};
  for (const row of rows) {
    const block = row.block as { definition?: string } | undefined;
    if (block?.definition && sync.definitions[block.definition])
      definitions[block.definition] = sync.definitions[block.definition];
  }
  return { rows, definitions };
}

/**
 * The v3 `input.json` of a built case: assembly roles as `{ rows, definitions }` from the document
 * that holds each layer, and the drawn zones in world coordinates (ARCH-03 §3 자체 시험 자료).
 */
export function roleInputs(
  built: ReturnType<typeof buildCase>,
  layout: SyntheticLayout,
  roles: readonly LayerRole[] = Object.keys(LAYERS) as LayerRole[],
) {
  const site: Record<
    string,
    { rows: Record<string, unknown>[]; definitions: Record<string, unknown> }
  > = {};
  for (const role of roles) {
    const snapshot = roleSnapshot(built[HOME[role]], LAYERS[role]);
    if (snapshot.rows.length) site[role] = snapshot;
  }
  const zone = (id: string, ring: Local[]) => ({
    id,
    shape: ring.map((p) => built.toSite(p)),
    source: { value: id, by: 'sketch', at: 'synthetic' },
  });
  return {
    site,
    fireRoute: (layout.fire ?? []).map((ring, k) => zone(`fire-${k + 1}`, ring)),
    requestedZones: (layout.requested ?? []).map((r) => zone(r.id, r.ring)),
    ...(layout.planter
      ? { planterZones: layout.planter.map((ring, k) => zone(`planter-${k + 1}`, ring)) }
      : {}),
    ...(layout.dry ? { dryZones: layout.dry.map((ring, k) => zone(`dry-${k + 1}`, ring)) } : {}),
  };
}

/**
 * −21° grid mixing 4.0 and 5.559 m bays (PLAN-23 `grid-rot21`). Expected with the defaults:
 * 10 columns; cap 불가 4, open cut 협의 7, column ↔ basin beam 경고 2; spans 12 with 2 over
 * 12 m (13.559 m row girder, 16.590 m diagonal), 1 overhang; curves 6 with 4 over 12 m.
 */
export const gridRot21: SyntheticLayout = {
  angleDeg: -21,
  origin: [5000, 3000],
  columnZ: [0, 6],
  columns: [
    { at: [0, 0] },
    { at: [4, 0], reversed: true },
    { at: [9.559, 0] },
    { at: [13.559, 0] },
    { at: [0, 5.559] },
    { at: [4, 5.559] },
    { at: [9.559, 5.559], reversed: true },
    { at: [13.559, 5.559] },
    { at: [0, 9.559] },
    { at: [13.559, 9.559] },
  ],
  girders: [
    [
      [0, 0],
      [13.559, 0],
    ],
    [
      [0, 5.559],
      [9.559, 5.559],
      [13.559, 5.559],
    ],
    [
      [0, 9.559],
      [13.559, 9.559],
    ],
    [
      [0, -1.5],
      [0, 9.559],
    ],
    [
      [13.559, 0],
      [13.559, 9.559],
    ],
    [
      [0, 0],
      [13.559, 9.559],
    ],
  ],
  existing: [
    { at: [0, 1.5] },
    { at: [4, -2.8] },
    { at: [6.559, -3.0] },
    { at: [13.559, 2.2] },
    { at: [2.6, 5.559] },
    { at: [9.559, 7.059] },
  ],
  bands: [
    { from: [-1, 5.959], to: [8, 5.959], width: 0.6 },
    { from: [11.5, -1], to: [11.5, 11], width: 0.6 },
  ],
};

/**
 * 4 m bays where existing footings clear the caps in one direction only (PLAN-23 `grid-4m-bay`),
 * and one footing turned 45° whose unrotated bounding box would overlap but whose real footprint
 * keeps 0.771 m. Expected: cap 불가 0 (gaps 0.15, 0.15, 0.771), open cut 협의 3, basin 경고 0.
 */
export const grid4mBay: SyntheticLayout = {
  angleDeg: -21,
  origin: [3000, 1000],
  columnZ: [0, 6],
  columns: [{ at: [0, 0] }, { at: [4, 0] }, { at: [8, 0] }],
  girders: [
    [
      [0, 0],
      [8, 0],
    ],
  ],
  existing: [{ at: [0, 2.5] }, { at: [4, -2.5] }, { at: [10.5, 2.5], turnDeg: 45 }],
  bands: [{ from: [-2, -0.9], to: [10, -0.9], width: 0.6 }],
};

/**
 * Girders cut over column tops: a straight girder rising at its far end with columns on it, 0.29 m
 * beside it (cut), 0.31 m beside it (not cut) and 0.25 m past its end (the end); and a 10 m arch in
 * a vertical plane between two columns (span = plan length 10, longer along the curve).
 */
export const curveSplit: SyntheticLayout = {
  angleDeg: 0,
  origin: [0, 0],
  columnZ: [0, 6],
  columns: [
    { at: [0, 0] },
    { at: [6, 0.29], reversed: true },
    { at: [9, -0.31] },
    { at: [12, 0] },
    { at: [16.25, 0] },
    { at: [0, 10] },
    { at: [10, 10] },
  ],
  girders: [
    [
      [-2, 0, 6],
      [8, 0, 6],
      [16, 0, 7],
    ],
    Array.from({ length: 11 }, (_, i): Xyz => [i, 10, 6 + 1 - ((i - 5) / 5) ** 2]),
  ],
  existing: [],
  bands: [],
};
