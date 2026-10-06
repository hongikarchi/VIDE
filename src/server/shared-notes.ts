import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { z } from 'zod';
import {
  actionItems,
  NOTE_KIND_LABEL,
  NOTE_KINDS,
  noteMarkdown,
  type NoteKind,
} from '../contracts/note-doc.ts';
import { NoteSocket, type NoteSocketStatus } from '../contracts/note-socket.ts';
import { fromBase64, toBase64 } from '../contracts/note-sync.ts';
import { DomainError } from '../core/store.ts';
import { localDate } from '../core/agenda.ts';

/**
 * Shared project notes on the work PC (SPEC-10, ADR-034, ARCH-01 §6 「공유 노트」). The site is
 * the source of truth; this PC is a member through its host key. It
 *  - lists, creates and renames notes through the site's PC routes,
 *  - keeps one live replica per open note: a Yjs document saved under the project's data folder
 *    (`notes/.yjs/<id>.bin`) and connected to the note's Durable Object, so edits made while the
 *    site is unreachable stay here and merge on reconnect (`.pending` marks unsent edits),
 *  - relays the replica to the PC screen over a local stream (`stream`/`receive`),
 *  - writes a Markdown copy of every note (`notes/<id>.md`, `notes/journal-<date>.md`,
 *    `notes/README.md`) inside the project's records folder, which the AI reads with its
 *    built-in Read tool (ADR-031 6),
 *  - sends a 협의 사항 note's open check-list items to the project's 할 일, and appends the day's
 *    summary to the site's journal entry (queued here when the site is unreachable).
 */
const noteSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string(),
    title: z.string(),
    kind: z.enum(NOTE_KINDS),
    journalDate: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    updatedBy: z.string().nullable(),
    updatedByName: z.string().nullable().optional(),
    revision: z.number(),
    snapshot: z.string().optional(),
    excerpt: z.string().optional(),
    deleted: z.boolean().optional(),
  })
  .passthrough();
export type SharedNote = z.infer<typeof noteSchema>;
const listSchema = z.object({ notes: z.array(noteSchema) });
const ticketSchema = z.object({ url: z.string() });
const queuedSchema = z.array(z.object({ date: z.string(), text: z.string() }));

interface Remote {
  site: string | undefined;
  deviceFetch(path: string, method?: string, data?: unknown): Promise<Response | undefined>;
}
interface AgendaPort {
  list(projectId: string): { text: string; done: boolean }[];
  add(projectId: string, value: unknown, source?: 'user' | 'ai'): unknown;
}
interface Options {
  remote: Remote;
  dataDirectory: string | undefined;
  agenda: AgendaPort;
  WebSocket?: typeof WebSocket;
  today?: () => string;
}
type StreamEvent =
  | { type: 'sync'; state: string; vector: string }
  | { type: 'update'; update: string }
  | { type: 'awareness'; update: string }
  | { type: 'status'; status: NoteSocketStatus & { pending: boolean } };
type Listener = (event: StreamEvent) => void;

interface Replica {
  projectId: string;
  noteId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  socket: NoteSocket;
  listeners: Map<string, Listener>;
  /** The awareness client ids each screen sent (never sent back to that screen). */
  own: Map<string, Set<number>>;
  pending: boolean;
  save?: ReturnType<typeof setTimeout>;
  idle?: ReturnType<typeof setTimeout>;
  check?: ReturnType<typeof setInterval>;
  title: string;
  file: string;
}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const NOTE_ID = /^[0-9a-f-]{36}$/i;
const fail = (code: string) => new DomainError(code);
const fileOf = (note: Pick<SharedNote, 'id' | 'kind' | 'journalDate'>) =>
  note.kind === 'journal' && note.journalDate ? `journal-${note.journalDate}.md` : `${note.id}.md`;
const when = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

export class SharedNotes {
  private replicas = new Map<string, Replica>();
  private opening = new Map<string, Promise<Replica>>();
  private options: Options;
  private saving = new Set<Promise<unknown>>();
  constructor(options: Options) {
    this.options = options;
  }
  private folder(projectId: string) {
    const data = this.options.dataDirectory;
    if (!data || !PROJECT_ID.test(projectId)) throw fail('NOT_FOUND');
    return join(data, 'projects', projectId, 'notes');
  }
  /** The folder the AI reads (undefined without a data folder). */
  notesFolder(projectId: string) {
    try {
      return this.folder(projectId);
    } catch {
      return undefined;
    }
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
    return `/projects/${encodeURIComponent(projectId)}/notes`;
  }

  // ── Local copy ──────────────────────────────────────────────────────────────────────────────
  private async write(path: string, text: string | Uint8Array) {
    const task = (async () => {
      await writeFile(path + '.tmp', text, 'utf8');
      await rename(path + '.tmp', path);
    })();
    this.saving.add(task);
    try {
      await task;
    } finally {
      this.saving.delete(task);
    }
  }
  private markdownFile(note: SharedNote, body: string) {
    return (
      `# ${note.title}\n\n` +
      `<!-- VIDE 공유 노트 · ${NOTE_KIND_LABEL[note.kind]} · id ${note.id}` +
      `${note.journalDate ? ` · 날짜 ${note.journalDate}` : ''} · 마지막 수정 ${when(note.updatedAt)}` +
      `${note.updatedByName ? ` (${note.updatedByName})` : ''} · 원본은 계정 사이트 -->\n\n` +
      body.trim() +
      '\n'
    );
  }
  private async index(projectId: string): Promise<SharedNote[]> {
    try {
      return z
        .array(noteSchema)
        .parse(JSON.parse(await readFile(join(this.folder(projectId), 'index.json'), 'utf8')));
    } catch {
      return [];
    }
  }
  /** Writes every note's Markdown, the README index and index.json; drops removed notes. */
  private async mirror(projectId: string, notes: SharedNote[]) {
    const folder = this.folder(projectId);
    await mkdir(join(folder, '.yjs'), { recursive: true });
    const keep = new Set(['README.md', 'index.json', '.yjs']);
    for (const note of notes) {
      const file = fileOf(note);
      keep.add(file);
      const replica = this.replicas.get(`${projectId}:${note.id}`);
      if (replica) {
        replica.title = note.title;
        continue; // An open note writes its own (newer) copy.
      }
      if (note.snapshot !== undefined)
        await this.write(join(folder, file), this.markdownFile(note, note.snapshot));
    }
    const sorted = [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
    await this.write(
      join(folder, 'README.md'),
      '# 공유 노트·일지\n\n' +
        '이 프로젝트 구성원이 계정 사이트에서 함께 쓰는 노트·협의 사항·일지의 사본이다. ' +
        '원본은 사이트이며 이 파일들은 VIDE가 다시 쓴다(직접 고쳐도 사이트에 반영되지 않는다).\n\n' +
        '| 제목 | 종류 | 파일 | 마지막 수정 |\n|---|---|---|---|\n' +
        sorted
          .map(
            (note) =>
              `| ${note.title.replace(/\|/g, '/')} | ${NOTE_KIND_LABEL[note.kind]} | ${fileOf(note)} | ${when(note.updatedAt)} |`,
          )
          .join('\n') +
        '\n',
    );
    await this.write(
      join(folder, 'index.json'),
      JSON.stringify(sorted.map(({ snapshot: _snapshot, excerpt: _excerpt, ...meta }) => meta)),
    );
    for (const name of await readdir(folder).catch(() => [] as string[]))
      if (name.endsWith('.md') && !keep.has(name)) await unlink(join(folder, name)).catch(() => {});
  }

  // ── Site calls ──────────────────────────────────────────────────────────────────────────────
  /**
   * The project's notes from the site (and the local copy refreshed); when the site cannot be
   * reached, the last copy with `online: false`.
   */
  async list(projectId: string) {
    try {
      const { notes } = listSchema.parse(await this.device(this.base(projectId) + '?full=1'));
      await this.mirror(projectId, notes);
      void this.pushPending(projectId).catch(() => {});
      return {
        online: true,
        notes: notes.map(({ snapshot, ...meta }) => ({
          ...meta,
          excerpt: (snapshot ?? '').replace(/\s+/g, ' ').slice(0, 160),
        })),
      };
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'SITE_UNREACHABLE';
      if (!['SITE_UNREACHABLE', 'ACCOUNT_NOT_LINKED', 'SITE_ERROR'].includes(code)) throw error;
      return { online: false, error: code, notes: await this.index(projectId) };
    }
  }
  async create(projectId: string, input: { title?: unknown; kind?: unknown }) {
    const note = noteSchema.parse(await this.device(this.base(projectId), 'POST', input));
    void this.list(projectId).catch(() => {});
    return note;
  }
  /** Opens (or makes) the journal entry of `date` (default: this PC's today). */
  async journal(projectId: string, date = this.today()) {
    const note = noteSchema.parse(
      await this.device(this.base(projectId) + '/journal', 'POST', { date }),
    );
    void this.list(projectId).catch(() => {});
    return note;
  }
  async update(projectId: string, noteId: string, input: { title?: unknown; kind?: unknown }) {
    if (!NOTE_ID.test(noteId)) throw fail('NOT_FOUND');
    const note = noteSchema.parse(
      await this.device(`${this.base(projectId)}/${noteId}`, 'PATCH', input),
    );
    void this.list(projectId).catch(() => {});
    return note;
  }
  async remove(projectId: string, noteId: string) {
    if (!NOTE_ID.test(noteId)) throw fail('NOT_FOUND');
    await this.device(`${this.base(projectId)}/${noteId}`, 'DELETE');
    void this.list(projectId).catch(() => {});
    return { deleted: true };
  }
  private today() {
    return this.options.today?.() ?? localDate();
  }

  // ── Live replicas ───────────────────────────────────────────────────────────────────────────
  private stateFile(projectId: string, noteId: string) {
    return join(this.folder(projectId), '.yjs', `${noteId}.bin`);
  }
  /** The note's live replica on this PC (made on first use). */
  open(projectId: string, noteId: string): Promise<Replica> {
    if (!NOTE_ID.test(noteId)) return Promise.reject(fail('NOT_FOUND'));
    const key = `${projectId}:${noteId}`;
    const existing = this.replicas.get(key);
    if (existing) return Promise.resolve(existing);
    // Two callers at once (the screen's stream and its first edit) share one replica.
    let opening = this.opening.get(key);
    if (!opening) {
      opening = this.createReplica(projectId, noteId).finally(() => this.opening.delete(key));
      this.opening.set(key, opening);
    }
    return opening;
  }
  private async createReplica(projectId: string, noteId: string): Promise<Replica> {
    const key = `${projectId}:${noteId}`;
    const folder = this.folder(projectId);
    await mkdir(join(folder, '.yjs'), { recursive: true });
    const doc = new Y.Doc();
    const state = await readFile(this.stateFile(projectId, noteId)).catch(() => undefined);
    if (state) Y.applyUpdate(doc, new Uint8Array(state), 'disk');
    const pending = existsSync(this.stateFile(projectId, noteId).replace(/\.bin$/, '.pending'));
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null); // The engine relays cursors; it is not a user.
    const meta = (await this.index(projectId)).find((note) => note.id === noteId);
    const replica: Replica = {
      projectId,
      noteId,
      doc,
      awareness,
      listeners: new Map(),
      own: new Map(),
      pending,
      title: meta?.title ?? '',
      file: meta ? fileOf(meta) : `${noteId}.md`,
      socket: undefined as unknown as NoteSocket,
    };
    this.replicas.set(key, replica);
    replica.socket = new NoteSocket({
      doc,
      awareness,
      WebSocket: this.options.WebSocket,
      url: async () => {
        const value = ticketSchema.parse(
          await this.device(`${this.base(projectId)}/${noteId}/ticket`, 'POST', {}),
        );
        const site = this.options.remote.site;
        if (!site) throw fail('ACCOUNT_NOT_LINKED');
        return site.replace(/^http/, 'ws') + value.url;
      },
      onStatus: () => this.status(replica),
    });
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'disk') return;
      // Edits made here (screen or AI) wait for the site; ones from the site are already there.
      if (origin !== replica.socket) this.markPending(replica, true);
      for (const [client, listener] of replica.listeners)
        if (origin !== `screen:${client}`) listener({ type: 'update', update: toBase64(update) });
      this.scheduleSave(replica);
    });
    awareness.on(
      'update',
      (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const clients = [...changes.added, ...changes.updated, ...changes.removed];
        const from =
          typeof origin === 'string' && origin.startsWith('screen:') ? origin.slice(7) : '';
        if (from) {
          const own = replica.own.get(from) ?? new Set<number>();
          for (const id of clients) own.add(id);
          replica.own.set(from, own);
        }
        for (const [client, listener] of replica.listeners) {
          if (client === from) continue;
          const own = replica.own.get(client);
          const theirs = own ? clients.filter((id) => !own.has(id)) : clients;
          if (theirs.length)
            listener({
              type: 'awareness',
              update: toBase64(awarenessProtocol.encodeAwarenessUpdate(awareness, theirs)),
            });
        }
      },
    );
    // Sent edits are known sent once the socket is synced with nothing left to send.
    replica.check = setInterval(() => {
      if (replica.pending && replica.socket.idle) this.markPending(replica, false);
    }, 500);
    replica.check.unref?.();
    return replica;
  }
  private status(replica: Replica) {
    const event: StreamEvent = {
      type: 'status',
      status: { ...replica.socket.status, pending: replica.pending },
    };
    for (const listener of replica.listeners.values()) listener(event);
  }
  private markPending(replica: Replica, pending: boolean) {
    if (replica.pending === pending) return;
    replica.pending = pending;
    const marker = this.stateFile(replica.projectId, replica.noteId).replace(/\.bin$/, '.pending');
    const task = pending
      ? writeFile(marker, String(Date.now())).catch(() => {})
      : unlink(marker).catch(() => {});
    this.saving.add(task);
    void task.finally(() => this.saving.delete(task));
    this.status(replica);
  }
  private scheduleSave(replica: Replica) {
    clearTimeout(replica.save);
    replica.save = setTimeout(() => void this.save(replica), 400);
    replica.save.unref?.();
  }
  private async save(replica: Replica) {
    clearTimeout(replica.save);
    replica.save = undefined;
    const folder = this.folder(replica.projectId);
    await mkdir(join(folder, '.yjs'), { recursive: true });
    await this.write(
      this.stateFile(replica.projectId, replica.noteId),
      Y.encodeStateAsUpdate(replica.doc),
    );
    const meta = (await this.index(replica.projectId)).find((note) => note.id === replica.noteId);
    const note: SharedNote = meta ?? {
      id: replica.noteId,
      projectId: replica.projectId,
      title: replica.title || '제목 없음',
      kind: 'note',
      journalDate: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      updatedBy: null,
      revision: 0,
    };
    await this.write(
      join(folder, fileOf(note)),
      this.markdownFile(
        { ...note, updatedAt: Date.now(), updatedByName: null },
        noteMarkdown(replica.doc),
      ),
    );
  }
  /** Saves every open replica now (state and Markdown). */
  async flushLocal() {
    await Promise.all([...this.replicas.values()].filter((r) => r.save).map((r) => this.save(r)));
    await Promise.all([...this.saving]);
  }

  /**
   * The PC screen's view of a note: the replica's whole state first, then every change. `client`
   * names the screen so its own edits are not echoed back.
   */
  async stream(projectId: string, noteId: string, client: string, listener: Listener) {
    const replica = await this.open(projectId, noteId);
    clearTimeout(replica.idle);
    replica.listeners.set(client, listener);
    listener({
      type: 'sync',
      state: toBase64(Y.encodeStateAsUpdate(replica.doc)),
      vector: toBase64(Y.encodeStateVector(replica.doc)),
    });
    const others = [...replica.awareness.getStates().keys()];
    if (others.length)
      listener({
        type: 'awareness',
        update: toBase64(awarenessProtocol.encodeAwarenessUpdate(replica.awareness, others)),
      });
    listener({ type: 'status', status: { ...replica.socket.status, pending: replica.pending } });
    replica.socket.reconnect();
    return () => {
      replica.listeners.delete(client);
      // That screen's cursor leaves with it.
      const own = [...(replica.own.get(client) ?? [])];
      replica.own.delete(client);
      if (own.length) awarenessProtocol.removeAwarenessStates(replica.awareness, own, 'engine');
      if (!replica.listeners.size) {
        // Keep the site connection a little while (page reloads), then close the replica.
        replica.idle = setTimeout(() => void this.closeReplica(replica), 30_000);
        replica.idle.unref?.();
      }
    };
  }
  /** An edit or cursor from the PC screen. */
  async receive(
    projectId: string,
    noteId: string,
    client: string,
    input: { update?: unknown; awareness?: unknown },
  ) {
    const replica = await this.open(projectId, noteId);
    const origin = `screen:${client}`;
    if (typeof input.update === 'string')
      Y.applyUpdate(replica.doc, fromBase64(input.update), origin);
    if (typeof input.awareness === 'string')
      awarenessProtocol.applyAwarenessUpdate(
        replica.awareness,
        fromBase64(input.awareness),
        origin,
      );
    return { ok: true };
  }
  private async closeReplica(replica: Replica) {
    if (replica.listeners.size) return;
    this.replicas.delete(`${replica.projectId}:${replica.noteId}`);
    clearInterval(replica.check);
    clearTimeout(replica.idle);
    if (replica.save) await this.save(replica);
    replica.socket.destroy();
    replica.awareness.destroy();
  }
  /**
   * Notes edited here while the site was unreachable (`.pending`): open each so its socket sends
   * the edits, and close it again once sent. Also sends queued journal lines.
   */
  async pushPending(projectId: string) {
    const folder = this.folder(projectId);
    const names = await readdir(join(folder, '.yjs')).catch(() => [] as string[]);
    for (const name of names) {
      const noteId = name.replace(/\.pending$/, '');
      if (name === noteId || !NOTE_ID.test(noteId)) continue;
      const replica = await this.open(projectId, noteId);
      if (!replica.listeners.size) {
        clearTimeout(replica.idle);
        replica.idle = setTimeout(() => void this.closeReplica(replica), 60_000);
        replica.idle.unref?.();
      }
    }
    await this.sendQueuedJournal(projectId);
  }

  // ── 협의 사항 → 할 일, 퇴근하기 → 일지 ─────────────────────────────────────────────────────
  /**
   * Engine API (SPEC-10.4): the open check-list items of a note go to the project's 할 일, each
   * once (an open item with the same text is skipped). Reads the live replica when open, else the
   * local copy refreshed from the site.
   */
  async toAgenda(projectId: string, noteId: string) {
    if (!NOTE_ID.test(noteId)) throw fail('NOT_FOUND');
    const replica = this.replicas.get(`${projectId}:${noteId}`);
    let markdown = replica ? noteMarkdown(replica.doc) : undefined;
    if (markdown === undefined) {
      const listed = await this.list(projectId);
      const note = listed.notes.find((item) => item.id === noteId);
      if (!note) throw fail('NOTE_NOT_FOUND');
      markdown = await readFile(join(this.folder(projectId), fileOf(note)), 'utf8').catch(() => '');
    }
    return this.agendaFromText(projectId, markdown);
  }
  /** Adds each open check-list item of `text` as a 할 일 (shared with other callers). */
  agendaFromText(projectId: string, text: string) {
    const open = new Set(
      this.options.agenda
        .list(projectId)
        .filter((item) => !item.done)
        .map((item) => item.text.trim()),
    );
    const added: unknown[] = [];
    const skipped: string[] = [];
    for (const item of actionItems(text)) {
      if (open.has(item)) {
        skipped.push(item);
        continue;
      }
      added.push(this.options.agenda.add(projectId, { text: item }, 'user'));
      open.add(item);
    }
    return { added, skipped };
  }
  private queueFile(projectId: string) {
    return join(this.folder(projectId), '.yjs', 'journal-queue.json');
  }
  /**
   * Engine API for [퇴근하기] (SPEC-10.5): appends `text` to the journal entry of `date` (today)
   * on the site. When the site cannot be reached the line waits here and goes with the next
   * notes refresh (`queued`).
   */
  async appendJournal(projectId: string, text: string, date = this.today()) {
    if (!text.trim()) throw fail('INVALID_INPUT');
    try {
      const reply = z
        .object({ id: z.string(), lines: z.number() })
        .parse(await this.device(this.base(projectId) + '/journal/append', 'POST', { date, text }));
      void this.list(projectId).catch(() => {});
      return { state: 'sent' as const, noteId: reply.id };
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'SITE_UNREACHABLE';
      if (code === 'ACCOUNT_NOT_LINKED') return { state: 'unlinked' as const };
      if (code !== 'SITE_UNREACHABLE') throw error;
      const file = this.queueFile(projectId);
      await mkdir(join(this.folder(projectId), '.yjs'), { recursive: true });
      const queue = queuedSchema
        .catch([])
        .parse(JSON.parse(await readFile(file, 'utf8').catch(() => '[]')));
      queue.push({ date, text });
      await this.write(file, JSON.stringify(queue.slice(-200)));
      return { state: 'queued' as const };
    }
  }
  private async sendQueuedJournal(projectId: string) {
    const file = this.queueFile(projectId);
    if (!existsSync(file)) return;
    const queue = queuedSchema
      .catch([])
      .parse(JSON.parse(await readFile(file, 'utf8').catch(() => '[]')));
    const left = [];
    for (const item of queue)
      try {
        await this.device(this.base(projectId) + '/journal/append', 'POST', item);
      } catch {
        left.push(item);
      }
    if (left.length) await this.write(file, JSON.stringify(left));
    else await unlink(file).catch(() => {});
  }
  async close() {
    for (const replica of [...this.replicas.values()]) {
      replica.listeners.clear();
      await this.closeReplica(replica);
    }
    await Promise.all([...this.saving]);
  }
}
export const isNoteKind = (value: unknown): value is NoteKind =>
  NOTE_KINDS.includes(value as NoteKind);
