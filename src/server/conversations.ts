// Conversations (SPEC-02.19, ADR-021, PLAN-24 T-061): a conversation is one purpose's flow of
// turns. Its service and model are fixed when it opens; every turn runs on the CLI's default login
// of that moment (ADR-025: accounts are switched in AccountSwitch). A Claude conversation continues
// one provider session (one CLI run per turn, `--session-id` then `--resume`), a Codex one too
// (`exec resume <thread>`, SPIKE ④ re-test 2026-09-30; the thread is named by its first turn).
// A provider switched off in SESSION_PROVIDERS runs the ledger method. VIDE's ledger,
// not the provider transcript, is the record: losing a session loses no work. Every conversation,
// the project's default one included, fixes its service and model at its first turn (2026-10-01,
// ADR-021, `place`): the composer's own model, else Jev's choice, once; another model later opens a
// new conversation with a hand-over. The default conversation becomes a row (`default-<project>`)
// at its first turn; requests from before then (`conversationId` NULL) stay listed under it.
// Storage rows: ARCH-03 §10; CLI arguments: ARCH-01 §2.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import type { StoredWork } from '../contracts/stored-work.ts';
import { hostUse, waitingOf, type WaitingFor } from '../contracts/request-scope.ts';
import type { SessionOptions } from '../ai/claude-cli.ts';
import { removeClaudeTranscript } from '../ai/claude-cli.ts';
import { removeCodexTranscript } from '../ai/codex-cli.ts';
import { MAKE_LIMITS } from './make-routes.ts';
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
/**
 * Past these a new session with the ledger is suggested (SPEC-02.19 5; PLAN-24 starting values):
 * the defaults of the conversation length setting (`<data>/conversation-settings.json`).
 */
export const SESSION_MAX_TURNS = 12;
export const SESSION_MAX_INPUT_TOKENS = 150_000;
export const sessionLimitsSchema = z
  .object({
    maxTurns: z.number().int().min(2).max(200),
    maxInputTokens: z.number().int().min(10_000).max(2_000_000),
  })
  .strict();
export type SessionLimits = z.infer<typeof sessionLimitsSchema>;
export const DEFAULT_SESSION_LIMITS: SessionLimits = Object.freeze({
  maxTurns: SESSION_MAX_TURNS,
  maxInputTokens: SESSION_MAX_INPUT_TOKENS,
});
/** The ledger item sent with a turn; older entries are summarized past this (ARCH-03 §10.3). */
export const LEDGER_BYTES = 8 * 1024;
/** Provider transcripts of a closed conversation are removed after this (SPEC-02.19 1). */
export const TRANSCRIPT_RETENTION_DAYS = 30;
/** Every this many turns of one session the whole ledger goes again (SPEC-02.17 6). */
const FULL_LEDGER_EVERY = 6;
const RECENT_TURNS = 3;
export const DEFAULT_TITLE = '기본 대화';
/** What the composer sends for the default conversation; the server resolves it to the row. */
export const DEFAULT_KEY = 'default';
/** The default conversation's row, made at its first turn. */
export const defaultConversationId = (projectId: string) => `default-${projectId}`;
/** The ledger mark of a conversation opened with "자동 (Jev)" and no request yet. */
const FIRST_TURN_CHOICE = 'first-turn';
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
  NO_ACTIVE_SESSION: 409,
  CONVERSATION_BOUND: 409,
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
 * The conversation's session reached the length setting (SPEC-02.19 5): a new session with the
 * ledger and the hand-over packet is suggested ([새 세션으로 이어가기], `…/renew`); until then the
 * session goes on.
 */
export interface LengthHandover {
  kind: 'length';
  grade: 'T1';
  turns: number;
  inputTokens: number;
  limits: SessionLimits;
  sends: { ledgerItems: number; recentTurns: number; files: number };
}
export type ConversationSummary = (
  | Conversation
  | DefaultConversation
  | (Omit<Conversation, 'id'> & { id: null })
) & {
  requests: number;
  /** Service and model are chosen at the next (first) turn; until then the shown ones are provisional. */
  pending: boolean;
  /** The session the next turn would resume, if any. */
  session: SessionSummary | null;
  /**
   * A suggested hand-over (the session reached the length setting). A turn stopped on the
   * account's limit is not handed over: it is not sent again, and the app says to change the
   * account in AccountSwitch (ADR-025).
   */
  handover: LengthHandover | null;
};
export type NewSessionReason =
  | 'first'
  | 'account'
  | 'provider'
  | 'model'
  | 'length'
  | 'lost'
  | 'closed';
/** Where a turn's conversation goes and how its service and model were fixed (`place`). */
export interface Placement {
  conversation: Conversation;
  /** Jev's decision when it chose at this (first) turn. */
  routing?: Choice;
  /** The conversation the request was sent from when another model opened a new one. */
  movedFrom?: Conversation;
}
export interface PlaceDeps {
  /** Jev's service, model and effort for this request (`requested`: the composer's service). */
  route: (requested: Provider) => Promise<Choice>;
}
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
  /**
   * A reference-image turn (SPEC-09.4, T-090): the output carries the board's interpretation
   * (`required`), or may carry a spoken correction of it (`optional`).
   */
  reference?: 'required' | 'optional';
  /**
   * A host or jig turn of a conversation with a reference board: no structured output, so a
   * correction comes as a fenced block in the reply (Execution takes it out, T-090).
   */
  referenceBlock?: boolean;
  /** The board (attachment id) the turn's correction belongs to. */
  referenceBoard?: string;
}
/** What a reference board adds to a turn (src/server/reference-boards.ts `turnItem`). */
export interface ReferenceTurn {
  item: TurnItem;
  output?: 'required' | 'optional';
  /** A chat turn's board: the one it was shown, whatever is newest when it ends. */
  attachmentId?: string;
}
export interface Hold {
  /** The conversation's line is stopped (an unresolved result, SPEC-02.19 4). */
  code?: string;
  waitingFor?: WaitingFor;
}
interface Options {
  diagnostics?: Pick<Diagnostics, 'write'>;
  /** Test seam: removes one session's provider transcript (default: the CLI modules'). */
  removeTranscript?: (provider: Provider, sessionId: string) => Promise<number>;
  /**
   * The conversation length setting's file; by default `conversation-settings.json` next to the
   * database (none for an in-memory one: the defaults apply).
   */
  settingsFile?: string | null;
  /** The reference board's item and output of a turn (SPEC-09, T-090); none for most turns. */
  reference?: (request: StoredWork) => ReferenceTurn | undefined;
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
/**
 * The composer's own service and model (SPEC-02.19 2); undefined for "자동 (Jev)". A model named
 * after its service is that CLI's own default model (no catalog): stored as no model.
 */
export function explicitChoice(input: Record<string, unknown>): Choice | undefined {
  const provider = providerSchema.safeParse(input.provider);
  if (!provider.success || typeof input.model !== 'string' || isAutoModel(input.model)) return;
  const model = modelSchema.safeParse(input.model);
  if (!model.success) return;
  return {
    provider: provider.data,
    model: model.data === provider.data ? undefined : model.data,
    effort: typeof input.effort === 'string' ? input.effort : 'default',
  };
}
const sameAi = (conversation: Conversation, choice: Choice) =>
  conversation.provider === choice.provider &&
  (conversation.model ?? null) === (choice.model ?? null);
const sessionMode = (provider: Provider, kind: Kind) =>
  SESSION_PROVIDERS[provider] && !(kind === 'jig-make' && provider === 'codex-cli')
    ? 'session'
    : 'ledger';
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
/** Removes one session's transcript from the CLI's default folder (`~/.claude`, `~/.codex`). */
export async function removeTranscript(provider: Provider, sessionId: string) {
  return provider === 'codex-cli'
    ? removeCodexTranscript(undefined, sessionId)
    : removeClaudeTranscript(undefined, sessionId);
}

export class ConversationService {
  readonly store: ConversationStore;
  private readonly db: Store;
  private readonly options: Options;
  private readonly settingsFile: string | null;
  private cachedLimits?: SessionLimits;
  constructor(store: Store, options: Options = {}) {
    this.db = store;
    this.store = new ConversationStore(store.db);
    this.options = options;
    const location = store.db.location();
    this.settingsFile =
      options.settingsFile !== undefined
        ? options.settingsFile
        : location
          ? join(dirname(location), 'conversation-settings.json')
          : null;
    this.recover();
  }
  /** The conversation length setting (defaults when unset or unreadable). */
  limits(): SessionLimits {
    if (this.cachedLimits) return this.cachedLimits;
    let limits = DEFAULT_SESSION_LIMITS;
    if (this.settingsFile)
      try {
        const parsed = sessionLimitsSchema.safeParse(
          JSON.parse(readFileSync(this.settingsFile, 'utf8')),
        );
        if (parsed.success) limits = parsed.data;
      } catch {
        /* No file yet, or one that does not parse: the defaults. */
      }
    return (this.cachedLimits = limits);
  }
  saveLimits(value: unknown): SessionLimits {
    const parsed = sessionLimitsSchema.safeParse(value);
    if (!parsed.success) throw new DomainError('INVALID_INPUT');
    if (this.settingsFile) {
      mkdirSync(dirname(this.settingsFile), { recursive: true });
      writeFileSync(this.settingsFile, JSON.stringify(parsed.data, null, 2) + '\n');
    }
    return (this.cachedLimits = parsed.data);
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
      pending: conversation.id ? this.pendingChoice(conversation as Conversation) : true,
      session: active ? sessionSummary(active) : null,
      handover:
        conversation.id && active
          ? this.lengthHandover(conversation as Conversation, active)
          : null,
    };
  }
  /** The project's default conversation row, once its first turn made it. */
  defaultRow(projectId: string): Conversation | undefined {
    try {
      return this.store.get(projectId, defaultConversationId(projectId));
    } catch (error) {
      if ((error as { code?: string }).code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }
  /**
   * The default conversation as listed (`id` null): its row once fixed, with the requests from
   * before the row (no `conversationId`) counted in.
   */
  private defaultSummary(projectId: string): ConversationSummary {
    const row = this.defaultRow(projectId);
    if (!row) return this.summarize(this.defaultConversation(projectId));
    const summary = this.summarize(row);
    return {
      ...summary,
      id: null,
      title: DEFAULT_TITLE,
      requests: summary.requests + this.store.requestIds(projectId, null).length,
    } as ConversationSummary;
  }
  /** The conversation was opened with "자동 (Jev)" and no request yet: its first turn chooses. */
  private pendingChoice(conversation: Conversation) {
    return this.store
      .ledger(conversation.id, { current: true })
      .some(
        (item) =>
          item.kind === 'decision' &&
          (item.body as { aiChoice?: unknown } | null)?.aiChoice === FIRST_TURN_CHOICE,
      );
  }
  /** The length suggestion of an open conversation whose active session reached the setting. */
  private lengthHandover(
    conversation: Conversation,
    active: ProviderSession,
  ): LengthHandover | null {
    const limits = this.limits();
    if (
      conversation.state !== 'open' ||
      (active.turns < limits.maxTurns && active.inputTokens < limits.maxInputTokens)
    )
      return null;
    const { finished, files } = this.recentWork(this.latestRows(conversation.id));
    return {
      kind: 'length',
      grade: 'T1',
      turns: active.turns,
      inputTokens: active.inputTokens,
      limits,
      sends: {
        ledgerItems: this.store.ledger(conversation.id, { current: true }).length,
        recentTurns: Math.min(finished, RECENT_TURNS),
        files,
      },
    };
  }
  /** Finished turns and file names among a conversation's latest requests (what a hand-over sends). */
  private recentWork(rows: { state: string; input: string }[]) {
    const files = new Set<string>();
    let finished = 0;
    for (const row of rows)
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
    return { finished, files: files.size };
  }
  private latestRows(conversationId: string) {
    return this.db.db
      .prepare(
        `SELECT id, state, input, result FROM workspace_requests WHERE conversationId=?
          ORDER BY rowid DESC LIMIT 21`,
      )
      .all(conversationId) as {
      id: string;
      state: string;
      input: string;
      result: string | null;
    }[];
  }

  /** Opens a conversation on the service, model and effort it keeps until it closes. */
  create(
    projectId: string,
    value: {
      kind: Kind;
      title: string;
      provider: Provider;
      model?: string | null;
      effort?: string | null;
      jigInstanceId?: string | null;
      draftId?: string | null;
      targets?: string[] | null;
      /** Opened with "자동 (Jev)" before any request: the first turn chooses again (`place`). */
      pending?: boolean;
    },
  ) {
    return this.summarize(this.open(projectId, value));
  }
  private open(
    projectId: string,
    { pending, ...value }: Parameters<ConversationService['create']>[1],
    row?: string,
    by?: 'user' | 'jev',
  ) {
    this.db.project(projectId);
    // A make-conversation writes an open draft of this project (PLAN-22 T-063).
    if (
      value.kind === 'jig-make' &&
      value.draftId &&
      new JigStore(this.db.db).draft(projectId, value.draftId).state !== 'open'
    )
      throw new DomainError('DRAFT_NOT_OPEN');
    const conversation = this.store.create(
      projectId,
      {
        ...value,
        effort: value.effort === 'default' ? null : value.effort,
        // A Codex make-conversation runs the ledger method: its draft files travel in each packet.
        mode: sessionMode(value.provider, value.kind),
      },
      row,
    );
    if (pending)
      this.store.addLedgerItem(conversation.id, {
        kind: 'decision',
        body: { aiChoice: FIRST_TURN_CHOICE },
      });
    this.options.diagnostics?.write('conversation-open', {
      conversationId: conversation.id,
      projectId,
      kind: conversation.kind,
      provider: conversation.provider,
      model: conversation.model,
      effort: conversation.effort,
      mode: conversation.mode,
      ...(by ? { by } : {}),
      ...(pending ? { pending: true } : {}),
    });
    return conversation;
  }
  /** The default conversation first, then the project's own in opening order. */
  list(projectId: string): ConversationSummary[] {
    this.db.project(projectId);
    const own = defaultConversationId(projectId);
    return [
      this.defaultSummary(projectId),
      ...this.store
        .list(projectId)
        .filter((entry) => entry.id !== own)
        .map((entry) => this.summarize(entry)),
    ];
  }
  get(projectId: string, conversationId: string | null) {
    this.db.project(projectId);
    if (conversationId === null) {
      const row = this.defaultRow(projectId);
      return {
        ...this.defaultSummary(projectId),
        ledger: row ? this.store.ledger(row.id, { current: true }) : [],
        sessions: row ? this.store.sessions(row.id).map(sessionSummary) : [],
      };
    }
    const conversation = this.store.get(projectId, conversationId);
    return {
      ...this.summarize(conversation),
      ledger: this.store.ledger(conversationId, { current: true }),
      sessions: this.store.sessions(conversationId).map(sessionSummary),
    };
  }
  /** Closing keeps VIDE's requests, results and ledger; `discard` removes the transcripts now. */
  async close(projectId: string, conversationId: string, { discard = false } = {}) {
    // The default conversation stays (SPEC-02.19 1).
    if (conversationId === defaultConversationId(projectId)) throw new DomainError('INVALID_INPUT');
    const conversation = this.store.setState(projectId, conversationId, 'closed');
    if (discard) await this.purge(conversationId);
    return this.summarize(this.store.get(projectId, conversation.id));
  }
  /** A reopened conversation whose transcripts are gone starts a new session from the ledger. */
  reopen(projectId: string, conversationId: string) {
    return this.summarize(this.store.setState(projectId, conversationId, 'open'));
  }
  /**
   * Binds an open conversation to a jig instance (RESEARCH-12 §6.3): its later turns get jig_set
   * and jig_run on that instance. A conversation bound to another instance, or a make-conversation,
   * is not rebound (the screen opens a new jig conversation instead).
   */
  bind(projectId: string, conversationId: string, jigInstanceId: string) {
    const conversation = this.store.get(projectId, conversationId);
    if (conversation.state !== 'open') throw new DomainError('CONVERSATION_CLOSED');
    if (conversation.kind === 'jig-make') throw new DomainError('INVALID_INPUT');
    new JigStore(this.db.db).instance(projectId, jigInstanceId);
    if (conversation.jigInstanceId && conversation.jigInstanceId !== jigInstanceId)
      throw new DomainError('CONVERSATION_BOUND');
    return this.summarize(this.store.update(projectId, conversationId, { jigInstanceId }));
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
      // Make budgets for every make turn, a question card's answer turn too (T-063).
      if (input.executionLimits === undefined) input.executionLimits = { ...MAKE_LIMITS };
    }
    return conversation;
  }
  /**
   * A make-conversation is stopped (T-063) from its latest stop card (repeated failures or the
   * turn cap) until that card is answered with a way to go on (another approach, a narrower
   * scope, a free answer or 'continue'); 'stop-here' and 'new-conversation' keep it stopped. Its
   * later turns get no file tools. Other conversations are never stopped.
   */
  makeStopped(projectId: string, conversationId: string) {
    const conversation = this.store.get(projectId, conversationId);
    if (conversation.kind !== 'jig-make') return false;
    const ledger = this.store.ledger(conversationId, { current: true }).reverse();
    const card = ledger.find(
      (item) =>
        item.kind === 'question' &&
        /^make-(stop|turn-cap)-\d+$/.test(String((item.body as { id?: unknown } | null)?.id)),
    );
    if (!card) return false;
    const cardId = (card.body as { id: string }).id;
    const answer = ledger.find(
      (item) =>
        (item.kind === 'answer' || item.kind === 'decision') &&
        (item.body as { questionId?: unknown } | null)?.questionId === cardId,
    )?.body as { optionId?: string; text?: string } | undefined;
    if (!answer) return true;
    if (answer.optionId) return ['stop-here', 'new-conversation'].includes(answer.optionId);
    return !answer.text;
  }
  /**
   * Where a submitted turn goes (SPEC-02.19 2, 2026-10-01): `conversationId` is a conversation or
   * `default`. The first turn fixes service and model: the composer's own model, else Jev's choice
   * (the only time Jev chooses a model for a conversation). A later turn keeps them; only its effort
   * may differ. Another service or model from the composer opens a new conversation with a
   * hand-over, and the request goes there. Fills the input like `fix`.
   */
  async place(
    projectId: string,
    input: Record<string, unknown>,
    deps: PlaceDeps,
  ): Promise<Placement> {
    const raw = id.parse(input.conversationId);
    const explicit = explicitChoice(input);
    let routing: Placement['routing'];
    const choose = async (): Promise<Choice> =>
      explicit ??
      (routing = await deps.route(input.provider === 'codex-cli' ? 'codex-cli' : 'claude-cli'));
    let conversation: Conversation | undefined;
    let movedFrom: Conversation | undefined;
    let opened = false;
    if (raw === DEFAULT_KEY || raw === defaultConversationId(projectId)) {
      this.db.project(projectId);
      conversation = this.defaultRow(projectId);
      if (!conversation) {
        opened = true;
        const choice = await choose();
        // Two first turns at once: the one that lost the race joins the row the other made.
        conversation =
          this.defaultRow(projectId) ??
          this.open(
            projectId,
            {
              kind: 'general',
              title: DEFAULT_TITLE,
              provider: choice.provider,
              model: choice.model ?? null,
              effort: choice.effort,
            },
            defaultConversationId(projectId),
            routing ? 'jev' : 'user',
          );
      }
    } else conversation = this.store.get(projectId, raw);
    if (conversation.state !== 'open') throw new DomainError('CONVERSATION_CLOSED');
    if (!opened) {
      const mark = this.store
        .ledger(conversation.id, { current: true })
        .find(
          (item) =>
            item.kind === 'decision' &&
            (item.body as { aiChoice?: unknown } | null)?.aiChoice === FIRST_TURN_CHOICE,
        );
      if (mark) {
        // Opened with "자동 (Jev)" and no request yet: this first turn fixes service and model.
        const choice = await choose();
        this.store.supersede(conversation.id, mark.id, mark.id);
        conversation = this.store.update(projectId, conversation.id, {
          provider: choice.provider,
          model: choice.model ?? null,
          effort: choice.effort === 'default' ? null : choice.effort,
          mode: sessionMode(choice.provider, conversation.kind),
        });
        this.options.diagnostics?.write('conversation-fixed', {
          conversationId: conversation.id,
          provider: conversation.provider,
          model: conversation.model,
          by: routing ? 'jev' : 'user',
        });
      } else if (explicit && !sameAi(conversation, explicit)) {
        movedFrom = conversation;
        conversation = this.continueIn(
          projectId,
          conversation,
          explicit,
          typeof input.body === 'string' ? input.body : undefined,
        );
      }
    }
    input.conversationId = conversation.id;
    this.fix(projectId, input);
    if (routing) input.routing = routing;
    return { conversation, ...(routing ? { routing } : {}), ...(movedFrom ? { movedFrom } : {}) };
  }
  /**
   * Another service or model for an open conversation (SPEC-02.19 5, 2026-10-01): the conversation
   * stays as it is, a new one opens on that service and model, and its first session gets the
   * hand-over (the old conversation's ledger, latest turns and files). Both ledgers say so.
   */
  private continueIn(projectId: string, from: Conversation, choice: Choice, body?: string) {
    const title =
      body?.trim() && from.id === defaultConversationId(projectId)
        ? clip(body.trim().replace(/\s+/g, ' '), 60)
        : from.id === defaultConversationId(projectId)
          ? KIND_TITLES.general
          : from.title;
    const made = this.open(projectId, {
      kind: from.kind === 'app' ? 'general' : from.kind,
      title,
      provider: choice.provider,
      model: choice.model ?? null,
      effort: choice.effort,
      jigInstanceId: from.jigInstanceId,
      draftId: from.draftId,
      targets: from.targets,
    });
    const side = (conversation: Conversation) => ({
      conversationId: conversation.id,
      title:
        conversation.id === defaultConversationId(projectId) ? DEFAULT_TITLE : conversation.title,
      provider: conversation.provider,
      model: conversation.model,
    });
    // The account-limit stop the old conversation shows is answered by this move.
    const stopped = this.limitStopped(from.id);
    this.store.addLedgerItem(from.id, {
      kind: 'handoff',
      ...(stopped ? { requestId: stopped } : {}),
      body: { reason: 'moved', to: side(made) },
    });
    this.store.addLedgerItem(made.id, {
      kind: 'handoff',
      body: {
        reason: 'model',
        from: side(from),
        to: { provider: made.provider, model: made.model },
      },
    });
    this.options.diagnostics?.write('conversation-handover', {
      conversationId: made.id,
      from: from.id,
      reason: 'model',
      provider: made.provider,
      model: made.model,
    });
    return made;
  }
  /**
   * [다른 AI로 이어 가기] (SPEC-02.19 5, confirmed T2 card): a new conversation on the chosen
   * service and model takes over; its first turn opens a session with the hand-over.
   */
  handoffTo(projectId: string, conversationId: string, value: unknown) {
    const input = handoffInput.parse(value);
    const conversation = this.store.get(projectId, conversationId);
    if (conversation.state !== 'open') throw new DomainError('CONVERSATION_CLOSED');
    return this.summarize(
      this.continueIn(projectId, conversation, {
        provider: input.provider,
        model: input.model,
        effort: input.effort ?? 'default',
      }),
    );
  }
  /**
   * The conversation's latest request, when it stopped on the account's limit: [다른 AI로 이어 가기]
   * records the hand-over against it (that turn is not sent again).
   */
  private limitStopped(conversationId: string) {
    const [last] = this.latestRows(conversationId);
    if (!last || last.state !== 'failed') return undefined;
    try {
      const code = (JSON.parse(last.result ?? 'null') as { code?: unknown } | null)?.code;
      return code === 'PROVIDER_LIMIT' ? last.id : undefined;
    } catch {
      return undefined;
    }
  }
  /**
   * [새 세션으로 이어가기] on the length suggestion (SPEC-02.19 5): the active session is left and
   * the next turn opens a new one on the same service with the ledger and hand-over.
   */
  renew(projectId: string, conversationId: string) {
    const conversation = this.store.get(projectId, conversationId);
    if (conversation.state !== 'open') throw new DomainError('CONVERSATION_CLOSED');
    const active = this.store.sessions(conversationId, 'active');
    if (!active.length) throw new DomainError('NO_ACTIVE_SESSION');
    for (const session of active) this.store.setSessionState(session, 'handed-off');
    const last = active.at(-1)!;
    this.store.addLedgerItem(conversationId, {
      kind: 'handoff',
      body: {
        reason: 'length',
        confirmed: 'T1',
        turns: last.turns,
        inputTokens: last.inputTokens,
        from: sessionKey(last),
      },
    });
    this.options.diagnostics?.write('conversation-handover', {
      conversationId,
      reason: 'length',
      provider: conversation.provider,
    });
    return this.summarize(this.store.get(projectId, conversationId));
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
    const opened = await this.openTurn(request, options);
    if (!opened) return opened;
    // A reference board's data comes with the turn (SPEC-09.4, T-090).
    let reference: ReferenceTurn | undefined;
    try {
      reference = this.options.reference?.(request);
    } catch {
      reference = undefined;
    }
    const turn = reference ? { ...opened, items: [...opened.items, reference.item] } : opened;
    // A turn without the host (and not a jig review with its own format) asks for structured
    // output: done, progress or at most three question cards (PLAN-24 T-062).
    if (request.input.jig !== undefined || hostUse(request.input) !== 'none')
      return reference?.output === 'optional' && reference.attachmentId
        ? { ...turn, referenceBlock: true, referenceBoard: reference.attachmentId }
        : turn;
    const ledger = this.store.ledger(turn.conversation.id, { current: true });
    return {
      ...turn,
      structured: true,
      askedQuestions: askedQuestions(ledger),
      items: [...turn.items, turnOutputItem(reference?.output)],
      ...(reference?.output ? { reference: reference.output } : {}),
      ...(reference?.attachmentId ? { referenceBoard: reference.attachmentId } : {}),
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
    // Every turn runs on the CLI's default login (ADR-025). A session an older VIDE opened on one
    // of its own account profiles is not resumed: the next turn opens a new one ('account').
    const accountProfileId = 'default';
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
    if (active && active.provider === provider && active.accountProfileId === accountProfileId) {
      // Past the length setting the session goes on; a new one is only suggested (lengthHandover).
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
    let reason: NewSessionReason = !previous
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
              : previous.state === 'handed-off' && lastHandoffReason(all()) === 'length'
                ? 'length'
                : 'closed';
    if (active) this.store.setSessionState(active, 'handed-off');
    const key = { conversationId, provider, accountProfileId, sessionId: randomUUID() };
    const version = await cliVersion();
    // Codex names its thread itself: the row is added when the opening turn reports it.
    const pending = provider === 'codex-cli' ? { cliVersion: version } : undefined;
    if (!pending) this.store.addSession({ ...key, promptMode: 'neutral', cliVersion: version });
    const items: TurnItem[] = [ledgerItem(all(), 'all')];
    if (previous) {
      items.push(handoffItem(reason, own));
      const { sessionId: _placeholder, ...opening } = key;
      this.store.addLedgerItem(conversationId, {
        kind: 'handoff',
        requestId: request.id,
        body: { reason, from: sessionKey(previous), to: pending ? opening : key },
      });
    } else {
      // A conversation's first session: what it continues (another model's conversation, or the
      // default conversation's requests from before it was one) comes over as a hand-over.
      const source = this.firstSessionSource(conversation, others);
      if (source) {
        reason = source.reason;
        items.push(handoffItem(source.reason, source.rows, source.from));
      }
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
  private firstSessionSource(
    conversation: Conversation,
    rows: StoredWork[],
  ): { reason: NewSessionReason; rows: StoredWork[]; from?: Record<string, unknown> } | undefined {
    const moved = this.store
      .ledger(conversation.id, { current: true })
      .find(
        (item) =>
          item.kind === 'handoff' && (item.body as { reason?: unknown } | null)?.reason === 'model',
      );
    const from = (moved?.body as { from?: Record<string, unknown> } | undefined)?.from;
    if (typeof from?.conversationId === 'string') {
      const source = from.conversationId;
      const ledger = this.store
        .ledger(source, { current: true })
        .filter(
          (item) =>
            item.kind !== 'handoff' &&
            (item.body as { aiChoice?: unknown } | null)?.aiChoice === undefined,
        );
      return {
        reason: 'model',
        rows: rows.filter((row) => row.input.conversationId === source && !isChildRow(row)),
        from: {
          title: from.title,
          provider: from.provider,
          model: from.model,
          ledger: ledgerItem(ledger, 'all').data,
        },
      };
    }
    if (conversation.id !== defaultConversationId(conversation.projectId)) return;
    const earlier = rows.filter((row) => {
      const input = row.input as Record<string, unknown>;
      return (
        input.conversationId === undefined &&
        !isChildRow(row) &&
        typeof input.body === 'string' &&
        !!input.body.trim() &&
        input.source === undefined &&
        input.jig === undefined
      );
    });
    return earlier.some((row) => row.state === 'succeeded')
      ? { reason: 'first', rows: earlier }
      : undefined;
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
    return { conversation, body: formatAnswers(answers), items, askedIn: input.requestId };
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
    // A session of one of VIDE's former account profiles lived in that profile's folder, which
    // VIDE no longer manages (ADR-025): nothing of it is touched here.
    if (session.accountProfileId !== 'default') return 0;
    try {
      return await (this.options.removeTranscript ?? removeTranscript)(
        session.provider as Provider,
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

/** Why the conversation's latest hand-over happened (a confirmed length suggestion: 'length'). */
const lastHandoffReason = (items: LedgerItem[]) =>
  (items.filter((item) => item.kind === 'handoff').at(-1)?.body as { reason?: unknown } | undefined)
    ?.reason;
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
const isChildRow = (row: StoredWork) =>
  !!(row.input as { parentRequestId?: unknown }).parentRequestId;
function handoffItem(
  reason: NewSessionReason,
  own: StoredWork[],
  from?: Record<string, unknown>,
): TurnItem {
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
      note:
        reason === 'model'
          ? 'This conversation continues another one that used a different model. `from.ledger` holds its decisions, assumptions, questions and results; its most recent turns follow.'
          : reason === 'first'
            ? 'This conversation continues the earlier requests of this project; the most recent ones follow.'
            : 'This is a new session of the same conversation. The ledger item holds every decision, assumption, question and result so far; the most recent turns follow.',
      ...(from ? { from } : {}),
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
  /** Submits a request (the answer turn) the way `POST …/requests` does; returns it. */
  submit?: (
    projectId: string,
    input: Record<string, unknown>,
    /** The request whose question is answered: the answer turn keeps its Plan/Auto mode. */
    askedIn?: string,
  ) => Promise<unknown>;
}

/** Answers `/api/v1/projects/:id/conversations…`; false when the request is not one. */
export async function conversationRoutes(
  url: URL,
  request: IncomingMessage,
  { service, body, send, remote, chooseModel, submit }: ConversationRouteContext,
): Promise<boolean> {
  // The conversation length setting (SPEC-02.19 5): changed only on this computer.
  if (url.pathname === '/api/v1/settings/conversations') {
    if (request.method === 'GET') send(200, service.limits());
    else if (request.method === 'PUT') {
      if (remote) throw new DomainError('FORBIDDEN');
      send(200, service.saveLimits(await body(request)));
    } else return false;
    return true;
  }
  const route =
    /^\/api\/v1\/projects\/([^/]+)\/conversations(?:\/([^/]+)(?:\/(close|reopen|ledger|handoff|answer|renew|bind))?)?$/.exec(
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
        jigInstanceId: input.jigInstanceId,
        draftId: input.draftId,
        targets: input.targets,
        // Jev had no request to read: the first turn chooses service and model (SPEC-02.19 2).
        pending: automatic && !input.body?.trim(),
      }),
    );
    return true;
  }
  if (!action) {
    if (request.method !== 'GET') return false;
    send(200, service.get(projectId, rawId === DEFAULT_KEY ? null : rawId));
    return true;
  }
  if (request.method !== 'POST') return false;
  // The default conversation has a session, ledger and hand-over once its first turn fixed it.
  const conversationId =
    rawId === DEFAULT_KEY ? (service.defaultRow(projectId)?.id ?? null) : rawId;
  if (conversationId === null) throw new DomainError('INVALID_INPUT');
  if (action === 'close') {
    const input = closeInput.parse(await body(request));
    send(200, await service.close(projectId, conversationId, { discard: input.discard }));
  } else if (action === 'reopen') send(200, service.reopen(projectId, conversationId));
  else if (action === 'renew') send(200, service.renew(projectId, conversationId));
  else if (action === 'bind') {
    // A jig started from a request works in this conversation (RESEARCH-12 §6.3 startSkill).
    const { jigInstanceId } = z
      .object({ jigInstanceId: id })
      .strict()
      .parse(await body(request));
    send(200, service.bind(projectId, conversationId, jigInstanceId));
  } else if (action === 'ledger')
    send(201, service.addLedger(projectId, conversationId, await body(request)));
  else if (action === 'answer') {
    // The answers go as the next turn of the same conversation (SPEC-02.19 6).
    if (!submit) throw new DomainError('EXECUTOR_NOT_READY');
    const next = randomUUID();
    const answered = service.answer(projectId, conversationId, await body(request), next);
    try {
      // `permission: 'review'` (Plan) is the fallback; submit sets the asked turn's mode.
      const created = await submit(
        projectId,
        {
          id: next,
          conversationId,
          body: answered.body,
          permission: 'review',
          hostUse: 'none',
          provider: answered.conversation.provider,
          pins: [],
          sketches: [],
          files: [],
        },
        answered.askedIn,
      );
      send(201, { request: created, answers: answered.items });
    } catch (error) {
      service.withdraw(conversationId, answered.items);
      throw error;
    }
  } else {
    if (remote) throw new DomainError('FORBIDDEN');
    const input = handoffInput.parse(await body(request));
    send(200, service.handoffTo(projectId, conversationId, input));
  }
  return true;
}
