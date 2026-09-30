import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  BakeCard,
  bakeSummarySchema,
  type BakeCardProps,
  type BakeSummary,
  type Resolve,
} from '../bake-card.tsx';

// 'Rhino에 만들기' as a panel part (PLAN-23 T-056, SPEC-07.12·13, Design SCR-13 part `bake-card`):
// [선만 먼저 만들기] and [부재 만들기] bake the instance. With an attached Rhino the bake is made in
// the open document at once, in host undo records (바로 적용, user decision 2026-09-30): the card
// shows what was added, replaced and left alone, and [되돌리기] undoes the last bake through the
// host (`POST …/bakes/:id/undo`). Without one it runs in a work copy only (a request the card
// follows) and the person is asked to open the file in Rhino and connect it. The person's choices
// for preserved objects go into the next bake (`resolve`); a baseline read that failed after the
// run is retried with [반영 결과 읽기] (`POST …/bakes/:id/baseline`). Earlier bakes are listed below.

const offerSchema = z.object({
  id: z.string(),
  template: z.string(),
  layer: z.string(),
  requires: z.array(z.string()).default([]),
  builtin: z.boolean().default(false),
});
const recordSchema = z
  .object({
    id: z.string(),
    bakeId: z.string(),
    linkId: z.string(),
    requestId: z.string(),
    runId: z.string(),
    items: z.record(z.string(), z.object({ state: z.string() }).passthrough()),
    appliedAt: z.string().nullable(),
    pendingBaseline: z.boolean(),
    undone: z.boolean().default(false),
    undoable: z.boolean().default(false),
  })
  .passthrough();
const bakesSchema = z.object({
  bakes: z.array(recordSchema),
  offers: z.array(offerSchema).default([]),
  stale: z.boolean().default(false),
});
type Offer = z.infer<typeof offerSchema>;
type BakeRecord = z.infer<typeof recordSchema>;

const LABELS: Record<string, string> = {
  lines: '선(축선·기둥선·상단선)',
  members: 'H 부재',
  'member-columns': 'H 기둥',
};
export const bakeLabel = (id: string) => LABELS[id] ?? id;
const needsAnalysis = (offer: Offer) => offer.requires.includes('analysis-confirmed');

/** A JSON call that keeps the body of a refusal (the blocked gates' hints). */
async function call(path: string, method = 'GET', data?: unknown) {
  const response = await fetch('api/v1' + path, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    /* no body */
  }
  return { ok: response.ok, body };
}
const errorText = (body: Record<string, unknown>, fallback: string) => {
  const hints = Array.isArray(body.hints) ? body.hints.filter((h) => typeof h === 'string') : [];
  const problems = Array.isArray(body.problems)
    ? body.problems.filter((p) => typeof p === 'string').slice(0, 3)
    : [];
  if (body.code === 'GATE_BLOCKED')
    return `만들기 전에 막았습니다. ${[...hints, ...problems].join(' · ') || fallback}`;
  if (body.code === 'NOT_APPLIED')
    return 'Rhino 문서에서 이번에 만든 객체를 찾지 못했습니다. 파일을 Rhino에서 열어 연결하세요.';
  if (body.code === 'BAKE_GUARDED')
    return '기록에 없는 객체까지 지우려 해서 되돌렸습니다. Rhino 문서는 그대로입니다.';
  if (body.code === 'BAKE_FAILED' || body.code === 'BAKE_READ_FAILED')
    return body.undoFailed
      ? '만들지 못했고 일부를 되돌리지 못했습니다. Rhino에서 Ctrl+Z로 확인하세요.'
      : '만들지 못했습니다. Rhino 문서는 그대로입니다.';
  if (body.code === 'BAKE_UNDO_NOT_LATEST')
    return '그 뒤에 Rhino에서 다른 작업이 있어 되돌리지 않았습니다. Rhino에서 Ctrl+Z를 쓰세요.';
  if (body.code === 'BAKE_UNDO_UNAVAILABLE')
    return '이 만들기는 VIDE에서 되돌릴 수 없습니다. Rhino에서 Ctrl+Z를 쓰세요.';
  if (body.code === 'STALE_INPUT') return 'Rhino 문서가 방금 바뀌었습니다. 다시 누르세요.';
  if (body.code === 'BAKE_NOT_COMPUTED') return '계산이 끝난 결과가 없습니다. 먼저 계산하세요.';
  return typeof body.message === 'string' ? body.message : fallback;
};

/** The plans of a submitted bake as a provisional summary (before the candidate is made). */
function provisional(body: Record<string, unknown>): BakeSummary | undefined {
  const plans = Array.isArray(body.plans) ? body.plans : [];
  const parsed = bakeSummarySchema.safeParse({
    runId: body.runId ?? '',
    readId: body.readId ?? '',
    linkId: body.linkId ?? '',
    bakes: plans,
    totals: {
      added: 0,
      replaced: 0,
      preserved: 0,
      copies: 0,
      deleted: 0,
      failed: 0,
    },
    layers: plans.map((p) => (p as { layer?: unknown }).layer).filter(Boolean),
  });
  if (!parsed.success) return undefined;
  const summary = parsed.data;
  for (const bake of summary.bakes) {
    summary.totals.added += bake.added.length;
    summary.totals.replaced += bake.replaced.length;
    summary.totals.preserved += bake.preserved.length;
    summary.totals.respected += bake.respected.length;
    summary.totals.copies += bake.copies;
    summary.totals.deleted += bake.deleted.length;
  }
  return summary;
}

interface Last {
  requestId?: string;
  summary: BakeSummary;
  state: BakeCardProps['state'];
}

export interface BakePartProps {
  projectId: string;
  instanceId: string;
  title?: string;
  /** Bake ids to offer; every offer of the instance when omitted. */
  bake?: readonly string[];
  /** Recompute the instance (after edits were taken as 수정 사항). */
  onRecompute?: () => void;
  /** Frame one object of the linked document. */
  onFocus?: (nativeId: string) => void;
  /** Changes when the instance was computed again; the offers and records are read again. */
  revision?: unknown;
}

export function BakePart({
  projectId,
  instanceId,
  title = 'Rhino에 만들기',
  bake,
  onRecompute,
  onFocus,
  revision,
}: BakePartProps) {
  const base = `/projects/${encodeURIComponent(projectId)}/jig-instances/${encodeURIComponent(instanceId)}`;
  const [offers, setOffers] = useState<Offer[]>([]);
  const [records, setRecords] = useState<BakeRecord[]>([]);
  const [stale, setStale] = useState(false);
  const [last, setLast] = useState<Last>();
  const [choices, setChoices] = useState<Record<string, Resolve>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  /** A request-opened instance has no output layer yet (ADR-026): the bakes waiting for one. */
  const [needLayer, setNeedLayer] = useState<string[]>();
  const [layer, setLayer] = useState('');
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const wanted = bake?.join(',');
  const load = useCallback(async () => {
    const { ok, body } = await call(`${base}/bakes`);
    if (!ok || !alive.current) return;
    const parsed = bakesSchema.safeParse(body);
    if (!parsed.success) return;
    const only = wanted?.split(',');
    setOffers(parsed.data.offers.filter((o) => !only || only.includes(o.id)));
    setRecords(parsed.data.bakes);
    setStale(parsed.data.stale);
  }, [base, wanted]);
  useEffect(() => {
    void load();
  }, [load, revision]);

  // Follow the candidate request until it ends; its result carries the real summary.
  const requestId = last?.requestId;
  const following = last?.state === 'running';
  useEffect(() => {
    if (!requestId || !following) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const { ok, body } = await call(
        `/projects/${encodeURIComponent(projectId)}/requests/${requestId}`,
      );
      if (!alive.current) return;
      const state = ok && typeof body.state === 'string' ? body.state : 'running';
      if (state === 'queued' || state === 'running') {
        timer = setTimeout(poll, 1500);
        return;
      }
      const result = (body.result ?? {}) as { bake?: unknown };
      const summary = bakeSummarySchema.safeParse(result.bake);
      setLast((current) =>
        current && current.requestId === requestId
          ? {
              ...current,
              summary: summary.success ? summary.data : current.summary,
              state:
                state === 'succeeded' ? 'succeeded' : state === 'failed' ? 'failed' : 'unknown',
            }
          : current,
      );
      void load();
    };
    timer = setTimeout(poll, 800);
    return () => clearTimeout(timer);
  }, [requestId, following, projectId, load]);

  const start = async (ids: string[]) => {
    if (!ids.length) return;
    setBusy(true);
    setNotice('');
    try {
      const resolve = Object.keys(choices).length ? choices : undefined;
      const { ok, body } = await call(`${base}/bake`, 'POST', { bake: ids, resolve });
      if (!ok && body.code === 'LAYER_ROOT_MISSING') {
        setNeedLayer(ids);
        setNotice(
          '이 작업본은 요청으로 열어 출력 레이어가 아직 없습니다. 연결 모델에 있는 레이어를 적으면 그 바로 아래 한 단계에 만듭니다.',
        );
        return;
      }
      if (!ok) {
        setNotice(errorText(body, '만들지 못했습니다.'));
        return;
      }
      if (body.status === 'absorbed') {
        setChoices({});
        setNotice(
          `Rhino에서 고친 ${Number(body.absorbed) || 0}개를 수정 사항으로 받았습니다. 다시 계산한 뒤 다시 누르세요.`,
        );
        return;
      }
      const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
      if (body.status === 'applied') {
        // Made in the open document; the result carries the real summary.
        const made = bakeSummarySchema.safeParse(body.bake);
        const summary = made.success ? made.data : provisional(body);
        if (summary) setLast({ requestId, summary, state: 'applied' });
        setChoices({});
        await load();
        return;
      }
      const summary = provisional(body);
      if (summary) setLast({ requestId, summary, state: 'running' });
      if (typeof body.notice === 'string') setNotice(body.notice);
      setChoices({});
    } catch {
      setNotice('엔진에 연결하지 못했습니다.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const baseline = async (record: BakeRecord) => {
    setBusy(true);
    setNotice('');
    try {
      const { ok, body } = await call(
        `${base}/bakes/${encodeURIComponent(record.id)}/baseline`,
        'POST',
        {},
      );
      if (!ok) setNotice(errorText(body, '반영 결과를 읽지 못했습니다.'));
      else {
        const missing = Array.isArray(body.missing) ? body.missing.length : 0;
        setNotice(
          `반영 결과를 읽었습니다: ${Number(body.recorded) || 0}개 기록${missing ? ` · 찾지 못함 ${missing}개` : ''}`,
        );
        if (last?.requestId === record.requestId) setLast({ ...last, state: 'applied' });
      }
      await load();
    } catch {
      setNotice('엔진에 연결하지 못했습니다.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const undo = async (record: BakeRecord) => {
    setBusy(true);
    setNotice('');
    try {
      const { ok, body } = await call(
        `${base}/bakes/${encodeURIComponent(record.id)}/undo`,
        'POST',
        {},
      );
      if (!ok) setNotice(errorText(body, '되돌리지 못했습니다.'));
      else {
        setNotice('이번 만들기를 Rhino에서 되돌렸습니다.');
        if (last?.requestId === record.requestId) setLast({ ...last, state: 'undone' });
      }
      await load();
    } catch {
      setNotice('엔진에 연결하지 못했습니다.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const lineIds = offers.filter((o) => !needsAnalysis(o)).map((o) => o.id);
  const memberIds = offers.filter(needsAnalysis).map((o) => o.id);
  const lastRecords = last?.requestId ? records.filter((r) => r.requestId === last.requestId) : [];
  const baselineState: BakeCardProps['baseline'] = lastRecords.length
    ? lastRecords.every((r) => !r.pendingBaseline)
      ? 'recorded'
      : 'pending'
    : undefined;
  const undoable = lastRecords.find((r) => r.undoable);
  const chosen = Object.entries(choices);

  return (
    <div className="kit-card bake-part" data-part="bake-card">
      <strong>
        {title}
        {stale ? <span className="kit-badge">만든 결과가 오래됨</span> : null}
      </strong>
      {offers.length ? (
        <div className="kit-actions">
          {lineIds.length ? (
            <button type="button" disabled={busy || following} onClick={() => void start(lineIds)}>
              {memberIds.length ? '선만 먼저 만들기' : '만들기'}
            </button>
          ) : null}
          {memberIds.length ? (
            <button
              type="button"
              disabled={busy || following}
              onClick={() => void start(memberIds)}
              title="같은 입력의 확정 해석이 있어야 합니다"
            >
              부재 만들기
            </button>
          ) : null}
        </div>
      ) : (
        <span className="kit-muted">이 작업본은 Rhino에 만들 수 있는 결과가 없습니다.</span>
      )}
      {chosen.length ? (
        <small className="kit-muted">
          다음 만들기에 적용:{' '}
          {chosen.map(([key, choice]) => `${key} ${choiceText[choice]}`).join(', ')}
        </small>
      ) : null}
      {notice ? (
        <p className="kit-notice" role="status">
          {notice}
        </p>
      ) : null}
      {needLayer ? (
        <form
          className="kit-actions"
          aria-label="출력 레이어"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              if (!layer.trim()) return;
              setBusy(true);
              const { ok, body } = await call(`${base}/layer-root`, 'PUT', {
                layerRoot: layer.trim(),
              });
              setBusy(false);
              if (!ok) {
                setNotice(
                  body.code === 'LAYER_ROOT_MISSING'
                    ? '연결 모델에 없는 레이어입니다. 연결 파일에 있는 레이어를 적으세요.'
                    : errorText(body, '출력 레이어를 정하지 못했습니다.'),
                );
                return;
              }
              const ids = needLayer;
              setNeedLayer(undefined);
              await start(ids);
            })();
          }}
        >
          <input
            value={layer}
            maxLength={1000}
            placeholder="연결 모델의 레이어 이름"
            onChange={(event) => setLayer(event.target.value)}
          />
          <button type="submit" disabled={busy || !layer.trim()}>
            정하고 만들기
          </button>
        </form>
      ) : null}
      {last ? (
        <>
          <BakeCard
            summary={last.summary}
            state={last.state}
            baseline={baselineState}
            stale={stale}
            onUndo={undoable && !busy ? () => void undo(undoable) : undefined}
            onRecordBaseline={
              lastRecords.some((r) => r.pendingBaseline)
                ? () => void baseline(lastRecords.find((r) => r.pendingBaseline)!)
                : undefined
            }
            onResolve={(_bakeId, key, choice) =>
              setChoices((current) => ({ ...current, [key]: choice }))
            }
            onFocus={onFocus}
          />
          {last.state === 'succeeded' ? (
            <small className="kit-muted">
              작업 사본에만 만들었습니다. 파일을 Rhino에서 열어 연결하세요.
            </small>
          ) : null}
        </>
      ) : null}
      {onRecompute && notice.startsWith('Rhino에서 고친') ? (
        <button type="button" onClick={onRecompute}>
          다시 계산
        </button>
      ) : null}
      {records.length ? (
        <details className="bake-records">
          <summary>만든 기록 {records.length}개</summary>
          <ul>
            {records.map((record) => {
              const count = Object.values(record.items).filter((i) => i.state === 'jig').length;
              return (
                <li key={record.id}>
                  <span>{bakeLabel(record.bakeId)}</span>
                  <small>
                    {' '}
                    객체 {count}개 ·{' '}
                    {record.undone
                      ? '되돌림'
                      : record.pendingBaseline
                        ? '만든 뒤 읽기 전'
                        : `만듦 ${new Date(record.appliedAt!).toLocaleString('ko-KR')}`}
                  </small>
                  {record.pendingBaseline ? (
                    <button type="button" disabled={busy} onClick={() => void baseline(record)}>
                      반영 결과 읽기
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
const choiceText: Record<Resolve, string> = {
  keep: '유지',
  overwrite: '덮기',
  absorb: '수정 사항으로 받기',
};
