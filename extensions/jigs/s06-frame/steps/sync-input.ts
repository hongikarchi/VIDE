// Temporary input adapter of the M0 diagnosis (PLAN-23 T-044): stored Sync display results →
// layer lists, role rows and first role guesses from layer names (rules only, no AI). T-051
// replaces it with the assembly step (SPEC-07.5: rule candidates → AI proposal → people confirm)
// and jig input reads. Pure: atob/TextDecoder only, so the engine and tests share it.

import type { BlockDefinition } from '../../../../src/jigs/official/geometry-kit/index.ts';
import type { DiagnoseRow } from './diagnose.ts';
import { ROLE_KEYS, type RoleKey } from './labels.ts';

export type ObjectKind = 'curve' | 'block' | 'mesh' | 'wire' | 'other';
export interface LayerSummary {
  name: string;
  count: number;
  kinds: Partial<Record<ObjectKind, number>>;
}
export interface SourceLayers {
  syncId: string;
  document: string;
  layers: LayerSummary[];
}
export interface RolePick {
  syncId: string;
  layer: string;
}

type Row = Record<string, unknown>;

export function decodeText(value: unknown) {
  if (typeof value !== 'string' || !value) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
    );
  } catch {
    return '';
  }
}
/**
 * Layer names of scene rows, decoded once per distinct value: a Sync repeats a few dozen layer
 * names over up to hundreds of thousands of rows, and the engine answers other requests meanwhile.
 */
function layerNames() {
  const known = new Map<unknown, string>();
  return (row: Row) => {
    let name = known.get(row.layer64);
    if (name === undefined) {
      name = decodeText(row.layer64);
      known.set(row.layer64, name);
    }
    return name;
  };
}
const numbers = (value: unknown) =>
  Array.isArray(value) && value.length ? (value as number[]) : undefined;
const rowsOf = (result: Row) =>
  Array.isArray(result.scene) ? (result.scene as unknown[]).filter(isRow) : [];
function isRow(value: unknown): value is Row {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function objectKind(row: Row): ObjectKind {
  if (isRow(row.block)) return 'block';
  if (numbers(row.line)) return 'curve';
  if (numbers(row.vertices)) return 'mesh';
  if (numbers(row.segments)) return 'wire';
  return 'other';
}

export function documentName(result: Row) {
  const source = isRow(result.sourceDocument) ? result.sourceDocument : {};
  return typeof source.name === 'string' && source.name ? source.name : '이름 없는 문서';
}

/** Layers of one Sync with object counts by kind, in first-seen order. */
export function syncLayers(result: Row): LayerSummary[] {
  const layers = new Map<string, LayerSummary>();
  const layerOf = layerNames();
  for (const row of rowsOf(result)) {
    const name = layerOf(row);
    const entry = layers.get(name) ?? { name, count: 0, kinds: {} };
    const kind = objectKind(row);
    entry.count++;
    entry.kinds[kind] = (entry.kinds[kind] ?? 0) + 1;
    layers.set(name, entry);
  }
  return [...layers.values()];
}

/** Scene rows of the given layers as diagnosis rows, with the block definitions they use. */
export function roleRows(
  result: Row,
  syncId: string,
  layers: readonly string[],
): { rows: DiagnoseRow[]; definitions: Record<string, BlockDefinition> } {
  const wanted = new Set(layers);
  const layerOf = layerNames();
  const all = isRow(result.definitions) ? result.definitions : {};
  const definitions: Record<string, BlockDefinition> = {};
  const rows: DiagnoseRow[] = [];
  const unnamed = new Map<string, DiagnoseRow>();
  for (const row of rowsOf(result)) {
    const layer = layerOf(row);
    if (!wanted.has(layer)) continue;
    const id = String(row.id);
    const out: DiagnoseRow = { syncId, id, layer };
    if (typeof row.nativeId === 'string') out.nativeId = row.nativeId;
    const name = decodeText(row.name64);
    if (name) out.name = name;
    else unnamed.set(id, out);
    const line = numbers(row.line),
      vertices = numbers(row.vertices),
      segments = numbers(row.segments);
    if (line) out.line = line;
    if (vertices) out.vertices = vertices;
    if (segments) out.segments = segments;
    if (isRow(row.block) && typeof row.block.definition === 'string') {
      out.block = {
        definition: row.block.definition,
        transform: numbers(row.block.transform) ?? [],
      };
      const definition = all[row.block.definition];
      if (isRow(definition))
        definitions[row.block.definition] = {
          vertices: numbers(definition.vertices),
          indices: numbers(definition.indices),
          segments: numbers(definition.segments),
        };
    }
    rows.push(out);
  }
  // Names from the object list, looked up only for the rows taken.
  if (unnamed.size && Array.isArray(result.objects))
    for (const object of result.objects as unknown[]) {
      if (!isRow(object) || typeof object.name !== 'string' || !object.name) continue;
      const out = unnamed.get(String(object.id));
      if (out && !out.name) out.name = object.name;
    }
  return { rows, definitions };
}

// First guesses from layer names and object kinds. They are suggestions the person checks on the
// screen; nothing is silently merged. `other` says whether a role lives in another document than
// the columns (true: the civil/basin model) or in the same one (false). `alt` is a weaker second
// rule that only applies in another document than the columns: a basin model draws its footing
// and column as one block on a layer named after the column, so that layer may still be picked.
const RULES: Record<
  RoleKey,
  {
    words: RegExp;
    prefer?: RegExp;
    avoid?: RegExp;
    kinds: ObjectKind[];
    other?: boolean;
    alt?: { words: RegExp; avoid?: RegExp; kinds: ObjectKind[] };
  }
> = {
  columns: {
    words: /기둥|column|\bcol\b|^c\d/i,
    avoid: /기존|existing|유수지|basin|기초|footing/i,
    kinds: ['curve'],
  },
  girders: {
    words: /거더|girder|큰\s*보|\bgir\b|보|beam/i,
    prefer: /거더|girder/i,
    avoid: /작은\s*보|기존|existing|유수지|basin|기초|footing/i,
    kinds: ['curve'],
    other: false,
  },
  newFootings: {
    words: /기초|footing|파일\s*캡|pile\s*cap|\bfdn\b|\bpc\b/i,
    prefer: /신설|new|파일\s*캡|pile/i,
    avoid: /기존|existing/i,
    kinds: ['block', 'mesh'],
    other: false,
  },
  existingFootings: {
    words: /기초|footing|\bfdn\b/i,
    prefer: /기존|existing/i,
    avoid: /신설|new|파일\s*캡|pile/i,
    kinds: ['block', 'mesh'],
    other: true,
    alt: {
      words: /기둥|column|\bcol\b/i,
      avoid: /신설|new|파일\s*캡|pile|보|girder|beam/i,
      kinds: ['block'],
    },
  },
  basinGirders: {
    words: /유수지|basin|보|girder|beam/i,
    prefer: /유수지|basin/i,
    avoid: /기초|footing|기둥|column/i,
    kinds: ['mesh', 'block'],
    other: true,
  },
};

/** Best (document, layer) per role, or null. Roles are filled in order; a layer is used once. */
export function guessRoles(sources: readonly SourceLayers[]): Record<RoleKey, RolePick | null> {
  const used = new Set<string>();
  const out = {} as Record<RoleKey, RolePick | null>;
  let home: string | undefined;
  for (const role of ROLE_KEYS) {
    const rule = RULES[role];
    let best: { pick: RolePick; score: number } | null = null;
    for (const source of sources)
      for (const layer of source.layers) {
        const id = `${source.syncId}\u0000${layer.name}`;
        if (used.has(id)) continue;
        let score: number;
        let kinds: ObjectKind[];
        if (rule.words.test(layer.name)) {
          score = 10;
          kinds = rule.kinds;
          if (rule.prefer?.test(layer.name)) score += 5;
          if (rule.avoid?.test(layer.name)) score -= 20;
        } else if (
          rule.alt &&
          home &&
          source.syncId !== home &&
          rule.alt.words.test(layer.name) &&
          !rule.alt.avoid?.test(layer.name)
        ) {
          // Below any layer the main words match, above nothing.
          score = 4;
          kinds = rule.alt.kinds;
        } else continue;
        const fitting = kinds.reduce((sum, kind) => sum + (layer.kinds[kind] ?? 0), 0);
        score += fitting * 2 >= layer.count ? 4 : fitting ? 1 : -20;
        if (home && rule.other !== undefined)
          score += (source.syncId !== home) === rule.other ? 3 : -3;
        if (score > 0 && (!best || score > best.score))
          best = { pick: { syncId: source.syncId, layer: layer.name }, score };
      }
    out[role] = best?.pick ?? null;
    if (best) used.add(`${best.pick.syncId}\u0000${best.pick.layer}`);
    if (role === 'columns') home = best?.pick.syncId;
  }
  return out;
}
