// 갱신 제안 카드 (PLAN-54 T-349·T-351, SPEC-05.12, Design SCR-47): at the top of the work column, in
// the request cards' place and box. One card per designated pair whose one side changed: the files,
// the time, the mismatch rows in the Sync jig's row format with a check box each, and [적용]·[무시]·
// [나중에]. Two or more cards fold into '갱신 제안 n건' with one pair open at a time. While a card
// shows, the model viewport draws its rows: the line as it is (accent) and after (dashed, 50%).
// A remote session sees the card and the overlay, with no buttons.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store/core.ts';
import { sessionState } from './store/session.ts';
import { statusState } from './store/status.ts';
import { viewerState } from './store/viewer.ts';
import { setWorkspace } from './workspaces.ts';
import type { OverlayItem } from './viewport.ts';
import {
  applyProposal,
  dismissProposal,
  laterProposal,
  listProposals,
  proposalSchema,
  REFUSAL_TEXT,
  rowText,
  timeText,
  type Proposal,
} from './sync-pairs-api.ts';
import './proposal-card.css';

/** How often the cards are read again (the engine computes them after each Sync). */
const POLL_MS = 5000;
const SHOWN_ROWS = 5;
const OVERLAY_NOW = 'vide-proposal-now';
const OVERLAY_AFTER = 'vide-proposal-after';

const FAILURE: Record<string, string> = {
  PAIR_LINK_CLOSED: '연결이 닫혔습니다',
  HOST_BUSY: '프로그램이 바쁩니다 — 끝나면 다시 누르세요',
  PROPOSAL_STALE: '목록이 바뀌어 다시 계산했습니다',
  PROPOSAL_NOT_FOUND: '이 제안은 이미 닫혔습니다',
  OUTPUT_UNCLEAR: '결과를 확인하지 못했습니다. 다시 적용하지 않습니다',
  ROW_NOT_SELECTABLE: '맞출 수 있는 행을 고르세요',
  PROPOSAL_DIRECTION_PENDING: '도면을 기준으로 모델을 맞추는 일은 Sync jig에서 하세요',
};
/** SPEC-14.10 3: additions and changes are chosen; a deletion (CAD에만) starts unchosen. */
const defaultPicked = (rows: Proposal['rows'], refused: ReadonlyMap<string, unknown>) =>
  new Set(
    rows.filter((row) => !refused.has(row.id) && row.state !== 'cad-only').map((row) => row.id),
  );
/** SPEC-05.12 8 ⑤: the host-side marks (T-350) are not drawn yet, so every card says so. */
const HOST_MARK_NOTE = '프로그램 안에는 표시하지 못했습니다 · 여기에만 보입니다';
const codeOf = (error: unknown) => String((error as { code?: unknown })?.code ?? '');
const head = (card: Proposal) =>
  card.changedSide === 'model'
    ? '모델이 바뀌었어요. 도면도 맞출까요?'
    : '도면이 바뀌었어요. 모델도 맞출까요?';
const sub = (card: Proposal) =>
  card.changedSide === 'model'
    ? `${card.names.model} → ${card.names.drawing} · 바뀐 시각 ${timeText(card.changedAt)}`
    : `${card.names.drawing} → ${card.names.model} · 바뀐 시각 ${timeText(card.changedAt)}`;

/** The overlay items of the shown cards' chosen rows (model coordinates, metres). */
export function overlayItems(cards: readonly Proposal[]) {
  const now: OverlayItem[] = [];
  const after: OverlayItem[] = [];
  for (const card of cards)
    for (const row of card.rows) {
      if (row.overlay?.now)
        now.push({
          id: `${card.id}:${row.id}`,
          kind: 'polyline',
          points: row.overlay.now,
          tone: 'accent',
          width: 3,
        });
      if (row.overlay?.after)
        after.push({
          id: `${card.id}:${row.id}`,
          kind: 'polyline',
          points: row.overlay.after,
          tone: 'accent',
          dashed: true,
          width: 2,
        });
    }
  return { now, after };
}

function CardBody({
  card,
  projectId,
  remote,
  onChanged,
}: {
  card: Proposal;
  projectId: string;
  remote: boolean;
  onChanged: (next: Proposal | null, message?: string) => void;
}) {
  const refused = useMemo(
    () => new Map(card.refused.map((entry) => [entry.rowId, entry])),
    [card.refused],
  );
  const [picked, setPicked] = useState(() => defaultPicked(card.rows, refused));
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  // A recomputed card keeps the choice of rows that are still there.
  const rowsKey = card.rows.map((row) => row.key).join(',');
  useEffect(() => {
    setPicked(defaultPicked(card.rows, refused));
  }, [rowsKey, refused, card.rows]);
  const rows =
    more || card.rows.length <= SHOWN_ROWS + 1 ? card.rows : card.rows.slice(0, SHOWN_ROWS);
  const drawingSide = card.changedSide === 'drawing';
  const selectable = card.rows.filter((row) => !refused.has(row.id));
  const canApply =
    !remote && !drawingSide && !card.blocked && selectable.some((row) => picked.has(row.id));
  const show = (row: Proposal['rows'][number]) => {
    if (!row.rhino) return;
    const target = row.rhino.id;
    void import('./app/viewport.ts').then((viewport) => {
      viewport.selectInResult(card.basis.modelSync, target);
    });
  };
  const run = async (action: 'apply' | 'dismiss' | 'later') => {
    setBusy(true);
    setFailure('');
    try {
      if (action === 'later') {
        await laterProposal(projectId, card.id);
        onChanged(null);
      } else if (action === 'dismiss') {
        await dismissProposal(projectId, card.id);
        onChanged(null);
      } else {
        const rowsChosen = card.rows.filter((row) => picked.has(row.id)).map((row) => row.id);
        let answer;
        try {
          answer = await applyProposal(projectId, card.id, { rows: rowsChosen });
        } catch (error) {
          if (codeOf(error) !== 'DELETE_CONFIRMATION_REQUIRED') throw error;
          const count = card.rows.filter(
            (row) => picked.has(row.id) && row.state === 'cad-only',
          ).length;
          if (!confirm(`도면에서 ${count}개를 지웁니다. 계속할까요?`)) return;
          answer = await applyProposal(projectId, card.id, {
            rows: rowsChosen,
            confirmDeletes: true,
          });
        }
        const result = answer.result;
        const notApplied = result.refused?.length
          ? ` · 맞추지 않은 행 ${result.refused.length}`
          : '';
        if (result.state === 'applied') {
          const count = result.files?.[0]?.rows?.length ?? rowsChosen.length;
          onChanged(
            null,
            `도면에 ${count}행을 맞췄습니다${notApplied} · 되돌리기는 ZWCAD에서 Ctrl+Z 한 번입니다. 저장은 ZWCAD에서 하세요.`,
          );
        } else if (result.state === 'unclear') {
          onChanged(answer.proposal);
          setFailure(FAILURE.OUTPUT_UNCLEAR!);
        } else {
          onChanged(answer.proposal);
          setFailure(`맞추지 못했습니다. 도면은 그대로입니다${notApplied}`);
        }
      }
    } catch (error) {
      const code = codeOf(error);
      if (code === 'PROPOSAL_STALE') {
        // The engine answered with the list computed again; show it instead.
        const fresh = proposalSchema.safeParse((error as { proposal?: unknown }).proposal);
        onChanged(fresh.success ? fresh.data : null);
      } else if (code === 'PROPOSAL_NOT_FOUND') onChanged(null);
      setFailure(FAILURE[code] ?? '맞추지 못했습니다');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ol className="proposal-rows" aria-label="어긋남 목록">
        {rows.map((row) => {
          const refusal = refused.get(row.id);
          return (
            <li key={row.id} data-refused={refusal ? 'true' : undefined}>
              <input
                type="checkbox"
                aria-label={`${row.id} 맞추기`}
                checked={!refusal && picked.has(row.id)}
                disabled={!!refusal || remote || drawingSide}
                onChange={(event) => {
                  const next = new Set(picked);
                  if (event.target.checked) next.add(row.id);
                  else next.delete(row.id);
                  setPicked(next);
                }}
              />
              <button type="button" className="proposal-row-text" onClick={() => show(row)}>
                {rowText(row, card.changedSide)}
              </button>
              {refusal ? (
                <span className="proposal-row-reason">{REFUSAL_TEXT[refusal.reason]}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {card.rows.length > rows.length ? (
        <button type="button" className="link-button" onClick={() => setMore(true)}>
          나머지 {card.rows.length - rows.length}행
        </button>
      ) : null}
      {remote ? (
        <p className="proposal-note">작업 PC의 VIDE에서 맞추세요</p>
      ) : (
        <div className="route-card-actions proposal-actions">
          <button
            type="button"
            className="primary-button"
            disabled={!canApply || busy}
            onClick={() => void run('apply')}
          >
            {busy ? '맞추는 중…' : '적용'}
          </button>
          <button type="button" disabled={busy} onClick={() => void run('dismiss')}>
            무시
          </button>
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => void run('later')}
          >
            나중에
          </button>
        </div>
      )}
      {drawingSide && !remote ? (
        <p className="proposal-note">
          Sync jig에서 맞추세요{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => setWorkspace('jig', { instanceId: 'legacy:sync' })}
          >
            Sync jig 열기
          </button>
        </p>
      ) : null}
      {failure ? (
        <p className="proposal-failure" role="status">
          {failure}
        </p>
      ) : null}
    </>
  );
}

export function ProposalCardsView({
  projectId,
  cards,
  remote,
  onChanged,
  message,
}: {
  projectId: string;
  cards: Proposal[];
  remote: boolean;
  onChanged: (cardId: string, next: Proposal | null, message?: string) => void;
  message: string;
}) {
  const [open, setOpen] = useState<string | undefined>();
  const [overlay, setOverlay] = useState(true);
  const shown = cards.length === 1 ? cards : cards.filter((card) => card.id === open);
  // The viewport overlay follows the cards shown (cleared when none is).
  const items = useMemo(() => overlayItems(overlay ? shown : []), [shown, overlay]);
  const viewport = useStore(viewerState, (slice) => slice.viewport);
  useEffect(() => {
    if (!viewport) return;
    viewport.overlay(OVERLAY_NOW, items.now.length ? items.now : null);
    viewport.overlay(OVERLAY_AFTER, items.after.length ? items.after : null);
    viewport.overlayStyle?.(OVERLAY_AFTER, { opacity: 0.5 });
  }, [viewport, items]);
  useEffect(
    () => () => {
      viewerState.viewport?.overlay(OVERLAY_NOW, null);
      viewerState.viewport?.overlay(OVERLAY_AFTER, null);
    },
    [],
  );
  if (!cards.length)
    return message ? (
      <section className="proposal-card" aria-label="갱신 제안">
        <p className="proposal-sub" role="status">
          {message}
        </p>
      </section>
    ) : null;
  const toggle = (
    <label className="proposal-overlay-toggle">
      <input
        type="checkbox"
        checked={overlay}
        onChange={(event) => setOverlay(event.target.checked)}
      />
      뷰포트에 겹쳐 보기
    </label>
  );
  if (cards.length === 1) {
    const card = cards[0]!;
    return (
      <section className="proposal-card" aria-label="갱신 제안">
        <p className="proposal-head">{head(card)}</p>
        <p className="proposal-sub">{sub(card)}</p>
        <p className="proposal-sub">{HOST_MARK_NOTE}</p>
        {toggle}
        <CardBody
          key={card.id}
          card={card}
          projectId={projectId}
          remote={remote}
          onChanged={(next, text) => onChanged(card.id, next, text)}
        />
      </section>
    );
  }
  return (
    <section className="proposal-card" aria-label="갱신 제안">
      <p className="proposal-head">갱신 제안 {cards.length}건</p>
      <p className="proposal-sub">{HOST_MARK_NOTE}</p>
      {toggle}
      <ul className="proposal-pairs">
        {cards.map((card) => (
          <li key={card.id}>
            <button
              type="button"
              className="proposal-pair"
              aria-expanded={open === card.id}
              onClick={() => setOpen(open === card.id ? undefined : card.id)}
            >
              {card.names.model} ↔ {card.names.drawing} ·{' '}
              {card.changedSide === 'model' ? '모델 변경' : '도면 변경'} · 어긋남 {card.rows.length}
            </button>
            {open === card.id ? (
              <div className="proposal-open">
                <p className="proposal-head">{head(card)}</p>
                <p className="proposal-sub">{sub(card)}</p>
                <CardBody
                  key={card.id}
                  card={card}
                  projectId={projectId}
                  remote={remote}
                  onChanged={(next, text) => onChanged(card.id, next, text)}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {message ? (
        <p className="proposal-sub" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}

/** The work column's slot: reads the open project's cards every few seconds. */
export const ProposalCards = memo(function ProposalCards() {
  const projectId = useStore(sessionState, (slice) => slice.project?.id);
  const remote = useStore(statusState, (slice) => slice.remote);
  const [cards, setCards] = useState<Proposal[]>([]);
  const [message, setMessage] = useState('');
  const messageTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const read = useCallback(async () => {
    if (!projectId || document.hidden) return;
    try {
      setCards(await listProposals(projectId));
    } catch {
      /* the next poll tries again */
    }
  }, [projectId]);
  useEffect(() => {
    setCards([]);
    if (!projectId) return;
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => clearInterval(timer);
  }, [projectId, read]);
  useEffect(() => () => clearTimeout(messageTimer.current), []);
  if (!projectId) return null;
  return (
    <ProposalCardsView
      projectId={projectId}
      cards={cards}
      remote={remote}
      message={message}
      onChanged={(cardId, next, text) => {
        setCards((list) =>
          next
            ? list.map((card) => (card.id === cardId ? next : card))
            : list.filter((card) => card.id !== cardId),
        );
        if (text) {
          setMessage(text);
          clearTimeout(messageTimer.current);
          messageTimer.current = setTimeout(() => setMessage(''), 12000);
        }
      }}
    />
  );
});
