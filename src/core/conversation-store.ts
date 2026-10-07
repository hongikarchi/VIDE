import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DomainError, type Store } from './store.ts';

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
  // 법규 Q&A (SPEC-13.2): the project's legal conversation, where Jev sends legal questions.
  'legal',
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
  private readonly source: DatabaseSync | Store;
  private readonly conversationDbs = new Map<string, DatabaseSync>();
  /** One DB (tests, a single file), or a Store: each project's conversations live in its own DB. */
  constructor(source: DatabaseSync | Store) {
    this.source = source;
  }
  private of(projectId: string) {
    return this.source instanceof DatabaseSync ? this.source : this.source.db(projectId);
  }
  /** The DB of the project a conversation belongs to (conversation ids are unique across projects). */
  private ofConversation(conversationId: string) {
    const source = this.source;
    if (source instanceof DatabaseSync) return source;
    let db = this.conversationDbs.get(conversationId);
    if (!db || !source.databases().includes(db)) {
      db = source.findDb('SELECT 1 FROM conversations WHERE id=?', conversationId);
      if (!db) return source.app; // No such conversation: reads find nothing, writes fail.
      this.conversationDbs.set(conversationId, db);
    }
    return db;
  }

  /** `row` names the conversation (the project's default one has a fixed ID); else a new UUID. */
  create(projectId: string, value: NewConversation, row: string = randomUUID()): Conversation {
    const input = newConversation.parse(value);
    const now = new Date().toISOString();
    id.parse(row);
    this.of(projectId)
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
    const row = this.of(projectId)
      .prepare('SELECT * FROM conversations WHERE projectId=? AND id=?')
      .get(projectId, conversationId) as unknown as ConversationRow | undefined;
    if (!row) throw new DomainError('NOT_FOUND');
    return toConversation(row);
  }
  list(projectId: string, state?: Conversation['state']): Conversation[] {
    const rows = (state
      ? this.of(projectId)
          .prepare('SELECT * FROM conversations WHERE projectId=? AND state=? ORDER BY createdAt')
          .all(projectId, state)
      : this.of(projectId)
          .prepare('SELECT * FROM conversations WHERE projectId=? ORDER BY createdAt')
          .all(projectId)) as unknown as ConversationRow[];
    return rows.map(toConversation);
  }
  /** Closed conversations of every project whose `closedAt` is before `at` (transcript retention). */
  closedBefore(at: string): Conversation[] {
    const dbs = this.source instanceof DatabaseSync ? [this.source] : this.source.databases();
    return dbs
      .flatMap(
        (db) =>
          db
            .prepare(
              "SELECT * FROM conversations WHERE state='closed' AND closedAt<? ORDER BY closedAt",
            )
            .all(at) as unknown as ConversationRow[],
      )
      .map(toConversation)
      .sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''));
  }
  update(projectId: string, conversationId: string, value: ConversationPatch): Conversation {
    const patch = conversationPatch.parse(value);
    this.get(projectId, conversationId);
    const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (fields.length)
      this.of(projectId)
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
    this.of(projectId)
      .prepare('UPDATE conversations SET state=?,closedAt=?,updatedAt=? WHERE projectId=? AND id=?')
      .run(state, state === 'closed' ? now : null, now, projectId, conversationId);
    return this.get(projectId, conversationId);
  }
  /** Request IDs of one conversation in submission order; `null` is the project's default one. */
  requestIds(projectId: string, conversationId: string | null): string[] {
    return this.of(projectId)
      .prepare(
        'SELECT id FROM workspace_requests WHERE projectId=? AND conversationId IS ? ORDER BY rowid',
      )
      .all(projectId, conversationId)
      .map((row) => String(row.id));
  }

  addSession(value: z.input<typeof newSession>): ProviderSession {
    const input = newSession.parse(value);
    this.ofConversation(input.conversationId)
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
    const row = this.ofConversation(k.conversationId)
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
        ? this.ofConversation(conversationId)
            .prepare(
              'SELECT * FROM provider_sessions WHERE conversationId=? AND state=? ORDER BY rowid',
            )
            .all(conversationId, state)
        : this.ofConversation(conversationId)
            .prepare('SELECT * FROM provider_sessions WHERE conversationId=? ORDER BY rowid')
            .all(conversationId)
    ).map((row) => ({ ...row }) as unknown as ProviderSession);
  }
  /** Counts one finished turn and its input tokens. */
  recordTurn(key: ProviderSessionKey, inputTokens: number, at = new Date().toISOString()) {
    const k = sessionKey.parse(key);
    this.session(k);
    this.ofConversation(k.conversationId)
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
    this.ofConversation(k.conversationId)
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
    this.ofConversation(conversationId)
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
    const row = this.ofConversation(conversationId)
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
      this.ofConversation(conversationId)
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
    this.ofConversation(conversationId)
      .prepare('UPDATE ledger_items SET supersededBy=? WHERE conversationId=? AND id=?')
      .run(by, conversationId, itemId);
    return this.ledgerItem(conversationId, itemId);
  }
}
