import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { api } from '../gateway.ts';
import { messageOf, type InstanceState } from './instance.ts';

// 앞 jig의 결과 — panel part `jig-source` (SPEC-07.2·07.5 6, PLAN-45 T-213, Design §14): a
// `jig-output` input reads one earlier instance of another jig in this project. The card says which
// one (작업본 · 계산 시각), why it cannot be read yet, and '다시 계산 필요' when that result moved
// after this instance last computed; the person may pick another instance or go back to the
// latest computed one. Values come from `…/jig-outputs/:key`; the steps recompute after a change.

const info = z
  .object({
    instanceId: z.string(),
    title: z.string(),
    jig: z.string(),
    version: z.string(),
    status: z.string(),
    at: z.string().nullable(),
    reason: z.string().optional(),
  })
  .passthrough();
const stateSchema = z
  .object({
    input: z.object({ key: z.string(), title: z.string() }).passthrough(),
    chosen: z.object({ instanceId: z.string() }).passthrough().nullable(),
    current: info.nullable(),
    ready: z.boolean(),
    reason: z.string().nullable(),
    candidates: z.array(
      z
        .object({
          instanceId: z.string(),
          title: z.string(),
          at: z.string().nullable(),
          ready: z.boolean(),
          reason: z.string().optional(),
        })
        .passthrough(),
    ),
    stale: z.boolean(),
  })
  .passthrough();
type SourceState = z.infer<typeof stateSchema>;

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('ko-KR', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

export function JigSource({
  projectId,
  instanceId,
  inputKey,
  title,
  jig,
}: {
  projectId: string;
  instanceId: string;
  inputKey: string;
  title?: string;
  jig: InstanceState;
}) {
  const path = `/projects/${encodeURIComponent(projectId)}/jig-instances/${encodeURIComponent(instanceId)}/jig-outputs/${encodeURIComponent(inputKey)}`;
  const [state, setState] = useState<SourceState>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const read = useCallback(async () => {
    try {
      setState(stateSchema.parse(await api(path)));
    } catch (error) {
      setMessage(messageOf(error));
    }
  }, [path]);
  const revision = jig.lastRun?.getTime();
  useEffect(() => {
    void read();
  }, [read, revision]);

  const choose = async (sourceId: string | null) => {
    setBusy(true);
    setMessage(undefined);
    try {
      setState(stateSchema.parse(await api(path, 'PUT', { instanceId: sourceId })));
      await jig.recompute();
    } catch (error) {
      setMessage(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const label = title ?? state?.input.title ?? '앞 jig의 결과';
  const current = state?.current;
  return (
    <section
      className="kit-section jig-source"
      aria-label={label}
      data-ready={state ? String(state.ready) : undefined}
      data-stale={state?.stale ? 'true' : undefined}
    >
      <h4>{label}</h4>
      {!state ? (
        <p className="kit-muted" role="status">
          {message ?? '앞 결과를 읽는 중'}
        </p>
      ) : (
        <>
          {current ? (
            <p className="jig-source-current">
              <strong>{current.title}</strong>
              <span className="kit-muted">
                {' '}
                · {current.jig.replace(/^vide\//, '')} {current.version} · 계산 {when(current.at)}
              </span>
            </p>
          ) : null}
          {!state.ready ? (
            <p className="kit-notice" role="status">
              {state.reason ?? '앞 결과를 받을 수 없습니다'}
            </p>
          ) : null}
          {state.stale ? (
            <p className="kit-notice" role="status" data-stale-note="">
              다시 계산 필요 — 앞 작업본의 결과가 이 작업본을 계산한 뒤에 바뀌었습니다.{' '}
              <button type="button" disabled={busy} onClick={() => void jig.recompute()}>
                다시 계산
              </button>
            </p>
          ) : null}
          <label className="jig-source-pick">
            앞 작업본{' '}
            <select
              value={state.chosen?.instanceId ?? ''}
              disabled={busy}
              onChange={(event) => void choose(event.currentTarget.value || null)}
            >
              <option value="">최근 계산된 작업본(자동)</option>
              {state.candidates.map((c) => (
                <option key={c.instanceId} value={c.instanceId}>
                  {c.title}
                  {c.ready ? ` · ${when(c.at)}` : ' · 받을 수 없음'}
                </option>
              ))}
            </select>
          </label>
          {message ? (
            <p className="kit-muted" role="alert">
              {message}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
