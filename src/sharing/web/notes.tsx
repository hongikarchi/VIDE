import { useMemo } from 'react';
import { NoteSocket } from '../../contracts/note-socket';
import { NotesWorkspace, type NoteItem, type NotesBackend } from '../../ui/notes/notes-workspace';
import { api, type Project } from './api';

// SPEC-10: a project's shared notes, 협의 사항 and daily journal on the account site. Every
// project member edits; the live editor connects to the note's Durable Object with a one-minute
// ticket per attempt (notes.ts).
export function ProjectNotes({ project, user }: { project: Project; user: string }) {
  const backend = useMemo<NotesBackend>(() => {
    const base = `/projects/${encodeURIComponent(project.id)}/notes`;
    return {
      user,
      agendaHint: '할 일로 보내기는 작업 PC의 VIDE에서 합니다.',
      list: async () => ({
        notes: ((await api(base)) as { notes: NoteItem[] }).notes,
        online: true,
      }),
      create: async (kind) => (await api(base, 'POST', { kind })) as NoteItem,
      journal: async (date) => (await api(base + '/journal', 'POST', { date })) as NoteItem,
      update: async (id, input) => (await api(`${base}/${id}`, 'PATCH', input)) as NoteItem,
      remove: async (id) => {
        await api(`${base}/${id}`, 'DELETE');
      },
      connect: (id, doc, awareness, onStatus) => {
        const socket = new NoteSocket({
          doc,
          awareness,
          url: async () => {
            const { url } = (await api(`${base}/${id}/ticket`, 'POST', {})) as { url: string };
            return location.origin.replace(/^http/, 'ws') + url;
          },
          onStatus,
        });
        const back = () => socket.reconnect();
        window.addEventListener('online', back);
        return () => {
          window.removeEventListener('online', back);
          socket.destroy();
        };
      },
    };
  }, [project.id, user]);
  const initial = new URL(location.href).searchParams.get('note') ?? undefined;
  return (
    <div className="notes-page">
      <NotesWorkspace
        backend={backend}
        initial={initial}
        onOpen={(id) => {
          const url = new URL(location.href);
          url.searchParams.set('note', id);
          history.replaceState(null, '', url);
        }}
      />
    </div>
  );
}
