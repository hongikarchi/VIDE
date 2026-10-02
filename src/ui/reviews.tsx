import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { ReviewNotes } from './review-notes.tsx';
import type { NoteActions } from './review-notes.tsx';
import { showReviewComparison } from './review-comparison.tsx';
import { api } from './gateway.ts';
import { reviewRowSchema, reviewSchema, reviewNoteSchema } from '../contracts/reviews.ts';
import type { ReviewRow, Review, ReviewNote } from '../contracts/reviews.ts';
import { tableViewSchema } from '../contracts/quantities.ts';
import { SharedFeedback } from './shared-feedback.tsx';
import type { ReceivedFeedback } from '../contracts/shared-feedback.ts';
import type { TableView } from '../contracts/quantities.ts';

const dialog = document.createElement('dialog');
document.body.append(dialog);
const modal = createRoot(dialog);
let busy = false,
  generation = 0;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '검토 자료를 읽지 못했습니다.';
dialog.addEventListener('cancel', (event) => {
  if (busy) event.preventDefault();
});
dialog.addEventListener('close', () => {
  generation++;
  modal.render(null);
});
function ReviewContent({
  projectId,
  row,
  actions,
}: {
  projectId: string;
  row: ReviewRow;
  actions: NoteActions;
}) {
  const [content, setContent] = useState<{ review: Review; notes: ReviewNote[] } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void Promise.all([
      api(`/projects/${projectId}/reviews/${row.id}`),
      api(`/projects/${projectId}/reviews/${row.id}/notes`),
    ])
      .then(([data, rows]) => {
        const review = reviewSchema.parse(data),
          notes = z.array(reviewNoteSchema).parse(rows);
        if (
          review.id !== row.id ||
          review.projectId !== projectId ||
          notes.some((note) => note.reviewId !== row.id || note.projectId !== projectId)
        )
          throw new Error('검토본의 기준이 일치하지 않습니다.');
        if (alive) setContent({ review, notes });
      })
      .catch((reason) => {
        if (alive) setError(errorText(reason));
      });
    return () => {
      alive = false;
    };
  }, [projectId, row.id]);
  return (
    <>
      <div className="quantity-head">
        <h2>{row.title}</h2>
        <a
          href={`api/v1/projects/${projectId}/reviews/${row.id}/download`}
          download="VIDE-review.html"
        >
          HTML 내려받기
        </a>
        <button onClick={() => dialog.close()}>닫기</button>
      </div>
      <iframe
        title="검토본 내용"
        sandbox=""
        src={`api/v1/projects/${projectId}/reviews/${row.id}/preview`}
      />
      <details className="review-notes">
        <summary>검토 의견</summary>
        <section>
          {content ? (
            <ReviewNotes review={content.review} initialNotes={content.notes} {...actions} />
          ) : (
            <p role="status">{error || '의견 불러오는 중…'}</p>
          )}
        </section>
      </details>
    </>
  );
}
function SaveReview({
  projectId,
  requestId,
  image,
  views,
  onSaved,
}: {
  projectId: string;
  requestId: string;
  image: string;
  views: TableView[];
  onSaved: (row: ReviewRow) => void;
}) {
  const [title, setTitle] = useState(''),
    [view, setView] = useState(''),
    [saving, setSaving] = useState(false),
    [status, setStatus] = useState('');
  const locked = useRef(false),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  async function save() {
    if (locked.current) return;
    locked.current = true;
    busy = true;
    setSaving(true);
    try {
      const row = reviewRowSchema.parse(
        await api(`/projects/${projectId}/reviews`, 'POST', {
          requestId,
          title,
          image,
          query: views.find((item) => item.id === view)?.query || {},
        }),
      );
      if (row.requestId !== requestId) throw new Error('저장된 검토본의 기준이 일치하지 않습니다.');
      onSaved(row);
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      locked.current = false;
      busy = false;
      setSaving(false);
    }
  }
  return (
    <>
      <div className="quantity-head">
        <h2>검토본 저장</h2>
        <button
          disabled={saving}
          onClick={() => {
            if (!locked.current) dialog.close();
          }}
        >
          닫기
        </button>
      </div>
      <p>화면·입력·표·적용 상태를 현재 시점으로 남깁니다.</p>
      <div className="table-controls">
        <input
          ref={input}
          aria-label="검토본 제목"
          placeholder="예: 수정 전, 검토 후보"
          maxLength={100}
          value={title}
          disabled={saving}
          onChange={(event) => setTitle(event.target.value)}
        />
        <select
          aria-label="검토본 표 구성"
          value={view}
          disabled={saving}
          onChange={(event) => setView(event.target.value)}
        >
          <option value="">전체 객체</option>
          {views.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button disabled={saving} onClick={save}>
          검토본 저장
        </button>
      </div>
      <p role="status">{status}</p>
    </>
  );
}
/**
 * The saved 검토본 of the shown project (T-109, user decision 2026-10-02): listed in the 산출물
 * screen's 검토본 view and linked from each request ('이 작업으로 만든 검토본'). The work history
 * keeps only the request list.
 */
let listed: { projectId: string; rows: ReviewRow[] } | undefined;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((listener) => listener());
/** Saved 검토본 of a project (empty until the list is read). */
export function reviewRows(projectId: string | undefined): ReviewRow[] {
  return projectId && listed?.projectId === projectId ? listed.rows : [];
}
const newestFirst = (rows: ReviewRow[]) =>
  [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
/** The 검토본 saved from one request, newest first. */
export function reviewsOf(projectId: string | undefined, requestId: string): ReviewRow[] {
  return newestFirst(reviewRows(projectId).filter((row) => row.requestId === requestId));
}
export function onReviewsChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
let shared:
  | {
      actions: NoteActions;
      getProject: () => string | undefined;
      onSharedAdopt: (note: ReceivedFeedback) => void;
      refresh: () => Promise<void>;
    }
  | undefined;
/** Open one saved 검토본 (the read dialog: content, notes, HTML download). */
export function openReview(projectId: string, row: ReviewRow) {
  if (!shared) return;
  generation++;
  dialog.className = 'review-dialog';
  dialog.setAttribute('aria-label', '저장한 검토본');
  modal.render(<ReviewContent key={generation} {...{ projectId, row, actions: shared.actions }} />);
  if (!dialog.open) dialog.showModal();
}
/** Open the 외부 의견 inbox (SPEC-04.7): import, received list, basis and adopt. */
export function openSharedFeedback(projectId: string, onCount?: (count: number) => void) {
  if (!shared) return;
  const { actions, getProject, onSharedAdopt } = shared;
  generation++;
  dialog.className = 'quantity-dialog';
  dialog.setAttribute('aria-label', '외부 의견');
  modal.render(
    <>
      <button onClick={() => dialog.close()}>닫기</button>
      <SharedFeedback
        key={generation}
        projectId={projectId}
        onBasis={actions.onBasis}
        onCount={onCount}
        onAdopt={(note) => {
          if (getProject() !== projectId) throw Error('프로젝트가 변경되었습니다.');
          onSharedAdopt(note);
          dialog.close();
        }}
      />
    </>,
  );
  if (!dialog.open) dialog.showModal();
}
/** How many 외부 의견 this project has received (the badge in the 산출물 screen). */
export async function sharedFeedbackCount(projectId: string) {
  return z.array(z.unknown()).parse(await api(`/projects/${projectId}/shared-feedback`)).length;
}
/** The 검토본 view of the 산출물 screen: [검토본 비교] and every saved 검토본, newest first. */
export function ReviewSection({ projectId, shown }: { projectId: string; shown: number }) {
  const [, setVersion] = useState(0);
  const [status, setStatus] = useState('');
  useEffect(() => onReviewsChange(() => setVersion((n) => n + 1)), []);
  useEffect(() => {
    setStatus('');
    void shared?.refresh().catch((error: unknown) => setStatus(errorText(error)));
  }, [projectId, shown]);
  const rows = newestFirst(reviewRows(projectId));
  return (
    <div className="output-review">
      <div className="output-side-head">
        <p className="caption">저장한 검토본</p>
        {rows.length > 1 ? (
          <button
            type="button"
            onClick={() => {
              void showReviewComparison(projectId).catch((error: unknown) =>
                setStatus(errorText(error)),
              );
            }}
          >
            검토본 비교
          </button>
        ) : null}
      </div>
      <p className="output-note">
        작업 보기의 [검토본 저장]으로 남긴 화면·입력·표·적용 상태입니다. 열어도 현재 모델은 바뀌지
        않습니다.
      </p>
      {status ? <p role="status">{status}</p> : null}
      {rows.length ? (
        <ul className="output-review-list" aria-label="저장한 검토본">
          {rows.map((row) => (
            <li key={row.id}>
              <button type="button" onClick={() => openReview(projectId, row)}>
                {row.title}
              </button>
              <span className="output-review-meta">
                {new Date(row.createdAt).toLocaleString('ko-KR')}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="output-empty">저장한 검토본이 없습니다.</p>
      )}
    </div>
  );
}
export function initializeReviews(
  getProject: () => string | undefined,
  notify: (message: string) => void,
  onAdopt: NoteActions['onAdopt'],
  onBasis: NoteActions['onBasis'],
  onSharedAdopt: (note: ReceivedFeedback) => void,
) {
  let refreshGeneration = 0;
  const actions: NoteActions = {
    onAdopt: (note, review) => {
      onAdopt(note, review);
      dialog.close();
    },
    onBasis: (id) => {
      onBasis(id);
      dialog.close();
    },
  };
  async function refresh() {
    const projectId = getProject(),
      current = ++refreshGeneration;
    if (!projectId) {
      listed = undefined;
      publish();
      return;
    }
    const rows = z.array(reviewRowSchema).parse(await api(`/projects/${projectId}/reviews`));
    if (current !== refreshGeneration || getProject() !== projectId) return;
    listed = { projectId, rows };
    publish();
  }
  shared = { actions, getProject, onSharedAdopt, refresh };
  async function create(requestId: string, image: string) {
    if (busy) return;
    const projectId = getProject();
    if (!projectId) return;
    const current = ++generation,
      views = z.array(tableViewSchema).parse(await api(`/projects/${projectId}/table-views`));
    if (current !== generation || getProject() !== projectId || busy) return;
    dialog.className = 'quantity-dialog review-save';
    dialog.setAttribute('aria-label', '검토본 저장');
    modal.render(
      <SaveReview
        key={current}
        {...{ projectId, requestId, image, views }}
        onSaved={(row) => {
          openReview(projectId, row);
          notify('검토본을 저장했습니다. 산출물의 검토본에서 다시 열 수 있습니다.');
          void refresh().catch((error) =>
            notify('검토본은 저장됐지만 목록을 갱신하지 못했습니다: ' + errorText(error)),
          );
        }}
      />,
    );
    if (!dialog.open) dialog.showModal();
  }
  return { refresh, create };
}
