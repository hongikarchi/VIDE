// Bake planning (SPEC-07.12 4, SPEC-07.13, ARCH-03 §9.4): the items a bake declaration takes from
// a step output, and what the forced pre-bake read says about the objects an earlier bake
// recorded. Replacement is decided by recorded object GUIDs and fingerprints, never by tags: a
// recorded object with the same fingerprint on its recorded, visible layer is replaced; a changed,
// moved or missing one is a person's work and is left alone; tagged objects the record does not
// know are copies and stay. Only the objects of this instance and bake are ever deleted.
// An edit taken as a 수정 사항 (`absorb`, SPEC-07.13) moves that key's baseline to the taken
// fingerprint: while the object keeps it, the object stands for the jig's item and is left alone.

import type { BakeDecl } from '../runtime/manifest.ts';
import type { Override } from '../runtime/instance.ts';
import { at } from '../runtime/gates.ts';
import type { ReadModel } from '../runtime/runtime.ts';
import type { JigBake } from '../../core/jig-store.ts';
import {
  itemProblems,
  type BakeCurve,
  type BakeItem,
  type TemplateName,
  type Vec3,
} from './data-block.ts';

/** One key of a bake record (`jig_bakes.items`, ARCH-03 §9.4). */
export interface BakeRecordItem {
  nativeId: string;
  /** Display-path geometry hash after application; '' until the baseline read succeeded. */
  hash: string;
  layer: string;
  runId: string;
  state: 'jig' | 'kept' | 'deleted';
}
export type BakeRecordItems = Record<string, BakeRecordItem>;
export type Resolve = 'keep' | 'overwrite' | 'absorb';

const FIELD_DEFAULTS: Record<TemplateName, string[]> = {
  'vide.bake.curves@1': ['curve'],
  'vide.bake.sweep-h@1': ['section', 'H_mm', 'B_mm', 'tw_mm', 'tf_mm', 'rail'],
  'vide.bake.extrude-column@1': [
    'section',
    'H_mm',
    'B_mm',
    'tw_mm',
    'tf_mm',
    'base',
    'top',
    'strongAxis',
  ],
  'vide.bake.textdot@1': ['text', 'point'],
};

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : NaN);
function vec3(value: unknown): Vec3 | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return undefined;
  const v: Vec3 = [num(value[0]), num(value[1]), value.length === 3 ? num(value[2]) : 0];
  return v.every(Number.isFinite) ? v : undefined;
}
/**
 * A curve value of a step output: `{kind, points}`, a point array (polyline; 2D points get z 0),
 * or `{from, to}` for a straight line.
 */
export function curveOf(value: unknown): BakeCurve | undefined {
  if (Array.isArray(value)) {
    const points = value.map(vec3);
    return points.every(Boolean) && points.length >= 2
      ? { kind: 'polyline', points: points as Vec3[] }
      : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if ('from' in record && 'to' in record) {
    const from = vec3(record.from),
      to = vec3(record.to);
    return from && to ? { kind: 'polyline', points: [from, to] } : undefined;
  }
  if (Array.isArray(record.points)) {
    const points = record.points.map(vec3);
    if (!points.every(Boolean)) return undefined;
    const kind = record.kind === 'arc' ? 'arc' : 'polyline';
    return { kind, points: points as Vec3[] };
  }
  return undefined;
}

/** The step id and the path inside its output that `decl.items` names (`step.<id>.<path>`). */
export function itemsPath(decl: Pick<BakeDecl, 'items'>) {
  const parts = decl.items.replace(/^step\./, '').split('.');
  return { stepId: parts[0], path: parts.slice(1).join('.') };
}

export interface Extracted {
  items: BakeItem[];
  problems: string[];
}
/** The S-06 bake plan step output (PLAN-23 T-056 ⑫, `extensions/jigs/s06-frame/steps/bakeplan.ts`). */
export const BAKE_PLAN_SCHEMA = 'vide.s06.bakePlan/1';
const MEMBER_TEMPLATES: readonly TemplateName[] = [
  'vide.bake.sweep-h@1',
  'vide.bake.extrude-column@1',
];
/**
 * Rows of a bake plan (`lines`, `members`) as the template fields: a line's `points` with `arc`
 * are a three-point arc; members give their section name and sizes; `members` bakes (H under the
 * top line, web vertical) take the non-column rows and column bakes the column rows. Members are
 * refused unless the declaration requires `analysis-confirmed` and the plan is not a preview.
 */
function bakePlanRows(decl: BakeDecl, output: Record<string, unknown>, list: unknown[]) {
  const problems: string[] = [];
  const member = MEMBER_TEMPLATES.includes(decl.template);
  if (member && !(decl.requires ?? []).includes('analysis-confirmed'))
    problems.push('부재 만들기에는 확정 해석 점검(analysis-confirmed)이 필요합니다');
  if (member && output.previewOnly !== false)
    problems.push('미확정 미리보기 해석의 단면이라 부재를 만들지 않습니다');
  const rows: Record<string, unknown>[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const points = Array.isArray(row.points) ? row.points : [];
    const curve = { kind: row.arc && points.length === 3 ? 'arc' : 'polyline', points };
    const base = {
      ...row,
      role: row.role ?? row.kind,
      mark: typeof row.mark === 'string' && row.mark ? row.mark : undefined,
    };
    const column = row.role === 'column' || row.kind === 'column';
    switch (decl.template) {
      case 'vide.bake.curves@1':
        rows.push({ ...base, curve });
        break;
      case 'vide.bake.sweep-h@1':
        if (!column) rows.push({ ...base, section: row.sectionName, rail: curve });
        break;
      case 'vide.bake.extrude-column@1':
        if (column)
          rows.push({
            ...base,
            section: row.sectionName,
            base: points[0],
            top: points[points.length - 1],
          });
        break;
      case 'vide.bake.textdot@1': {
        if (!base.mark || !points.length) break;
        const a = vec3(points[0]),
          b = vec3(points[points.length - 1]);
        const point =
          points.length === 3 ? points[1] : a && b ? a.map((v, i) => (v + b[i]) / 2) : undefined;
        rows.push({ ...base, text: base.mark, point });
        break;
      }
    }
  }
  return { rows, problems };
}

/** The template items of a bake declaration from its step output, fields mapped by `decl.map`. */
export function extractItems(decl: BakeDecl, output: unknown): Extracted {
  const problems: string[] = [];
  const { path } = itemsPath(decl);
  const found = at(output, path || undefined);
  if (!Array.isArray(found))
    return { items: [], problems: [`항목 배열이 없습니다: ${decl.items}`] };
  let list: unknown[] = found;
  if ((output as { schema?: unknown }).schema === BAKE_PLAN_SCHEMA) {
    const plan = bakePlanRows(decl, output as Record<string, unknown>, list);
    problems.push(...plan.problems);
    list = plan.rows;
  }
  const items: BakeItem[] = [];
  const field = (item: Record<string, unknown>, name: string) => at(item, decl.map?.[name] ?? name);
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      problems.push(`#${index}: 항목이 객체가 아닙니다`);
      return;
    }
    const item = entry as Record<string, unknown>;
    const keyValue = at(item, decl.key);
    const key = typeof keyValue === 'string' ? keyValue : String(keyValue ?? `#${index}`);
    const attrs: [string, string][] = [];
    for (const [name, source] of Object.entries(decl.attrs ?? {})) {
      const value = at(item, source);
      if (value !== undefined && value !== null) attrs.push([name, String(value)]);
    }
    const fields: Record<string, unknown> = {};
    for (const name of FIELD_DEFAULTS[decl.template]) fields[name] = field(item, name);
    const base = { key, attrs };
    switch (decl.template) {
      case 'vide.bake.curves@1': {
        const curve = curveOf(fields.curve);
        if (curve) items.push({ ...base, curve });
        else problems.push(`${key}: 곡선이 없습니다`);
        break;
      }
      case 'vide.bake.sweep-h@1': {
        const rail = curveOf(fields.rail);
        if (rail)
          items.push({
            ...base,
            section: String(fields.section ?? ''),
            H_mm: num(fields.H_mm),
            B_mm: num(fields.B_mm),
            tw_mm: num(fields.tw_mm),
            tf_mm: num(fields.tf_mm),
            rail,
          });
        else problems.push(`${key}: 상단선이 없습니다`);
        break;
      }
      case 'vide.bake.extrude-column@1': {
        const basePoint = vec3(fields.base),
          top = vec3(fields.top),
          strongAxis = vec3(fields.strongAxis) ?? [1, 0, 0];
        if (basePoint && top)
          items.push({
            ...base,
            section: String(fields.section ?? ''),
            H_mm: num(fields.H_mm),
            B_mm: num(fields.B_mm),
            tw_mm: num(fields.tw_mm),
            tf_mm: num(fields.tf_mm),
            base: basePoint,
            top,
            strongAxis,
          });
        else problems.push(`${key}: 기둥의 아래·위 점이 없습니다`);
        break;
      }
      case 'vide.bake.textdot@1': {
        const point = vec3(fields.point);
        if (point) items.push({ ...base, text: String(fields.text ?? key), point });
        else problems.push(`${key}: 부호 위치가 없습니다`);
        break;
      }
    }
  });
  problems.push(...itemProblems(decl.template, items));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) problems.push(`${item.key}: 키가 겹칩니다`);
    seen.add(item.key);
  }
  return { items, problems };
}

const decode64 = (value: unknown) => {
  if (typeof value !== 'string' || !value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
};
/** One read row as the plan sees it. */
export interface ReadObject {
  nativeId: string;
  hash: string;
  layer: string;
  tags: Record<string, string>;
}
/** Rows of a read model by GUID, with their `vide-*` tags decoded. */
export function readObjects(model: ReadModel): Map<string, ReadObject> {
  const out = new Map<string, ReadObject>();
  for (const row of Array.isArray(model.scene) ? model.scene : []) {
    if (!row || typeof row !== 'object') continue;
    const tags: Record<string, string> = {};
    for (const pair of Array.isArray(row.attributes64) ? row.attributes64 : [])
      if (Array.isArray(pair) && pair.length === 2) {
        const name = decode64(pair[0]);
        if (name.startsWith('vide-')) tags[name] = decode64(pair[1]);
      }
    const nativeId = String(row.nativeId ?? '');
    if (!nativeId) continue;
    out.set(nativeId, {
      nativeId,
      hash: typeof row.geometryHash === 'string' ? row.geometryHash : '',
      layer: typeof row.layer === 'string' ? row.layer : decode64(row.layer64),
      tags,
    });
  }
  return out;
}
/** Layer visibility of a read; a model without a layer table reports every layer as usable. */
export function readLayers(model: ReadModel): Map<string, { visible: boolean; locked: boolean }> {
  const out = new Map<string, { visible: boolean; locked: boolean }>();
  for (const layer of Array.isArray(model.layers) ? model.layers : []) {
    if (!layer || typeof layer !== 'object') continue;
    const row = layer as { fullPath?: unknown; visible?: unknown; locked?: unknown };
    if (typeof row.fullPath === 'string')
      out.set(row.fullPath, { visible: row.visible !== false, locked: row.locked === true });
  }
  return out;
}
/** A layer and its ancestors are on and unlocked. */
export function layerUsable(
  layers: Map<string, { visible: boolean; locked: boolean }>,
  fullPath: string,
) {
  const parts = fullPath.split('::');
  for (let i = parts.length; i > 0; i--) {
    const state = layers.get(parts.slice(0, i).join('::'));
    if (state && (!state.visible || state.locked))
      return { visible: state.visible, locked: state.locked };
  }
  return { visible: true, locked: false };
}

export interface Preserved {
  key: string;
  nativeId: string;
  reason: 'edited' | 'moved' | 'pending-baseline';
}
export interface BakePlan {
  /** Items to make now. */
  create: BakeItem[];
  /** Recorded GUIDs to delete before making (unchanged jig objects). */
  deleteIds: string[];
  added: string[];
  replaced: string[];
  /** Recorded keys no longer in the results: their unchanged objects are deleted, not remade. */
  dropped: string[];
  /** Human-edited (or not yet baselined) objects the bake leaves alone. */
  preserved: Preserved[];
  /** Keys a person decided to keep; skipped. */
  kept: string[];
  /** Keys whose object a person deleted; not made again. */
  deleted: string[];
  /** Tagged objects of this instance and bake that no record knows (copies). */
  copies: number;
  /** Replace targets on hidden or locked layers (gate `hidden-target`). */
  hiddenTargets: { key: string; layer: string; visible: boolean; locked: boolean }[];
  /** Record items carried into the new record (kept, deleted, preserved). */
  carry: BakeRecordItems;
  /** Overrides to add for `absorb` resolutions (origin `host-edit`). */
  absorbed: Omit<Override, 'id' | 'at'>[];
  /**
   * Keys whose person-edited object was taken as a 수정 사항 (now or earlier) and still has the
   * taken fingerprint: it stands for the jig's item, so it is neither deleted nor made again.
   */
  respected: string[];
}
/** The fingerprint a person's edit was taken at (`absorb`, SPEC-07.13), by result key. */
export type Absorbed = Record<string, { nativeId: string; hash: string; layer: string }>;
/**
 * The taken edits of one bake from an instance's overrides (`target.kind: 'bake-item'`, origin
 * `host-edit`); the latest override of a key wins.
 */
export function absorbedOf(
  overrides: readonly Pick<Override, 'target' | 'op' | 'fields' | 'origin'>[],
  bakeId: string,
): Absorbed {
  const out: Absorbed = {};
  for (const o of overrides) {
    if (o.target.kind !== 'bake-item' || o.origin !== 'host-edit' || o.op !== 'set') continue;
    if (o.target.identity.bake !== bakeId) continue;
    const { nativeId, hash, layer } = o.fields;
    if (typeof nativeId !== 'string' || typeof hash !== 'string' || typeof layer !== 'string')
      continue;
    out[String(o.target.identity.key)] = { nativeId, hash, layer };
  }
  return out;
}
export interface PlanInput {
  instanceId: string;
  bakeId: string;
  planned: readonly BakeItem[];
  /** The latest applied record of this bake and link, if any. */
  prior?: Pick<JigBake, 'runId' | 'items' | 'appliedAt'>;
  /** Records made and not baselined; their objects, when present, are preserved. */
  pending?: readonly Pick<JigBake, 'runId' | 'items'>[];
  read: ReadModel;
  resolve?: Record<string, Resolve>;
  /** Edits taken earlier as 수정 사항 (`absorbedOf`); they replace the recorded baseline. */
  absorbed?: Absorbed;
}
/** Classify the recorded objects against the forced read and decide what to delete and make. */
export function planBake(input: PlanInput): BakePlan {
  const objects = readObjects(input.read);
  const layers = readLayers(input.read);
  const resolve = input.resolve ?? {};
  const plan: BakePlan = {
    create: [],
    deleteIds: [],
    added: [],
    replaced: [],
    dropped: [],
    preserved: [],
    kept: [],
    deleted: [],
    copies: 0,
    hiddenTargets: [],
    carry: {},
    absorbed: [],
    respected: [],
  };
  const known = new Set<string>();
  const skip = new Set<string>();
  const plannedKeys = new Set(input.planned.map((item) => item.key));
  const priorItems = (input.prior?.items ?? {}) as BakeRecordItems;
  const absorb = (key: string, object: ReadObject) =>
    plan.absorbed.push({
      target: { kind: 'bake-item', identity: { key, bake: input.bakeId } },
      op: 'set',
      fields: { nativeId: object.nativeId, hash: object.hash, layer: object.layer },
      origin: 'host-edit',
      by: 'user',
      note: `Rhino에서 고친 ${key}을(를) 수정 사항으로 받음`,
    });
  for (const [key, recordedItem] of Object.entries(priorItems)) {
    known.add(recordedItem.nativeId);
    // A taken edit moves the baseline to the fingerprint it was taken at (SPEC-07.13).
    const taken = input.absorbed?.[key];
    const item = taken ? { ...recordedItem, ...taken } : recordedItem;
    known.add(item.nativeId);
    const choice = resolve[key];
    if (item.state === 'kept' && choice !== 'overwrite') {
      plan.kept.push(key);
      plan.carry[key] = item;
      skip.add(key);
      continue;
    }
    if (item.state === 'deleted' && choice !== 'overwrite') {
      plan.deleted.push(key);
      plan.carry[key] = item;
      skip.add(key);
      continue;
    }
    const object = objects.get(item.nativeId);
    if (!object) {
      // A person deleted it: not made again (SPEC-07.12 4) unless they chose to overwrite.
      if (choice === 'overwrite') continue;
      plan.deleted.push(key);
      plan.carry[key] = { ...item, state: 'deleted' };
      skip.add(key);
      continue;
    }
    const edited = !item.hash || object.hash !== item.hash || object.layer !== item.layer;
    if (edited && choice !== 'overwrite' && choice !== 'absorb') {
      const reason: Preserved['reason'] = !item.hash
        ? 'pending-baseline'
        : object.layer !== item.layer
          ? 'moved'
          : 'edited';
      plan.preserved.push({ key, nativeId: item.nativeId, reason });
      plan.carry[key] = choice === 'keep' ? { ...item, state: 'kept' } : item;
      if (choice === 'keep') plan.kept.push(key);
      skip.add(key);
      continue;
    }
    if (choice !== 'overwrite' && (edited ? choice === 'absorb' : !!taken)) {
      // Taken as a 수정 사항: the person's object stands for the jig's item and stays as it is;
      // editing it again makes it a person's edit again, `overwrite` replaces it with the jig's.
      if (edited) absorb(key, object);
      plan.respected.push(key);
      plan.carry[key] = {
        ...item,
        nativeId: object.nativeId,
        hash: object.hash,
        layer: object.layer,
        state: 'jig',
      };
      skip.add(key);
      continue;
    }
    // Replace: the recorded object, unchanged (or overwritten on request), on a usable layer.
    const usable = layerUsable(layers, object.layer);
    if (!usable.visible || usable.locked) {
      plan.hiddenTargets.push({ key, layer: object.layer, ...usable });
      skip.add(key);
      continue;
    }
    plan.deleteIds.push(item.nativeId);
    if (plannedKeys.has(key)) plan.replaced.push(key);
    else plan.dropped.push(key);
  }
  for (const record of input.pending ?? [])
    for (const [key, item] of Object.entries(record.items as BakeRecordItems)) {
      known.add(item.nativeId);
      if (skip.has(key) || !objects.has(item.nativeId) || item.state !== 'jig') continue;
      // Applied, but the baseline read never succeeded: preserved until it does (SPEC-07.17).
      plan.preserved.push({ key, nativeId: item.nativeId, reason: 'pending-baseline' });
      plan.carry[key] = { ...item, hash: '' };
      skip.add(key);
    }
  for (const item of input.planned) {
    if (skip.has(item.key)) continue;
    plan.create.push(item);
    if (!plan.replaced.includes(item.key)) plan.added.push(item.key);
  }
  for (const object of objects.values())
    if (
      !known.has(object.nativeId) &&
      object.tags['vide-instance'] === input.instanceId &&
      object.tags['vide-bake'] === input.bakeId
    )
      plan.copies++;
  return plan;
}
