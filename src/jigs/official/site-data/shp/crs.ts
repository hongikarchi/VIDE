// Coordinate systems for imported site data (SPEC-12.4, PLAN-45 T-206). Rewritten from S-02 Site
// Maker (`parse_prj`, TM 정·역변환) and S-04 검토엔진 (`geo.js` crsFromPrj·gridConvergence), with
// the Krüger series (Karney 2011, 6th order in n) in place of their Snyder series so a point 4–5°
// off the central meridian (UTM-K covers 124–132°E) stays well under a millimetre.
//
// Rules carried over from both sources: a `.prj` is identified by its parameters (central meridian,
// scale, false easting/northing, origin latitude, ellipsoid), never by its name; Korea 2000 (GRS80)
// and WGS84 differ by less than the survey tolerance and need no datum shift; Bessel-based systems
// (EPSG:5174 등 구 좌표계) need a 100–200 m datum shift, so files in them are rejected, not moved.
// Pure TypeScript without node: imports.

export interface Ellipsoid {
  name: string;
  a: number;
  invF: number;
}
export const GRS80: Ellipsoid = { name: 'GRS 1980', a: 6378137, invF: 298.257222101 };
export const WGS84: Ellipsoid = { name: 'WGS 84', a: 6378137, invF: 298.257223563 };
const BESSEL_A = 6377397.155;

/** Transverse Mercator parameters: degrees and metres. */
export interface TmParams {
  lat0: number;
  lon0: number;
  k0: number;
  fe: number;
  fn: number;
}

export interface Crs {
  kind: 'projected' | 'geographic';
  /** EPSG code when the parameters match a known system, else null (still usable). */
  epsg: string | null;
  name: string;
  ellipsoid: Ellipsoid;
  tm?: TmParams;
}

export type CrsErrorCode =
  | 'CRS_MISSING'
  | 'CRS_UNREADABLE'
  | 'CRS_BESSEL'
  | 'CRS_UNSUPPORTED_DATUM'
  | 'CRS_UNSUPPORTED_PROJECTION'
  | 'CRS_UNSUPPORTED_UNIT'
  | 'CRS_NOT_PROJECTED';
export class CrsError extends Error {
  readonly code: CrsErrorCode;
  constructor(code: CrsErrorCode, message: string) {
    super(message);
    this.name = 'CrsError';
    this.code = code;
  }
}

const tm = (lon0: number, k0: number, fe: number, fn: number, lat0 = 38): TmParams => ({
  lat0,
  lon0,
  k0,
  fe,
  fn,
});
/** Known systems, matched by parameters only. The names are for display. */
export const KNOWN_CRS: Readonly<Record<string, Crs>> = Object.freeze({
  '5179': {
    kind: 'projected',
    epsg: '5179',
    name: 'Korea 2000 / UTM-K',
    ellipsoid: GRS80,
    tm: tm(127.5, 0.9996, 1000000, 2000000),
  },
  '5180': {
    kind: 'projected',
    epsg: '5180',
    name: 'Korea 2000 / 서부원점(FN 500000)',
    ellipsoid: GRS80,
    tm: tm(125, 1, 200000, 500000),
  },
  '5181': {
    kind: 'projected',
    epsg: '5181',
    name: 'Korea 2000 / 중부원점(FN 500000)',
    ellipsoid: GRS80,
    tm: tm(127, 1, 200000, 500000),
  },
  '5182': {
    kind: 'projected',
    epsg: '5182',
    name: 'Korea 2000 / 제주(FN 550000)',
    ellipsoid: GRS80,
    tm: tm(127, 1, 200000, 550000),
  },
  '5183': {
    kind: 'projected',
    epsg: '5183',
    name: 'Korea 2000 / 동부원점(FN 500000)',
    ellipsoid: GRS80,
    tm: tm(129, 1, 200000, 500000),
  },
  '5184': {
    kind: 'projected',
    epsg: '5184',
    name: 'Korea 2000 / 동해원점(FN 500000)',
    ellipsoid: GRS80,
    tm: tm(131, 1, 200000, 500000),
  },
  '5185': {
    kind: 'projected',
    epsg: '5185',
    name: 'Korea 2000 / 서부원점',
    ellipsoid: GRS80,
    tm: tm(125, 1, 200000, 600000),
  },
  '5186': {
    kind: 'projected',
    epsg: '5186',
    name: 'Korea 2000 / 중부원점',
    ellipsoid: GRS80,
    tm: tm(127, 1, 200000, 600000),
  },
  '5187': {
    kind: 'projected',
    epsg: '5187',
    name: 'Korea 2000 / 동부원점',
    ellipsoid: GRS80,
    tm: tm(129, 1, 200000, 600000),
  },
  '5188': {
    kind: 'projected',
    epsg: '5188',
    name: 'Korea 2000 / 동해원점',
    ellipsoid: GRS80,
    tm: tm(131, 1, 200000, 600000),
  },
  '32651': {
    kind: 'projected',
    epsg: '32651',
    name: 'WGS 84 / UTM 51N',
    ellipsoid: WGS84,
    tm: tm(123, 0.9996, 500000, 0, 0),
  },
  '32652': {
    kind: 'projected',
    epsg: '32652',
    name: 'WGS 84 / UTM 52N',
    ellipsoid: WGS84,
    tm: tm(129, 0.9996, 500000, 0, 0),
  },
  '4326': { kind: 'geographic', epsg: '4326', name: 'WGS 84 (경위도)', ellipsoid: WGS84 },
  '4737': { kind: 'geographic', epsg: '4737', name: 'Korea 2000 (경위도)', ellipsoid: GRS80 },
} satisfies Record<string, Crs>);

/** A known CRS by EPSG code ("5186", "EPSG:5186"), or a CrsError. */
export function crsByEpsg(code: string | number): Crs {
  const key = String(code)
    .trim()
    .replace(/^epsg[:\s]*/i, '');
  const crs = KNOWN_CRS[key];
  if (!crs)
    throw new CrsError(
      'CRS_UNSUPPORTED_PROJECTION',
      `EPSG:${key}는 지원하는 좌표계가 아닙니다(${Object.keys(KNOWN_CRS).join(', ')})`,
    );
  return crs;
}

export function crsLabel(crs: Crs): string {
  if (crs.epsg) return `EPSG:${crs.epsg} ${crs.name}`;
  const p = crs.tm;
  return p ? `TM CM ${p.lon0} k0 ${p.k0} FE ${p.fe} FN ${p.fn} 위도 ${p.lat0}` : crs.name;
}

// --- WKT ----------------------------------------------------------------------------------------

interface WktNode {
  key: string;
  args: (string | number | WktNode)[];
}

function parseWkt(text: string): WktNode {
  let i = 0;
  const s = text;
  const skip = () => {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
  };
  const node = (): WktNode => {
    skip();
    const start = i;
    while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) i++;
    const key = s.slice(start, i).toUpperCase();
    if (!key) throw new CrsError('CRS_UNREADABLE', `.prj를 읽을 수 없습니다(위치 ${i})`);
    skip();
    const open = s[i];
    if (open !== '[' && open !== '(') return { key, args: [] };
    const close = open === '[' ? ']' : ')';
    i++;
    const args: WktNode['args'] = [];
    for (;;) {
      skip();
      if (i >= s.length) throw new CrsError('CRS_UNREADABLE', '.prj의 괄호가 닫히지 않았습니다');
      const c = s[i];
      if (c === close || c === ']' || c === ')') {
        i++;
        return { key, args };
      }
      if (c === '"') {
        let j = i + 1;
        let out = '';
        for (;;) {
          if (j >= s.length)
            throw new CrsError('CRS_UNREADABLE', '.prj의 따옴표가 닫히지 않았습니다');
          if (s[j] === '"') {
            if (s[j + 1] === '"') {
              out += '"';
              j += 2;
              continue;
            }
            break;
          }
          out += s[j++];
        }
        args.push(out);
        i = j + 1;
      } else if (/[-+.\d]/.test(c)) {
        const m = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(s.slice(i));
        if (!m) throw new CrsError('CRS_UNREADABLE', `.prj의 숫자를 읽을 수 없습니다(위치 ${i})`);
        args.push(Number(m[0]));
        i += m[0].length;
      } else args.push(node());
    }
  };
  const root = node();
  return root;
}

const children = (n: WktNode) => n.args.filter((a): a is WktNode => typeof a === 'object');
const firstString = (n: WktNode) => n.args.find((a): a is string => typeof a === 'string') ?? '';
const numbers = (n: WktNode) => n.args.filter((a): a is number => typeof a === 'number');
function find(n: WktNode, keys: readonly string[]): WktNode | undefined {
  for (const c of children(n)) {
    if (keys.includes(c.key)) return c;
    const deep = find(c, keys);
    if (deep) return deep;
  }
  return undefined;
}

const PARAM_ALIASES: Record<string, keyof TmParams> = {
  latitudeoforigin: 'lat0',
  latitudeofnaturalorigin: 'lat0',
  latitudeofcenter: 'lat0',
  centralmeridian: 'lon0',
  longitudeofnaturalorigin: 'lon0',
  longitudeofcenter: 'lon0',
  scalefactor: 'k0',
  scalefactoratnaturalorigin: 'k0',
  falseeasting: 'fe',
  falsenorthing: 'fn',
};
const PROJECTED_KEYS = ['PROJCS', 'PROJCRS', 'PROJECTEDCRS'];
const GEOGRAPHIC_KEYS = ['GEOGCS', 'GEOGCRS', 'GEODCRS', 'GEOGRAPHICCRS', 'GEODETICCRS'];

/**
 * Identify a `.prj` (ESRI or OGC WKT1, WKT2) by its parameters. Throws CrsError when the system is
 * Bessel-based, uses another datum, projection or unit, or cannot be read.
 */
export function parsePrj(text: string): Crs {
  const trimmed = String(text ?? '')
    .replace(/^﻿/, '')
    .trim();
  if (!trimmed) throw new CrsError('CRS_MISSING', '.prj가 비어 있습니다');
  let root = parseWkt(trimmed);
  if (root.key === 'COMPD_CS' || root.key === 'COMPOUNDCRS') {
    const horizontal = children(root).find(
      (c) => PROJECTED_KEYS.includes(c.key) || GEOGRAPHIC_KEYS.includes(c.key),
    );
    if (!horizontal) throw new CrsError('CRS_UNREADABLE', '복합 좌표계에 수평 좌표계가 없습니다');
    root = horizontal;
  }
  const projected = PROJECTED_KEYS.includes(root.key);
  if (!projected && !GEOGRAPHIC_KEYS.includes(root.key))
    throw new CrsError('CRS_UNREADABLE', `좌표계 정의가 아닙니다(${root.key})`);

  const spheroid = find(root, ['SPHEROID', 'ELLIPSOID']);
  const datum = find(root, ['DATUM', 'GEODETICDATUM', 'TRF']);
  const datumName = datum ? firstString(datum) : '';
  const [a, invF] = spheroid ? numbers(spheroid) : [];
  const spheroidName = spheroid ? firstString(spheroid) : '';
  if (
    /bessel/i.test(spheroidName) ||
    (a !== undefined && Math.abs(a - BESSEL_A) < 1) ||
    /tokyo|korean[_\s]?datum[_\s]?1985|korean[_\s]?1985|kgd[_\s]?1985/i.test(datumName)
  )
    throw new CrsError(
      'CRS_BESSEL',
      `구 좌표계(Bessel 타원체 '${spheroidName || datumName}')입니다. 데이텀 변환(100~200 m)이 필요하므로 쓰지 않습니다. Korea 2000(GRS80) 좌표계 파일을 다시 받으세요`,
    );
  if (a === undefined || invF === undefined)
    throw new CrsError('CRS_UNREADABLE', '.prj에 타원체 값이 없습니다');
  let ellipsoid: Ellipsoid;
  if (Math.abs(a - GRS80.a) < 1e-3 && Math.abs(invF - GRS80.invF) < 1e-6) ellipsoid = GRS80;
  else if (Math.abs(a - WGS84.a) < 1e-3 && Math.abs(invF - WGS84.invF) < 1e-6) ellipsoid = WGS84;
  else
    throw new CrsError(
      'CRS_UNSUPPORTED_DATUM',
      `지원하지 않는 타원체입니다('${spheroidName}', a ${a}, 1/f ${invF}). GRS80·WGS84만 씁니다`,
    );
  const primem = find(root, ['PRIMEM', 'PRIMEMERIDIAN']);
  if (primem && Math.abs(numbers(primem)[0] ?? 0) > 1e-12)
    throw new CrsError('CRS_UNSUPPORTED_DATUM', '본초 자오선이 그리니치가 아닙니다');

  if (!projected) {
    const epsg = ellipsoid === WGS84 ? '4326' : '4737';
    return { ...KNOWN_CRS[epsg] };
  }

  const method = find(root, ['PROJECTION', 'METHOD']);
  const methodName = (method ? firstString(method) : '').toLowerCase().replace(/[^a-z]/g, '');
  if (methodName !== 'transversemercator' && methodName !== 'gausskruger')
    throw new CrsError(
      'CRS_UNSUPPORTED_PROJECTION',
      `지원하지 않는 투영입니다('${method ? firstString(method) : '없음'}'). 횡단 메르카토르(TM)만 씁니다`,
    );
  // WKT1 puts the linear unit directly under PROJCS; WKT2 under the CRS or each AXIS.
  const unitNode =
    children(root).find((c) => c.key === 'UNIT' || c.key === 'LENGTHUNIT') ??
    children(root)
      .filter((c) => c.key === 'AXIS')
      .flatMap((c) => children(c).filter((u) => u.key === 'LENGTHUNIT'))[0];
  const factor = unitNode ? numbers(unitNode)[0] : 1;
  if (factor !== undefined && Math.abs(factor - 1) > 1e-9)
    throw new CrsError('CRS_UNSUPPORTED_UNIT', `좌표 단위가 m가 아닙니다(배율 ${factor})`);

  const params: Partial<TmParams> = {};
  const visit = (n: WktNode) => {
    for (const c of children(n)) {
      if (c.key === 'PARAMETER') {
        const name = firstString(c)
          .toLowerCase()
          .replace(/[^a-z]/g, '');
        const key = PARAM_ALIASES[name];
        const value = numbers(c)[0];
        if (key && value !== undefined) params[key] = value;
      } else visit(c);
    }
  };
  visit(root);
  if (params.lon0 === undefined)
    throw new CrsError('CRS_UNREADABLE', '.prj에 중앙 자오선(Central_Meridian)이 없습니다');
  const tmParams: TmParams = {
    lat0: params.lat0 ?? 0,
    lon0: params.lon0,
    k0: params.k0 ?? 1,
    fe: params.fe ?? 0,
    fn: params.fn ?? 0,
  };
  return identify({
    kind: 'projected',
    epsg: null,
    name: '사용자 정의 TM',
    ellipsoid,
    tm: tmParams,
  });
}

function sameTm(a: TmParams, b: TmParams) {
  return (
    Math.abs(a.lat0 - b.lat0) < 1e-9 &&
    Math.abs(a.lon0 - b.lon0) < 1e-9 &&
    Math.abs(a.k0 - b.k0) < 1e-12 &&
    Math.abs(a.fe - b.fe) < 1e-6 &&
    Math.abs(a.fn - b.fn) < 1e-6
  );
}
function identify(crs: Crs): Crs {
  for (const known of Object.values(KNOWN_CRS))
    if (known.kind === 'projected' && known.tm && crs.tm && sameTm(known.tm, crs.tm))
      return { ...known, ellipsoid: crs.ellipsoid };
  return crs;
}

/** True when two systems give the same coordinates (GRS80 and WGS84 are treated as one). */
export function sameCrs(a: Crs, b: Crs): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'geographic') return true;
  return !!a.tm && !!b.tm && sameTm(a.tm, b.tm);
}

// --- Transverse Mercator (Krüger series, Karney 2011) ------------------------------------------

const RAD = Math.PI / 180;

interface TmSeries {
  A: number;
  e: number;
  alpha: number[];
  beta: number[];
}
const seriesCache = new Map<string, TmSeries>();
function series(ellipsoid: Ellipsoid): TmSeries {
  const key = `${ellipsoid.a}/${ellipsoid.invF}`;
  const cached = seriesCache.get(key);
  if (cached) return cached;
  const f = 1 / ellipsoid.invF;
  const n = f / (2 - f);
  const n2 = n * n,
    n3 = n2 * n,
    n4 = n3 * n,
    n5 = n4 * n,
    n6 = n5 * n;
  const out: TmSeries = {
    A: (ellipsoid.a / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256),
    e: Math.sqrt(f * (2 - f)),
    alpha: [
      0,
      n / 2 -
        (2 / 3) * n2 +
        (5 / 16) * n3 +
        (41 / 180) * n4 -
        (127 / 288) * n5 +
        (7891 / 37800) * n6,
      (13 / 48) * n2 -
        (3 / 5) * n3 +
        (557 / 1440) * n4 +
        (281 / 630) * n5 -
        (1983433 / 1935360) * n6,
      (61 / 240) * n3 - (103 / 140) * n4 + (15061 / 26880) * n5 + (167603 / 181440) * n6,
      (49561 / 161280) * n4 - (179 / 168) * n5 + (6601661 / 7257600) * n6,
      (34729 / 80640) * n5 - (3418889 / 1995840) * n6,
      (212378941 / 319334400) * n6,
    ],
    beta: [
      0,
      n / 2 -
        (2 / 3) * n2 +
        (37 / 96) * n3 -
        (1 / 360) * n4 -
        (81 / 512) * n5 +
        (96199 / 604800) * n6,
      (1 / 48) * n2 +
        (1 / 15) * n3 -
        (437 / 1440) * n4 +
        (46 / 105) * n5 -
        (1118711 / 3870720) * n6,
      (17 / 480) * n3 - (37 / 840) * n4 - (209 / 4480) * n5 + (5569 / 90720) * n6,
      (4397 / 161280) * n4 - (11 / 504) * n5 - (830251 / 7257600) * n6,
      (4583 / 161280) * n5 - (108847 / 3991680) * n6,
      (20648693 / 638668800) * n6,
    ],
  };
  seriesCache.set(key, out);
  return out;
}

/** Conformal latitude tangent τ' from the geodetic τ (Karney eq. 7–9). */
function tauPrime(tau: number, e: number) {
  const sigma = Math.sinh(e * Math.atanh((e * tau) / Math.hypot(1, tau)));
  return tau * Math.hypot(1, sigma) - sigma * Math.hypot(1, tau);
}

/** ξ', η' and ξ, η on the unit sphere-scaled plane (before k0·A and false origin). */
function forwardRaw(latDeg: number, dLonDeg: number, s: TmSeries) {
  const tau = Math.tan(latDeg * RAD);
  const lambda = dLonDeg * RAD;
  const tp = tauPrime(tau, s.e);
  const xiP = Math.atan2(tp, Math.cos(lambda));
  const etaP = Math.asinh(Math.sin(lambda) / Math.hypot(tp, Math.cos(lambda)));
  let xi = xiP,
    eta = etaP,
    p = 1,
    q = 0;
  for (let j = 1; j <= 6; j++) {
    const a = s.alpha[j];
    xi += a * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += a * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
    p += 2 * j * a * Math.cos(2 * j * xiP) * Math.cosh(2 * j * etaP);
    q += 2 * j * a * Math.sin(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }
  const gamma = Math.atan2(tp * Math.tan(lambda), Math.hypot(1, tp)) + Math.atan2(q, p);
  return { xi, eta, gamma };
}

/** Geographic (degrees) → projected [E, N] (m). */
export function tmForward(latDeg: number, lonDeg: number, params: TmParams, ellipsoid = GRS80) {
  const s = series(ellipsoid);
  const { xi, eta } = forwardRaw(latDeg, lonDeg - params.lon0, s);
  const xi0 = forwardRaw(params.lat0, 0, s).xi;
  return [params.fe + params.k0 * s.A * eta, params.fn + params.k0 * s.A * (xi - xi0)] as [
    number,
    number,
  ];
}

/** Projected [E, N] (m) → geographic [lat, lon] (degrees). */
export function tmInverse(easting: number, northing: number, params: TmParams, ellipsoid = GRS80) {
  const s = series(ellipsoid);
  const xi0 = forwardRaw(params.lat0, 0, s).xi;
  const xi = (northing - params.fn) / (params.k0 * s.A) + xi0;
  const eta = (easting - params.fe) / (params.k0 * s.A);
  let xiP = xi,
    etaP = eta;
  for (let j = 1; j <= 6; j++) {
    const b = s.beta[j];
    xiP -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const tp = Math.sin(xiP) / Math.hypot(Math.sinh(etaP), Math.cos(xiP));
  const lambda = Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  const e2 = s.e * s.e;
  let tau = tp;
  for (let k = 0; k < 10; k++) {
    const tpi = tauPrime(tau, s.e);
    const d =
      ((tp - tpi) / Math.hypot(1, tpi)) *
      ((1 + (1 - e2) * tau * tau) / ((1 - e2) * Math.hypot(1, tau)));
    tau += d;
    if (Math.abs(d) < 1e-14) break;
  }
  return [Math.atan(tau) / RAD, params.lon0 + lambda / RAD] as [number, number];
}

/**
 * Grid convergence (degrees) at a geographic point: the angle measured clockwise from true north
 * to grid north. Positive east of the central meridian. A true azimuth is grid azimuth + γ.
 */
export function tmConvergence(latDeg: number, lonDeg: number, params: TmParams, ellipsoid = GRS80) {
  return forwardRaw(latDeg, lonDeg - params.lon0, series(ellipsoid)).gamma / RAD;
}

// --- Between systems ----------------------------------------------------------------------------

export type XY = [number, number];

/** Geographic [lat, lon] of a coordinate given in `crs` (x = E or lon, y = N or lat). */
export function toGeographic(crs: Crs, x: number, y: number): XY {
  if (crs.kind === 'geographic') return [y, x];
  return tmInverse(x, y, crs.tm!, crs.ellipsoid);
}

/**
 * A function moving coordinates from one system to another, or null when they are the same
 * (no work and no rounding). Geographic coordinates are (lon, lat) in x, y.
 */
export function transformer(from: Crs, to: Crs): ((x: number, y: number) => XY) | null {
  if (sameCrs(from, to)) return null;
  if (to.kind === 'geographic')
    return (x, y) => {
      const [lat, lon] = toGeographic(from, x, y);
      return [lon, lat];
    };
  const target = to.tm!;
  return (x, y) => {
    const [lat, lon] = toGeographic(from, x, y);
    return tmForward(lat, lon, target, to.ellipsoid);
  };
}

/** Grid convergence (degrees, clockwise from true north to grid north) of `crs` at a point in it. */
export function convergenceAt(crs: Crs, x: number, y: number): number {
  if (crs.kind !== 'projected') return 0;
  const [lat, lon] = toGeographic(crs, x, y);
  return tmConvergence(lat, lon, crs.tm!, crs.ellipsoid);
}

/** The Korea 2000 plane belt (EPSG:5185~5188) whose central meridian is nearest to a longitude. */
export function beltFor(lonDeg: number): Crs {
  const code = lonDeg < 126 ? '5185' : lonDeg < 128 ? '5186' : lonDeg < 130 ? '5187' : '5188';
  return KNOWN_CRS[code];
}
