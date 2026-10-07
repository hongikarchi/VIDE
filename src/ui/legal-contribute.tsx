import { useCallback, useEffect, useState } from 'react';
import { api } from './gateway.ts';
import { SOURCE_TEXT } from './legal-answer-card.tsx';
import './legal-contribute.css';

// 되돌려 보내기 (SPEC-13.10, OQ-17, PLAN-46 T-224): the [cLAWde로 보내기] list of the legal jig.
// Every profile value is listed; only user-confirmed values can be ticked, and nothing is ticked at
// first. Assumptions, AI estimates, service and model values and left-out items show greyed with
// why; a value already sent shows '보냄' until it changes. [보내기] sends exactly the ticked items
// once; the service's partial refusal shows each refused item with its reason. An unreachable
// service marks nothing sent and nothing is resent by itself. The AI never sends (it may suggest).

type Scalar = string | number | boolean;
type Block = 'assumed' | 'ai' | 'service' | 'model' | 'excluded' | 'sent';
interface Item {
  key: string;
  label?: string;
  value: Scalar;
  unit?: string;
  source: string;
  selectable: boolean;
  blocked?: Block;
  sent: { receiptId: string; sentAt: string } | null;
}
interface Result {
  receiptId: string;
  accepted: string[];
  rejected: { key: string; label?: string; reason: string }[];
  items: Item[];
}

const BLOCK_TEXT: Record<Block, string> = {
  assumed: '가정 · 보낼 수 없음',
  ai: 'AI 추정 · 보낼 수 없음',
  service: '서비스 값 · 보낼 수 없음',
  model: '모델에서 읽음 · 사용자 확정 전',
  excluded: '보낼 정보에서 뺀 항목',
  sent: '보냄',
};
const ERROR_TEXT: Record<string, string> = {
  SERVICE_UNAVAILABLE: '서비스에 닿지 않아 보내지 못했습니다. 아무것도 보내지 않았습니다.',
  SERVICE_NOT_CONNECTED: '법규 서비스가 연결되지 않았습니다',
  SERVICE_AUTH: '로그인 필요 · 설정 › 외부 서비스에서 다시 연결하세요',
  SERVICE_BAD_RESPONSE: '서비스 응답 오류 · 보냄으로 표시하지 않았습니다',
  LEGAL_PROJECT_OFF: '이 프로젝트는 법규 서비스에 보내지 않도록 설정되어 있습니다',
  LEGAL_NOT_CONTRIBUTABLE: '고른 항목 중 보낼 수 없는 것이 있습니다. 목록을 다시 확인하세요.',
  FORBIDDEN: 'cLAWde로 보내기는 이 PC의 VIDE 창에서만 할 수 있습니다',
};
const QUIET = [...Object.keys(ERROR_TEXT), 'INVALID_INPUT', 'NETWORK_UNAVAILABLE'];
const errorText = (error: unknown) =>
  ERROR_TEXT[(error as { code?: string } | null)?.code ?? ''] ?? '보내지 못했습니다';
const valueText = (value: Scalar, unit?: string) =>
  `${typeof value === 'boolean' ? (value ? '예' : '아니오') : String(value)}${unit ? ` ${unit}` : ''}`;

export function LegalContribute({
  base,
  connected,
  labels = {},
}: {
  /** `/projects/<id>/legal`. */
  base: string;
  connected: boolean;
  labels?: Record<string, string>;
}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const view = (await api(`${base}/contribute`, 'GET', undefined, { quiet: QUIET })) as {
        items: Item[];
      };
      setItems(view.items);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  const send = async () => {
    if (!ticked.length) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const done = (await api(
        `${base}/contribute`,
        'POST',
        { keys: ticked },
        { quiet: QUIET },
      )) as Result;
      setResult(done);
      setItems(done.items);
      setTicked([]);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const name = (item: { key: string; label?: string }) =>
    item.label ?? labels[item.key] ?? item.key;
  return (
    <section className="legal-send legal-contribute" aria-label="cLAWde로 보내기">
      <header>
        <strong>cLAWde로 보내기</strong>
        <small className="legal-faint">
          이 프로젝트에서 확인한 값을 법규 서비스 DB에 보탭니다. 고른 항목만 한 번에 보냅니다.
          가정·AI 추정·서비스 값은 보낼 수 없습니다.
        </small>
      </header>
      {items === null ? null : items.length ? (
        <ul>
          {items.map((item) => (
            <li
              key={item.key}
              data-disabled={!item.selectable || undefined}
              data-sent={item.sent ? 'true' : undefined}
            >
              <label>
                <input
                  type="checkbox"
                  aria-label={`${name(item)} 보내기`}
                  checked={ticked.includes(item.key)}
                  disabled={!item.selectable || busy || !connected}
                  onChange={() =>
                    setTicked((list) =>
                      list.includes(item.key)
                        ? list.filter((key) => key !== item.key)
                        : [...list, item.key],
                    )
                  }
                />
                <span>{name(item)}</span>
              </label>
              <strong>{valueText(item.value, item.unit)}</strong>
              <small>
                {SOURCE_TEXT[item.source] ?? item.source}
                {item.blocked ? ` · ${BLOCK_TEXT[item.blocked]}` : ''}
                {item.sent ? ` · 접수 ${item.sent.receiptId}` : ''}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="legal-faint">법규 프로필에 보낼 값이 없습니다.</p>
      )}
      {result ? (
        <div className="legal-contribute-result" role="status">
          <p>
            접수 {result.receiptId} · 받음 {result.accepted.length}개
            {result.rejected.length ? ` · 거절 ${result.rejected.length}개` : ''}
          </p>
          {result.rejected.length ? (
            <ul className="legal-contribute-rejected">
              {result.rejected.map((entry) => (
                <li key={entry.key}>
                  <span>{name(entry)}</span>
                  <small>{entry.reason}</small>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="legal-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer>
        <button
          type="button"
          className="legal-primary"
          disabled={busy || !connected || !ticked.length}
          onClick={() => void send()}
        >
          {busy ? '보내는 중…' : `보내기${ticked.length ? ` (${ticked.length})` : ''}`}
        </button>
      </footer>
    </section>
  );
}
