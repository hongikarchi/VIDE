// S-06 frame jig ④ 기초 간섭 (PLAN-23 T-051, SPEC-06.11 2, 결정 F2.3): the generated columns and
// caps run through the same diagnosis as the drawn layout (`diagnose()`, real footprints, signed
// separation): pile cap ↔ existing footing = 불가, open cut ↔ existing footing = 협의, column ↔ basin
// beam = 경고. For a 불가 column a nudge along its axis within `nudgeMax` is proposed when one exists
// and keeps every span within the limit — proposed, never applied. Columns of one new segment on
// both sides of an existing expansion joint are a warning for the civil office. The review list
// gathers what a person must look at.

import {
  allowedWindows,
  type Vec2,
  type Vec3,
} from '../../../../src/jigs/official/geometry-kit/index.ts';
import type { AssembleOutput } from './assemble.ts';
import type { AxesOutput } from './axes.ts';
import type { ColumnsOutput } from './columns.ts';
import {
  diagnose,
  type DiagnoseInputs,
  type DiagnoseOutput,
  type DiagnoseRow,
  type InterferenceRow,
} from './diagnose.ts';
import { panelShapes, verdictText, type ClashFill } from './diagnose-step.ts';
import type { FootprintsOutput } from './footprints.ts';
import { rectangle } from './footprints.ts';
import { VERDICT_LABEL } from './labels.ts';
import { footprintsOf, toDiagnoseRows, type SiteInput } from './roles.ts';

export interface InterferenceInputs {
  site: SiteInput;
  steps: {
    columns: ColumnsOutput;
    footprints: FootprintsOutput;
    axes: AxesOutput;
    assemble: AssembleOutput;
  };
}
export interface InterferenceParams {
  spanMax: number;
  columnSize: number;
  capClearance: number;
  openCutRule: 'consult' | 'forbid';
  nudgeMax: number;
  capSize: number;
}
export const DEFAULT_INTERFERENCE_PARAMS: InterferenceParams = {
  spanMax: 12,
  columnSize: 0.5,
  capClearance: 0.2,
  openCutRule: 'consult',
  nudgeMax: 0.6,
  capSize: 2.0,
};

export interface InterferenceOut extends InterferenceRow {
  at: Vec3;
  judgement: string;
  capText: string;
  cutText: string;
  basinText: string;
}
export interface NudgeRow {
  key: string;
  column: string;
  to: Vec2 | null;
  shift_m: number | null;
  along: string;
  judgement: string;
  text: string;
}
export interface ReviewRow {
  key: string;
  kind: string;
  judgement: string;
  text: string;
}
export interface InterferenceOutput {
  schema: 'vide.s06.interference/1';
  params: InterferenceParams;
  summary: DiagnoseOutput['summary'] & { nudges: number; ejCross: number; review: number };
  tables: {
    interference: InterferenceOut[];
    spans: AxesOutput['spans'];
    nudges: NudgeRow[];
    ejCross: {
      key: string;
      ej: string;
      segment: string;
      left: number;
      right: number;
      judgement: string;
      text: string;
    }[];
    review: ReviewRow[];
  };
  fills: {
    capClash: ClashFill[];
    cutClash: ClashFill[];
    basinClash: ClashFill[];
    spanOver: ClashFill[];
    nudges: ClashFill[];
  };
  missing: DiagnoseOutput['missing'];
  bands: { span: [number, number] };
  notes: string[];
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const round = (v: number, digits = 3) => Number(v.toFixed(digits));

function resolveParams(params: Partial<InterferenceParams>): InterferenceParams {
  const out = { ...DEFAULT_INTERFERENCE_PARAMS };
  for (const key of Object.keys(DEFAULT_INTERFERENCE_PARAMS) as (keyof InterferenceParams)[])
    if (params[key] !== undefined) Object.assign(out, { [key]: params[key] });
  for (const key of ['spanMax', 'columnSize', 'capClearance', 'nudgeMax', 'capSize'] as const)
    if (!Number.isFinite(out[key]) || out[key] < 0)
      throw new RangeError(`${key} ${String(out[key])}`);
  if (out.openCutRule !== 'consult' && out.openCutRule !== 'forbid')
    throw new RangeError('openCutRule');
  return out;
}
const measureText = (m: { verdict: InterferenceRow['verdict']; distance: number | null }) =>
  m.distance === null
    ? VERDICT_LABEL[m.verdict]
    : `${VERDICT_LABEL[m.verdict]} · ${m.distance < 0 ? `겹침 ${(-m.distance).toFixed(2)}` : m.distance.toFixed(2)} m`;

export function interference(
  inputs: InterferenceInputs,
  params: Partial<InterferenceParams> = {},
): InterferenceOutput {
  const p = resolveParams(params);
  const {
    columns: cols,
    footprints: feet,
    axes: axesOut,
    assemble: assembled,
  } = inputs.steps ?? ({} as InterferenceInputs['steps']);
  if (!cols || !feet || !axesOut || !assembled)
    throw new Error('STEPS_MISSING: 기둥·기초·축선 결과가 없습니다');
  const notes: string[] = [];

  // The generated layout as diagnosis rows: columns as vertical lines, caps as block instances.
  const columnRows: DiagnoseRow[] = cols.columns.map((c) => ({
    syncId: 'jig',
    id: c.key,
    layer: 'jig 기둥',
    name: c.mark,
    line: [...c.bottom, ...c.top],
  }));
  const capRows: DiagnoseRow[] = feet.caps.map((cap) => ({
    syncId: 'jig',
    id: cap.key,
    layer: 'jig 기초',
    block: { definition: cap.key, transform: IDENTITY },
  }));
  const existing = toDiagnoseRows('existingFootings', inputs.site?.existingFootings);
  const basin = toDiagnoseRows('basinGirders', inputs.site?.basinGirders);
  const diagnoseInputs: DiagnoseInputs = {
    columns: columnRows,
    newFootings: capRows,
    existingFootings: existing.rows,
    basinGirders: basin.rows,
    definitions: {
      jig: feet.definitions,
      existingFootings: existing.definitions,
      basinGirders: basin.definitions,
    },
  };
  if (!inputs.site?.basinGirders) delete diagnoseInputs.basinGirders;
  const output = diagnose(diagnoseInputs, {
    spanMax: p.spanMax,
    splitTol: 0.3,
    columnSize: p.columnSize,
    capClearance: p.capClearance,
    openCutRule: p.openCutRule,
    openCutSize: null,
  });
  // The diagnosis numbers its columns C01…; the layout keys are the stable ones.
  const keyOf = new Map(output.tables.interference.map((row) => [row.key, row.column.id]));
  const rekey = (fill: ClashFill): ClashFill => {
    const [head, ...rest] = fill.id.split(':');
    const key = keyOf.get(head) ?? head;
    return {
      ...fill,
      id: [key, ...rest].join(':'),
      key,
      ...(fill.label ? { label: keyOf.get(fill.label) ?? fill.label } : {}),
    };
  };
  const shapes = panelShapes(output);
  const interferenceRows: InterferenceOut[] = output.tables.interference.map((row) => ({
    ...row,
    key: row.column.id,
    at: row.bottom,
    judgement: verdictText(row.verdict),
    capText: measureText(row.cap),
    cutText: measureText(row.openCut),
    basinText: measureText(row.basin),
  }));

  // Nudges for 불가 columns: along the column's axis lines, the nearest clear position within
  // nudgeMax whose spans to the neighbours stay within the limit. Proposed only.
  const existingHulls = footprintsOf(
    'existingFootings',
    inputs.site?.existingFootings,
    'base',
  ).shapes.map((s) => s.hull);
  const capShape = rectangle([0, 0], p.capSize, p.capSize, assembled.frame.angleDeg);
  const neighbours = new Map<string, { other: string; at: Vec2 }[]>();
  const columnAt = new Map(cols.columns.map((c) => [c.key, c.at]));
  for (const span of axesOut.spans) {
    const a = columnAt.get(span.from),
      b = columnAt.get(span.to);
    if (!a || !b) continue;
    neighbours.set(span.from, [...(neighbours.get(span.from) ?? []), { other: span.to, at: b }]);
    neighbours.set(span.to, [...(neighbours.get(span.to) ?? []), { other: span.from, at: a }]);
  }
  const nudges: NudgeRow[] = [];
  const nudgeFills: ClashFill[] = [];
  const directions: { name: string; dir: Vec2 }[] = [
    { name: 'u', dir: assembled.frame.u },
    { name: 'v', dir: assembled.frame.v },
  ];
  for (const row of interferenceRows) {
    if (row.cap.verdict !== 'forbidden') continue;
    const col = cols.columns.find((c) => c.key === row.key);
    if (!col) continue;
    const allowed = directions.filter(
      (d) => (d.name === 'u' ? col.lineV : col.lineU) || (!col.lineU && !col.lineV),
    );
    let best: { at: Vec2; shift: number; along: string } | null = null;
    let spanBlocked = false;
    for (const d of allowed.length ? allowed : directions) {
      const windows = allowedWindows(
        { origin: col.at, direction: d.dir, from: -p.nudgeMax, to: p.nudgeMax },
        capShape,
        existingHulls,
        { clearance: p.capClearance },
      ).windows;
      for (const [lo, hi] of windows) {
        const t = lo <= 0 && hi >= 0 ? 0 : Math.abs(lo) < Math.abs(hi) ? lo : hi;
        if (Math.abs(t) < 1e-6) continue;
        const at: Vec2 = [col.at[0] + d.dir[0] * t, col.at[1] + d.dir[1] * t];
        const spansOk = (neighbours.get(col.key) ?? []).every(
          (n) => Math.hypot(n.at[0] - at[0], n.at[1] - at[1]) <= p.spanMax + 1e-6,
        );
        if (!spansOk) {
          spanBlocked = true;
          continue;
        }
        if (!best || Math.abs(t) < Math.abs(best.shift)) best = { at, shift: t, along: d.name };
      }
    }
    if (best) {
      nudges.push({
        key: `nudge:${col.mark}`,
        column: col.key,
        to: [round(best.at[0], 6), round(best.at[1], 6)],
        shift_m: round(best.shift),
        along: best.along === 'u' ? '축 u 방향' : '축 v 방향',
        judgement: '제안',
        text: `${best.along === 'u' ? 'u' : 'v'} 방향으로 ${round(Math.abs(best.shift), 2)} m 옮기면 겹침이 없습니다. 자동으로 적용하지 않습니다.`,
      });
      const ring = rectangle(best.at, p.capSize, p.capSize, assembled.frame.angleDeg);
      nudgeFills.push({
        id: `${col.key}:nudge`,
        key: col.key,
        points: [...ring, ring[0]].map(([x, y]) => [x, y, col.bottom[2]] as Vec3),
        label: `${col.mark} 제안`,
      });
    } else
      nudges.push({
        key: `nudge:${col.mark}`,
        column: col.key,
        to: null,
        shift_m: null,
        along: '—',
        judgement: '없음',
        text: spanBlocked
          ? `±${p.nudgeMax} m 안의 빈 자리는 경간 상한을 넘겨 제안하지 않습니다.`
          : `±${p.nudgeMax} m 안에 겹침 없는 자리가 없습니다.`,
      });
  }

  // Existing expansion joints: columns of one new segment on both sides (SPEC-06.11 2 표).
  const side = (line: { line: [number, number, number][] }, at: Vec2) => {
    const [a, b] = line.line;
    const cross = (b[0] - a[0]) * (at[1] - a[1]) - (b[1] - a[1]) * (at[0] - a[0]);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return length > 0 ? cross / length : 0;
  };
  const segmentOf = (at: Vec2) =>
    (assembled.joints?.newEJ ?? []).map((ej) => (side(ej, at) >= 0 ? '+' : '-')).join('') || '전체';
  const ejCross: InterferenceOutput['tables']['ejCross'] = [];
  for (const ej of assembled.joints?.existingEJ ?? []) {
    const bySegment = new Map<string, { left: number; right: number }>();
    for (const col of cols.columns) {
      const d = side(ej, col.at);
      if (Math.abs(d) < 0.5) continue;
      const key = segmentOf(col.at);
      const entry = bySegment.get(key) ?? { left: 0, right: 0 };
      if (d > 0) entry.left++;
      else entry.right++;
      bySegment.set(key, entry);
    }
    for (const [segment, counts] of bySegment)
      if (counts.left && counts.right)
        ejCross.push({
          key: `${ej.name}:${segment}`,
          ej: ej.name,
          segment: segment === '전체' ? '전체(신설 E.J. 없음)' : `구간 ${segment}`,
          left: counts.left,
          right: counts.right,
          judgement: '! 경고',
          text: `기존 E.J. ${ej.name} 양쪽에 같은 구간의 기둥이 ${counts.left} + ${counts.right}개 — 토목사무소 확인`,
        });
  }

  // The review list: what a person or another office must look at.
  const review: ReviewRow[] = [];
  for (const v of axesOut.violations)
    review.push({
      key: `axes:${v.key}:${v.objective}`,
      kind: v.objective === 'span' ? '경간' : v.objective === 'edge' ? '캔틸레버' : '배치',
      judgement: v.objective === 'span' ? '✕ 초과' : '! 목록',
      text: `${v.key} · ${v.text}`,
    });
  for (const row of interferenceRows) {
    if (row.cap.verdict === 'forbidden')
      review.push({
        key: `cap:${row.key}`,
        kind: '파일캡',
        judgement: '✕ 불가',
        text: `${row.key} · ${row.capText}`,
      });
    if (row.openCut.verdict !== 'pass' && row.openCut.verdict !== 'incomplete')
      review.push({
        key: `cut:${row.key}`,
        kind: '오픈컷',
        judgement: verdictText(row.openCut.verdict),
        text: `${row.key} · ${row.cutText} — 토목사무소 협의`,
      });
    if (row.basin.verdict === 'warning')
      review.push({
        key: `basin:${row.key}`,
        kind: '유수지 보',
        judgement: '! 경고',
        text: `${row.key} · ${row.basinText}`,
      });
  }
  for (const r of cols.requested ?? [])
    if (r.verdict === 'review')
      review.push({
        key: r.key,
        kind: '요청 영역',
        judgement: r.judgement,
        text: `${r.zone} · ${r.reason}`,
      });
  for (const c of ejCross)
    review.push({ key: `ej:${c.key}`, kind: '기존 E.J.', judgement: c.judgement, text: c.text });
  for (const m of assembled.possibleMissing ?? [])
    review.push({
      key: m.key,
      kind: '모델 누락 가능',
      judgement: '? 확인',
      text: `${m.grid} 교점에 기존 기초 없음 — 토목사무소 확인`,
    });
  for (const f of cols.fireConflicts ?? [])
    review.push({
      key: `fire:${f.key}`,
      kind: '소방 동선',
      judgement: '✕ 불가',
      text: `${f.key} · ${f.zone} 안이라 두지 않음`,
    });
  notes.push(...output.notes);
  if (nudges.some((n) => n.to))
    notes.push(
      `비켜 두기 후보 ${nudges.filter((n) => n.to).length}건은 제안이며 적용하지 않았습니다.`,
    );

  return {
    schema: 'vide.s06.interference/1',
    params: p,
    summary: {
      ...output.summary,
      spans: {
        total: axesOut.spans.length,
        over: axesOut.summary.spanOver,
        overhangs: 0,
        unsupported: 0,
        max: axesOut.summary.maxSpan,
      },
      nudges: nudges.filter((n) => n.to).length,
      ejCross: ejCross.length,
      review: review.length,
    },
    tables: { interference: interferenceRows, spans: axesOut.spans, nudges, ejCross, review },
    fills: {
      capClash: shapes.fills.capClash.map(rekey),
      cutClash: shapes.fills.cutClash.map(rekey),
      basinClash: shapes.fills.basinClash.map(rekey),
      spanOver: axesOut.spans
        .filter((s) => s.verdict === 'over')
        .map((s) => ({ id: `${s.key}:span`, key: s.key, points: s.line, label: `${s.length} m` })),
      nudges: nudgeFills,
    },
    missing: output.missing.filter((m) => m.judgement !== 'span' && m.judgement !== 'curve'),
    bands: { span: [p.spanMax - 1, p.spanMax + 1e-6] },
    notes,
  };
}
