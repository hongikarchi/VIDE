import { useEffect, useRef, type ReactNode } from 'react';
import type { ColumnSpec } from './registry.ts';
import { cellText, fieldOf, isNumeric, toCsv, unitText } from '../jig-panel/bindings.ts';
import './kit.css';

// Table parts (Design §14 `issue-table` · `table` · `schedule` · `result-tabs`, SCR-13 결과 서랍):
// numbers right-aligned in place, a row press selects it (and the jig frames it in 3D), a
// selection made elsewhere (3D, plan) scrolls its row into view, and every table saves as CSV.

const MAX_ROWS = 500;

export function DataTable({
  variant = 'table',
  label,
  rows,
  columns,
  rowId,
  selected,
  onRow,
  csvName,
}: {
  variant?: 'table' | 'issue-table' | 'schedule';
  label: string;
  rows: readonly Record<string, unknown>[];
  columns: readonly ColumnSpec[];
  rowId: (row: Record<string, unknown>, index: number) => string;
  selected?: string;
  onRow?: (id: string, row: Record<string, unknown>) => void;
  csvName?: string;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    if (selected === undefined) return;
    const row = [...(body.current?.rows ?? [])].find((r) => r.dataset.id === selected);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const numeric = new Set(columns.filter((c) => isNumeric(rows, c.field)).map((c) => c.field));
  const save = () => {
    const url = URL.createObjectURL(
      new Blob([toCsv(rows, columns)], { type: 'text/csv;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${csvName ?? label}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (!rows.length)
    return (
      <p className="kit-muted" role="status">
        {label}: 결과가 없습니다.
      </p>
    );
  return (
    <div data-table={variant}>
      <div className="kit-table-wrap">
        <table className="kit-table" aria-label={label}>
          <thead>
            <tr>
              {variant === 'issue-table' ? <th data-num>번호</th> : null}
              {columns.map((column) => (
                <th key={column.field} data-num={numeric.has(column.field) ? '' : undefined}>
                  {column.label}
                  {column.unit ? ` (${unitText(column.unit)})` : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody ref={body}>
            {rows.slice(0, MAX_ROWS).map((row, i) => {
              const id = rowId(row, i);
              return (
                <tr
                  key={id}
                  data-id={id}
                  aria-selected={selected === id}
                  tabIndex={0}
                  onClick={() => onRow?.(id, row)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onRow?.(id, row);
                  }}
                >
                  {variant === 'issue-table' ? <td data-num>{i + 1}</td> : null}
                  {columns.map((column) => (
                    <td key={column.field} data-num={numeric.has(column.field) ? '' : undefined}>
                      {cellText(fieldOf(row, column.field), column.decimals)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="kit-table-foot">
        <span>
          {rows.length > MAX_ROWS
            ? `처음 ${MAX_ROWS}행 · 전체 ${rows.length}행`
            : `${rows.length}행`}
        </span>
        <button type="button" className="kit-button" onClick={save}>
          CSV
        </button>
      </div>
    </div>
  );
}

export function ResultTabs({
  tabs,
  active,
  onActive,
}: {
  tabs: readonly { id: string; title: string; count?: number; content: ReactNode }[];
  active: string;
  onActive: (id: string) => void;
}) {
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  return (
    <div className="kit-drawer">
      <div className="kit-tabs" role="tablist" aria-label="결과">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === current?.id}
            onClick={() => onActive(tab.id)}
          >
            {tab.title}
            {tab.count !== undefined ? <b>{tab.count}</b> : null}
          </button>
        ))}
      </div>
      <div role="tabpanel">{current?.content}</div>
    </div>
  );
}
