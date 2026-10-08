// [관리자에게 제출] and 내 제출 (SPEC-07.19, ADR-041, Design SCR-16·18). A draft of the make screen
// or a project jig installed on this PC goes, after a one-card confirmation with a note, to the
// account site's admin box (`POST /api/v1/jig-submissions`, T2); 내 제출 lists this account's
// submissions with their status (받음 · 검토 중 · 반영됨 · 반려 with the reason). The engine refuses
// remote sessions; the button says so there instead of failing.
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { api, errors } from './gateway.ts';
import { remoteSession } from './remote-panel.ts';

Object.assign(errors, {
  ACCOUNT_NOT_LINKED:
    'VIDE 계정에 로그인한 PC에서만 제출할 수 있습니다. 왼쪽 아래 계정 단추에서 로그인하세요.',
  JIG_SUBMISSION_TOO_LARGE: 'jig 묶음이 8 MB를 넘어 보내지 않았습니다. 시험 자료를 줄여 보세요.',
  JIG_SUBMISSIONS_FULL:
    '관리자가 아직 보지 않은 제출이 많아 지금은 더 받지 않습니다. 잠시 뒤 다시 제출하세요.',
  JIG_PACK_INVALID: '계정 사이트가 이 jig 묶음을 받지 않았습니다. 다시 제출하세요.',
  JIG_SUBMIT_FAILED: '계정 사이트에 제출하지 못했습니다. 잠시 뒤 다시 제출하세요.',
  UPLOADS_DISABLED: '지금은 계정 사이트가 올리기를 받지 않습니다.',
});
const SUBMIT_INVALID =
  '형식 점검을 통과하지 못해 보내지 않았습니다. 점검 결과를 고친 뒤 다시 제출하세요.';
if (!errors.SITE_UNREACHABLE)
  errors.SITE_UNREACHABLE =
    '계정 사이트에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 제출하세요.';

export const STATUS_LABEL: Record<string, string> = {
  received: '받음',
  reviewing: '검토 중',
  applied: '반영됨',
  rejected: '반려',
};
const submissionSchema = z
  .object({
    id: z.string(),
    jigId: z.string(),
    version: z.string(),
    name: z.string().default(''),
    note: z.string().default(''),
    status: z.string(),
    reason: z.string().nullable().optional(),
    createdAt: z.number(),
  })
  .passthrough();
export type Submission = z.infer<typeof submissionSchema>;
const listSchema = z
  .object({
    linked: z.boolean().default(false),
    online: z.boolean().default(false),
    error: z.string().optional(),
    submissions: z.array(submissionSchema).catch([]).default([]),
  })
  .passthrough();

/** What to send: a draft of a project, or an installed jig version. */
export type SubmitTarget =
  | { projectId: string; draftId: string }
  | { jigId: string; version: string };

export async function submitJig(target: SubmitTarget, note: string) {
  return z
    .object({ submission: submissionSchema })
    .passthrough()
    .parse(
      await api(
        '/jig-submissions',
        'POST',
        { ...target, note, confirm: true },
        { timeoutMs: 180_000 },
      ),
    );
}
export async function listSubmissions() {
  return listSchema.parse(await api('/jig-submissions'));
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';

/** [관리자에게 제출] with its confirmation card and note (SPEC-07.19 4). */
export function SubmitJig({
  target,
  name,
  version,
  disabled,
}: {
  target: SubmitTarget;
  name: string;
  version?: string;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false),
    [note, setNote] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const remote = remoteSession();
  const send = () => {
    setBusy(true);
    setNotice('');
    submitJig(target, note.trim())
      .then((result) => {
        setAsking(false);
        setNote('');
        setNotice(
          `제출했습니다 · ${STATUS_LABEL[result.submission.status] ?? result.submission.status}`,
        );
        window.dispatchEvent(new CustomEvent('vide:jig-submitted'));
      })
      .catch((error) =>
        setNotice(
          (error as { code?: unknown } | null)?.code === 'JIG_INVALID'
            ? SUBMIT_INVALID
            : messageOf(error),
        ),
      )
      .finally(() => setBusy(false));
  };
  return (
    <>
      <button
        type="button"
        disabled={disabled || busy || remote}
        title={remote ? '이 PC의 VIDE에서 제출하세요' : undefined}
        onClick={() => {
          setAsking((value) => !value);
          setNotice('');
        }}
        data-action="submit-jig"
      >
        관리자에게 제출
      </button>
      {remote ? <small className="kit-reason">이 PC의 VIDE에서 제출하세요</small> : null}
      {asking ? (
        <div className="kit-confirm" role="group" aria-label="관리자 제출 확인">
          <strong>
            {name}
            {version ? ` v${version}` : ''}을 관리자에게 제출합니다
          </strong>
          <span>어디로: 계정 사이트의 관리자 제출함</span>
          <span>
            영향: 관리자가 보고 공식 배포에 넣을 수 있습니다. 이 PC의 jig는 바뀌지 않고 다른 사람
            PC에 바로 설치되지 않습니다.
          </span>
          <textarea
            className="jig-submit-note"
            rows={3}
            maxLength={2000}
            value={note}
            placeholder="무엇을 바꿨는지, 왜 필요한지"
            aria-label="메모"
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="kit-actions">
            <button type="button" className="primary" disabled={busy} onClick={send}>
              {busy ? '보내는 중…' : '제출'}
            </button>
            <button type="button" disabled={busy} onClick={() => setAsking(false)}>
              취소
            </button>
          </div>
        </div>
      ) : null}
      {notice ? <small role="status">{notice}</small> : null}
    </>
  );
}

const sentAt = (at: number) =>
  new Date(at).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** 내 제출: this account's submissions as the site answers them (SPEC-07.19 7). */
export function MySubmissions() {
  const [state, setState] = useState<z.infer<typeof listSchema>>();
  const read = useCallback(() => {
    listSubmissions()
      .then(setState)
      .catch(() => setState({ linked: true, online: false, submissions: [] }));
  }, []);
  useEffect(() => {
    read();
    window.addEventListener('vide:jig-submitted', read);
    return () => window.removeEventListener('vide:jig-submitted', read);
  }, [read]);
  if (!state) return null;
  if (!state.linked)
    return <p className="jig-intro">VIDE 계정에 로그인하면 제출한 jig가 여기에 보입니다.</p>;
  if (!state.online || state.error)
    return <p className="jig-intro">계정 사이트에 연결하지 못해 제출 목록을 볼 수 없습니다.</p>;
  if (!state.submissions.length) return <p className="jig-intro">아직 제출한 jig가 없습니다.</p>;
  return (
    <ul className="make-drafts jig-submissions" aria-label="내 제출">
      {state.submissions.map((row) => (
        <li key={row.id}>
          <span>
            {row.name || row.jigId} v{row.version}
            {row.note ? <small> · {row.note.split('\n')[0].slice(0, 60)}</small> : null}
            {row.status === 'rejected' && row.reason ? (
              <small className="jig-submission-reason">반려 사유: {row.reason}</small>
            ) : null}
          </span>
          <small>
            {sentAt(row.createdAt)} ·{' '}
            <span className="pill" data-status={row.status}>
              {STATUS_LABEL[row.status] ?? row.status}
            </span>
          </small>
        </li>
      ))}
    </ul>
  );
}
