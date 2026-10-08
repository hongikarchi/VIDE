import { z } from 'zod';

// Rhino에 만들기 결과 카드 (Design SCR-13 'Rhino에 만들기 결과', part `bake-card`, SPEC-07.12 6):
// what the bake added and replaced, what it left alone because a person changed, copied or
// deleted it, the output layers, and the actions that follow. With an attached Rhino the bake is
// made in the open document at once (바로 적용, user decision 2026-09-30) and the card offers
// [되돌리기] for the last bake (the host's undo). Without one it ran in a work copy only and the
// card asks to open the file in Rhino and connect it; [반영 결과 읽기] retries a baseline read that
// failed; the person's choice for each preserved object (유지 · 덮기 · 수정 사항으로 받기,
// SPEC-07.13) goes into the next bake. Wiring into the
// jig screen is PLAN-23 T-056; this file is the component and the schema of the request result's
// `bake` field (src/jigs/bake/bake.ts `BakeSummary`); `jig-panel/bake-parts.tsx` drives it.

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
  respected: z.array(z.string()).default([]),
  kept: z.array(z.string()),
  deleted: z.array(z.string()),
  copies: z.number().int().nonnegative(),
  failed: z.array(z.string()).default([]),
  /** Why each failed key failed (패널링: left on the failure layer, SPEC-16.9 5). */
  failures: z.array(z.object({ key: z.string(), reason: z.string(), code: z.string() })).optional(),
  recordId: z.string().optional(),
  /** 패널링: person-edited objects of an earlier layout kept ('이전 배치에서 보존'). */
  preservedEarlier: z.number().int().nonnegative().optional(),
  /** 패널링: largest actual-face vs sample difference at the made corners, and its limit (m). */
  deviationMax: z.number().nonnegative().optional(),
  deviationLimit: z.number().positive().optional(),
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
    respected: z.number().default(0),
    copies: z.number(),
    deleted: z.number(),
    failed: z.number(),
  }),
  layers: z.array(z.string()),
  text: z.string().optional(),
  direct: z.boolean().optional(),
  /** Host undo records of a direct bake ('Rhino Ctrl+Z n번'). */
  undos: z.number().int().nonnegative().optional(),
});
export type BakeSummary = z.infer<typeof bakeSummarySchema>;
export type BakeOutcome = z.infer<typeof bakeOutcomeSchema>;
export type Resolve = 'keep' | 'overwrite' | 'absorb';

export interface BakeCardProps {
  summary: BakeSummary;
  /**
   * `applied`: made in the open document (direct) or read after application; `succeeded`: made in
   * a work copy only (no attached Rhino); `undone`: taken back with [되돌리기].
   */
  state: 'running' | 'succeeded' | 'failed' | 'applied' | 'undone' | 'unknown';
  /** Recorded (baseline read done), pending (applied, read not yet), failed (read failed). */
  baseline?: 'recorded' | 'pending' | 'failed';
  /** The results changed after this bake ('만든 결과가 오래됨'). */
  stale?: boolean;
  /** Opens the confirmation card that applies a work-copy result to the original (SCR-15). */
  onApply?: () => void;
  /** Undo the last direct bake in Rhino (the host's undo record); only for the latest bake. */
  onUndo?: () => void;
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

/** A failed panel's reason in words (SPEC-16.10; template reasons by their code). */
const FAILURE_WORDS: Record<string, string> = {
  'outside-trim': '꼭짓점이 트림 밖',
  'not-closed': '닫힌 부재가 되지 않음',
  degenerate: '모양이 퇴화함',
  'folded-projection': '투영 격자가 접힘',
  'thickness-curvature': '두께 불가(곡률)',
  'make-failed': 'Rhino에서 만들지 못함',
};
const failureLabel = (failure: { code: string; reason: string }) =>
  FAILURE_WORDS[failure.code] ?? failure.reason;

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
  onUndo,
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
  const earlier = summary.bakes.reduce((n, bake) => n + (bake.preservedEarlier ?? 0), 0);
  const failures = summary.bakes.flatMap((bake) => bake.failures ?? []);
  const deviations = summary.bakes.filter((bake) => bake.deviationMax !== undefined);
  const deviation = deviations.length
    ? Math.max(...deviations.map((bake) => bake.deviationMax!))
    : undefined;
  const deviationLimit = deviations.find((bake) => bake.deviationLimit)?.deviationLimit;
  const coarse =
    deviation !== undefined && deviationLimit !== undefined && deviation > deviationLimit;
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
            {baseline === 'recorded'
              ? summary.direct
                ? 'Rhino에 만듦'
                : '원본에 반영됨'
              : '만듦 · 결과 읽기 필요'}
          </span>
        ) : state === 'succeeded' ? (
          <span className="bake-badge">작업 사본에만 만듦</span>
        ) : state === 'undone' ? (
          <span className="bake-badge">되돌림</span>
        ) : state === 'failed' ? (
          <span className="bake-badge" data-tone="no">
            만들지 못함
          </span>
        ) : null}
      </header>
      <ul className="bake-lines">
        <Line label="추가" count={totals.added} />
        <Line label="교체" count={totals.replaced} />
        <Line
          label="사람이 고친 것 보존"
          count={totals.preserved}
          detail={earlier ? `이전 배치에서 보존 ${earlier}` : undefined}
        />
        {totals.respected ? (
          <Line
            label="수정 사항으로 받은 것"
            count={totals.respected}
            detail="Rhino에서 고친 그대로 둠"
          />
        ) : null}
        <Line label="복사본 그대로" count={totals.copies} />
        <Line
          label="사람이 지운 것"
          count={totals.deleted}
          detail={totals.deleted ? '다시 만들지 않음 · 되살리려면 덮기' : undefined}
        />
        {totals.failed ? (
          <Line
            label="만들지 못함"
            count={totals.failed}
            detail={failures.length ? '실패 레이어에 윤곽과 번호로 남김' : undefined}
          />
        ) : null}
      </ul>
      {deviation !== undefined ? (
        <p className="bake-deviation" data-coarse={coarse || undefined}>
          실제 면과 표본의 최대 차이 {(deviation * 1000).toFixed(1)} mm
          {coarse ? ' · 표본이 거칩니다 · 촘촘하게 다시 읽기' : ''}
        </p>
      ) : null}
      {failures.length ? (
        <details className="bake-failures">
          <summary>만들지 못한 패널 {failures.length}개</summary>
          <ul>
            {failures.slice(0, 50).map((failure) => (
              <li key={failure.key}>
                {failure.key.split(':').slice(2).join(':')} <small>{failureLabel(failure)}</small>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {applied && summary.direct && (summary.undos ?? 0) > 1 ? (
        <p className="bake-undos">
          <small>
            Rhino에서 되돌리려면 Ctrl+Z {summary.undos}번 · [되돌리기]는 한 번에 모두 되돌립니다
          </small>
        </p>
      ) : null}
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
        {applied && onUndo ? (
          <button
            type="button"
            onClick={onUndo}
            title="Rhino의 실행 취소로 이번 만들기를 되돌립니다"
          >
            되돌리기
          </button>
        ) : null}
        {applied && baseline !== 'recorded' && onRecordBaseline ? (
          <button type="button" onClick={onRecordBaseline}>
            {baseline === 'failed' ? '결과 읽기 다시 시도' : '반영 결과 읽기'}
          </button>
        ) : null}
        {applied && baseline === 'failed' ? (
          <small>읽기 전에는 이 객체들을 교체하지 않고 보존합니다.</small>
        ) : null}
      </div>
    </section>
  );
}
