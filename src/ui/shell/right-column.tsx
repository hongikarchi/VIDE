// RightColumn (PLAN-26 T-113, region C): the AI column: panel chrome, chat heading, conversation
// chips, the work view with its request queue, question cards and the proposal slot, around the
// composer. Each part renders from the work slice (src/ui/store/work.ts), which
// src/ui/app/thread.ts writes; the screens that come from modules the shell does not import (chips,
// work view, question cards) arrive in the slice as parts. The panel chrome (`#panel-header`,
// `#panel-card`, `#panel-footer`) is still filled by the panel-mode start (src/ui/app/boot.ts), so it
// stays static markup here; the composer is region D's component, rendered unchanged.
import { memo, useLayoutEffect, useRef } from 'react';
import { useStore } from '../store/core.ts';
import { workState } from '../store/work.ts';
import { PendingRequests } from '../requests.tsx';
import { Composer } from './composer.tsx';
import { PartBoundary } from './part-boundary.tsx';
import { RouteCard } from './route-card.tsx';
import { AgendaHelper } from './agenda-helper.tsx';

/** Filled and shown by the panel-mode start; React never redraws these containers. */
const PanelTop = memo(function PanelTop() {
  return (
    <>
      <div className="panel-header" id="panel-header" hidden />
      <div id="panel-card" hidden />
    </>
  );
});
const PanelFooter = memo(function PanelFooter() {
  return <div id="panel-footer" hidden />;
});

function ConversationChips() {
  const chips = useStore(workState, (slice) => slice.chips);
  return (
    <div className="conversation-chips" id="conversation-chips" aria-label="대화">
      {chips ? (
        <PartBoundary name="conversation-chips" reset={chips}>
          <chips.View key={chips.key} {...chips.props} />
        </PartBoundary>
      ) : null}
    </div>
  );
}

/** The Make tab's side panel (src/ui/make-tab.tsx portals into it), right under the chips. */
function MakeSide() {
  const receive = useStore(workState, (slice) => slice.makeSide);
  return receive ? <section className="make-side" aria-label="제작 진행" ref={receive} /> : null;
}

function Conversation() {
  const thread = useStore(workState, (slice) => slice.thread);
  const filter = useStore(workState, (slice) => slice.filter);
  return (
    <div id="conversation" aria-label="작업 보기" aria-live="polite">
      {thread ? (
        <PartBoundary name="conversation" reset={thread}>
          <thread.View {...thread.props} filter={filter} />
        </PartBoundary>
      ) : (
        <div className="chat-empty">요청을 보내면 진행 단계와 결과가 여기에 표시됩니다.</div>
      )}
    </div>
  );
}

function RequestQueue() {
  const queue = useStore(workState, (slice) => slice.queue);
  return (
    <div className="thread-queue" id="thread-queue">
      <div className="queue-head">
        {'대기 중인 요청 '}
        <span id="request-count">
          {queue ? String(queue.state.instructions?.length ?? 0) : '0'}
        </span>
        {' · 보내기를 누르면 함께 실행'}
      </div>
      <div id="pending-requests">
        {queue ? (
          <PartBoundary name="pending-requests" reset={queue}>
            <PendingRequests
              state={queue.state}
              onChange={queue.onChange}
              onEdited={() => {
                // The edited text shows at once: the same queue, drawn again.
                if (workState.queue) workState.queue = { ...workState.queue };
                workState.bump();
              }}
            />
          </PartBoundary>
        ) : null}
      </div>
    </div>
  );
}

/** `#thread`: back to its top whenever a work is focused (`focusWork`, also the same one again). */
function Thread() {
  const token = useStore(workState, (slice) => slice.focusToken);
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (token && element.current) element.current.scrollTop = 0;
  }, [token]);
  return (
    <div id="thread" ref={element}>
      <Conversation />
      <RequestQueue />
    </div>
  );
}

function RecentSection() {
  const open = useStore(workState, (slice) => slice.recentOpen);
  return (
    <section className="thread-section" id="recent-section" data-open={String(open)}>
      <div className="recent-heading">
        <span className="thread-title">
          {'작업 '}
          <span id="recent-count" />
        </span>
        <button
          id="toggle-recent"
          type="button"
          hidden
          aria-expanded={open}
          onClick={() => {
            workState.recentOpen = !workState.recentOpen;
            workState.bump();
          }}
        />
      </div>
      <Thread />
    </section>
  );
}

function QuestionCards() {
  const cards = useStore(workState, (slice) => slice.questionCards);
  return (
    <div className="question-cards" id="question-cards">
      {cards ? (
        <PartBoundary name="question-cards" reset={cards}>
          <cards.View key={cards.key} {...cards.props} />
        </PartBoundary>
      ) : null}
    </div>
  );
}

export const RightColumn = memo(function RightColumn() {
  return (
    <>
      <aside id="right">
        <PanelTop />
        <div className="chat-heading">
          <h2>AI WORK</h2>
        </div>
        <AgendaHelper />
        <ConversationChips />
        <MakeSide />
        <RecentSection />
        {'\n'}
        <QuestionCards />
        <RouteCard />
        <Composer />
        <PanelFooter />
      </aside>
    </>
  );
});
