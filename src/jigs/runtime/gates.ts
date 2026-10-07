// Gates (점검, SPEC-07.14, ARCH-03 §11): every check the core offers, chosen by name in a jig's
// manifest. A gate runs at one timing with one level — `block` stops the flow, `warn` only lists,
// `isolate` drops the failing items and passes the rest. The catalogue is the closed vocabulary the
// manifest validator accepts; a name listed here but not implemented yet fails closed at its level
// so a jig never silently runs without a check it declared. Messages are the architectural
// sentences the step rail shows; the exact wording is Design's.

import type { GateUse, JigManifest } from './manifest.ts';
import type { ParamValue } from './params.ts';

export type GateTiming = 'before-run' | 'after-run' | 'after-ai' | 'before-render' | 'before-bake';
export type GateLevel = 'block' | 'warn' | 'isolate';

export interface GateSpec {
  timing: GateTiming;
  /** Default level when the jig names the gate without one. */
  level: GateLevel;
  /** A verdict annotates the result table ('초과') and never blocks (ARCH-03 §11). */
  verdict?: true;
  implemented: boolean;
}

const GATE_TABLE = {
  'inputs-present': { timing: 'before-run', level: 'block', implemented: true },
  'inputs-confirmed': { timing: 'before-run', level: 'warn', implemented: true },
  'units-si': { timing: 'before-run', level: 'block', implemented: true },
  'stale-input': { timing: 'before-run', level: 'block', implemented: true },
  'fact-valid': { timing: 'before-run', level: 'block', implemented: true },
  'basis-required': { timing: 'before-run', level: 'warn', implemented: true },
  'non-empty': { timing: 'after-run', level: 'block', implemented: true },
  'no-nan': { timing: 'after-run', level: 'block', implemented: true },
  'ids-stable': { timing: 'after-run', level: 'block', implemented: true },
  'ring-orientation': { timing: 'after-run', level: 'block', implemented: true },
  'polygon-valid': { timing: 'after-run', level: 'block', implemented: true },
  'inside-boundary': { timing: 'after-run', level: 'block', implemented: true },
  'no-overlap': { timing: 'after-run', level: 'block', implemented: false },
  'planar-curve': { timing: 'after-run', level: 'block', implemented: false },
  'span-max': { timing: 'after-run', level: 'warn', verdict: true, implemented: true },
  'cantilever-max': { timing: 'after-run', level: 'warn', verdict: true, implemented: true },
  'mark-unique': { timing: 'after-run', level: 'block', implemented: true },
  'schedule-complete': { timing: 'after-run', level: 'block', implemented: false },
  'combo-echo': { timing: 'after-run', level: 'block', implemented: false },
  'unchecked-listed': { timing: 'after-run', level: 'block', implemented: false },
  'ref-whitelist': { timing: 'after-ai', level: 'block', implemented: false },
  'numbers-in-source': { timing: 'after-ai', level: 'block', implemented: false },
  'quote-exists': { timing: 'after-ai', level: 'block', implemented: false },
  'no-formula-invented': { timing: 'after-ai', level: 'block', implemented: false },
  'no-plan-dependent-conclusion': { timing: 'after-ai', level: 'block', implemented: false },
  'claim-consistent': { timing: 'before-render', level: 'block', implemented: false },
  'solid-closed': { timing: 'before-bake', level: 'block', implemented: false },
  'tag-scope': { timing: 'before-bake', level: 'block', implemented: false },
  'count-match': { timing: 'before-bake', level: 'block', implemented: false },
  'layer-scope': { timing: 'before-bake', level: 'block', implemented: true },
  'hidden-target': { timing: 'before-bake', level: 'block', implemented: true },
  'bake-args-safe': { timing: 'before-bake', level: 'block', implemented: false },
  'analysis-confirmed': { timing: 'before-bake', level: 'block', implemented: true },
  'target-confirmed': { timing: 'before-bake', level: 'block', implemented: true },
} as const satisfies Record<string, GateSpec>;
export type GateName = keyof typeof GATE_TABLE;
export const GATES: { readonly [K in GateName]: GateSpec } = GATE_TABLE;
export const GATE_NAMES = Object.keys(GATES) as GateName[];
export const isGateName = (name: string): name is GateName => name in GATES;

export interface GateResult {
  name: GateName;
  timing: GateTiming;
  level: GateLevel;
  ok: boolean;
  /** Keys or descriptions of what failed (empty when ok). */
  failed: string[];
  message: string;
  /** Items removed by an `isolate` gate. */
  isolated?: number;
  /** A verdict gate: annotations for the result table, never a block. */
  verdict?: true;
}

export interface GateContext {
  manifest: JigManifest;
  stepId: string;
  /** Input values by key (an assembly input is `{ <role>: snapshot }`). */
  inputs: Record<string, unknown>;
  params: Record<string, ParamValue>;
  /** After-run: the step's output. Isolate gates replace it. */
  output?: unknown;
  inputHash?: string;
  /** The previous result of this step, for `ids-stable`. */
  previous?: { inputHash: string; output: unknown } | null;
  /** Assembly roles and whether a person confirmed them. */
  assembly?: Record<string, { confirmed?: unknown; sources?: { revisionKey: string }[] }>;
  /** Current document revision keys by link, for `stale-input`; absent means unknown (passes). */
  currentRevisions?: Record<string, string>;
  layerRoot?: string;
  /** Before-bake: objects the bake would delete and the layers it would write. */
  bake?: {
    targets?: { key: string; layer: string; visible: boolean; locked: boolean }[];
    layers?: string[];
  };
  hooks?: {
    analysisConfirmed?: (inputHash: string) => boolean;
    /** A `confirm-target` human step is confirmed (SPEC-12.3의 3). */
    targetConfirmed?: () => boolean;
  };
}

export interface GateRun {
  results: GateResult[];
  /** Names of block-level gates that failed; the flow stops when non-empty. */
  blocked: string[];
  /** The output after isolate gates removed failing items. */
  output: unknown;
}

type Point = [number, number];
type Args = Record<string, unknown>;
const EPS = 1e-9;

/** Value at a dotted path ('columns', 'site.outline'). */
export function at(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
function setAt(value: unknown, path: string | undefined, next: unknown): unknown {
  if (!path) return next;
  const parts = path.split('.');
  const copy = (node: unknown, index: number): unknown => {
    if (index === parts.length) return next;
    const record = node && typeof node === 'object' ? (node as Record<string, unknown>) : {};
    return { ...record, [parts[index]]: copy(record[parts[index]], index + 1) };
  };
  return copy(value, 0);
}
/** The item array a gate looks at: `args.items` path, the output itself, or its first array field. */
function itemsOf(output: unknown, args: Args): { path: string | undefined; items: unknown[] } {
  const path = typeof args.items === 'string' ? args.items : undefined;
  const direct = at(output, path);
  if (Array.isArray(direct)) return { path, items: direct };
  if (!path && output && typeof output === 'object')
    for (const [key, value] of Object.entries(output as Record<string, unknown>))
      if (Array.isArray(value)) return { path: key, items: value };
  return { path, items: [] };
}
const keyOf = (item: unknown, field: string) =>
  item && typeof item === 'object' ? (item as Record<string, unknown>)[field] : undefined;
const keyField = (args: Args) => (typeof args.key === 'string' ? args.key : 'key');

function isPoint(value: unknown): value is Point {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}
export function polygonOf(value: unknown): Point[] | null {
  const points = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { points?: unknown }).points)
      ? (value as { points: unknown[] }).points
      : null;
  if (!points || !points.every(isPoint)) return null;
  const ring = points.map((p): Point => [p[0], p[1]]);
  if (ring.length > 1) {
    const [a, b] = [ring[0], ring[ring.length - 1]];
    if (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS) ring.pop();
  }
  return ring;
}
export function signedArea(ring: Point[]) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i],
      [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}
const cross = (o: Point, a: Point, b: Point) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function segmentsCross(a: Point, b: Point, c: Point, d: Point) {
  const d1 = cross(c, d, a),
    d2 = cross(c, d, b),
    d3 = cross(a, b, c),
    d4 = cross(a, b, d);
  return (
    ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
    ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))
  );
}
/** Why a ring is not a valid simple polygon, or null. */
export function polygonProblem(ring: Point[] | null): string | null {
  if (!ring) return 'not-a-polygon';
  if (ring.length < 3) return 'fewer-than-3-points';
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    if (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS) return 'repeated-point';
  }
  if (Math.abs(signedArea(ring)) < 1e-6) return 'zero-area';
  const n = ring.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n]))
        return 'self-intersection';
    }
  return null;
}
export function pointInPolygon(point: Point, ring: Point[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1]) {
      const x = ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
      if (point[0] < x) inside = !inside;
    }
  }
  return inside;
}
function hasNaN(value: unknown, path = '', found: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) found.push(path || '(root)');
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => hasNaN(item, `${path}[${index}]`, found));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      hasNaN(item, path ? `${path}.${key}` : key, found);
  }
  return found;
}

type Check = (
  ctx: GateContext,
  args: Args,
  level: GateLevel,
) => { failed: string[]; message: string; output?: unknown; isolated?: number };

const requiredInputKeys = (manifest: JigManifest, stepId: string) => {
  const step = manifest.steps.find((s) => s.id === stepId);
  const read = new Set(
    (step?.reads ?? [])
      .filter((r) => r.startsWith('input.'))
      .map((r) => r.split('.').slice(1, 3).join('.')),
  );
  const keys: string[] = [];
  for (const input of manifest.inputs) {
    if (input.kind === 'assembly') {
      for (const role of input.roles)
        if (role.required && (read.has(input.key) || read.has(`${input.key}.${role.role}`)))
          keys.push(`${input.key}.${role.role}`);
    } else if ('required' in input && input.required && read.has(input.key)) keys.push(input.key);
  }
  return keys;
};

const checks: Record<GateName, Check> = {
  'inputs-present': (ctx) => {
    const failed = requiredInputKeys(ctx.manifest, ctx.stepId).filter((key) => {
      const value = at(ctx.inputs, key);
      return value === undefined || value === null || (Array.isArray(value) && !value.length);
    });
    return { failed, message: failed.length ? `필요한 입력이 없습니다: ${failed.join(', ')}` : '' };
  },
  'inputs-confirmed': (ctx) => {
    const failed = Object.entries(ctx.assembly ?? {})
      .filter(([, role]) => !role.confirmed)
      .map(([role]) => role);
    return {
      failed,
      message: failed.length ? `사람이 확인하지 않은 입력 역할: ${failed.join(', ')}` : '',
    };
  },
  'units-si': (ctx) => {
    const failed: string[] = [];
    for (const decl of ctx.manifest.params) {
      const value = ctx.params[decl.key]?.value;
      if (decl.type === 'choice' || decl.type === 'toggle') continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) failed.push(decl.key);
    }
    return { failed, message: failed.length ? `SI 값이 아닌 설정값: ${failed.join(', ')}` : '' };
  },
  'stale-input': (ctx) => {
    if (!ctx.currentRevisions) return { failed: [], message: '' };
    const failed: string[] = [];
    for (const [role, entry] of Object.entries(ctx.assembly ?? {}))
      for (const source of entry.sources ?? []) {
        const link = source.revisionKey.split('|').slice(0, 2).join('|');
        const current = Object.entries(ctx.currentRevisions).find(
          ([, key]) => key.split('|').slice(0, 2).join('|') === link,
        );
        if (current && current[1] !== source.revisionKey) failed.push(role);
      }
    return {
      failed: [...new Set(failed)],
      message: failed.length
        ? `읽은 뒤 문서가 바뀐 입력 역할: ${[...new Set(failed)].join(', ')}`
        : '',
    };
  },
  'fact-valid': (ctx, _args, level) => {
    const invalid: string[] = [],
      unconfirmed: string[] = [];
    for (const [key, value] of Object.entries(ctx.params)) {
      if (value.by !== 'fact') continue;
      if (value.status === 'contaminated' || value.status === 'superseded') invalid.push(key);
      else if (value.status === 'ai') unconfirmed.push(key);
    }
    // Unconfirmed statements only warn (ARCH-03 §11); invalid ones fail at the declared level.
    const failed = level === 'warn' ? [...invalid, ...unconfirmed] : invalid;
    return {
      failed,
      message: invalid.length
        ? `근거가 무효인 설정값: ${invalid.join(', ')}`
        : unconfirmed.length
          ? `근거가 미확정인 설정값: ${unconfirmed.join(', ')}`
          : '',
    };
  },
  'basis-required': (ctx) => {
    const failed = ctx.manifest.params
      .filter((decl) => decl.basis?.status === 'to-ask' && ctx.params[decl.key]?.by === 'default')
      .map((decl) => decl.key);
    return {
      failed,
      message: failed.length ? `물어볼 설정값이 남아 있습니다: ${failed.join(', ')}` : '',
    };
  },
  'non-empty': (ctx, args) => {
    const { items } = itemsOf(ctx.output, args);
    const empty = !items.length;
    // `args.message`: the jig's own sentence for why an empty list stops the flow.
    const said = typeof args.message === 'string' && args.message ? args.message.slice(0, 200) : '';
    return {
      failed: empty ? ['(empty)'] : [],
      message: empty ? said || '결과가 비어 있습니다' : '',
    };
  },
  'no-nan': (ctx) => {
    const failed = hasNaN(ctx.output).slice(0, 20);
    return { failed, message: failed.length ? `수치 오류(NaN·무한)가 있습니다: ${failed[0]}` : '' };
  },
  'ids-stable': (ctx, args) => {
    const field = keyField(args);
    const { items } = itemsOf(ctx.output, args);
    const keys = items.map((item) => keyOf(item, field));
    const failed: string[] = [];
    const seen = new Set<string>();
    keys.forEach((key, index) => {
      if (typeof key !== 'string' || !key) failed.push(`#${index}`);
      else if (seen.has(key)) failed.push(key);
      seen.add(String(key));
    });
    let message = failed.length
      ? `안정 키가 없거나 겹칩니다: ${failed.slice(0, 5).join(', ')}`
      : '';
    // The same input fingerprint must give the same keys.
    if (!failed.length && ctx.previous && ctx.previous.inputHash === ctx.inputHash) {
      const before = new Set(
        itemsOf(ctx.previous.output, args).items.map((item) => String(keyOf(item, field))),
      );
      for (const key of seen) if (!before.has(key)) failed.push(key);
      for (const key of before) if (!seen.has(key)) failed.push(key);
      if (failed.length)
        message = `같은 입력인데 키가 달라졌습니다: ${failed.slice(0, 5).join(', ')}`;
    }
    return { failed, message };
  },
  'ring-orientation': (ctx, args, level) => {
    const field = typeof args.field === 'string' ? args.field : 'shape';
    const { path, items } = itemsOf(ctx.output, args);
    const failed: string[] = [];
    const kept = items.filter((item, index) => {
      const ring = polygonOf(at(item, field));
      const ok = !!ring && signedArea(ring) > EPS;
      if (!ok) failed.push(String(keyOf(item, keyField(args)) ?? `#${index}`));
      return ok;
    });
    return {
      failed,
      message: failed.length ? `방향이 반시계가 아닌 다각형 ${failed.length}개` : '',
      ...(level === 'isolate' && failed.length
        ? { output: setAt(ctx.output, path, kept), isolated: failed.length }
        : {}),
    };
  },
  'polygon-valid': (ctx, args, level) => {
    const field = typeof args.field === 'string' ? args.field : 'shape';
    const { path, items } = itemsOf(ctx.output, args);
    const failed: string[] = [];
    const kept = items.filter((item, index) => {
      const problem = polygonProblem(polygonOf(at(item, field)));
      if (problem) failed.push(`${String(keyOf(item, keyField(args)) ?? `#${index}`)}:${problem}`);
      return !problem;
    });
    return {
      failed,
      message: failed.length ? `유효하지 않은 다각형 ${failed.length}개(${failed[0]})` : '',
      ...(level === 'isolate' && failed.length
        ? { output: setAt(ctx.output, path, kept), isolated: failed.length }
        : {}),
    };
  },
  'inside-boundary': (ctx, args, level) => {
    // `boundary` is a path into the inputs, or into the output with an `output.` prefix.
    const boundaryPath = typeof args.boundary === 'string' ? args.boundary : '';
    const boundary = polygonOf(
      boundaryPath.startsWith('output.')
        ? at(ctx.output, boundaryPath.slice(7))
        : at(ctx.inputs, boundaryPath),
    );
    if (!boundary) return { failed: ['(boundary)'], message: '경계 다각형이 없습니다' };
    const field = typeof args.field === 'string' ? args.field : 'at';
    const { path, items } = itemsOf(ctx.output, args);
    const failed: string[] = [];
    const kept = items.filter((item, index) => {
      const value = at(item, field);
      const points = isPoint(value) ? [value] : (polygonOf(value) ?? []);
      const ok = points.length > 0 && points.every((p) => pointInPolygon(p, boundary));
      if (!ok) failed.push(String(keyOf(item, keyField(args)) ?? `#${index}`));
      return ok;
    });
    return {
      failed,
      message: failed.length ? `경계 밖으로 나가는 항목 ${failed.length}개` : '',
      ...(level === 'isolate' && failed.length
        ? { output: setAt(ctx.output, path, kept), isolated: failed.length }
        : {}),
    };
  },
  'span-max': (ctx, args) => {
    const field = typeof args.field === 'string' ? args.field : 'span_m';
    const max =
      typeof args.max === 'number' ? args.max : Number(ctx.params[String(args.param)]?.value);
    const { items } = itemsOf(ctx.output, args);
    const failed = Number.isFinite(max)
      ? items
          .filter((item) => Number(at(item, field)) > max + 1e-6)
          .map((item) => String(keyOf(item, keyField(args))))
      : [];
    return { failed, message: failed.length ? `경간 상한 ${max} m 초과 ${failed.length}개` : '' };
  },
  'cantilever-max': (ctx, args) => {
    const field = typeof args.field === 'string' ? args.field : 'cantilever_m';
    const max =
      typeof args.max === 'number' ? args.max : Number(ctx.params[String(args.param)]?.value);
    const { items } = itemsOf(ctx.output, args);
    const failed = Number.isFinite(max)
      ? items
          .filter((item) => Number(at(item, field)) > max + 1e-6)
          .map((item) => String(keyOf(item, keyField(args))))
      : [];
    return {
      failed,
      message: failed.length ? `내민 길이 상한 ${max} m 초과 ${failed.length}개` : '',
    };
  },
  'mark-unique': (ctx, args) => {
    const field = typeof args.field === 'string' ? args.field : 'mark';
    const { items } = itemsOf(ctx.output, args);
    const seen = new Set<string>(),
      failed: string[] = [];
    for (const item of items) {
      const mark = at(item, field);
      if (typeof mark !== 'string') continue;
      if (seen.has(mark)) failed.push(mark);
      seen.add(mark);
    }
    return {
      failed,
      message: failed.length ? `부호가 겹칩니다: ${[...new Set(failed)].join(', ')}` : '',
    };
  },
  'layer-scope': (ctx) => {
    const root = ctx.layerRoot ?? '';
    const failed = (ctx.bake?.layers ?? []).filter(
      (layer) => !root || !(layer === root || layer.startsWith(root + '::')),
    );
    return {
      failed,
      message: failed.length ? `출력 레이어 밖에 쓰려 합니다: ${failed.join(', ')}` : '',
    };
  },
  'hidden-target': (ctx) => {
    const failed = (ctx.bake?.targets ?? [])
      .filter((target) => !target.visible || target.locked)
      .map((target) => target.key);
    return {
      failed,
      message: failed.length ? `꺼진·잠긴 레이어의 객체를 교체하려 합니다: ${failed.length}개` : '',
    };
  },
  'analysis-confirmed': (ctx) => {
    const ok = !!ctx.inputHash && !!ctx.hooks?.analysisConfirmed?.(ctx.inputHash);
    return {
      failed: ok ? [] : ['(analysis)'],
      message: ok ? '' : '같은 입력의 확정 해석이 없습니다',
    };
  },
  'target-confirmed': (ctx) => {
    const ok = !!ctx.hooks?.targetConfirmed?.();
    return {
      failed: ok ? [] : ['(target)'],
      message: ok ? '' : '대상 필지를 확정하지 않았습니다',
    };
  },
  // Not implemented yet: fail closed at the declared level (see the module comment).
  'no-overlap': pending,
  'planar-curve': pending,
  'schedule-complete': pending,
  'combo-echo': pending,
  'unchecked-listed': pending,
  'ref-whitelist': pending,
  'numbers-in-source': pending,
  'quote-exists': pending,
  'no-formula-invented': pending,
  'no-plan-dependent-conclusion': pending,
  'claim-consistent': pending,
  'solid-closed': pending,
  'tag-scope': pending,
  'count-match': pending,
  'bake-args-safe': pending,
};
function pending(): ReturnType<Check> {
  return { failed: ['(not-implemented)'], message: '이 VIDE에 아직 없는 점검입니다' };
}

/** Run the gates of one timing in declaration order; block gates that fail stop the flow. */
export function runGates(uses: readonly GateUse[], timing: GateTiming, ctx: GateContext): GateRun {
  const results: GateResult[] = [];
  const blocked: string[] = [];
  let output = ctx.output;
  for (const use of uses) {
    const spec = GATES[use.use];
    if (spec.timing !== timing) continue;
    const level = spec.verdict ? 'warn' : (use.level ?? spec.level);
    const outcome = checks[use.use]({ ...ctx, output }, use.args ?? {}, level);
    const ok = !outcome.failed.length;
    if (!ok && level === 'block') blocked.push(use.use);
    if (outcome.output !== undefined) output = outcome.output;
    results.push({
      name: use.use,
      timing,
      level,
      ok,
      failed: outcome.failed,
      message: outcome.message,
      ...(outcome.isolated ? { isolated: outcome.isolated } : {}),
      ...(spec.verdict ? { verdict: true } : {}),
    });
  }
  return { results, blocked, output };
}
