// 보고용 게시 — [공유] (PLAN-54 T-343, Design SCR-43, SPEC-07.11 공유 경로 둘, SPEC-04.14,
// SPEC-05.11): in the 보고용 head (report-tab.tsx mounts it into #report-publish-slot). The choice
// is the VIDE 공유 사이트 password link (default) or the user's own Cloudflare account (only when
// connected). The password is made here once per 보고용 (12 characters), shown before the first
// [게시] and after [다시 만들기] only; after a publish it is never shown again. [다시 게시] keeps
// it. Failures are one red line in plain Korean; nothing here shows a token or a raw answer.
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, errors } from './gateway.ts';
import { statusState } from './store/status.ts';
import { useStore } from './store/core.ts';
import type { PublishSlotMount } from './report-tab.tsx';
import './publish-card.css';

type Target = 'vide-site' | 'cloudflare';
interface PublishRecord {
  target: Target;
  url: string;
  workerName?: string;
  publishedAt: string;
  passwordSet: boolean;
  revokedAt?: string;
}
interface PublishState {
  published: PublishRecord | null;
  passwordKept: boolean;
  defaultSiteName: string;
  siteLinked: boolean;
}

/** Letters and digits that are hard to mix up when read aloud or typed from a phone. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export function makePassword(length = 12): string {
  const out: string[] = [];
  const bytes = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      // Rejection sampling keeps every character equally likely.
      if (b < 256 - (256 % ALPHABET.length) && out.length < length)
        out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return out.join('');
}

/** '10-15 14:31' (Design SCR-43). */
export function shortStamp(iso: string | undefined): string {
  const at = new Date(iso ?? '');
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const FAILURE: Record<string, string> = {
  ACCOUNT_NOT_CONNECTED: '연결된 Cloudflare 계정이 없습니다',
  ACCOUNT_SCOPE: '이 토큰으로는 올릴 수 없습니다 — Workers 편집 권한이 필요합니다',
  SERVICE_UNREACHABLE: '서비스에 닿지 않습니다 · 잠시 뒤 다시 시도하세요',
};
/** The red line for a failed [게시]/[내리기] (Design SCR-43 실패). */
export function failureText(error: unknown, target: Target): string {
  const code = String((error as { code?: unknown } | undefined)?.code ?? '');
  const message = error instanceof Error ? error.message : '';
  if (code === 'PUBLISH_FAILED' && message.startsWith('올리지 못했습니다')) return message;
  if (target === 'cloudflare' && FAILURE[code]) return FAILURE[code];
  if (code === 'SERVICE_UNREACHABLE') return FAILURE.SERVICE_UNREACHABLE;
  return errors[code] ?? '올리지 못했습니다 — 잠시 뒤 다시 시도하세요';
}

const live = (record: PublishRecord | null | undefined): record is PublishRecord =>
  !!record && !record.revokedAt;
const QUIET = [
  'ACCOUNT_NOT_CONNECTED',
  'ACCOUNT_NOT_LINKED',
  'ACCOUNT_SCOPE',
  'SERVICE_UNREACHABLE',
  'PUBLISH_FAILED',
  'PUBLISH_TARGET_LIVE',
  'PUBLISH_NAME_LIVE',
  'PUBLISH_PASSWORD_REQUIRED',
  'INVALID_SITE_NAME',
  'INVALID_PASSWORD',
  'INVALID_PUBLISH_FILES',
  'PUBLISH_TOO_LARGE',
  'NOT_PUBLISHED',
];

export function PublishCard({ projectId, outputName }: { projectId: string; outputName: string }) {
  const path = `/projects/${encodeURIComponent(projectId)}/outputs/${encodeURIComponent(outputName)}`;
  const [state, setState] = useState<PublishState>();
  const [cloudflare, setCloudflare] = useState(false);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Target>('vide-site');
  const [siteName, setSiteName] = useState('');
  // The password stays in this card only until a publish succeeds.
  const [password, setPassword] = useState<string>();
  const [stage, setStage] = useState<'upload' | 'check'>();
  const [confirmDown, setConfirmDown] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [copied, setCopied] = useState<string>();
  // The site answered that it takes no new uploads now (ADR-038 staging switch): say so up front.
  const [siteClosed, setSiteClosed] = useState(false);
  // A remote session sees the result line only (SPEC-05.11: 원격 세션은 상태만 본다).
  const remote = useStore(statusState, (s) => s.remote);

  const load = useCallback(async () => {
    const next = (await api(path + '/publish')) as PublishState;
    setState(next);
    return next;
  }, [path]);
  useEffect(() => {
    let gone = false;
    void load()
      .then((next) => {
        if (gone) return;
        const record = next.published;
        if (live(record)) setTarget(record.target);
        setSiteName(record?.workerName ?? next.defaultSiteName);
        // A 보고용 that has never had a password gets one now (shown until the first [게시]).
        if (!next.passwordKept && !live(record)) setPassword(makePassword());
      })
      .catch(() => {});
    void api('/settings/services', 'GET', undefined, { quiet: ['FORBIDDEN'] })
      .then((view) => {
        const status = (view as { cloudflare?: { status?: string } } | undefined)?.cloudflare
          ?.status;
        if (!gone) setCloudflare(status === 'connected');
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [load]);
  // The VIDE site cannot take it here (no account on this PC, or the site takes no uploads now)
  // and Cloudflare is connected: start on the one that can work (nothing live is moved).
  useEffect(() => {
    if (!state || live(state.published) || !cloudflare) return;
    if (!state.siteLinked || siteClosed) setTarget('cloudflare');
  }, [state, cloudflare, siteClosed]);

  const record = state?.published ?? null;
  const isLive = live(record);
  const again = isLive && record.target === target;
  const otherLive = isLive && record.target !== target;
  const busy = !!stage;

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(what),
      () => setCopied(undefined),
    );
  };
  const publish = async () => {
    setFailure(undefined);
    setStage('upload');
    try {
      await api(
        path + '/publish',
        'POST',
        {
          target,
          ...(target === 'cloudflare' && siteName.trim() ? { siteName: siteName.trim() } : {}),
          ...(password ? { password } : {}),
        },
        { quiet: QUIET },
      );
      setStage('check');
      await load();
      // Published: the password is not shown again (it is sealed on this PC, hashed on the site).
      setPassword(undefined);
      setOpen(false);
    } catch (error) {
      const text = failureText(error, target);
      if (target === 'vide-site' && text.includes('새 업로드를 받지 않습니다')) setSiteClosed(true);
      setFailure(text);
    } finally {
      setStage(undefined);
    }
  };
  const unpublish = async () => {
    setFailure(undefined);
    setConfirmDown(false);
    setStage('upload');
    try {
      await api(path + '/unpublish', 'POST', {}, { quiet: QUIET });
      await load();
    } catch (error) {
      setFailure(failureText(error, record?.target ?? target));
    } finally {
      setStage(undefined);
    }
  };

  const subdomain =
    record?.target === 'cloudflare'
      ? /^https:\/\/[^.]+\.([^.]+)\.workers\.dev/.exec(record.url)?.[1]
      : undefined;

  if (remote)
    return isLive ? (
      <div className="publish-card" data-publish-card="">
        <p className="publish-result" data-publish-result="">
          <span className="publish-url">{record.url}</span>
          {record.passwordSet ? <span>비밀번호 설정됨</span> : null}
          <span>{shortStamp(record.publishedAt)}</span>
        </p>
      </div>
    ) : null;

  return (
    <div className="publish-card" data-publish-card="">
      <div className="publish-row">
        <button
          type="button"
          className="secondary"
          aria-expanded={open}
          id="publish-open"
          onClick={() => setOpen((v) => !v)}
        >
          공유
        </button>
      </div>
      {isLive ? (
        <p className="publish-result" data-publish-result="">
          <span className="publish-url">{record.url}</span>
          <button type="button" className="link-button" onClick={() => copy(record.url, 'url')}>
            {copied === 'url' ? '복사됨' : '복사'}
          </button>
          <a className="link-button" href={record.url} target="_blank" rel="noopener noreferrer">
            열기
          </a>
          {record.passwordSet ? <span>비밀번호 설정됨</span> : null}
          <span>{shortStamp(record.publishedAt)}</span>
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => setConfirmDown(true)}
          >
            내리기
          </button>
        </p>
      ) : null}
      {confirmDown ? (
        <div className="publish-confirm" role="dialog" aria-label="내리기">
          <p>주소가 더 이상 열리지 않습니다. 폴더의 보고용은 그대로입니다.</p>
          <button type="button" className="primary" onClick={() => void unpublish()}>
            내리기
          </button>
          <button type="button" className="secondary" onClick={() => setConfirmDown(false)}>
            취소
          </button>
        </div>
      ) : null}
      {open ? (
        <div className="publish-panel" role="group" aria-label="공유">
          <label className="publish-choice">
            <input
              type="radio"
              name={`publish-target-${outputName}`}
              checked={target === 'vide-site'}
              disabled={busy}
              onChange={() => setTarget('vide-site')}
            />
            <span>
              VIDE 공유 사이트 · 비밀번호 링크(기본)
              {record?.target === 'vide-site' && isLive ? (
                <small> · 올림 · {shortStamp(record.publishedAt)}</small>
              ) : null}
              {state && !state.siteLinked ? (
                <small className="publish-hint">
                  VIDE 계정에 로그인한 PC에서만 게시할 수 있습니다
                </small>
              ) : null}
              {siteClosed ? (
                <small className="publish-hint">
                  사이트가 지금 새 업로드를 받지 않습니다
                  {cloudflare ? ' — 내 Cloudflare 계정으로 게시할 수 있습니다' : ''}
                </small>
              ) : null}
            </span>
          </label>
          <label className="publish-choice" data-disabled={String(!cloudflare)}>
            <input
              type="radio"
              name={`publish-target-${outputName}`}
              checked={target === 'cloudflare'}
              disabled={busy || !cloudflare}
              onChange={() => setTarget('cloudflare')}
            />
            <span>
              내 Cloudflare 계정
              {record?.target === 'cloudflare' && isLive ? (
                <small> · 올림 · {shortStamp(record.publishedAt)}</small>
              ) : null}
              {!cloudflare ? (
                <small className="publish-hint">
                  설정 → 외부 서비스에서 Cloudflare를 연결하세요{' '}
                  <button
                    type="button"
                    className="link-button"
                    onClick={(event) => statusState.actions.open(event.currentTarget, 'services')}
                  >
                    외부 서비스 열기
                  </button>
                </small>
              ) : null}
            </span>
          </label>
          {target === 'cloudflare' ? (
            <div className="publish-field">
              <label htmlFor="publish-site-name">사이트 이름</label>
              <input
                id="publish-site-name"
                value={siteName}
                spellCheck={false}
                disabled={busy}
                // A live site keeps its name: renaming it means [내리기] first (one address).
                readOnly={again}
                onChange={(event) => setSiteName(event.target.value.toLowerCase())}
              />
              <small>
                주소: {siteName || '…'}.{subdomain ?? '<계정>'}.workers.dev
                {again ? ' · 이름을 바꾸려면 먼저 [내리기]' : ''}
              </small>
            </div>
          ) : null}
          {password !== undefined ? (
            <div className="publish-field">
              <label htmlFor="publish-password">비밀번호</label>
              <span className="publish-password-row">
                <input id="publish-password" value={password} readOnly spellCheck={false} />
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => setPassword(makePassword())}
                >
                  다시 만들기
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => copy(password, 'password')}
                >
                  {copied === 'password' ? '복사됨' : '복사'}
                </button>
              </span>
              <small>게시 뒤에는 다시 보이지 않습니다</small>
            </div>
          ) : (
            <p className="publish-note">
              {again
                ? '이전 게시를 덮습니다. 비밀번호는 그대로입니다'
                : '이전에 만든 비밀번호를 그대로 씁니다'}{' '}
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => setPassword(makePassword())}
              >
                다시 만들기
              </button>
            </p>
          )}
          {otherLive ? (
            <p className="publish-note">
              다른 곳에 올린 게시가 있습니다 — 먼저 [내리기]를 누르세요
            </p>
          ) : null}
          {stage ? (
            <p className="publish-progress" role="status">
              <span data-done={String(stage === 'check')}>올리는 중…</span>
              {stage === 'check' ? <span>주소 확인 중…</span> : null}
            </p>
          ) : (
            <button
              type="button"
              className="primary"
              id="publish-submit"
              disabled={!state || otherLive || (target === 'cloudflare' && !cloudflare)}
              onClick={() => void publish()}
            >
              {again ? '다시 게시' : '게시'}
            </button>
          )}
        </div>
      ) : null}
      {failure ? (
        <p className="publish-failure" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

/** Mounts the card into report-tab's [공유] slot (setPublishSlotMount / mountPublishSlot). */
export const mountPublishCard: PublishSlotMount = (el, context) => {
  const root = createRoot(el);
  root.render(<PublishCard projectId={context.projectId} outputName={context.outputName} />);
  // Unmount after the parent's render finishes (a root may not unmount during one).
  return () => void setTimeout(() => root.unmount(), 0);
};
