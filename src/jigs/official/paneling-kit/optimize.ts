// 3단계 최적화·타입화 (SPEC-16.7, PLAN-49 T-256): `SurfaceSample` + `PanelLayout` + `MemberSet` +
// `OptimizeSettings` → `PanelTyping`.
//
// Per panel, in number order (face, row, column): the stage-2 plate (the member's joint-reduced UV
// outline) on the surface → flatness against the best-fit plane (flatness.ts) → the curvature class
// (classify.ts) → the flat plate when planarizing ('best-fit' for every panel; with 'none' only to
// draw the cut outline of a panel already within the flatness tolerance) → the shape for typing
// (typing.ts: the flat plate's check points, or the surface's when not planarized) → the cut outline
// (unroll.ts). Then the type grouping, the planarization gaps over shared vertex keys and the nodes
// and joints (connections.ts).
//
// A panel failed in stage 1 or 2 (or whose plate has no area here) keeps its failure, takes no part
// in typing, nodes or joints, and is listed with the placeholder type `T-00` (no such type exists in
// `types`). A panel farther than the tolerance from its type's representative after a merge for the
// largest type count gets `over-type-tol` and is listed in `overTypeTol` — never silently fitted.
// 'pq' (전체 평면 사각 최적화) is not ready (T-259): it runs as 'best-fit' and says so in the notes.

import {
  geomTol,
  optimizeSettingsSchema,
  type MemberSet,
  type OptimizeSettings,
  type PanelLayout,
  type PanelTyping,
  type PreviewSettings,
  type SurfaceSample,
} from '../../../contracts/paneling.ts';
import { curvatureClass, higherClass, type CurvatureClass } from './classify.ts';
import { connections, type ConnectionPanel } from './connections.ts';
import {
  measurePlate,
  offSurface,
  planarGaps,
  planarize,
  polygonArea3,
  projectToPlane,
  type KeyedMove,
  type PlateGeometry,
} from './flatness.ts';
import { fingerprint } from './hash.ts';
import { faceSampler, type FaceSampler } from './sample.ts';
import { comparePanels } from './schedule.ts';
import { settingValues } from './settings.ts';
import { groupShapes, makeShape, type Shape } from './typing.ts';
import { patternAxis, plateFrame, unrollPlate } from './unroll.ts';
import { scale3, sub3, type Vec2, type Vec3 } from './vec.ts';

export type OptimizeOutcome =
  | { ok: true; typing: PanelTyping; notes: string[]; ms: number }
  | { ok: false; code: 'BAD_SETTINGS' | 'NO_PANELS'; message: string };

export interface OptimizeInput {
  sample: SurfaceSample;
  layout: PanelLayout;
  members: MemberSet;
  /** Stage-1 direction (pattern axis and start corner for the cut outline, `flip` for the front). */
  direction: PreviewSettings['direction']['value'];
  settings: OptimizeSettings;
}

type Failure = PanelTyping['panels'][number]['failure'];

interface Work {
  id: string;
  index: number;
  keys: string[] | null;
  sampler: FaceSampler;
  plate: PlateGeometry | null;
  cls: CurvatureClass;
  flat: Vec3[] | null;
  shape: Shape | null;
  failure: Failure;
  layoutCorners: Vec3[];
  layoutUV: Vec2[];
  layoutKeys: string[];
}

const PLACEHOLDER = 'T-00';
const typeName = (i: number) => `T-${String(i + 1).padStart(2, '0')}`;

/** Stage 3: flatness, planarization, curvature classes, types, nodes, joints and cut outlines. */
export function optimizePanels(input: OptimizeInput): OptimizeOutcome {
  const started = performance.now();
  const parsed = optimizeSettingsSchema.safeParse(input.settings);
  if (!parsed.success) {
    const maxTypes = (input.settings as { maxTypes?: { value?: unknown } })?.maxTypes?.value;
    return {
      ok: false,
      code: 'BAD_SETTINGS',
      message:
        typeof maxTypes === 'number' && maxTypes < 1
          ? '최대 타입 수는 1 이상이어야 합니다(제한 없음은 빈 값)'
          : `3단계 설정값이 맞지 않습니다 · ${parsed.error.issues[0]?.path.join('.')}`,
    };
  }
  const settings = parsed.data;
  const { sample, layout, members, direction } = input;
  const flip = direction.flip ? -1 : 1;
  const tol = geomTol(sample);
  const flatnessTol = settings.flatnessTol.value;
  const typeTol = settings.typeTol.value;
  const notes: string[] = [];
  let method = settings.planarize.value;
  if (method === 'pq') {
    notes.push('전체 평면 사각 최적화는 준비 중입니다 · 패널별 최적 평면으로 계산했습니다');
    method = 'best-fit';
  }
  const samplers = new Map(sample.faces.map((f) => [f.faceIndex, faceSampler(f)]));
  const memberOf = new Map(members.members.map((m) => [m.panelId, m]));
  const panels = layout.panels.slice().sort(comparePanels);
  if (!panels.length) return { ok: false, code: 'NO_PANELS', message: '패널이 0개입니다' };

  // ── per panel ──
  const work: Work[] = panels.map((p, index) => {
    const sampler = samplers.get(p.faceIndex) ?? samplers.values().next().value!;
    const w: Work = {
      id: p.id,
      index,
      keys: null,
      sampler,
      plate: null,
      cls: 'flat',
      flat: null,
      shape: null,
      failure: p.failure,
      layoutCorners: p.corners as Vec3[],
      layoutUV: p.uv as Vec2[],
      layoutKeys: p.vertexKeys,
    };
    const m = memberOf.get(p.id);
    if (!w.failure && !m)
      w.failure = {
        code: 'degenerate',
        message: '2단계 부재가 없습니다 · 2단계를 다시 계산하세요',
      };
    if (!w.failure && m?.failure) w.failure = m.failure;
    if (w.failure || !m) return w;
    const plate = measurePlate(sampler, m.uv as Vec2[], flip);
    w.plate = plate;
    w.keys = m.uv.length === p.vertexKeys.length ? p.vertexKeys : null;
    w.cls = curvatureClass(sampler, plate.checkUV, settings.flatRadius.value).class;
    const projected = planarize(plate);
    if (polygonArea3(projected) <= tol * tol) {
      w.failure = { code: 'degenerate', message: '판 넓이가 0' };
      return w;
    }
    if (method === 'best-fit' || plate.flatness <= flatnessTol) w.flat = projected;
    w.shape =
      method === 'best-fit'
        ? makeShape({
            vertices: projected,
            mids: projected.map((a, i) => {
              const b = projected[(i + 1) % projected.length];
              return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] as Vec3;
            }),
            centre: projectToPlane(plate.centre, plate.plane),
            normal: plate.plane.normal,
          })
        : makeShape({
            vertices: plate.surf,
            mids: plate.mids,
            centre: plate.centre,
            normal: plate.plane.normal,
          });
    // Panels of another target opening ratio are another type (SPEC-16.13 4).
    if (p.opening) w.shape.cls = Math.round(p.opening.ratio * 1000);
    return w;
  });

  // ── planarization gaps and distance from the surface ──
  const planarized = method === 'best-fit';
  const moves: KeyedMove[] = [];
  const off = new Array<number | null>(work.length).fill(null);
  if (planarized)
    for (const w of work) {
      if (!w.plate || !w.flat || w.failure) continue;
      off[w.index] = offSurface(w.sampler, w.plate, w.flat, flip);
      if (w.keys)
        w.keys.forEach((key, i) =>
          moves.push({ panel: w.index, key, move: sub3(w.flat![i], w.plate!.surf[i]) }),
        );
    }
  const gaps = planarized ? planarGaps(moves, work.length) : null;

  // ── types ──
  const typed = work.filter((w) => w.shape && !w.failure);
  const grouping = groupShapes(
    typed.map((w) => w.shape!),
    typeTol,
    settings.maxTypes.value,
  );
  const frameOf = (w: Work) => {
    const plate = w.plate!;
    const cuv = plate.checkUV[plate.checkUV.length - 1];
    const axis = patternAxis(w.sampler, cuv, direction.axis, direction.startCorner);
    const pts = w.flat ?? planarize(plate);
    return { pts, frame: plateFrame(plate.plane.normal, axis, sub3(pts[1], pts[0])) };
  };
  const typeOfWork = new Map<number, number>();
  const devOfWork = new Map<number, number>();
  typed.forEach((w, k) => {
    typeOfWork.set(w.index, grouping.typeOf[k]);
    devOfWork.set(w.index, grouping.deviation[k]);
  });
  const eps = typeTol * 1e-9 + 1e-12;
  const overTypeTol: string[] = [];
  for (const w of typed)
    if ((devOfWork.get(w.index) ?? 0) > typeTol + eps) {
      w.failure = {
        code: 'over-type-tol',
        message: `타입 대표와의 편차 ${((devOfWork.get(w.index) ?? 0) * 1000).toFixed(1)} mm가 타입 허용 오차 ${(typeTol * 1000).toFixed(1)} mm를 넘음`,
      };
      overTypeTol.push(w.id);
    }
  const types: PanelTyping['types'] = grouping.types.map((g, i) => {
    const rep = typed[g.rep];
    let cls: CurvatureClass = 'flat';
    let maxDeviation = 0;
    for (const s of g.members) {
      cls = higherClass(cls, typed[s].cls);
      maxDeviation = Math.max(maxDeviation, grouping.deviation[s]);
    }
    const { pts, frame } = frameOf(rep);
    return {
      type: typeName(i),
      class: cls,
      count: g.members.length,
      vertexCount: rep.shape!.n,
      representative: rep.id,
      size: unrollPlate(pts, frame).size,
      maxDeviation,
      mirrorOf: g.mirrorOf === null ? null : typeName(g.mirrorOf),
    };
  });

  // ── nodes and joints ──
  const connected: ConnectionPanel[] = typed
    .filter((w) => w.keys)
    .map((w) => ({
      id: w.id,
      keys: w.layoutKeys,
      corners: w.layoutCorners,
      normals: w.layoutUV.map(([u, v]) => scale3(w.sampler.normal(u, v), flip)),
      planeNormal: w.plate!.plane.normal,
      centre: w.plate!.centre,
    }));
  const joined = connections(connected, settings.nodeAngleStep.value, typeTol);
  notes.push(...joined.notes);

  // ── per panel output ──
  const out: PanelTyping['panels'] = work.map((w) => {
    const t = typeOfWork.get(w.index);
    const plate = w.plate;
    return {
      panelId: w.id,
      type: t === undefined ? PLACEHOLDER : typeName(t),
      class: w.cls,
      flatness: plate ? plate.flatness : 0,
      planarGap: gaps && plate && w.flat && t !== undefined ? gaps[w.index] : null,
      offSurface: t !== undefined ? off[w.index] : null,
      deviation: devOfWork.get(w.index) ?? 0,
      flat: t !== undefined && w.flat ? unrollPlate(w.flat, frameOf(w).frame).outline : null,
      failure: w.failure,
    };
  });
  const typing: PanelTyping = {
    schema: 'vide.paneling.typing@1',
    membersHash: fingerprint([members.layoutHash, members.settingsHash]),
    settingsHash: fingerprint(settingValues(settings)),
    panels: out,
    types,
    nodes: joined.nodes,
    joints: joined.joints,
    nodeAt: joined.nodeAt,
    jointAt: joined.jointAt,
    overTypeTol,
    maxTypesUnmet: grouping.unmet,
  };
  if (grouping.unmet !== null)
    notes.push(
      `꼭짓점 수${panels.some((p) => p.opening) ? '·개구율이' : '가'} 달라 합칠 수 없는 타입이 남아 최대 타입 수 ${settings.maxTypes.value}개를 지킬 수 없습니다 · 가능한 최소 ${grouping.unmet}개`,
    );
  return { ok: true, typing, notes, ms: Math.round(performance.now() - started) };
}
