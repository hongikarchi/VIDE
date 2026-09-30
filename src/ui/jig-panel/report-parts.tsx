import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../gateway.ts';
import type { PartOf } from '../kit/registry.ts';
import { CompareBars, LedgerPage, ReportPage } from '../kit/report.tsx';
import {
  parseReportTemplate,
  resolveBlock,
  resolveReport,
  type ReportContext,
  type ReportModel,
} from '../../jigs/runtime/report-format.ts';
import { resolve, type PanelData } from './bindings.ts';

// The report parts of a declarative panel (Design §14 `report` · `compare-bars` · `ledger`,
// SCR-17, PLAN-22 T-057): bind the checked part to the instance's outputs and settings and draw it
// with the kit. `report` resolves the jig's frame (`reports/<id>.json`, src/jigs/runtime/
// report-format.ts) on the current result; the caller passes the frames it has read.

/** The values a report frame reads, from what the panel holds. */
export function reportContext(data: PanelData, final?: Record<string, boolean>): ReportContext {
  return {
    outputs: data.outputs,
    params: Object.fromEntries(data.params.map((p) => [p.key, p.value])),
    ...(data.inputs ? { inputs: data.inputs } : {}),
    ...(final ? { final } : {}),
  };
}

// A panel binding may name `ledger.<name>` or `params`, which report paths do not; the part reads
// the bound value itself and resolves the block from it.
const HELD = 'step.__part';
const held = (value: unknown, data: PanelData): ReportContext => ({
  ...reportContext(data),
  outputs: { __part: value },
});

export function CompareBarsPart({ part, data }: { part: PartOf<'compare-bars'>; data: PanelData }) {
  const limit = typeof part.limit === 'string' ? resolve(part.limit, data) : part.limit;
  const block = resolveBlock(
    {
      kind: 'compare-bars',
      title: part.title,
      from: HELD,
      label: part.label,
      value: part.value,
      shade: part.shade,
      unit: part.unit,
      decimals: part.decimals,
      limit: typeof limit === 'number' ? limit : undefined,
      limitLabel: part.limitLabel,
    },
    held(resolve(part.from, data), data),
  );
  return block.kind === 'compare-bars' ? <CompareBars {...block} /> : null;
}

export function LedgerPart({ part, data }: { part: PartOf<'ledger'>; data: PanelData }) {
  const value = resolve(part.from, data);
  const rows = Array.isArray(value) ? value : [];
  const first = rows.find((row) => row && typeof row === 'object' && !Array.isArray(row)) as
    | Record<string, unknown>
    | undefined;
  const columns = part.columns?.length
    ? part.columns
    : Object.keys(first ?? {})
        .filter((key) => key !== part.group && typeof first?.[key] !== 'object')
        .slice(0, 8)
        .map((field) => ({ field, label: field }));
  if (!columns.length) return <p className="kit-muted">원장에 항목이 없습니다.</p>;
  const block = resolveBlock(
    { kind: 'ledger', title: part.title, from: HELD, group: part.group, columns },
    held(value, data),
  );
  return block.kind === 'ledger' ? <LedgerPage {...block} /> : null;
}

export function ReportPart({
  part,
  data,
  templates,
  final,
  onBack,
}: {
  part: PartOf<'report'>;
  data: PanelData;
  /** The jig's report frames by id, as read from its package. */
  templates?: Record<string, unknown>;
  /** Steps whose result is final (a preview is marked, never written as final). */
  final?: Record<string, boolean>;
  onBack?: () => void;
}) {
  const raw = templates?.[part.report];
  if (raw === undefined)
    return (
      <p className="kit-muted" role="status">
        보고서 틀 ‘{part.report}’을 읽는 중이거나 이 jig에 없습니다.
      </p>
    );
  const { template, issues } = parseReportTemplate(raw);
  if (!template)
    return (
      <div>
        <p className="kit-notice" data-level="error" role="alert">
          보고서 틀에 형식에 맞지 않는 곳이 있어 열지 않았습니다.
        </p>
        <ul className="kit-issues">
          {issues.map((issue, i) => (
            <li key={i}>
              {issue.message} <small>{issue.path}</small>
            </li>
          ))}
        </ul>
      </div>
    );
  return <ReportPage model={resolveReport(template, reportContext(data, final))} onBack={onBack} />;
}

/**
 * A `report` view of an open instance: the engine resolves the jig's frame on the kept outputs
 * (`GET …/reports/:id`, the same model as the 보고서 tab, previews marked) and it is read again
 * whenever `revision` changes (a new run).
 */
export function InstanceReportPart({
  projectId,
  instanceId,
  reportId,
  revision,
}: {
  projectId: string;
  instanceId: string;
  reportId: string;
  revision?: unknown;
}) {
  const [model, setModel] = useState<ReportModel>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const out = (await api(
          `/projects/${encodeURIComponent(projectId)}/jig-instances/${encodeURIComponent(instanceId)}/reports/${encodeURIComponent(reportId)}`,
        )) as { model?: ReportModel };
        if (!live) return;
        setModel(out.model);
        setFailed(!out.model);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [projectId, instanceId, reportId, revision]);
  if (model) return <ReportPage model={model} />;
  return (
    <p className="kit-muted" role="status">
      {failed ? `보고서 틀 ‘${reportId}’을 이 jig에서 열지 못했습니다.` : '보고서를 만드는 중…'}
    </p>
  );
}

/** Draw one report part of a checked panel (the panel's `render` hands these here). */
export function renderReportPart(
  part: PartOf<'report' | 'compare-bars' | 'ledger'>,
  key: string,
  data: PanelData,
  extra: {
    templates?: Record<string, unknown>;
    final?: Record<string, boolean>;
    onBack?: () => void;
  } = {},
): ReactNode {
  if (part.part === 'compare-bars') return <CompareBarsPart key={key} part={part} data={data} />;
  if (part.part === 'ledger') return <LedgerPart key={key} part={part} data={data} />;
  return <ReportPart key={key} part={part} data={data} {...extra} />;
}
