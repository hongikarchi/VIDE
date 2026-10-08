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

// 모델 분류 카드 — panel part `compliance-roles` (SPEC-15.3·15.4·15.14·15.16, Design SCR-32, PLAN-48
// T-239): what the role-check read of the linked document found (once when the panel opens, and at
// each [법규 체크]) — 역할별 수, 쓰지 못한 객체, 형상이 바뀐 객체 — the project's confirmed
// classification, a person's own role for a layer or an object, the records of objects that are no
// longer in the model, and the AI's role proposals. A proposal is only a proposal: it counts nowhere
// until a person takes it ([받기] · [역할 바꾸기] · [버리기], one group at a time, objects can be
// taken out, no 'take all'); before it is asked the card says what goes to the AI. The routes are the
// engine's (ARCH-03 §8.6). A remote screen sees the card but cannot change it.

const proposeAnswer = z
  .object({
    proposals: z.array(z.unknown()).default([]),
    rejected: z
      .array(z.object({ why: z.string(), text: z.string().optional() }).passthrough())
      .default([]),
  })
  .passthrough();

/** Reasons an object has no usable role that a person can settle here (SPEC-15.9 7). */
const SETTLE = new Set([
  '역할 없음',
  '역할과 모양이 맞지 않음',
  '닫히지 않음',
  '평면이 아님',
  '숨김',
]);
const MAX_LISTED = 40;

const RoleSelect = ({
  value,
  onChange,
  disabled,
  label,
}: {
  value: ComplianceRoleName | '';
  onChange: (role: ComplianceRoleName) => void;
  disabled: boolean;
  label: string;
}) => (
  <select
    value={value}
    disabled={disabled}
    aria-label={label}
    onChange={(event) => onChange(event.currentTarget.value as ComplianceRoleName)}
  >
    {value === '' ? <option value="">역할 고르기</option> : null}
    {COMPLIANCE_ROLES.map((r) => (
      <option key={r} value={r}>
        {COMPLIANCE_ROLE_LABELS[r]}
      </option>
    ))}
  </select>
);

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
  const [notice, setNotice] = useState<string>();
  const [rejected, setRejected] = useState<string[]>([]);
  const [changing, setChanging] = useState<Record<string, ComplianceRoleName>>({});
  const [excluded, setExcluded] = useState<Record<string, string[]>>({});
  const [asking, setAsking] = useState(false);
  const [layerRole, setLayerRole] = useState<Record<string, ComplianceRoleName>>({});
  const [objectRole, setObjectRole] = useState<Record<string, ComplianceRoleName>>({});
  const result = view.read.kind === 'ok' ? view.read.result : null;
  const model = result?.inputs.model;
  const read = view.documentRead;
  const base = `/projects/${encodeURIComponent(projectId)}/compliance`;
  const proposals = (view.roles?.proposals ?? []).filter((p) => p.state === 'proposed');
  const records = view.roles?.records ?? [];

  const act = async (work: () => Promise<void>, again = false) => {
    setBusy(true);
    setWarning(undefined);
    setNotice(undefined);
    try {
      await work();
      await view.refresh();
      if (again) await view.readDocument(true);
    } catch (error) {
      setWarning(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const propose = () =>
    act(async () => {
      setAsking(false);
      const answer = proposeAnswer.parse(await api(`${base}/proposals`, 'POST', { instanceId }));
      // The AI did not answer: not a discarded proposal — the person sets roles here.
      const failed = answer.rejected.find((r) => r.why === 'AI_FAILED');
      if (failed)
        setNotice(failed.text ?? 'AI 제안을 받지 못했습니다. 역할은 직접 정할 수 있습니다.');
      const dropped = answer.rejected.filter((r) => r.why !== 'AI_FAILED');
      setRejected(dropped.map((r) => r.text ?? r.why));
      if (!answer.proposals.length && !answer.rejected.length)
        setNotice('제안할 역할 없음 객체가 없거나 AI가 제안하지 않았습니다.');
    });
  const decide = (proposal: RoleProposal, action: 'accept' | 'reject', role?: ComplianceRoleName) =>
    act(async () => {
      await api(`${base}/proposals/${encodeURIComponent(proposal.id)}`, 'POST', {
        action,
        ...(role && role !== proposal.role ? { role } : {}),
        ...(action === 'accept' && excluded[proposal.id]?.length
          ? { exclude: excluded[proposal.id] }
          : {}),
      });
    }, action === 'accept');
  const setRecords = (
    body: {
      set?: { scope: 'layer' | 'object'; key: string; role: ComplianceRoleName }[];
      remove?: { scope: 'layer' | 'object'; key: string }[];
    },
    again = true,
  ) =>
    act(async () => {
      if (!read) return;
      await api(`${base}/roles`, 'PUT', {
        documentKey: read.documentKey,
        set: body.set ?? [],
        remove: body.remove ?? [],
        instanceId,
      });
    }, again);

  // Counts: the result's when there is one, else the last role-check read's.
  const roles = result
    ? roleCounts(result)
    : read
      ? COMPLIANCE_ROLES.flatMap((role) =>
          read.byRole[role]
            ? [{ role, label: COMPLIANCE_ROLE_LABELS[role], count: read.byRole[role] }]
            : [],
        )
      : [];
  const unused = result
    ? unusedCounts(result)
    : read
      ? Object.entries(read.unusedByReason)
          .filter(([, count]) => count > 0)
          .map(([reason, count]) => ({ reason, count }))
      : [];
  const blocking = unused.filter((u) => BLOCKING_UNUSED.includes(u.reason));
  const other = unused.filter((u) => !BLOCKING_UNUSED.includes(u.reason));
  const c = result?.classification ?? read;
  // What a person can settle here: objects without a usable role, by layer.
  const open = (read?.rows ?? []).filter((r) => r.reason && SETTLE.has(r.reason));
  const openLayers = [...new Set(open.map((r) => r.layer))].sort();
  const roleless = open.filter((r) => r.reason === '역할 없음');
  const sendLayers = [...new Set(roleless.map((r) => r.layer))].sort();
  const missing = (read?.missingRecords ?? []) as { key: string; role: string }[];
  const canPropose = !!read && !view.documentReading;
  const proposeWhy = view.documentReading
    ? '모델을 읽는 중입니다'
    : view.documentReadError
      ? `모델을 읽지 못했습니다: ${view.documentReadError}`
      : !read
        ? '모델을 읽은 뒤에 제안받을 수 있습니다'
        : !roleless.length
          ? '역할 없는 객체가 없습니다'
          : '';
  return (
    <section className="kit-section cmp-roles" aria-label={title ?? '모델'}>
      <h4>
        {title ?? '모델'}
        {model || read ? (
          <span className="kit-muted">
            {' '}
            <span className="cmp-mono">{(model ?? read)!.documentKey}</span> · 읽음{' '}
            {stamp((read ?? model)!.readAt).slice(11)}
          </span>
        ) : null}
      </h4>
      {result || read ? (
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
        <p className="kit-muted" data-document-read="">
          {view.documentReading
            ? '모델을 읽는 중…'
            : view.documentReadError
              ? `모델을 읽지 못했습니다: ${view.documentReadError}`
              : view.remote
                ? '역할별 객체 수는 작업 PC의 [법규 체크] 뒤에 보입니다.'
                : '역할별 객체 수는 모델을 읽은 뒤에 보입니다.'}
        </p>
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
      {!view.remote && missing.length ? (
        <p className="kit-muted" data-missing-records="">
          모델에 없는 객체의 기록 {missing.length}개{' '}
          <button
            type="button"
            className="cmp-text-button"
            disabled={busy}
            onClick={() =>
              void setRecords({
                remove: missing.map((m) => ({ scope: 'object' as const, key: m.key })),
              })
            }
          >
            기록 지우기
          </button>
        </p>
      ) : null}
      {view.remote ? null : (
        <>
          <button
            type="button"
            className="cmp-text-button"
            disabled={busy || !canPropose || !roleless.length}
            title={proposeWhy || undefined}
            aria-expanded={asking}
            onClick={() => setAsking((v) => !v)}
          >
            역할 제안 받기
          </button>
          {proposeWhy && !busy ? (
            <small className="kit-muted" data-propose-why="">
              {' '}
              {proposeWhy}
            </small>
          ) : null}
          {asking && canPropose && roleless.length ? (
            <div className="cmp-send" role="group" aria-label="AI에 보낼 내용" data-send="">
              <p>
                레이어 이름 {sendLayers.length}개와 역할 없는 객체 {roleless.length}개의 묶음
                요약(레이어 · 객체 종류 · 닫힘 · 수평 · 크기 구간 · 높이 구간 · 개수 · 속성 이름,
                좌표 없음)을 AI에 보냅니다. AI는 역할을 제안만 하고, 받기 전에는 계산에 들어가지
                않습니다.
              </p>
              <ul className="cmp-send-list">
                {sendLayers.slice(0, MAX_LISTED).map((layer) => (
                  <li key={layer} className="cmp-mono">
                    {layer || '(레이어 없음)'}
                  </li>
                ))}
                {sendLayers.length > MAX_LISTED ? (
                  <li className="kit-muted">외 {sendLayers.length - MAX_LISTED}개</li>
                ) : null}
              </ul>
              <span className="kit-actions">
                <button type="button" disabled={busy} onClick={() => void propose()}>
                  보내고 제안 받기
                </button>
                <button type="button" disabled={busy} onClick={() => setAsking(false)}>
                  취소
                </button>
              </span>
            </div>
          ) : null}
        </>
      )}
      {warning ? (
        <p className="cmp-warn" role="alert">
          {warning}
        </p>
      ) : null}
      {notice ? (
        <p className="kit-muted" role="status" data-notice-roles="">
          {notice}
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
            const out = new Set(excluded[proposal.id] ?? []);
            return (
              <li key={proposal.id} data-proposal={proposal.id}>
                <span className="cmp-tag">제안</span>
                <strong>
                  {proposal.layer || '레이어 없음'}
                  {proposal.scope === 'group' ? ' 묶음' : ''}
                </strong>{' '}
                → {COMPLIANCE_ROLE_LABELS[proposal.role]}
                {proposal.floor ? ` · ${proposal.floor}` : ''}
                {proposal.use ? ` · ${proposal.use}` : ''} · {proposal.objectIds.length - out.size}
                개{out.size ? ` (뺀 객체 ${out.size})` : ''}
                <small className="kit-muted cmp-proposal-why">{proposal.reason}</small>
                <small className="kit-muted">
                  받으면 이 제안의 객체에만 역할이 붙습니다(레이어의 다른 객체·나중 객체는 그대로)
                </small>
                {role === 'ignore' ? (
                  <small className="cmp-warn">이 객체들은 어떤 검사에도 들어가지 않음</small>
                ) : null}
                {view.remote ? null : (
                  <>
                    <details className="cmp-exclude">
                      <summary>객체 빼기</summary>
                      <ul>
                        {proposal.objectIds.slice(0, MAX_LISTED * 5).map((id) => (
                          <li key={id}>
                            <label>
                              <input
                                type="checkbox"
                                checked={!out.has(id)}
                                disabled={busy}
                                onChange={(event) => {
                                  const keep = event.currentTarget.checked;
                                  setExcluded((current) => {
                                    const next = new Set(current[proposal.id] ?? []);
                                    if (keep) next.delete(id);
                                    else next.add(id);
                                    return { ...current, [proposal.id]: [...next] };
                                  });
                                }}
                              />{' '}
                              <span className="cmp-mono">{id.slice(0, 8)}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </details>
                    <span className="kit-actions">
                      <button
                        type="button"
                        disabled={busy || out.size >= proposal.objectIds.length}
                        onClick={() => void decide(proposal, 'accept', role)}
                      >
                        받기
                      </button>
                      <label>
                        <span className="cmp-visually-hidden">역할 바꾸기</span>
                        <RoleSelect
                          value={role}
                          disabled={busy}
                          label="역할 바꾸기"
                          onChange={(next) =>
                            setChanging((current) => ({ ...current, [proposal.id]: next }))
                          }
                        />
                      </label>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide(proposal, 'reject')}
                      >
                        버리기
                      </button>
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!view.remote && read && open.length ? (
        <details className="cmp-own" data-own-roles="">
          <summary>역할 직접 정하기 ({open.length})</summary>
          <p className="kit-muted">
            레이어에 정하면 그 레이어와 하위 레이어의 모든 객체(나중에 그린 객체 포함)에 붙습니다.
          </p>
          <ul aria-label="레이어 역할">
            {openLayers.slice(0, MAX_LISTED).map((layer) => (
              <li key={layer} data-own-layer={layer}>
                <span className="cmp-mono">{layer || '(레이어 없음)'}</span>{' '}
                <RoleSelect
                  value={layerRole[layer] ?? ''}
                  disabled={busy}
                  label={`${layer} 레이어 역할`}
                  onChange={(role) => setLayerRole((current) => ({ ...current, [layer]: role }))}
                />
                <button
                  type="button"
                  disabled={busy || !layerRole[layer]}
                  onClick={() =>
                    void setRecords({
                      set: [{ scope: 'layer', key: layer, role: layerRole[layer] }],
                    })
                  }
                >
                  정하기
                </button>
              </li>
            ))}
          </ul>
          <ul aria-label="객체 역할">
            {open.slice(0, MAX_LISTED).map((row) => (
              <li key={row.objectId} data-own-object={row.objectId}>
                <span className="cmp-mono">{row.objectId.slice(0, 8)}</span>{' '}
                <span className="kit-muted">
                  {row.layer} · {row.reason}
                </span>{' '}
                <RoleSelect
                  value={objectRole[row.objectId] ?? ''}
                  disabled={busy}
                  label={`객체 ${row.objectId.slice(0, 8)} 역할`}
                  onChange={(role) =>
                    setObjectRole((current) => ({ ...current, [row.objectId]: role }))
                  }
                />
                <button
                  type="button"
                  disabled={busy || !objectRole[row.objectId]}
                  onClick={() =>
                    void setRecords({
                      set: [{ scope: 'object', key: row.objectId, role: objectRole[row.objectId] }],
                    })
                  }
                >
                  정하기
                </button>
              </li>
            ))}
            {open.length > MAX_LISTED ? (
              <li className="kit-muted">외 {open.length - MAX_LISTED}개 — 레이어로 정하세요</li>
            ) : null}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
