// Site admins' jig submission box (ADR-041, SPEC-04.13, Design SCR-27): packs that users sent from
// VIDE, with the note, the SHA-256 the site computed, a download, the command that unpacks the
// pack into the repository, and the status (받음 → 검토 중 → 반영됨 | 반려 with a reason).
import { Fragment, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { api, message } from './api';

const STATUS_LABEL = {
  received: '받음',
  reviewing: '검토 중',
  applied: '반영됨',
  rejected: '반려',
} as const;
type Status = keyof typeof STATUS_LABEL;
const submissionSchema = z.object({
  id: z.string(),
  jigId: z.string(),
  version: z.string(),
  name: z.string(),
  note: z.string(),
  size: z.number(),
  sha256: z.string(),
  status: z.enum(['received', 'reviewing', 'applied', 'rejected']),
  reason: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  pc: z.string().nullable(),
  submitter: z.string().optional(),
});
type Submission = z.infer<typeof submissionSchema>;
const listSchema = z.object({ submissions: z.array(submissionSchema) });

const size = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
const fileName = (s: Submission) =>
  `${s.jigId.split('/')[1]}@${s.version}-${s.sha256.slice(0, 8)}.vjig`;
const command = (s: Submission) => `npm run jig:unpack -- ${fileName(s)} --digest ${s.sha256}`;

function Detail({ submission, changed }: { submission: Submission; changed: () => void }) {
  const [status, setStatus] = useState<Status>(submission.status),
    [reason, setReason] = useState(submission.reason ?? ''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState(false);
  const save = async () => {
    setBusy(true);
    setNotice('');
    try {
      await api(`/admin/jigs/${encodeURIComponent(submission.id)}/status`, 'POST', {
        status,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      changed();
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/admin/jigs/${encodeURIComponent(submission.id)}`, 'DELETE');
      changed();
    } catch (error) {
      setNotice(message(error));
      setBusy(false);
    }
  };
  return (
    <div className="jig-box-detail">
      <p className="jig-box-note">{submission.note || '메모 없음'}</p>
      <p>
        SHA-256 <code>{submission.sha256}</code>
      </p>
      <p>
        저장소에 풀기 <code>{command(submission)}</code>{' '}
        <button
          className="ghost"
          onClick={() => void navigator.clipboard?.writeText(command(submission)).catch(() => {})}
        >
          명령 복사
        </button>
      </p>
      <p>
        <a
          className="reports-csv"
          href={`/api/admin/jigs/${encodeURIComponent(submission.id)}/pack`}
          download={fileName(submission)}
        >
          묶음 내려받기
        </a>
      </p>
      <div className="reports-filters">
        <label>
          상태
          <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          사유{status === 'rejected' ? ' (필수)' : ''}
          <input
            value={reason}
            maxLength={500}
            placeholder="반려할 때 이유"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={busy || (status === 'rejected' && !reason.trim())}
          onClick={() => void save()}
        >
          상태 저장
        </button>
        {deleting ? (
          <>
            <button className="danger" disabled={busy} onClick={() => void remove()}>
              정말 삭제
            </button>
            <button className="ghost" onClick={() => setDeleting(false)}>
              취소
            </button>
          </>
        ) : (
          <button className="ghost" onClick={() => setDeleting(true)}>
            삭제
          </button>
        )}
      </div>
      {notice ? (
        <p role="alert" className="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

export function AdminJigs() {
  const [filter, setFilter] = useState(''),
    [rows, setRows] = useState<Submission[]>([]),
    [open, setOpen] = useState(''),
    [status, setStatus] = useState(''),
    [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    setStatus('');
    try {
      setRows(
        listSchema.parse(await api('/admin/jigs' + (filter ? '?status=' + filter : '')))
          .submissions,
      );
    } catch (error) {
      setStatus(message(error));
    } finally {
      setLoaded(true);
    }
  }, [filter]);
  useEffect(() => {
    void refresh();
    // The filter applies with [보기]; the first load shows everything.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="reports-page" aria-label="jig 제출함">
      <h1>jig 제출함</h1>
      <p className="reports-note">
        사용자가 VIDE에서 보낸 jig 묶음입니다. 내려받아 저장소에서 확인한 뒤 공식 배포에 넣습니다.
      </p>
      <form
        className="reports-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void refresh();
        }}
      >
        <label>
          상태
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">전체</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button className="primary">보기</button>
      </form>
      {status ? (
        <p role="alert" className="status">
          {status}
        </p>
      ) : null}
      <table className="reports-table" aria-label="받은 jig">
        <thead>
          <tr>
            <th>보낸 시각</th>
            <th>제출자</th>
            <th>jig</th>
            <th>버전</th>
            <th>크기</th>
            <th>상태</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={row.id}>
              <tr>
                <td>{new Date(row.createdAt).toLocaleString('ko-KR')}</td>
                <td>
                  {row.submitter ?? ''}
                  {row.pc ? ` · ${row.pc}` : ''}
                </td>
                <td>
                  {row.name}
                  <br />
                  <small>{row.jigId}</small>
                </td>
                <td>{row.version}</td>
                <td>{size(row.size)}</td>
                <td>
                  <span className="jig-box-status" data-status={row.status}>
                    {STATUS_LABEL[row.status]}
                  </span>
                  {row.status === 'rejected' && row.reason ? (
                    <>
                      <br />
                      <small>{row.reason}</small>
                    </>
                  ) : null}
                </td>
                <td>
                  <button className="ghost" onClick={() => setOpen(open === row.id ? '' : row.id)}>
                    {open === row.id ? '접기' : '자세히'}
                  </button>
                </td>
              </tr>
              {open === row.id ? (
                <tr>
                  <td colSpan={7}>
                    <Detail
                      key={row.updatedAt}
                      submission={row}
                      changed={() => {
                        void refresh();
                      }}
                    />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
      {loaded && !rows.length && !status ? <p className="empty">받은 제출이 없습니다.</p> : null}
    </section>
  );
}
