import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DraftState } from './model.ts';

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
  const candidates = state.messages.filter(
    (message) =>
      message.request.state === 'succeeded' &&
      message.request.result?.hostExecuted &&
      message.request.result?.executionMode === 'sdk',
  );
  function Targets() {
    const [selected, setSelected] = useState([
      state.linkedTargets?.[0]?.baseRequestId || '',
      state.linkedTargets?.[1]?.baseRequestId || '',
    ]);
    const [confirmed, setConfirmed] = useState(false),
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
                setConfirmed(false);
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
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          두 문서의 좌표를 m로 환산했을 때 원점과 축이 같습니다.
        </label>
        <p>
          배치 기준이 다른 문서는 먼저 좌표를 맞춰야 합니다. 원본 적용은 후보 확인 후 별도로
          진행합니다.
        </p>
        {error && <p role="alert">{error}</p>}
        <button
          disabled={!confirmed || !selected.every(Boolean) || selected[0] === selected[1]}
          onClick={() => {
            try {
              state.linkedTargets = selected.map((baseRequestId) => ({
                baseRequestId,
                host:
                  candidates.find((m) => m.id === baseRequestId)!.request.result?.host === 'zwcad'
                    ? 'zwcad'
                    : 'rhino',
              }));
              state.coordinateBasis = 'shared-metre-axes';
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
