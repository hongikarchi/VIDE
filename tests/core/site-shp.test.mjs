import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  CrsError,
  KNOWN_CRS,
  codeName,
  crsByEpsg,
  describeLayer,
  dictionarySize,
  importShapefiles,
  importUnpacked,
  packOffsets,
  parsePrj,
  readShp,
  resolveEncoding,
  tmConvergence,
  tmForward,
  tmInverse,
  transformer,
} from '../../src/jigs/official/site-data/shp/index.ts';

// PLAN-45 T-206. Every shapefile here is synthetic and written by the helpers below: made-up
// coordinates, PNU and 지번 (no project site, no downloaded data).

const close = (actual, expected, eps, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} ≠ ${expected} (±${eps})`);
const dms = (d, m, s) => d + m / 60 + s / 3600;

// --- .prj texts ---------------------------------------------------------------------------------
const GRS =
  'GEOGCS["GCS_Korea_2000",DATUM["D_Korea_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
const esriTm = (name, cm, k0, fe, fn, geog = GRS) =>
  `PROJCS["${name}",${geog},PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",${fe}],PARAMETER["False_Northing",${fn}],PARAMETER["Central_Meridian",${cm}],PARAMETER["Scale_Factor",${k0}],PARAMETER["Latitude_Of_Origin",38.0],UNIT["Meter",1.0]]`;
const PRJ_5179 = esriTm(
  'Korea_2000_Korea_Unified_Coordinate_System',
  127.5,
  0.9996,
  1000000,
  2000000,
);
const PRJ_5186 = esriTm('Korea_2000_Korea_Central_Belt_2010', 127.0, 1.0, 200000, 600000);
const PRJ_5174 = esriTm(
  'Korean_1985_Modified_Korea_Central_Belt',
  127.0028902777778,
  1.0,
  200000,
  500000,
  'GEOGCS["GCS_Korean_Datum_1985",DATUM["D_Korean_Datum_1985",SPHEROID["Bessel_1841",6377397.155,299.1528128]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
);

// --- Independent TM (Snyder series, as in S-04 geo.js) to build the second-CRS fixture -----------
const A = 6378137,
  F = 1 / 298.257222101,
  E2 = F * (2 - F),
  EP2 = E2 / (1 - E2),
  D = Math.PI / 180;
const arc = (phi) =>
  A *
  ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi -
    ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) +
    ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) -
    ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi));
function snyderForward(lat, lon, p) {
  const phi = lat * D;
  const N = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2,
    C = EP2 * Math.cos(phi) ** 2,
    Ax = (lon - p.lon0) * D * Math.cos(phi);
  return [
    p.fe +
      p.k0 *
        N *
        (Ax +
          ((1 - T + C) * Ax ** 3) / 6 +
          ((5 - 18 * T + T ** 2 + 72 * C - 58 * EP2) * Ax ** 5) / 120),
    p.fn +
      p.k0 *
        (arc(phi) -
          arc(p.lat0 * D) +
          N *
            Math.tan(phi) *
            (Ax ** 2 / 2 +
              ((5 - T + 9 * C + 4 * C ** 2) * Ax ** 4) / 24 +
              ((61 - 58 * T + T ** 2 + 600 * C - 330 * EP2) * Ax ** 6) / 720)),
  ];
}
function snyderInverse(E, N, p) {
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const M = arc(p.lat0 * D) + (N - p.fn) / p.k0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const C1 = EP2 * Math.cos(phi1) ** 2,
    T1 = Math.tan(phi1) ** 2;
  const N1 = A / Math.sqrt(1 - E2 * Math.sin(phi1) ** 2);
  const R1 = (A * (1 - E2)) / (1 - E2 * Math.sin(phi1) ** 2) ** 1.5;
  const Dx = (E - p.fe) / (N1 * p.k0);
  const phi =
    phi1 -
    ((N1 * Math.tan(phi1)) / R1) *
      (Dx ** 2 / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * EP2) * Dx ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * EP2 - 3 * C1 ** 2) * Dx ** 6) / 720);
  const lam =
    p.lon0 * D +
    (Dx -
      ((1 + 2 * T1 + C1) * Dx ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * EP2 + 24 * T1 ** 2) * Dx ** 5) / 120) /
      Math.cos(phi1);
  return [phi / D, lam / D];
}
const TM5186 = KNOWN_CRS['5186'].tm,
  TM5179 = KNOWN_CRS['5179'].tm;
const to5179 = ([e, n, z = 0]) => [...snyderForward(...snyderInverse(e, n, TM5186), TM5179), z];

// --- Writers ------------------------------------------------------------------------------------
const utf8 = (s) => new TextEncoder().encode(s);
// EUC-KR encoder built from the platform decoder (KS X 1001 Hangul block), so no extra package.
const EUC = new Map();
{
  const dec = new TextDecoder('euc-kr');
  for (let lead = 0xb0; lead <= 0xc8; lead++)
    for (let trail = 0xa1; trail <= 0xfe; trail++)
      EUC.set(dec.decode(new Uint8Array([lead, trail])), [lead, trail]);
}
const eucKr = (s) =>
  new Uint8Array(
    [...s].flatMap((ch) => {
      if (ch.charCodeAt(0) < 0x80) return [ch.charCodeAt(0)];
      const b = EUC.get(ch);
      assert.ok(b, `no EUC-KR bytes for ${ch}`);
      return b;
    }),
  );

function writeShp(type, shapes) {
  const z = type === 11 || type === 13 || type === 15;
  const recs = shapes.map((shape) => {
    if (!shape) {
      const b = new DataView(new ArrayBuffer(4));
      b.setInt32(0, 0, true);
      return new Uint8Array(b.buffer);
    }
    if (type === 1 || type === 11) {
      const [x, y, zz = 0] = shape.points[0];
      const b = new DataView(new ArrayBuffer(z ? 36 : 20));
      b.setInt32(0, type, true);
      b.setFloat64(4, x, true);
      b.setFloat64(12, y, true);
      if (z) {
        b.setFloat64(20, zz, true);
        b.setFloat64(28, 0, true);
      }
      return new Uint8Array(b.buffer);
    }
    const pts = shape.parts.flat();
    const n = pts.length,
      np = shape.parts.length;
    const size = 44 + 4 * np + 16 * n + (z ? 32 + 16 * n : 0);
    const b = new DataView(new ArrayBuffer(size));
    b.setInt32(0, type, true);
    const xs = pts.map((p) => p[0]),
      ys = pts.map((p) => p[1]);
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
      // M range + values stay 0.
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
  const all = shapes.filter(Boolean).flatMap((s) => (s.points ? s.points : s.parts.flat()));
  if (all.length)
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

/** fields: [name, 'C'|'N', length, decimals]; rows: arrays (null row = deleted). */
function writeDbf(fields, rows, encode = utf8, ldid = 0) {
  const hlen = 32 + 32 * fields.length + 1;
  const rlen = 1 + fields.reduce((s, f) => s + f[2], 0);
  const out = new Uint8Array(hlen + rows.length * rlen + 1);
  const dv = new DataView(out.buffer);
  out[0] = 0x03;
  dv.setUint32(4, rows.length, true);
  dv.setUint16(8, hlen, true);
  dv.setUint16(10, rlen, true);
  out[29] = ldid;
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
    if (row === null) {
      out[base] = 0x2a;
      return;
    }
    let o = base + 1;
    fields.forEach(([, type, len], i) => {
      const v = row[i];
      const bytes =
        type === 'N' ? utf8(v === null ? '' : String(v).padStart(len)) : encode(v ?? '');
      out.set(bytes.subarray(0, len), o);
      o += len;
    });
  });
  out[out.length - 1] = 0x1a;
  return out;
}

function layer(base, { type, shapes, fields, rows, prj, cpg, encode, ldid }) {
  const files = [
    { name: `${base}.shp`, bytes: writeShp(type, shapes) },
    { name: `${base}.dbf`, bytes: writeDbf(fields, rows, encode, ldid) },
  ];
  if (prj !== undefined) files.push({ name: `${base}.prj`, bytes: utf8(prj) });
  if (cpg !== undefined) files.push({ name: `${base}.cpg`, bytes: utf8(cpg) });
  return files;
}

function writeZip(entries) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const nameBytes = utf8(name);
    const data = deflateRawSync(bytes);
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x800, true);
    local.setUint16(8, 8, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x800, true);
    central.setUint16(10, 8, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, bytes.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    locals.push(new Uint8Array(local.buffer), nameBytes, data);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return Buffer.concat([...locals, ...centrals, new Uint8Array(end.buffer)]);
}

// --- Synthetic site -----------------------------------------------------------------------------
// A 20 m × 30 m parcel in EPSG:5186 (연속지적도 style, EUC-KR), a building inset 2 m with a 2 m
// courtyard in EPSG:5179 (수치지형도 style, UTF-8), contours and spot heights in EPSG:5179.
const P0 = [202650.37, 544320.83];
const rect = ([x, y], w, h, z = 0) => [
  [x, y, z],
  [x + w, y, z],
  [x + w, y + h, z],
  [x, y + h, z],
];
const cw = (ring) => [...ring].reverse(); // shapefile outer rings are clockwise
const closeRing = (ring) => [...ring, ring[0]];
const parcelRing = rect(P0, 20, 30);
const buildingRing = rect([P0[0] + 2, P0[1] + 2], 16, 26);
const courtyard = rect([P0[0] + 7, P0[1] + 12], 2, 2);

function siteFiles() {
  return [
    ...layer('LSMD_CONT_LDREG_11680', {
      type: 5,
      shapes: [{ parts: [closeRing(cw(parcelRing))] }],
      fields: [
        ['PNU', 'C', 19],
        ['JIBUN', 'C', 30],
        ['BCHK', 'C', 1],
      ],
      rows: [['1168010100101230004', '123-4 대', '1']],
      prj: PRJ_5186,
      cpg: 'EUC-KR',
      encode: eucKr,
    }),
    ...layer('N3A_B0010000', {
      type: 5,
      shapes: [
        // outer CW + hole CCW (spec order), in EPSG:5179 through the independent Snyder series
        { parts: [closeRing(cw(buildingRing)).map(to5179), closeRing(courtyard).map(to5179)] },
        // a non-compliant counter-clockwise outer ring (must still extrude upward)
        { parts: [closeRing(rect([P0[0] + 40, P0[1]], 10, 10)).map(to5179)] },
        // a wall-less canopy
        { parts: [closeRing(cw(rect([P0[0] - 20, P0[1]], 6, 6))).map(to5179)] },
        null,
      ],
      fields: [
        ['KIND', 'C', 6],
        ['NMLY', 'N', 3],
        ['NAME', 'C', 40],
      ],
      rows: [
        ['BDK004', 5, '가나빌딩'],
        ['BDK001', 2, ''],
        ['BDK005', 1, '주차 캐노피'],
        ['BDK000', 1, ''],
      ],
      prj: PRJ_5179,
      cpg: 'UTF-8',
    }),
    ...layer('N3L_F0010000', {
      type: 13,
      shapes: [
        { parts: [[to5179([P0[0] - 50, P0[1] - 10, 35]), to5179([P0[0] + 70, P0[1] - 10, 35])]] },
        { parts: [[to5179([P0[0] - 50, P0[1] + 50, 40]), to5179([P0[0] + 70, P0[1] + 50, 40])]] },
      ],
      fields: [['CONT', 'N', 8, 2]],
      rows: [[35], [40]],
      prj: PRJ_5179,
      cpg: 'UTF-8',
    }),
    ...layer('N3P_F0020000', {
      type: 11,
      shapes: [{ points: [to5179([P0[0] + 10, P0[1] + 15, 37.25])] }],
      fields: [['NUME', 'N', 8, 2]],
      rows: [[37.25]],
      prj: PRJ_5179,
      // no .cpg: the DBF has only numbers, so strict UTF-8 reads it (with a warning)
    }),
    ...layer('N3A_A0010000', {
      type: 5,
      shapes: [{ parts: [closeRing(cw(rect([P0[0] - 30, P0[1] - 8], 120, 6))).map(to5179)] }],
      fields: [['SCLS', 'C', 8]],
      rows: [['A0013111']],
      prj: PRJ_5179,
      cpg: 'UTF-8',
    }),
    ...layer('N3L_A0020000', {
      type: 3,
      shapes: [{ parts: [[to5179([P0[0] - 30, P0[1] - 5]), to5179([P0[0] + 90, P0[1] - 5])]] }],
      fields: [['SCLS', 'C', 8]],
      rows: [['A0023111']],
      prj: PRJ_5179,
      cpg: 'UTF-8',
    }),
  ];
}

// --- Tests --------------------------------------------------------------------------------------

test('TM matches published reference points (OS GB guide Annex C, EPSG GN7-2)', () => {
  const airy = { name: 'Airy 1830', a: 6377563.396, invF: 299.3249646 };
  const osgb = { lat0: 49, lon0: -2, k0: 0.9996012717, fe: 400000, fn: -100000 };
  // OS "A guide to coordinate systems in Great Britain", Annex C worked example.
  const [e, n] = tmForward(dms(52, 39, 27.2531), dms(1, 43, 4.5177), osgb, airy);
  close(e, 651409.903, 0.001, 'OS E');
  close(n, 313177.27, 0.001, 'OS N');
  const [lat, lon] = tmInverse(651409.903, 313177.27, osgb, airy);
  close(lat, dms(52, 39, 27.2531), 1e-8, 'OS lat');
  close(lon, dms(1, 43, 4.5177), 1e-8, 'OS lon');
  // EPSG Guidance Note 7-2, Transverse Mercator example (values given to the centimetre).
  const [e2, n2] = tmForward(50.5, 0.5, osgb, airy);
  close(e2, 577274.99, 0.011, 'EPSG E');
  close(n2, 69740.5, 0.011, 'EPSG N');
  // The Korea 2000 false origins are exact by definition.
  assert.deepEqual(tmForward(38, 127, TM5186), [200000, 600000]);
  assert.deepEqual(tmForward(38, 127.5, TM5179), [1000000, 2000000]);
});

test('TM round trip stays sub-millimetre across Korea and agrees with the Snyder series', () => {
  for (const [lat, lon] of [
    [33.2, 124.6],
    [35.1, 129.1],
    [37.5, 127.03],
    [38.5, 131.9],
  ]) {
    for (const tm of [TM5179, TM5186]) {
      const [e, n] = tmForward(lat, lon, tm);
      const [la, lo] = tmInverse(e, n, tm);
      close(la, lat, 1e-9, 'lat');
      close(lo, lon, 1e-9, 'lon');
    }
    // Near the central meridian the older series is accurate; they must agree there.
    if (Math.abs(lon - 127.5) < 1) {
      const [e, n] = tmForward(lat, lon, TM5179);
      const [se, sn] = snyderForward(lat, lon, TM5179);
      close(e, se, 0.001, 'Snyder E');
      close(n, sn, 0.001, 'Snyder N');
    }
  }
});

test('grid convergence is the grid azimuth of true north, ~0.30° between UTM-K and 중부원점', () => {
  const lat = 37.51,
    lon = 127.03;
  for (const tm of [TM5179, TM5186]) {
    const [e0, n0] = tmForward(lat, lon, tm);
    const [e1, n1] = tmForward(lat + 1e-5, lon, tm);
    const gridAzimuthOfTrueNorth = (Math.atan2(e1 - e0, n1 - n0) * 180) / Math.PI;
    close(tmConvergence(lat, lon, tm), -gridAzimuthOfTrueNorth, 1e-6, 'γ');
  }
  close(tmConvergence(lat, lon, TM5186) - tmConvergence(lat, lon, TM5179), 0.3, 0.02, 'Δγ');
  assert.ok(tmConvergence(lat, 127.6, TM5186) > 0, 'east of the central meridian γ > 0');
});

test('.prj is identified by parameters, not by its name', () => {
  // Named like 중부원점 but carrying UTM-K parameters → UTM-K.
  assert.equal(
    parsePrj(esriTm('Korea_2000_Korea_Central_Belt_2010', 127.5, 0.9996, 1000000, 2000000)).epsg,
    '5179',
  );
  assert.equal(parsePrj(PRJ_5186).epsg, '5186');
  // OGC WKT1 (lower-case parameter names, AUTHORITY nodes) and WKT2.
  const ogc =
    'PROJCS["whatever",GEOGCS["x",DATUM["y",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",38],PARAMETER["central_meridian",129],PARAMETER["scale_factor",1],PARAMETER["false_easting",200000],PARAMETER["false_northing",600000],UNIT["metre",1],AUTHORITY["EPSG","9999"]]';
  assert.equal(parsePrj(ogc).epsg, '5187');
  const wkt2 =
    'PROJCRS["n",BASEGEOGCRS["Korea 2000",DATUM["Geocentric datum of Korea",ELLIPSOID["GRS 1980",6378137,298.257222101,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0]],CONVERSION["c",METHOD["Transverse Mercator"],PARAMETER["Latitude of natural origin",38],PARAMETER["Longitude of natural origin",125],PARAMETER["Scale factor at natural origin",1],PARAMETER["False easting",200000],PARAMETER["False northing",600000]],CS[Cartesian,2],AXIS["northing (X)",north,LENGTHUNIT["metre",1]],AXIS["easting (Y)",east,LENGTHUNIT["metre",1]]]';
  assert.equal(parsePrj(wkt2).epsg, '5185');
  // Unknown but complete GRS80 TM → usable, no EPSG.
  const custom = parsePrj(esriTm('my_grid', 127.25, 1, 100000, 100000));
  assert.equal(custom.epsg, null);
  assert.equal(custom.tm.lon0, 127.25);
  assert.equal(parsePrj(GRS).kind, 'geographic');
});

test('Bessel and other unusable systems are rejected with a reason', () => {
  const reject = (prj, code) =>
    assert.throws(
      () => parsePrj(prj),
      (e) => e instanceof CrsError && e.code === code,
    );
  reject(PRJ_5174, 'CRS_BESSEL');
  // A Bessel ellipsoid hiding behind a GRS-like name is still Bessel (by its semi-major axis).
  reject(PRJ_5186.replace('6378137.0,298.257222101', '6377397.155,299.1528128'), 'CRS_BESSEL');
  reject(
    PRJ_5186.replace('GRS_1980",6378137.0,298.257222101', 'Airy_1830",6377563.396,299.3249646'),
    'CRS_UNSUPPORTED_DATUM',
  );
  reject(
    PRJ_5186.replace('Transverse_Mercator', 'Lambert_Conformal_Conic'),
    'CRS_UNSUPPORTED_PROJECTION',
  );
  reject(
    PRJ_5186.replace('UNIT["Meter",1.0]]', 'UNIT["Foot_US",0.3048006096012192]]'),
    'CRS_UNSUPPORTED_UNIT',
  );
  reject('', 'CRS_MISSING');
  reject('PROJCS["broken"', 'CRS_UNREADABLE');
});

test('encoding follows the .cpg (or the DBF Korean driver byte) and never guesses', () => {
  assert.deepEqual(resolveEncoding('UTF-8'), { label: 'utf-8', source: 'cpg', declared: 'UTF-8' });
  assert.equal(resolveEncoding('cp949').label, 'euc-kr');
  assert.equal(resolveEncoding(' EUC-KR\r\n').label, 'euc-kr');
  assert.equal(resolveEncoding('', new Uint8Array(32).fill(0x79, 29, 30)).source, 'dbf');
  assert.equal(resolveEncoding(null).source, 'none');
  assert.throws(() => resolveEncoding('Shift_JIS'), { code: 'ENCODING_UNSUPPORTED' });
});

test('a synthetic site imports into one local frame (5186 + 5179 within 1 cm)', () => {
  const result = importUnpacked(siteFiles());
  assert.deepEqual(result.rejected, []);
  const { frame } = result;
  assert.equal(frame.crs.epsg, '5186', 'the 연속지적도 CRS is the default frame');
  assert.ok(Number.isInteger(frame.origin[0]) && Number.isInteger(frame.origin[1]));
  assert.deepEqual(
    result.ignored.map((i) => i.name),
    ['도로중심선'],
  );
  const byRole = Object.fromEntries(result.layers.map((l) => [l.role, l]));
  assert.deepEqual(Object.keys(byRole).sort(), [
    'building',
    'contour',
    'parcel',
    'road-boundary',
    'spot-height',
  ]);
  const local = ([x, y]) => [x - frame.origin[0], y - frame.origin[1]];

  // Parcel: EUC-KR attributes, CW outer ring turned CCW, coordinates untouched (same CRS).
  const parcel = byRole.parcel;
  assert.equal(parcel.reprojected, false);
  assert.equal(parcel.encoding.label, 'euc-kr');
  const [pf] = parcel.features;
  assert.deepEqual(pf.parcel, {
    pnu: '1168010100101230004',
    jibun: '123-4 대',
    ledger: '토지대장',
  });
  const outer = pf.geometry.polygons[0].outer;
  assert.equal(outer.length, 4, 'closing point dropped');
  assert.ok(signedArea2(outer) > 0, 'outer ring counter-clockwise');
  outer.forEach((p, i) => {
    const [ex, ey] = local(parcelRing[i]);
    close(p[0], ex, 1e-9, 'parcel x');
    close(p[1], ey, 1e-9, 'parcel y');
  });

  // Building: moved from 5179 (written by the Snyder series) back onto the 5186 corners < 1 cm.
  const building = byRole.building;
  assert.equal(building.reprojected, true);
  close(building.rotationDeg, -0.3, 0.02, 'grid rotation between 5179 and 5186');
  const [b0, b1, b2] = building.features;
  const poly = b0.geometry.polygons[0];
  assert.ok(signedArea2(poly.outer) > 0, 'outer CCW');
  assert.equal(poly.holes.length, 1, 'courtyard kept as a hole');
  assert.ok(signedArea2(poly.holes[0]) < 0, 'hole CW');
  let worst = 0;
  for (const p of poly.outer) {
    const target = buildingRing
      .map(local)
      .reduce((best, q) =>
        Math.hypot(q[0] - p[0], q[1] - p[1]) < Math.hypot(best[0] - p[0], best[1] - p[1])
          ? q
          : best,
      );
    worst = Math.max(worst, Math.hypot(target[0] - p[0], target[1] - p[1]));
  }
  assert.ok(worst < 0.01, `misalignment ${worst} m`);
  assert.deepEqual(
    {
      floors: b0.building.floors,
      kindName: b0.building.kindName,
      name: b0.building.name,
      wallless: b0.building.wallless,
    },
    { floors: 5, kindName: '주택외건물', name: '가나빌딩', wallless: false },
  );
  assert.ok(signedArea2(b1.geometry.polygons[0].outer) > 0, 'a CCW source ring stays CCW');
  assert.equal(b2.building.wallless, true);
  assert.equal(b2.decoded.KIND, '무벽건물');
  assert.equal(building.counts.nullShapes, 1);
  assert.equal(building.counts.features, 3);
  assert.ok(building.warnings.some((w) => w.includes('무벽건물 1동')));

  // Terrain: contour elevation from CONT, spot height from NUME (no .cpg → strict UTF-8 warning).
  assert.deepEqual(
    byRole.contour.features.map((f) => f.elevation),
    [35, 40],
  );
  assert.equal(byRole.contour.features[0].geometry.lines[0][0][2], 35);
  assert.equal(byRole['spot-height'].features[0].elevation, 37.25);
  assert.equal(byRole['spot-height'].encoding.source, 'none');
  assert.ok(byRole['spot-height'].warnings.some((w) => w.includes('.cpg')));
  assert.match(byRole['road-boundary'].features[0].decoded.SCLS, /고속국도/);

  // True north: grid north rotated by the convergence; differs from grid north by ~0.0x°.
  close(Math.hypot(...frame.trueNorth), 1, 1e-12);
  close(
    (Math.atan2(-frame.trueNorth[0], frame.trueNorth[1]) * 180) / Math.PI,
    frame.convergenceDeg,
    1e-12,
  );
  close(frame.originLatLon[0], 37.5, 0.5, 'origin latitude');
});

const signedArea2 = (ring) => {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
};

test('a chosen target CRS and origin are honoured; the origin does not depend on layer order', () => {
  const files = siteFiles();
  const a = importUnpacked(files, { target: 'EPSG:5179', origin: [1000123, 1950456] });
  assert.equal(a.frame.crs.epsg, '5179');
  assert.deepEqual(a.frame.origin, [1000123, 1950456, 0]);
  assert.equal(a.layers.find((l) => l.role === 'building').reprojected, false);
  assert.equal(a.layers.find((l) => l.role === 'parcel').reprojected, true);
  const b = importUnpacked([...files].reverse());
  const c = importUnpacked(files);
  assert.deepEqual(b.frame.origin, c.frame.origin);
  const geo = importUnpacked(files, { target: '4326' });
  assert.equal(geo.frame, null);
  assert.equal(geo.rejected.at(-1).code, 'CRS_NOT_PROJECTED');
  assert.equal(crsByEpsg('5188').tm.lon0, 131);
  assert.equal(transformer(KNOWN_CRS['5186'], KNOWN_CRS['5186']), null);
});

test('missing pair files, Bessel files, bad encodings and count mismatches are rejected; others continue', () => {
  const files = siteFiles();
  const without = (name) => files.filter((f) => f.name !== name);
  let r = importUnpacked(without('N3A_B0010000.prj'));
  assert.deepEqual(
    r.rejected.map((x) => [x.file, x.code, x.missing]),
    [['N3A_B0010000', 'MISSING_PAIR', ['.prj']]],
  );
  assert.ok(!r.layers.some((l) => l.role === 'building'));
  assert.ok(
    r.layers.some((l) => l.role === 'parcel'),
    'the rest still imports',
  );
  r = importUnpacked(without('N3L_F0010000.dbf'));
  assert.deepEqual(r.rejected[0].missing, ['.dbf']);
  r = importUnpacked([{ name: 'orphan.dbf', bytes: writeDbf([['A', 'C', 1]], [['x']]) }]);
  assert.deepEqual(r.rejected[0].missing, ['.shp', '.prj']);
  assert.equal(r.frame, null);

  const bessel = layer('GIS_BLDG_5174', {
    type: 5,
    shapes: [{ parts: [closeRing(cw(rect([200000, 450000], 10, 10)))] }],
    fields: [['A', 'C', 1]],
    rows: [['x']],
    prj: PRJ_5174,
    cpg: 'UTF-8',
  });
  r = importUnpacked([...files, ...bessel]);
  const rej = r.rejected.find((x) => x.file === 'GIS_BLDG_5174');
  assert.equal(rej.code, 'CRS_BESSEL');
  assert.match(rej.reason, /Bessel/);
  assert.equal(r.layers.length, 5);

  // EUC-KR text without any declaration is not guessed.
  const undeclared = layer('LSMD_CONT_LDREG_99999', {
    type: 5,
    shapes: [{ parts: [closeRing(cw(parcelRing))] }],
    fields: [
      ['PNU', 'C', 19],
      ['JIBUN', 'C', 30],
    ],
    rows: [['1168010100101230005', '123-5 대']],
    prj: PRJ_5186,
    encode: eucKr,
  });
  r = importUnpacked(undeclared);
  assert.equal(r.rejected[0].code, 'ENCODING_UNDECLARED');
  // …but the DBF's Korean language driver byte is a declaration.
  r = importUnpacked(
    layer('LSMD_CONT_LDREG_99999', {
      type: 5,
      shapes: [{ parts: [closeRing(cw(parcelRing))] }],
      fields: [
        ['PNU', 'C', 19],
        ['JIBUN', 'C', 30],
      ],
      rows: [['1168010100101230005', '123-5 대']],
      prj: PRJ_5186,
      encode: eucKr,
      ldid: 0x79,
    }),
  );
  assert.equal(r.layers[0].features[0].parcel.jibun, '123-5 대');

  const mismatch = layer('N3A_B0010000', {
    type: 5,
    shapes: [{ parts: [closeRing(cw(buildingRing))] }],
    fields: [['KIND', 'C', 6]],
    rows: [['BDK001'], ['BDK001']],
    prj: PRJ_5186,
    cpg: 'UTF-8',
  });
  r = importUnpacked(mismatch);
  assert.equal(r.rejected[0].code, 'SHP_DBF_MISMATCH');
  assert.throws(() => readShp(new Uint8Array(120)), { code: 'SHP_INVALID' });
});

test('a ZIP of the same files imports the same; deleted records are skipped', async () => {
  const files = siteFiles();
  const zip = writeZip(files);
  const fromZip = await importShapefiles([{ name: 'NGII_synthetic.zip', bytes: zip }]);
  const direct = importUnpacked(files);
  assert.deepEqual(fromZip.rejected, []);
  assert.deepEqual(fromZip.frame, direct.frame);
  assert.deepEqual(
    fromZip.layers.map((l) => [l.role, l.counts.features]),
    direct.layers.map((l) => [l.role, l.counts.features]),
  );
  const broken = await importShapefiles([{ name: 'bad.zip', bytes: zip.subarray(0, 40) }]);
  assert.equal(broken.rejected[0].code, 'ZIP_INVALID');

  const withDeleted = layer('N3A_B0010000', {
    type: 5,
    shapes: [{ parts: [closeRing(cw(buildingRing))] }, { parts: [closeRing(cw(courtyard))] }],
    fields: [['KIND', 'C', 6]],
    rows: [null, ['BDK001']],
    prj: PRJ_5186,
    cpg: 'UTF-8',
  });
  const r = importUnpacked(withDeleted);
  assert.equal(r.layers[0].counts.deleted, 1);
  assert.deepEqual(
    r.layers[0].features.map((f) => f.index),
    [1],
  );
});

test('f32 offsets from the f64 origin keep sub-millimetre precision; absolute f32 does not', () => {
  const { frame, layers } = importUnpacked(siteFiles());
  const points = layers.flatMap((l) =>
    l.features.flatMap((f) =>
      f.geometry.kind === 'polygon'
        ? f.geometry.polygons.flatMap((p) => p.outer)
        : f.geometry.kind === 'polyline'
          ? f.geometry.lines.flat()
          : f.geometry.points,
    ),
  );
  const packed = packOffsets(points);
  let local = 0,
    absolute = 0;
  points.forEach((p, i) => {
    local = Math.max(local, Math.abs(packed[i * 3] - p[0]), Math.abs(packed[i * 3 + 1] - p[1]));
    const x = p[0] + frame.origin[0],
      y = p[1] + frame.origin[1];
    absolute = Math.max(absolute, Math.abs(Math.fround(x) - x), Math.abs(Math.fround(y) - y));
  });
  assert.ok(local < 1e-4, `local f32 error ${local}`);
  assert.ok(absolute > 1e-3, `absolute f32 error ${absolute}`);
});

test('the NGII dictionary names layers and codes', () => {
  assert.deepEqual(dictionarySize(), { layers: 107, fields: 66, codes: 503, scls: 423 });
  const b = describeLayer('N3A_B0010000');
  assert.deepEqual(
    [b.product, b.category, b.name, b.geometry, b.scale, b.role],
    ['ngii-topo', '건물', '건물', '면', '1:5,000', 'building'],
  );
  assert.equal(describeLayer('N1L_F0010000').role, 'contour');
  assert.equal(describeLayer('N3P_F0020000').role, 'spot-height');
  assert.equal(describeLayer('N3A_A0010000').role, 'road-boundary');
  assert.equal(describeLayer('N3L_A0020000').role, 'unused');
  assert.equal(describeLayer('N3A_Z9999999').role, 'unused');
  assert.equal(describeLayer('folder/LSMD_CONT_LDREG_11680', ['PNU', 'JIBUN']).role, 'parcel');
  assert.equal(codeName('KIND', 'BDK005'), '무벽건물');
  assert.equal(codeName('BCHK', '2'), '임야대장');
  assert.equal(codeName('NMLY', 3), null);
});
