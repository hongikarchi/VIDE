// Composer (PLAN-26 T-113, region D): the composer: context chips, the message box, its actions and
// settings, drawn from the draft slice (`draftState.view`, set by render()'s composer parts in
// app/composer.ts). The message box `#body` is an uncontrolled textarea: app/composer.ts and
// pin-tokens.ts own its value, caret, `disabled` and listeners, and make-tab.tsx writes it and
// dispatches `input`; it never re-renders. `#effort-menu`'s `open` is the browser's.
import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { useStore } from '../store/core.ts';
import { draftState, type ContextItem } from '../store/draft.ts';
import { useComposerHeight } from '../composer-height.ts';
import { ConnectionBanner } from './connection-banner.tsx';

/**
 * The message box with the inline pin layers (pin-tokens.ts paints the backdrop, places the ghost
 * and sets `data-ghost`; React draws them once and leaves them).
 */
const MessageBox = memo(function MessageBox() {
  return (
    <div className="body-field">
      <div className="body-backdrop" aria-hidden="true" />
      <textarea
        id="body"
        disabled
        rows={3}
        placeholder="요청을 적거나, 객체·스케치·파일을 첨부하세요…"
      />
      <button
        type="button"
        className="pin-ghost"
        hidden
        title="선택한 객체를 이 위치에 고정합니다"
      />
    </div>
  );
});

function ContextChip({ item }: { item: ContextItem }) {
  if (item.kind === 'selection')
    return (
      <button
        type="button"
        className="chip selection-chip"
        title="지금 고른 객체를 이 요청의 대상으로 첨부합니다"
        onClick={item.run}
      >
        {item.text}
      </button>
    );
  if (item.kind === 'basis') return <button onClick={item.run}>입력 기준 보기</button>;
  if (item.kind === 'new-basis') return <small>새 작업 기준</small>;
  const select = item.select;
  return (
    <span
      className={select ? 'chip chip-action' : 'chip'}
      title={item.title || undefined}
      onClick={
        select
          ? (event) => {
              if (event.target === event.currentTarget) select();
            }
          : undefined
      }
    >
      {item.thumbnail ? <img className="chip-thumb" src={item.thumbnail} alt="" /> : null}
      {item.text}
      {item.action ? (
        <button
          type="button"
          className="chip-mask"
          title={item.action.title}
          onClick={item.action.run}
        >
          {item.action.label}
        </button>
      ) : null}
      <button aria-label={`${item.text} 제외`} onClick={item.remove}>
        ×
      </button>
    </span>
  );
}

export const Composer = memo(function Composer() {
  useStore(draftState, (slice) => slice.version);
  const view = draftState.view;
  const actions = draftState.actions;
  const resize = useComposerHeight();
  const [dropping, setDropping] = useState(false);
  const model = useRef<HTMLSelectElement>(null);
  const effort = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  // The menu's and the slider's values follow the draft after each draw (uncontrolled, so a value
  // set by a script or a change event that does not bubble still reaches the native listeners).
  useLayoutEffect(() => {
    if (model.current && view.model !== undefined) model.current.value = view.model;
    if (effort.current) effort.current.value = String(view.effort.index);
  });
  // `#model` keeps a native `change` listener: tests and the jig screens dispatch one that does
  // not bubble to React's root.
  useLayoutEffect(() => {
    const select = model.current;
    if (!select) return;
    const changed = () => draftState.actions.chooseModel(select.value);
    select.addEventListener('change', changed);
    return () => select.removeEventListener('change', changed);
  }, []);
  const carriesFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');
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
          {...resize}
        />
        <div
          className={dropping ? 'composer dropping' : 'composer'}
          onDragOver={(event) => {
            if (!carriesFiles(event)) return;
            event.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDropping(false);
          }}
          onDrop={(event) => {
            setDropping(false);
            if (!carriesFiles(event)) return;
            event.preventDefault();
            actions.attach(Array.from(event.dataTransfer?.files ?? []));
          }}
        >
          <div id="context" aria-label="첨부한 문맥">
            {view.context.map((item, index) => (
              <ContextChip key={item.kind + index} item={item} />
            ))}
          </div>
          <label className="sr-only" htmlFor="body">
            메시지
          </label>
          <MessageBox />
          <div className="compose-actions">
            <button
              id="attach-file"
              className="attach-button"
              type="button"
              aria-label="파일 첨부"
              title="파일·이미지 첨부 (모든 형식, 파일당 200MB) · 입력 상자에 붙여넣거나 끌어 놓아도 됩니다"
              data-icon="paperclip"
              disabled={view.attachDisabled}
              // The paperclip opens the file picker directly (SPEC-01.12 1).
              onClick={() => files.current?.click()}
            />
            <input
              id="files"
              type="file"
              multiple
              hidden
              ref={files}
              onChange={(event) => {
                const picked = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                actions.attach(picked);
              }}
            />
            <span id="saved">{view.saved}</span>
            <button
              id="add-request"
              className="queue"
              aria-label="요청 목록에 추가"
              title="요청 목록에 추가 · Shift+Enter"
              data-icon="list-plus"
              disabled={view.addDisabled}
              onClick={actions.queue}
            />
            <button
              id="request"
              className="send"
              aria-label="메시지 보내기"
              title={view.send.title}
              data-icon="send"
              disabled={view.send.disabled}
              aria-busy={draftState.routing ? 'true' : undefined}
              onClick={actions.send}
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
            data-mode={view.mode}
          >
            <button
              type="button"
              role="radio"
              data-mode="plan"
              aria-checked={view.mode === 'plan' ? 'true' : 'false'}
              disabled={view.ready === false}
              title="AI가 읽고 재고 계획한 뒤 질문합니다. 문서는 바꾸지 않습니다. 계획 카드의 [진행]으로 이어서 실행합니다."
              onClick={() => actions.setMode('plan')}
            >
              계획
            </button>
            <button
              type="button"
              role="radio"
              data-mode="auto"
              aria-checked={view.mode === 'plan' ? 'false' : 'true'}
              disabled={view.ready === false}
              title="AI가 열린 문서에서 바로 작업합니다. 실행마다 되돌리기 기록이 남아 Ctrl+Z나 [되돌리기]로 되돌릴 수 있습니다."
              onClick={() => actions.setMode('auto')}
            >
              자동
            </button>
          </div>
          <select
            id="model"
            aria-label="모델"
            title="설치 CLI 자료와 공식 지원 모델 목록입니다. 실제 계정 사용 가능 여부는 실행 시 확인됩니다."
            ref={model}
            disabled={view.modelDisabled}
          >
            {view.models.first.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name}
              </option>
            ))}
            {view.models.groups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.name}
                  </option>
                ))}
              </optgroup>
            ))}
            {view.extraModels.map((id) => (
              <option key={'extra:' + id} value={id}>
                {id + ' · 사용 확인 필요'}
              </option>
            ))}
          </select>
          <details className="effort-control" id="effort-menu">
            <summary title="추론 강도">
              <span aria-hidden="true">◷</span> <span id="effort-label">{view.effort.label}</span>
            </summary>
            <div className="effort-popover">
              <strong>추론 강도</strong>
              <input
                id="effort"
                type="range"
                min="0"
                max={String(view.effort.max)}
                step="1"
                defaultValue="0"
                aria-label="Effort"
                aria-valuetext={view.effort.title === undefined ? undefined : view.effort.label}
                title={view.effort.title}
                disabled={view.effort.disabled}
                style={
                  view.effort.fill === undefined
                    ? undefined
                    : ({ '--effort-fill': view.effort.fill } as CSSProperties)
                }
                ref={effort}
                onInput={(event) => actions.chooseEffort(event.currentTarget.valueAsNumber)}
              />
              <div id="effort-steps">
                {view.effort.steps.map((step, index) => (
                  <span key={index} data-active={String(step.active)}>
                    {step.text}
                  </span>
                ))}
              </div>
            </div>
          </details>
        </div>
        <p id="validation" role="status" />
        {'\n'}
      </div>
    </>
  );
});
