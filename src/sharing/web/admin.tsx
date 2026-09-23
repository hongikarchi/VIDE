import { useEffect, useState } from 'react';
import { z } from 'zod';
import { api, message, type Project } from './api';
const membersSchema = z.object({
  members: z.array(
    z.object({
      user_id: z.string(),
      name: z.string(),
      email: z.string(),
      role: z.enum(['owner', 'viewer', 'commenter']),
    }),
  ),
});
const requestsSchema = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      user_id: z.string(),
      name: z.string(),
      email: z.string(),
      emailVerified: z.number(),
      role: z.string(),
    }),
  ),
});
export function Admin({ project }: { project: Project }) {
  const [email, setEmail] = useState(''),
    [role, setRole] = useState('viewer'),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [link, setLink] = useState(''),
    [members, setMembers] = useState<z.infer<typeof membersSchema>['members']>([]);
  const [requests, setRequests] = useState<z.infer<typeof requestsSchema>['requests']>([]);
  const base = '/projects/' + project.id;
  async function refresh() {
    setRequests(requestsSchema.parse(await api(base + '/join-requests')).requests);
    setMembers(membersSchema.parse(await api(base + '/members')).members);
  }
  useEffect(() => {
    let active = true;
    void api(base + '/members')
      .then((value) => {
        if (active) setMembers(membersSchema.parse(value).members);
      })
      .catch((error) => {
        if (active) setStatus(message(error));
      });
    return () => {
      active = false;
    };
  }, [base]);
  useEffect(() => {
    void api(base + '/join-requests')
      .then((value) => setRequests(requestsSchema.parse(value).requests))
      .catch((error) => setStatus(message(error)));
  }, [base]);
  async function decide(id: string, decision: string) {
    setBusy(true);
    try {
      await api(base + '/join-requests/' + id, 'POST', { decision });
      await refresh();
      setStatus('참여 신청을 처리했습니다.');
    } catch (error) {
      setStatus(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function invite() {
    if (busy) return;
    setBusy(true);
    setStatus('');
    setLink('');
    try {
      const result = z
        .object({ link: z.string(), emailDelivery: z.string() })
        .parse(await api(base + '/invitations', 'POST', { email, role }));
      setLink(result.link);
      setStatus(
        result.emailDelivery === 'disabled'
          ? '링크를 전달한 뒤 신청자의 계정을 직접 확인하고 승인해 주세요.'
          : result.emailDelivery === 'submitted'
            ? '초대 발송을 요청했습니다.'
            : '메일 발송을 확인하지 못했습니다. 링크를 직접 전달할 수 있습니다.',
      );
    } catch (error) {
      setStatus(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function change(id: string, next: string) {
    setBusy(true);
    try {
      await api(
        base + '/members/' + id,
        next === 'remove' ? 'DELETE' : 'PATCH',
        next === 'remove' ? undefined : { role: next },
      );
      await refresh();
      setStatus('권한을 갱신했습니다.');
    } catch (error) {
      setStatus(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="admin">
      <summary>프로젝트 공유 관리</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void invite();
        }}
      >
        <input
          type="email"
          aria-label="초대 이메일"
          placeholder="초대할 이메일"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select aria-label="초대 역할" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="viewer">열람자</option>
          <option value="commenter">의견 작성자</option>
        </select>
        <button disabled={busy}>초대</button>
      </form>
      {link ? <a href={link}>초대 링크</a> : null}
      <button
        disabled={busy}
        onClick={() => {
          void refresh().catch((error) => setStatus(message(error)));
        }}
      >
        신청 새로고침
      </button>
      <ul>
        {requests.map((r) => (
          <li key={r.id}>
            {r.name} · {r.email} · 계정 {r.user_id} ·{' '}
            {r.emailVerified ? '이메일 확인됨' : '이메일 미확인'} · {r.role}
            <button
              disabled={busy}
              onClick={() => {
                void decide(r.id, 'approve');
              }}
            >
              참여 승인
            </button>
            <button
              disabled={busy}
              onClick={() => {
                void decide(r.id, 'reject');
              }}
            >
              거절
            </button>
          </li>
        ))}
      </ul>
      <ul>
        {members.map((member) => (
          <li key={member.user_id}>
            {member.name} · {member.email}
            {member.role === 'owner' ? (
              <small> · 소유자</small>
            ) : (
              <select
                aria-label={member.email + ' 권한'}
                disabled={busy}
                value={member.role}
                onChange={(e) => {
                  void change(member.user_id, e.target.value);
                }}
              >
                <option value="viewer">열람자</option>
                <option value="commenter">의견 작성자</option>
                <option value="remove">권한 회수</option>
              </select>
            )}
          </li>
        ))}
      </ul>
      <p role="status" className="status">
        {status}
      </p>
    </details>
  );
}
