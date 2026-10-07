// Synthetic SHP files for the site modeling jig (PLAN-45 T-207): a 연속지적도 layer (two lots and a
// road strip), a 수치지형도 building layer (floors only, one wall-less canopy), contours and spot
// heights, all in EPSG:5186 with UTF-8 .cpg. Every PNU, name and coordinate is invented
// (법정동 1199920100 does not exist). The writers follow the ESRI shapefile and dBASE layouts.

const utf8 = (s) => new TextEncoder().encode(s);
const PRJ_5186 =
  'PROJCS["Korea_2000_Korea_Central_Belt_2010",GEOGCS["GCS_Korea_2000",DATUM["D_Korea_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",200000.0],PARAMETER["False_Northing",600000.0],PARAMETER["Central_Meridian",127.0],PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",38.0],UNIT["Meter",1.0]]';

function writeShp(type, shapes) {
  const z = type === 11 || type === 13 || type === 15;
  const recs = shapes.map((shape) => {
    if (type === 1 || type === 11) {
      const [x, y, zz = 0] = shape.points[0];
      const b = new DataView(new ArrayBuffer(z ? 36 : 20));
      b.setInt32(0, type, true);
      b.setFloat64(4, x, true);
      b.setFloat64(12, y, true);
      if (z) b.setFloat64(20, zz, true);
      return new Uint8Array(b.buffer);
    }
    const pts = shape.parts.flat();
    const n = pts.length;
    const np = shape.parts.length;
    const size = 44 + 4 * np + 16 * n + (z ? 32 + 16 * n : 0);
    const b = new DataView(new ArrayBuffer(size));
    b.setInt32(0, type, true);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) =>
      b.setFloat64(4 + i * 8, v, true),
    );
    b.setInt32(36, np, true);
    b.setInt32(40, n, true);
    let start = 0;
    shape.parts.forEach((part, k) => {
      b.setInt32(44 + k * 4, start, true);
      start += part.length;
    });
    const xy = 44 + 4 * np;
    pts.forEach((p, i) => {
      b.setFloat64(xy + i * 16, p[0], true);
      b.setFloat64(xy + i * 16 + 8, p[1], true);
    });
    if (z) {
      const zs = pts.map((p) => p[2] ?? 0);
      const zo = xy + 16 * n;
      b.setFloat64(zo, Math.min(...zs), true);
      b.setFloat64(zo + 8, Math.max(...zs), true);
      zs.forEach((v, i) => b.setFloat64(zo + 16 + i * 8, v, true));
    }
    return new Uint8Array(b.buffer);
  });
  const total = 100 + recs.reduce((s, r) => s + 8 + r.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, 9994, false);
  dv.setInt32(24, total / 2, false);
  dv.setInt32(28, 1000, true);
  dv.setInt32(32, type, true);
  const all = shapes.flatMap((s) => (s.points ? s.points : s.parts.flat()));
  [
    Math.min(...all.map((p) => p[0])),
    Math.min(...all.map((p) => p[1])),
    Math.max(...all.map((p) => p[0])),
    Math.max(...all.map((p) => p[1])),
  ].forEach((v, i) => dv.setFloat64(36 + i * 8, v, true));
  let off = 100;
  recs.forEach((r, i) => {
    dv.setInt32(off, i + 1, false);
    dv.setInt32(off + 4, r.length / 2, false);
    out.set(r, off + 8);
    off += 8 + r.length;
  });
  return out;
}

/** fields: [name, 'C'|'N', length, decimals]. */
function writeDbf(fields, rows) {
  const hlen = 32 + 32 * fields.length + 1;
  const rlen = 1 + fields.reduce((s, f) => s + f[2], 0);
  const out = new Uint8Array(hlen + rows.length * rlen + 1);
  const dv = new DataView(out.buffer);
  out[0] = 0x03;
  dv.setUint32(4, rows.length, true);
  dv.setUint16(8, hlen, true);
  dv.setUint16(10, rlen, true);
  fields.forEach(([name, type, len, dec], i) => {
    const o = 32 + i * 32;
    out.set(utf8(name), o);
    out[o + 11] = type.charCodeAt(0);
    out[o + 16] = len;
    out[o + 17] = dec ?? 0;
  });
  out[hlen - 1] = 0x0d;
  rows.forEach((row, r) => {
    const base = hlen + r * rlen;
    out.fill(0x20, base, base + rlen);
    let o = base + 1;
    fields.forEach(([, type, len], i) => {
      const v = row[i];
      const bytes = type === 'N' ? utf8(v === null ? '' : String(v).padStart(len)) : utf8(v ?? '');
      out.set(bytes.subarray(0, len), o);
      o += len;
    });
  });
  out[out.length - 1] = 0x1a;
  return out;
}

function layer(base, { type, shapes, fields, rows }) {
  return [
    { name: `${base}.shp`, bytes: writeShp(type, shapes) },
    { name: `${base}.dbf`, bytes: writeDbf(fields, rows) },
    { name: `${base}.prj`, bytes: utf8(PRJ_5186) },
    { name: `${base}.cpg`, bytes: utf8('UTF-8') },
  ];
}

export const SHP_DONG = '1199920100';
export const SHP_TARGET = `${SHP_DONG}100120004`;
export const SHP_NEIGHBOUR = `${SHP_DONG}100120005`;
export const SHP_ROAD = `${SHP_DONG}100130000`;
export const SHP_X = 203000;
export const SHP_Y = 551000;
const rect = (x, y, w, h, z = 0) => [
  [x, y, z],
  [x + w, y, z],
  [x + w, y + h, z],
  [x, y + h, z],
];
const cw = (ring) => [...ring].reverse(); // shapefile outer rings are clockwise
const closed = (ring) => [...ring, ring[0]];

/** The synthetic site as named SHP parts (`{name, bytes}`), ready for importShapefiles. */
export function siteShapefiles({ x = SHP_X, y = SHP_Y } = {}) {
  const X = x;
  const Y = y;
  return [
    ...layer('LSMD_CONT_LDREG_99999', {
      type: 5,
      shapes: [
        { parts: [closed(cw(rect(X, Y, 20, 30)))] },
        { parts: [closed(cw(rect(X + 20, Y, 15, 30)))] },
        { parts: [closed(cw(rect(X - 20, Y - 8, 80, 8)))] },
      ],
      fields: [
        ['PNU', 'C', 19],
        ['JIBUN', 'C', 30],
        ['BCHK', 'C', 1],
      ],
      rows: [
        [SHP_TARGET, '12-4 대', '1'],
        [SHP_NEIGHBOUR, '12-5 대', '1'],
        [SHP_ROAD, '13 도', '1'],
      ],
    }),
    ...layer('N3A_B0010000', {
      type: 5,
      shapes: [
        { parts: [closed(cw(rect(X + 2, Y + 2, 16, 26)))] },
        { parts: [closed(cw(rect(X + 23, Y + 5, 9, 12)))] },
        { parts: [closed(cw(rect(X - 10, Y + 10, 5, 5)))] },
      ],
      fields: [
        ['KIND', 'C', 6],
        ['NMLY', 'N', 3],
        ['NAME', 'C', 40],
      ],
      rows: [
        ['BDK004', 4, '합성 업무동'],
        ['BDK001', 2, ''],
        ['BDK005', 1, '합성 캐노피'],
      ],
    }),
    ...layer('N3L_F0010000', {
      type: 13,
      shapes: [
        {
          parts: [
            [
              [X - 60, Y - 40, 30],
              [X + 90, Y - 40, 30],
            ],
          ],
        },
        {
          parts: [
            [
              [X - 60, Y + 20, 33],
              [X + 90, Y + 20, 33],
            ],
          ],
        },
        {
          parts: [
            [
              [X - 60, Y + 80, 36],
              [X + 90, Y + 80, 36],
            ],
          ],
        },
      ],
      fields: [['CONT', 'N', 8, 2]],
      rows: [[30], [33], [36]],
    }),
    ...layer('N3P_F0020000', {
      type: 11,
      shapes: [{ points: [[X + 10, Y + 15, 32.5]] }],
      fields: [['NUME', 'N', 8, 2]],
      rows: [[32.5]],
    }),
  ];
}
