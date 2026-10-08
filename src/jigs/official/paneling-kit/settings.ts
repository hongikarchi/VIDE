// 추천값 표와 값의 출처 (SPEC-16.4 1·3·4): the value a card shows first for every setting the jig
// asks about, and the resolution of stage-1 settings — an empty value is filled with its
// recommendation and marked 'assumed' (가정), a given value keeps the source it came with
// ('person' unless said otherwise). An assumed value may drive the preview, never a member make
// (`makeAllowed` in the contract). Lengths are metres here; the screen shows mm.

import {
  OPENING_MAX,
  PATTERNS,
  type MemberSettings,
  type OptimizeSettings,
  type PreviewSettings,
  type SettingSource,
} from '../../../contracts/paneling.ts';

type Values<T> = { [K in keyof T]: T[K] extends { value: infer V } ? V : never };

/** SPEC-16.4 1 추천값, stage 1. */
export const RECOMMENDED_PREVIEW: Values<PreviewSettings> = {
  pattern: 'grid',
  size: [1.2, 0.6],
  measure: 'arc-length',
  projection: 'plan-xy',
  direction: { axis: 'u', startCorner: 'min-min', flip: false },
  boundary: { rule: 'trim', mergeBelow: 0.3 },
};
/** SPEC-16.4 1 추천값 of the stage-1 settings read only with some values (SPEC-16.13). */
export const RECOMMENDED_VORONOI = { jitter: 0.5, seed: 1 };
export const RECOMMENDED_OPENING = { near: 0, far: 0, radius: 10, levels: 5 as number };

/** SPEC-16.4 1 추천값, stage 2. */
export const RECOMMENDED_MEMBERS: Values<MemberSettings> = {
  thickness: 0.05,
  thicknessSide: 'outside',
  joint: 0.01,
  boundaryJoint: 'flush',
  stock: null,
};
/** SPEC-16.4 1 추천값, stage 3. */
export const RECOMMENDED_OPTIMIZE: Values<OptimizeSettings> = {
  flatnessTol: 0.003,
  planarize: 'best-fit',
  typeTol: 0.002,
  maxTypes: null,
  flatRadius: 100,
  nodeAngleStep: 1,
};

function resolve<T extends Record<string, unknown>>(
  recommended: T,
  given: Partial<T>,
  sources: Partial<Record<keyof T, SettingSource>>,
): { [K in keyof T]: { value: T[K]; source: SettingSource } } {
  const out = {} as { [K in keyof T]: { value: T[K]; source: SettingSource } };
  for (const key of Object.keys(recommended) as (keyof T)[]) {
    const value = given[key];
    out[key] =
      value === undefined
        ? { value: structuredClone(recommended[key]), source: 'assumed' }
        : { value: value as T[keyof T], source: sources[key] ?? 'person' };
  }
  return out;
}

/** Stage-1 settings from given values: empty ones take the recommendation as 'assumed'. */
export function resolvePreviewSettings(
  given: Partial<Values<PreviewSettings>> = {},
  sources: Partial<Record<keyof PreviewSettings, SettingSource>> = {},
): PreviewSettings {
  return resolve(RECOMMENDED_PREVIEW, given, sources) as PreviewSettings;
}
export function resolveMemberSettings(
  given: Partial<Values<MemberSettings>> = {},
  sources: Partial<Record<keyof MemberSettings, SettingSource>> = {},
): MemberSettings {
  return resolve(RECOMMENDED_MEMBERS, given, sources) as MemberSettings;
}
export function resolveOptimizeSettings(
  given: Partial<Values<OptimizeSettings>> = {},
  sources: Partial<Record<keyof OptimizeSettings, SettingSource>> = {},
): OptimizeSettings {
  return resolve(RECOMMENDED_OPTIMIZE, given, sources) as OptimizeSettings;
}

const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
const positive = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * Stage-1 settings from the jig's flat setting values (`jig.json` params: pattern, width, height,
 * measure, projection, axis, startCorner, flip, boundaryRule, mergeBelow; lengths in metres).
 * A missing or invalid value counts as empty (추천값, 'assumed'). The engine tells which values are
 * still on their default (`by: 'default'` of a 'to-ask' setting) and passes those as `assumed`.
 */
export function previewSettingsFromParams(
  params: Record<string, unknown>,
  assumed: readonly string[] = [],
): PreviewSettings {
  const given: Partial<Values<PreviewSettings>> = {};
  const sources: Partial<Record<keyof PreviewSettings, SettingSource>> = {};
  const pattern = pick(params.pattern, PATTERNS);
  if (pattern) given.pattern = pattern;
  const w = positive(params.width),
    h = positive(params.height);
  if (w && h) given.size = [w, h];
  const measure = pick(params.measure, ['arc-length', 'parameter', 'projected'] as const);
  if (measure) given.measure = measure;
  const projection = pick(params.projection, ['plan-xy', 'best-vertical'] as const);
  if (projection) given.projection = projection;
  const axis = pick(params.axis, ['u', 'v'] as const);
  const startCorner = pick(params.startCorner, [
    'min-min',
    'max-min',
    'min-max',
    'max-max',
  ] as const);
  if (axis || startCorner || typeof params.flip === 'boolean')
    given.direction = {
      axis: axis ?? RECOMMENDED_PREVIEW.direction.axis,
      startCorner: startCorner ?? RECOMMENDED_PREVIEW.direction.startCorner,
      flip: typeof params.flip === 'boolean' ? params.flip : false,
    };
  const rule = pick(params.boundaryRule, ['trim', 'merge', 'drop'] as const);
  const mergeBelow =
    typeof params.mergeBelow === 'number' && params.mergeBelow >= 0 && params.mergeBelow <= 1
      ? params.mergeBelow
      : undefined;
  if (rule || mergeBelow !== undefined)
    given.boundary = {
      rule: rule ?? RECOMMENDED_PREVIEW.boundary.rule,
      mergeBelow: mergeBelow ?? RECOMMENDED_PREVIEW.boundary.mergeBelow,
    };
  const groups: Record<string, keyof PreviewSettings> = {
    pattern: 'pattern',
    width: 'size',
    height: 'size',
    measure: 'measure',
    projection: 'projection',
    axis: 'direction',
    startCorner: 'direction',
    flip: 'direction',
    boundaryRule: 'boundary',
    mergeBelow: 'boundary',
  };
  for (const key of assumed) if (groups[key]) sources[groups[key]] = 'assumed';
  const settings = resolvePreviewSettings(given, sources);
  return withPatternExtras(settings, params, assumed);
}

const ratio = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= OPENING_MAX
    ? value
    : undefined;

/**
 * The stage-1 settings read only with some values (SPEC-16.13, SPEC-16.4 1): the Voronoi seeds when
 * the pattern is Voronoi (params jitter, seed), the opening when one of the two ratios is above 0
 * (params openNear, openFar, openRadius in metres, openLevels with 0 = continuous). Without them
 * the settings (and their hash) stay as before.
 */
export function withPatternExtras(
  settings: PreviewSettings,
  params: Record<string, unknown>,
  assumed: readonly string[] = [],
): PreviewSettings {
  const out: PreviewSettings = { ...settings };
  const sourceOf = (keys: string[]): SettingSource =>
    keys.some((k) => assumed.includes(k) || params[k] === undefined) ? 'assumed' : 'person';
  if (settings.pattern.value === 'voronoi') {
    const jitter =
      typeof params.jitter === 'number' && params.jitter >= 0 && params.jitter <= 1
        ? params.jitter
        : RECOMMENDED_VORONOI.jitter;
    const seed =
      typeof params.seed === 'number' &&
      Number.isInteger(params.seed) &&
      params.seed >= 0 &&
      params.seed <= 9999
        ? params.seed
        : RECOMMENDED_VORONOI.seed;
    out.voronoi = { value: { jitter, seed }, source: sourceOf(['jitter', 'seed']) };
  }
  const near = ratio(params.openNear) ?? RECOMMENDED_OPENING.near;
  const far = ratio(params.openFar) ?? RECOMMENDED_OPENING.far;
  if (near > 0 || far > 0) {
    const radius = positive(params.openRadius) ?? RECOMMENDED_OPENING.radius;
    const levels =
      typeof params.openLevels === 'number' &&
      Number.isInteger(params.openLevels) &&
      (params.openLevels === 0 || (params.openLevels >= 2 && params.openLevels <= 20))
        ? params.openLevels
        : RECOMMENDED_OPENING.levels;
    out.opening = {
      value: { near, far, radius, levels: levels as 0 },
      source: sourceOf(['openNear', 'openFar', 'openRadius', 'openLevels']),
    };
  }
  return out;
}

const nonNegative = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Stage-2 settings from the jig's flat setting values (thickness, thicknessSide, joint,
 * boundaryJoint, stockWidth, stockHeight; lengths in metres). A stock of 0 × 0 is 'no limit'
 * (null); one side 0 is no limit that way only (the other still checked). Missing or invalid values take the recommendation as
 * 'assumed', as do the keys listed in `assumed` (still on their default).
 */
export function memberSettingsFromParams(
  params: Record<string, unknown>,
  assumed: readonly string[] = [],
): MemberSettings {
  const given: Partial<Values<MemberSettings>> = {};
  const sources: Partial<Record<keyof MemberSettings, SettingSource>> = {};
  const thickness = positive(params.thickness);
  if (thickness) given.thickness = thickness;
  const side = pick(params.thicknessSide, ['outside', 'inside'] as const);
  if (side) given.thicknessSide = side;
  const joint = nonNegative(params.joint);
  if (joint !== undefined) given.joint = joint;
  const boundaryJoint = pick(params.boundaryJoint, ['flush', 'half'] as const);
  if (boundaryJoint) given.boundaryJoint = boundaryJoint;
  const sw = nonNegative(params.stockWidth),
    sh = nonNegative(params.stockHeight);
  if (sw !== undefined && sh !== undefined) {
    given.stock = sw > 0 || sh > 0 ? [sw, sh] : null;
  }
  const groups: Record<string, keyof MemberSettings> = {
    thickness: 'thickness',
    thicknessSide: 'thicknessSide',
    joint: 'joint',
    boundaryJoint: 'boundaryJoint',
    stockWidth: 'stock',
    stockHeight: 'stock',
  };
  for (const key of assumed) if (groups[key]) sources[groups[key]] = 'assumed';
  return resolveMemberSettings(given, sources);
}

/**
 * Stage-3 settings from the jig's flat values (flatnessTol, planarize, typeTol, maxTypes, flatRadius,
 * nodeAngleStep; lengths in metres). `maxTypes` 0 or empty means no limit (the jig's '0이면 제한
 * 없음'); a negative or fractional count is passed on as given so the settings check refuses it.
 * Missing or invalid values count as empty (추천값, 'assumed'), as do the keys in `assumed`.
 */
export function optimizeSettingsFromParams(
  params: Record<string, unknown>,
  assumed: readonly string[] = [],
): OptimizeSettings {
  const given: Partial<Values<OptimizeSettings>> = {};
  const sources: Partial<Record<keyof OptimizeSettings, SettingSource>> = {};
  for (const key of ['flatnessTol', 'typeTol', 'flatRadius', 'nodeAngleStep'] as const) {
    const value = positive(params[key]);
    if (value !== undefined) given[key] = value;
  }
  const planarize = pick(params.planarize, ['none', 'best-fit', 'pq'] as const);
  if (planarize) given.planarize = planarize;
  if (typeof params.maxTypes === 'number' && Number.isFinite(params.maxTypes))
    given.maxTypes = params.maxTypes === 0 ? null : params.maxTypes;
  else if (params.maxTypes === null) given.maxTypes = null;
  for (const key of assumed)
    if (key in RECOMMENDED_OPTIMIZE) sources[key as keyof OptimizeSettings] = 'assumed';
  return resolveOptimizeSettings(given, sources);
}

/** The values of settings without their sources (what the computation reads; `settingsHash`). */
export function settingValues<T extends Record<string, { value: unknown }>>(settings: T) {
  return Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, v.value]));
}
