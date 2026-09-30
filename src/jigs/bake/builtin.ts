// Built-in bakes (PLAN-23 T-056 part 1, SPEC-07.12): what every jig can make in Rhino from its
// current results without declaring a bake of its own (a jig that names Rhino as a host and is
// not an AI draft; the templates and the row reading are VIDE's, the jig only gives results). `lines` makes the lines a person and the
// jig share — axes, column lines, girder top lines when a step gives them — on `jig 상단선`;
// `members` and `member-columns` make H members and H columns on `jig 부재` from result rows that
// carry a section, and need a confirmed analysis of the same inputs (`analysis-confirmed`). A
// jig's own `bake` declaration with the same id wins. Rows are read from the top-level arrays of
// the finished code steps' outputs; a later step's row replaces an earlier one with the same key.

import type { BakeDecl } from '../runtime/manifest.ts';

export const BUILTIN_PREFIX = 'builtin.';

export const BUILTIN_BAKES: readonly BakeDecl[] = [
  {
    id: 'lines',
    template: 'vide.bake.curves@1',
    host: 'rhino',
    items: `${BUILTIN_PREFIX}lines`,
    layer: 'jig 상단선',
    key: 'key',
    attrs: { 'vide-role': 'role' },
    mode: 'replace-own',
  },
  {
    id: 'members',
    template: 'vide.bake.sweep-h@1',
    host: 'rhino',
    items: `${BUILTIN_PREFIX}members`,
    layer: 'jig 부재',
    key: 'key',
    attrs: { 'vide-role': 'role', 'vide-section': 'section' },
    mode: 'replace-own',
    requires: ['analysis-confirmed'],
  },
  {
    id: 'member-columns',
    template: 'vide.bake.extrude-column@1',
    host: 'rhino',
    items: `${BUILTIN_PREFIX}memberColumns`,
    layer: 'jig 부재',
    key: 'key',
    attrs: { 'vide-role': 'role', 'vide-section': 'section' },
    mode: 'replace-own',
    requires: ['analysis-confirmed'],
  },
];

export const isBuiltinBake = (decl: Pick<BakeDecl, 'items'>) =>
  decl.items.startsWith(BUILTIN_PREFIX);

/** What the built-ins need from a jig: it names Rhino as a host and is not an AI draft. */
export interface BakeJig {
  source: string;
  manifest: { hosts?: { rhino?: string }; bake?: BakeDecl[] };
}
const builtinsFor = (jig: BakeJig) =>
  jig.source !== 'ai-draft' && jig.manifest.hosts?.rhino !== undefined ? BUILTIN_BAKES : [];
/** The jig's own declaration of a bake id, else the built-in one it may use. */
export function bakeDeclOf(jig: BakeJig, id: string) {
  return jig.manifest.bake?.find((b) => b.id === id) ?? builtinsFor(jig).find((b) => b.id === id);
}
/** Every bake an instance can offer: its own declarations, then the built-ins it does not shadow. */
export function bakeDeclsOf(jig: BakeJig): BakeDecl[] {
  const own = jig.manifest.bake ?? [];
  return [...own, ...builtinsFor(jig).filter((b) => !own.some((d) => d.id === b.id))];
}

/** Top-level output arrays whose rows are lines, and the role each one stands for. */
const LINE_ARRAYS: [string, string][] = [
  ['axes', 'axis'],
  ['columns', 'column'],
  ['girders', 'girder'],
  ['beams', 'beam'],
];
const MEMBER_ARRAYS: [string, string][] = [
  ['girders', 'girder'],
  ['beams', 'beam'],
  ['members', 'member'],
];
/** A girder's top line first (members hang below it, SPEC-06.12), then any line of the row. */
const CURVE_FIELDS = ['topLine', 'rail', 'line', 'curve', 'points'];

type Row = Record<string, unknown>;
const rowsOf = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((r): r is Row => !!r && typeof r === 'object') : [];
const keyOf = (row: Row, index: number) => {
  const key = row.key ?? row.id ?? row.mark;
  return typeof key === 'string' || typeof key === 'number' ? String(key) : `#${index}`;
};
const curveField = (row: Row) => {
  const value = CURVE_FIELDS.map((f) => row[f]).find((v) => v !== undefined);
  // A row's own `points` with `kind: 'arc'` (start, interior, end) stays an arc.
  return value === row.points && row.kind === 'arc' && Array.isArray(value) && value.length === 3
    ? { kind: 'arc', points: value }
    : value;
};
const sized = (row: Row) =>
  typeof row.section === 'string' &&
  ['H_mm', 'B_mm', 'tw_mm', 'tf_mm'].every((f) => typeof row[f] === 'number');
const deg = (value: unknown): [number, number, number] | undefined =>
  typeof value === 'number' && Number.isFinite(value)
    ? [Math.cos((value * Math.PI) / 180), Math.sin((value * Math.PI) / 180), 0]
    : undefined;

/**
 * The rows a built-in bake takes, as a step output its declaration reads (`{lines}`, `{members}`,
 * `{memberColumns}`), from the outputs of the finished steps in manifest order.
 */
export function builtinOutput(outputs: readonly unknown[]): Record<string, Row[]> {
  const lines = new Map<string, Row>();
  const members = new Map<string, Row>();
  const columns = new Map<string, Row>();
  for (const output of outputs) {
    if (!output || typeof output !== 'object') continue;
    const record = output as Row;
    for (const [name, role] of LINE_ARRAYS)
      rowsOf(record[name]).forEach((row, i) => {
        const curve = curveField(row);
        if (curve === undefined) return;
        const key = `${role}:${keyOf(row, i)}`;
        lines.set(key, { key, role, curve });
      });
    for (const [name, role] of MEMBER_ARRAYS)
      rowsOf(record[name]).forEach((row, i) => {
        const rail = curveField(row);
        if (rail === undefined || !sized(row)) return;
        const key = `${role}:${keyOf(row, i)}`;
        members.set(key, { ...row, key, role, rail });
      });
    rowsOf(record.columns).forEach((row, i) => {
      if (!sized(row)) return;
      const line = Array.isArray(row.line) ? row.line : undefined;
      const base = row.base ?? row.bottom ?? line?.[0];
      const top = row.top ?? line?.[1];
      if (base === undefined || top === undefined) return;
      const key = `column:${keyOf(row, i)}`;
      columns.set(key, {
        ...row,
        key,
        role: 'column',
        base,
        top,
        strongAxis: row.strongAxis ?? deg(row.strongAxisDeg),
      });
    });
  }
  return {
    lines: [...lines.values()],
    members: [...members.values()],
    memberColumns: [...columns.values()],
  };
}
