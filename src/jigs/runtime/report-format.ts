// The report frame of a jig (`reports/<name>.json`, SPEC-07.11, ARCH-03 §5.2, PLAN-22 T-057).
// A frame declares the head (eyebrow, sentence headline, source line, KPI strip), numbered sections
// with claim titles and their blocks (table, compare bars, ledger, list), the assumptions and the
// items not checked. Claims are chosen, never written: each claim is a list of cases
// `{ when, template }` and the first case whose closed condition holds on the current result is
// used, its `{path}` holes filled with result values. `when` is `<path> <op> <path|number>` joined
// by `&&`, op one of `== != < <= > >=`; a case without `when` is the fallback. Paths are the panel
// bindings: `step.<id>.<field>…` (with `.length` of a list), `$<setting>`, `inputs.<key>…`.
//
// Gates (ARCH-03 §11): `claim-consistent` re-checks the chosen case's condition and that every
// number of the claim is one of the values the claim is bound to (its section's `from`, the paths
// of its condition and holes); `numbers-in-source` checks that every number of every claim is a
// value of the result or the settings; `unchecked-listed` checks that the items not checked are on
// the first page. An AI polish (optional, once) inherits its case: when it fails a gate the frame
// sentence comes back with '확인 필요'. Results of steps that are not final (preview) are marked,
// never written as final (SPEC-06.3). Pure (zod only): the engine, the server page and the panel
// share it.

import { z } from 'zod';

const WORD = '[A-Za-z_][A-Za-z0-9_-]*';
const PATH_SOURCE = `(?:step\\.${WORD}(?:\\.(?:${WORD}|\\d+))*|\\$${WORD}|inputs\\.${WORD}(?:\\.(?:${WORD}|\\d+))*)`;
/** A value path of a report (the panel binding grammar without `params`/`ledger.`). */
export const REPORT_PATH = new RegExp(`^${PATH_SOURCE}$`);
const OPS = ['==', '!=', '<=', '>=', '<', '>'] as const;
type Op = (typeof OPS)[number];
const TERM = `(?:${PATH_SOURCE}|-?\\d+(?:\\.\\d+)?)`;
const CONDITION = new RegExp(
  `^\\s*${PATH_SOURCE}\\s*(?:==|!=|<=|>=|<|>)\\s*${TERM}\\s*(?:&&\\s*${PATH_SOURCE}\\s*(?:==|!=|<=|>=|<|>)\\s*${TERM}\\s*)*$`,
);
const HOLE = /\{([^{}:]+)(?::(\d))?\}/g;

const path = z.string().regex(REPORT_PATH, '경로는 step.… · $설정값 · inputs.… 만');
const field = z.string().regex(new RegExp(`^${WORD}(?:\\.${WORD})*$`), '항목 이름');
const title = z.string().min(1).max(80);
const sentence = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (text) => [...text.matchAll(HOLE)].every((m) => REPORT_PATH.test(m[1].trim())),
    '틀의 {…}는 결과 경로만',
  );
const tone = z.enum(['ok', 'warn', 'ng', 'na']);
const claimCase = z
  .object({
    when: z
      .string()
      .regex(CONDITION, '조건은 <경로> <연산자> <경로|숫자>를 &&로 잇습니다')
      .optional(),
    template: sentence,
    tone: tone.optional(),
  })
  .strict();
const claim = z.object({ cases: z.array(claimCase).min(1).max(12) }).strict();
/** The headline is a sentence: every case ends with a period. */
const headlineClaim = claim.refine(
  (c) => c.cases.every((k) => /[.。]$/.test(k.template.trim())),
  '헤드라인은 마침표로 끝나는 문장입니다',
);
const column = z
  .object({
    field,
    label: title,
    unit: z.string().max(12).optional(),
    decimals: z.number().int().min(0).max(6).optional(),
  })
  .strict();
const block = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('table'),
      title: title.optional(),
      from: path,
      columns: z.array(column).min(1).max(12),
      max: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('compare-bars'),
      title: title.optional(),
      from: path,
      label: field,
      value: field,
      /** Row field naming the bar shade: base · alt · strong · actual · na. */
      shade: field.optional(),
      unit: z.string().max(12).optional(),
      decimals: z.number().int().min(0).max(6).optional(),
      limit: z.union([path, z.number()]).optional(),
      limitLabel: title.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ledger'),
      title: title.optional(),
      from: path,
      group: field.optional(),
      columns: z.array(column).min(1).max(12),
    })
    .strict(),
  z
    .object({
      kind: z.literal('list'),
      title: title.optional(),
      from: path,
      field: field.optional(),
    })
    .strict(),
]);

export const reportTemplateSchema = z
  .object({
    template: z.literal('study'),
    title,
    eyebrow: z.string().min(1).max(80).optional(),
    headline: headlineClaim,
    lede: claim.optional(),
    kpis: z
      .array(
        z
          .object({
            label: title,
            from: path,
            unit: z.string().max(12).optional(),
            decimals: z.number().int().min(0).max(6).optional(),
            note: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(6)
      .optional(),
    sections: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]*$/),
            /** What the section's claim is bound to (the values its numbers may come from). */
            from: z.array(path).min(1).max(12),
            title: claim,
            lede: claim.optional(),
            blocks: z.array(block).max(8).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    assumptions: z.union([path, z.array(z.string().min(1).max(200)).max(30)]).optional(),
    unchecked: z.union([path, z.array(z.string().min(1).max(200)).max(30)]),
    polish: z.enum(['none', 'ai-once']).optional(),
  })
  .strict();
export type ReportTemplate = z.infer<typeof reportTemplateSchema>;
export type ReportBlockSpec = z.infer<typeof block>;
export type ClaimSpec = z.infer<typeof claim>;

/** The values a report reads. `final[step] === false` marks a step whose result is a preview. */
export interface ReportContext {
  outputs: Record<string, unknown>;
  params: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  final?: Record<string, boolean>;
  /** For the source line: when the inputs were read, statements and setting grounds. */
  source?: {
    readAt?: string;
    statements?: { total: number; confirmed: number };
    params?: { total: number; grounded: number };
  };
}
export type ClaimTone = z.infer<typeof tone>;
export interface ClaimOut {
  id: string;
  text: string;
  tone?: ClaimTone;
  /** Index of the case used; -1 when no case held. */
  case: number;
  /** A polished sentence failed a gate and the frame sentence came back. */
  check?: '확인 필요';
  /** Bound to a step whose result is a preview, not final. */
  provisional?: boolean;
}
export interface ReportColumn {
  label: string;
  unit?: string;
  numeric: boolean;
}
export type BarShade = 'base' | 'alt' | 'strong' | 'actual' | 'na';
export type ReportBlock =
  | { kind: 'table'; title?: string; columns: ReportColumn[]; rows: string[][]; more: number }
  | {
      kind: 'compare-bars';
      title?: string;
      unit?: string;
      max: number;
      rows: { label: string; value: number | null; text: string; shade: BarShade }[];
      limit?: { value: number; text: string; label?: string };
    }
  | {
      kind: 'ledger';
      title?: string;
      groups: { name: string; count: number }[];
      columns: ReportColumn[];
      rows: { group: string; cells: string[] }[];
    }
  | { kind: 'list'; title?: string; items: string[] };
export interface ReportGate {
  id: 'claim-consistent' | 'numbers-in-source' | 'unchecked-listed';
  ok: boolean;
  /** Claim ids or a short reason when not ok. */
  failed: string[];
}
export interface ReportModel {
  title: string;
  eyebrow?: string;
  headline: ClaimOut;
  lede?: ClaimOut;
  source: string[];
  kpis: { label: string; value: string; unit?: string; note?: string; provisional?: boolean }[];
  sections: {
    no: string;
    id: string;
    title: ClaimOut;
    lede?: ClaimOut;
    blocks: ReportBlock[];
  }[];
  assumptions: string[];
  unchecked: string[];
  gates: ReportGate[];
  /** Steps whose results are previews; the page says so. */
  provisional: string[];
}

export interface ReportIssue {
  path: string;
  message: string;
}
/** Check a frame; `template` only when there are no issues. */
export function parseReportTemplate(raw: unknown): {
  template?: ReportTemplate;
  issues: ReportIssue[];
} {
  const parsed = reportTemplateSchema.safeParse(raw);
  if (parsed.success) return { template: parsed.data, issues: [] };
  return {
    issues: parsed.error.issues.map((issue) => ({
      path: ['report', ...issue.path.map(String)].join('.'),
      message:
        issue.code === 'unrecognized_keys'
          ? `목록에 없는 속성: ${issue.keys.join(', ')}`
          : issue.message,
    })),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function fieldOf(value: unknown, dotted: string): unknown {
  let current = value;
  for (const segment of dotted.split('.')) {
    if (Array.isArray(current))
      current =
        segment === 'length'
          ? current.length
          : /^\d+$/.test(segment)
            ? current[Number(segment)]
            : undefined;
    else if (isRecord(current)) current = current[segment];
    else return undefined;
  }
  return current;
}
/** The value a report path names. */
export function resolvePath(at: string, ctx: ReportContext): unknown {
  const p = at.trim();
  if (p.startsWith('$')) return ctx.params[p.slice(1)];
  const [head, name, ...rest] = p.split('.');
  const root =
    head === 'step' ? ctx.outputs[name] : head === 'inputs' ? ctx.inputs?.[name] : undefined;
  return rest.length ? fieldOf(root, rest.join('.')) : root;
}
const stepOfPath = (p: string) =>
  p.trim().startsWith('step.') ? p.trim().split('.')[1] : undefined;

function compare(left: unknown, op: Op, right: unknown): boolean {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  if (op === '==') return left === right;
  if (op === '!=') return left !== right;
  if (!finite(left) || !finite(right)) return false;
  return op === '<'
    ? left < right
    : op === '<='
      ? left <= right
      : op === '>'
        ? left > right
        : left >= right;
}
function term(text: string, ctx: ReportContext): unknown {
  const t = text.trim();
  return /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : resolvePath(t, ctx);
}
/** Whether a closed condition holds (a missing value makes it false). */
export function evaluateWhen(when: string, ctx: ReportContext): boolean {
  if (!CONDITION.test(when)) return false;
  return when.split('&&').every((part) => {
    const m = /^\s*(\S+?)\s*(==|!=|<=|>=|<|>)\s*(\S+)\s*$/.exec(part);
    return !!m && compare(term(m[1], ctx), m[2] as Op, term(m[3], ctx));
  });
}
const pathsOfWhen = (when?: string) =>
  when
    ? when
        .split('&&')
        .flatMap((part) => part.split(/==|!=|<=|>=|<|>/).map((t) => t.trim()))
        .filter((t) => REPORT_PATH.test(t))
    : [];
const pathsOfTemplate = (template: string) => [...template.matchAll(HOLE)].map((m) => m[1].trim());

/** Number text the report writes: fixed decimals, else up to 3, with thousands separators. */
export function formatValue(value: number, decimals?: number): string {
  const fixed =
    decimals !== undefined
      ? value.toFixed(decimals)
      : Number.isInteger(value)
        ? String(value)
        : String(Number(value.toFixed(3)));
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}
function valueText(value: unknown, decimals?: number): string {
  if (value === undefined || value === null || value === '') return '—';
  if (finite(value)) return formatValue(value, decimals);
  if (typeof value === 'boolean') return value ? '예' : '아니오';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `${formatValue(value.length)}개`;
  return '—';
}
/** Fill `{path}` / `{path:decimals}` holes with result values. */
export function fillTemplate(template: string, ctx: ReportContext): string {
  return template.replace(HOLE, (_, at: string, d?: string) =>
    valueText(resolvePath(at, ctx), d === undefined ? undefined : Number(d)),
  );
}

/** Numbers written in a sentence (ignoring ones glued to a letter, like C1 or A3). */
export function numbersIn(text: string): { text: string; value: number; decimals: number }[] {
  const out: { text: string; value: number; decimals: number }[] = [];
  for (const m of text.matchAll(
    /(?<![A-Za-z0-9_.,-])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![A-Za-z0-9_.,-])-?\d+(?:\.\d+)?/g,
  )) {
    const raw = m[0];
    const plain = raw.replaceAll(',', '');
    out.push({ text: raw, value: Number(plain), decimals: plain.split('.')[1]?.length ?? 0 });
  }
  return out;
}
/** Every number a value holds (leaves, and the length of every list). */
export function numbersOf(value: unknown, out: number[] = [], depth = 0): number[] {
  if (depth > 12) return out;
  if (finite(value)) out.push(value);
  else if (Array.isArray(value)) {
    out.push(value.length);
    for (const item of value) numbersOf(item, out, depth + 1);
  } else if (isRecord(value))
    for (const item of Object.values(value)) numbersOf(item, out, depth + 1);
  return out;
}
/** A written number matches a source value when that value rounds to it. */
const matches = (n: { value: number; decimals: number }, source: readonly number[]) => {
  const tolerance = 0.5 * 10 ** -n.decimals + 1e-9;
  return source.some(
    (v) =>
      Math.abs(v - n.value) <= tolerance || Math.abs(Math.abs(v) - Math.abs(n.value)) <= tolerance,
  );
};
/** The numbers of `text` that are not among `source`. */
export function unsourcedNumbers(text: string, source: readonly number[]): string[] {
  return numbersIn(text)
    .filter((n) => !matches(n, source))
    .map((n) => n.text);
}

interface ClaimRun {
  out: ClaimOut;
  spec: ClaimSpec;
  bound: string[];
}
function chooseClaim(
  id: string,
  spec: ClaimSpec,
  bound: readonly string[],
  ctx: ReportContext,
): ClaimRun {
  const index = spec.cases.findIndex((c) => (c.when ? evaluateWhen(c.when, ctx) : true));
  const used = spec.cases[index];
  const paths = used
    ? [...bound, ...pathsOfWhen(used.when), ...pathsOfTemplate(used.template)]
    : [...bound];
  const provisional = paths.some((p) => {
    const step = stepOfPath(p);
    return !!step && ctx.final?.[step] === false;
  });
  return {
    spec,
    bound: paths,
    out: {
      id,
      text: used ? fillTemplate(used.template, ctx) : '',
      tone: used?.tone,
      case: index,
      ...(provisional ? { provisional } : {}),
    },
  };
}
function claimGate(run: ClaimRun, ctx: ReportContext, all: readonly number[]) {
  const c = run.spec.cases[run.out.case];
  const holds = !!c && (!c.when || evaluateWhen(c.when, ctx));
  const bound = run.bound.flatMap((p) => numbersOf(resolvePath(p, ctx)));
  return {
    consistent: holds && unsourcedNumbers(run.out.text, bound).length === 0,
    sourced: unsourcedNumbers(run.out.text, all).length === 0,
  };
}

function columnsOut(columns: readonly z.infer<typeof column>[], rows: readonly unknown[]) {
  return columns.map((c) => ({
    label: c.label,
    ...(c.unit ? { unit: c.unit } : {}),
    numeric:
      rows.length > 0 &&
      rows.slice(0, 20).every((r) => finite(fieldOf(r, c.field)) || fieldOf(r, c.field) == null),
  }));
}
const rowsOf = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);
const SHADES: readonly BarShade[] = ['base', 'alt', 'strong', 'actual', 'na'];

/** A block's rows and texts from the result. */
export function resolveBlock(spec: ReportBlockSpec, ctx: ReportContext): ReportBlock {
  const value = resolvePath(spec.from, ctx);
  if (spec.kind === 'list') {
    const items = (Array.isArray(value) ? value : [])
      .map((item) => valueText(spec.field ? fieldOf(item, spec.field) : item))
      .filter((t) => t !== '—');
    return { kind: 'list', title: spec.title, items };
  }
  const rows = rowsOf(value);
  if (spec.kind === 'table') {
    const shown = rows.slice(0, spec.max ?? 200);
    return {
      kind: 'table',
      title: spec.title,
      columns: columnsOut(spec.columns, rows),
      rows: shown.map((r) => spec.columns.map((c) => valueText(fieldOf(r, c.field), c.decimals))),
      more: rows.length - shown.length,
    };
  }
  if (spec.kind === 'ledger') {
    const group = (r: Record<string, unknown>) =>
      spec.group ? valueText(fieldOf(r, spec.group)) : '전체';
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(group(r), (counts.get(group(r)) ?? 0) + 1);
    return {
      kind: 'ledger',
      title: spec.title,
      groups: [...counts].map(([name, count]) => ({ name, count })),
      columns: columnsOut(spec.columns, rows),
      rows: rows.map((r) => ({
        group: group(r),
        cells: spec.columns.map((c) => valueText(fieldOf(r, c.field), c.decimals)),
      })),
    };
  }
  const limitValue = typeof spec.limit === 'string' ? resolvePath(spec.limit, ctx) : spec.limit;
  const bars = rows.map((r) => {
    const v = fieldOf(r, spec.value);
    const shade = spec.shade ? fieldOf(r, spec.shade) : undefined;
    return {
      label: valueText(fieldOf(r, spec.label)),
      value: finite(v) ? v : null,
      text: valueText(v, spec.decimals),
      shade: (SHADES as readonly unknown[]).includes(shade)
        ? (shade as BarShade)
        : finite(v)
          ? 'base'
          : 'na',
    } as const;
  });
  const values = bars.flatMap((b) => (b.value === null ? [] : [b.value]));
  const limit = finite(limitValue)
    ? {
        value: limitValue,
        text: formatValue(limitValue, spec.decimals),
        ...(spec.limitLabel ? { label: spec.limitLabel } : {}),
      }
    : undefined;
  return {
    kind: 'compare-bars',
    title: spec.title,
    ...(spec.unit ? { unit: spec.unit } : {}),
    max: Math.max(0, ...values, limit?.value ?? 0) || 1,
    rows: bars,
    ...(limit ? { limit } : {}),
  };
}

function texts(
  value: string | readonly string[] | undefined,
  ctx: ReportContext,
): string[] | undefined {
  if (value === undefined) return [];
  if (Array.isArray(value)) return [...value];
  const resolved = resolvePath(value as string, ctx);
  if (!Array.isArray(resolved)) return undefined;
  return resolved
    .map((item) =>
      typeof item === 'string'
        ? item
        : isRecord(item)
          ? valueText(item.text ?? item.title ?? item.label)
          : valueText(item),
    )
    .filter((t) => t !== '—');
}

export interface ResolveOptions {
  /** AI-polished sentences by claim id (`headline`, `lede`, `<section>.title`, `<section>.lede`). */
  polished?: Record<string, string>;
}

/**
 * Resolve a frame on the current result: choose each claim's case, fill it, resolve the blocks,
 * and run the report gates. A polished sentence replaces a frame sentence only when it passes
 * both claim gates; otherwise the frame sentence stays with '확인 필요'.
 */
export function resolveReport(
  template: ReportTemplate,
  ctx: ReportContext,
  options: ResolveOptions = {},
): ReportModel {
  const all = [...numbersOf(ctx.outputs), ...numbersOf(ctx.params), ...numbersOf(ctx.inputs ?? {})];
  const headBound = (template.kpis ?? []).map((k) => k.from);
  const runs: ClaimRun[] = [];
  const run = (id: string, spec: ClaimSpec, bound: readonly string[]) => {
    const r = chooseClaim(id, spec, bound, ctx);
    const polished = options.polished?.[id];
    if (polished !== undefined && template.polish === 'ai-once' && r.out.case >= 0) {
      const candidate: ClaimRun = { ...r, out: { ...r.out, text: polished } };
      const g = claimGate(candidate, ctx, all);
      if (g.consistent && g.sourced) r.out = candidate.out;
      else r.out = { ...r.out, check: '확인 필요' };
    }
    runs.push(r);
    return r.out;
  };
  const allBound = template.sections.flatMap((s) => s.from);
  const headline = run('headline', template.headline, [...headBound, ...allBound]);
  const lede = template.lede ? run('lede', template.lede, [...headBound, ...allBound]) : undefined;
  const sections = template.sections.map((s, i) => ({
    no: String(i + 1).padStart(2, '0'),
    id: s.id,
    title: run(`${s.id}.title`, s.title, s.from),
    ...(s.lede ? { lede: run(`${s.id}.lede`, s.lede, s.from) } : {}),
    blocks: (s.blocks ?? []).map((b) => resolveBlock(b, ctx)),
  }));
  const kpis = (template.kpis ?? []).map((k) => {
    const value = resolvePath(k.from, ctx);
    const step = stepOfPath(k.from);
    return {
      label: k.label,
      value: valueText(value, k.decimals),
      ...(k.unit ? { unit: k.unit } : {}),
      ...(k.note ? { note: k.note } : {}),
      ...(step && ctx.final?.[step] === false ? { provisional: true } : {}),
    };
  });

  const inconsistent: string[] = [];
  const unsourced: string[] = [];
  for (const r of runs) {
    if (r.out.case < 0) {
      inconsistent.push(r.out.id);
      continue;
    }
    const g = claimGate(r, ctx, all);
    if (!g.consistent) inconsistent.push(r.out.id);
    if (!g.sourced) unsourced.push(r.out.id);
  }
  const unchecked = texts(template.unchecked, ctx);
  const assumptions = texts(template.assumptions, ctx) ?? [];
  const src = ctx.source;
  const source = [
    src?.readAt ? `입력 읽은 시각 ${src.readAt}` : '입력 읽은 시각 —',
    src?.statements
      ? `자료 진술 ${formatValue(src.statements.total)}건 (확정 ${formatValue(src.statements.confirmed)})`
      : undefined,
    src?.params
      ? `설정값 ${formatValue(src.params.total)}개 중 근거 있음 ${formatValue(src.params.grounded)}`
      : undefined,
  ].filter((t): t is string => !!t);
  const provisional = Object.entries(ctx.final ?? {})
    .filter(([, final]) => final === false)
    .map(([step]) => step);
  return {
    title: template.title,
    ...(template.eyebrow ? { eyebrow: template.eyebrow } : {}),
    headline,
    ...(lede ? { lede } : {}),
    source,
    kpis,
    sections,
    assumptions,
    unchecked: unchecked ?? [],
    gates: [
      { id: 'claim-consistent', ok: inconsistent.length === 0, failed: inconsistent },
      { id: 'numbers-in-source', ok: unsourced.length === 0, failed: unsourced },
      {
        id: 'unchecked-listed',
        ok: unchecked !== undefined,
        failed: unchecked === undefined ? ['검토하지 않은 항목 목록을 읽지 못했습니다'] : [],
      },
    ],
    provisional,
  };
}

/** A headline is a sentence: it ends with a period (the frame's own rule, Design SCR-17). */
export const endsAsSentence = (text: string) => /[.。]$/.test(text.trim());
