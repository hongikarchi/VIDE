// Composer (PLAN-26 T-113, region D): the composer: context chips, the message box, its actions and
// settings. Static markup moved from index.html; it has no state or props and never re-renders
// until its region makes it stateful.
import { memo } from 'react';
import { ConnectionBanner } from './connection-banner.tsx';

export const Composer = memo(function Composer() {
  return (
    <>
      <div className="composer-wrap">
        <ConnectionBanner />
        <div
          id="composer-resize"
          role="separator"
          aria-label="메시지 입력 높이"
          aria-orientation="horizontal"
          tabIndex={0}
        />
        <div className="composer">
          <div id="context" aria-label="첨부한 문맥" />
          <label className="sr-only" htmlFor="body">
            메시지
          </label>
          <textarea
            id="body"
            disabled
            rows={3}
            placeholder="요청을 적거나, 객체·스케치·파일을 첨부하세요…"
          />
          <div className="compose-actions">
            <button
              id="attach-file"
              className="attach-button"
              type="button"
              aria-label="파일 첨부"
              title="파일·이미지 첨부 (모든 형식, 파일당 200MB) · 입력 상자에 붙여넣거나 끌어 놓아도 됩니다"
              data-icon="paperclip"
            />
            <input id="files" type="file" multiple hidden />
            <span id="saved" />
            <button
              id="add-request"
              className="queue"
              aria-label="요청 목록에 추가"
              title="요청 목록에 추가 · Shift+Enter"
              data-icon="list-plus"
            />
            <button
              id="request"
              className="send"
              aria-label="메시지 보내기"
              title="보내기 · Ctrl+Enter"
              data-icon="send"
            />
          </div>
        </div>
        {'\n'}
        <div className="composer-settings">
          <div
            id="mode-toggle"
            className="mode-toggle"
            role="radiogroup"
            aria-label="작업 모드"
            title="작업 모드 · Shift+Tab으로 전환"
          >
            <button
              type="button"
              role="radio"
              data-mode="plan"
              aria-checked="false"
              title="AI가 읽고 재고 계획한 뒤 질문합니다. 문서는 바꾸지 않습니다. 계획 카드의 [진행]으로 이어서 실행합니다."
            >
              계획
            </button>
            <button
              type="button"
              role="radio"
              data-mode="auto"
              aria-checked="true"
              title="AI가 열린 문서에서 바로 작업합니다. 실행마다 되돌리기 기록이 남아 Ctrl+Z나 [되돌리기]로 되돌릴 수 있습니다."
            >
              자동
            </button>
          </div>
          <select
            id="model"
            aria-label="모델"
            title="설치 CLI 자료와 공식 지원 모델 목록입니다. 실제 계정 사용 가능 여부는 실행 시 확인됩니다."
          />
          <details className="effort-control" id="effort-menu">
            <summary title="추론 강도">
              <span aria-hidden="true">◷</span> <span id="effort-label">기본값</span>
            </summary>
            <div className="effort-popover">
              <strong>추론 강도</strong>
              <input
                id="effort"
                type="range"
                min="0"
                max="0"
                step="1"
                defaultValue="0"
                aria-label="Effort"
              />
              <div id="effort-steps" />
            </div>
          </details>
        </div>
        <p id="validation" role="status" />
        {'\n'}
      </div>
    </>
  );
});
