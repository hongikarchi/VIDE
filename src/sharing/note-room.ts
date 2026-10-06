import { DurableObject } from 'cloudflare:workers';
import * as Y from 'yjs';
import type { Env } from './auth';
import { appendParagraphs, ensureFirstBlock, noteMarkdown } from '../contracts/note-doc.ts';
import { readMessage, syncStep1, updateMessage } from '../contracts/note-sync.ts';

// One shared note (ADR-034): a SQLite-backed Durable Object holding the note's Yjs document. The
// browsers and work PCs editing it keep a hibernatable WebSocket each (no duration charge while
// idle). Incoming updates are applied, sent to the other sockets and buffered; an alarm writes the
// buffer to the object's own SQLite about once a second (one row per flush, not per keystroke, to
// stay inside the free 100,000 rows written a day) and the Markdown snapshot to D1 at most every
// five seconds, and at once when the last socket leaves. Who may connect is checked by the Worker
// before the socket reaches here (notes.ts).
const PERSIST_MS = 1000;
const D1_MS = 5000;
const COMPACT_ROWS = 100;
const MESSAGE_MAX = 4 * 1024 * 1024;

interface Attachment {
  user: string;
}

export class NoteRoom extends DurableObject<Env> {
  private doc = new Y.Doc({ gc: true });
  private pending: Uint8Array[] = [];
  private d1Dirty = false;
  private lastD1 = 0;
  private alarmSet = false;
  private editor: string | null = null;
  private projectId = '';
  private noteId = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(
        'CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)',
      );
      sql.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      for (const row of sql.exec<{ key: string; value: string }>('SELECT key,value FROM meta'))
        if (row.key === 'project') this.projectId = row.value;
        else if (row.key === 'note') this.noteId = row.value;
      const rows = sql
        .exec<{ data: ArrayBuffer }>('SELECT data FROM updates ORDER BY id')
        .toArray()
        .map((row) => new Uint8Array(row.data));
      if (rows.length) Y.applyUpdate(this.doc, Y.mergeUpdates(rows));
      this.doc.on('update', this.onUpdate);
      ensureFirstBlock(this.doc, 'init');
    });
  }

  private onUpdate = (update: Uint8Array, origin: unknown) => {
    this.pending.push(update);
    this.d1Dirty = true;
    const body = updateMessage(update);
    for (const socket of this.ctx.getWebSockets())
      if (socket !== origin)
        try {
          socket.send(body);
        } catch {
          /* A closing socket; its close handler cleans up. */
        }
    if (origin && typeof origin === 'object' && 'deserializeAttachment' in origin) {
      const attachment = (origin as WebSocket).deserializeAttachment() as Attachment | null;
      if (attachment?.user) this.editor = attachment.user;
    }
    this.schedule(PERSIST_MS);
  };

  private schedule(ms: number) {
    if (this.alarmSet) return;
    this.alarmSet = true;
    void this.ctx.storage.setAlarm(Date.now() + ms);
  }

  /** Buffered updates → one SQLite row; many rows → one compacted state. */
  private persist() {
    if (!this.pending.length) return;
    const merged = Y.mergeUpdates(this.pending);
    this.pending = [];
    const sql = this.ctx.storage.sql;
    sql.exec('INSERT INTO updates(data) VALUES(?)', merged);
    const count = sql.exec<{ n: number }>('SELECT count(*) AS n FROM updates').one().n;
    if (count > COMPACT_ROWS)
      this.ctx.storage.transactionSync(() => {
        sql.exec('DELETE FROM updates');
        sql.exec('INSERT INTO updates(data) VALUES(?)', Y.encodeStateAsUpdate(this.doc));
      });
  }

  private async writeD1() {
    if (!this.d1Dirty || !this.noteId) return;
    this.d1Dirty = false;
    this.lastD1 = Date.now();
    await this.env.DB.prepare(
      'UPDATE notes SET snapshot=?,updated_at=?,updated_by=COALESCE(?,updated_by),revision=revision+1 WHERE id=? AND project_id=?',
    )
      .bind(noteMarkdown(this.doc), Date.now(), this.editor, this.noteId, this.projectId)
      .run();
  }

  async alarm() {
    this.alarmSet = false;
    this.persist();
    if (!this.d1Dirty) return;
    const wait = this.lastD1 + D1_MS - Date.now();
    if (wait <= 0 || this.ctx.getWebSockets().length === 0) await this.writeD1();
    else this.schedule(wait);
  }

  private remember(request: Request) {
    const project = request.headers.get('X-Note-Project') ?? '',
      note = request.headers.get('X-Note-Id') ?? '';
    if (!project || !note || (this.noteId && (this.noteId !== note || this.projectId !== project)))
      return false;
    if (!this.noteId) {
      this.projectId = project;
      this.noteId = note;
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO meta(key,value) VALUES('project',?),('note',?)",
        project,
        note,
      );
    }
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.remember(request)) return new Response('NOTE_MISMATCH', { status: 400 });
    const path = new URL(request.url).pathname;
    if (path === '/socket') {
      if (request.headers.get('Upgrade') !== 'websocket')
        return new Response('UPGRADE_REQUIRED', { status: 426 });
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        user: request.headers.get('X-Note-User') ?? '',
      } satisfies Attachment);
      // The server's state vector first; the client answers with what the server lacks
      // (edits it made offline) and asks for the rest with its own step 1.
      server.send(syncStep1(this.doc));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path === '/append' && request.method === 'POST') {
      const input = (await request.json()) as { text?: unknown; user?: unknown };
      if (typeof input.text !== 'string') return new Response('INVALID_INPUT', { status: 400 });
      if (typeof input.user === 'string') this.editor = input.user;
      const lines = appendParagraphs(this.doc, input.text, 'append');
      this.persist();
      await this.writeD1();
      return Response.json({ lines });
    }
    if (path === '/flush' && request.method === 'POST') {
      this.persist();
      await this.writeD1();
      return Response.json({ markdown: noteMarkdown(this.doc) });
    }
    if (path === '/markdown') return Response.json({ markdown: noteMarkdown(this.doc) });
    return new Response('NOT_FOUND', { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string) {
    if (typeof message === 'string') return;
    if (message.byteLength > MESSAGE_MAX) {
      socket.close(1009, 'MESSAGE_TOO_LARGE');
      return;
    }
    let read: ReturnType<typeof readMessage>;
    try {
      read = readMessage(this.doc, new Uint8Array(message), socket);
    } catch {
      socket.close(1007, 'INVALID_MESSAGE');
      return;
    }
    if (read.reply) socket.send(read.reply);
    if (read.awareness)
      // Cursors and presence are relayed, not stored.
      for (const other of this.ctx.getWebSockets())
        if (other !== socket)
          try {
            other.send(message);
          } catch {
            /* closing */
          }
  }

  async webSocketClose(socket: WebSocket, code: number) {
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      /* already closed */
    }
    if (this.ctx.getWebSockets().filter((other) => other !== socket).length === 0) {
      this.persist();
      await this.writeD1();
    }
  }

  async webSocketError(socket: WebSocket) {
    await this.webSocketClose(socket, 1011);
  }
}
