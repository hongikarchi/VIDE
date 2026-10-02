// RightColumn (PLAN-26 T-113, region C): the AI column: panel chrome, chat heading, conversation
// chips, the work view, question cards and the route card. Static markup moved from index.html; it
// has no state or props and never re-renders until its region makes it stateful.
import { memo } from 'react';
import { Composer } from './composer.tsx';

export const RightColumn = memo(function RightColumn() {
  return (
    <>
      <aside id="right">
        <div className="panel-header" id="panel-header" hidden />
        <div id="panel-card" hidden />
        <div className="chat-heading">
          <h2>AI WORK</h2>
        </div>
        <div className="conversation-chips" id="conversation-chips" aria-label="대화" />
        <section className="thread-section" id="recent-section" data-open="true">
          <div className="recent-heading">
            <span className="thread-title">
              {'작업 '}
              <span id="recent-count" />
            </span>
            <button id="toggle-recent" type="button" hidden aria-expanded="true" />
          </div>
          <div id="thread">
            <div id="conversation" aria-label="작업 보기" aria-live="polite">
              <div className="chat-empty">요청을 보내면 진행 단계와 결과가 여기에 표시됩니다.</div>
            </div>
            <div className="thread-queue" id="thread-queue">
              <div className="queue-head">
                {'대기 중인 요청 '}
                <span id="request-count">0</span>
                {' · 보내기를 누르면 함께 실행'}
              </div>
              <div id="pending-requests" />
            </div>
          </div>
        </section>
        {'\n'}
        <div className="question-cards" id="question-cards" />
        <div className="route-card" id="route-card" role="group" aria-label="요청 제안" hidden />
        <Composer />
        <div id="panel-footer" hidden />
      </aside>
    </>
  );
});
