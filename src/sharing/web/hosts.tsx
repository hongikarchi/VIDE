import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { api } from './api';

// Work PCs signed in with this account. An online PC runs VIDE with Rhino/CAD attached and does
// all the work. A browser on that same PC opens it locally; other devices go through its tunnel.
export const hostsSchema = z.object({
  hosts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      online: z.boolean(),
      remote: z.boolean().default(false),
      local: z.string().nullable().default(null),
      lastSeen: z.number().nullable(),
      version: z.string().nullable().default(null),
      updateRequired: z.boolean().default(false),
      status: z
        .object({
          documents: z
            .array(z.object({ host: z.string(), name: z.string(), live: z.boolean() }))
            .optional(),
        })
        .passthrough()
        .catch({}),
    }),
  ),
});
export type Host = z.infer<typeof hostsSchema>['hosts'][number];

const THIS_PC = 'vide:this-pc';
function remembered() {
  try {
    return sessionStorage.getItem(THIS_PC) || '';
  } catch {
    return '';
  }
}
/** Ask a PC's local address whether it is this browser's own PC (it answers with its id). */
async function probe(host: Host) {
  if (!host.local) return false;
  try {
    const response = await fetch(host.local + '/api/v1/hello', {
      signal: AbortSignal.timeout(4000),
      credentials: 'omit',
    });
    const reply = z.object({ hostId: z.string() }).parse(await response.json());
    return reply.hostId === host.id;
  } catch {
    return false;
  }
}

/** PCs of this account, refreshed every 10 s, and which one (if any) is this browser's PC. */
export function useHosts() {
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [thisPc, setThisPc] = useState(remembered);
  const [error, setError] = useState('');
  const probed = useRef(new Set<string>());
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api('/hosts')
        .then((value) => {
          if (!active) return;
          const list = hostsSchema.parse(value).hosts;
          setHosts(list);
          setError('');
          for (const host of list) {
            const key = host.id + host.local;
            if (!host.online || !host.local || probed.current.has(key)) continue;
            probed.current.add(key);
            void probe(host).then((mine) => {
              if (!mine || !active) return;
              setThisPc(host.id);
              try {
                sessionStorage.setItem(THIS_PC, host.id);
              } catch {
                /* Probe again next visit. */
              }
            });
          }
        })
        .catch((cause) => {
          if (active) setError(cause instanceof Error ? cause.message : '');
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return { hosts, thisPc, error };
}

export function describeHost(host: Host) {
  if (!host.online)
    return host.lastSeen ? `꺼짐 · ${new Date(host.lastSeen).toLocaleString()}` : '꺼짐';
  const documents = (host.status.documents ?? [])
    .map(
      (document) =>
        `${document.host === 'zwcad' ? 'ZWCAD' : 'Rhino'} ${document.name}${document.live ? ' · Live' : ''}`,
    )
    .join(' / ');
  return documents || '켜짐 · 연결된 문서 없음';
}

export function HostStrip({ hosts, thisPc }: { hosts: Host[] | null; thisPc: string }) {
  if (hosts === null) return <p className="muted small">작업 PC 확인 중…</p>;
  if (!hosts.length)
    return (
      <div className="pc-empty">
        <strong>이 계정에 연결된 작업 PC가 아직 없습니다.</strong>
        <ol>
          <li>Rhino가 있는 PC에서 VIDE 작업 화면을 엽니다.</li>
          <li>
            처음 실행할 때의 로그인 화면이나 왼쪽 아래 계정 단추에서 이 아이디와 비밀번호로
            로그인합니다.
          </li>
          <li>이 페이지에 그 PC가 표시되면, 프로젝트를 눌러 그 PC에서 엽니다.</li>
        </ol>
      </div>
    );
  return (
    <ul className="pcs" aria-label="작업 PC">
      {hosts.map((host) => (
        <li key={host.id} data-online={String(host.online)} title={describeHost(host)}>
          <span className="host-dot" aria-hidden="true" />
          <strong>{host.name}</strong>
          {host.id === thisPc ? <span className="badge">이 PC</span> : null}
          {host.online ? (
            <small>
              {host.remote ? '원격 켜짐' : '원격 꺼짐'}
              {host.version ? ` · v${host.version}` : ''}
            </small>
          ) : (
            <small>꺼짐</small>
          )}
          {host.online && host.updateRequired ? (
            <span className="badge warn">업데이트 필요</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
