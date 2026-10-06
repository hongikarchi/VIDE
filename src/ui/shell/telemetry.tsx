// Opt-in error/performance reports (ADR-036, SPEC-05.9, Design 「오류·성능 정보 동의」): the first-run
// card (shown once on the installed PC program until answered), the [진단 묶음을 보낼까요?] card after
// an engine crash, and the switch in Settings › 상태 · 오류 next to [진단 묶음 내보내기]. The engine
// owns the choice (GET/PUT /telemetry); nothing is sent before [동의].
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { api } from '../gateway.ts';
import { sessionState } from '../store/session.ts';
import { useStore } from '../store/core.ts';
import { statusState } from '../store/status.ts';
import {
  BUNDLE_CONTENTS,
  BUNDLE_EXCLUDED,
  DUMP_NOTE,
  TELEMETRY_INTRO,
  TELEMETRY_NOT_SENT,
  TELEMETRY_QUESTION,
  TELEMETRY_SENT,
} from '../../contracts/telemetry-notice.ts';

// Host panels (?panel=rhino|zwcad) never show the cards; the PC's main window does.
const panelMode = ['rhino', 'zwcad'].includes(
  new URLSearchParams(location.search).get('panel') ?? '',
);

const viewSchema = z
  .object({
    consent: z.enum(['granted', 'denied']).nullable(),
    prompt: z.boolean(),
    installId: z.string().optional(),
    lastSentAt: z.string().optional(),
    lastError: z.string().optional(),
    pending: z.number(),
    site: z.string(),
    crash: z.object({ at: z.string(), code: z.number(), hex: z.string().optional() }).optional(),
  })
  .passthrough();
type View = z.infer<typeof viewSchema>;
const crashAnswerSchema = z
  .object({
    sent: z.boolean(),
    reason: z.string().optional(),
    file: z.string().optional(),
    bytes: z.number().optional(),
  })
  .passthrough();

const when = (at?: string) =>
  at
    ? new Date(at).toLocaleString('ko-KR', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
const privacyUrl = (site: string) => `${site.replace(/\/+$/, '')}/privacy`;

/** The "무엇을 보내나요" list (the card and the settings section). */
function WhatIsSent({ site }: { site?: string }) {
  return (
    <details className="telemetry-details">
      <summary>무엇을 보내나요</summary>
      <ul>
        {TELEMETRY_SENT.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p>보내지 않는 것</p>
      <ul>
        {TELEMETRY_NOT_SENT.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {site ? (
        <a href={privacyUrl(site)} target="_blank" rel="noreferrer">
          개인정보 처리 안내
        </a>
      ) : null}
    </details>
  );
}

/** A modal that the user answers with its buttons (Escape does not close it). */
function Modal({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) {
      try {
        dialog.showModal();
        // No choice is pre-selected: focus starts on the card itself, not on a button or the list.
        dialog.focus();
      } catch {
        dialog.setAttribute('open', '');
      }
    }
  }, []);
  return (
    <dialog
      ref={ref}
      className="telemetry-dialog"
      tabIndex={-1}
      aria-label={label}
      onCancel={(event) => event.preventDefault()}
    >
      {children}
    </dialog>
  );
}

/** Reads the engine's state once the page's session is open (the first card waits for it). */
function useTelemetryView() {
  const [view, setView] = useState<View | null>(null);
  const load = useCallback(async () => {
    const value = viewSchema.parse(
      await api('/telemetry', 'GET', undefined, { quiet: ['FORBIDDEN'] }),
    );
    setView(value);
    return value;
  }, []);
  return { view, setView, load };
}

export const TelemetryCards = memo(function TelemetryCards() {
  const { view, setView, load } = useTelemetryView();
  const [busy, setBusy] = useState(false);
  const [dumps, setDumps] = useState(false);
  const [crashResult, setCrashResult] = useState<z.infer<typeof crashAnswerSchema> | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (panelMode) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      if (!live) return;
      if (!sessionState.ready) {
        timer = setTimeout(attempt, 500);
        return;
      }
      void load().catch(() => {
        /* The card is asked again on the next start. */
      });
    };
    attempt();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [load]);
  if (!view) return null;
  if (view.prompt)
    return (
      <Modal label="오류·성능 정보 보내기">
        <h2>오류·성능 정보 보내기</h2>
        <p className="telemetry-question">{TELEMETRY_QUESTION}</p>
        <p className="telemetry-intro">{TELEMETRY_INTRO}</p>
        <WhatIsSent site={view.site} />
        <div className="telemetry-actions">
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setView(viewSchema.parse(await api('/telemetry', 'PUT', { consent: 'denied' })));
              } finally {
                setBusy(false);
              }
            }}
          >
            보내지 않음
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setView(viewSchema.parse(await api('/telemetry', 'PUT', { consent: 'granted' })));
              } finally {
                setBusy(false);
              }
            }}
          >
            동의
          </button>
        </div>
      </Modal>
    );
  if (view.crash || crashResult) {
    const close = () => {
      setCrashResult(null);
      setView({ ...view, crash: undefined });
    };
    const answer = async (send: boolean) => {
      setBusy(true);
      try {
        const result = crashAnswerSchema.parse(
          await api(
            '/telemetry/crash',
            'POST',
            { send, dumps: send && dumps },
            {
              timeoutMs: 180_000,
            },
          ),
        );
        if (send) setCrashResult(result);
        else close();
      } catch {
        setCrashResult({ sent: false, reason: 'FAILED' });
      } finally {
        setBusy(false);
      }
    };
    return (
      <Modal label="진단 묶음 보내기">
        <h2>진단 묶음을 보낼까요?</h2>
        {crashResult ? (
          <>
            <p role="status">
              {crashResult.sent
                ? '보냈습니다. 원인을 찾는 데 쓰겠습니다.'
                : crashResult.reason === 'BUNDLES_DISABLED'
                  ? '지금은 사이트가 진단 묶음을 받지 않습니다. 묶음 파일은 이 PC에 만들어 두었으니, 문제를 알릴 때 이 파일을 보내 주세요.'
                  : crashResult.reason === 'BUNDLE_TOO_LARGE'
                    ? '묶음이 너무 커서 보내지 않았습니다. 파일은 이 PC에 있습니다.'
                    : '보내지 못했습니다. 묶음 파일이 있으면 문제를 알릴 때 보내 주세요.'}
            </p>
            {crashResult.file ? (
              <div className="diagnostic-file">
                <code>{crashResult.file}</code>
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(crashResult.file!)
                      .then(() => setCopied(true))
                      .catch(() => {})
                  }
                >
                  {copied ? '복사됨' : '경로 복사'}
                </button>
              </div>
            ) : null}
            <div className="telemetry-actions">
              <button type="button" className="primary-button" onClick={close}>
                닫기
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="telemetry-intro">
              {`작업 엔진이 비정상 종료됐습니다 (${when(view.crash?.at)}${
                view.crash?.hex ? ` · 코드 ${view.crash.hex}` : ''
              }). 원인을 찾을 수 있게 진단 묶음을 보내 주시겠어요? 보내지 않아도 VIDE는 그대로 쓸 수 있습니다.`}
            </p>
            <details className="telemetry-details" open>
              <summary>묶음에 들어가는 것</summary>
              <ul>
                {BUNDLE_CONTENTS.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p>{BUNDLE_EXCLUDED}</p>
            </details>
            <label className="telemetry-dumps">
              <input
                type="checkbox"
                checked={dumps}
                onChange={(event) => setDumps(event.target.checked)}
              />
              {DUMP_NOTE}
            </label>
            <div className="telemetry-actions">
              <button type="button" disabled={busy} onClick={() => void answer(false)}>
                보내지 않음
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void answer(true)}
              >
                {busy ? '보내는 중…' : '보내기'}
              </button>
            </div>
          </>
        )}
      </Modal>
    );
  }
  return null;
});

/** Settings › 상태 · 오류: the switch, the last send and what the next report holds. */
export const TelemetrySection = memo(function TelemetrySection() {
  const { view, setView, load } = useTelemetryView();
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  // Read when the tab is shown (the dialog is drawn before the page's session opens).
  const tab = useStore(statusState, (s) => s.tab);
  useEffect(() => {
    if (tab !== 'status' || !sessionState.ready) return;
    setMessage('');
    void load().catch(() => setMessage('설정을 읽지 못했습니다.'));
  }, [load, tab]);
  const granted = view?.consent === 'granted';
  return (
    <section className="settings-telemetry">
      <h3>오류·성능 정보 보내기</h3>
      <small>
        이름 없는 요약만 보내고 요청 글·파일·경로·이름은 보내지 않습니다. 진단 묶음과 충돌 덤프는
        자동으로 보내지 않습니다.
      </small>
      <label className="telemetry-switch">
        <input
          id="telemetry-consent"
          type="checkbox"
          checked={granted}
          disabled={!view || busy}
          onChange={async (event) => {
            const next = event.target.checked;
            setBusy(true);
            try {
              setView(
                viewSchema.parse(
                  await api(
                    '/telemetry',
                    'PUT',
                    { consent: next ? 'granted' : 'denied' },
                    { quiet: ['FORBIDDEN'] },
                  ),
                ),
              );
              setMessage(
                next
                  ? '지금부터의 기록을 요약해 시작할 때와 하루 한 번 보냅니다.'
                  : '보내지 않습니다. 보내지 못한 요약도 지웠습니다.',
              );
            } catch (error) {
              setMessage(
                (error as { code?: unknown } | null)?.code === 'FORBIDDEN'
                  ? '이 설정은 이 PC의 VIDE 창에서만 바꿀 수 있습니다.'
                  : '설정을 바꾸지 못했습니다.',
              );
            } finally {
              setBusy(false);
            }
          }}
        />
        {TELEMETRY_QUESTION}
      </label>
      {view ? (
        <p className="usage-note" role="status">
          {[
            view.consent === null
              ? '아직 답하지 않음 · 보내지 않음'
              : granted
                ? '보내는 중'
                : '보내지 않음',
            view.lastSentAt ? `마지막 전송 ${when(view.lastSentAt)}` : '',
            view.pending ? `보낼 요약 ${view.pending}건` : '',
            granted && view.lastError ? `지난 전송 실패(${view.lastError}) · 다음에 다시 보냄` : '',
            view.installId ? `설치 번호 ${view.installId.slice(0, 8)}` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      {message ? <p className="usage-note">{message}</p> : null}
      <WhatIsSent site={view?.site} />
      <div className="settings-actions">
        <button
          id="telemetry-preview"
          type="button"
          onClick={async () => {
            try {
              setPreview(
                JSON.stringify(
                  await api('/telemetry/preview', 'GET', undefined, { quiet: ['FORBIDDEN'] }),
                  null,
                  2,
                ),
              );
            } catch {
              setPreview('');
              setMessage('보낼 내용을 만들지 못했습니다.');
            }
          }}
        >
          보낼 내용 보기
        </button>
      </div>
      {preview ? <pre className="telemetry-preview">{preview}</pre> : null}
    </section>
  );
});
