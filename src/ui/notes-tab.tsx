import { createRoot, type Root } from 'react-dom/client';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { fromBase64, toBase64 } from '../contracts/note-sync.ts';
import { api } from './gateway.ts';
import {
  NotesWorkspace,
  type NoteItem,
  type NoteLinkStatus,
  type NotesBackend,
} from './notes/notes-workspace.tsx';
import './notes-tab.css';

// 노트·일지 workspace (SPEC-10, Design SCR-23): the account site's shared notes in VIDE. The engine
// is the project member (this PC's account link) and keeps each open note's replica; this screen
// talks to the engine only — a stream of the replica (Server-Sent Events) and posted updates — so
// it works the same at this PC, through the tunnel and through the site's relay, and edits made
// while the site is unreachable wait in the engine (src/server/shared-notes.ts).
let root: Root | undefined;
let shownFor: string | undefined;

function backendFor(projectId: string): NotesBackend & { setUser(name: string): void } {
  const base = `/projects/${encodeURIComponent(projectId)}/notes`;
  const backend = {
    user: '나',
    setUser(name: string) {
      backend.user = name;
    },
    list: async () => {
      const value = (await api(base)) as { notes: NoteItem[]; online: boolean; user?: string };
      if (value.user) backend.user = value.user;
      return value;
    },
    create: async (kind: 'note' | 'discussion') => (await api(base, 'POST', { kind })) as NoteItem,
    journal: async (date: string) => (await api(base + '/journal', 'POST', { date })) as NoteItem,
    update: async (id: string, input: object) =>
      (await api(`${base}/${id}`, 'PUT', input)) as NoteItem,
    remove: async (id: string) => {
      await api(`${base}/${id}/remove`, 'POST', {});
    },
    toAgenda: async (id: string) =>
      (await api(`${base}/${id}/to-agenda`, 'POST', {})) as { added: number; skipped: number },
    connect(
      id: string,
      doc: Y.Doc,
      awareness: awarenessProtocol.Awareness,
      onStatus: (status: NoteLinkStatus) => void,
    ) {
      const client = Array.from(crypto.getRandomValues(new Uint8Array(12)), (n) =>
        n.toString(16).padStart(2, '0'),
      ).join('');
      const post = (data: { update?: string; awareness?: string }) =>
        api(`${base}/${id}/updates`, 'POST', { client, ...data }).catch(() => {
          // The engine is this PC; a lost post is resent whole on the next stream 'sync'.
        });
      // Edits are sent in small batches (one post per animation frame of typing).
      let queued: Uint8Array[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        timer = undefined;
        if (!queued.length) return;
        const update = Y.mergeUpdates(queued);
        queued = [];
        void post({ update: toBase64(update) });
      };
      const onUpdate = (update: Uint8Array, origin: unknown) => {
        if (origin === 'engine') return;
        queued.push(update);
        timer ??= setTimeout(flush, 40);
      };
      const onAwareness = (
        changes: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin === 'engine') return;
        const clients = [...changes.added, ...changes.updated, ...changes.removed];
        void post({
          awareness: toBase64(awarenessProtocol.encodeAwarenessUpdate(awareness, clients)),
        });
      };
      doc.on('update', onUpdate);
      awareness.on('update', onAwareness);
      const stream = new EventSource(`api/v1${base}/${id}/stream?client=${client}`);
      stream.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as
          | { type: 'sync'; state: string; vector: string }
          | { type: 'update' | 'awareness'; update: string }
          | { type: 'status'; status: NoteLinkStatus };
        if (event.type === 'sync') {
          Y.applyUpdate(doc, fromBase64(event.state), 'engine');
          // Whatever this screen has that the engine lacks (a reconnect) goes back at once.
          const missing = Y.encodeStateAsUpdate(doc, fromBase64(event.vector));
          if (missing.length > 2) void post({ update: toBase64(missing) });
          if (awareness.getLocalState())
            void post({
              awareness: toBase64(
                awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]),
              ),
            });
        } else if (event.type === 'update') Y.applyUpdate(doc, fromBase64(event.update), 'engine');
        else if (event.type === 'awareness')
          awarenessProtocol.applyAwarenessUpdate(awareness, fromBase64(event.update), 'engine');
        else if (event.type === 'status') onStatus(event.status);
      };
      stream.onerror = () => onStatus({ connected: false, synced: false, pending: true });
      return () => {
        if (timer) {
          clearTimeout(timer);
          flush();
        }
        awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], 'local');
        stream.close();
        doc.off('update', onUpdate);
        awareness.off('update', onAwareness);
      };
    },
  };
  return backend;
}

/** Shows the 노트·일지 screen of `projectId` (the workspace tab's container). */
export function showNotes(projectId: string) {
  const workspace = document.querySelector<HTMLElement>('.workspace');
  if (!workspace) return;
  if (!root) {
    const host = document.createElement('section');
    host.className = 'notes-tab';
    host.setAttribute('aria-label', '노트·일지');
    workspace.append(host);
    root = createRoot(host);
  }
  if (shownFor !== projectId) {
    shownFor = projectId;
    root.render(<NotesWorkspace key={projectId} backend={backendFor(projectId)} />);
  }
}
