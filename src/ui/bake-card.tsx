import { z } from 'zod';

// Rhino에 만들기 결과 카드 (Design SCR-13 'Rhino에 만들기 결과', part `bake-card`, SPEC-07.12 6):
// what the candidate adds and replaces, what it left alone because a person changed, copied or
// deleted it, the output layers, and the actions that follow — apply to the original (the SCR-15
// confirmation card does the applying), record the baseline after application, and the person's
// choice for each preserved object (유지 · 덮기 · 수정 사항으로 받기, SPEC-07.13). Wiring into the
// jig screen is PLAN-23 T-056; this file is the component and the schema of the request result's
// `bake` field (src/jigs/bake/bake.ts `BakeSummary`).

const preserved = z.object({
  key: z.string(),
  nativeId: z.string(),
  reason: z.enum(['edited', 'moved', 'pending-baseline']),
});
export const bakeOutcomeSchema = z.object({
  bakeId: z.string(),
  template: z.string(),
  layer: z.string(),
  added: z.array(z.string()),
  replaced: z.array(z.string()),
  dropped: z.array(z.string()).default([]),
  preserved: z.array(preserved),
  kept: z.array(z.string()),
  deleted: z.array(z.string()),
  copies: z.number().int().nonnegative(),
  failed: z.array(z.string()).default([]),
  recordId: z.string().optional(),
});
export const bakeSummarySchema = z.object({
  runId: z.string(),
  readId: z.string(),
  linkId: z.string(),
  bakes: z.array(bakeOutcomeSchema),
  totals: z.object({
    added: z.number(),
    replaced: z.number(),
    preserved: z.number(),
    copies: z.number(),
    deleted: z.number(),
    failed: z.number(),
  }),
  layers: z.array(z.string()),
  text: z.string().optional(),
});
export type BakeSummary = z.infer<typeof bakeSummarySchema>;
export type BakeOutcome = z.infer<typeof bakeOutcomeSchema>;
export type Resolve = 'keep' | 'overwrite' | 'absorb';

export interface BakeCardProps {
  summary: BakeSummary;
  /** The candidate request's state as the work view shows it. */
  state: 'running' | 'succeeded' | 'failed' | 'applied' | 'unknown';
  /** Recorded (baseline read done), pending (applied, read not yet), failed (read failed). */
  baseline?: 'recorded' | 'pending' | 'failed';
  /** The results changed after this bake ('만든 결과가 오래됨'). */
  stale?: boolean;
  /** Opens the confirmation card that applies the candidate to the original (SCR-15). */
  onApply?: () => void;
  /** Reads the applied document again to record the baseline fingerprints. */
  onRecordBaseline?: () => void;
  /** The person's choice for a preserved object, used by the next bake. */
  onResolve?: (bakeId: string, key: string, choice: Resolve) => void;
  /** Focus an object (row ↔ 3D). */
  onFocus?: (nativeId: string) => void;
}

const reasonLabel: Record<z.infer<typeof preserved>['reason'], string> = {
  edited: 'Rhino에서 고침',
  moved: '다른 레이어로 옮김',
  'pending-baseline': '반영 뒤 읽기 전',
};
const choices: [Resolve, string][] = [
  ['keep', '유지'],
  ['overwrite', '덮기'],
  ['absorb', '수정 사항으로 받기'],
];

function Line({ label, count, detail }: { label: string; count: number; detail?: string }) {
  return (
    <li className="bake-line" data-empty={count === 0}>
      <span className="bake-line-label">{label}</span>
      <strong className="bake-line-count">{count}</strong>
      {detail ? <small className="bake-line-detail">{detail}</small> : null}
    </li>
  );
}

export function BakeCard({
  summary,
  state,
  baseline,
  stale,
  onApply,
  onRecordBaseline,
  onResolve,
  onFocus,
}: BakeCardProps) {
  const { totals } = summary;
  const preservedRows = summary.bakes.flatMap((bake) =>
    bake.preserved.map((item) => ({ bake, item })),
  );
  const deletedKeys = summary.bakes.flatMap((bake) => bake.deleted);
  const applied = state === 'applied';
  return (
    <section className="bake-card" data-state={state} aria-label="Rhino에 만들기 결과">
      <header className="bake-card-head">
        <h4>Rhino에 만들기</h4>
        {stale ? (
          <span className="bake-badge" data-tone="warn">
            만든 결과가 오래됨
          </span>
        ) : null}
        {applied ? (
          <span className="bake-badge" data-tone="ok">
            {baseline === 'recorded' ? '원본에 반영됨' : '반영됨 · 기준 읽기 필요'}
          </span>
        ) : state === 'succeeded' ? (
          <span className="bake-badge">후보</span>
        ) : state === 'failed' ? (
          <span className="bake-badge" data-tone="no">
            만들지 못함
          </span>
        ) : null}
      </header>
      <ul className="bake-lines">
        <Line label="추가" count={totals.added} />
        <Line label="교체" count={totals.replaced} />
        <Line label="사람이 고친 것 보존" count={totals.preserved} />
        <Line label="복사본 그대로" count={totals.copies} />
        <Line
          label="사람이 지운 것"
          count={totals.deleted}
          detail={totals.deleted ? '다시 만들지 않음 · 되살리려면 덮기' : undefined}
        />
        {totals.failed ? <Line label="만들지 못함" count={totals.failed} /> : null}
      </ul>
      <p className="bake-layers">출력 레이어: {summary.layers.map((layer) => layer).join(' · ')}</p>
      {preservedRows.length ? (
        <details className="bake-preserved" open>
          <summary>보존한 객체 {preservedRows.length}개</summary>
          <ul>
            {preservedRows.map(({ bake, item }) => (
              <li key={`${bake.bakeId}:${item.key}`}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onFocus?.(item.nativeId)}
                  disabled={!onFocus}
                >
                  {item.key}
                </button>
                <small> {reasonLabel[item.reason]}</small>
                {onResolve && item.reason !== 'pending-baseline' ? (
                  <span className="bake-choices">
                    {choices.map(([choice, label]) => (
                      <button
                        type="button"
                        key={choice}
                        onClick={() => onResolve(bake.bakeId, item.key, choice)}
                      >
                        {label}
                      </button>
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {deletedKeys.length ? (
        <p className="bake-deleted">
          <small>사람이 지운 것: {deletedKeys.join(', ')}</small>
        </p>
      ) : null}
      <div className="bake-actions">
        {state === 'succeeded' && onApply ? (
          <button type="button" className="primary" onClick={onApply}>
            원본에 반영
          </button>
        ) : null}
        {applied && baseline !== 'recorded' && onRecordBaseline ? (
          <button type="button" onClick={onRecordBaseline}>
            {baseline === 'failed' ? '기준 읽기 다시 시도' : '반영 결과 읽기'}
          </button>
        ) : null}
        {applied && baseline === 'failed' ? (
          <small>읽기 전에는 이 객체들을 교체하지 않고 보존합니다.</small>
        ) : null}
      </div>
    </section>
  );
}
