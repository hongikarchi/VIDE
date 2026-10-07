import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './gateway.ts';
import { Card, type TurnQuestion } from './question-card.tsx';
import {
  LegalAnswerCard,
  SOURCE_TEXT,
  STAGE_TEXT,
  VERDICT_TEXT,
  VerdictPill,
  agoText,
  type LegalAnswerView,
} from './legal-answer-card.tsx';
import type { ClawdeChecklist, ClawdeStageId, ClawdeVerdict } from '../contracts/clawde.ts';
import { LegalContribute } from './legal-contribute.tsx';
import './legal-jig.css';

// 법규 검토 jig (J-03, SPEC-13.2·13.3·13.5·13.6·13.7·13.9, Design SCR-29, PLAN-46 T-221·T-222): a
// built-in screen jig. The question box with the design stage, the '보낼 정보' card the engine
// returns before anything leaves (`{needsConfirm}`), the project's answers as answer cards with the
// service's back-questions as question cards, the stage checklist (design stages as the axis,
// permit phases as tags and a filter) and the legal profile. The panel asks the engine, never an
// AI: `POST …/legal/ask`, `GET …/legal/answers`, `GET …/legal/checklist`, `POST …/legal/confirm`,
// `GET/PUT …/legal/profile`. Nothing is queued while the service is unreachable.

type Scalar = string | number | boolean;
interface ProfileItem {
  key: string;
  label?: string;
  value: Scalar;
  unit?: string;
  source: string;
  version?: string;
  excluded: boolean;
  notice?: { value: Scalar; unit?: string; source: string; version?: string; replaced?: boolean };
}
interface ProfileView {
  stage: ClawdeStageId;
  items: ProfileItem[];
  stages: { id: ClawdeStageId; label: string }[];
  permitPhases: { id: string; label: string }[];
  profileKeys: { key: string; label: string; unit?: string }[];
}
interface AnswersView {
  answers: LegalAnswerView[];
  offline: boolean;
  status: string;
  projectOff: boolean;
}
interface SendItem {
  key: string;
  label?: string;
  value: Scalar;
  unit?: string;
  source: string;
  version?: string;
  selectable: boolean;
  excluded: boolean;
}
interface SendCard {
  items: SendItem[];
  hash: string;
  stage: string;
}
interface ChecklistView {
  stage: ClawdeStageId;
  items: ClawdeChecklist['items'];
  lawDbDate: string;
  fetchedAt: string;
  cached: boolean;
  offline: boolean;
  stale: boolean;
}
/** A send card waiting: for a question, or for the stage checklist. */
type Pending =
  | { kind: 'ask'; question: string; refresh: boolean; card: SendCard }
  | { kind: 'checklist'; card: SendCard };

const STAGES: ClawdeStageId[] = [
  'scale-review',
  'schematic',
  'design-development',
  'construction-docs',
];
const PHASE_TEXT: Record<string, string> = {
  review: '심의',
  permit: '허가',
  'construction-start': '착공',
  occupancy: '사용승인',
};
const STATUS_TEXT: Record<ClawdeVerdict, string> = { ...VERDICT_TEXT, unknown: '확인 필요' };
const CONNECTED_STATES = ['connected', 'unreachable', 'unchecked'];
const QUIET = [
  'SERVICE_UNAVAILABLE',
  'SERVICE_NOT_CONNECTED',
  'SERVICE_AUTH',
  'SERVICE_BAD_RESPONSE',
  'LEGAL_PROJECT_OFF',
  'FORBIDDEN',
  'INVALID_INPUT',
  'NOT_FOUND',
  'NETWORK_UNAVAILABLE',
  'ACTION_TIMEOUT',
];
const ERROR_TEXT: Record<string, string> = {
  SERVICE_UNAVAILABLE: '서비스에 닿지 않음',
  SERVICE_NOT_CONNECTED: '법규 서비스가 연결되지 않았습니다',
  SERVICE_AUTH: '로그인 필요 · 설정 › 외부 서비스에서 다시 연결하세요',
  SERVICE_BAD_RESPONSE: '서비스 응답 오류 · 이 답은 저장하지 않았습니다',
  LEGAL_PROJECT_OFF: '이 프로젝트는 법규 서비스에 보내지 않도록 설정되어 있습니다',
  FORBIDDEN: '법규 프로필은 이 PC의 VIDE 창에서만 고칠 수 있습니다',
  INVALID_INPUT: '입력 형식이 맞지 않습니다',
};
const codeOf = (error: unknown) => (error as { code?: string } | null)?.code ?? '';
const errorText = (error: unknown) => ERROR_TEXT[codeOf(error)] ?? '요청하지 못했습니다';
const valueText = (value: Scalar, unit?: string) =>
  `${typeof value === 'boolean' ? (value ? '예' : '아니오') : String(value)}${unit ? ` ${unit}` : ''}`;
const timeText = (iso: string) =>
  new Date(iso).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export function LegalJig({ projectId }: { projectId: string }) {
  const base = `/projects/${encodeURIComponent(projectId)}/legal`;
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [answers, setAnswers] = useState<AnswersView | null>(null);
  const [view, setView] = useState<'answers' | 'checklist' | 'profile' | 'contribute'>('answers');
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [unsent, setUnsent] = useState<string[]>([]);
  const [askError, setAskError] = useState<{ question: string; refresh: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number>();
  const [closedNeeds, setClosedNeeds] = useState<number[]>([]);
  const [notice, setNotice] = useState('');

  const loadProfile = useCallback(async () => {
    try {
      setProfile((await api(`${base}/profile`, 'GET', undefined, { quiet: QUIET })) as ProfileView);
    } catch (error) {
      setNotice(errorText(error));
    }
  }, [base]);
  const loadAnswers = useCallback(async () => {
    try {
      const next = (await api(`${base}/answers`, 'GET', undefined, {
        quiet: QUIET,
      })) as AnswersView;
      setAnswers(next);
      return next;
    } catch (error) {
      setNotice(errorText(error));
      return undefined;
    }
  }, [base]);
  useEffect(() => {
    void loadProfile();
    void loadAnswers().then((next) => setOpen((current) => current ?? next?.answers[0]?.number));
  }, [loadProfile, loadAnswers]);

  const stage = profile?.stage ?? 'scale-review';
  const labels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of profile?.profileKeys ?? []) out[key.key] = key.label;
    for (const item of profile?.items ?? []) if (item.label) out[item.key] = item.label;
    return out;
  }, [profile]);
  const connected = !!answers && CONNECTED_STATES.includes(answers.status) && !answers.projectOff;

  /** Asks; a changed send list comes back as the card (nothing sent yet). */
  const ask = useCallback(
    async (
      text: string,
      {
        refresh = false,
        confirm,
      }: { refresh?: boolean; confirm?: { hash: string; exclude: string[] } } = {},
    ) => {
      const asked = text.trim();
      if (!asked) return;
      setBusy(true);
      setAskError(undefined);
      try {
        const result = (await api(
          `${base}/ask`,
          'POST',
          {
            question: asked,
            stage,
            ...(refresh ? { refresh } : {}),
            ...(confirm ? { confirmSendHash: confirm.hash, exclude: confirm.exclude } : {}),
          },
          { quiet: QUIET },
        )) as { needsConfirm?: SendCard; number?: number };
        if (result.needsConfirm) {
          setPending({ kind: 'ask', question: asked, refresh, card: result.needsConfirm });
          return;
        }
        setPending(null);
        setUnsent((list) => list.filter((q) => q !== asked));
        setQuestion('');
        await loadAnswers();
        setOpen(result.number);
        setView('answers');
      } catch (error) {
        setAskError({ question: asked, refresh, text: errorText(error) });
        await loadAnswers();
      } finally {
        setBusy(false);
      }
    },
    [base, stage, loadAnswers],
  );

  const putProfile = useCallback(
    async (data: unknown) => {
      try {
        const next = (await api(`${base}/profile`, 'PUT', data, { quiet: QUIET })) as ProfileView;
        setProfile(next);
        await loadAnswers();
        return true;
      } catch (error) {
        setNotice(errorText(error));
        return false;
      }
    },
    [base, loadAnswers],
  );

  /** The card's [보내기]: the final list of left-out keys goes with it. */
  const sendCard = async (exclude: string[]) => {
    if (!pending) return;
    if (pending.kind === 'ask')
      await ask(pending.question, {
        refresh: pending.refresh,
        confirm: { hash: pending.card.hash, exclude },
      });
    else {
      setBusy(true);
      try {
        const result = (await api(
          `${base}/confirm`,
          'POST',
          { hash: pending.card.hash, exclude, stage },
          { quiet: QUIET },
        )) as { needsConfirm?: SendCard };
        if (result.needsConfirm) setPending({ kind: 'checklist', card: result.needsConfirm });
        else {
          setPending(null);
          setChecklistKey((n) => n + 1);
        }
        void loadProfile();
      } catch (error) {
        setNotice(errorText(error));
      } finally {
        setBusy(false);
      }
    }
  };
  /** The card closed: nothing goes; the question stays as '보내지 않음'. */
  const closeCard = () => {
    if (pending?.kind === 'ask') {
      const left = pending.question;
      setUnsent((list) => (list.includes(left) ? list : [left, ...list]));
      setQuestion('');
    }
    setPending(null);
  };

  const [checklistKey, setChecklistKey] = useState(0);
  const changeStage = async (next: ClawdeStageId) => {
    if (next === stage) return;
    await putProfile({ stage: next });
  };

  const openItem = (item: ClawdeChecklist['items'][number]) =>
    void ask(item.answerHint ?? `${item.topic} 기준을 받나요?`);

  const status = answers?.status ?? 'unchecked';
  return (
    <div className="legal-jig">
      <header className="legal-head">
        <div>
          <small className="legal-faint">
            cLAWde 법령 DB에 묻고 근거 조항과 함께 보입니다. 판정은 서비스가 정합니다.
          </small>
        </div>
        <span className="legal-status" data-status={answers?.projectOff ? 'off' : status}>
          {answers?.projectOff
            ? '이 프로젝트는 보내지 않음'
            : ({
                connected: '연결됨',
                unreachable: '닿지 않음',
                'login-required': '로그인 필요',
                off: '꺼짐',
                'not-configured': '설정 안 됨',
                unchecked: '확인 전',
              }[status] ?? status)}
        </span>
      </header>

      {answers && !connected ? (
        <p className="legal-banner" role="status">
          {answers.projectOff
            ? '이 프로젝트는 법규 서비스에 보내지 않도록 설정되어 있습니다. 받아 둔 답만 보입니다.'
            : '법규 서비스가 연결되지 않았습니다. 설정 › 외부 서비스에서 cLAWde를 연결하세요. 받아 둔 답은 계속 보입니다.'}
          <button
            type="button"
            onClick={() => document.querySelector<HTMLElement>('#workspace-settings')?.click()}
          >
            설정 열기
          </button>
        </p>
      ) : null}

      <form
        className="legal-ask"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(question);
        }}
      >
        <textarea
          aria-label="법규 질문"
          rows={2}
          maxLength={2000}
          placeholder="예: 우리 건물은 일조 사선 봐야 해?"
          value={question}
          disabled={!connected}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void ask(question);
            }
          }}
        />
        <div className="legal-ask-row">
          <label>
            설계 단계
            <select
              aria-label="설계 단계"
              value={stage}
              disabled={!profile}
              onChange={(event) => void changeStage(event.target.value as ClawdeStageId)}
            >
              {STAGES.map((id) => (
                <option key={id} value={id}>
                  {profile?.stages.find((s) => s.id === id)?.label ?? STAGE_TEXT[id]}
                </option>
              ))}
            </select>
          </label>
          <span className="legal-spacer" />
          <button
            type="submit"
            className="legal-primary"
            disabled={!connected || busy || !question.trim()}
          >
            {busy ? '묻는 중…' : '묻기'}
          </button>
        </div>
        {askError ? (
          <p className="legal-error" role="alert">
            {askError.text}
            <button
              type="button"
              disabled={busy}
              onClick={() => void ask(askError.question, { refresh: askError.refresh })}
            >
              다시 시도
            </button>
          </p>
        ) : null}
      </form>

      {pending ? (
        <SendConfirm
          key={pending.card.hash}
          card={pending.card}
          question={pending.kind === 'ask' ? pending.question : undefined}
          busy={busy}
          onSend={(exclude) => void sendCard(exclude)}
          onClose={closeCard}
        />
      ) : null}
      {notice ? (
        <p className="legal-error" role="status">
          {notice}
          <button type="button" onClick={() => setNotice('')}>
            닫기
          </button>
        </p>
      ) : null}

      <nav className="legal-tabs" role="tablist" aria-label="법규 검토 보기">
        {(
          [
            ['answers', `답 ${answers?.answers.length ?? 0}`],
            ['checklist', '단계별 법령'],
            ['profile', '법규 프로필'],
            ['contribute', 'cLAWde로 보내기'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {view === 'answers' ? (
        <div className="legal-answers">
          {unsent.map((q) => (
            <div key={q} className="legal-row" data-unsent="true">
              <span className="legal-row-q">{q}</span>
              <span className="legal-mark" data-mark="unsent">
                보내지 않음
              </span>
              <button type="button" disabled={!connected || busy} onClick={() => void ask(q)}>
                다시 묻기
              </button>
            </div>
          ))}
          {answers?.answers.length ? (
            answers.answers.map((answer) => {
              const expanded = open === answer.number;
              const needs =
                expanded && !closedNeeds.includes(answer.number)
                  ? answer.answer.needs.filter(
                      (need) =>
                        !profile?.items.some((i) => i.key === need.key && i.source === 'user'),
                    )
                  : [];
              return (
                <div key={answer.number} className="legal-entry" data-open={expanded}>
                  <button
                    type="button"
                    className="legal-row"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? undefined : answer.number)}
                  >
                    <VerdictPill verdict={answer.verdict} downgraded={answer.downgraded} />
                    <span className="legal-row-q">{answer.question}</span>
                    <span className="legal-faint">{answer.ref}</span>
                    {answers.offline ? (
                      <span className="legal-mark" data-mark="offline">
                        오프라인 · {agoText(answer.fetchedAt)}
                      </span>
                    ) : null}
                    {answer.stale ? (
                      <span className="legal-mark" data-mark="stale">
                        다시 확인 필요
                      </span>
                    ) : null}
                  </button>
                  {expanded ? (
                    <LegalAnswerCard
                      view={answer}
                      offline={answers.offline}
                      labels={labels}
                      busy={busy || !connected}
                      onReask={() => void ask(answer.question, { refresh: true })}
                      onRewrite={() =>
                        void api(`${base}/answers/${answer.number}/rewrite`, 'POST', undefined, {
                          quiet: QUIET,
                        })
                          .then(() => loadAnswers())
                          .catch((error) => setNotice(errorText(error)))
                      }
                    >
                      {needs.length ? (
                        <BackQuestions
                          needs={needs.slice(0, 3)}
                          busy={busy || !connected}
                          onAnswer={async (values, assumed) => {
                            const ok = await putProfile({
                              values: Object.fromEntries(
                                Object.entries(values).map(([key, value]) => [
                                  key,
                                  { value, ...(assumed ? { assumed: true } : {}) },
                                ]),
                              ),
                              answered: true,
                            });
                            if (ok) await ask(answer.question);
                          }}
                          onClose={() => setClosedNeeds((list) => [...list, answer.number])}
                        />
                      ) : null}
                    </LegalAnswerCard>
                  ) : null}
                </div>
              );
            })
          ) : !unsent.length ? (
            <p className="legal-empty">
              아직 받은 답이 없습니다. 위에 질문을 적거나 단계별 법령에서 항목을 누르세요.
            </p>
          ) : null}
        </div>
      ) : null}

      {view === 'checklist' ? (
        <StageChecklist
          key={`${stage}-${checklistKey}`}
          base={base}
          stage={stage}
          profile={profile}
          connected={connected}
          onStage={(next) => void changeStage(next)}
          onCard={(card) => setPending({ kind: 'checklist', card })}
          onOpen={openItem}
        />
      ) : null}

      {view === 'profile' && profile ? (
        <ProfileEditor profile={profile} onSave={putProfile} />
      ) : null}

      {view === 'contribute' ? (
        <LegalContribute base={base} connected={connected} labels={labels} />
      ) : null}
    </div>
  );
}

/** The '보낼 정보' card (SPEC-13.3): items, values and sources; any can be left out. */
function SendConfirm({
  card,
  question,
  busy,
  onSend,
  onClose,
}: {
  card: SendCard;
  question?: string;
  busy: boolean;
  onSend: (exclude: string[]) => void;
  onClose: () => void;
}) {
  const [off, setOff] = useState<string[]>(
    card.items.filter((i) => i.selectable && i.excluded).map((i) => i.key),
  );
  return (
    <section className="legal-send" aria-label="보낼 정보">
      <header>
        <strong>보낼 정보</strong>
        <small className="legal-faint">
          cLAWde에 아래 항목과 {question ? '질문·' : ''}설계 단계만 보냅니다. 형상·원본 파일·자료
          원문·사람 이름은 보내지 않습니다.
        </small>
      </header>
      {question ? <p className="legal-send-q">“{question}”</p> : null}
      {card.items.length ? (
        <ul>
          {card.items.map((item) => {
            const checked = item.selectable && !off.includes(item.key);
            return (
              <li key={item.key} data-disabled={!item.selectable || undefined}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`${item.label ?? item.key} 보내기`}
                    checked={checked}
                    disabled={!item.selectable || busy}
                    onChange={() =>
                      setOff((list) =>
                        list.includes(item.key)
                          ? list.filter((k) => k !== item.key)
                          : [...list, item.key],
                      )
                    }
                  />
                  <span>{item.label ?? item.key}</span>
                </label>
                <strong>{valueText(item.value, item.unit)}</strong>
                <small>
                  {SOURCE_TEXT[item.source] ?? item.source}
                  {item.version ? ` · ${item.version}` : ''}
                  {!item.selectable ? ' · 확정 전에는 보내지 않음' : ''}
                </small>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="legal-faint">보낼 프로젝트 정보가 없습니다. 질문과 설계 단계만 보냅니다.</p>
      )}
      <footer>
        <button type="button" className="legal-primary" disabled={busy} onClick={() => onSend(off)}>
          보내기
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          보내지 않음
        </button>
      </footer>
    </section>
  );
}

/** The service's back-questions as VIDE question cards (SPEC-13.7, ADR-026): at most three. */
function BackQuestions({
  needs,
  busy,
  onAnswer,
  onClose,
}: {
  needs: LegalAnswerView['answer']['needs'];
  busy: boolean;
  onAnswer: (values: Record<string, string>, assumed: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, { optionId?: string; text?: string }>>({});
  const questions: TurnQuestion[] = needs.map((need) => ({
    id: need.key,
    title: need.question,
    options: need.options.map((option) => ({
      id: option,
      label: option,
      ...(option === need.recommended ? { recommended: true } : {}),
    })),
    allowFree: true,
  }));
  const chosen = (need: (typeof needs)[number]) => {
    const choice = choices[need.key] ?? {};
    return choice.text?.trim() || choice.optionId || need.recommended || need.options[0];
  };
  const withRecommended = needs.filter((need) => need.recommended);
  return (
    <section className="legal-needs" aria-label="되묻기">
      <p className="legal-faint">
        답이 이 정보에 따라 갈립니다. 답하면 법규 프로필에 남고 같은 질문을 다시 묻습니다.
      </p>
      {questions.map((q, index) => (
        <div key={q.id} className="legal-need">
          <Card
            question={q}
            index={index}
            count={questions.length}
            choice={choices[q.id] ?? {}}
            choose={(choice) => setChoices((all) => ({ ...all, [q.id]: choice }))}
            disabled={busy}
          />
          <small className="legal-faint">{needs[index].why}</small>
        </div>
      ))}
      <footer className="qcard-actions">
        <button type="button" className="qcard-secondary" disabled={busy} onClick={onClose}>
          닫기
        </button>
        <button
          type="button"
          className="qcard-secondary"
          disabled={busy || !withRecommended.length}
          onClick={() =>
            void onAnswer(
              Object.fromEntries(withRecommended.map((need) => [need.key, need.recommended!])),
              true,
            )
          }
        >
          권장값으로 진행 · 가정으로 기록
        </button>
        <button
          type="button"
          className="qcard-primary"
          disabled={busy}
          onClick={() =>
            void onAnswer(Object.fromEntries(needs.map((need) => [need.key, chosen(need)])), false)
          }
        >
          이 답으로 진행
        </button>
      </footer>
    </section>
  );
}

/**
 * 단계별 법령 (SPEC-13.6): the design stage is the axis; the items of the chosen stage show and the
 * other stages fold under '다른 단계 n개'. Permit phases are tags and a filter (screen state only,
 * no call). An item opens its answer card (the cache first, else a question).
 */
function StageChecklist({
  base,
  stage,
  profile,
  connected,
  onStage,
  onCard,
  onOpen,
}: {
  base: string;
  stage: ClawdeStageId;
  profile: ProfileView | null;
  connected: boolean;
  onStage: (stage: ClawdeStageId) => void;
  onCard: (card: SendCard) => void;
  onOpen: (item: ClawdeChecklist['items'][number]) => void;
}) {
  const [list, setList] = useState<ChecklistView | null>(null);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<string>('all');
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError('');
      try {
        const result = (await api(
          `${base}/checklist?stage=${stage}${refresh ? '&refresh=1' : ''}`,
          'GET',
          undefined,
          { quiet: QUIET },
        )) as ChecklistView | { needsConfirm: SendCard };
        if ('needsConfirm' in result) onCard(result.needsConfirm);
        else setList(result);
      } catch (failure) {
        setError(errorText(failure));
      } finally {
        setLoading(false);
      }
    },
    [base, stage, onCard],
  );
  useEffect(() => {
    // Read once per mount: the key remounts it on a stage change or a confirmed card.
    void load();
  }, []);
  const phases = profile?.permitPhases.length
    ? profile.permitPhases
    : Object.entries(PHASE_TEXT).map(([id, label]) => ({ id, label }));
  const phaseLabel = (id: string) => phases.find((p) => p.id === id)?.label ?? PHASE_TEXT[id] ?? id;
  const shown = (list?.items ?? []).filter(
    (item) => phase === 'all' || item.permitPhases?.includes(phase as never),
  );
  const current = shown.filter((item) => item.stage === stage);
  const others = shown.filter((item) => item.stage !== stage);
  const row = (item: ClawdeChecklist['items'][number]) => (
    <li key={`${item.stage}-${item.topic}`}>
      <button
        type="button"
        className="legal-check-item"
        disabled={!connected}
        onClick={() => onOpen(item)}
      >
        <span className="legal-check-top">
          <strong>{item.topic}</strong>
          <span className="legal-verdict" data-verdict={item.status}>
            {STATUS_TEXT[item.status]}
          </span>
          <span className="legal-spacer" />
          <span className="legal-faint">근거 {item.refs.length}</span>
        </span>
        <span className="legal-check-reason">{item.reason}</span>
        {item.permitPhases?.length ? (
          <span className="legal-phases">
            {item.permitPhases.map((id) => (
              <span key={id} className="legal-phase">
                {phaseLabel(id)}
              </span>
            ))}
          </span>
        ) : null}
      </button>
    </li>
  );
  return (
    <div className="legal-checklist">
      <div className="legal-stage-bar" role="group" aria-label="설계 단계">
        {STAGES.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={id === stage}
            disabled={!profile}
            onClick={() => onStage(id)}
          >
            {profile?.stages.find((s) => s.id === id)?.label ?? STAGE_TEXT[id]}
          </button>
        ))}
      </div>
      <div className="legal-phase-bar" role="group" aria-label="인허가 시점">
        <span className="legal-faint">인허가 시점</span>
        {[{ id: 'all', label: '전체' }, ...phases].map((p) => (
          <button
            key={p.id}
            type="button"
            className="legal-chip"
            aria-pressed={phase === p.id}
            onClick={() => setPhase(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {list ? (
        <p className="legal-list-meta">
          {list.offline ? (
            <span className="legal-mark" data-mark="offline">
              오프라인 · {agoText(list.fetchedAt)}
            </span>
          ) : null}
          {list.stale ? (
            <span className="legal-mark" data-mark="stale">
              다시 확인 필요
            </span>
          ) : null}
          <span className="legal-faint">
            {timeText(list.fetchedAt)} 조회 · 법령 DB {list.lawDbDate}
          </span>
          <span className="legal-spacer" />
          <button type="button" disabled={!connected || loading} onClick={() => void load(true)}>
            다시 받기
          </button>
        </p>
      ) : null}
      {error ? (
        <p className="legal-error" role="alert">
          {error}
          <button type="button" disabled={loading} onClick={() => void load(true)}>
            다시 시도
          </button>
        </p>
      ) : null}
      {loading && !list ? <p className="legal-faint">단계 목록을 받는 중…</p> : null}
      {list ? (
        <>
          {current.length ? (
            <ul className="legal-check-list" aria-label={`${STAGE_TEXT[stage]} 항목`}>
              {current.map(row)}
            </ul>
          ) : (
            <p className="legal-empty">
              {phase === 'all'
                ? '이 단계에서 볼 항목이 없습니다.'
                : '이 인허가 시점에 걸리는 이 단계 항목이 없습니다.'}
            </p>
          )}
          {others.length ? (
            <details className="legal-others">
              <summary>다른 단계 {others.length}개</summary>
              {STAGES.filter((id) => id !== stage).map((id) => {
                const items = others.filter((item) => item.stage === id);
                return items.length ? (
                  <div key={id}>
                    <h5>{profile?.stages.find((s) => s.id === id)?.label ?? STAGE_TEXT[id]}</h5>
                    <ul className="legal-check-list">{items.map(row)}</ul>
                  </div>
                ) : null;
              })}
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** 법규 프로필 (SPEC-13.4): values with their source; the user's edit is '사용자 확정'. */
function ProfileEditor({
  profile,
  onSave,
}: {
  profile: ProfileView;
  onSave: (data: unknown) => Promise<boolean>;
}) {
  const keys = useMemo(() => {
    const out = profile.profileKeys.map((k) => ({ key: k.key, label: k.label, unit: k.unit }));
    for (const item of profile.items)
      if (!out.some((k) => k.key === item.key))
        out.push({ key: item.key, label: item.label ?? item.key, unit: item.unit });
    return out;
  }, [profile]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const commit = async (key: string, unit?: string) => {
    const text = drafts[key];
    if (text === undefined) return;
    const item = profile.items.find((i) => i.key === key);
    if (text.trim() === (item ? String(item.value) : '')) {
      setDrafts(({ [key]: _, ...rest }) => rest);
      return;
    }
    const number = Number(text.replace(/,/g, ''));
    const value =
      text.trim() === '' ? null : unit && Number.isFinite(number) ? number : text.trim();
    if (
      await onSave({
        values: { [key]: value === null ? null : { value, ...(unit ? { unit } : {}) } },
      })
    )
      setDrafts(({ [key]: _, ...rest }) => rest);
  };
  return (
    <div className="legal-profile">
      <p className="legal-faint">
        법규 판단에 쓰는 이 프로젝트의 정보입니다. 고친 값은 사용자 확정이 되고, 서비스나 모델이
        다른 값을 주면 알림만 합니다. AI 추정 값은 확정하기 전에는 보내지 않습니다.
      </p>
      <ul>
        {keys.map(({ key, label, unit }) => {
          const item = profile.items.find((i) => i.key === key);
          return (
            <li key={key}>
              <label>
                <span>{label}</span>
                <input
                  aria-label={label}
                  value={drafts[key] ?? (item ? String(item.value) : '')}
                  placeholder="—"
                  onChange={(event) => setDrafts((all) => ({ ...all, [key]: event.target.value }))}
                  onBlur={() => void commit(key, unit ?? item?.unit)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                  }}
                />
                {(unit ?? item?.unit) ? <small>{unit ?? item?.unit}</small> : null}
              </label>
              {item ? (
                <span className="legal-source" data-source={item.source}>
                  {SOURCE_TEXT[item.source] ?? item.source}
                  {item.version ? ` · ${item.version}` : ''}
                </span>
              ) : (
                <span className="legal-faint">비어 있음</span>
              )}
              {item ? (
                <label className="legal-exclude">
                  <input
                    type="checkbox"
                    checked={item.excluded}
                    disabled={item.source === 'ai'}
                    onChange={() => void onSave({ exclude: { [key]: !item.excluded } })}
                  />
                  보내지 않음
                </label>
              ) : null}
              {item?.notice?.replaced ? (
                <small className="legal-notice" data-notice="replaced">
                  바뀐 값 · 이전 {valueText(item.notice.value, item.notice.unit)}
                  {item.notice.version ? ` (${item.notice.version})` : ''}
                </small>
              ) : item?.notice ? (
                <small className="legal-notice">
                  {SOURCE_TEXT[item.notice.source] ?? item.notice.source}의 다른 값{' '}
                  {valueText(item.notice.value, item.notice.unit)} · 바꾸지 않았습니다
                </small>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
