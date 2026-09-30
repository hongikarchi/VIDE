// S-06 frame jig ⑫ Rhino에 만들기 계획 (PLAN-23 T-056, SPEC-06.12·.13, SPEC-07.12): what the
// bakes of VIDE (src/jigs/bake) make in Rhino from the corrected frame. Only top-of-steel lines are
// planned as lines — axes, column lines, girder top lines (arcs kept as arcs) and beam top lines —
// for `{layerRoot}::jig 상단선`; H members hang below their top line with the web vertical, and H
// columns follow their strong axis, for `{layerRoot}::jig 부재`. Sections come from step 'sizing'
// and marks from step 'schedule'; a member without a known section is listed, not made. No centre
// lines. Keys are built from the result ids only (`girder:G01`, `column:C01`, …), so recomputing
// gives the same keys and a bake replaces only its own objects. Members need a confirmed analysis
// at bake time (gate `analysis-confirmed`); a plan made from preview sizing says so
// (`previewOnly`) and the bake refuses its members. Pure: (inputs, params) → JSON, metres.

type Vec3 = [number, number, number];

// --- inputs (the contract fields of the steps this one reads) ------------------------------------

export interface ArcIn {
  center: Vec3;
  radius: number;
  startDeg: number;
  endDeg: number;
  sweepDeg?: number;
  plane: 'vertical' | 'plan';
}
export interface GirderIn {
  id: string;
  sourceId?: string;
  points: Vec3[];
  kind?: 'line' | 'arc';
  arc?: ArcIn;
  supports?: { columnId: string; t: number }[];
}
export interface ColumnIn {
  /** Drawn column key of step 'girders' (`id`) or of a layout step (`key`). */
  id?: string;
  key?: string;
  sourceId?: string;
  bottom?: Vec3;
  base?: Vec3;
  top?: Vec3;
  line?: [Vec3, Vec3];
  /** Girders the column carries (step 'model'); the girders' supports are read otherwise. */
  girders?: string[];
}
export interface BeamIn {
  id: string;
  points: Vec3[];
}
export interface HeightIn {
  columnId: string;
  topZ: number;
  bottomZ: number;
  length_m?: number;
}
export interface SizingGroupIn {
  id: string;
  role: 'column' | 'girder' | 'beam' | 'edge';
  memberIds: string[];
  sectionId: string | null;
  sectionName?: string | null;
  maxRatio?: number | null;
  status: 'ok' | 'no-candidate' | 'unchecked';
}
export interface SectionIn {
  name: string;
  h_mm: number;
  b_mm: number;
  tw_mm: number;
  tf_mm: number;
  kgpm: number;
}
export interface SizingIn {
  schema?: string;
  previewOnly: boolean;
  groups: SizingGroupIn[];
  sectionsById: Record<string, SectionIn>;
}
export interface ScheduleIn {
  prefix?: string;
  marks: { memberId: string; mark: string }[];
}
export interface BakePlanInputs {
  steps: {
    girders: { girders: GirderIn[]; columns?: ColumnIn[] };
    /** Columns of the analysis model (`key: 'col:…'`, top on the girder's top of steel). */
    model?: { columns?: ColumnIn[] };
    beams?: { beams?: BeamIn[]; edgeCantilevers?: BeamIn[] };
    /** Column rows of a layout step, used when the model gives none. */
    columns?: { columns?: ColumnIn[] };
    /** Floored column heights (step 'heights'); drawn heights otherwise. */
    heights?: { rows?: HeightIn[] };
    axes?: { axes?: { key: string; line: [Vec3, Vec3] }[] };
    sizing?: SizingIn;
    schedule?: ScheduleIn;
  };
}
export interface BakePlanParams {
  /** One-level layer names under the jig's fixed output parent (`{layerRoot}::…`). */
  linesLayer: string;
  membersLayer: string;
}
export const DEFAULT_BAKEPLAN_PARAMS: BakePlanParams = {
  linesLayer: 'jig 상단선',
  membersLayer: 'jig 부재',
};

// --- output ---------------------------------------------------------------------------------------

export type LineKind = 'girder' | 'beam' | 'column' | 'axis';
export interface PlanArc {
  center: Vec3;
  radius: number;
  plane: 'vertical' | 'plan';
}
export interface BakeLine {
  key: string;
  kind: LineKind;
  /** Polyline points, or [start, interior, end] when `arc` is given. */
  points: Vec3[];
  arc?: PlanArc;
  layer: string;
  mark?: string;
}
export interface BakeMember {
  key: string;
  /** Design member id of the analysis model (`G:G01`, `B:B01`, `A:E01`, `col:…`). */
  memberId: string;
  mark: string;
  sectionId: string;
  sectionName: string;
  /** Top of steel (beams) or base → top (columns); [start, interior, end] when `arc`. */
  points: Vec3[];
  arc?: PlanArc;
  role: 'column' | 'girder' | 'beam' | 'edge';
  webVertical: true;
  layer: string;
  status: SizingGroupIn['status'];
  /** Section dimensions the bake templates take. */
  H_mm: number;
  B_mm: number;
  tw_mm: number;
  tf_mm: number;
  kgpm: number;
  length_m: number;
  /** Columns: flange direction in plan, so the web runs along the main girder. */
  strongAxis?: Vec3;
}
export interface BakePlanOutput {
  schema: 'vide.s06.bakePlan/1';
  params: BakePlanParams;
  /** The sections came from preview sizing: members are listed but not made. */
  previewOnly: boolean;
  lines: BakeLine[];
  members: BakeMember[];
  /** Sized members the plan could not make, with the reason. */
  skipped: { memberId: string; reason: string }[];
  summary: { lines: number; members: number; steel_t: number };
  notes: string[];
}

// --- helpers --------------------------------------------------------------------------------------

const r4 = (value: number) => Number((Math.round(value * 1e4) / 1e4).toFixed(4)) + 0;
const p3 = (p: readonly number[]): Vec3 => [r4(p[0]), r4(p[1]), r4(p[2] ?? 0)];
const finite3 = (p: unknown): p is Vec3 =>
  Array.isArray(p) && p.length >= 2 && p.slice(0, 3).every((v) => Number.isFinite(v));
const deg = Math.PI / 180;
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lengthOf = (points: readonly Vec3[]) =>
  points.slice(1).reduce((sum, p, i) => sum + dist(points[i], p), 0);
/** Key text the bake accepts (`bake-args-safe`): other characters become `_`, at most 64. */
const safe = (text: string) => text.replace(/[^A-Za-z0-9가-힣:_>.-]/g, '_').slice(0, 64);

/** [start, interior, end] of a girder arc from its description; null when it does not fit. */
function arcPoints(points: readonly Vec3[], arc: ArcIn): Vec3[] | null {
  const start = points[0],
    end = points[points.length - 1];
  const sweep = arc.sweepDeg ?? arc.endDeg - arc.startDeg;
  if (!(arc.radius > 0) || !finite3(arc.center) || !Number.isFinite(sweep)) return null;
  const angle = (arc.startDeg + sweep / 2) * deg;
  let mid: Vec3;
  if (arc.plane === 'plan') {
    mid = [
      arc.center[0] + arc.radius * Math.cos(angle),
      arc.center[1] + arc.radius * Math.sin(angle),
      (start[2] + end[2]) / 2,
    ];
  } else {
    const h = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (!(h > 0)) return null;
    const ax = (end[0] - start[0]) / h,
      ay = (end[1] - start[1]) / h;
    const c = Math.cos(angle) * arc.radius,
      s = Math.sin(angle) * arc.radius;
    mid = [arc.center[0] + ax * c, arc.center[1] + ay * c, arc.center[2] + s];
  }
  // The described arc must pass near the drawn polyline's middle (else keep the polyline).
  const near = Math.min(...points.map((p) => dist(p, mid)));
  const chord = dist(start, end);
  if (!(chord > 0) || near > Math.max(0.05, chord * 0.01)) return null;
  return [p3(start), p3(mid), p3(end)];
}
/** The top line of a girder: arcs as three points and their description, else the polyline. */
function topLine(g: GirderIn): { points: Vec3[]; arc?: PlanArc } | null {
  const points = (g.points ?? []).filter(finite3).map(p3);
  if (points.length < 2) return null;
  if (g.kind === 'arc' && g.arc) {
    const three = arcPoints(points, g.arc);
    if (three)
      return {
        points: three,
        arc: { center: p3(g.arc.center), radius: r4(g.arc.radius), plane: g.arc.plane },
      };
  }
  return { points };
}

interface Column {
  id: string;
  sourceId?: string;
  base: Vec3;
  top: Vec3;
  girders?: string[];
}
function columnsOf(inputs: BakePlanInputs, notes: string[]): Column[] {
  const rows =
    inputs.steps.model?.columns ??
    inputs.steps.columns?.columns ??
    inputs.steps.girders.columns ??
    [];
  const heights = new Map<string, HeightIn>();
  for (const h of inputs.steps.heights?.rows ?? []) heights.set(String(h.columnId), h);
  const out: Column[] = [];
  let floored = 0;
  for (const c of rows) {
    const id = String(c.key ?? c.id ?? c.sourceId ?? '');
    const base = c.bottom ?? c.base ?? c.line?.[0];
    const top = c.top ?? c.line?.[1];
    if (!id || !finite3(base) || !finite3(top)) continue;
    const h =
      heights.get(id) ??
      (c.sourceId ? (heights.get(c.sourceId) ?? heights.get(`col:${c.sourceId}`)) : undefined);
    const b = p3(base),
      t = p3(top);
    if (h && Number.isFinite(h.topZ) && Number.isFinite(h.bottomZ) && h.topZ > h.bottomZ) {
      t[2] = r4(h.topZ);
      b[2] = r4(h.bottomZ);
      floored++;
    }
    out.push({ id, sourceId: c.sourceId, base: [t[0], t[1], b[2]], top: t, girders: c.girders });
  }
  if (rows.length && !floored && !inputs.steps.heights)
    notes.push('높이 점검(heights) 결과가 없어 그린 기둥 길이 그대로 계획했습니다.');
  return out;
}

/** Plan unit vector across the main (longest) girder a column carries: the flange direction. */
function strongAxisOf(column: Column, girders: readonly GirderIn[]): Vec3 | undefined {
  let best: Vec3 | undefined,
    longest = 0;
  for (const g of girders) {
    const points = (g.points ?? []).filter(finite3);
    if (points.length < 2) continue;
    const carries = column.girders
      ? column.girders.includes(g.id)
      : (g.supports ?? []).some(
          (s) => s.columnId === column.id || (column.sourceId && s.columnId === column.sourceId),
        );
    if (!carries) continue;
    const a = points[0],
      b = points[points.length - 1];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    if (l > longest) {
      longest = l;
      best = [r4(-dy / l), r4(dx / l), 0];
    }
  }
  return best;
}

// --- the step -------------------------------------------------------------------------------------

export function bakePlan(
  inputs: BakePlanInputs,
  params: Partial<BakePlanParams> = {},
): BakePlanOutput {
  const p: BakePlanParams = { ...DEFAULT_BAKEPLAN_PARAMS, ...params };
  const notes: string[] = [];
  const steps = inputs.steps;
  const girders = steps.girders?.girders ?? [];
  const beams = steps.beams?.beams ?? [];
  const cantilevers = steps.beams?.edgeCantilevers ?? [];
  const columns = columnsOf(inputs, notes);
  const markOf = new Map<string, string>();
  for (const m of steps.schedule?.marks ?? []) markOf.set(m.memberId, m.mark);

  // Member id of the analysis model → geometry (model step: G:/B:/A:/col: keys).
  const geometry = new Map<
    string,
    { key: string; kind: LineKind; points: Vec3[]; arc?: PlanArc; column?: Column }
  >();
  for (const g of girders) {
    const line = topLine(g);
    if (line) geometry.set(`G:${g.id}`, { key: `girder:${g.id}`, kind: 'girder', ...line });
  }
  for (const b of beams) {
    const points = (b.points ?? []).filter(finite3).map(p3);
    if (points.length >= 2)
      geometry.set(`B:${b.id}`, { key: `beam:${b.id}`, kind: 'beam', points });
  }
  for (const a of cantilevers) {
    const points = (a.points ?? []).filter(finite3).map(p3);
    if (points.length >= 2)
      geometry.set(`A:${a.id}`, { key: `cantilever:${a.id}`, kind: 'beam', points });
  }
  for (const c of columns) {
    const name = c.sourceId ?? c.id.replace(/^col:/, '');
    const entry = {
      key: `column:${name}`,
      kind: 'column' as const,
      points: [c.base, c.top],
      column: c,
    };
    geometry.set(c.id.startsWith('col:') ? c.id : `col:${name}`, entry);
  }

  // Lines: axes, columns, girders, beams — every drawn or corrected line, sized or not.
  const lines: BakeLine[] = [];
  const lineKeys = new Set<string>();
  const addLine = (line: Omit<BakeLine, 'key' | 'layer'> & { key: string }) => {
    let key = safe(line.key);
    while (lineKeys.has(key)) key = safe(`${key}_`);
    lineKeys.add(key);
    lines.push({ ...line, key, layer: p.linesLayer });
  };
  for (const axis of steps.axes?.axes ?? [])
    if (finite3(axis.line?.[0]) && finite3(axis.line?.[1]))
      addLine({ key: `axis:${axis.key}`, kind: 'axis', points: axis.line.map(p3) });
  const byKey = new Map<string, string>();
  for (const [memberId, g] of geometry) if (!byKey.has(g.key)) byKey.set(g.key, memberId);
  const order: LineKind[] = ['column', 'girder', 'beam'];
  for (const kind of order)
    for (const [key, memberId] of byKey) {
      const g = geometry.get(memberId)!;
      if (g.kind !== kind) continue;
      const mark = markOf.get(memberId);
      addLine({
        key,
        kind,
        points: g.points,
        ...(g.arc ? { arc: g.arc } : {}),
        ...(mark ? { mark } : {}),
      });
    }

  // Members: every sized design member with a known section and geometry.
  const sizing = steps.sizing;
  const previewOnly = sizing ? sizing.previewOnly !== false : true;
  const members: BakeMember[] = [];
  const skipped: BakePlanOutput['skipped'] = [];
  const memberKeys = new Set<string>();
  if (!sizing) notes.push('단면 선정(sizing) 결과가 없어 부재는 계획하지 않았습니다.');
  for (const group of sizing?.groups ?? []) {
    const section = group.sectionId ? sizing!.sectionsById?.[group.sectionId] : undefined;
    for (const memberId of [...group.memberIds].sort()) {
      if (!section) {
        skipped.push({ memberId, reason: '단면 후보 없음' });
        continue;
      }
      const g = geometry.get(memberId);
      if (!g) {
        skipped.push({ memberId, reason: '형상을 찾지 못함' });
        continue;
      }
      const dims = [section.h_mm, section.b_mm, section.tw_mm, section.tf_mm];
      if (!dims.every((v) => Number.isFinite(v) && v > 0)) {
        skipped.push({ memberId, reason: '단면 치수가 없음' });
        continue;
      }
      let key = safe(g.key);
      while (memberKeys.has(key)) key = safe(`${key}_`);
      memberKeys.add(key);
      const role = g.kind === 'column' ? 'column' : group.role;
      // An arc's length is the drawn (segmented) arc's, not its three planning points'.
      const girder = g.arc ? girders.find((x) => `G:${x.id}` === memberId) : undefined;
      const length_m = r4(lengthOf(girder ? girder.points.filter(finite3) : g.points));
      const strongAxis =
        g.column && role === 'column' ? strongAxisOf(g.column, girders) : undefined;
      members.push({
        key,
        memberId,
        mark: markOf.get(memberId) ?? '',
        sectionId: group.sectionId!,
        sectionName: section.name,
        points: g.points,
        ...(g.arc ? { arc: g.arc } : {}),
        role,
        webVertical: true,
        layer: p.membersLayer,
        status: group.status,
        H_mm: section.h_mm,
        B_mm: section.b_mm,
        tw_mm: section.tw_mm,
        tf_mm: section.tf_mm,
        kgpm: section.kgpm,
        length_m,
        ...(role === 'column' ? { strongAxis: strongAxis ?? [1, 0, 0] } : {}),
      });
    }
  }
  if (sizing && previewOnly)
    notes.push('미확정 미리보기 해석의 단면입니다. 확정 해석 전에는 부재를 만들지 않습니다.');
  const unmarked = members.filter((m) => !m.mark).length;
  if (steps.schedule && unmarked) notes.push(`부호가 없는 부재 ${unmarked}개`);
  if (skipped.length) notes.push(`만들지 못한 부재 ${skipped.length}개(단면 후보·형상 없음)`);

  const steel_t = r4(members.reduce((sum, m) => sum + (m.kgpm * m.length_m) / 1000, 0));
  return {
    schema: 'vide.s06.bakePlan/1',
    params: p,
    previewOnly,
    lines,
    members,
    skipped,
    summary: { lines: lines.length, members: members.length, steel_t },
    notes,
  };
}

// --- members after the confirmed analysis ---------------------------------------------------------

export interface BakeMembersInputs {
  steps: {
    bakePlan: BakePlanOutput;
    model: {
      modelHash: string;
      model: { members: { id: string; section: string }[] };
      map: { physical: Record<string, string[]> };
    };
    /** Output of step 'analysisConfirmed' (runs only after a person pressed [해석 확정]). */
    analysisConfirmed?: { confirmed?: { modelHash: string } } | null;
  };
}

/**
 * Step 'bakeMembers' (SPEC-06.12 부재, SPEC-06.11 8): the members of the plan once a person has
 * confirmed the analysis. The runner reaches it only after [해석 확정], so the lines bake never
 * waits for it. Members are offered (`previewOnly: false`) only when the confirmed analysis is of
 * this model and every planned member carries the section that model was confirmed with; sections
 * chosen by preview sizing and not yet applied and confirmed again stay a preview (SPEC-06.12:
 * "선정 뒤 다시 확정하지 않은 단면으로는 만들지 않는다"). Lines are left to step 'bakePlan'.
 */
export function bakeMembers(inputs: BakeMembersInputs): BakePlanOutput {
  const plan = inputs.steps.bakePlan;
  const model = inputs.steps.model;
  const confirmed = inputs.steps.analysisConfirmed?.confirmed;
  const sectionOf = new Map(model.model.members.map((m) => [m.id, m.section]));
  let reason: string | null = null;
  if (!confirmed || confirmed.modelHash !== model.modelHash)
    reason = '이 모델의 확정 해석이 없어 부재를 만들지 않습니다.';
  else {
    const changed = plan.members.filter((m) =>
      (model.map.physical[m.memberId] ?? []).some((seg) => sectionOf.get(seg) !== m.sectionId),
    ).length;
    if (changed)
      reason = `선정 단면이 확정한 모델의 단면과 다른 부재 ${changed}개: 선정 단면을 모델에 적용하고 해석을 다시 확정해야 부재를 만듭니다.`;
  }
  const notes = plan.notes.filter((n) => !n.startsWith('미확정 미리보기 해석의 단면'));
  notes.push(reason ?? '확정 해석과 같은 단면입니다. 부재를 만들 수 있습니다.');
  return {
    ...plan,
    previewOnly: reason !== null,
    lines: [],
    summary: { ...plan.summary, lines: 0 },
    notes,
  };
}
