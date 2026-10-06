import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_CONVERSATION,
  mirrorDocSchema,
  mirrorMarkdown,
  mirrorStateLabel,
  shareableRequest,
  type MirrorDoc,
  type MirroredConversation,
  type MirroredRequest,
  type MirroredThread,
} from '../contracts/conversation-mirror.ts';
import type { DocumentLinks } from '../core/document-links.ts';
import { DomainError, type Store } from '../core/store.ts';

/**
 * Conversation records through the account site (ADR-037 4, SPEC-04.12, PLAN-36).
 *
 * Upload: this PC is the origin of the requests it ran. Per project (while its "할 일·대화 기록을
 * 사이트에 올리기" switch is on, offline-view.ts) the hostless requests (`shareableRequest`: the
 * user's 2026-10-06 adjustment keeps modeling conversations on the PC) go to the site as text:
 * request text, full answer, activity lines, executed code, file names. Incremental: a request is
 * sent again only when its state or stored size changed since the last upload, in batches of about
 * 1 MB and 8 requests (one call stays near D1's 50 queries per Worker call on the free plan); what was sent is recorded after each batch (conversation-mirror.json), so a restart or a
 * failed call resumes where it stopped. A request hidden or deleted here leaves the site with the
 * next upload; turning the switch off removes this PC's rows (retried until the site answers).
 *
 * Read: the other members' records of a project come back with their documents (only the ones
 * changed since the last read) into `projects/<id>/history/` in the data folder: one Markdown file
 * per conversation and a README for the AI (it reads them with its file tools), and
 * `.data/mirror.json` for the read-only view in 작업 이력.
 */
const BATCH_BYTES = 1024 * 1024;
const BATCH_REQUESTS = 8;
const RETRY_MS = 60_000;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
/** Activity kinds whose detail is the AI's own text or code; query and result details may carry
 * model data and are left out. */
const DETAIL_KINDS = new Set(['execute', 'thinking', 'message']);

const projectStateSchema = z.object({
  sent: z.record(z.string(), z.string()).default({}),
  conversations: z.record(z.string(), z.string()).default({}),
  revision: z.number().default(0),
  at: z.number().optional(),
  error: z.object({ code: z.string(), at: z.number() }).optional(),
  /** The switch was turned off and the site has not confirmed the removal yet. */
  removing: z.boolean().optional(),
});
const stateSchema = z.object({
  projects: z.record(z.string(), projectStateSchema).default({}),
});
type ProjectState = z.infer<typeof projectStateSchema>;

const remoteRequestSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    originHost: z.string(),
    state: z.string(),
    createdAt: z.string(),
    endedAt: z.string().nullable(),
    revision: z.number(),
    files: z.array(z.string()),
    storedAt: z.number(),
  })
  .and(mirrorDocSchema.partial());
const remoteConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  originHost: z.string(),
  originName: z.string(),
  originPc: z.string().nullable(),
  requests: z.number(),
  lastAt: z.string().nullable(),
});
const remoteSchema = z.object({
  at: z.number(),
  conversations: z.array(remoteConversationSchema),
  requests: z.array(remoteRequestSchema),
});
const copySchema = z.object({
  since: z.number(),
  at: z.number(),
  conversations: z.array(remoteConversationSchema),
  requests: z.record(
    z.string(),
    z.object({
      id: z.string(),
      conversationId: z.string(),
      originHost: z.string(),
      state: z.string(),
      createdAt: z.string(),
      endedAt: z.string().nullable(),
      revision: z.number(),
      storedAt: z.number(),
      doc: mirrorDocSchema,
    }),
  ),
});
type Copy = z.infer<typeof copySchema>;

interface Remote {
  hostId: string | undefined;
  deviceFetch(path: string, method?: string, data?: unknown): Promise<Response | undefined>;
}
interface Options {
  /** Where the upload record and the copies live (the data folder); none in memory-only runs. */
  directory?: string;
  store: Store;
  links: DocumentLinks;
  remote: Remote;
  now?: () => number;
  batchBytes?: number;
}
interface Candidate {
  id: string;
  conversationId: string;
  fingerprint: string;
}

const fail = (code: string) => new DomainError(code);
const fileName = (conversation: { originHost: string; id: string }) =>
  `${conversation.originHost.slice(0, 8)}-${conversation.id}.md`;
const when = (value: string | null) => (value ? value.slice(0, 16).replace('T', ' ') : '');

export class ConversationMirror {
  private state = stateSchema.parse({});
  private loaded: Promise<void> | undefined;
  private options: Options;
  private reading = new Map<string, Promise<unknown>>();
  /** When each project's requests were last compared (at most once a minute unless forced). */
  private checked = new Map<string, number>();
  constructor(options: Options) {
    this.options = options;
  }
  private get now() {
    return this.options.now?.() ?? Date.now();
  }
  private get file() {
    return this.options.directory
      ? join(this.options.directory, 'conversation-mirror.json')
      : undefined;
  }
  private load() {
    return (this.loaded ??= (async () => {
      if (!this.file) return;
      try {
        this.state = stateSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
      } catch {
        /* First use or an unreadable record: everything is sent again (the site replaces it). */
      }
    })());
  }
  private async save() {
    if (!this.file) return;
    await writeFile(this.file + '.tmp', JSON.stringify(this.state));
    await rename(this.file + '.tmp', this.file);
  }
  private async device(path: string, method = 'GET', data?: unknown) {
    let response: Response | undefined;
    try {
      response = await this.options.remote.deviceFetch(path, method, data);
    } catch {
      throw fail('SITE_UNREACHABLE');
    }
    if (!response) throw fail('ACCOUNT_NOT_LINKED');
    const value = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (!response.ok)
      throw fail(
        typeof value.error === 'string' && /^[A-Z_]{2,64}$/.test(value.error)
          ? value.error
          : 'SITE_ERROR',
      );
    return value;
  }
  private base(projectId: string) {
    if (!PROJECT_ID.test(projectId)) throw fail('NOT_FOUND');
    return `/projects/${encodeURIComponent(projectId)}/conversations`;
  }

  /** What this PC has sent of the project (for the switch's status line). */
  async status(projectId: string) {
    await this.load();
    const own = this.state.projects[projectId];
    return {
      shared: own ? Object.keys(own.sent).length : 0,
      at: own?.at ? new Date(own.at).toISOString() : null,
      error: own?.error?.code ?? null,
      removing: !!own?.removing,
    };
  }

  // ── Upload ──────────────────────────────────────────────────────────────────────────────────
  /** The project's shareable requests with a cheap fingerprint each (state and stored sizes). */
  private candidates(projectId: string): Candidate[] {
    const rows = this.options.store
      .db(projectId)
      .prepare(
        `SELECT w.id, w.state, length(w.input) AS li, coalesce(length(w.result),0) AS lr,
          json_extract(w.input,'$.conversationId') AS conversationId,
          json_extract(w.input,'$.source') AS source,
          json_extract(w.input,'$.provider') AS provider,
          json_type(w.input,'$.jig') AS jig,
          json_type(w.input,'$.sourceDocument') AS sourceDocument,
          json_extract(w.input,'$.linkId') AS linkId,
          json_extract(w.input,'$.baseRequestId') AS baseRequestId,
          json_type(w.input,'$.linkedTargets') AS linkedTargets,
          json_extract(w.input,'$.applyToSource') AS applyToSource,
          json_extract(w.input,'$.parentRequestId') AS parentRequestId,
          coalesce(json_array_length(w.result,'$.executions'),0) AS executions,
          json_type(w.result,'$.sourceDocument') AS resultDocument,
          json_extract(w.result,'$.baseRequestId') AS resultBase,
          json_extract(w.result,'$.hostExecuted') AS hostExecuted
         FROM workspace_requests w
         WHERE w.projectId=? AND json_extract(w.input,'$.hostUse')='none'
           AND w.id NOT IN (SELECT requestId FROM hidden_requests WHERE projectId=?)
         ORDER BY w.rowid`,
      )
      .all(projectId, projectId) as Record<string, unknown>[];
    const present = (value: unknown) => (value === null || value === undefined ? undefined : value);
    return rows
      .filter((row) =>
        shareableRequest(
          {
            hostUse: 'none',
            source: present(row.source),
            provider: present(row.provider),
            jig: present(row.jig),
            sourceDocument: present(row.sourceDocument),
            linkId: present(row.linkId),
            baseRequestId: present(row.baseRequestId),
            linkedTargets: present(row.linkedTargets),
            applyToSource: row.applyToSource === 1,
            parentRequestId: present(row.parentRequestId),
          },
          {
            executions: Array.from({ length: Number(row.executions) || 0 }),
            sourceDocument: present(row.resultDocument),
            baseRequestId: present(row.resultBase),
            hostExecuted: row.hostExecuted === 1,
          },
        ),
      )
      .map((row) => ({
        id: String(row.id),
        conversationId:
          typeof row.conversationId === 'string' ? row.conversationId : DEFAULT_CONVERSATION,
        fingerprint: `${String(row.state)}|${Number(row.li)}|${Number(row.lr)}`,
      }));
  }
  /** One request's shared document (exactly the fields of `mirrorDocSchema`). */
  private document(projectId: string, id: string) {
    const row = this.options.store
      .db(projectId)
      .prepare(
        'SELECT state, createdAt, input, result FROM workspace_requests WHERE projectId=? AND id=?',
      )
      .get(projectId, id) as
      | { state: string; createdAt: string; input: string; result: string | null }
      | undefined;
    if (!row) return undefined;
    const input = JSON.parse(row.input) as { body?: unknown; files?: unknown };
    const result = (row.result ? JSON.parse(row.result) : {}) as {
      text?: unknown;
      activity?: unknown;
      executions?: unknown;
      endedAt?: unknown;
    };
    const files = new Set<string>();
    if (Array.isArray(input.files))
      for (const file of input.files)
        if (
          file &&
          typeof file === 'object' &&
          typeof (file as { name?: unknown }).name === 'string'
        )
          files.add((file as { name: string }).name);
    const doc: MirrorDoc = {
      body: typeof input.body === 'string' ? input.body : '',
      answer: typeof result.text === 'string' ? result.text : null,
      activity: (Array.isArray(result.activity) ? result.activity : []).flatMap((entry) => {
        const value = entry as { at?: unknown; kind?: unknown; text?: unknown; detail?: unknown };
        if (typeof value?.text !== 'string' || typeof value.kind !== 'string') return [];
        return [
          {
            at: typeof value.at === 'string' ? value.at.slice(0, 40) : '',
            kind: value.kind.slice(0, 20),
            text: value.text,
            ...(typeof value.detail === 'string' && DETAIL_KINDS.has(value.kind)
              ? { detail: value.detail }
              : {}),
          },
        ];
      }),
      executions: (Array.isArray(result.executions) ? result.executions : []).flatMap((entry) => {
        const value = entry as {
          label?: unknown;
          state?: unknown;
          at?: unknown;
          file?: { name?: unknown } | null;
          language?: unknown;
          body?: unknown;
          code?: unknown;
        };
        if (!value || typeof value !== 'object') return [];
        const code =
          typeof value.body === 'string'
            ? value.body
            : typeof value.code === 'string'
              ? value.code
              : null;
        return [
          {
            label: typeof value.label === 'string' ? value.label : '실행',
            state: typeof value.state === 'string' ? value.state.slice(0, 20) : 'applied',
            at: typeof value.at === 'string' ? value.at.slice(0, 40) : null,
            file: typeof value.file?.name === 'string' ? value.file.name : null,
            language: typeof value.language === 'string' ? value.language.slice(0, 20) : null,
            code,
          },
        ];
      }),
      files: [...files],
    };
    for (const execution of doc.executions) if (execution.file) files.add(execution.file);
    doc.files = [...files];
    return {
      state: /^[a-z-]{1,30}$/.test(row.state) ? row.state : 'unknown',
      createdAt: row.createdAt,
      endedAt: typeof result.endedAt === 'string' ? result.endedAt.slice(0, 40) : null,
      doc,
    };
  }
  private conversationRows(projectId: string, ids: string[]) {
    const store = this.options.store.db(projectId);
    const read = store.prepare(
      'SELECT id, kind, title, provider, model, createdAt, updatedAt FROM conversations WHERE projectId=? AND id=?',
    );
    const times = store.prepare(
      'SELECT min(createdAt) AS first, max(createdAt) AS last FROM workspace_requests WHERE projectId=? AND conversationId IS NULL',
    );
    return ids.map((id) => {
      if (id === DEFAULT_CONVERSATION) {
        const span = times.get(projectId) as { first: string | null; last: string | null };
        const at = new Date(this.now).toISOString();
        return {
          id,
          title: '기본 대화',
          kind: 'default',
          provider: null,
          model: null,
          createdAt: span.first ?? at,
          updatedAt: span.last ?? at,
        };
      }
      const row = read.get(projectId, id) as
        | {
            id: string;
            kind: string;
            title: string;
            provider: string | null;
            model: string | null;
            createdAt: string;
            updatedAt: string;
          }
        | undefined;
      const at = new Date(this.now).toISOString();
      return {
        id,
        title: (row?.title ?? '대화').slice(0, 500),
        kind: (row?.kind ?? 'session').slice(0, 40),
        provider: row?.provider?.slice(0, 40) ?? null,
        model: row?.model?.slice(0, 120) ?? null,
        createdAt: row?.createdAt ?? at,
        updatedAt: row?.updatedAt ?? row?.createdAt ?? at,
      };
    });
  }

  /**
   * Sends what changed since the last upload of the project (incremental, batched). Returns an
   * error code or undefined. A failed batch is tried again a minute later (`force` skips the wait).
   */
  async upload(projectId: string, force = false): Promise<string | undefined> {
    await this.load();
    if (!this.options.remote.hostId) return 'ACCOUNT_NOT_LINKED';
    const own = (this.state.projects[projectId] ??= projectStateSchema.parse({}));
    if (own.removing) {
      // The switch was turned on again before the removal reached the site: start over.
      own.removing = false;
      own.sent = {};
      own.conversations = {};
    }
    if (!force && own.error && this.now - own.error.at < RETRY_MS) return own.error.code;
    if (!force && this.now - (this.checked.get(projectId) ?? -Infinity) < RETRY_MS) return;
    this.checked.set(projectId, this.now);
    let list: Candidate[];
    try {
      list = this.candidates(projectId);
    } catch {
      return 'MIRROR_READ_FAILED';
    }
    const current = new Set(list.map((item) => item.id));
    const changed = list.filter((item) => own.sent[item.id] !== item.fingerprint);
    const removed = Object.keys(own.sent).filter((id) => !current.has(id));
    const conversationIds = [...new Set(list.map((item) => item.conversationId))];
    const conversationRows = this.conversationRows(projectId, conversationIds);
    const conversationKey = (row: (typeof conversationRows)[number]) =>
      `${row.title}|${row.kind}|${row.updatedAt}`;
    const staleConversations = conversationRows.filter(
      (row) => own.conversations[row.id] !== conversationKey(row),
    );
    if (!changed.length && !removed.length && !staleConversations.length) return undefined;
    const limit = this.options.batchBytes ?? BATCH_BYTES;
    // Batches: each carries the rows of its requests' conversations (and the changed ones).
    let index = 0;
    let first = true;
    try {
      while (first || index < changed.length) {
        const batch: { meta: Candidate; upload: Record<string, unknown> }[] = [];
        let bytes = 0;
        while (index < changed.length && batch.length < BATCH_REQUESTS) {
          const item = changed[index];
          const read = this.document(projectId, item.id);
          if (!read) {
            index++;
            continue;
          }
          const doc = JSON.stringify(read.doc);
          if (batch.length && bytes + doc.length > limit) break;
          bytes += doc.length;
          batch.push({
            meta: item,
            upload: {
              id: item.id,
              conversationId: item.conversationId,
              state: read.state,
              createdAt: read.createdAt,
              endedAt: read.endedAt,
              revision: own.revision + 1,
              doc,
            },
          });
          index++;
        }
        const named = new Set(batch.map((entry) => entry.meta.conversationId));
        const conversations = conversationRows.filter(
          (row) => named.has(row.id) || (first && staleConversations.includes(row)),
        );
        await this.device(this.base(projectId), 'PUT', {
          conversations,
          requests: batch.map((entry) => entry.upload),
          ...(first ? { removed } : {}),
        });
        own.revision++;
        for (const entry of batch) own.sent[entry.meta.id] = entry.meta.fingerprint;
        for (const row of conversations) own.conversations[row.id] = conversationKey(row);
        if (first) for (const id of removed) delete own.sent[id];
        first = false;
        own.at = this.now;
        delete own.error;
        // Recorded after every batch: a restart sends only what is left.
        await this.save();
      }
      return undefined;
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'MIRROR_UPLOAD_FAILED';
      own.error = { code, at: this.now };
      await this.save();
      return code;
    }
  }

  /** The switch is off: this PC's rows leave the site (retried until it answers). */
  async remove(projectId: string) {
    await this.load();
    const own = (this.state.projects[projectId] ??= projectStateSchema.parse({}));
    own.removing = true;
    own.sent = {};
    own.conversations = {};
    await this.save();
    return this.retryRemoval(projectId);
  }
  private async retryRemoval(projectId: string) {
    try {
      await this.device(this.base(projectId), 'DELETE');
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'SITE_UNREACHABLE';
      // A project the site does not have (or no account) has nothing there to remove.
      if (!['PROJECT_NOT_FOUND', 'ACCOUNT_NOT_LINKED'].includes(code)) return false;
    }
    delete this.state.projects[projectId];
    await this.save();
    return true;
  }
  /** Removals the site has not confirmed yet (each heartbeat). */
  async pendingRemovals() {
    await this.load();
    for (const [projectId, own] of Object.entries(this.state.projects))
      if (own.removing) await this.retryRemoval(projectId);
  }
  // ── Other members' records ──────────────────────────────────────────────────────────────────
  private folder(projectId: string) {
    const data = this.options.directory;
    if (!data || !PROJECT_ID.test(projectId)) throw fail('NOT_FOUND');
    return join(data, 'projects', projectId, 'history');
  }
  private async copy(projectId: string): Promise<Copy | undefined> {
    try {
      return copySchema.parse(
        JSON.parse(await readFile(join(this.folder(projectId), '.data', 'mirror.json'), 'utf8')),
      );
    } catch {
      return undefined;
    }
  }
  private async write(path: string, text: string) {
    await writeFile(path + '.tmp', text, 'utf8');
    await rename(path + '.tmp', path);
  }
  private threadOf(copy: Copy, conversation: MirroredConversation): MirroredThread {
    const requests = Object.values(copy.requests)
      .filter(
        (request) =>
          request.originHost === conversation.originHost &&
          request.conversationId === conversation.id,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(
        (request): MirroredRequest => ({
          id: request.id,
          conversationId: request.conversationId,
          state: request.state,
          createdAt: request.createdAt,
          endedAt: request.endedAt,
          revision: request.revision,
          ...request.doc,
        }),
      );
    return { conversation, requests };
  }
  /** Writes the Markdown copies, their README and the view's data; drops removed ones. */
  private async mirror(projectId: string, copy: Copy) {
    const folder = this.folder(projectId);
    await mkdir(join(folder, '.data'), { recursive: true });
    await this.write(join(folder, '.data', 'mirror.json'), JSON.stringify(copy));
    const keep = new Set(['README.md']);
    const listed = copy.conversations.filter((conversation) =>
      Object.values(copy.requests).some(
        (request) =>
          request.originHost === conversation.originHost &&
          request.conversationId === conversation.id,
      ),
    );
    for (const conversation of listed) {
      const name = fileName(conversation);
      keep.add(name);
      await this.write(join(folder, name), mirrorMarkdown(this.threadOf(copy, conversation)));
    }
    await this.write(
      join(folder, 'README.md'),
      '# 다른 구성원의 대화 기록\n\n' +
        '이 프로젝트의 다른 구성원(다른 PC)이 VIDE에서 한 요청·AI 답·활동·실행 코드의 사본이다. ' +
        '호스트 문서 없이 한 대화만 올라오며(모델링 대화는 그 PC에만 남는다), 원본은 그 작업을 돌린 PC다. ' +
        'VIDE가 계정 사이트에서 받아 다시 쓴다(직접 고쳐도 반영되지 않는다).\n\n' +
        '| 대화 | 누가 · 어느 PC | 요청 수 | 마지막 | 파일 |\n|---|---|---|---|---|\n' +
        listed
          .map(
            (conversation) =>
              `| ${conversation.title.replace(/\|/g, '/')} | ${conversation.originName}${conversation.originPc ? ` · ${conversation.originPc}` : ''} | ${conversation.requests} | ${when(conversation.lastAt)} | ${fileName(conversation)} |`,
          )
          .join('\n') +
        '\n',
    );
    for (const name of await readdir(folder).catch(() => [] as string[]))
      if (name.endsWith('.md') && !keep.has(name)) await unlink(join(folder, name)).catch(() => {});
  }
  /**
   * Reads the other members' records from the site (documents changed since the last read) and
   * refreshes the local copy. One read per project at a time.
   */
  refresh(projectId: string): Promise<Copy> {
    const running = this.reading.get(projectId) as Promise<Copy> | undefined;
    if (running) return running;
    const work = (async () => {
      const before = await this.copy(projectId);
      const since = before?.since ?? 0;
      const value = remoteSchema.parse(await this.device(`${this.base(projectId)}?since=${since}`));
      const requests: Copy['requests'] = {};
      for (const request of value.requests) {
        const doc = mirrorDocSchema.safeParse(request).data ?? before?.requests[request.id]?.doc;
        if (!doc) continue; // Not sent this time and not here before: next full read brings it.
        requests[request.id] = {
          id: request.id,
          conversationId: request.conversationId,
          originHost: request.originHost,
          state: request.state,
          createdAt: request.createdAt,
          endedAt: request.endedAt,
          revision: request.revision,
          storedAt: request.storedAt,
          doc,
        };
      }
      // A document missing locally (an earlier failed write) is read again on the next call.
      const missing = value.requests.some((request) => !requests[request.id]);
      const copy: Copy = {
        since: missing ? 0 : value.at,
        at: this.now,
        conversations: value.conversations,
        requests,
      };
      await this.mirror(projectId, copy);
      return copy;
    })().finally(() => this.reading.delete(projectId));
    this.reading.set(projectId, work);
    return work;
  }
  private listOf(copy: Copy | undefined) {
    if (!copy) return [];
    return copy.conversations
      .map((conversation) => {
        const thread = this.threadOf(copy, conversation);
        const last = thread.requests.at(-1);
        return {
          ...conversation,
          requests: thread.requests.length,
          lastAt: last?.createdAt ?? conversation.lastAt,
          preview: last ? last.body.replace(/\s+/g, ' ').slice(0, 160) : '',
          lastState: last ? mirrorStateLabel(last.state) : '',
        };
      })
      .filter((conversation) => conversation.requests > 0)
      .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  }
  /**
   * The other members' conversations for 작업 이력: fresh from the site, or the last copy with
   * `online: false` when the site cannot be reached.
   */
  async list(projectId: string) {
    this.folder(projectId); // An invalid id (or no data folder) is NOT_FOUND here.
    try {
      const copy = await this.refresh(projectId);
      return { online: true, conversations: this.listOf(copy) };
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'SITE_UNREACHABLE';
      return { online: false, error: code, conversations: this.listOf(await this.copy(projectId)) };
    }
  }
  /** One conversation from the local copy (read-only). */
  async thread(projectId: string, originHost: string, conversationId: string) {
    const copy = await this.copy(projectId);
    const conversation = copy?.conversations.find(
      (row) => row.originHost === originHost && row.id === conversationId,
    );
    if (!copy || !conversation) throw fail('NOT_FOUND');
    return this.threadOf(copy, conversation);
  }
  /** The folder the AI reads (undefined without a data folder). */
  historyFolder(projectId: string) {
    try {
      return this.folder(projectId);
    } catch {
      return undefined;
    }
  }
}
