import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { api } from './gateway.ts';
import { reviewNoteSchema } from '../contracts/reviews.ts';
import type { Review, ReviewNote } from '../contracts/reviews.ts';

const draftSchema = z.object({
  body: z.string().max(4000),
  objectId: z.string().nullable(),
  id: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
  pending: z.boolean(),
});
type Draft = z.infer<typeof draftSchema>;
const empty = (): Draft => ({ body: '', objectId: null, id: crypto.randomUUID(), pending: false });
export interface NoteActions {
  onAdopt: (note: ReviewNote, review: Review) => void;
  onBasis: (id: string) => void;
}
export function ReviewNotes({
  review,
  initialNotes,
  onAdopt,
  onBasis,
}: { review: Review; initialNotes: ReviewNote[] } & NoteActions) {
  const key = `vide:review-note:${review.projectId}:${review.id}`;
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const saved = draftSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? 'null'));
      if (saved.success) return saved.data;
    } catch {
      /* Unreadable browser cache is not authoritative; stored server notes remain available. */
    }
    return empty();
  });
  const [notes, setNotes] = useState(initialNotes),
    [status, setStatus] = useState(''),
    [saving, setSaving] = useState(false),
    locked = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function persist(next: Draft) {
    setDraft(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      setStatus('초안 저장 불가. 화면을 닫기 전에 의견을 저장하세요.');
    }
  }
  async function save() {
    if (locked.current || !draft.body.trim()) return;
    locked.current = true;
    setSaving(true);
    const submitted = { ...draft, pending: true };
    persist(submitted);
    try {
      const note = reviewNoteSchema.parse(
        await api(`/projects/${review.projectId}/reviews/${review.id}/notes`, 'POST', {
          id: submitted.id,
          body: submitted.body,
          objectId: submitted.objectId,
        }),
      );
      if (
        note.id !== submitted.id ||
        note.projectId !== review.projectId ||
        note.reviewId !== review.id ||
        note.requestId !== review.requestId ||
        note.body !== submitted.body ||
        note.objectId !== submitted.objectId
      )
        throw new Error('의견 저장 결과의 기준이 일치하지 않습니다.');
      if (alive.current) {
        setNotes((current) =>
          current.some((item) => item.id === note.id) ? current : [...current, note],
        );
        persist(empty());
        setStatus('의견을 저장했습니다. AI 실행 전의 검토 기록입니다.');
      } else
        try {
          const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
          if (saved?.id === submitted.id) localStorage.setItem(key, JSON.stringify(empty()));
        } catch {
          /* Server save succeeded; retained submission ID makes a later retry idempotent. */
        }
    } catch (error) {
      if (alive.current)
        setStatus(
          (error instanceof Error ? error.message : '의견을 저장하지 못했습니다.') +
            ' · 같은 의견을 다시 확인할 수 있습니다.',
        );
    } finally {
      locked.current = false;
      if (alive.current) setSaving(false);
    }
  }
  const perform = (action: () => void) => {
    try {
      action();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '요청을 처리하지 못했습니다.');
    }
  };
  return (
    <>
      <h3>검토 의견</h3>
      <small>이 검토본에 로컬로 저장됩니다.</small>
      <div>
        {notes.map((note) => (
          <article key={note.id}>
            <small>
              {review.payload.model.find((object) => object.id === note.objectId)?.name ||
                '검토본 전체'}{' '}
              · {new Date(note.createdAt).toLocaleString('ko-KR')}
            </small>
            <p>{note.body}</p>
            <button onClick={() => perform(() => onBasis(review.requestId))}>기준 후보 열기</button>
            <button onClick={() => perform(() => onAdopt(note, review))}>요청 초안에 첨부</button>
          </article>
        ))}
      </div>
      <div className="review-note-form">
        <select
          aria-label="의견 대상"
          value={draft.objectId ?? ''}
          disabled={draft.pending}
          onChange={(event) => persist({ ...draft, objectId: event.target.value || null })}
        >
          <option value="">검토본 전체</option>
          {review.payload.model.map((object) => (
            <option key={object.id} value={object.id}>
              {object.name}
            </option>
          ))}
        </select>
        <textarea
          aria-label="검토 의견 본문"
          maxLength={4000}
          value={draft.body}
          disabled={draft.pending}
          onChange={(event) => persist({ ...draft, body: event.target.value })}
        />
        <button disabled={saving || !draft.body.trim()} onClick={save}>
          {draft.pending ? '동일 의견 다시 확인' : '의견 저장'}
        </button>
        <p role="status">{status}</p>
      </div>
    </>
  );
}
