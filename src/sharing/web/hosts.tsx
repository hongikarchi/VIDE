import { useEffect, useState } from 'react';
import { z } from 'zod';
import { api } from './api';

// Work PCs paired with this account. An online PC runs VIDE with Rhino/CAD attached and does all
// the work; opening it hands this device a one-minute login to that PC's workspace.
const hostsSchema = z.object({
  hosts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      online: z.boolean(),
      lastSeen: z.number().nullable(),
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
type Host = z.infer<typeof hostsSchema>['hosts'][number];
const message = (error: unknown) => (error instanceof Error ? error.message : '요청 실패');

export function Hosts() {
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () =>
    api('/hosts')
      .then((value) => setHosts(hostsSchema.parse(value).hosts))
      .catch((error) => setStatus(message(error)));
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, []);
  const open = async (host: Host) => {
    setBusy(true);
    setStatus(`${host.name}에 연결하는 중…`);
    try {
      const { url } = z
        .object({ url: z.string().url() })
        .parse(await api(`/hosts/${host.id}/open`, 'POST', {}));
      location.href = url;
    } catch (error) {
      setStatus(message(error));
      setBusy(false);
      void refresh();
    }
  };
  return (
    <section className="hosts" aria-label="작업 PC">
      <h2>작업 PC</h2>
      {hosts === null ? <p className="muted">확인 중…</p> : null}
      {hosts?.length === 0 ? (
        <p className="muted">등록된 PC가 없습니다. 아래에서 등록 코드를 만드세요.</p>
      ) : null}
      <ul>
        {hosts?.map((host) => (
          <li key={host.id} data-online={String(host.online)}>
            <div>
              <strong>
                <span className="host-dot" aria-hidden="true" /> {host.name}
              </strong>
              <small>
                {host.online
                  ? (host.status.documents ?? [])
                      .map(
                        (document) =>
                          `${document.host === 'zwcad' ? 'ZWCAD' : 'Rhino'} · ${document.name}${document.live ? ' · Live' : ''}`,
                      )
                      .join(' / ') || '온라인 · 연결된 문서 없음'
                  : host.lastSeen
                    ? `꺼짐 · 마지막 ${new Date(host.lastSeen).toLocaleString()}`
                    : '꺼짐'}
              </small>
            </div>
            <button
              className="primary"
              disabled={!host.online || busy}
              onClick={() => {
                void open(host);
              }}
            >
              열기
            </button>
          </li>
        ))}
      </ul>
      {pairing ? (
        <p className="pairing">
          등록 코드 <strong>{pairing.code}</strong>
          <small>
            PC의 VIDE → 설정 → 원격 접속에 입력하세요 ·{' '}
            {new Date(pairing.expiresAt).toLocaleTimeString()}까지
          </small>
        </p>
      ) : null}
      <button
        disabled={busy}
        onClick={() => {
          void api('/hosts/pairings', 'POST', {})
            .then((value) =>
              setPairing(z.object({ code: z.string(), expiresAt: z.number() }).parse(value)),
            )
            .catch((error) => setStatus(message(error)));
        }}
      >
        PC 등록 코드 만들기
      </button>
      {status ? (
        <p role="status" className="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}
