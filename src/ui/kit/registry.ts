// The official parts of declarative jig screens (Design §14 부품 목록, SPEC-07.10, ARCH-03 §5.1).
// A `panel.json` may use only these parts, only in their places, only with these properties.
// Values are words, numbers, token names or bindings — a step output path (`step.<id>.<field>…`),
// a setting (`$<key>`), `params`, `inputs.<key>…` or `ledger.<name>`; never code, never a colour.
// Parts in `NOT_READY` are listed in Design but not built yet, so a panel that uses them is refused
// (보고서·원장·비교 막대 came with the report frame, PLAN-22 T-057).
// This module is pure (zod only) so the engine and tests can check a panel without React.

import { z } from 'zod';

/** Every part name of the Design list, in its order. */
export const PART_NAMES = [
  'step-rail',
  'param-group',
  'slider',
  'choice',
  'stepper',
  'toggle',
  'slider-board',
  'fact-badge',
  'role-card',
  'kpi-strip',
  'verdict-legend',
  'viewport-overlay',
  'plan-map',
  'issue-table',
  'table',
  'schedule',
  'result-tabs',
  'compare-bars',
  'bake-card',
  'conflict-banner',
  'report',
  'ledger',
  'site-picker',
  'jig-source',
] as const;
export type PartName = (typeof PART_NAMES)[number];

/** Colour token names a panel may use (Design §02); anything else is refused. */
export const TONES = [
  'ov-grid',
  'ov-new',
  'ov-existing',
  'ov-clash',
  'ok',
  'warn',
  'ng',
  'na',
] as const;
export type Tone = (typeof TONES)[number];

const WORD = '[A-Za-z_][A-Za-z0-9_-]*';
/** The binding grammar of ARCH-03 §5.1. */
export const BINDING = new RegExp(
  `^(?:step\\.${WORD}(?:\\.(?:${WORD}|\\d+))*|\\$${WORD}|params|inputs\\.${WORD}(?:\\.${WORD})*|ledger\\.${WORD})$`,
);
export const SETTING = new RegExp(`^\\$${WORD}$`);
/** A field path inside one row (`at`, `site.polygon`). */
export const FIELD = new RegExp(`^${WORD}(?:\\.${WORD})*$`);

const text = z.string().min(1).max(200);
const title = z.string().min(1).max(80);
const binding = z.string().regex(BINDING, '연결은 step.… · $설정값 · params · inputs.… 만');
const setting = z.string().regex(SETTING, '설정값은 $이름');
const field = z.string().regex(FIELD, '항목 이름');
const layerKey = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(40);
const tone = z.enum(TONES);
/** Verdict band edges `[주의 시작, 초과 시작]` or a binding to them (e.g. a model's colorBands). */
const bands = z.union([binding, z.tuple([z.number(), z.number()])]);
const column = z
  .object({
    field,
    label: title,
    unit: z.string().max(12).optional(),
    decimals: z.number().int().min(0).max(6).optional(),
  })
  .strict();
const layer = z
  .object({
    key: layerKey,
    title: title.optional(),
    from: binding,
    shape: z.enum(['point', 'line', 'polygon']),
    /** The row field holding the geometry (default `at` · `line` · `polygon`). */
    at: field.optional(),
    /** The row field that identifies an item (default `key`). */
    id: field.optional(),
    label: field.optional(),
    tone: tone.optional(),
    dashed: z.boolean().optional(),
    /** Polygons: a light fill under the outline. */
    fill: z.boolean().optional(),
    colorBy: field.optional(),
    bands: bands.optional(),
  })
  .strict();
const legend = z
  .object({
    part: z.literal('verdict-legend'),
    title: title.optional(),
    from: binding,
    field,
    bands,
    overlay: layerKey.optional(),
  })
  .strict();
const tableProps = {
  title: title.optional(),
  from: binding,
  columns: z.array(column).min(1).max(12).optional(),
  key: field.optional(),
  overlay: layerKey.optional(),
  csv: z
    .string()
    .regex(/^[\w가-힣-]{1,60}$/)
    .optional(),
};

/** Property schemas by part (without `part`); every object is strict. */
export const PART_PROPS = {
  'step-rail': z.object({ title: title.optional() }).strict(),
  'param-group': z
    .object({
      title: title.optional(),
      group: title.optional(),
      params: z.array(setting).min(1).max(40).optional(),
    })
    .strict(),
  slider: z.object({ param: setting }).strict(),
  choice: z.object({ param: setting }).strict(),
  stepper: z.object({ param: setting }).strict(),
  toggle: z.object({ param: setting }).strict(),
  'slider-board': z
    .object({ title: title.optional(), params: z.array(setting).min(1).max(6).optional() })
    .strict(),
  'fact-badge': z.object({ param: setting }).strict(),
  'role-card': z
    .object({
      input: z.string().regex(new RegExp(`^inputs\\.${WORD}$`)),
      roles: z.array(title).min(1).max(20).optional(),
    })
    .strict(),
  'kpi-strip': z
    .object({
      items: z
        .array(
          z
            .object({
              label: title,
              from: binding,
              unit: z.string().max(12).optional(),
              decimals: z.number().int().min(0).max(6).optional(),
              note: text.optional(),
              warnAbove: z.union([binding, z.number()]).optional(),
              /** Why the cell is empty before there is a value (default: 계산 전). */
              empty: title.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(6),
    })
    .strict(),
  'verdict-legend': legend.omit({ part: true }),
  'viewport-overlay': z
    .object({
      title: title.optional(),
      layers: z.array(layer).min(1).max(12),
      legend: legend.optional(),
    })
    .strict(),
  'plan-map': z
    .object({
      title: title.optional(),
      layers: z.array(layer).min(1).max(12),
      /** Turn the plan so this angle (degrees, e.g. the grid angle) reads as horizontal. */
      rotate: binding.optional(),
    })
    .strict(),
  'issue-table': z.object(tableProps).strict(),
  table: z.object(tableProps).strict(),
  schedule: z.object(tableProps).strict(),
  'result-tabs': z
    .object({ tabs: z.array(z.record(z.string(), z.unknown())).min(1).max(12) })
    .strict(),
  'compare-bars': z
    .object({
      title: title.optional(),
      from: binding,
      label: field,
      value: field,
      /** Row field naming the bar shade: base · alt · strong · actual · na. */
      shade: field.optional(),
      unit: z.string().max(12).optional(),
      decimals: z.number().int().min(0).max(6).optional(),
      limit: z.union([binding, z.number()]).optional(),
      limitLabel: title.optional(),
    })
    .strict(),
  'bake-card': z
    .object({
      title: title.optional(),
      from: binding.optional(),
      // Bake ids the card offers (the jig's own or VIDE's built-in `lines`·`members`); all when omitted.
      bake: z.array(z.string().min(1).max(40)).max(10).optional(),
    })
    .strict(),
  'conflict-banner': z.object({ from: binding }).strict(),
  report: z.object({ report: title }).strict(),
  ledger: z
    .object({
      title: title.optional(),
      from: binding,
      group: field.optional(),
      columns: z.array(column).min(1).max(12).optional(),
    })
    .strict(),
  // 대상 필지 고르기 (SPEC-12.3, PLAN-45 T-207): a `site-data` input's notice, address search,
  // candidate question card, chosen parcels, collect and SHP put-in.
  'site-picker': z
    .object({
      input: z.string().regex(new RegExp(`^inputs\\.${WORD}$`)),
      title: title.optional(),
    })
    .strict(),
  // 앞 jig의 결과 (SPEC-07.2·07.5 6, PLAN-45 T-213): a `jig-output` input's earlier instance —
  // which one, its state and '다시 계산 필요' — and the choice among the project's instances.
  'jig-source': z
    .object({
      input: z.string().regex(new RegExp(`^inputs\\.${WORD}$`)),
      title: title.optional(),
    })
    .strict(),
} satisfies Record<PartName, z.ZodType>;

/** Parts not built yet: listed, but a panel that uses them is refused (none since T-057). */
export const NOT_READY: ReadonlySet<PartName> = new Set<PartName>([]);

/** Where each place of the `jig-run` layout accepts which parts. */
export const PLACES = {
  left: [
    'step-rail',
    'param-group',
    'slider',
    'choice',
    'stepper',
    'toggle',
    'fact-badge',
    'role-card',
    'verdict-legend',
    'bake-card',
    'conflict-banner',
    'site-picker',
    'jig-source',
  ],
  views: ['viewport-overlay', 'plan-map', 'report'],
  board: ['slider-board'],
  kpis: ['kpi-strip'],
  drawer: ['result-tabs', 'issue-table', 'table', 'schedule', 'ledger'],
  tab: ['issue-table', 'table', 'schedule', 'bake-card', 'compare-bars', 'ledger'],
} as const satisfies Record<string, readonly PartName[]>;
export type Place = keyof typeof PLACES;

export type LayerSpec = z.infer<typeof layer>;
export type LegendSpec = z.infer<typeof legend>;
export type ColumnSpec = z.infer<typeof column>;
export type PartProps = { [K in PartName]: z.infer<(typeof PART_PROPS)[K]> };
/** One part in a panel after checking; `result-tabs` tabs are checked parts with a title. */
export type PartUse = {
  [K in PartName]: { part: K } & (K extends 'result-tabs'
    ? { tabs: (PartUse & { title: string })[] }
    : PartProps[K]);
}[PartName];
export type PartOf<K extends PartName> = Extract<PartUse, { part: K }>;
