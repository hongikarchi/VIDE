import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DomainError } from './store.ts';

// Rows of conversations, provider_sessions and ledger_items (ARCH-03 §10.2, schema v5). Data access
// only: when a conversation starts, resumes, hands off or closes is decided by the conversation
// service (PLAN-24 T-061). Callers check the project (`Store.project`) before writing; the schema's
// foreign keys reject rows of a missing project or conversation.

const id = z.string().min(1).max(200);
const name = z.string().max(200);
export const conversationKinds = [
  'general',
  'model-edit',
  'cad-edit',
  'ask',
  'jig-run',
  'jig-make',
  'app',
] as const;
const newConversation = z
  .object({
    kind: z.enum(conversationKinds),
    title: z.string().min(1).max(500),
    provider: z.enum(['claude-cli', 'codex-cli']),
    model: name.nullable().optional(),
    effort: name.nullable().optional(),
    accountProfileId: name.nullable().optional(),
    mode: z.enum(['session', 'ledger']).optional(),
    jigInstanceId: id.nullable().optional(),
    draftId: id.nullable().optional(),
    targets: z.array(id).nullable().optional(),
  })
  .strict();
export type NewConversation = z.input<typeof newConversation>;
const conversationPatch = newConversation
  .pick({
    title: true,
    // The service changes only by hand-over (SPEC-02.19 5), never mid-session.
    provider: true,
    model: true,
    effort: true,
    accountProfileId: true,
    mode: true,
    jigInstanceId: true,
    draftId: true,
    targets: true,
  })
  .partial()
  .strict();
export type ConversationPatch = z.input<typeof conversationPatch>;
export interface Conversation {
  id: string;
  projectId: string;
  kind: (typeof conversationKinds)[number];
  title: string;
  provider: 'claude-cli' | 'codex-cli';
  model: string | null;
  effort: string | null;
  accountProfileId: string | null;
  mode: 'session' | 'ledger';
  jigInstanceId: string | null;
  draftId: string | null;
  /** Linked files the conversation is about (screen filter and suggestions; not an admission rule). */
  targets: string[] | null;
  state: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
type ConversationRow = Omit<Conversation, 'targets'> & { targets: string | null };
const toConversation = (row: ConversationRow): Conversation => ({
  ...row,
  targets: row.targets === null ? null : (JSON.parse(row.targets) as string[]),
});

// A session row or any object holding its four key fields selects it.
const sessionKey = z.object({
  conversationId: id,
  provider: name,
  accountProfileId: name,
  sessionId: id,
});
export type ProviderSessionKey = z.infer<typeof sessionKey>;
const newSession = sessionKey
  .extend({ promptMode: z.enum(['neutral', 'tools', 'no-tools']), cliVersion: name })
  .strict();
export type SessionState = 'active' | 'handed-off' | 'closed' | 'lost';
export interface ProviderSession extends ProviderSessionKey {
  promptMode: 'neutral' | 'tools' | 'no-tools';
  cliVersion: string;
  turns: number;
  inputTokens: number;
  lastTurnAt: string | null;
  state: SessionState;
}

export const ledgerKinds = [
  'assumption',
  'question',
  'answer',
  'decision',
  'code',
  'param-change',
  'result-ref',
  'handoff',
] as const;
const newLedgerItem = z
  .object({ kind: z.enum(ledgerKinds), body: z.unknown(), requestId: id.nullable().optional() })
  .strict();
export interface LedgerItem {
  id: string;
  conversationId: string;
  kind: (typeof ledgerKinds)[number];
  body: unknown;
  requestId: string | null;
  createdAt: string;
  supersededBy: string | null;
}
type LedgerRow = Omit<LedgerItem, 'body'> & { body: string };

export class ConversationStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** `row` names the conversation (the project's default one has a fixed ID); else a new UUID. */
  create(projectId: string, value: NewConversation, row: string = randomUUID()): Conversation {
    const input = newConversation.parse(value);
    const now = new Date().toISOString();
    id.parse(row);
    this.db
      .prepare(
        `INSERT INTO conversations(id,projectId,kind,title,provider,model,effort,accountProfileId,mode,
          jigInstanceId,draftId,targets,state,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`,
      )
      .run(
        row,
        projectId,
        input.kind,
        input.title,
        input.provider,
        input.model ?? null,
        input.effort ?? null,
        input.accountProfileId ?? null,
        input.mode ?? 'session',
        input.jigInstanceId ?? null,
        input.draftId ?? null,
        input.targets ? JSON.stringify(input.targets) : null,
        now,
        now,
      );
    return this.get(projectId, row);
  }
  get(projectId: string, conversationId: string): Conversation {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE projectId=? AND id=?')
      .get(projectId, conversationId) as unknown as ConversationRow | undefined;
    if (!row) throw new DomainError('NOT_FOUND');
    return toConversation(row);
  }
  list(projectId: string, state?: Conversation['state']): Conversation[] {
    const rows = (state
      ? this.db
          .prepare('SELECT * FROM conversations WHERE projectId=? AND state=? ORDER BY createdAt')
          .all(projectId, state)
      : this.db
          .prepare('SELECT * FROM conversations WHERE projectId=? ORDER BY createdAt')
          .all(projectId)) as unknown as ConversationRow[];
    return rows.map(toConversation);
  }
  /** Closed conversations of every project whose `closedAt` is before `at` (transcript retention). */
  closedBefore(at: string): Conversation[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM conversations WHERE state='closed' AND closedAt<? ORDER BY closedAt",
        )
        .all(at) as unknown as ConversationRow[]
    ).map(toConversation);
  }
  update(projectId: string, conversationId: string, value: ConversationPatch): Conversation {
    const patch = conversationPatch.parse(value);
    this.get(projectId, conversationId);
    const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (fields.length)
      this.db
        .prepare(
          `UPDATE conversations SET ${fields.map(([key]) => key + '=?').join(',')},updatedAt=?
            WHERE projectId=? AND id=?`,
        )
        .run(
          ...fields.map(([key, v]) => (key === 'targets' && v ? JSON.stringify(v) : (v as never))),
          new Date().toISOString(),
          projectId,
          conversationId,
        );
    return this.get(projectId, conversationId);
  }
  /** Closing records `closedAt`; reopening clears it. */
  setState(projectId: string, conversationId: string, state: Conversation['state']) {
    this.get(projectId, conversationId);
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE conversations SET state=?,closedAt=?,updatedAt=? WHERE projectId=? AND id=?')
      .run(state, state === 'closed' ? now : null, now, projectId, conversationId);
    return this.get(projectId, conversationId);
  }
  /** Request IDs of one conversation in submission order; `null` is the project's default one. */
  requestIds(projectId: string, conversationId: string | null): string[] {
    return this.db
      .prepare(
        'SELECT id FROM workspace_requests WHERE projectId=? AND conversationId IS ? ORDER BY rowid',
      )
      .all(projectId, conversationId)
      .map((row) => String(row.id));
  }

  addSession(value: z.input<typeof newSession>): ProviderSession {
    const input = newSession.parse(value);
    this.db
      .prepare(
        `INSERT INTO provider_sessions(conversationId,provider,accountProfileId,sessionId,promptMode,
          cliVersion,state) VALUES(?,?,?,?,?,?,'active')`,
      )
      .run(
        input.conversationId,
        input.provider,
        input.accountProfileId,
        input.sessionId,
        input.promptMode,
        input.cliVersion,
      );
    return this.session(input);
  }
  session(key: ProviderSessionKey): ProviderSession {
    const k = sessionKey.parse(key);
    const row = this.db
      .prepare(
        'SELECT * FROM provider_sessions WHERE conversationId=? AND provider=? AND accountProfileId=? AND sessionId=?',
      )
      .get(k.conversationId, k.provider, k.accountProfileId, k.sessionId);
    if (!row) throw new DomainError('NOT_FOUND');
    return { ...row } as unknown as ProviderSession;
  }
  sessions(conversationId: string, state?: SessionState): ProviderSession[] {
    return (
      state
        ? this.db
            .prepare(
              'SELECT * FROM provider_sessions WHERE conversationId=? AND state=? ORDER BY rowid',
            )
            .all(conversationId, state)
        : this.db
            .prepare('SELECT * FROM provider_sessions WHERE conversationId=? ORDER BY rowid')
            .all(conversationId)
    ).map((row) => ({ ...row }) as unknown as ProviderSession);
  }
  /** Counts one finished turn and its input tokens. */
  recordTurn(key: ProviderSessionKey, inputTokens: number, at = new Date().toISOString()) {
    const k = sessionKey.parse(key);
    this.session(k);
    this.db
      .prepare(
        `UPDATE provider_sessions SET turns=turns+1,inputTokens=inputTokens+?,lastTurnAt=?
          WHERE conversationId=? AND provider=? AND accountProfileId=? AND sessionId=?`,
      )
      .run(
        z.number().int().min(0).parse(inputTokens),
        at,
        k.conversationId,
        k.provider,
        k.accountProfileId,
        k.sessionId,
      );
    return this.session(k);
  }
  setSessionState(key: ProviderSessionKey, state: SessionState) {
    const k = sessionKey.parse(key);
    this.session(k);
    this.db
      .prepare(
        `UPDATE provider_sessions SET state=?
          WHERE conversationId=? AND provider=? AND accountProfileId=? AND sessionId=?`,
      )
      .run(
        z.enum(['active', 'handed-off', 'closed', 'lost']).parse(state),
        k.conversationId,
        k.provider,
        k.accountProfileId,
        k.sessionId,
      );
    return this.session(k);
  }

  addLedgerItem(conversationId: string, value: z.input<typeof newLedgerItem>): LedgerItem {
    const input = newLedgerItem.parse(value);
    const row = randomUUID();
    this.db
      .prepare('INSERT INTO ledger_items VALUES(?,?,?,?,?,?,NULL)')
      .run(
        row,
        conversationId,
        input.kind,
        JSON.stringify(input.body ?? null),
        input.requestId ?? null,
        new Date().toISOString(),
      );
    return this.ledgerItem(conversationId, row);
  }
  ledgerItem(conversationId: string, itemId: string): LedgerItem {
    const row = this.db
      .prepare('SELECT * FROM ledger_items WHERE conversationId=? AND id=?')
      .get(conversationId, itemId) as unknown as LedgerRow | undefined;
    if (!row) throw new DomainError('NOT_FOUND');
    return { ...row, body: JSON.parse(row.body) as unknown };
  }
  /** Items in recording order; `current` leaves out superseded ones, `since` those before that time. */
  ledger(
    conversationId: string,
    { current = false, since }: { current?: boolean; since?: string } = {},
  ): LedgerItem[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM ledger_items WHERE conversationId=?${current ? ' AND supersededBy IS NULL' : ''}${since ? ' AND createdAt>=?' : ''}
            ORDER BY createdAt, rowid`,
        )
        .all(...(since ? [conversationId, since] : [conversationId])) as unknown as LedgerRow[]
    ).map((row) => ({ ...row, body: JSON.parse(row.body) as unknown }));
  }
  supersede(conversationId: string, itemId: string, by: string) {
    this.ledgerItem(conversationId, itemId);
    this.ledgerItem(conversationId, by);
    this.db
      .prepare('UPDATE ledger_items SET supersededBy=? WHERE conversationId=? AND id=?')
      .run(by, conversationId, itemId);
    return this.ledgerItem(conversationId, itemId);
  }
}
