// Conversations (SPEC-02.19, ADR-021, PLAN-24 T-061): a conversation is one purpose's flow of
// turns. Its service, model and account are fixed when it opens; a Claude conversation continues
// one provider session (one CLI run per turn, `--session-id` then `--resume`), a Codex one too
// (`exec resume <thread>`, SPIKE ④ re-test 2026-09-30; the thread is named by its first turn).
// A provider switched off in SESSION_PROVIDERS runs the ledger method. VIDE's ledger,
// not the provider transcript, is the record: losing a session loses no work. Requests without a
// conversation belong to the project's default conversation (`conversationId` NULL), which keeps
// the earlier per-request behaviour. Storage rows: ARCH-03 §10; CLI arguments: ARCH-01 §2.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { DomainError, type Store } from '../core/store.ts';
import { JigStore } from '../core/jig-store.ts';
import {
  ConversationStore,
  conversationKinds,
  ledgerKinds,
  type Conversation,
  type LedgerItem,
  type ProviderSession,
  type ProviderSessionKey,
} from '../core/conversation-store.ts';
import type { AccountProfiles } from '../ai/account-profiles.ts';
import type { StoredWork } from '../contracts/stored-work.ts';
import { hostUse, waitingOf, type WaitingFor } from '../contracts/request-scope.ts';
import type { SessionOptions } from '../ai/claude-cli.ts';
import { removeClaudeTranscript } from '../ai/claude-cli.ts';
import { removeCodexTranscript } from '../ai/codex-cli.ts';
import { isAutoModel, type Choice, type RoutingInput } from '../ai/model-router.ts';
import type { Diagnostics } from './diagnostics.ts';
import {
  MAX_QUESTIONS,
  formatAnswers,
  turnOutputItem,
  turnOutputSchema,
  type TurnAnswer,
  type TurnQuestion,
} from './turn-output.ts';

type Provider = 'claude-cli' | 'codex-cli';
type Kind = (typeof conversationKinds)[number];

/** Providers whose session resume passed the SPIKE (ADR-021 7); the others run the ledger method. */
export const SESSION_PROVIDERS: Record<Provider, boolean> = {
  'claude-cli': true,
  'codex-cli': true,
};
/** A session longer than this reopens with the ledger (SPEC-02.19 5; PLAN-24 starting values). */
export const SESSION_MAX_TURNS = 12;
export const SESSION_MAX_INPUT_TOKENS = 150_000;
/** The ledger item sent with a turn; older entries are summarized past this (ARCH-03 §10.3). */
export const LEDGER_BYTES = 8 * 1024;
/** Provider transcripts of a closed conversation are removed after this (SPEC-02.19 1). */
export const TRANSCRIPT_RETENTION_DAYS = 30;
/** Every this many turns of one session the whole ledger goes again (SPEC-02.17 6). */
const FULL_LEDGER_EVERY = 6;
const RECENT_TURNS = 3;
export const DEFAULT_TITLE = '기본 대화';
const KIND_TITLES: Record<Kind, string> = {
  general: '대화',
  'model-edit': '모델 편집',
  'cad-edit': 'CAD 편집',
  ask: '질문',
  'jig-run': 'jig 작업',
  'jig-make': 'jig 만들기',
  app: '앱',
};

/** HTTP statuses of the conversation error codes; server.ts merges them into its table. */
export const conversationStatuses: Record<string, number> = {
  CONVERSATION_CLOSED: 409,
  CONVERSATION_PROVIDER: 409,
};

/** The project's default conversation: the requests without one (SPEC-02.19 1). */
export interface DefaultConversation {
  id: null;
  projectId: string;
  kind: 'general';
  title: string;
  provider: null;
  model: null;
  effort: null;
  accountProfileId: null;
  mode: 'ledger';
  jigInstanceId: null;
  draftId: null;
  targets: null;
  state: 'open';
  createdAt: null;
  updatedAt: null;
  closedAt: null;
}
export interface SessionSummary {
  sessionId: string;
  provider: string;
  accountProfileId: string;
  turns: number;
  inputTokens: number;
  state: ProviderSession['state'];
  lastTurnAt: string | null;
}
/**
 * The T2 card of a turn stopped on its account's limit (SPEC-02.19 5, automatic switching off):
 * the stopped turn is not sent again; confirming moves the conversation to another account of the
 * same service, whose next turn opens a new session with the hand-over packet described here.
 */
export interface LimitHandover {
  kind: 'limit';
  grade: 'T2';
  requestId: string;
  from: { provider: string; accountProfileId: string };
  /** What the new session receives: the whole ledger, the latest finished turns, file names. */
  sends: { ledgerItems: number; recentTurns: number; files: number };
}
export type ConversationSummary = (Conversation | DefaultConversation) & {
  requests: number;
  /** The session the next turn would resume, if any. */
  session: SessionSummary | null;
  /** A hand-over waiting for the user's confirmation. */
  handover: LimitHandover | null;
};
export type NewSessionReason = 'first' | 'account' | 'provider' | 'length' | 'lost' | 'closed';
/** A packet item a turn carries (ledger, hand-over, changes elsewhere). */
export interface TurnItem {
  id: string;
  type: string;
  data: unknown;
}
/** One turn of a conversation, from `beginTurn` to `endTurn`. */
export interface Turn {
  conversation: Conversation;
  requestId: string;
  /** The provider session of this turn; undefined with the ledger method. */
  session?: SessionOptions & ProviderSessionKey;
  /** Ledger, hand-over and changes-elsewhere items to send with the turn. */
  items: TurnItem[];
  /** Set when this turn opened a new session. */
  opened?: NewSessionReason;
  /**
   * A Codex session's opening turn: Codex names the thread itself, so the session row is added
   * when the turn reports it (`result.sessionId`), with this CLI version.
   */
  pending?: { cliVersion: string };
  /** The turn ends as done, progress or question cards (T-062; turns without the host). */
  structured?: boolean;
  /** Question IDs the ledger already holds (asked or answered): never asked again. */
  askedQuestions?: ReadonlySet<string>;
}
export interface Hold {
  /** The conversation's line is stopped (an unresolved result, SPEC-02.19 4). */
  code?: string;
  waitingFor?: WaitingFor;
}
interface Options {
  profiles?: Pick<AccountProfiles, 'directory'>;
  diagnostics?: Pick<Diagnostics, 'write'>;
  /** Test seam: removes one session's provider transcript (default: the CLI modules'). */
  removeTranscript?: (
    provider: Provider,
    configDirectory: string | undefined,
    sessionId: string,
  ) => Promise<number>;
}

const id = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/);
const providerSchema = z.enum(['claude-cli', 'codex-cli']);
const modelSchema = z.string().regex(/^[a-zA-Z0-9._-]{1,100}(?:\[1m\])?$/);
const effortSchema = z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
const createInput = z
  .object({
    kind: z.enum(conversationKinds).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    /** The first request's text: names the conversation and lets Jev choose service and model. */
    body: z.string().max(20000).optional(),
    provider: providerSchema.optional(),
    model: modelSchema.optional(),
    effort: effortSchema.optional(),
    host: z.enum(['rhino', 'zwcad']).optional(),
    permission: z.enum(['review', 'candidate']).optional(),
    jigInstanceId: id.optional(),
    draftId: id.optional(),
    targets: z.array(id).max(50).optional(),
    /** A make-conversation on a jig draft (PLAN-22 T-063): kind `jig-make`, `draftId` required. */
    mode: z.literal('make').optional(),
  })
  .strict()
  .refine((input) => input.mode !== 'make' || input.draftId !== undefined);
export type CreateConversationInput = z.input<typeof createInput>;
const ledgerInput = z
  .object({ kind: z.enum(ledgerKinds), body: z.unknown(), requestId: id.optional() })
  .strict();
const handoffInput = z
  .object({
    provider: providerSchema,
    model: modelSchema.optional(),
    effort: effortSchema.optional(),
  })
  .strict();
const closeInput = z.object({ discard: z.boolean().optional() }).strict();
const switchInput = z
  .object({ accountProfileId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/) })
  .strict();
const questionKey = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
/** Answers to one turn's question cards; `recommended` answers every open one with its default. */
const answerInput = z
  .object({
    requestId: id,
    answers: z
      .array(
        z
          .object({
            questionId: questionKey,
            optionId: questionKey.optional(),
            text: z.string().trim().min(1).max(500).optional(),
          })
          .strict()
          .refine((answer) => answer.optionId || answer.text),
      )
      .max(MAX_QUESTIONS)
      .default([]),
    recommended: z.boolean().optional(),
  })
  .strict();
/** The question and answer IDs in the ledger (SPEC-02.19 6: a decided thing is not asked again). */
function askedQuestions(items: LedgerItem[]) {
  const ids = new Set<string>();
  for (const item of items) {
    const body = (item.body ?? {}) as { id?: unknown; questionId?: unknown };
    if (item.kind === 'question' && typeof body.id === 'string') ids.add(body.id);
    if (['answer', 'decision'].includes(item.kind) && typeof body.questionId === 'string')
      ids.add(body.questionId);
  }
  return ids;
}

const clip = (text: unknown, max: number) => {
  const value = typeof text === 'string' ? text : '';
  return value.length > max ? value.slice(0, max) + ' …(생략)' : value;
};
const summary = (body: unknown) =>
  clip(typeof body === 'string' ? body : JSON.stringify(body ?? null), 160);
/** Tokens a turn put into the context: Claude counts cache reads and writes apart from input. */
const turnTokens = (usage: unknown) => {
  const parsed = z
    .object({
      inputTokens: z.number().nullable().optional(),
      cacheReadTokens: z.number().nullable().optional(),
      cacheCreationTokens: z.number().nullable().optional(),
    })
    .passthrough()
    .safeParse(usage);
  if (!parsed.success) return 0;
  const { inputTokens, cacheReadTokens, cacheCreationTokens } = parsed.data;
  return Math.max(
    0,
    Math.round((inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0)),
  );
};
/** A conversation's kind from Jev's task (SPEC-02.17 5) when the caller names none. */
export function kindOf(task: string | undefined, host: string | undefined): Kind {
  if (task === 'lookup') return 'ask';
  if (task === 'simple_edit' || task === 'complex')
    return host === 'zwcad' ? 'cad-edit' : 'model-edit';
  return 'general';
}
/** The ledger as one packet item: current entries, oldest summarized then left out past 8 KB. */
export function ledgerItem(items: LedgerItem[], scope: 'all' | 'since-last-turn'): TurnItem {
  const entries = items.map((item) => ({
    id: item.id,
    kind: item.kind,
    at: item.createdAt,
    ...(item.requestId ? { requestId: item.requestId } : {}),
    body: item.body,
  }));
  const size = () => Buffer.byteLength(JSON.stringify(entries));
  let summarized = 0,
    omitted = 0;
  for (let index = 0; size() > LEDGER_BYTES && index < entries.length; index++) {
    entries[index] = { ...entries[index], body: summary(entries[index].body) };
    summarized++;
  }
  while (size() > LEDGER_BYTES && entries.length) {
    entries.shift();
    omitted++;
  }
  return { id: 'ledger', type: 'ledger', data: { scope, items: entries, summarized, omitted } };
}
export async function removeTranscript(
  provider: Provider,
  configDirectory: string | undefined,
  sessionId: string,
) {
  return provider === 'codex-cli'
    ? removeCodexTranscript(configDirectory, sessionId)
    : removeClaudeTranscript(configDirectory, sessionId);
}

export class ConversationService {
  readonly store: ConversationStore;
  private readonly db: Store;
  private readonly options: Options;
  constructor(store: Store, options: Options = {}) {
    this.db = store;
    this.store = new ConversationStore(store.db);
    this.options = options;
    this.recover();
  }
  /**
   * After a restart the session of a turn that was cut off is not resumed (SPEC-02.19 5): an
   * interrupted request that had started, with no completed turn after it, marks it lost.
   */
  private recover() {
    const lost = this.db.db
      .prepare(
        `SELECT conversationId, provider, accountProfileId, sessionId FROM provider_sessions s
          WHERE s.state='active' AND EXISTS(
            SELECT 1 FROM workspace_requests r WHERE r.conversationId=s.conversationId
              AND r.state='interrupted'
              AND (r.result IS NULL OR json_extract(r.result,'$.phase') NOT IN ('queue','waiting'))
              AND NOT EXISTS(SELECT 1 FROM workspace_requests r2 WHERE r2.conversationId=r.conversationId
                AND r2.state='succeeded' AND r2.rowid>r.rowid))`,
      )
      .all() as unknown as ProviderSessionKey[];
    for (const key of lost) this.store.setSessionState(key, 'lost');
  }
  private defaultConversation(projectId: string): DefaultConversation {
    return {
      id: null,
      projectId,
      kind: 'general',
      title: DEFAULT_TITLE,
      provider: null,
      model: null,
      effort: null,
      accountProfileId: null,
      mode: 'ledger',
      jigInstanceId: null,
      draftId: null,
      targets: null,
      state: 'open',
      createdAt: null,
      updatedAt: null,
      closedAt: null,
    };
  }
  private summarize(conversation: Conversation | DefaultConversation): ConversationSummary {
    const active = conversation.id
      ? this.store.sessions(conversation.id, 'active').at(-1)
      : undefined;
    return {
      ...conversation,
      requests: this.store.requestIds(conversation.projectId, conversation.id).length,
      session: active ? sessionSummary(active) : null,
      handover: conversation.id ? this.limitHandover(conversation as Conversation) : null,
    };
  }
  /**
   * The conversation's latest request stopped on its account's limit and no hand-over answered it
   * yet: the T2 card (SPEC-02.19 5). With automatic switching on, the next request already comes
   * on another account and opens the new session itself, so the card is only offered.
   */
  private limitHandover(conversation: Conversation): LimitHandover | null {
    if (conversation.state !== 'open') return null;
    const rows = this.db.db
      .prepare(
        `SELECT id, state, input, result FROM workspace_requests WHERE conversationId=?
          ORDER BY rowid DESC LIMIT 21`,
      )
      .all(conversation.id) as {
      id: string;
      state: string;
      input: string;
      result: string | null;
    }[];
    const last = rows[0];
    if (!last || last.state !== 'failed') return null;
    let code: unknown, accountProfileId: unknown;
    try {
      code = (JSON.parse(last.result ?? 'null') as { code?: unknown } | null)?.code;
      accountProfileId = (JSON.parse(last.input) as { accountProfileId?: unknown })
        .accountProfileId;
    } catch {
      return null;
    }
    if (code !== 'PROVIDER_LIMIT') return null;
    const ledger = this.store.ledger(conversation.id, { current: true });
    if (ledger.some((item) => item.kind === 'handoff' && item.requestId === last.id)) return null;
    const files = new Set<string>();
    let finished = 0;
    for (const row of rows.slice(1))
      if (row.state === 'succeeded') {
        finished++;
        try {
          for (const file of (JSON.parse(row.input) as { files?: { name?: unknown }[] }).files ??
            [])
            if (typeof file?.name === 'string') files.add(file.name);
        } catch {
          /* A row that does not parse sends nothing. */
        }
      }
    return {
      kind: 'limit',
      grade: 'T2',
      requestId: last.id,
      from: {
        provider: conversation.provider,
        accountProfileId:
          typeof accountProfileId === 'string'
            ? accountProfileId
            : (conversation.accountProfileId ?? 'default'),
      },
      sends: {
        ledgerItems: ledger.length,
        recentTurns: Math.min(finished, RECENT_TURNS),
        files: files.size,
      },
    };
  }

  /** Opens a conversation on the service, model, effort and account it keeps until it closes. */
  create(
    projectId: string,
    value: {
      kind: Kind;
      title: string;
      provider: Provider;
      model?: string | null;
      effort?: string | null;
      accountProfileId: string;
      jigInstanceId?: string | null;
      draftId?: string | null;
      targets?: string[] | null;
    },
  ) {
    this.db.project(projectId);
    // A make-conversation writes an open draft of this project (PLAN-22 T-063).
    if (
      value.kind === 'jig-make' &&
      value.draftId &&
      new JigStore(this.db.db).draft(projectId, value.draftId).state !== 'open'
    )
      throw new DomainError('DRAFT_NOT_OPEN');
    const conversation = this.store.create(projectId, {
      ...value,
      effort: value.effort === 'default' ? null : value.effort,
      mode: SESSION_PROVIDERS[value.provider] ? 'session' : 'ledger',
    });
    this.options.diagnostics?.write('conversation-open', {
      conversationId: conversation.id,
      projectId,
      kind: conversation.kind,
      provider: conversation.provider,
      model: conversation.model,
      effort: conversation.effort,
      mode: conversation.mode,
    });
    return this.summarize(conversation);
  }
  /** The default conversation first, then the project's own in opening order. */
  list(projectId: string): ConversationSummary[] {
    this.db.project(projectId);
    return [this.defaultConversation(projectId), ...this.store.list(projectId)].map((entry) =>
      this.summarize(entry),
    );
  }
  get(projectId: string, conversationId: string | null) {
    this.db.project(projectId);
    if (conversationId === null)
      return { ...this.summarize(this.defaultConversation(projectId)), ledger: [], sessions: [] };
    const conversation = this.store.get(projectId, conversationId);
    return {
      ...this.summarize(conversation),
      ledger: this.store.ledger(conversationId, { current: true }),
      sessions: this.store.sessions(conversationId).map(sessionSummary),
    };
  }
  /** Closing keeps VIDE's requests, results and ledger; `discard` removes the transcripts now. */
  async close(projectId: string, conversationId: string, { discard = false } = {}) {
    const conversation = this.store.setState(projectId, conversationId, 'closed');
    if (discard) await this.purge(conversationId);
    return this.summarize(this.store.get(projectId, conversation.id));
  }
  /** A reopened conversation whose transcripts are gone starts a new session from the ledger. */
  reopen(projectId: string, conversationId: string) {
    return this.summarize(this.store.setState(projectId, conversationId, 'open'));
  }
  /** Records what happened outside an AI turn (a setting changed, an app action, a decision). */
  addLedger(projectId: string, conversationId: string, value: unknown) {
    this.store.get(projectId, conversationId);
    const input = ledgerInput.parse(value);
    return this.store.addLedgerItem(conversationId, input);
  }
  /**
   * A turn of a conversation runs on the conversation's service and model (SPEC-02.19 2): the
   * submitted input takes them over; only the effort may differ per turn.
   */
  fix(projectId: string, input: Record<string, unknown>) {
    const conversation = this.store.get(projectId, id.parse(input.conversationId));
    if (conversation.state !== 'open') throw new DomainError('CONVERSATION_CLOSED');
    input.provider = conversation.provider;
    if (conversation.model) input.model = conversation.model;
    else delete input.model;
    if (typeof input.effort !== 'string' || input.effort === 'default') {
      if (conversation.effort) input.effort = conversation.effort;
      else delete input.effort;
    }
    delete input.routing;
    // A make-conversation turn never uses the host: it gets the draft's file and make tools (T-064).
    if (conversation.kind === 'jig-make') {
      if (
        !conversation.draftId ||
        new JigStore(this.db.db).draft(projectId, conversation.draftId).state !== 'open'
      )
        throw new DomainError('DRAFT_NOT_OPEN');
      input.hostUse = 'none';
    }
    return conversation;
  }
  /**
   * [다른 AI로 이어 가기] (SPEC-02.19 5, confirmed T2 card): the conversation goes on with another
   * service or model; its next turn opens a new session with a hand-over.
   */
  handoffTo(projectId: string, conversationId: string, value: unknown, accountProfileId: string) {
    const input = handoffInput.parse(value);
    const conversation = this.store.get(projectId, conversationId);
    if (conversation.state !== 'open') throw new DomainError('CONVERSATION_CLOSED');
    for (const session of this.store.sessions(conversationId, 'active'))
      this.store.setSessionState(session, 'handed-off');
    const updated = this.store.update(projectId, conversationId, {
      provider: input.provider,
      model: input.model ?? null,
      effort: input.effort && input.effort !== 'default' ? input.effort : null,
      accountProfileId,
      mode: SESSION_PROVIDERS[input.provider] ? 'session' : 'ledger',
    });
    const stopped = this.limitHandover(conversation)?.requestId;
    this.store.addLedgerItem(conversationId, {
      kind: 'handoff',
      ...(stopped ? { requestId: stopped } : {}),
      body: {
        reason: 'provider',
        from: { provider: conversation.provider, model: conversation.model },
        to: { provider: updated.provider, model: updated.model },
      },
    });
    return this.summarize(updated);
  }
  /**
   * The confirmed T2 card of an account limit (SPEC-02.19 5): the conversation keeps its service
   * and model and goes on on another account of that service. The stopped turn is not sent again;
   * the next turn opens a new session there with the ledger and the hand-over packet.
   */
  switchAccount(projectId: string, conversationId: string, value: unknown) {
    const { accountProfileId } = switchInput.parse(value);
    const conversation = this.store.get(projectId, conversationId);
    if (conversation.state !== 'open') throw new DomainError('CONVERSATION_CLOSED');
    const from = conversation.accountProfileId ?? 'default';
    if (accountProfileId === from) throw new DomainError('INVALID_INPUT');
    if (this.options.profiles)
      try {
        this.options.profiles.directory(conversation.provider as Provider, accountProfileId);
      } catch {
        throw new DomainError('INVALID_INPUT');
      }
    const stopped = this.limitHandover(conversation)?.requestId;
    for (const session of this.store.sessions(conversationId, 'active'))
      this.store.setSessionState(session, 'handed-off');
    const updated = this.store.update(projectId, conversationId, { accountProfileId });
    this.store.addLedgerItem(conversationId, {
      kind: 'handoff',
      ...(stopped ? { requestId: stopped } : {}),
      body: {
        reason: 'account',
        confirmed: 'T2',
        from: { provider: conversation.provider, accountProfileId: from },
        to: { provider: conversation.provider, accountProfileId },
      },
    });
    this.options.diagnostics?.write('conversation-handover', {
      conversationId,
      reason: 'account',
      provider: conversation.provider,
    });
    return this.summarize(updated);
  }

  /**
   * One running turn per conversation (SPEC-02.19 4): a later message of the same conversation
   * waits in its line, in order; an unresolved result stops the line.
   */
  hold(request: StoredWork, rows: StoredWork[], active: ReadonlySet<string>): Hold | undefined {
    const key = request.input.conversationId;
    if (typeof key !== 'string') return;
    const mine = rows.filter((row) => row.id !== request.id && row.input.conversationId === key);
    if (mine.some((row) => row.state === 'unknown')) return { code: 'HOST_RESULT_UNRESOLVED' };
    const index = rows.findIndex((row) => row.id === request.id);
    // Earlier messages of the conversation that run or wait: this one stands behind them.
    const ahead = (index < 0 ? mine : mine.filter((row) => rows.indexOf(row) < index)).filter(
      (row) =>
        row.state === 'running' ||
        (row.state === 'queued' && (active.has(row.id) || !!waitingOf(row))),
    );
    if (!ahead.length) return;
    // ARCH-03 §10.3 names this kind; request-scope's union lists the document and project ones.
    const waitingFor = {
      kind: 'conversation',
      key,
      after: ahead[ahead.length - 1].id,
      position: ahead.filter((row) => row.state === 'queued').length + 1,
    } as unknown as WaitingFor;
    return { waitingFor };
  }
  /**
   * Prepares a conversation's turn: which provider session it runs in (resumed, or a new one
   * with a hand-over) or the ledger method, and the ledger, hand-over and changes-elsewhere items.
   */
  async beginTurn(
    request: StoredWork,
    options: { rows: StoredWork[]; cliVersion: () => Promise<string> },
  ): Promise<Turn | undefined> {
    const turn = await this.openTurn(request, options);
    // A turn without the host (and not a jig review with its own format) asks for structured
    // output: done, progress or at most three question cards (PLAN-24 T-062).
    if (!turn || request.input.jig !== undefined || hostUse(request.input) !== 'none') return turn;
    const ledger = this.store.ledger(turn.conversation.id, { current: true });
    return {
      ...turn,
      structured: true,
      askedQuestions: askedQuestions(ledger),
      items: [...turn.items, turnOutputItem()],
    };
  }
  private async openTurn(
    request: StoredWork,
    { rows, cliVersion }: { rows: StoredWork[]; cliVersion: () => Promise<string> },
  ): Promise<Turn | undefined> {
    const conversationId = request.input.conversationId;
    if (typeof conversationId !== 'string') return;
    const conversation = this.store.get(request.projectId, conversationId);
    if (conversation.state !== 'open') throw new DomainError('CONVERSATION_CLOSED');
    const provider = request.input.provider;
    if (provider !== conversation.provider) throw new DomainError('CONVERSATION_PROVIDER');
    const accountProfileId = request.input.accountProfileId ?? 'default';
    const others = rows.filter((row) => row.id !== request.id);
    const own = others.filter((row) => row.input.conversationId === conversationId);
    const since = own.at(-1)?.createdAt ?? conversation.createdAt;
    const elsewhere = changesElsewhere(others, conversationId, since);
    const all = () => this.store.ledger(conversationId, { current: true });
    if (conversation.mode !== 'session' || !SESSION_PROVIDERS[provider])
      return {
        conversation,
        requestId: request.id,
        items: [ledgerItem(all(), 'all'), ...elsewhere],
      };
    const active = this.store.sessions(conversationId, 'active').at(-1);
    if (
      active &&
      active.provider === provider &&
      active.accountProfileId === accountProfileId &&
      active.turns < SESSION_MAX_TURNS &&
      active.inputTokens < SESSION_MAX_INPUT_TOKENS
    ) {
      const full = active.turns % FULL_LEDGER_EVERY === 0 || !active.lastTurnAt;
      return {
        conversation,
        requestId: request.id,
        // An active session always has a completed turn: an opening turn that failed is `lost`.
        session: { id: active.sessionId, resume: true, ...sessionKey(active) },
        items: [
          ledgerItem(
            full
              ? all()
              : this.store.ledger(conversationId, { current: true, since: active.lastTurnAt! }),
            full ? 'all' : 'since-last-turn',
          ),
          ...elsewhere,
        ],
      };
    }
    // A new session: the previous one is never resumed again; its work comes over in the packet.
    const previous = active ?? this.store.sessions(conversationId).at(-1);
    const reason: NewSessionReason = !previous
      ? 'first'
      : active
        ? active.accountProfileId !== accountProfileId || active.provider !== provider
          ? 'account'
          : 'length'
        : previous.state === 'lost'
          ? 'lost'
          : // A confirmed hand-over (T2 card) left the session: say which way it went.
            previous.state === 'handed-off' && previous.provider !== provider
            ? 'provider'
            : previous.state === 'handed-off' && previous.accountProfileId !== accountProfileId
              ? 'account'
              : 'closed';
    if (active) this.store.setSessionState(active, 'handed-off');
    const key = { conversationId, provider, accountProfileId, sessionId: randomUUID() };
    const version = await cliVersion();
    // Codex names its thread itself: the row is added when the opening turn reports it.
    const pending = provider === 'codex-cli' ? { cliVersion: version } : undefined;
    if (!pending) this.store.addSession({ ...key, promptMode: 'neutral', cliVersion: version });
    if (conversation.accountProfileId !== accountProfileId)
      this.store.update(request.projectId, conversationId, { accountProfileId });
    const items: TurnItem[] = [ledgerItem(all(), 'all')];
    if (previous) {
      items.push(handoffItem(reason, own));
      const { sessionId: _placeholder, ...opening } = key;
      this.store.addLedgerItem(conversationId, {
        kind: 'handoff',
        requestId: request.id,
        body: { reason, from: sessionKey(previous), to: pending ? opening : key },
      });
    }
    return {
      conversation,
      requestId: request.id,
      session: { id: key.sessionId, resume: false, ...key },
      items: [...items, ...elsewhere],
      opened: reason,
      ...(pending ? { pending } : {}),
    };
  }
  /** Books the turn's outcome: tokens on the session, a lost session, the result in the ledger. */
  endTurn(turn: Turn, done: { state: string; result: Record<string, unknown> | null }) {
    const code = typeof done.result?.code === 'string' ? done.result.code : undefined;
    const finished = done.state === 'succeeded' || done.state === 'unknown';
    let session: (SessionOptions & ProviderSessionKey) | undefined = turn.session;
    if (session && turn.pending) {
      // A Codex opening turn: the session is the thread it reported; without one nothing resumes.
      const thread = done.result?.sessionId;
      session =
        typeof thread === 'string' && /^[0-9a-f-]{36}$/.test(thread)
          ? { ...session, sessionId: thread, id: thread }
          : undefined;
      if (session)
        this.store.addSession({
          ...sessionKey(session),
          promptMode: 'neutral',
          cliVersion: turn.pending.cliVersion,
        });
    }
    if (session) {
      if (finished) {
        // Codex counts cache reads inside its input, and a resumed Codex turn reports the
        // session's running total (SPIKE-2026-09-30 ④): only the growth is this turn's.
        const tokens =
          session.provider === 'codex-cli'
            ? Math.max(
                0,
                Math.round(
                  Number((done.result?.usage as { inputTokens?: unknown })?.inputTokens) || 0,
                ),
              )
            : turnTokens(done.result?.usage);
        this.store.recordTurn(
          session,
          done.result?.usageScope === 'session'
            ? Math.max(0, tokens - this.store.session(sessionKey(session)).inputTokens)
            : tokens,
        );
      }
      // A stop without a confirmed exit or a transcript that is gone is never resumed
      // (SPEC-02.19 5); neither is an opening turn that failed, since the CLI may have written
      // its transcript under that ID already (a fresh ID opens the next turn).
      else if (!session.resume || code === 'STOP_UNCONFIRMED' || code === 'SESSION_LOST')
        this.store.setSessionState(session, 'lost');
    }
    if (finished)
      this.store.addLedgerItem(turn.conversation.id, {
        kind: 'result-ref',
        requestId: turn.requestId,
        body: {
          state: done.state,
          text: clip(done.result?.text, 300),
          hostExecuted: done.result?.hostExecuted === true,
          ...(typeof done.result?.host === 'string' ? { host: done.result.host } : {}),
          ...(code ? { code } : {}),
        },
      });
    // Question cards go in the ledger, so a later turn never asks them again.
    const questions = z
      .object({ turnOutput: z.object({ questions: z.array(z.unknown()) }).passthrough() })
      .passthrough()
      .safeParse(done.result);
    if (finished && turn.structured && questions.success)
      for (const question of questions.data.turnOutput.questions)
        this.store.addLedgerItem(turn.conversation.id, {
          kind: 'question',
          requestId: turn.requestId,
          body: question,
        });
    this.options.diagnostics?.write('conversation-turn', {
      conversationId: turn.conversation.id,
      requestId: turn.requestId,
      mode: turn.session ? 'session' : 'ledger',
      ...(turn.session ? { resume: turn.session.resume } : {}),
      ...(turn.opened ? { opened: turn.opened } : {}),
      state: done.state,
      code: code ?? null,
    });
  }

  /**
   * Answers a turn's question cards (SPEC-02.19 6): each open question of that turn gets the
   * chosen option, a free answer when the card allows one, or its recommended option. The answers
   * go in the ledger under the next turn's request ID; `withdraw` takes them back when that turn
   * could not be submitted.
   */
  answer(projectId: string, conversationId: string, value: unknown, nextRequestId: string) {
    const conversation = this.store.get(projectId, conversationId);
    if (conversation.state !== 'open') throw new DomainError('CONVERSATION_CLOSED');
    const input = answerInput.parse(value);
    const ledger = this.store.ledger(conversationId, { current: true });
    const answered = new Set(
      ledger
        .filter((item) => item.kind === 'answer' || item.kind === 'decision')
        .map((item) => (item.body as { questionId?: unknown } | null)?.questionId),
    );
    const open = new Map<string, TurnQuestion>();
    for (const item of ledger)
      if (item.kind === 'question' && item.requestId === input.requestId) {
        const parsed = turnOutputSchema.safeParse({
          status: 'question',
          text: '',
          questions: [item.body],
        });
        const question = parsed.success ? parsed.data.questions[0] : undefined;
        if (question && !answered.has(question.id)) open.set(question.id, question);
      }
    if (!open.size) throw new DomainError('NOT_FOUND');
    const answers: TurnAnswer[] = [];
    for (const given of input.answers) {
      const question = open.get(given.questionId);
      if (!question || answers.some((a) => a.question.id === question.id))
        throw new DomainError('INVALID_INPUT');
      const option = given.optionId
        ? question.options.find((candidate) => candidate.id === given.optionId)
        : undefined;
      if ((given.optionId && !option) || (given.text && !question.allowFree))
        throw new DomainError('INVALID_INPUT');
      answers.push({ question, option, text: given.text, recommended: false });
    }
    if (input.recommended)
      for (const question of open.values())
        if (!answers.some((a) => a.question.id === question.id))
          answers.push({
            question,
            option: question.options.find((o) => o.recommended) ?? question.options[0],
            recommended: true,
          });
    if (!answers.length) throw new DomainError('INVALID_INPUT');
    const items = answers.map((answer) =>
      this.store.addLedgerItem(conversationId, {
        kind: 'answer',
        requestId: nextRequestId,
        body: {
          questionId: answer.question.id,
          askedIn: input.requestId,
          title: answer.question.title,
          ...(answer.option ? { optionId: answer.option.id, label: answer.option.label } : {}),
          ...(answer.text ? { text: answer.text } : {}),
          by: answer.recommended ? 'recommended' : 'user',
        },
      }),
    );
    return { conversation, body: formatAnswers(answers), items };
  }
  /** Takes back recorded answers whose turn was not submitted (they can be answered again). */
  withdraw(conversationId: string, items: LedgerItem[]) {
    for (const item of items) this.store.supersede(conversationId, item.id, item.id);
  }

  /** Removes the transcripts of every session of the conversation (a discarded jig draft, retention). */
  async purge(conversationId: string) {
    let removed = 0;
    for (const session of this.store.sessions(conversationId))
      if (session.state !== 'closed') {
        removed += await this.removeTranscript(session);
        this.store.setSessionState(session, 'closed');
      }
    return removed;
  }
  /** Transcripts of conversations closed more than 30 days ago (SPEC-02.19 1). */
  async sweep(now = new Date()) {
    const before = new Date(now.getTime() - TRANSCRIPT_RETENTION_DAYS * 86_400_000).toISOString();
    let removed = 0;
    for (const conversation of this.store.closedBefore(before))
      removed += await this.purge(conversation.id);
    return removed;
  }
  private async removeTranscript(session: ProviderSession) {
    let directory: string | undefined;
    try {
      directory = this.options.profiles?.directory(
        session.provider as Provider,
        session.accountProfileId,
      );
    } catch {
      return 0; // The account profile is gone, and its transcripts with it.
    }
    try {
      return await (this.options.removeTranscript ?? removeTranscript)(
        session.provider as Provider,
        directory,
        session.sessionId,
      );
    } catch (error) {
      this.options.diagnostics?.write('transcript-remove-failed', {
        conversationId: session.conversationId,
        provider: session.provider,
        code: (error as { code?: string }).code ?? 'UNKNOWN',
      });
      return 0;
    }
  }
}

const sessionKey = (session: ProviderSessionKey): ProviderSessionKey => ({
  conversationId: session.conversationId,
  provider: session.provider,
  accountProfileId: session.accountProfileId,
  sessionId: session.sessionId,
});
const sessionSummary = (session: ProviderSession): SessionSummary => ({
  sessionId: session.sessionId,
  provider: session.provider,
  accountProfileId: session.accountProfileId,
  turns: session.turns,
  inputTokens: session.inputTokens,
  state: session.state,
  lastTurnAt: session.lastTurnAt,
});
/** Hand-over to a new session (SPEC-02.19 5): the ledger item carries everything decided; this one the recent turns and files. */
function handoffItem(reason: NewSessionReason, own: StoredWork[]): TurnItem {
  const finished = own.filter((row) => row.state === 'succeeded');
  const files = new Set<string>();
  for (const row of finished.slice(-20))
    for (const file of row.input.files) if (typeof file.name === 'string') files.add(file.name);
  const last = own.at(-1);
  const stopped =
    last?.state === 'failed' && last.result?.code === 'PROVIDER_LIMIT' ? last : undefined;
  return {
    id: 'handoff',
    type: 'handoff',
    data: {
      reason,
      note: 'This is a new session of the same conversation. The ledger item holds every decision, assumption, question and result so far; the most recent turns follow.',
      recentTurns: finished.slice(-RECENT_TURNS).map((row) => ({
        request: clip(row.input.body, 2000),
        response: clip(row.result?.text, 6000),
      })),
      files: [...files],
      // The turn an account limit stopped was not answered and is not sent again by itself.
      ...(stopped ? { stopped: { request: clip(stopped.input.body, 2000), answered: false } } : {}),
    },
  };
}
/** What other conversations changed since this one's last turn (SPEC-02.17 6): reflected documents and edits. */
function changesElsewhere(rows: StoredWork[], conversationId: string, since: string): TurnItem[] {
  const changes = rows
    .filter(
      (row) =>
        (row.input.conversationId ?? null) !== conversationId &&
        row.createdAt > since &&
        row.state === 'succeeded' &&
        row.result?.hostExecuted === true,
    )
    .slice(-20)
    .map((row) => ({
      requestId: row.id,
      kind:
        row.input.source === 'document' ? 'sync' : row.input.source === 'file' ? 'import' : 'edit',
      host: row.result?.host ?? row.input.host ?? 'rhino',
      request: clip(row.input.body, 200),
      at: row.createdAt,
    }));
  return changes.length
    ? [{ id: 'changes-elsewhere', type: 'changes-elsewhere', data: changes }]
    : [];
}

export interface ConversationRouteContext {
  service: ConversationService;
  body: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  send: (status: number, data: unknown) => void;
  /** The request came through the remote tunnel: confirmed (T2) actions are refused. */
  remote?: boolean;
  /** Jev's service, model and effort for a new conversation (SPEC-02.17 5). */
  chooseModel: (input: RoutingInput, requested?: Provider) => Promise<Choice & { task?: string }>;
  /** The account a new conversation is fixed to (SPEC-02.19 2). */
  chooseAccount: (provider: Provider) => Promise<string>;
  /** Submits a request (the answer turn) the way `POST …/requests` does; returns it. */
  submit?: (projectId: string, input: Record<string, unknown>) => Promise<unknown>;
}

/** Answers `/api/v1/projects/:id/conversations…`; false when the request is not one. */
export async function conversationRoutes(
  url: URL,
  request: IncomingMessage,
  { service, body, send, remote, chooseModel, chooseAccount, submit }: ConversationRouteContext,
): Promise<boolean> {
  const route =
    /^\/api\/v1\/projects\/([^/]+)\/conversations(?:\/([^/]+)(?:\/(close|reopen|ledger|handoff|account|answer))?)?$/.exec(
      url.pathname,
    );
  if (!route) return false;
  const [, projectId, rawId, action] = route;
  if (!rawId) {
    if (request.method === 'GET') {
      send(200, service.list(projectId));
      return true;
    }
    if (request.method !== 'POST') return false;
    const input = createInput.parse(await body(request));
    // A named service (and model) is kept as in a request; otherwise Jev chooses once, here.
    const automatic = !input.provider || isAutoModel(input.model);
    const choice = automatic
      ? await chooseModel(
          { body: input.body ?? input.title ?? '', host: input.host, permission: input.permission },
          input.provider,
        )
      : { provider: input.provider!, model: input.model, effort: input.effort ?? 'default' };
    const kind =
      input.mode === 'make'
        ? 'jig-make'
        : (input.kind ?? kindOf(automatic ? choice.task : undefined, input.host));
    const title =
      input.title ??
      (input.body?.trim() ? clip(input.body.trim().replace(/\s+/g, ' '), 60) : KIND_TITLES[kind]);
    send(
      201,
      service.create(projectId, {
        kind,
        title,
        provider: choice.provider,
        model: choice.model ?? null,
        effort: choice.effort,
        accountProfileId: await chooseAccount(choice.provider),
        jigInstanceId: input.jigInstanceId,
        draftId: input.draftId,
        targets: input.targets,
      }),
    );
    return true;
  }
  const conversationId = rawId === 'default' ? null : rawId;
  if (!action) {
    if (request.method !== 'GET') return false;
    send(200, service.get(projectId, conversationId));
    return true;
  }
  if (request.method !== 'POST') return false;
  // The default conversation has no session, ledger or hand-over of its own.
  if (conversationId === null) throw new DomainError('INVALID_INPUT');
  if (action === 'close') {
    const input = closeInput.parse(await body(request));
    send(200, await service.close(projectId, conversationId, { discard: input.discard }));
  } else if (action === 'reopen') send(200, service.reopen(projectId, conversationId));
  else if (action === 'ledger')
    send(201, service.addLedger(projectId, conversationId, await body(request)));
  else if (action === 'answer') {
    // The answers go as the next turn of the same conversation (SPEC-02.19 6).
    if (!submit) throw new DomainError('EXECUTOR_NOT_READY');
    const next = randomUUID();
    const answered = service.answer(projectId, conversationId, await body(request), next);
    try {
      const created = await submit(projectId, {
        id: next,
        conversationId,
        body: answered.body,
        permission: 'review',
        hostUse: 'none',
        provider: answered.conversation.provider,
        pins: [],
        sketches: [],
        files: [],
      });
      send(201, { request: created, answers: answered.items });
    } catch (error) {
      service.withdraw(conversationId, answered.items);
      throw error;
    }
  } else if (action === 'account') {
    // The confirmed T2 card of an account limit: same service, another account (SPEC-02.19 5).
    if (remote) throw new DomainError('FORBIDDEN');
    send(200, service.switchAccount(projectId, conversationId, await body(request)));
  } else {
    if (remote) throw new DomainError('FORBIDDEN');
    const input = handoffInput.parse(await body(request));
    send(
      200,
      service.handoffTo(projectId, conversationId, input, await chooseAccount(input.provider)),
    );
  }
  return true;
}
