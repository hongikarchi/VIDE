// S-06 frame jig ① 진단 as a v3 `code` step (PLAN-23 T-051): the M0 diagnosis of the layout as it
// is drawn, fed from the assembled site roles instead of the temporary route. The judgement code
// is `diagnose()` unchanged; this file only adapts the inputs and adds the words and geometry the
// declarative panel binds to (verdict labels, a point per column, span lines, clash fills by kind).

import type { Vec3 } from '../../../../src/jigs/official/geometry-kit/index.ts';
import {
  DEFAULT_PARAMS,
  diagnose,
  type DiagnoseOutput,
  type DiagnoseParams,
  type InterferenceRow,
  type OverlayItem,
  type SpanRow,
} from './diagnose.ts';
import { VERDICT_LABEL, VERDICT_SYMBOL, type Verdict } from './labels.ts';
import { diagnoseInputsOf, type SiteInput } from './roles.ts';

export interface DiagnoseStepInputs {
  site: SiteInput;
}
export type DiagnoseStepParams = Partial<DiagnoseParams>;

export interface ClashFill {
  id: string;
  key: string;
  points: Vec3[];
  label?: string;
}
export interface DiagnoseStepOutput extends DiagnoseOutput {
  tables: DiagnoseOutput['tables'] & {
    interference: (InterferenceRow & {
      at: Vec3;
      judgement: string;
      capText: string;
      cutText: string;
      basinText: string;
    })[];
    spans: (SpanRow & { line: Vec3[]; judgement: string })[];
  };
  fills: {
    capClash: ClashFill[];
    cutClash: ClashFill[];
    basinClash: ClashFill[];
    spanOver: ClashFill[];
  };
  shapes: {
    existing: ClashFill[];
    caps: ClashFill[];
    openCuts: ClashFill[];
    columns: ClashFill[];
  };
  bands: { span: [number, number] };
}

export const verdictText = (verdict: Verdict | null) =>
  verdict ? `${VERDICT_SYMBOL[verdict]} ${VERDICT_LABEL[verdict]}` : '—';
const measureText = (m: { verdict: Verdict; distance: number | null }) =>
  m.distance === null
    ? VERDICT_LABEL[m.verdict]
    : `${VERDICT_LABEL[m.verdict]} · ${m.distance < 0 ? `겹침 ${(-m.distance).toFixed(2)}` : m.distance.toFixed(2)} m`;

const toFill = (item: OverlayItem): ClashFill | null => {
  if (item.kind === 'polygon')
    return {
      id: item.id,
      key: item.id.split(':')[0],
      points: item.points.map(([x, y]) => [x, y, item.z] as Vec3),
      ...(item.label ? { label: item.label } : {}),
    };
  if (item.kind === 'polyline')
    return {
      id: item.id,
      key: item.id.split(':')[0],
      points: item.closed ? [...item.points, item.points[0]] : item.points,
      ...(item.label ? { label: item.label } : {}),
    };
  return null;
};
const fills = (items: OverlayItem[]) => items.map(toFill).filter((f): f is ClashFill => !!f);

/** Panel-facing lists from a diagnosis: per-kind clash fills and the reference shapes. */
export function panelShapes(output: DiagnoseOutput) {
  const layer = (key: string) => output.overlays.find((o) => o.key === key)?.items ?? [];
  const clash = layer('s06-clash');
  const part = (name: string) => clash.filter((i) => i.id.split(':')[1]?.startsWith(name));
  const fresh = layer('s06-new');
  return {
    fills: {
      capClash: fills(part('cap')),
      cutClash: fills(part('cut')),
      basinClash: fills(part('basin')),
      spanOver: fills(layer('s06-spans')),
    },
    shapes: {
      existing: fills(layer('s06-existing')),
      caps: fills(fresh.filter((i) => i.id.endsWith(':cap'))),
      openCuts: fills(fresh.filter((i) => i.id.endsWith(':cut'))),
      columns: fills(fresh.filter((i) => i.id.endsWith(':column'))),
    },
  };
}

export function diagnoseStep(
  inputs: DiagnoseStepInputs,
  params: DiagnoseStepParams = {},
): DiagnoseStepOutput {
  const output = diagnose(diagnoseInputsOf(inputs.site ?? {}), params);
  const spanMax = output.params.spanMax ?? DEFAULT_PARAMS.spanMax;
  return {
    ...output,
    tables: {
      ...output.tables,
      interference: output.tables.interference.map((row) => ({
        ...row,
        at: row.bottom,
        judgement: verdictText(row.verdict),
        capText: measureText(row.cap),
        cutText: measureText(row.openCut),
        basinText: measureText(row.basin),
      })),
      spans: output.tables.spans.map((row) => ({
        ...row,
        line: row.points,
        judgement: verdictText(row.verdict),
      })),
    },
    ...panelShapes(output),
    bands: { span: [spanMax - 1, spanMax + 1e-6] },
  };
}
