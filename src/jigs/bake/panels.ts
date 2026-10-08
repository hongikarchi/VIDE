// 패널링 rows for Rhino에 만들기 (SPEC-16.9, PLAN-49 T-255, ARCH-03 §9.1): the adapter that turns a
// stage result into template items. Stage 1 (`PanelLayout`) → `vide.bake.panels-uv@1` open faces;
// stage 2 (`MemberSet`) → `vide.bake.panel-solids@1` closed members and the joint centre lines as
// `vide.bake.curves@1`. Panels go as UV outlines with the face they lie on; Rhino rebuilds them on
// the ORIGINAL face after checking the face fingerprint the sample was read with. Keys follow
// `makeKey` (`<kind>:<layout hash 8>:<panel id>`), so a new layout never reuses a key and a stage-2
// change replaces the same panel. A panel the engine already failed is sent too, to be left on the
// failure layer as its outline and number (never silently missing, SPEC-16.10); dropped panels
// (boundary rule 'drop') are the person's choice and are not made.

import { createHash } from 'node:crypto';
import {
  makeKey,
  type MemberSet,
  type PanelLayout,
  type SurfaceSample,
} from '../../contracts/paneling.ts';
import { faceSampler, layoutFingerprint } from '../official/paneling-kit/index.ts';
import type { BakeDecl } from '../runtime/manifest.ts';
import type { ParamValue } from '../runtime/params.ts';
import { stageSources, stagesUpTo, stageOfStep } from '../runtime/paneling-confirmed.ts';
import {
  isPanelTemplate,
  PANEL_STATUS,
  surfaceHeaderProblems,
  type BakeItem,
  type CurveItem,
  type PanelItem,
  type SurfaceHeader,
  type Vec3,
} from './data-block.ts';

/** Time limit of one panel body inside Rhino (ms): about 500 members take 1 s (SPIKE §7). */
export const PANEL_BUDGET_MS = 60_000;
/** The jig's stage-1 step: its `PanelLayout` gives every panel's face and status (PLAN-49 T-253: ids fixed). */
export const LAYOUT_STEP = 'preview';
/** The failure layer under the output layer (SPEC-16.9 3). */
export const FAIL_LAYER = '실패';
/** Sample-vs-surface difference above which the card says '표본이 거칩니다' without a tolerance. */
export const DEVIATION_LIMIT_DEFAULT = 0.003;

/** Does this declaration take its rows from the 패널링 adapter? */
export const isPanelDecl = (decl: Pick<BakeDecl, 'template' | 'rows'>) =>
  isPanelTemplate(decl.template) || decl.rows === 'paneling';

export interface PanelRowsInput {
  decl: BakeDecl;
  /** The step the declaration names (`step.<id>`), and its output. */
  stepId: string;
  output: unknown;
  /** Stage 1 output (members and joints need the panels' faces and status). */
  layout: unknown;
  sample: SurfaceSample | null;
  manifestParams: readonly { key: string; group?: string }[];
  params: Readonly<Record<string, ParamValue>>;
  layerRoot: string;
}
export interface PanelRows {
  items: BakeItem[];
  surface?: SurfaceHeader;
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

/** The contract failure code of a template reason (`UV_OUTSIDE_TRIM`, `NOT_CLOSED`, …). */
export function failureCode(reason: string) {
  if (reason === 'UV_OUTSIDE_TRIM') return 'outside-trim';
  if (reason === 'NOT_CLOSED') return 'not-closed';
  if (/^[a-z][a-z-]+$/.test(reason)) return reason;
  return 'make-failed';
}
