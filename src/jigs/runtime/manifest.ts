// `jig.json` v3 (ARCH-03 §3, SPEC-07.2·07.15): the one authoritative file of a jig. This module
// holds the zod schema (strict: unknown fields are rejected) and the checks that go beyond the
// schema — unique keys, references between inputs, settings and steps, an acyclic step order,
// gate names and timings, the closed capability vocabulary, setting units, forbidden files and the
// derived values the core recomputes. Files on disk are the loader's job; the validator takes the
// file list it found.

import { z } from 'zod';
import { GATES, isGateName, type GateLevel, type GateName } from './gates.ts';
import { buildGraph, parseRead } from './graph.ts';
import { JIG_ICONS } from '../../contracts/jig-icons.ts';

export const CONTRACT_VERSION = 3;
export const JIG_ID = /^(vide|project)\/[a-z0-9]+(-[a-z0-9]+)*$/;
export const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** A path inside the package: relative, posix, no `..`, no leading slash or drive letter. */
export const PACKAGE_PATH = /^(?!\.\.?(\/|$))(?!\/)(?![A-Za-z]:)[^\\]*(?<!\/\.\.)(?<!\/\.)$/;
const packagePath = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => PACKAGE_PATH.test(p) && !p.split('/').includes('..'), '패키지 안의 상대 경로만');
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);

export const CAPABILITIES = [
  'links.list',
  'sync.read',
  'facts.read',
  'jig.read',
  'library.call',
  'host.bake',
  'ai.once',
  'ai.tools',
  'export.file',
] as const;
/** Official-only capabilities: accepted for `vide/*` ids only. */
export const OFFICIAL_CAPABILITIES = ['process.exec', 'host.script', 'net.fetch'] as const;
/**
 * External domain services (ADR-040, ARCH-01 「jig 능력」): only official built-in jigs (`vide/*`
 * from the program itself) may declare one; the engine hands them the service's read results.
 * Sending back to a service is never a jig capability.
 */
export const SERVICE_CAPABILITIES = ['service.clawde'] as const;
/** Reserved for later decisions (B14, C2): always rejected. */
export const RESERVED_CAPABILITIES = ['host.ops', 'publish.site'] as const;
export type Capability =
  | (typeof CAPABILITIES)[number]
  | (typeof OFFICIAL_CAPABILITIES)[number]
  | (typeof SERVICE_CAPABILITIES)[number];

export const PARAM_TYPES = [
  'length',
  'area',
  'force',
  'lineLoad',
  'areaLoad',
  'angle',
  'ratio',
  'count',
  'level',
  'choice',
  'toggle',
] as const;
export type ParamType = (typeof PARAM_TYPES)[number];
/** Units a setting type may declare (storage is SI; the first is the storage unit). */
export const UNITS_BY_TYPE: Record<ParamType, readonly string[]> = {
  length: ['m', 'mm'],
  area: ['m2', 'mm2'],
  force: ['kN', 'N'],
  lineLoad: ['kN/m'],
  areaLoad: ['kN/m2'],
  angle: ['deg'],
  ratio: ['', '%'],
  count: ['EA'],
  level: ['EL', 'm'],
  choice: [],
  toggle: [],
};

const gateUse = z
  .object({
    use: z.string(),
    level: z.enum(['block', 'warn', 'isolate']).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type GateUse = { use: GateName; level?: GateLevel; args?: Record<string, unknown> };

const roleDecl = z
  .object({
    role: key,
    title: z.string().min(1).max(200),
    shape: z.enum(['polygon', 'polyline', 'footprint', 'band', 'line', 'point', 'level', 'label']),
    many: z.boolean(),
    required: z.boolean(),
    hints: z
      .object({
        layers: z.array(z.string().min(1).max(200)).max(20).optional(),
        words: z.array(z.string().min(1).max(50)).max(20).optional(),
        blockSize_m: z.tuple([z.number().positive(), z.number().positive()]).optional(),
      })
      .strict(),
    /** Code extractor: `rows` (the layer rows as read) or `vide/<library>#<function>`. */
    extract: z.string().regex(/^(rows|vide\/[a-z0-9-]+#[A-Za-z_][A-Za-z0-9_]*)$/),
  })
  .strict();
export type RoleDecl = z.infer<typeof roleDecl>;

const inputBase = { key, title: z.string().min(1).max(200) };
const inputDecl = z.discriminatedUnion('kind', [
  z
    .object({
      ...inputBase,
      kind: z.literal('sync-layers'),
      host: z.enum(['rhino', 'zwcad']),
      match: z.array(z.string().min(1).max(200)).min(1).max(20),
      geometry: z.enum(['curves', 'points', 'breps', 'blocks', 'text', 'any']),
      includeHidden: z.boolean().optional(),
      pin: z.enum(['live', 'snapshot']).optional(),
      required: z.boolean(),
    })
    .strict(),
  z
    .object({ ...inputBase, kind: z.literal('assembly'), roles: z.array(roleDecl).min(1).max(20) })
    .strict(),
  z
    .object({
      ...inputBase,
      kind: z.literal('facts'),
      query: z
        .object({
          discipline: z.array(z.string()).optional(),
          kinds: z.array(z.string()).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...inputBase,
      kind: z.literal('zone'),
      shape: z.enum(['polygon', 'line']),
      meaning: z.string().min(1).max(300),
      required: z.boolean(),
    })
    .strict(),
  z
    .object({ ...inputBase, kind: z.literal('table-file'), accept: z.array(z.string()).min(1) })
    .strict(),
  z
    .object({
      ...inputBase,
      kind: z.literal('jig-output'),
      from: z.object({ jig: z.string().regex(JIG_ID), output: key }).strict(),
    })
    .strict(),
]);
export type InputDecl = z.infer<typeof inputDecl>;

const paramDecl = z
  .object({
    key,
    title: z.string().min(1).max(200),
    help: z.string().max(1000).optional(),
    group: z.string().min(1).max(100),
    type: z.enum(PARAM_TYPES),
    unit: z.string().max(10).optional(),
    display: z
      .object({ unit: z.string().max(10), decimals: z.number().int().min(0).max(6) })
      .strict()
      .optional(),
    default: z.union([z.number(), z.string(), z.boolean()]),
    range: z
      .object({ min: z.number(), max: z.number(), step: z.number().positive() })
      .strict()
      .optional(),
    bands: z
      .array(
        z
          .object({
            from: z.number(),
            to: z.number(),
            tone: z.enum(['ok', 'warn', 'no']),
            label: z.string().max(100),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    choices: z
      .array(
        z
          .object({
            value: z.string().min(1).max(100),
            label: z.string().max(200),
            consequence: z.string().max(300).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .optional(),
    words: z
      .object({
        more: z.array(z.string()).max(20),
        less: z.array(z.string()).max(20),
        sign: z.union([z.literal(1), z.literal(-1)]),
      })
      .strict()
      .optional(),
    basis: z
      .object({
        factRefs: z.array(z.string()).optional(),
        note: z.string().max(500).optional(),
        status: z.enum(['confirmed', 'assumed', 'chosen', 'to-ask']),
        question: z.string().max(300).optional(),
      })
      .strict()
      .optional(),
    affects: z.array(key).max(50),
    board: z.boolean().optional(),
    fixedAtPin: z.boolean().optional(),
  })
  .strict();
export type ParamDecl = z.infer<typeof paramDecl>;

const stepBase = {
  id: key,
  title: z.string().min(1).max(200),
  needs: z.array(key).max(50).optional(),
  reads: z.array(z.string().min(1).max(200)).max(100),
  writes: key,
  speed: z.enum(['live', 'release', 'button', 'confirm']),
  gates: z.array(gateUse).max(30).optional(),
  budget: z
    .object({ wallClockMs: z.number().int().positive().max(600_000) })
    .strict()
    .optional(),
};
export const HUMAN_SLOTS = ['confirm-inputs', 'confirm-analysis', 'draw-zone'] as const;
const stepDecl = z.discriminatedUnion('kind', [
  z
    .object({
      ...stepBase,
      kind: z.literal('code'),
      entry: z.string().regex(/^steps\/[A-Za-z0-9_./-]+\.ts#[A-Za-z_][A-Za-z0-9_]*$/),
    })
    .strict(),
  z
    .object({
      ...stepBase,
      kind: z.literal('library'),
      use: z.string().regex(/^vide\/[a-z0-9-]+#[A-Za-z_][A-Za-z0-9_]*$/),
      args: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z.object({ ...stepBase, kind: z.literal('host'), bake: z.array(key).min(1) }).strict(),
  z
    .object({
      ...stepBase,
      kind: z.literal('ai'),
      prompt: packagePath,
      tools: z.array(z.string()).max(10).optional(),
      authority: z.literal('draft-only'),
    })
    .strict(),
  z
    .object({
      ...stepBase,
      kind: z.literal('human'),
      slot: z.enum(HUMAN_SLOTS),
      blocks: z.array(key).max(50),
    })
    .strict(),
]);
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type StepDecl = DistributiveOmit<z.infer<typeof stepDecl>, 'gates'> & { gates?: GateUse[] };
export type StepKind = StepDecl['kind'];

const bakeDecl = z
  .object({
    id: key,
    template: z.enum([
      'vide.bake.curves@1',
      'vide.bake.sweep-h@1',
      'vide.bake.extrude-column@1',
      'vide.bake.textdot@1',
      'vide.bake.extrude-polygon@1',
      'vide.bake.brep-faces@1',
      'vide.bake.mesh@1',
    ]),
    host: z.literal('rhino'),
    items: z.string().min(1).max(200),
    layer: z
      .string()
      .min(1)
      .max(100)
      .refine((v) => !v.includes('::'), '한 단계 이름만'),
    key: z.string().min(1).max(100),
    map: z.record(z.string(), z.string()).optional(),
    attrs: z.record(z.string(), z.string()).optional(),
    mode: z.literal('replace-own'),
    requires: z.array(z.string()).max(10).optional(),
  })
  .strict();
export type BakeDecl = Omit<z.infer<typeof bakeDecl>, 'requires'> & { requires?: GateName[] };

export type StepRuntime = 'engine' | 'child' | 'box' | 'bake' | 'cli' | 'screen';
export type JigSource = 'builtin' | 'dev-source' | 'dev-pack' | 'ai-draft';

export const manifestSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    id: z.string().regex(JIG_ID),
    version: z.string().regex(SEMVER),
    kind: z.enum(['tool', 'library']),
    name: z.string().min(1).max(100),
    summary: z.string().min(1).max(300),
    /** How the jig looks in the lists: a name from VIDE's fixed icon list (PLAN-26 T-100). */
    icon: z.enum(JIG_ICONS).optional(),
    hosts: z
      .object({
        rhino: z.enum(['required', 'optional']).optional(),
        zwcad: z.enum(['required', 'optional']).optional(),
      })
      .strict()
      .optional(),
    uses: z
      .array(
        z
          .object({ id: z.string().regex(/^vide\/[a-z0-9-]+$/), range: z.string().min(1).max(50) })
          .strict(),
      )
      .max(10)
      .optional(),
    inputs: z.array(inputDecl).max(30),
    params: z.array(paramDecl).max(100),
    steps: z.array(stepDecl).min(1).max(50),
    outputs: z
      .array(z.object({ key, from: z.string().min(1), schema: packagePath }).strict())
      .max(20)
      .optional(),
    panel: packagePath.optional(),
    reports: z
      .array(z.object({ id: key, file: packagePath, title: z.string().min(1).max(200) }).strict())
      .max(10)
      .optional(),
    bake: z.array(bakeDecl).max(20).optional(),
    capabilities: z
      .array(
        z
          .object({
            name: z.string().min(1).max(40),
            scope: z.string().max(200).optional(),
            reason: z.string().min(1).max(300),
          })
          .strict(),
      )
      .max(20),
    selftest: z.object({ fixtures: packagePath, requiresHost: z.literal(false) }).strict(),
    skill: packagePath,
    // jig = skill (RESEARCH-12 §6.3): how a request opens and runs the jig; all optional.
    /**
     * `reuse: last` opens the project's latest instance. `layerRoot`: the output layer offered
     * first when a request-opened instance asks for one at Rhino에 만들기 (ADR-026).
     */
    open: z
      .object({
        reuse: z.enum(['last', 'new']).optional(),
        layerRoot: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
    /** Settings a starting request may set ("구조 분석 해줘, 경간 11로"). */
    from_request: z.array(key).max(30).optional(),
    /** Run until this step, or `first-hard` (the first human step that blocks others; default). */
    autorun: z
      .object({ until: z.union([z.literal('first-hard'), key]) })
      .strict()
      .optional(),
    /** Values the core recomputes (ARCH-03 §3); when declared they must match. */
    derived: z
      .object({
        ai: z
          .object({ required: z.boolean(), steps: z.array(key) })
          .strict()
          .optional(),
        runtimes: z
          .record(z.string(), z.enum(['engine', 'child', 'box', 'bake', 'cli', 'screen']))
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type JigManifest = Omit<
  z.infer<typeof manifestSchema>,
  'steps' | 'bake' | 'capabilities'
> & {
  steps: StepDecl[];
  bake?: BakeDecl[];
  capabilities: { name: Capability; scope?: string; reason: string }[];
};

export interface ManifestIssue {
  code:
    | 'JIG_SCHEMA'
    | 'JIG_DUPLICATE'
    | 'JIG_REF_MISSING'
    | 'JIG_CYCLE'
    | 'JIG_GATE_UNKNOWN'
    | 'JIG_GATE_TIMING'
    | 'JIG_GATE_PENDING'
    | 'JIG_AI_GATE_REQUIRED'
    | 'JIG_CAPABILITY'
    | 'JIG_CAPABILITY_MISSING'
    | 'JIG_PARAM'
    | 'JIG_FILE_MISSING'
    | 'JIG_FORBIDDEN_FILE'
    | 'JIG_DERIVED_MISMATCH'
    | 'JIG_LIBRARY_UNKNOWN'
    | 'JIG_PANEL';
  path: string;
  message: string;
  /** Warnings do not fail validation. */
  level: 'error' | 'warn';
}

export interface DerivedValues {
  ai: { required: boolean; steps: string[] };
  runtimes: Record<string, StepRuntime>;
}

/** Files that make a package an agent instruction set; their presence fails validation and import. */
export const FORBIDDEN_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.claude/',
  '.mcp.json',
  '.codex/',
] as const;
export function forbiddenFiles(files: readonly string[]): string[] {
  return files.filter((file) => {
    const parts = file.split('/');
    return FORBIDDEN_FILES.some((rule) =>
      rule.endsWith('/') ? parts.slice(0, -1).includes(rule.slice(0, -1)) : parts.at(-1) === rule,
    );
  });
}

/** Where each step kind runs for a source (ARCH-03 §6.1). */
export function runtimeFor(kind: StepKind, source: JigSource): StepRuntime {
  if (kind === 'code')
    return source === 'builtin' ? 'engine' : source === 'ai-draft' ? 'box' : 'child';
  if (kind === 'library') return 'engine';
  if (kind === 'host') return 'bake';
  if (kind === 'ai') return 'cli';
  return 'screen';
}
export function deriveValues(manifest: JigManifest, source: JigSource): DerivedValues {
  const aiSteps = manifest.steps.filter((s) => s.kind === 'ai').map((s) => s.id);
  return {
    ai: { required: aiSteps.length > 0, steps: aiSteps },
    runtimes: Object.fromEntries(manifest.steps.map((s) => [s.id, runtimeFor(s.kind, source)])),
  };
}

export interface ValidateOptions {
  /** Relative posix paths of the package files, when known. */
  files?: readonly string[];
  source?: JigSource;
  /** Official libraries and their versions, for `uses` and `library` steps. */
  libraries?: Record<string, { version: string; functions?: readonly string[] }>;
}

/** Minimal semver range check: `*`, exact, `^x.y.z`, `~x.y.z`, `>=x.y.z`, `>=a <b`. */
export function satisfies(version: string, range: string): boolean {
  const v = version.split('-')[0].split('.').map(Number);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  const parse = (text: string) =>
    text
      .replace(/^[^\d]*/, '')
      .split('.')
      .map(Number);
  return range
    .trim()
    .split(/\s*\|\|\s*/)
    .some((alternative) =>
      alternative
        .trim()
        .split(/\s+/)
        .every((part) => {
          if (part === '*' || part === '') return true;
          const target = parse(part);
          if (part.startsWith('^')) {
            const upper =
              target[0] > 0
                ? [target[0] + 1, 0, 0]
                : target[1] > 0
                  ? [0, target[1] + 1, 0]
                  : [0, 0, target[2] + 1];
            return cmp(v, target) >= 0 && cmp(v, upper) < 0;
          }
          if (part.startsWith('~'))
            return cmp(v, target) >= 0 && cmp(v, [target[0], target[1] + 1, 0]) < 0;
          if (part.startsWith('>=')) return cmp(v, target) >= 0;
          if (part.startsWith('>')) return cmp(v, target) > 0;
          if (part.startsWith('<=')) return cmp(v, target) <= 0;
          if (part.startsWith('<')) return cmp(v, target) < 0;
          return cmp(v, target) === 0;
        }),
    );
}

/** Validate a parsed `jig.json`; `manifest` is set only when there is no error. */
export function validateManifest(
  raw: unknown,
  options: ValidateOptions = {},
): { manifest?: JigManifest; derived?: DerivedValues; issues: ManifestIssue[] } {
  const issues: ManifestIssue[] = [];
  const error = (code: ManifestIssue['code'], path: string, message: string) =>
    issues.push({ code, path, message, level: 'error' });
  const warn = (code: ManifestIssue['code'], path: string, message: string) =>
    issues.push({ code, path, message, level: 'warn' });
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 30))
      error('JIG_SCHEMA', issue.path.map(String).join('.') || '(root)', issue.message);
    return { issues };
  }
  const manifest = parsed.data as unknown as JigManifest;
  const source = options.source ?? 'dev-source';
  const official = manifest.id.startsWith('vide/');
  const files = options.files;
  const fileSet = files ? new Set(files) : undefined;

  const unique = (items: readonly string[], path: string) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item)) error('JIG_DUPLICATE', path, `겹치는 이름: ${item}`);
      seen.add(item);
    }
  };
  unique(
    manifest.inputs.map((i) => i.key),
    'inputs',
  );
  unique(
    manifest.params.map((p) => p.key),
    'params',
  );
  unique(
    manifest.steps.map((s) => s.id),
    'steps',
  );
  unique(
    manifest.steps.map((s) => s.writes),
    'steps.writes',
  );
  unique(
    (manifest.bake ?? []).map((b) => b.id),
    'bake',
  );
  const inputs = new Map(manifest.inputs.map((i) => [i.key, i]));
  const params = new Map(manifest.params.map((p) => [p.key, p]));
  const stepIds = new Set(manifest.steps.map((s) => s.id));
  for (const input of manifest.inputs)
    if (input.kind === 'assembly')
      unique(
        input.roles.map((r) => r.role),
        `inputs.${input.key}.roles`,
      );

  // Settings: unit by type, range, default and choices.
  for (const decl of manifest.params) {
    const path = `params.${decl.key}`;
    const allowed = UNITS_BY_TYPE[decl.type];
    if (decl.unit !== undefined && !allowed.includes(decl.unit))
      error('JIG_PARAM', path, `${decl.type}에 쓸 수 없는 단위: ${decl.unit}`);
    if (decl.display && !allowed.includes(decl.display.unit) && decl.type !== 'ratio')
      error('JIG_PARAM', path, `${decl.type}에 쓸 수 없는 표시 단위: ${decl.display.unit}`);
    if (decl.type === 'choice') {
      if (!decl.choices?.length) error('JIG_PARAM', path, 'choice에는 choices가 필요합니다');
      else if (
        typeof decl.default !== 'string' ||
        !decl.choices.some((c) => c.value === decl.default)
      )
        error('JIG_PARAM', path, '기본값이 choices에 없습니다');
    } else if (decl.type === 'toggle') {
      if (typeof decl.default !== 'boolean')
        error('JIG_PARAM', path, 'toggle의 기본값은 참·거짓입니다');
    } else {
      if (typeof decl.default !== 'number' || !Number.isFinite(decl.default))
        error('JIG_PARAM', path, '숫자 기본값이 필요합니다');
      if (
        decl.type === 'count' &&
        typeof decl.default === 'number' &&
        !Number.isInteger(decl.default)
      )
        error('JIG_PARAM', path, 'count의 기본값은 정수입니다');
      if (decl.range) {
        if (decl.range.min >= decl.range.max) error('JIG_PARAM', path, '범위는 min < max');
        else if (
          typeof decl.default === 'number' &&
          (decl.default < decl.range.min || decl.default > decl.range.max)
        )
          error('JIG_PARAM', path, '기본값이 범위 밖입니다');
      }
      if (decl.choices) error('JIG_PARAM', path, 'choice가 아닌데 choices가 있습니다');
    }
    for (const id of decl.affects)
      if (!stepIds.has(id)) error('JIG_REF_MISSING', `${path}.affects`, `없는 단계: ${id}`);
  }

  // Steps: reads, needs, gates, kind-specific rules.
  const gateTimings = {
    code: ['before-run', 'after-run'],
    library: ['before-run', 'after-run'],
    host: ['before-run', 'before-bake'],
    ai: ['before-run', 'after-ai'],
    human: ['before-run'],
  } as const;
  for (const step of manifest.steps) {
    const path = `steps.${step.id}`;
    for (const text of step.reads) {
      const read = parseRead(text);
      if (!read) error('JIG_REF_MISSING', `${path}.reads`, `읽기 선언 형식 오류: ${text}`);
      else if (read.kind === 'param' && !params.has(read.key))
        error('JIG_REF_MISSING', `${path}.reads`, `없는 설정값: ${text}`);
      else if (read.kind === 'step' && !stepIds.has(read.id))
        error('JIG_REF_MISSING', `${path}.reads`, `없는 단계: ${text}`);
      else if (read.kind === 'input') {
        const input = inputs.get(read.key);
        if (!input) error('JIG_REF_MISSING', `${path}.reads`, `없는 입력: ${text}`);
        else if (read.role !== undefined) {
          if (input.kind !== 'assembly' || !input.roles.some((r) => r.role === read.role))
            error('JIG_REF_MISSING', `${path}.reads`, `없는 입력 역할: ${text}`);
        }
      }
    }
    for (const id of step.needs ?? [])
      if (!stepIds.has(id)) error('JIG_REF_MISSING', `${path}.needs`, `없는 단계: ${id}`);
    for (const gate of step.gates ?? []) {
      if (!isGateName(gate.use)) {
        error('JIG_GATE_UNKNOWN', `${path}.gates`, `없는 점검: ${gate.use}`);
        continue;
      }
      const spec = GATES[gate.use];
      if (!(gateTimings[step.kind] as readonly string[]).includes(spec.timing))
        error(
          'JIG_GATE_TIMING',
          `${path}.gates`,
          `${step.kind} 단계에 쓸 수 없는 시점(${spec.timing}): ${gate.use}`,
        );
      if (!spec.implemented)
        warn(
          'JIG_GATE_PENDING',
          `${path}.gates`,
          `아직 구현되지 않은 점검(막음으로 처리): ${gate.use}`,
        );
    }
    if (
      step.kind === 'ai' &&
      !(step.gates ?? []).some((g) => isGateName(g.use) && GATES[g.use].timing === 'after-ai')
    )
      error('JIG_AI_GATE_REQUIRED', path, 'AI 단계에는 AI 뒤 점검이 하나 이상 필요합니다');
    if (step.kind === 'code' && fileSet && !fileSet.has(step.entry.split('#')[0]))
      error('JIG_FILE_MISSING', `${path}.entry`, `없는 파일: ${step.entry.split('#')[0]}`);
    if (step.kind === 'ai' && fileSet && !fileSet.has(step.prompt))
      error('JIG_FILE_MISSING', `${path}.prompt`, `없는 파일: ${step.prompt}`);
    if (step.kind === 'human')
      for (const id of step.blocks)
        if (!stepIds.has(id)) error('JIG_REF_MISSING', `${path}.blocks`, `없는 단계: ${id}`);
    if (step.kind === 'host')
      for (const id of step.bake)
        if (!(manifest.bake ?? []).some((b) => b.id === id))
          error('JIG_REF_MISSING', `${path}.bake`, `없는 만들기 선언: ${id}`);
    if (step.kind === 'library' && options.libraries) {
      const [id, fn] = step.use.split('#');
      const library = options.libraries[id];
      if (!library) error('JIG_LIBRARY_UNKNOWN', `${path}.use`, `없는 공식 라이브러리: ${id}`);
      else if (library.functions && !library.functions.includes(fn))
        error('JIG_LIBRARY_UNKNOWN', `${path}.use`, `${id}에 없는 함수: ${fn}`);
    }
  }
  // The opening fields name existing settings and steps.
  for (const key of manifest.from_request ?? [])
    if (!params.has(key)) error('JIG_REF_MISSING', 'from_request', `없는 설정값: ${key}`);
  const until = manifest.autorun?.until;
  if (until && until !== 'first-hard' && !stepIds.has(until))
    error('JIG_REF_MISSING', 'autorun.until', `없는 단계: ${until}`);
  const { cycle } = buildGraph(manifest);
  if (cycle.length) error('JIG_CYCLE', 'steps', `단계가 순환합니다: ${cycle.join(' → ')}`);

  // Bake declarations and their gates.
  for (const bake of manifest.bake ?? []) {
    for (const name of bake.requires ?? [])
      if (!isGateName(name) || GATES[name].timing !== 'before-bake')
        error('JIG_GATE_UNKNOWN', `bake.${bake.id}.requires`, `만들기 전 점검이 아닙니다: ${name}`);
  }

  // Capabilities: closed vocabulary, official-only names, and what the declarations need.
  const declared = new Set(manifest.capabilities.map((c) => c.name));
  for (const capability of manifest.capabilities) {
    const name = capability.name as string;
    if ((RESERVED_CAPABILITIES as readonly string[]).includes(name))
      error('JIG_CAPABILITY', 'capabilities', `예약된 능력(아직 결정 전): ${name}`);
    else if ((OFFICIAL_CAPABILITIES as readonly string[]).includes(name)) {
      if (!official)
        error('JIG_CAPABILITY', 'capabilities', `공식 jig만 선언할 수 있는 능력: ${name}`);
    } else if ((SERVICE_CAPABILITIES as readonly string[]).includes(name)) {
      if (!official || source !== 'builtin')
        error(
          'JIG_CAPABILITY',
          'capabilities',
          `공식 내장 jig만 선언할 수 있는 서비스 능력: ${name}`,
        );
    } else if (!(CAPABILITIES as readonly string[]).includes(name))
      error('JIG_CAPABILITY', 'capabilities', `목록에 없는 능력: ${name}`);
  }
  const need = (name: Capability, why: string) => {
    if (!declared.has(name))
      error('JIG_CAPABILITY_MISSING', 'capabilities', `${why}에는 ${name} 선언이 필요합니다`);
  };
  for (const input of manifest.inputs) {
    if (input.kind === 'sync-layers' || input.kind === 'assembly')
      need('sync.read', `입력 ${input.key}`);
    if (input.kind === 'facts') need('facts.read', `입력 ${input.key}`);
    if (input.kind === 'jig-output') need('jig.read', `입력 ${input.key}`);
  }
  for (const step of manifest.steps) {
    if (step.kind === 'library') need('library.call', `단계 ${step.id}`);
    if (step.kind === 'host') need('host.bake', `단계 ${step.id}`);
    if (step.kind === 'ai') need(step.tools?.length ? 'ai.tools' : 'ai.once', `단계 ${step.id}`);
  }
  if (manifest.bake?.length) {
    need('host.bake', '만들기 선언');
    if (manifest.hosts?.rhino === undefined)
      error('JIG_CAPABILITY_MISSING', 'hosts', '만들기 선언에는 hosts.rhino가 필요합니다');
  }
  if (manifest.kind === 'library' && !official)
    error('JIG_CAPABILITY', 'kind', '라이브러리 jig는 공식(vide/*)만 만듭니다');
  if (manifest.kind === 'tool' && !manifest.panel)
    error('JIG_FILE_MISSING', 'panel', '작업 jig에는 panel.json이 필요합니다');

  // Libraries the jig uses.
  for (const use of manifest.uses ?? []) {
    const library = options.libraries?.[use.id];
    if (options.libraries && !library)
      error('JIG_LIBRARY_UNKNOWN', 'uses', `없는 공식 라이브러리: ${use.id}`);
    else if (library && !satisfies(library.version, use.range))
      error(
        'JIG_LIBRARY_UNKNOWN',
        'uses',
        `${use.id} ${library.version}은 범위 ${use.range} 밖입니다`,
      );
  }

  // Files: declared ones exist, forbidden ones do not.
  if (fileSet) {
    const declaredFiles = [
      manifest.skill,
      manifest.panel,
      ...(manifest.reports ?? []).map((r) => r.file),
      ...(manifest.outputs ?? []).map((o) => o.schema),
    ];
    for (const file of declaredFiles)
      if (file && !fileSet.has(file))
        error('JIG_FILE_MISSING', 'files', `선언한 파일이 없습니다: ${file}`);
    if (
      ![...fileSet].some((f) => f.startsWith(manifest.selftest.fixtures.replace(/\/$/, '') + '/'))
    )
      error(
        'JIG_FILE_MISSING',
        'selftest.fixtures',
        `자체 시험 자료가 없습니다: ${manifest.selftest.fixtures}`,
      );
    for (const file of forbiddenFiles([...fileSet]))
      error('JIG_FORBIDDEN_FILE', 'files', `금지 파일: ${file}`);
  }

  // Derived values: recomputed here; a declaration that differs is rejected.
  const derived = deriveValues(manifest, source);
  if (manifest.derived?.ai) {
    const declaredAi = manifest.derived.ai;
    if (
      declaredAi.required !== derived.ai.required ||
      declaredAi.steps.join() !== derived.ai.steps.join()
    )
      error(
        'JIG_DERIVED_MISMATCH',
        'derived.ai',
        `다시 계산한 값과 다릅니다: ${JSON.stringify(derived.ai)}`,
      );
  }
  if (manifest.derived?.runtimes) {
    for (const [id, runtime] of Object.entries(manifest.derived.runtimes))
      if (derived.runtimes[id] !== runtime)
        error(
          'JIG_DERIVED_MISMATCH',
          `derived.runtimes.${id}`,
          `다시 계산한 값(${derived.runtimes[id] ?? '없음'})과 다릅니다`,
        );
  }
  return issues.some((i) => i.level === 'error') ? { issues } : { manifest, derived, issues };
}
