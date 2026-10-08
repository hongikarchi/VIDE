import { useState } from 'react';
import { z } from 'zod';
import {
  COMPLIANCE_ROLES,
  COMPLIANCE_ROLE_LABELS,
  type ComplianceRoleName,
  type RoleProposal,
} from '../../contracts/compliance.ts';
import { api } from '../gateway.ts';
import { messageOf } from '../jig-panel/instance.ts';
import type { ComplianceView } from '../compliance/context.ts';
import { BLOCKING_UNUSED, roleCounts, stamp, unusedCounts } from '../compliance/model.ts';
import '../compliance/compliance.css';

// 모델 분류 카드 — panel part `compliance-roles` (SPEC-15.3·15.4·15.16, Design SCR-32, PLAN-48
// T-239): what the last 법규 체크 read (역할별 수, 쓰지 못한 객체, 형상이 바뀐 객체), the project's
// confirmed classification, and the AI's role proposals. A proposal is only a proposal: it counts
// nowhere until a person takes it ([받기] · [바꾸기] · [버리기], one group at a time, no 'take all').
// The routes are the engine's (ARCH-03 §8.6): `GET …/compliance/roles`, `POST …/compliance/proposals`
// and `POST …/compliance/proposals/:pid`. A remote screen sees the card but cannot change it.

const proposeAnswer = z
  .object({
    proposals: z.array(z.unknown()).default([]),
    rejected: z.array(z.object({ why: z.string() }).passthrough()).default([]),
  })
  .passthrough();

export function ComplianceRoles({
  projectId,
  instanceId,
  title,
  view,
}: {
  projectId: string;
  instanceId: string;
  title?: string;
  view: ComplianceView;
}) {
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string>();
  const [rejected, setRejected] = useState<string[]>([]);
  const [changing, setChanging] = useState<Record<string, ComplianceRoleName>>({});
  const result = view.read.kind === 'ok' ? view.read.result : null;
  const model = result?.inputs.model;
  const base = `/projects/${encodeURIComponent(projectId)}/compliance`;
  const proposals = (view.roles?.proposals ?? []).filter((p) => p.state === 'proposed');
  const records = view.roles?.records ?? [];

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setWarning(undefined);
    try {
      await work();
      await view.refresh();
    } catch (error) {
      setWarning(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const propose = () =>
    act(async () => {
      const answer = proposeAnswer.parse(await api(`${base}/proposals`, 'POST', { instanceId }));
      setRejected(answer.rejected.map((r) => r.why));
      if (!answer.proposals.length && !answer.rejected.length)
        setWarning('제안할 역할 없음 객체가 없거나 AI가 제안하지 않았습니다.');
    });
  const decide = (proposal: RoleProposal, action: 'accept' | 'reject', role?: ComplianceRoleName) =>
    act(async () => {
      await api(`${base}/proposals/${encodeURIComponent(proposal.id)}`, 'POST', {
        action,
        ...(role && role !== proposal.role ? { role } : {}),
      });
    });

  const roles = result ? roleCounts(result) : [];
  const unused = result ? unusedCounts(result) : [];
  const blocking = unused.filter((u) => BLOCKING_UNUSED.includes(u.reason));
  const other = unused.filter((u) => !BLOCKING_UNUSED.includes(u.reason));
  const c = result?.classification;
  return (
    <section className="kit-section cmp-roles" aria-label={title ?? '모델'}>
      <h4>
        {title ?? '모델'}
        {model ? (
          <span className="kit-muted">
            {' '}
            <span className="cmp-mono">{model.documentKey}</span> · 읽음{' '}
            {stamp(model.readAt).slice(11)}
          </span>
        ) : null}
      </h4>
      {result ? (
        <ul className="cmp-role-list" aria-label="역할별 객체 수">
          {roles.length ? (
            roles.map((r) => (
              <li key={r.role} data-role={r.role}>
                <span>{r.label}</span>
                <span>{r.count}</span>
              </li>
            ))
          ) : (
            <li className="kit-muted">역할이 정해진 객체가 없습니다</li>
          )}
        </ul>
      ) : (
        <p className="kit-muted">역할별 객체 수는 [법규 체크] 뒤에 보입니다.</p>
      )}
      {c?.aiAccepted ? (
        <p className="kit-muted">AI 제안을 사람이 받은 객체 {c.aiAccepted}</p>
      ) : null}
      {blocking.length ? (
        <p className="cmp-warn" data-unused="">
          {blocking.map((u) => `${u.reason} ${u.count}`).join(' · ')}
        </p>
      ) : null}
      {other.length ? (
        <p className="kit-muted">{other.map((u) => `${u.reason} ${u.count}`).join(' · ')}</p>
      ) : null}
      {c?.hiddenWithRole ? (
        <p className="cmp-warn">
          숨긴 역할 객체 {c.hiddenWithRole} — 포함해서 다시 체크하거나 검사에서 빼세요
        </p>
      ) : null}
      {c?.geometryChanged ? (
        <p className="kit-muted">형상이 바뀐 객체 {c.geometryChanged} · 역할은 그대로</p>
      ) : null}
      {view.roles ? (
        <p className="kit-muted" data-records="">
          확인한 분류 {records.length}개 (레이어 {records.filter((r) => r.scope === 'layer').length}{' '}
          · 객체 {records.filter((r) => r.scope === 'object').length}) · 분류 판{' '}
          {view.roles.version}
        </p>
      ) : view.rolesError ? (
        <p className="kit-muted">분류 기록을 읽지 못했습니다: {view.rolesError}</p>
      ) : null}
      {view.remote ? null : (
        <button
          type="button"
          className="cmp-text-button"
          disabled={busy}
          onClick={() => void propose()}
        >
          역할 제안 받기
        </button>
      )}
      {warning ? (
        <p className="cmp-warn" role="alert">
          {warning}
        </p>
      ) : null}
      {rejected.length ? (
        <p className="kit-muted" data-rejected="">
          버린 제안 {rejected.length}: {rejected.join(' · ')}
        </p>
      ) : null}
      {proposals.length ? (
        <ul className="cmp-proposals" aria-label="역할 제안">
          {proposals.map((proposal) => {
            const role = changing[proposal.id] ?? proposal.role;
            return (
              <li key={proposal.id} data-proposal={proposal.id}>
                <span className="cmp-tag">제안</span>
                <strong>
                  {proposal.layer || '레이어 없음'}
                  {proposal.scope === 'group' ? ' 묶음' : ''}
                </strong>{' '}
                → {COMPLIANCE_ROLE_LABELS[proposal.role]}
                {proposal.floor ? ` · ${proposal.floor}` : ''}
                {proposal.use ? ` · ${proposal.use}` : ''} · {proposal.objectIds.length}개
                <small className="kit-muted cmp-proposal-why">{proposal.reason}</small>
                {role === 'ignore' ? (
                  <small className="cmp-warn">이 객체들은 어떤 검사에도 들어가지 않음</small>
                ) : null}
                {view.remote ? null : (
                  <span className="kit-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void decide(proposal, 'accept', role)}
                    >
                      받기
                    </button>
                    <label>
                      <span className="cmp-visually-hidden">역할 바꾸기</span>
                      <select
                        value={role}
                        disabled={busy}
                        aria-label="역할 바꾸기"
                        onChange={(event) =>
                          setChanging((current) => ({
                            ...current,
                            [proposal.id]: event.currentTarget.value as ComplianceRoleName,
                          }))
                        }
                      >
                        {COMPLIANCE_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {COMPLIANCE_ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void decide(proposal, 'reject')}
                    >
                      버리기
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
