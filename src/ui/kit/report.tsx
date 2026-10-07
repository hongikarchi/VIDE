import { useState } from 'react';
import type {
  BarShade,
  ClaimOut,
  ReportBlock,
  ReportColumn,
  ReportModel,
} from '../../jigs/runtime/report-format.ts';
import './kit.css';

// Report parts (Design §14 `report` · `compare-bars` · `ledger`, SCR-17): the study page with an
// eyebrow, a sentence headline, the source line, the KPI strip and numbered sections whose titles
// are claims; restrained comparison bars (grey · sage · coral) with a dashed limit line; and the
// ledger page (groups on the left as a filter, the evidence table on the right). They draw a
// resolved report (src/jigs/runtime/report-format.ts); the server renders the same model as the
// exported page (src/server/report.ts), which has no controls.

function Claim({ claim }: { claim: ClaimOut }) {
  return (
    <>
      {claim.text}
      {claim.check ? <span className="kit-report-flag">{claim.check}</span> : null}
      {claim.provisional ? (
        <span className="kit-report-flag" data-provisional>
          확정 전 미리보기
        </span>
      ) : null}
    </>
  );
}

const pct = (value: number, max: number) =>
  `${Math.max(0, Math.min(100, (value / (max || 1)) * 100)).toFixed(2)}%`;

export interface CompareBarRow {
  label: string;
  value: number | null;
  text: string;
  shade: BarShade;
}
export function CompareBars({
  title,
  rows,
  max,
  unit,
  limit,
}: {
  title?: string;
  rows: readonly CompareBarRow[];
  max: number;
  unit?: string;
  limit?: { value: number; text: string; label?: string };
}) {
  return (
    <figure className="kit-bars" aria-label={title ?? '비교'}>
      {title ? <h4>{title}</h4> : null}
      {rows.length ? null : <p className="kit-muted">값이 없습니다.</p>}
      {rows.map((row, i) => (
        <div key={i} className="kit-bar">
          <span className="kit-bar-label" title={row.label}>
            {row.label}
          </span>
          <div className="kit-bar-track">
            {row.value === null ? null : (
              <span
                className="kit-bar-fill"
                data-shade={row.shade}
                style={{ width: pct(row.value, max) }}
              />
            )}
            <span
              className="kit-bar-value"
              data-empty={row.value === null ? '' : undefined}
              style={{ left: row.value === null ? '0%' : pct(row.value, max) }}
            >
              {row.text}
              {unit && row.value !== null ? ` ${unit}` : ''}
            </span>
            {limit ? (
              <span className="kit-bar-limit" style={{ left: pct(limit.value, max) }} />
            ) : null}
          </div>
        </div>
      ))}
      {limit ? (
        <figcaption className="kit-bar-limit-label">
          ┆ {limit.label ?? '한도'} {limit.text}
          {unit ? ` ${unit}` : ''}
        </figcaption>
      ) : null}
    </figure>
  );
}

const Th = ({ column }: { column: ReportColumn }) => (
  <th data-num={column.numeric ? '' : undefined}>
    {column.label}
    {column.unit ? ` (${column.unit})` : ''}
  </th>
);

export function LedgerPage({
  title,
  groups,
  columns,
  rows,
}: {
  title?: string;
  groups: readonly { name: string; count: number }[];
  columns: readonly ReportColumn[];
  rows: readonly { group: string; cells: readonly string[] }[];
}) {
  const [only, setOnly] = useState<string>();
  const shown = only ? rows.filter((row) => row.group === only) : rows;
  let last: string | undefined;
  return (
    <div className="kit-ledger">
      <nav className="kit-ledger-toc" aria-label={title ?? '원장 목록'}>
        {title ? <h4>{title}</h4> : null}
        <ol>
          <li>
            <button type="button" aria-pressed={!only} onClick={() => setOnly(undefined)}>
              <span>전체</span>
              <span>{rows.length}</span>
            </button>
          </li>
          {groups.map((group) => (
            <li key={group.name}>
              <button
                type="button"
                aria-pressed={only === group.name}
                onClick={() => setOnly(only === group.name ? undefined : group.name)}
              >
                <span>{group.name}</span>
                <span>{group.count}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <div className="kit-ledger-body">
        <table className="kit-report-table">
          <thead>
            <tr>
              {columns.map((column, i) => (
                <Th key={i} column={column} />
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.flatMap((row, i) => {
              const out = [];
              if (row.group !== last)
                out.push(
                  <tr key={`g${i}`} className="kit-ledger-group">
                    <td colSpan={columns.length}>{row.group}</td>
                  </tr>,
                );
              last = row.group;
              out.push(
                <tr key={i}>
                  {row.cells.map((cell, j) => (
                    <td key={j} data-num={columns[j]?.numeric ? '' : undefined}>
                      {cell}
                    </td>
                  ))}
                </tr>,
              );
              return out;
            })}
          </tbody>
        </table>
        {shown.length ? null : <p className="kit-muted">항목이 없습니다.</p>}
      </div>
    </div>
  );
}

export function ReportBlockView({ block }: { block: ReportBlock }) {
  if (block.kind === 'compare-bars') return <CompareBars {...block} />;
  if (block.kind === 'ledger') return <LedgerPage {...block} />;
  if (block.kind === 'list')
    return (
      <div>
        {block.title ? <h4>{block.title}</h4> : null}
        <ul className="kit-report-list">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div>
      {block.title ? <h4>{block.title}</h4> : null}
      <table className="kit-report-table">
        <thead>
          <tr>
            {block.columns.map((column, i) => (
              <Th key={i} column={column} />
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} data-num={block.columns[j]?.numeric ? '' : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {block.more > 0 ? <p className="kit-muted">외 {block.more}행은 CSV에 있습니다.</p> : null}
    </div>
  );
}

const GATE_TEXT: Record<string, string> = {
  'claim-consistent': '주장 문장이 지금 결과와 맞지 않습니다',
  'numbers-in-source': '결과에 없는 숫자가 문장에 있습니다',
  'unchecked-listed': '검토하지 않은 항목 목록이 없습니다',
};

/**
 * The study report in the app. `onBack` returns to the instance's settings (the in-app button of
 * SPEC-07.11); the exported page has only the "VIDE에서 열기" line instead.
 */
export function ReportPage({
  model,
  origin,
  onBack,
}: {
  model: ReportModel;
  origin?: { project: string; instance: string; version: string };
  onBack?: () => void;
}) {
  const failed = model.gates.filter((gate) => !gate.ok);
  return (
    <article className="kit-report" aria-label={model.title}>
      <header className="kit-report-head">
        {model.eyebrow ? <p className="kit-report-eyebrow">{model.eyebrow}</p> : null}
        <h1 data-tone={model.headline.tone}>
          <Claim claim={model.headline} />
        </h1>
        {model.lede ? (
          <p className="kit-report-lede">
            <Claim claim={model.lede} />
          </p>
        ) : null}
        <p className="kit-report-source">
          {model.source.map((text, i) => (
            <span key={i}>{text}</span>
          ))}
        </p>
        {failed.length ? (
          <p className="kit-notice" role="alert">
            확인 필요 · {failed.map((gate) => GATE_TEXT[gate.id] ?? gate.id).join(' · ')}
          </p>
        ) : null}
        {model.exportRefused?.length ? (
          <p className="kit-notice" role="alert" data-export-refused="">
            내보내지 않음 · {model.exportRefused.join(' · ')}
          </p>
        ) : null}
        {model.provisional.length ? (
          <p className="kit-muted">확정 전 미리보기 결과가 섞여 있습니다.</p>
        ) : null}
        <div className="kit-report-caveat">
          <div>
            <h4>가정</h4>
            {model.assumptions.length ? (
              <ul>
                {model.assumptions.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            ) : (
              <p>없음</p>
            )}
          </div>
          <div>
            <h4>검토하지 않은 항목</h4>
            {model.unchecked.length ? (
              <ul>
                {model.unchecked.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            ) : (
              <p>없음</p>
            )}
          </div>
        </div>
        {onBack ? (
          <div className="kit-actions">
            <button type="button" onClick={onBack}>
              이 설정값으로 돌아가기
            </button>
          </div>
        ) : null}
      </header>
      {model.kpis.length ? (
        <div className="kit-report-kpis">
          {model.kpis.map((kpi, i) => (
            <div key={i} className="kit-report-kpi">
              <h3>{kpi.label}</h3>
              <div className="kit-report-kpi-value">
                {kpi.value}
                {kpi.unit ? <small>{kpi.unit}</small> : null}
              </div>
              {kpi.note || kpi.provisional ? (
                <p>
                  {kpi.note}
                  {kpi.provisional ? ' 확정 전 미리보기' : ''}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {model.sections.map((section) => (
        <section key={section.id} className="kit-report-section" data-section={section.id}>
          <span className="kit-report-no">{section.no}</span>
          <h2 data-tone={section.title.tone}>
            <Claim claim={section.title} />
          </h2>
          {section.lede ? (
            <p className="kit-report-lede">
              <Claim claim={section.lede} />
            </p>
          ) : null}
          {section.blocks.map((block, i) => (
            <ReportBlockView key={i} block={block} />
          ))}
        </section>
      ))}
      {origin ? (
        <p className="kit-report-open">
          VIDE에서 열기: {origin.project} · {origin.instance} · {origin.version}
        </p>
      ) : null}
    </article>
  );
}
