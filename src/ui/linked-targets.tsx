import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DraftState } from './model.ts';

export const linkedCandidates = (state: DraftState) =>
  state.messages.filter(
    (message) =>
      message.request.state === 'succeeded' &&
      message.request.result?.hostExecuted &&
      message.request.result?.executionMode === 'sdk',
  );
export function showLinkedTargets(state: DraftState, changed: () => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'quantity-dialog';
  dialog.setAttribute('aria-label', '연계 대상');
  document.body.append(dialog);
  const root = createRoot(dialog);
  const close = () => {
    dialog.close();
    root.unmount();
    dialog.remove();
  };
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  const candidates = linkedCandidates(state);
  function Targets() {
    const [selected, setSelected] = useState([
      state.linkedTargets?.[0]?.baseRequestId || '',
      state.linkedTargets?.[1]?.baseRequestId || '',
    ]);
    const [shared, setShared] = useState(false),
      [error, setError] = useState('');
    return (
      <>
        <header>
          <h2>연계 대상</h2>
          <button onClick={close}>닫기</button>
        </header>
        <p>한 요청에서 함께 다룰 기준 후보를 고르세요.</p>
        {[0, 1].map((index) => (
          <label key={index}>
            대상 {index + 1}
            <select
              aria-label={`연계 대상 ${index + 1}`}
              value={selected[index]}
              onChange={(event) => {
                setSelected(selected.map((value, i) => (i === index ? event.target.value : value)));
                setShared(false);
              }}
            >
              <option value="">기준 후보 선택</option>
              {candidates.map((message) => (
                <option key={message.id} value={message.id}>
                  {message.request.result?.host === 'zwcad' ? 'ZWCAD' : 'Rhino'} ·{' '}
                  {message.request.result?.sourceDocument?.name || message.body.slice(0, 80)}
                </option>
              ))}
            </select>
          </label>
        ))}
        <fieldset>
          <legend>두 문서의 좌표</legend>
          <label>
            <input
              type="radio"
              name="coordinate-basis"
              checked={!shared}
              onChange={() => setShared(false)}
            />
            원점·축이 다르거나 모름 — AI가 그리드·기둥 중심 등 대응 요소로 위치
            관계(이동·회전·축척·오차)를 먼저 구해 알려 줍니다.
          </label>
          <label>
            <input
              type="radio"
              name="coordinate-basis"
              checked={shared}
              onChange={() => setShared(true)}
            />
            m로 환산했을 때 원점과 축이 같음
          </label>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <button
          disabled={!selected.every(Boolean) || selected[0] === selected[1]}
          onClick={() => {
            try {
              state.linkedTargets = selected.map((baseRequestId) => ({
                baseRequestId,
                host:
                  candidates.find((m) => m.id === baseRequestId)!.request.result?.host === 'zwcad'
                    ? 'zwcad'
                    : 'rhino',
              }));
              state.coordinateBasis = shared ? 'shared-metre-axes' : 'align-by-features';
              changed();
              close();
            } catch (error) {
              setError(error instanceof Error ? error.message : '대상을 확인하세요.');
            }
          }}
        >
          요청에 첨부
        </button>
      </>
    );
  }
  root.render(<Targets />);
  dialog.showModal();
}
