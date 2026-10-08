// 패널링 기준 면 읽기 (SPEC-16.3, ARCH-03 §9.1, PLAN-49 T-251): the data block of the official read
// template `vide.read.surface-grid@1`, the body it renders to, and the template's answer decoded
// into the shared `SurfaceSample` (base64 float64 blocks → number arrays, units already metres).
// Failures keep the template's leading code and get the Korean reason the screen shows.

import { z } from 'zod';
import { renderTemplate } from '../jigs/bake/templates.ts';
import {
  SAMPLE_LIMIT,
  surfaceSampleSchema,
  type SurfaceFaceSample,
  type SurfaceSample,
} from '../contracts/paneling.ts';

export const SURFACE_TEMPLATE = 'vide.read.surface-grid@1';
/** Default grid per face (SPEC-16.3 2, SPIKE-2026-10-08-paneling: 128² ≤ 0.01 mm with cubic interpolation). */
export const DEFAULT_GRID = 128;
export const MAX_GRID = 512;
/** Faces per read (`surfaceSampleSchema.faces`). */
export const FACE_LIMIT = 64;

export type SurfaceReadMode = 'grid' | 'probe' | 'hashes';
const MODES: Record<SurfaceReadMode, number> = { grid: 0, probe: 1, hashes: 2 };

class BlockWriter {
  private parts: Buffer[] = [];
  i32(value: number) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(value);
    this.parts.push(b);
    return this;
  }
  f64(value: number) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(value);
    this.parts.push(b);
    return this;
  }
  str(value: string) {
    const bytes = Buffer.from(value, 'utf8');
    this.i32(bytes.length);
    this.parts.push(bytes);
    return this;
  }
  done() {
    return Buffer.concat(this.parts);
  }
}

export interface SurfaceReadRequest {
  mode: SurfaceReadMode;
  objectId: string;
  /** Rhino Brep face index; −1 = every face. */
  faceIndex: number;
  grid?: number;
  /** Probe parameters (u, v) for `probe`. */
  probes?: readonly number[];
}

/** The data block (ARCH-03 §9.1): little endian, base64 in the one placeholder. */
export function surfaceReadBlock({
  mode,
  objectId,
  faceIndex,
  grid = DEFAULT_GRID,
  probes = [],
}: SurfaceReadRequest): Buffer {
  if (!z.string().uuid().safeParse(objectId).success) throw failure('FACE_NOT_FOUND');
  if (!Number.isInteger(faceIndex) || faceIndex < -1) throw failure('FACE_NOT_FOUND');
  if (!Number.isInteger(grid) || grid < 2 || grid > MAX_GRID) throw failure('READ_GRID');
  if (probes.length % 2 !== 0 || !probes.every(Number.isFinite)) throw failure('READ_GRID');
  const w = new BlockWriter()
    .str(SURFACE_TEMPLATE)
    .i32(MODES[mode])
    .str(objectId)
    .i32(faceIndex)
    .i32(grid)
    .i32(grid)
    .i32(1)
    .i32(probes.length / 2);
  for (const p of probes) w.f64(p);
  return w.done();
}
/** The C# body to send with `direct-read` (template text with only the data block substituted). */
export function surfaceReadBody(request: SurfaceReadRequest): string {
  return renderTemplate(SURFACE_TEMPLATE, surfaceReadBlock(request)).code;
}

// ── 실패 (SPEC-16.3 5) ─────────────────────────────────────────────────────────────────────────

export const READ_FAILURES: Record<string, string> = {
  UNKNOWN_UNITS: '문서 단위가 없습니다 · Rhino에서 단위를 정하세요',
  FACE_NOT_FOUND: '면을 찾지 못했습니다',
  MESH_NOT_ACCEPTED: '메쉬 기준 면은 아직 받지 않습니다 · Rhino에서 서피스로 바꾸세요',
  NOT_A_SURFACE: '서피스·폴리서피스가 아닙니다',
  NO_SAMPLE_INSIDE: '트림 안에 든 표본이 없습니다 · 촘촘하게 다시 읽기',
  SAMPLE_LIMIT: `표본 점이 ${SAMPLE_LIMIT.toLocaleString('en-US')}개를 넘습니다 · 면을 적게 고르거나 표본을 줄이세요`,
  FACE_LIMIT: `면이 ${FACE_LIMIT}개를 넘습니다 · 면을 나눠 고르세요`,
  READ_GRID: '표본 격자는 2~512입니다',
  READ_INVALID: '읽은 표본이 형식에 맞지 않습니다',
  READ_CHANGED_DOCUMENT: '읽기가 문서를 바꾸려 해 멈췄습니다',
  PICK_NONE: 'Rhino에서 기준 면을 고른 뒤 [고른 면 쓰기]를 누르세요',
  PICK_MANY: '객체 하나만 고르세요 · 한 폴리서피스의 여러 면은 그 객체 하나로 고릅니다',
  NOT_PICKED: '아직 고른 기준 면이 없습니다',
  HOST_NOT_CONNECTED: '연결된 Rhino 문서가 없습니다 · Rhino에서 VIDE 연결을 켜세요',
  ATTACHED_ONLY: '기준 면은 연결된 Rhino 문서에서 고릅니다 · 파일 연결은 아직 읽지 않습니다',
  HOST_BUSY: 'Rhino가 명령을 실행 중입니다 · 끝난 뒤 다시 읽기',
  HOST_TIMEOUT: '읽기 시간이 한도를 넘었습니다 · 표본을 줄여 다시 읽기',
  READ_FAILED: '면을 읽지 못했습니다',
};
export interface ReadFailure {
  code: string;
  message: string;
}
export const failure = (code: string) => Object.assign(new Error(code), { code });
/** A known code with its reason; anything else is READ_FAILED with the detail after the reason. */
export function readFailure(code: string, detail?: string): ReadFailure {
  const known = READ_FAILURES[code];
  if (known && code !== 'READ_FAILED') return { code, message: known };
  const base = READ_FAILURES.READ_FAILED;
  return { code: 'READ_FAILED', message: detail ? `${base} · ${detail}` : base };
}
/** A template exception reads `CODE: 메시지`; anything else is READ_FAILED with its text. */
export function templateFailure(result: {
  code: string;
  message?: string;
  diagnostics?: string[];
}): ReadFailure {
  if (result.code !== 'EXECUTION_FAILED') return readFailure(result.code);
  const lead = /^([A-Z_]+):/.exec(result.message ?? '')?.[1];
  return lead && READ_FAILURES[lead]
    ? readFailure(lead)
    : readFailure('READ_FAILED', result.message?.slice(0, 300));
}

// ── 응답 풀기 ───────────────────────────────────────────────────────────────────────────────────

const block = z.union([z.string(), z.array(z.number())]);
const faceAnswer = z
  .object({
    faceIndex: z.number().int().nonnegative(),
    domainU: z.tuple([z.number(), z.number()]),
    domainV: z.tuple([z.number(), z.number()]),
    nu: z.number().int(),
    nv: z.number().int(),
    closedU: z.boolean(),
    closedV: z.boolean(),
    singular: z.object({
      uMin: z.boolean(),
      uMax: z.boolean(),
      vMin: z.boolean(),
      vMax: z.boolean(),
    }),
    points: block,
    normals: block,
    curvatures: block,
    inside: z.array(z.number()),
    trimLoops: z.array(z.array(z.tuple([z.number(), z.number()]))),
    geometryHash: z.string(),
  })
  .passthrough();
const gridAnswer = z
  .object({
    schema: z.literal(SURFACE_TEMPLATE),
    mode: z.literal(0),
    units: z.string(),
    toMeters: z.number().positive(),
    absTol: z.number().nonnegative(),
    nonFinite: z.number().int().nonnegative(),
    faces: z.array(faceAnswer).min(1),
  })
  .passthrough();
const hashesAnswer = z
  .object({ schema: z.literal(SURFACE_TEMPLATE), mode: z.literal(2), hashes: z.array(z.string()) })
  .passthrough();
export type GridAnswer = z.infer<typeof gridAnswer>;

/** A base64 little-endian float64 block (or a plain number array) as numbers. */
export function float64s(value: string | number[]): number[] {
  if (Array.isArray(value)) return value;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length % 8 !== 0) throw failure('READ_INVALID');
  const out = new Array<number>(bytes.length / 8);
  for (let k = 0; k < out.length; k++) out[k] = bytes.readDoubleLE(8 * k);
  return out;
}

/** Face hashes of a `hashes` read (face count of the object). */
export function decodeHashes(value: unknown): string[] {
  const parsed = hashesAnswer.safeParse(value);
  if (!parsed.success) throw failure('READ_INVALID');
  return parsed.data.hashes;
}
export function parseGrid(value: unknown): GridAnswer {
  const parsed = gridAnswer.safeParse(value);
  if (!parsed.success) throw failure('READ_INVALID');
  return parsed.data;
}

export interface SampleSource {
  linkId: string;
  documentKey: string;
  objectId: string;
  revisionKey: string;
  readAt: string;
  path: 'attached-template' | 'hidden-worker';
}
/** One or more grid answers of the same object → the shared `SurfaceSample` (schema-checked). */
export function decodeSurfaceSample(
  answers: readonly GridAnswer[],
  source: SampleSource,
): SurfaceSample {
  if (!answers.length) throw failure('READ_INVALID');
  const first = answers[0];
  const faces: SurfaceFaceSample[] = answers.flatMap((answer) =>
    answer.faces.map((f) => ({
      faceIndex: f.faceIndex,
      domainU: f.domainU,
      domainV: f.domainV,
      nu: f.nu,
      nv: f.nv,
      closedU: f.closedU,
      closedV: f.closedV,
      singular: {
        uMin: f.singular.uMin,
        uMax: f.singular.uMax,
        vMin: f.singular.vMin,
        vMax: f.singular.vMax,
      },
      points: float64s(f.points),
      normals: float64s(f.normals),
      curvatures: float64s(f.curvatures),
      inside: f.inside.map((v) => (v ? 1 : 0)),
      trimLoops: f.trimLoops,
      geometryHash: f.geometryHash,
    })),
  );
  const parsed = surfaceSampleSchema.safeParse({
    schema: 'vide.paneling.surface@1',
    source: {
      ...source,
      objectId: source.objectId.toLowerCase(),
      toMeters: first.toMeters,
      absTol: first.absTol,
    },
    faces,
  });
  if (!parsed.success) throw failure('READ_INVALID');
  return parsed.data;
}

/** What the screen shows about a kept sample (no arrays). */
export function sampleSummary(sample: SurfaceSample) {
  return {
    toMeters: sample.source.toMeters,
    absTol: sample.source.absTol,
    points: sample.faces.reduce((n, f) => n + f.nu * f.nv, 0),
    /** Size of the sampled faces' box along x, y, z (m), for the 기준 면 card. */
    extent: extentOf(sample.faces),
    faces: sample.faces.map((f) => {
      const inside = f.inside.reduce<number>((n, v) => n + v, 0);
      return {
        faceIndex: f.faceIndex,
        grid: [f.nu, f.nv],
        closedU: f.closedU,
        closedV: f.closedV,
        singular: f.singular,
        trimmed: f.trimLoops.length > 0,
        inside,
        /** Largest distance between neighbouring samples (m): how coarse the sample is. */
        spacing: maxSpacing(f),
      };
    }),
  };
}
function extentOf(faces: SurfaceFaceSample[]): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const f of faces)
    for (let k = 0; k < f.points.length; k++) {
      const v = f.points[k];
      if (v < lo[k % 3]) lo[k % 3] = v;
      if (v > hi[k % 3]) hi[k % 3] = v;
    }
  const size = (a: number) => (Number.isFinite(hi[a] - lo[a]) ? hi[a] - lo[a] : 0);
  return [size(0), size(1), size(2)];
}
function maxSpacing(f: SurfaceFaceSample) {
  const p = f.points;
  let best = 0;
  const d = (a: number, b: number) =>
    Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2]);
  for (let j = 0; j < f.nv; j++)
    for (let i = 0; i < f.nu; i++) {
      const k = j * f.nu + i;
      if (i + 1 < f.nu) best = Math.max(best, d(k, k + 1));
      if (j + 1 < f.nv) best = Math.max(best, d(k, k + f.nu));
    }
  return best;
}

/** Grid per face so that every face fits the read limit (SPEC-16.3 2): the asked grid, or less. */
export function gridFor(faceCount: number, asked?: number): number {
  if (faceCount < 1) throw failure('FACE_NOT_FOUND');
  if (faceCount > FACE_LIMIT) throw failure('FACE_LIMIT');
  if (asked !== undefined) {
    if (!Number.isInteger(asked) || asked < 2 || asked > MAX_GRID) throw failure('READ_GRID');
    if (faceCount * asked * asked > SAMPLE_LIMIT) throw failure('SAMPLE_LIMIT');
    return asked;
  }
  return Math.max(2, Math.min(DEFAULT_GRID, Math.floor(Math.sqrt(SAMPLE_LIMIT / faceCount))));
}
