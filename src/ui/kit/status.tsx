import type { ReactNode } from 'react';
import './kit.css';

// Status parts of the jig screen (Design §14, SCR-13): the step rail, the KPI strip and the verdict
// legend. They draw what they are given; the declarative panel (src/ui/jig-panel) binds them.

export type RailState =
  | 'pending'
  | 'running'
  | 'done'
  | 'stale'
  | 'blocked'
  | 'failed'
  | 'waiting'
  | 'confirmed'
  | 'reconfirm';
export interface RailStep {
  id: string;
  title: string;
  /** Who does the step: 계산 · 라이브러리 · AI · 사람 · 호스트. */
  by: string;
  state: RailState;
  ms?: number | null;
  /** The result was the same as before (nothing it reads changed). */
  unchanged?: boolean;
  problems?: number;
  /** Why the step is blocked or failed, as a sentence. */
  reason?: string;
  /** A person may confirm the step now. */
  confirm?: boolean;
}
const RAIL: Record<RailState, [string, string]> = {
  pending: ['○', '계산 전'],
  running: ['…', '계산 중'],
  done: ['✓', '계산됨'],
  stale: ['', '다시 계산 필요'],
  blocked: ['○', '앞 단계 대기'],
  failed: ['✕', '막힘'],
  waiting: ['○', '확정 전'],
  confirmed: ['✓', '확정됨'],
  reconfirm: ['!', '다시 확인 필요'],
};

export function StepRail({
  steps,
  busy,
  onConfirm,
}: {
  steps: readonly RailStep[];
  busy?: boolean;
  onConfirm?: (id: string) => void;
}) {
  return (
    <ol className="kit-rail" aria-label="단계">
      {steps.map((step, i) => {
        const [mark, text] = RAIL[step.state];
        return (
          <li
            key={step.id}
            data-step={step.id}
            data-state={step.state}
            data-cached={step.unchanged ? 'true' : undefined}
          >
            <span className="kit-rail-mark" aria-hidden="true">
              {step.state === 'stale' ? <span className="kit-stale" /> : mark || i + 1}
            </span>
            <span className="kit-rail-name">
              {i + 1}. {step.title}
              {step.problems ? <span className="kit-badge">문제 {step.problems}</span> : null}
            </span>
            <span className="kit-rail-time">
              {step.unchanged ? '변경 없음' : step.ms != null ? `${step.ms} ms` : ''}
            </span>
            <span className="kit-rail-meta">
              {text} · {step.by}
            </span>
            {step.reason ? <span className="kit-rail-why">{step.reason}</span> : null}
            {step.confirm && onConfirm ? (
              <button
                type="button"
                className="kit-button"
                data-primary
                disabled={busy}
                onClick={() => onConfirm(step.id)}
              >
                {step.state === 'reconfirm' ? '다시 확인' : '확인'}
              </button>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export interface KpiCell {
  label: string;
  /** Formatted value; undefined when there is none yet. */
  value?: string;
  unit?: string;
  note?: string;
  /** Over its limit: a symbol and words beside the title. */
  over?: boolean;
  /** Why there is no value (e.g. 계산 전). */
  empty?: string;
  stale?: boolean;
}
export function KpiStrip({ items }: { items: readonly KpiCell[] }) {
  return (
    <div className="kit-kpis" role="group" aria-label="핵심 수치">
      {items.map((item) => (
        <div key={item.label} className="kit-kpi" data-kpi={item.label}>
          <div className="kit-kpi-title">
            <span className={item.stale ? 'kit-stale' : undefined}>{item.label}</span>
            {item.over ? <span className="kit-over">✕ 초과</span> : null}
          </div>
          {item.value === undefined ? (
            <div className="kit-kpi-value" data-empty>
              — {item.empty ?? '계산 전'}
            </div>
          ) : (
            <div className="kit-kpi-value">
              {item.value}
              {item.unit ? <small>{item.unit}</small> : null}
            </div>
          )}
          {item.note ? <div className="kit-kpi-note">{item.note}</div> : null}
        </div>
      ))}
    </div>
  );
}

export type VerdictBand = 'ok' | 'warn' | 'ng' | 'na';
export function VerdictLegend({
  title,
  total,
  bands,
  only,
  colored,
  onOnly,
  onColored,
}: {
  title: string;
  total: number;
  /** Band rows: symbol, words, range text and count. */
  bands: readonly {
    band: VerdictBand;
    symbol: string;
    text: string;
    range: string;
    count: number;
  }[];
  only?: VerdictBand;
  colored: boolean;
  onOnly: (band: VerdictBand | undefined) => void;
  onColored: (on: boolean) => void;
}): ReactNode {
  return (
    <div className="kit-legend" data-off={colored ? undefined : ''}>
      <div className="kit-legend-head">
        <span>{title}</span>
        <span className="kit-muted">{total}개</span>
      </div>
      <div className="kit-legend-bands" role="group" aria-label={`${title} 구간`}>
        {bands.map((row) => (
          <button
            key={row.band}
            type="button"
            data-tone={row.band}
            data-band={row.band}
            aria-pressed={only === row.band}
            title="누르면 이 판정만 봅니다"
            onClick={() => onOnly(only === row.band ? undefined : row.band)}
          >
            <span className="kit-swatch" />
            <b>{row.symbol}</b>
            <span>
              {row.text} {row.range}
            </span>
            <span>{row.count}</span>
          </button>
        ))}
      </div>
      <div className="kit-actions">
        <button type="button" onClick={() => onColored(!colored)}>
          {colored ? '판정색 끄기' : '판정색 켜기'}
        </button>
        {only ? (
          <button type="button" onClick={() => onOnly(undefined)}>
            전체 보기
          </button>
        ) : null}
      </div>
    </div>
  );
}
