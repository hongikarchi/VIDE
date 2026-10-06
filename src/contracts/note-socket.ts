import type * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { awarenessMessage, readMessage, syncStep1, updateMessage } from './note-sync.ts';

export interface NoteSocketStatus {
  connected: boolean;
  synced: boolean;
  error?: string;
}
interface Options {
  doc: Y.Doc;
  awareness?: awarenessProtocol.Awareness;
  /** A fresh socket address (with a one-minute ticket) for each attempt. */
  url: () => Promise<string>;
  onStatus?: (status: NoteSocketStatus) => void;
  WebSocket?: typeof WebSocket;
}

/**
 * One note's live connection to the site (browser or PC engine). Local edits made while it is
 * closed stay in the Yjs document; the sync steps of the next connection send them (the queue of
 * offline edits is the document itself, SPEC-10.6). Reconnects with back-off until destroyed.
 */
export class NoteSocket {
  readonly doc: Y.Doc;
  readonly awareness?: awarenessProtocol.Awareness;
  private socket: WebSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delay = 500;
  private closed = false;
  /** A connection attempt is waiting for its ticket (no second socket may start meanwhile). */
  private connecting = false;
  private options: Options;
  status: NoteSocketStatus = { connected: false, synced: false };
  constructor(options: Options) {
    this.options = options;
    this.doc = options.doc;
    this.awareness = options.awareness;
    this.doc.on('update', this.onUpdate);
    this.awareness?.on('update', this.onAwareness);
    void this.connect();
  }
  private set(status: Partial<NoteSocketStatus>) {
    this.status = { ...this.status, ...status };
    this.options.onStatus?.(this.status);
  }
  private onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== this) this.send(updateMessage(update));
  };
  private onAwareness = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    // Our own cursor and, on the PC engine, the cursors of its local screens; never an echo.
    if (origin === this || !this.awareness) return;
    const clients = [...changes.added, ...changes.updated, ...changes.removed];
    this.send(awarenessMessage(awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients)));
  };
  private send(message: Uint8Array) {
    if (this.socket?.readyState === 1) this.socket.send(message as Uint8Array<ArrayBuffer>);
  }
  /** Connected, synced and nothing left in the socket's send buffer. */
  get idle() {
    return this.status.synced && this.socket?.readyState === 1 && this.socket.bufferedAmount === 0;
  }
  private async connect() {
    if (this.closed || this.connecting || this.socket) return;
    this.connecting = true;
    let url: string;
    try {
      url = await this.options.url();
    } catch (error) {
      this.set({ connected: false, synced: false, error: (error as Error)?.message || 'OFFLINE' });
      this.retry();
      return;
    } finally {
      this.connecting = false;
    }
    if (this.closed || this.socket) return;
    const Socket = this.options.WebSocket ?? WebSocket;
    const socket = new Socket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      this.delay = 500;
      this.set({ connected: true, error: undefined });
      socket.send(syncStep1(this.doc));
      if (this.awareness?.getLocalState())
        socket.send(
          awarenessMessage(
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
          ),
        );
    };
    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const read = readMessage(this.doc, new Uint8Array(event.data), this);
      if (read.reply) socket.send(read.reply);
      if (read.step2) this.set({ synced: true });
      if (read.awareness && this.awareness)
        awarenessProtocol.applyAwarenessUpdate(this.awareness, read.awareness, this);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.awareness) {
        const others = [...this.awareness.getStates().keys()].filter(
          (id) => id !== this.doc.clientID,
        );
        awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
      }
      this.set({
        connected: false,
        synced: false,
        error:
          event.code === 4403 ? 'FORBIDDEN' : event.code === 4404 ? 'NOTE_NOT_FOUND' : undefined,
      });
      if (event.code !== 4403 && event.code !== 4404) this.retry();
    };
    socket.onerror = () => {};
  }
  private retry() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, 30_000);
  }
  /** Reconnect now (e.g. the browser came back online). */
  reconnect() {
    if (this.closed || this.socket || this.connecting) return;
    this.delay = 500;
    clearTimeout(this.timer);
    void this.connect();
  }
  destroy() {
    this.closed = true;
    clearTimeout(this.timer);
    this.doc.off('update', this.onUpdate);
    this.awareness?.off('update', this.onAwareness);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000);
  }
}
