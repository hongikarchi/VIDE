import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { executionLimitsSchema, type ExecutionLimits } from '../contracts/execution-limits.ts';

export function showExecutionLimits(
  value: ExecutionLimits,
  save: (value: ExecutionLimits) => void,
) {
  const dialog = document.createElement('dialog');
  dialog.className = 'quantity-dialog execution-limits';
  dialog.setAttribute('aria-label', '작업 상한');
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
            maxToolCalls: Number(data.get('maxToolCalls')),
            maxHostCommands: Number(data.get('maxHostCommands')),
            timeoutSeconds: Number(data.get('timeoutSeconds')),
          });
          if (!parsed.success) {
            setMessage('표시된 범위의 정수를 입력하세요.');
            return;
          }
          save(parsed.data);
          dialog.close();
        }}
      >
        <h2>작업 상한</h2>
        <p>다음 요청에 적용합니다. 이미 시작된 호스트 연산은 안전하게 종료될 때까지 기다립니다.</p>
        <label>
          도구 호출 수{' '}
          <input
            name="maxToolCalls"
            type="number"
            required
            min="1"
            max="100"
            step="1"
            defaultValue={value.maxToolCalls}
          />
        </label>
        <label>
          대상별 호스트 실행 수{' '}
          <input
            name="maxHostCommands"
            type="number"
            required
            min="1"
            max="48"
            step="1"
            defaultValue={value.maxHostCommands}
          />
        </label>
        <label>
          AI 응답 시간 (초){' '}
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
