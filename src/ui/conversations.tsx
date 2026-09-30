import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { z } from 'zod';
import './conversations.css';

// 목적별 대화 칩 (Design SCR-15, SPEC-02.19, PLAN-24 T-061): one row of chips at the top of the
// right column, one chip per conversation (the project's default conversation first), with its
// state (● 진행 중, ◌ 읽지 않은 답, '대기 n'); a head line with the conversation's name, its target
// files and the service · model · account fixed when it opened (read-only); [+] 새 대화; closing;
// and the T2 hand-over card (다른 AI로 이어 가기, and the account-limit stop the server reports).
// The chosen conversation is also the work view's filter (`conversationFilter`, read by
// work-view.tsx). Server routes: src/server/conversations.ts `conversationRoutes`.

export type ApiCall = (path: string, method?: string, data?: unknown) => Promise<unknown>;

const provider = z.enum(['claude-cli', 'codex-cli']);
const sessionSchema = z
  .object({
    sessionId: z.string(),
    provider: z.string(),
    accountProfileId: z.string(),
    turns: z.number(),
    inputTokens: z.number(),
    state: z.string(),
    lastTurnAt: z.string().nullable(),
  })
  .passthrough();
const sendsSchema = z.object({
  ledgerItems: z.number(),
  recentTurns: z.number(),
  files: z.number(),
});
/**
 * The server's hand-over state (conversations.ts `limitHandover`/`lengthHandover`): an account
 * limit waiting for the T2 card, or a session past the length setting (a suggestion).
 */
export const handoverSchema = z.union([
  z
    .object({
      kind: z.literal('limit'),
      requestId: z.string(),
      from: z.object({ provider: z.string(), accountProfileId: z.string() }).passthrough(),
      sends: sendsSchema,
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('length'),
      turns: z.number(),
      inputTokens: z.number(),
      limits: z.object({ maxTurns: z.number(), maxInputTokens: z.number() }),
      sends: sendsSchema,
    })
    .passthrough(),
]);
export type ServerHandover = z.infer<typeof handoverSchema>;
export const conversationSchema = z
  .object({
    id: z.string().nullable(),
    kind: z.string(),
    title: z.string(),
    provider: provider.nullable(),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    accountProfileId: z.string().nullable(),
    mode: z.enum(['session', 'ledger']),
    targets: z.array(z.string()).nullable(),
    state: z.enum(['open', 'closed']),
    requests: z.number().default(0),
    session: sessionSchema.nullable().default(null),
    // An unknown shape (a newer server) shows no card rather than failing the list.
    handover: handoverSchema.nullable().catch(null).default(null),
  })
  .passthrough();
export type ConversationEntry = z.infer<typeof conversationSchema>;
const ledgerEntry = z
  .object({ id: z.string(), kind: z.string(), body: z.unknown(), createdAt: z.string() })
  .passthrough();
export const conversationDetailSchema = conversationSchema.extend({
  ledger: z.array(ledgerEntry).default([]),
  sessions: z.array(sessionSchema).default([]),
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

/** A request as the chips need it: the app's messages carry more. */
export interface RequestLike {
  id: string;
  request?: {
    state?: string;
    input?: unknown;
    result?: { phase?: unknown; code?: unknown } | null;
  } | null;
}
export interface ModelOption {
  id: string;
  name: string;
  provider: 'claude-cli' | 'codex-cli';
}
export interface TargetOption {
  id: string;
  name: string;
}

export const KIND_LABELS: Record<string, string> = {
  general: '대화',
  'model-edit': '모델 편집',
  'cad-edit': 'CAD 편집',
  ask: '질문',
  'jig-run': 'jig 작업',
  'jig-make': 'jig 만들기',
  app: '앱',
};
const PROVIDER_LABELS: Record<string, string> = { 'claude-cli': 'Claude', 'codex-cli': 'Codex' };
const HANDOFF_REASONS: Record<string, string> = {
  first: '첫 세션',
  account: '계정 한도로 여유 계정의 새 세션으로 옮겼습니다',
  length: '대화가 길어져 원장으로 새 세션을 열었습니다',
  lost: '끊긴 턴의 세션을 다시 쓰지 않고 원장으로 새 세션을 열었습니다',
  closed: '기록을 지운 대화를 원장으로 새 세션에서 이어 갑니다',
  provider: '다른 AI로 이어 갑니다',
};
const RUNNING = new Set(['queued', 'running']);
const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);

/** The conversation a request belongs to: absent is the default conversation (`null`). */
export function conversationOf(message: RequestLike): string | null {
  const id = (message.request?.input as { conversationId?: unknown } | undefined)?.conversationId;
  return typeof id === 'string' ? id : null;
}
/** Whether a request shows under a conversation filter; `undefined` shows everything. */
export function inConversation(message: RequestLike, filter: string | null | undefined) {
  return filter === undefined || conversationOf(message) === filter;
}
const isChild = (message: RequestLike) =>
  !!(message.request?.input as { parentRequestId?: unknown } | undefined)?.parentRequestId;

export interface ChipState {
  id: string | null;
  label: string;
  running: boolean;
  unread: boolean;
  waiting: number;
}
/**
 * The chips' states: running while one of its requests is queued or running outside a wait,
 * '대기 n' for the ones waiting behind it, unread when a request finished after the chip was
 * last looked at (`seen`: finished request ids per conversation key).
 */
export function chipStates(
  conversations: ConversationEntry[],
  messages: RequestLike[],
  seen: ReadonlyMap<string, ReadonlySet<string>>,
): ChipState[] {
  return conversations
    .filter((entry) => entry.state === 'open')
    .map((entry) => {
      const own = messages.filter(
        (message) => !isChild(message) && conversationOf(message) === entry.id,
      );
      const active = own.filter((message) => RUNNING.has(message.request?.state ?? ''));
      const waiting = active.filter((message) => message.request?.result?.phase === 'waiting');
      const looked = seen.get(keyOf(entry.id));
      const unread = own.some(
        (message) => FINISHED.has(message.request?.state ?? '') && !looked?.has(message.id),
      );
      return {
        id: entry.id,
        label: chipLabel(entry),
        running: active.length > waiting.length,
        unread: !!looked && unread,
        waiting: waiting.length,
      };
    });
}
export const keyOf = (id: string | null) => id ?? 'default';
/** '목적 · 이름' unless the name already says the purpose. */
export function chipLabel(entry: Pick<ConversationEntry, 'id' | 'kind' | 'title'>) {
  if (entry.id === null) return entry.title;
  const kind = KIND_LABELS[entry.kind] ?? '';
  return !kind || entry.kind === 'general' || entry.title.startsWith(kind)
    ? entry.title
    : `${kind} · ${entry.title}`;
}
/** The small read-only label of a conversation's service, model and account. */
export function providerLabel(
  entry: Pick<ConversationEntry, 'provider' | 'model' | 'effort' | 'accountProfileId'>,
  models: readonly ModelOption[] = [],
  accountName?: (id: string) => string | undefined,
) {
  if (!entry.provider) return '요청마다 고른 AI';
  const model = entry.model
    ? (models.find((option) => option.id === entry.model)?.name ?? entry.model)
    : '기본 모델';
  const account =
    entry.accountProfileId && entry.accountProfileId !== 'default'
      ? (accountName?.(entry.accountProfileId) ?? entry.accountProfileId)
      : '';
  return [PROVIDER_LABELS[entry.provider] ?? entry.provider, model, account]
    .filter(Boolean)
    .join(' · ');
}

export type HandoverCard =
  | {
      kind: 'limit';
      requestId: string;
      text: string;
      /** What the new session receives, from the server's state. */
      sends?: string;
    }
  | { kind: 'length'; key: string; text: string; sends: string }
  | { kind: 'record'; ledgerId: string; text: string; from?: string; to?: string };
/** '원장 n개 · 최근 턴 n개 · 파일 n개': what a new session receives. */
export function sendsText(sends: z.infer<typeof sendsSchema>) {
  return [
    `원장 ${sends.ledgerItems}개`,
    `최근 턴 ${sends.recentTurns}개`,
    ...(sends.files ? [`파일 ${sends.files}개`] : []),
  ].join(' · ');
}
const tokenText = (tokens: number) =>
  tokens >= 10_000 ? `${Math.round(tokens / 1000) / 10}만` : tokens.toLocaleString('ko-KR');
const LIMIT_TEXT =
  '이 계정의 사용 한도에 닿아 턴을 멈췄습니다. 끝난 턴은 자동으로 다시 보내지 않습니다.';
const sideLabel = (value: unknown) => {
  const side = value as { provider?: unknown; model?: unknown; accountProfileId?: unknown } | null;
  if (!side || typeof side.provider !== 'string') return undefined;
  return [
    PROVIDER_LABELS[side.provider] ?? side.provider,
    typeof side.model === 'string' ? side.model : '',
    typeof side.accountProfileId === 'string' && side.accountProfileId !== 'default'
      ? side.accountProfileId
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
};
/**
 * The hand-over card the head of a conversation shows (SPEC-02.19 5): the account-limit stop of
 * its latest request (the finished turn is not sent again; the T2 card offers another AI), else
 * the latest hand-over the ledger recorded (changed account or session and why).
 */
export function handoverCard(
  detail:
    | (Pick<ConversationDetail, 'id' | 'ledger'> & { handover?: ServerHandover | null })
    | undefined,
  messages: RequestLike[],
): HandoverCard | undefined {
  if (!detail || detail.id === null) return;
  // The server's state comes first: it knows the stop and what a new session receives.
  const state = detail.handover;
  if (state?.kind === 'limit')
    return {
      kind: 'limit',
      requestId: state.requestId,
      text: LIMIT_TEXT,
      sends: sendsText(state.sends),
    };
  if (state?.kind === 'length')
    return {
      kind: 'length',
      key: `${detail.id}:${state.turns}`,
      text:
        `대화가 길어졌습니다(${state.turns}턴 · 누적 ${tokenText(state.inputTokens)} 토큰, ` +
        `기준 ${state.limits.maxTurns}턴 · ${tokenText(state.limits.maxInputTokens)} 토큰). ` +
        '원장으로 새 세션을 열면 앞 내용은 원장과 최근 요약으로 이어집니다.',
      sends: sendsText(state.sends),
    };
  const own = messages.filter(
    (message) => !isChild(message) && conversationOf(message) === detail.id,
  );
  const last = own.at(-1);
  const handoffs = detail.ledger.filter((entry) => entry.kind === 'handoff');
  const record = handoffs.at(-1);
  if (last?.request?.state === 'failed' && last.request.result?.code === 'PROVIDER_LIMIT') {
    // A hand-over recorded after the stop already answers it.
    const stoppedAt = (last.request as { updatedAt?: unknown }).updatedAt;
    if (!record || typeof stoppedAt !== 'string' || record.createdAt < stoppedAt)
      return {
        kind: 'limit',
        requestId: last.id,
        text: LIMIT_TEXT,
      };
  }
  if (!record) return;
  const body = (record.body ?? {}) as { reason?: unknown; from?: unknown; to?: unknown };
  const reason = typeof body.reason === 'string' ? body.reason : '';
  if (reason === 'first') return;
  return {
    kind: 'record',
    ledgerId: record.id,
    text: HANDOFF_REASONS[reason] ?? '인계했습니다',
    from: sideLabel(body.from),
    to: sideLabel(body.to),
  };
}

// --- The chosen conversation, which the work view filters by. ---

let filter: string | null | undefined;
const listeners = new Set<() => void>();
/** The chosen conversation (`null` the default one); `undefined` when no chips are mounted. */
export const conversationFilter = () => filter;
/** Called whenever the chosen conversation changes (the work view re-renders on it). */
export function onConversationFilter(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function setFilter(next: string | null | undefined) {
  if (next === filter) return;
  filter = next;
  for (const listener of listeners) listener();
}

// --- Components ---

interface Options {
  projectId?: string;
  models?: ModelOption[];
  targets?: TargetOption[];
  messages?: RequestLike[];
  /** The chosen conversation changed: the composer sends `conversationId` (absent for null). */
  onChange?: (id: string | null) => void;
  accountName?: (id: string) => string | undefined;
}
export interface ConversationsController {
  /** New project, models, linked files or requests; a new project reloads the list. */
  update(patch: Options): void;
  refresh(): Promise<void>;
  /** The chosen conversation id, `null` for the default conversation. */
  active(): string | null;
  select(id: string | null): void;
  unmount(): void;
}

const errorText = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === 'NO_SPARE_ACCOUNT'
    ? '같은 AI의 여유 계정이 없습니다. 설정 → AI에서 계정을 더하거나 다른 AI로 이어 가세요.'
    : error instanceof Error
      ? error.message
      : '요청을 처리하지 못했습니다.';

function CreateForm({
  models,
  targets,
  create,
  cancel,
}: {
  models: ModelOption[];
  targets: TargetOption[];
  create: (value: Record<string, unknown>) => Promise<void>;
  cancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('general');
  const [target, setTarget] = useState('');
  const [model, setModel] = useState('auto');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const choice = models.find((option) => option.id === model);
  return (
    <form
      className="conv-create"
      aria-label="새 대화"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        create({
          ...(title.trim() ? { title: title.trim() } : {}),
          kind,
          ...(target ? { targets: [target] } : {}),
          ...(choice && model !== 'auto' ? { provider: choice.provider, model } : {}),
        })
          .catch((reason) => setError(errorText(reason)))
          .finally(() => setBusy(false));
      }}
    >
      <label>
        <span>이름</span>
        <input
          value={title}
          maxLength={60}
          placeholder="예: 구조 검토, 법규 질문"
          onChange={(event) => setTitle(event.target.value)}
          autoFocus
        />
      </label>
      <label>
        <span>목적</span>
        <select value={kind} onChange={(event) => setKind(event.target.value)}>
          {Object.entries(KIND_LABELS)
            .filter(([key]) => !['jig-make', 'app'].includes(key))
            .map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
        </select>
      </label>
      <label>
        <span>대상 파일</span>
        <select value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="">정하지 않음</option>
          {targets.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>AI</span>
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          <option value="auto">자동 (Jev)</option>
          {models
            .filter((option) => option.id !== 'auto')
            .map((option) => (
              <option key={option.id} value={option.id}>
                {(PROVIDER_LABELS[option.provider] ?? option.provider) + ' · ' + option.name}
              </option>
            ))}
        </select>
      </label>
      <small className="conv-note">
        AI와 모델은 대화를 시작할 때 정하고 이 대화 동안 바꾸지 않습니다.
      </small>
      {error ? <small className="conv-error">{error}</small> : null}
      <div className="conv-actions">
        <button type="submit" className="primary" disabled={busy}>
          대화 시작
        </button>
        <button type="button" onClick={cancel}>
          취소
        </button>
      </div>
    </form>
  );
}

function HandoverConfirm({
  entry,
  models,
  run,
  cancel,
}: {
  entry: ConversationEntry;
  models: ModelOption[];
  run: (value: { provider: string; model?: string }) => Promise<void>;
  cancel: () => void;
}) {
  const choices = models.filter(
    (option) =>
      option.id !== 'auto' &&
      !(option.provider === entry.provider && option.id === (entry.model ?? option.id)),
  );
  const [model, setModel] = useState(choices[0]?.id ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const next = choices.find((option) => option.id === model);
  return (
    <section className="conv-card" data-grade="T2" aria-label="다른 AI로 이어 가기 확인">
      <header>
        <strong>다른 AI로 이어 가기</strong>
        <span className="conv-grade">확인 필요</span>
      </header>
      <p>
        지금: {providerLabel(entry, models)}
        <br />
        바뀜:{' '}
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          {choices.map((option) => (
            <option key={option.id} value={option.id}>
              {(PROVIDER_LABELS[option.provider] ?? option.provider) + ' · ' + option.name}
            </option>
          ))}
        </select>
      </p>
      <small className="conv-note">
        새 AI에는 이 대화의 원장(결정·가정·질문과 답·결과 참조)과 최근 요청 요약을 보냅니다. 이전
        세션은 이어 쓰지 않습니다.
      </small>
      {error ? <small className="conv-error">{error}</small> : null}
      <div className="conv-actions">
        <button
          type="button"
          className="primary"
          disabled={!next || busy}
          onClick={() => {
            if (!next) return;
            setBusy(true);
            run({ provider: next.provider, model: next.id })
              .catch((reason) => setError(errorText(reason)))
              .finally(() => setBusy(false));
          }}
        >
          확인하고 이어 가기
        </button>
        <button type="button" onClick={cancel}>
          취소
        </button>
      </div>
    </section>
  );
}

function Conversations({
  api,
  options,
  version,
  select,
  selected,
}: {
  api: ApiCall;
  options: Options;
  version: number;
  select: (id: string | null) => void;
  selected: string | null;
}) {
  const { projectId, models = [], targets = [], messages = [] } = options;
  const [list, setList] = useState<ConversationEntry[]>([]);
  const [detail, setDetail] = useState<ConversationDetail>();
  const [creating, setCreating] = useState(false);
  const [handing, setHanding] = useState(false);
  const [renewing, setRenewing] = useState(false);
  /** Length suggestions the user chose to go on past (conversation id and turn count). */
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState('');
  const [seen, setSeen] = useState(() => new Map<string, Set<string>>());
  const [loaded, setLoaded] = useState(0);
  const base = projectId ? `/projects/${projectId}/conversations` : '';

  useEffect(() => {
    if (!base) return setList([]);
    let live = true;
    api(base)
      .then((value) => {
        if (live) setList(z.array(conversationSchema).parse(value));
      })
      .catch((reason) => live && setError(errorText(reason)));
    return () => {
      live = false;
    };
  }, [api, base, version, loaded]);
  useEffect(() => {
    if (!base) return setDetail(undefined);
    let live = true;
    api(`${base}/${selected ?? 'default'}`)
      .then((value) => {
        if (live) setDetail(conversationDetailSchema.parse(value));
      })
      .catch(() => live && setDetail(undefined));
    return () => {
      live = false;
    };
  }, [api, base, selected, version, loaded, messages.length]);
  // Looking at a conversation reads its finished requests.
  const finished = messages
    .filter(
      (message) =>
        conversationOf(message) === selected && FINISHED.has(message.request?.state ?? ''),
    )
    .map((message) => message.id)
    .join(',');
  useEffect(() => {
    setSeen((previous) => {
      const next = new Map(previous);
      next.set(keyOf(selected), new Set(finished ? finished.split(',') : []));
      return next;
    });
  }, [selected, finished]);
  // A conversation first seen here starts read; what finishes after that shows ◌ until opened.
  useEffect(() => {
    setSeen((previous) => {
      const fresh = list.filter((entry) => !previous.has(keyOf(entry.id)));
      if (!fresh.length) return previous;
      const next = new Map(previous);
      for (const entry of fresh)
        next.set(
          keyOf(entry.id),
          new Set(
            messages
              .filter(
                (message) =>
                  conversationOf(message) === entry.id &&
                  FINISHED.has(message.request?.state ?? ''),
              )
              .map((message) => message.id),
          ),
        );
      return next;
    });
  }, [list, messages]);
  // A closed or unknown conversation falls back to the default one.
  useEffect(() => {
    if (
      selected !== null &&
      list.length &&
      !list.some((e) => e.id === selected && e.state === 'open')
    )
      select(null);
  }, [list, selected, select]);

  const chips = chipStates(list, messages, seen);
  const shown = chips.slice(0, 5);
  const more = chips.slice(5);
  const current =
    list.find((entry) => entry.id === selected) ?? list.find((entry) => entry.id === null);
  const card = handoverCard(detail, messages);
  const targetNames = (current?.targets ?? [])
    .map((id) => targets.find((option) => option.id === id)?.name)
    .filter(Boolean);
  const reload = () => setLoaded((value) => value + 1);
  /** [새 세션으로 이어가기]: posts the hand-over (a spare account, or a new session). */
  const renew = (path: string) => {
    if (!current?.id) return;
    setRenewing(true);
    setError('');
    api(`${base}/${current.id}/${path}`, 'POST', {})
      .then(reload)
      .catch((reason) => setError(errorText(reason)))
      .finally(() => setRenewing(false));
  };

  return (
    <div className="conv">
      <div className="conv-chips" role="tablist" aria-label="대화">
        {shown.map((chip) => (
          <button
            key={keyOf(chip.id)}
            type="button"
            role="tab"
            className="conv-chip"
            aria-selected={chip.id === selected}
            data-conversation={keyOf(chip.id)}
            onClick={() => select(chip.id)}
          >
            {chip.running ? (
              <span className="conv-dot" data-state="running" title="진행 중">
                ●
              </span>
            ) : chip.unread ? (
              <span className="conv-dot" data-state="unread" title="읽지 않은 답">
                ◌
              </span>
            ) : null}
            <span className="conv-label">{chip.label}</span>
            {chip.waiting ? <span className="conv-wait">대기 {chip.waiting}</span> : null}
          </button>
        ))}
        {more.length ? (
          <select
            className="conv-more"
            aria-label="더보기"
            value={more.some((chip) => chip.id === selected) ? keyOf(selected) : ''}
            onChange={(event) =>
              event.target.value &&
              select(event.target.value === 'default' ? null : event.target.value)
            }
          >
            <option value="">더보기 {more.length}</option>
            {more.map((chip) => (
              <option key={keyOf(chip.id)} value={keyOf(chip.id)}>
                {(chip.running ? '● ' : chip.unread ? '◌ ' : '') +
                  chip.label +
                  (chip.waiting ? ` · 대기 ${chip.waiting}` : '')}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="conv-add"
          title="새 대화"
          aria-label="새 대화"
          disabled={!base}
          onClick={() => {
            setCreating(true);
            setHanding(false);
          }}
        >
          +
        </button>
      </div>
      {current ? (
        <div className="conv-head">
          <span className="conv-title">
            {current.id === null ? '기본 대화' : current.title}
            {targetNames.length ? ` · ${targetNames.join(', ')}` : ''}
          </span>
          <span className="conv-ai" title="대화를 시작할 때 정한 AI">
            {providerLabel(current, models, options.accountName)}
          </span>
          {current.id !== null ? (
            <details className="conv-menu">
              <summary aria-label="대화 메뉴">⋯</summary>
              <button
                type="button"
                onClick={(event) => {
                  (event.currentTarget.closest('details') as HTMLDetailsElement).open = false;
                  setHanding(true);
                  setCreating(false);
                }}
              >
                다른 AI로 이어 가기
              </button>
              <button
                type="button"
                onClick={(event) => {
                  (event.currentTarget.closest('details') as HTMLDetailsElement).open = false;
                  const id = current.id!;
                  api(`${base}/${id}/close`, 'POST', {})
                    .then(() => {
                      select(null);
                      reload();
                    })
                    .catch((reason) => setError(errorText(reason)));
                }}
              >
                대화 닫기
              </button>
            </details>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <small className="conv-error" role="alert">
          {error}
        </small>
      ) : null}
      {creating ? (
        <CreateForm
          models={models}
          targets={targets}
          cancel={() => setCreating(false)}
          create={async (value) => {
            const made = conversationSchema.parse(await api(base, 'POST', value));
            setCreating(false);
            setError('');
            reload();
            select(made.id);
          }}
        />
      ) : null}
      {handing && current && current.id !== null ? (
        <HandoverConfirm
          entry={current}
          models={models}
          cancel={() => setHanding(false)}
          run={async (value) => {
            await api(`${base}/${current.id}/handoff`, 'POST', value);
            setHanding(false);
            setError('');
            reload();
          }}
        />
      ) : null}
      {!handing && card && current ? (
        card.kind === 'limit' ? (
          <section className="conv-card" data-grade="T2" aria-label="계정 한도">
            <header>
              <strong>계정 한도</strong>
              <span className="conv-grade">확인 필요</span>
            </header>
            <p>{card.text}</p>
            <small className="conv-note">
              {card.sends
                ? `같은 AI의 여유 계정에서 새 세션을 엽니다. 보내는 것: ${card.sends}. `
                : ''}
              설정 → AI에서 자동 전환을 켜 두면 다음 턴부터 같은 AI의 여유 계정으로 이어 갑니다.
            </small>
            <div className="conv-actions">
              {card.sends ? (
                <button
                  type="button"
                  className="primary"
                  disabled={renewing}
                  onClick={() => renew('account')}
                >
                  새 세션으로 이어가기
                </button>
              ) : null}
              <button
                type="button"
                className={card.sends ? undefined : 'primary'}
                onClick={() => setHanding(true)}
              >
                다른 AI로 이어 가기
              </button>
            </div>
          </section>
        ) : card.kind === 'length' ? (
          kept.has(card.key) ? null : (
            <section className="conv-card" data-grade="T1" aria-label="대화 길이">
              <header>
                <strong>새 세션 제안</strong>
              </header>
              <p>{card.text}</p>
              <small className="conv-note">보내는 것: {card.sends}</small>
              <div className="conv-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={renewing}
                  onClick={() => renew('renew')}
                >
                  새 세션으로 이어가기
                </button>
                <button
                  type="button"
                  onClick={() => setKept((previous) => new Set(previous).add(card.key))}
                >
                  지금 세션으로 계속
                </button>
              </div>
            </section>
          )
        ) : (
          <section className="conv-card" data-grade="record" aria-label="인계">
            <header>
              <strong>인계</strong>
            </header>
            <p>
              {card.text}
              {card.from || card.to ? (
                <small className="conv-note">
                  {' '}
                  {card.from ?? '?'} → {card.to ?? '?'}
                </small>
              ) : null}
            </p>
          </section>
        )
      ) : null}
    </div>
  );
}

/**
 * Mounts the chips into `container` (the top of the right column). The app passes its `api`
 * (src/ui/gateway.ts) and keeps the chips current with `update`; the chosen conversation is the
 * work view's filter and goes to `onChange` for the composer.
 */
export function mountConversations(
  container: HTMLElement,
  api: ApiCall,
  initial: Options = {},
): ConversationsController {
  const root: Root = createRoot(container);
  let options: Options = { ...initial };
  let selected: string | null = null;
  let version = 0;
  const render = () =>
    root.render(
      <Conversations
        api={api}
        options={options}
        version={version}
        selected={selected}
        select={select}
      />,
    );
  function select(id: string | null) {
    if (id === selected && filter !== undefined) return;
    selected = id;
    setFilter(id);
    options.onChange?.(id);
    render();
  }
  setFilter(selected);
  render();
  return {
    update(patch) {
      if (patch.projectId !== undefined && patch.projectId !== options.projectId) {
        options = { ...options, ...patch };
        version++;
        select(null);
        render();
        return;
      }
      options = { ...options, ...patch };
      render();
    },
    async refresh() {
      version++;
      render();
    },
    active: () => selected,
    select,
    unmount() {
      root.unmount();
      setFilter(undefined);
    },
  };
}
