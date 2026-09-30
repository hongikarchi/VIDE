import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  conversationTurnLimits,
  executionLimitsSchema,
  requestLimits,
  type ExecutionLimits,
} from '../contracts/execution-limits.ts';

/** Presets the dialog fills in; the user still presses 적용. */
const presets: { label: string; value: ExecutionLimits }[] = [
  { label: '기본', value: requestLimits },
  { label: '대화 턴', value: conversationTurnLimits },
];

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
        <p>
          대화의 턴은 따로 정하지 않으면 도구 호출 {conversationTurnLimits.maxToolCalls}회, 호스트
          실행 {conversationTurnLimits.maxHostCommands}회, {conversationTurnLimits.timeoutSeconds}
          초를 씁니다.
        </p>
        <div className="table-controls" role="group" aria-label="미리 정한 값">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={(event) => {
                const form = event.currentTarget.form;
                if (!form) return;
                for (const [name, number] of Object.entries(preset.value)) {
                  const field = form.elements.namedItem(name);
                  if (field instanceof HTMLInputElement) field.value = String(number);
                }
                setMessage(`${preset.label} 값을 채웠습니다. 적용을 누르세요.`);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
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
