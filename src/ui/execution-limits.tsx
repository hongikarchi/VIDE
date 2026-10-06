import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  conversationTurnLimits,
  executionLimitsSchema,
  requestLimits,
  type ExecutionLimits,
} from '../contracts/execution-limits.ts';

/**
 * The AI's wait (SPEC-02.6): since ADR-031 8 (T-122) a turn has no tool-call or execute cap and stops
 * only after this many seconds without any output. The other two contract fields keep their values.
 */
const presets: { label: string; seconds: number }[] = [
  { label: '기본', seconds: requestLimits.timeoutSeconds },
  { label: '대화 턴', seconds: conversationTurnLimits.timeoutSeconds },
];

export function showExecutionLimits(
  value: ExecutionLimits,
  save: (value: ExecutionLimits) => void,
) {
  const dialog = document.createElement('dialog');
  dialog.className = 'quantity-dialog execution-limits';
  dialog.setAttribute('aria-label', 'AI 응답 대기');
  document.body.append(dialog);
  const root = createRoot(dialog);
  function Settings() {
    const [message, setMessage] = useState('');
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const parsed = executionLimitsSchema.safeParse({
            ...value,
            timeoutSeconds: Number(data.get('timeoutSeconds')),
          });
          if (!parsed.success) {
            setMessage('30~600 사이의 정수를 입력하세요.');
            return;
          }
          save(parsed.data);
          dialog.close();
        }}
      >
        <h2>AI 응답 대기</h2>
        <p>
          AI가 이 시간 동안 아무 출력도 없으면 작업을 멈춥니다. 조회·실행 횟수에는 상한이 없습니다.
          다음 요청부터 적용합니다.
        </p>
        <p>대화의 턴은 따로 정하지 않으면 {conversationTurnLimits.timeoutSeconds}초를 씁니다.</p>
        <div className="table-controls" role="group" aria-label="미리 정한 값">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={(event) => {
                const field = event.currentTarget.form?.elements.namedItem('timeoutSeconds');
                if (field instanceof HTMLInputElement) field.value = String(preset.seconds);
                setMessage(`${preset.label} 값을 채웠습니다. 적용을 누르세요.`);
              }}
            >
              {preset.label} {preset.seconds}초
            </button>
          ))}
        </div>
        <label>
          응답 없이 기다리는 시간 (초){' '}
          <input
            name="timeoutSeconds"
            type="number"
            required
            min="30"
            max="600"
            step="1"
            defaultValue={value.timeoutSeconds}
          />
        </label>
        <p role="status">{message}</p>
        <div className="table-controls">
          <button type="submit">적용</button>
          <button type="button" onClick={() => dialog.close()}>
            취소
          </button>
        </div>
      </form>
    );
  }
  root.render(<Settings />);
  dialog.addEventListener(
    'close',
    () => {
      root.unmount();
      dialog.remove();
    },
    { once: true },
  );
  dialog.showModal();
}
