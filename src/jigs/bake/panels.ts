// 패널링 rows for Rhino에 만들기 (SPEC-16.9, PLAN-49 T-255, ARCH-03 §9.1): the adapter that turns a
// stage result into template items. Stage 1 (`PanelLayout`) → `vide.bake.panels-uv@1` open faces;
// stage 2 (`MemberSet`) → `vide.bake.panel-solids@1` closed members and the joint centre lines as
// `vide.bake.curves@1`. Panels go as UV outlines with the face they lie on; Rhino rebuilds them on
// the ORIGINAL face after checking the face fingerprint the sample was read with. Keys follow
// `makeKey` (`<kind>:<layout hash 8>:<panel id>`), so a new layout never reuses a key and a stage-2
// change replaces the same panel. A panel the engine already failed is sent too, to be left on the
// failure layer as its outline and number (never silently missing, SPEC-16.10); dropped panels
// (boundary rule 'drop') are the person's choice and are not made.
//
// Stage 3 (`PanelTyping`, PLAN-49 T-257) makes four things with one [타입 만들기]: the type blocks
// (`vide.bake.block-instances@1`: a definition per type named `vide-panel-<type>-<typing hash 6>`,
// a placement per typed panel, keys `type:<layout hash 8>:<panel>`), the connection marks
// (`textdot@1`: node and joint types at their places, keys `node:…`/`joint:…`), the cut outlines on
// the XY plane beside the surface (`curves@1`, keys `cut:…:<panel>`) and their numbers
// (`textdot@1`, `cut:…:<panel>:no`).

import { createHash } from 'node:crypto';
import {
  makeKey,
  type MemberSet,
  type PanelLayout,
  type PanelTyping,
  type SurfaceSample,
} from '../../contracts/paneling.ts';
import {
  cutSheet,
  faceSampler,
  fingerprint,
  layoutFingerprint,
  previewSettingsFromParams,
  typePlacements,
} from '../official/paneling-kit/index.ts';
import type { BakeDecl } from '../runtime/manifest.ts';
import type { ParamValue } from '../runtime/params.ts';
import { stageSources, stagesUpTo, stageOfStep } from '../runtime/paneling-confirmed.ts';
import {
  blockHeaderProblems,
  isBlockTemplate,
  isPanelTemplate,
  PANEL_STATUS,
  surfaceHeaderProblems,
  type BakeItem,
  type BlockHeader,
  type BlockItem,
  type CurveItem,
  type PanelItem,
  type SurfaceHeader,
  type TextDotItem,
  type Vec3,
} from './data-block.ts';
import { itemsPath } from './plan.ts';

/** Time limit of one panel body inside Rhino (ms): about 500 members take 1 s (SPIKE §7). */
export const PANEL_BUDGET_MS = 60_000;
/** The jig's stage-1 step: its `PanelLayout` gives every panel's face and status (PLAN-49 T-253: ids fixed). */
export const LAYOUT_STEP = 'preview';
/** The jig's stage-2 step (`MemberSet`). */
export const MEMBERS_STEP = 'members';
/** The failure layer under the output layer (SPEC-16.9 3). */
export const FAIL_LAYER = '실패';
/** Sample-vs-surface difference above which the card says '표본이 거칩니다' without a tolerance. */
export const DEVIATION_LIMIT_DEFAULT = 0.003;

/** The jig's stage-3 step (`PanelTyping`). */
export const TYPING_STEP = 'optimize';

/** Does this declaration take its rows from the 패널링 adapter? */
export const isPanelDecl = (decl: Pick<BakeDecl, 'template' | 'rows'>) =>
  isPanelTemplate(decl.template) || isBlockTemplate(decl.template) || decl.rows === 'paneling';

export interface PanelRowsInput {
  decl: BakeDecl;
  /** The step the declaration names (`step.<id>`), and its output. */
  stepId: string;
  output: unknown;
  /** Stage 1 output (members and joints need the panels' faces and status). */
  layout: unknown;
  /** Stage 2 output (stage-3 makes need the plates). */
  members?: unknown;
  sample: SurfaceSample | null;
  manifestParams: readonly { key: string; group?: string }[];
  params: Readonly<Record<string, ParamValue>>;
  layerRoot: string;
}
export interface PanelRows {
  items: BakeItem[];
  surface?: SurfaceHeader;
  /** The block template's header (stage 3). */
  blocks?: BlockHeader;
  problems: string[];
  /** The layout fingerprint in the keys. */
  layoutHash?: string;
  /** '표본이 거칩니다' above this (m): the 3단계 flatness tolerance, else 3 mm. */
  deviationLimit: number;
}

const isLayout = (value: unknown): value is PanelLayout =>
  !!value &&
  typeof value === 'object' &&
  (value as { schema?: unknown }).schema === 'vide.paneling.layout@1' &&
  Array.isArray((value as { panels?: unknown }).panels);
const isTyping = (value: unknown): value is PanelTyping =>
  !!value &&
  typeof value === 'object' &&
  (value as { schema?: unknown }).schema === 'vide.paneling.typing@1' &&
  Array.isArray((value as { panels?: unknown }).panels);
const isMembers = (value: unknown): value is MemberSet =>
  !!value &&
  typeof value === 'object' &&
  (value as { schema?: unknown }).schema === 'vide.paneling.members@1' &&
  Array.isArray((value as { members?: unknown }).members);
const num = (params: PanelRowsInput['params'], key: string) => {
  const value = params[key]?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};
const mm = (m: number) => String(Math.round(m * 10000) / 10);
/** A short stable key part for a joint between two lattice vertices (vertex keys hold `|`). */
export const jointRef = (keys: readonly [string, string]) =>
  createHash('sha256')
    .update([...keys].sort().join('\n'))
    .digest('hex')
    .slice(0, 12);

/** A short stable key part for a lattice vertex (node marks). */
export const nodeRef = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 12);
/** The typing fingerprint (`vide-panel-<type>-<first 6>` block names, SPEC-16.9 6). */
export const typingHashOf = (typing: PanelTyping) =>
  fingerprint(['vide.paneling.typing@1', typing.membersHash, typing.settingsHash]);
/** The flat setting values the kit reads. */
const flatValues = (params: PanelRowsInput['params']) =>
  Object.fromEntries(Object.entries(params).map(([key, p]) => [key, p?.value]));

/** The layout fingerprint used in the make keys (`makeKey`, SPEC-16.9 6): the same value stage 2
 *  writes as `MemberSet.layoutHash`, so preview, member and joint keys share one middle part. */
export const layoutHashOf = (layout: PanelLayout) => layoutFingerprint(layout);

/** Items, the surface header and what stops the make, for one 패널링 declaration. */
export function panelRows(input: PanelRowsInput): PanelRows {
  const { decl, params } = input;
  const problems: string[] = [];
  const flatnessTol = num(params, 'flatnessTol');
  const out: PanelRows = {
    items: [],
    problems,
    deviationLimit: flatnessTol ?? DEVIATION_LIMIT_DEFAULT,
  };
  const layout = isLayout(input.layout) ? input.layout : undefined;
  if (!layout) {
    problems.push('1단계 미리보기 결과가 없습니다');
    return out;
  }
  const stage = stageOfStep(input.stepId);
  const sources = stageSources(input.manifestParams, params);
  const assumed = stagesUpTo(stage).some((s) => sources.assumed[s].length);
  const shared: [string, string][] = [['vide-assumed', assumed ? 'true' : 'false']];
  const byId = new Map(layout.panels.map((p) => [p.id, p]));
  const statusOf = (panel: { boundary: boolean; pole: boolean } | undefined) =>
    panel?.pole ? PANEL_STATUS.indexOf('pole') : panel?.boundary ? 1 : 0;

  if (input.stepId === TYPING_STEP) return typingRows(input, out, layout, shared, statusOf);

  if (decl.template === 'vide.bake.curves@1') {
    // Joint centre lines of stage 2 (줄눈 선, SPEC-16.6 1).
    const members = isMembers(input.output) ? input.output : undefined;
    if (!members) {
      problems.push('2단계 부재 결과가 없습니다');
      return out;
    }
    const layoutHash = members.layoutHash;
    out.layoutHash = layoutHash;
    const joint = num(params, 'joint');
    const seen = new Set<string>();
    for (const row of members.joints) {
      const key = makeKey('joint', layoutHash, jointRef(row.keys));
      if (seen.has(key)) continue;
      seen.add(key);
      const item: CurveItem = {
        key,
        attrs: [
          ...shared,
          ...(joint !== undefined ? [['vide-joint', mm(joint)] as [string, string]] : []),
        ],
        curve: { kind: 'polyline', points: row.line as Vec3[] },
      };
      out.items.push(item);
    }
    return out;
  }

  const sample = input.sample;
  if (!sample) {
    problems.push('기준 면 표본이 없습니다 · 기준 면을 다시 읽으세요');
    return out;
  }
  const samplers = new Map(sample.faces.map((face) => [face.faceIndex, face]));
  const sampler = new Map<number, ReturnType<typeof faceSampler>>();
  const pointAt = (faceIndex: number, u: number, v: number): Vec3 | undefined => {
    let s = sampler.get(faceIndex);
    if (!s) {
      const face = samplers.get(faceIndex);
      if (!face) return undefined;
      s = faceSampler(face);
      sampler.set(faceIndex, s);
    }
    return s.point(u, v) as Vec3;
  };
  const header = (
    kind: 'preview' | 'member',
    layoutHash: string,
    offset: number,
  ): SurfaceHeader => ({
    objectId: sample.source.objectId,
    faces: sample.faces.map((face) => ({ index: face.faceIndex, hash: face.geometryHash })),
    keyPrefix: makeKey(kind, layoutHash, ''),
    offset,
    budgetMs: PANEL_BUDGET_MS,
    failLayerPath: `${input.layerRoot}::${FAIL_LAYER}`,
    attrs: shared,
  });
  const panelItem = (
    prefix: string,
    fields: Omit<PanelItem, 'key' | 'attrs' | 'expect'>,
    expect: Vec3[],
  ): PanelItem => ({ key: prefix + fields.id, attrs: [], ...fields, expect });

  if (decl.template === 'vide.bake.panels-uv@1') {
    const layoutHash = layoutHashOf(layout);
    out.layoutHash = layoutHash;
    out.surface = header('preview', layoutHash, 0);
    for (const panel of layout.panels) {
      if (panel.failure?.code === 'dropped') continue;
      out.items.push(
        panelItem(
          out.surface.keyPrefix,
          {
            id: panel.id,
            faceIndex: panel.faceIndex,
            width: panel.width,
            height: panel.height,
            status: statusOf(panel),
            fail: panel.failure?.code ?? '',
            uv: panel.uv,
          },
          panel.corners as Vec3[],
        ),
      );
    }
  } else if (decl.template === 'vide.bake.panel-solids@1') {
    const members = isMembers(input.output) ? input.output : undefined;
    if (!members) {
      problems.push('2단계 부재 결과가 없습니다');
      return out;
    }
    const thickness = num(params, 'thickness') ?? members.members.find((m) => m)?.thickness;
    if (thickness === undefined || !(thickness > 0)) {
      problems.push('두께가 없습니다');
      return out;
    }
    // `outside` is toward the reference normal: the face normal, reversed by [뒤집기] (SPEC-16.2 3).
    const inside = params.thicknessSide?.value === 'inside';
    const flip = params.flip?.value === true;
    const offset = thickness * (inside ? -1 : 1) * (flip ? -1 : 1);
    const joint = num(params, 'joint');
    out.layoutHash = members.layoutHash;
    out.surface = header('member', members.layoutHash, offset);
    out.surface.attrs = [
      ...shared,
      ['vide-thickness', mm(thickness)],
      ...(joint !== undefined ? [['vide-joint', mm(joint)] as [string, string]] : []),
    ];
    for (const member of members.members) {
      const panel = byId.get(member.panelId);
      if (!panel) {
        problems.push(`${member.panelId}: 1단계 배치에 없는 패널입니다 · 다시 계산하세요`);
        continue;
      }
      if (panel.failure?.code === 'dropped') continue;
      const expect = member.uv.map(([u, v]) => pointAt(panel.faceIndex, u, v));
      if (expect.some((p) => !p)) {
        problems.push(`${member.panelId}: 표본에 없는 면입니다`);
        continue;
      }
      out.items.push(
        panelItem(
          out.surface.keyPrefix,
          {
            id: member.panelId,
            faceIndex: panel.faceIndex,
            width: member.flatSize[0],
            height: member.flatSize[1],
            status: statusOf(panel),
            fail: member.failure?.code ?? panel.failure?.code ?? '',
            uv: member.uv,
          },
          expect as Vec3[],
        ),
      );
    }
  } else problems.push(`패널링 결과로 만들 수 없는 틀입니다: ${decl.template}`);
  if (out.surface) {
    problems.push(...surfaceHeaderProblems(out.surface));
    const faces = new Set(out.surface.faces.map((f) => f.index));
    for (const item of out.items as PanelItem[])
      if (!faces.has(item.faceIndex)) problems.push(`${item.id}: 표본에 없는 면 ${item.faceIndex}`);
  }
  return out;
}

/**
 * Stage-3 rows (T-257): the type blocks, the connection marks, the cut outlines and their numbers.
 */
function typingRows(
  input: PanelRowsInput,
  out: PanelRows,
  layout: PanelLayout,
  shared: [string, string][],
  statusOf: (panel: { boundary: boolean; pole: boolean } | undefined) => number,
): PanelRows {
  const { decl, params } = input;
  const problems = out.problems;
  const typing = isTyping(input.output) ? input.output : undefined;
  const members = isMembers(input.members) ? input.members : undefined;
  if (!typing) {
    problems.push('3단계 최적화·타입화 결과가 없습니다');
    return out;
  }
  if (!members) {
    problems.push('2단계 부재 결과가 없습니다');
    return out;
  }
  const layoutHash = members.layoutHash;
  out.layoutHash = layoutHash;
  const byId = new Map(layout.panels.map((p) => [p.id, p]));
  const typeOf = new Map(typing.panels.map((t) => [t.panelId, t.type]));
  const { path } = itemsPath(decl);

  if (isBlockTemplate(decl.template)) {
    const sample = input.sample;
    if (!sample) {
      problems.push('기준 면 표본이 없습니다 · 기준 면을 다시 읽으세요');
      return out;
    }
    const thickness =
      num(params, 'thickness') ?? members.members.find((m) => !m.failure)?.thickness;
    if (thickness === undefined || !(thickness > 0)) {
      problems.push('두께가 없습니다');
      return out;
    }
    const joint = num(params, 'joint');
    // The block frame's +Z is the front (reference) normal: `outside` pushes the plate that way.
    const signed = params.thicknessSide?.value === 'inside' ? -thickness : thickness;
    const direction = previewSettingsFromParams(flatValues(params)).direction.value;
    const placed = typePlacements({ sample, layout, members, typing, direction });
    const hash = typingHashOf(typing).slice(0, 6);
    const nameOf = (type: string) => `vide-panel-${type}-${hash}`;
    const blocks: BlockHeader = {
      keyPrefix: makeKey('type', layoutHash, ''),
      hash,
      budgetMs: PANEL_BUDGET_MS,
      failLayerPath: `${input.layerRoot}::${FAIL_LAYER}`,
      attrs: [
        ...shared,
        ['vide-thickness', mm(thickness)],
        ...(joint !== undefined ? [['vide-joint', mm(joint)] as [string, string]] : []),
      ],
      defs: placed.blocks.map((b) => ({
        name: nameOf(b.type),
        type: b.type,
        thickness: signed,
        outline: b.outline.map(([x, y]) => [x, y] as [number, number]),
      })),
    };
    out.blocks = blocks;
    for (const p of placed.placements)
      out.items.push({
        key: blocks.keyPrefix + p.id,
        attrs: [],
        id: p.id,
        def: nameOf(p.type),
        cls: p.class,
        status: statusOf(byId.get(p.id)),
        flatness: p.flatness,
        width: p.size[0],
        height: p.size[1],
        fail: '',
        rotation: p.rotation,
        origin: p.origin as Vec3,
        outline: [],
      } satisfies BlockItem);
    for (const f of placed.failures)
      out.items.push({
        key: blocks.keyPrefix + f.id,
        attrs: [],
        id: f.id,
        def: '',
        cls: 'flat',
        status: statusOf(byId.get(f.id)),
        flatness: 0,
        width: 0,
        height: 0,
        fail: f.code,
        rotation: [],
        origin: [0, 0, 0],
        outline: f.outline as Vec3[],
      } satisfies BlockItem);
    problems.push(...blockHeaderProblems(blocks));
    return out;
  }

  if (decl.template === 'vide.bake.textdot@1' && !path.startsWith('panels')) {
    // 결합부 표식 (SPEC-16.7 5): node types at their vertices, joint types at the shared edges' middles.
    const at = new Map<string, Vec3>();
    for (const p of layout.panels)
      p.vertexKeys.forEach((key, i) => {
        if (!at.has(key)) at.set(key, p.corners[i] as Vec3);
      });
    for (const node of typing.nodeAt)
      out.items.push({
        key: makeKey('node', layoutHash, nodeRef(node.key)),
        attrs: [...shared, ['vide-connection', 'node'], ['vide-mark', node.type]],
        text: node.type,
        point: node.at as Vec3,
      } satisfies TextDotItem);
    const seen = new Set<string>();
    for (const joint of typing.jointAt) {
      const a = at.get(joint.keys[0]);
      const b = at.get(joint.keys[1]);
      const key = makeKey('joint', layoutHash, jointRef(joint.keys));
      if (!a || !b || seen.has(key)) continue;
      seen.add(key);
      out.items.push({
        key,
        attrs: [
          ...shared,
          ['vide-connection', 'joint'],
          ['vide-mark', joint.type],
          ['vide-panel-id', `${joint.panels[0]} ${joint.panels[1]}`],
        ],
        text: joint.type,
        point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
      } satisfies TextDotItem);
    }
    return out;
  }

  if (decl.template === 'vide.bake.curves@1' || decl.template === 'vide.bake.textdot@1') {
    // 재단 윤곽 (SPEC-16.7 6): flat outlines laid on XY beside the surface, and their numbers.
    for (const cut of cutSheet(layout, typing)) {
      const key = makeKey('cut', layoutHash, cut.id);
      const attrs: [string, string][] = [
        ...shared,
        ['vide-panel-id', cut.id],
        ['vide-panel-type', typeOf.get(cut.id) ?? cut.type],
      ];
      if (decl.template === 'vide.bake.curves@1')
        out.items.push({
          key,
          attrs,
          curve: { kind: 'polyline', points: cut.outline },
        } satisfies CurveItem);
      else
        out.items.push({
          key: `${key}:no`,
          attrs,
          text: cut.id,
          point: cut.label,
        } satisfies TextDotItem);
    }
    return out;
  }
  problems.push(`3단계 결과로 만들 수 없는 틀입니다: ${decl.template}`);
  return out;
}

/** The contract failure code of a template reason (`UV_OUTSIDE_TRIM`, `NOT_CLOSED`, …). */
export function failureCode(reason: string) {
  if (reason === 'UV_OUTSIDE_TRIM') return 'outside-trim';
  if (reason === 'NOT_CLOSED') return 'not-closed';
  if (reason === 'NO_TYPE') return 'degenerate';
  if (/^[a-z][a-z-]+$/.test(reason)) return reason;
  return 'make-failed';
}
