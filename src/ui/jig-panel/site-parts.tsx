import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { api } from '../gateway.ts';
import { Card } from '../question-card.tsx';
import { messageOf, type InstanceState } from './instance.ts';

// 대상 필지 고르기 — panel part `site-picker` (SPEC-12.3·12.4, PLAN-45 T-207, Design SCR-13):
// the FR-18 send notice of the project ([확인하고 쓰기] · [이 프로젝트에서 끄기]) and its off switch,
// the address search, the candidates as a question card (ADR-026: a jig step's question is a VIDE
// card, here with a small map of the candidates) with [PNU 직접 입력], the chosen parcels (합필:
// add by PNU) and [대상 필지 확정], [가져오기]/[다시 가져오기] with the changes of a new copy to take
// or leave, and the SHP files put in for this instance. Values come from the engine routes
// (`…/site-data/:key/*`); the steps recompute after each change. With no address anywhere (SPEC-12.3의
// 6 ③) the address field comes first with its reason and the cursor in it.

const noticeSchema = z.object({
  notice: z.object({
    sends: z.array(z.string()),
    recipients: z.array(z.object({ name: z.string(), host: z.string(), for: z.string() })),
    notSent: z.array(z.string()),
    version: z.string(),
  }),
  confirmed: z.boolean(),
  confirmedAt: z.string().nullable(),
  off: z.boolean(),
});
type Notice = z.infer<typeof noticeSchema>;
// The instance's stored state (view body) and the routes' replies share these fields; the replies
// use null for what is not there.
const stateSchema = z
  .object({
    query: z.string().nullish(),
    targets: z.object({ pnus: z.array(z.string()), by: z.string() }).nullish(),
    collection: z.object({ fetchedAt: z.string(), pnus: z.array(z.string()) }).nullish(),
    pending: z.object({ fetchedAt: z.string(), changes: z.array(z.string()) }).nullish(),
    previous: z.array(z.object({ fetchedAt: z.string() })).nullish(),
    shp: z.object({ files: z.array(z.string()), at: z.string() }).nullish(),
  })
  .passthrough();
type SiteState = z.infer<typeof stateSchema>;
const candidateSchema = z
  .object({
    pnu: z.string(),
    label: z.string(),
    point: z.tuple([z.number(), z.number()]).nullable(),
  })
  .passthrough();
const candidatesSchema = z
  .object({
    query: z.string().nullable(),
    status: z.string(),
    candidates: z.array(candidateSchema),
    proposal: z.string().nullable(),
    targets: z.array(z.string()),
    question: z
      .object({
        title: z.string(),
        options: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            hint: z.string().optional(),
            recommended: z.boolean().optional(),
          }),
        ),
        allowFree: z.boolean().optional(),
        blocks: z.string().optional(),
      })
      .nullable(),
    checks: z.array(z.string()),
  })
  .passthrough();
const sourceRow = z
  .object({ name: z.string(), status: z.string(), text: z.string() })
  .passthrough();

const PNU = /^\d{10}[12]\d{8}$/;
const lotOf = (pnu: string) =>
  `${pnu[10] === '2' ? '산' : ''}${Number(pnu.slice(11, 15))}${Number(pnu.slice(15, 19)) ? `-${Number(pnu.slice(15, 19))}` : ''}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** The candidates' positions in a small plan (numbers as in the card), north up. */
function CandidateMap({
  points,
  chosen,
}: {
  points: { pnu: string; point: [number, number] }[];
  chosen: readonly string[];
}) {
  if (!points.length) return null;
  const xs = points.map((p) => p.point[0]);
  const ys = points.map((p) => p.point[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 20);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const at = ([x, y]: [number, number]) => [
    80 + ((x - cx) / span) * 120,
    50 - ((y - cy) / span) * 70,
  ];
  return (
    <svg
      className="site-map"
      viewBox="0 0 160 100"
      role="img"
      aria-label={`후보 필지 위치 ${points.length}곳 (위가 북쪽)`}
    >
      <rect x="0.5" y="0.5" width="159" height="99" className="site-map-frame" />
      <text x="152" y="12" className="site-map-north">
        N
      </text>
      {points.map((p, i) => {
        const [x, y] = at(p.point);
        return (
          <g key={p.pnu} data-chosen={chosen.includes(p.pnu) ? 'true' : undefined}>
            <circle cx={x} cy={y} r="6" className="site-map-dot" />
            <text x={x} y={y + 3} textAnchor="middle" className="site-map-label">
              {i + 1}
            </text>
          </g>
        );
      })}
      <text x="6" y="94" className="site-map-scale">
        {`가로 약 ${Math.round(span)} m`}
      </text>
    </svg>
  );
}

export function SitePicker({
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
  const base = `/projects/${encodeURIComponent(projectId)}/jig-instances/${encodeURIComponent(instanceId)}/site-data/${encodeURIComponent(inputKey)}`;
  const [notice, setNotice] = useState<Notice>();
  const [query, setQuery] = useState('');
  const [choice, setChoice] = useState<{ optionId?: string; text?: string }>({});
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [shpNote, setShpNote] = useState<string>();
  const siteData = (jig.view?.body as { siteData?: Record<string, unknown> } | undefined)?.siteData;
  // The latest reply of a route wins over the view read when the panel opened.
  const [reply, setReply] = useState<SiteState>();
  const state: SiteState = reply ?? stateSchema.safeParse(siteData?.[inputKey] ?? {}).data ?? {};
  /** One site-data route; its reply carries the input's state. */
  const call = async (part: string, method: string, body: unknown) => {
    const result = (await api(`${base}/${part}`, method, body)) as Record<string, unknown>;
    const next = stateSchema.safeParse(result?.state);
    if (next.success) setReply(next.data);
    return result;
  };
  const parsed = candidatesSchema.safeParse(jig.outputs.candidates);
  const candidates = parsed.success ? parsed.data : undefined;
  const sources = z
    .array(sourceRow)
    .safeParse((jig.outputs.collect as { sources?: unknown } | undefined)?.sources);
  const targets = state.targets?.pnus ?? [];
  const confirmStatus =
    jig.reports.confirmTarget?.status ??
    jig.view?.steps.find((s) => s.id === 'confirmTarget')?.status;
  const confirmed = confirmStatus === 'confirmed';
  // ③ of SPEC-12.3의 6: no address in the request nor in the project — ask here, not in the chat.
  const asking = !state.query && !targets.length;
  const field = useRef<HTMLInputElement>(null);
  const focused = useRef(false);
  const waiting = busy || jig.busy;
  useEffect(() => {
    // Once, when the field can take the cursor (it is disabled while the steps compute).
    if (!asking || waiting || focused.current || !field.current) return;
    focused.current = true;
    field.current.focus();
  }, [asking, waiting]);

  const readNotice = useCallback(async () => {
    try {
      setNotice(
        noticeSchema.parse(
          await api(`/projects/${encodeURIComponent(projectId)}/site-data/notice`),
        ),
      );
    } catch (error) {
      setMessage(messageOf(error));
    }
  }, [projectId]);
  useEffect(() => {
    void readNotice();
  }, [readNotice]);
  useEffect(() => {
    if (state.query && !query) setQuery(state.query);
    // Only the first time the stored address arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.query]);

  /** Run one change, then read the instance again and recompute. */
  const act = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const said = await work();
      if (said) setMessage(said);
      await jig.recompute();
    } catch (error) {
      const code = (error as { code?: string })?.code;
      setMessage(
        code === 'SITE_DATA_OFF'
          ? '이 프로젝트는 공공 자료를 끄고 있습니다. 넣은 SHP만 씁니다.'
          : code === 'SITE_TARGETS_MISSING'
            ? '대상 필지를 먼저 고르세요.'
            : messageOf(error),
      );
    } finally {
      setBusy(false);
    }
  };
  const setNoticeChoice = (body: { confirm?: true; off?: boolean }) =>
    act(async () => {
      setNotice(
        noticeSchema.parse(
          await api(`/projects/${encodeURIComponent(projectId)}/site-data/notice`, 'PUT', body),
        ),
      );
    });
  const lookup = () =>
    act(async () => {
      const result = (await call('lookup', 'POST', { query: query.trim() })) as {
        needsConfirm?: unknown;
        off?: boolean;
      };
      setChoice({});
      if (result.needsConfirm) {
        await readNotice();
        return '공공 자료원에 보내기 전에 아래 안내를 확인하세요.';
      }
      if (result.off) return '공공 자료를 끈 프로젝트입니다. 넣은 SHP에서 찾습니다.';
    });
  const putTargets = (pnus: string[]) =>
    act(async () => {
      await call('targets', 'PUT', { pnus });
    });
  const choose = () => {
    const typed = choice.text?.replace(/[\s-]/g, '') ?? '';
    const picked =
      typed || choice.optionId || candidates?.question?.options.find((o) => o.recommended)?.id;
    if (!picked || !PNU.test(picked)) {
      setMessage('PNU는 19자리 숫자입니다.');
      return;
    }
    void putTargets([picked]);
  };
  const collect = () =>
    act(async () => {
      const result = (await call('collect', 'POST', {})) as {
        needsConfirm?: unknown;
        blocked?: boolean;
        waiting?: boolean;
        unchanged?: boolean;
      };
      if (result.needsConfirm) {
        await readNotice();
        return '공공 자료원에 보내기 전에 아래 안내를 확인하세요.';
      }
      if (result.waiting) return '새 사본에 바뀐 항목이 있습니다. 받을지 고르세요.';
      if (result.unchanged) return '다시 가져왔습니다. 바뀐 항목이 없습니다.';
      if (result.blocked) return '대상 필지 경계를 찾지 못했습니다. 필지를 확인하세요.';
    });
  const pending = (take: boolean) =>
    act(async () => {
      await call('pending', 'POST', { take });
      return take
        ? '새 사본으로 바꿨습니다. 이전 사본은 남겨 둡니다.'
        : '이전 사본을 그대로 씁니다.';
    });
  const putShp = (files: FileList | null) => {
    if (!files?.length) return;
    void act(async () => {
      const list = await Promise.all(
        [...files].map(async (file) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 0x8000)
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return { name: file.name, data: btoa(binary) };
        }),
      );
      const result = (await call('shp', 'POST', { files: list })) as {
        layers?: { name: string; features: number; role: string }[];
        rejected?: { file: string; reason: string }[];
        ignored?: { name: string }[];
      };
      const used = (result.layers ?? []).map((l) => `${l.name} ${l.features}`).join(' · ');
      const refused = (result.rejected ?? []).map((r) => `${r.file}: ${r.reason}`).join(' · ');
      setShpNote(
        [
          used && `넣음: ${used}`,
          refused && `넣지 않음: ${refused}`,
          result.ignored?.length ? `쓰지 않음 ${result.ignored.map((i) => i.name).join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' / ') || '넣은 레이어가 없습니다',
      );
    });
  };

  const disabled = waiting;
  const points = (candidates?.candidates ?? []).flatMap((c) =>
    c.point ? [{ pnu: c.pnu, point: c.point as [number, number] }] : [],
  );
  return (
    <section className="kit-section site-picker" aria-label={title ?? '대상 필지'}>
      <h4>{title ?? '대상 필지'}</h4>
      {asking ? (
        <p className="kit-banner site-ask" role="note">
          대지 주소나 PNU를 넣어 주세요 — 프로젝트에 저장된 주소가 없습니다
        </p>
      ) : null}
      <form
        className="site-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) void lookup();
        }}
      >
        <input
          ref={field}
          type="text"
          aria-label="주소·지번·PNU"
          placeholder="주소·지번·PNU (예: ○○동 123-4)"
          maxLength={200}
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="kit-button" disabled={disabled || !query.trim()}>
          찾기
        </button>
      </form>
      {notice && !notice.off && !notice.confirmed ? (
        <div className="kit-confirm site-notice" role="group" aria-label="공공 자료 전송 안내">
          <strong>공공 자료원에 보내기 전에 확인하세요</strong>
          <span>보내는 것: {notice.notice.sends.join(' · ')}</span>
          <ul className="kit-issues">
            {notice.notice.recipients.map((r) => (
              <li key={r.host}>
                {r.name}{' '}
                <small>
                  ({r.host}) — {r.for}
                </small>
              </li>
            ))}
          </ul>
          <small className="kit-muted">{notice.notice.notSent.join(' · ')}</small>
          <div className="kit-actions">
            <button
              type="button"
              data-primary
              disabled={disabled}
              onClick={() => void setNoticeChoice({ confirm: true })}
            >
              확인하고 쓰기
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void setNoticeChoice({ off: true })}
            >
              이 프로젝트에서 끄기
            </button>
          </div>
        </div>
      ) : null}
      {notice?.off ? (
        <p className="kit-banner">
          이 프로젝트는 공공 자료를 쓰지 않습니다. 넣은 SHP만 씁니다.{' '}
          <button
            type="button"
            className="kit-button"
            disabled={disabled}
            onClick={() => void setNoticeChoice({ off: false })}
          >
            다시 켜기
          </button>
        </p>
      ) : notice?.confirmed ? (
        <label className="kit-muted site-off">
          <input
            type="checkbox"
            checked={false}
            disabled={disabled}
            onChange={() => void setNoticeChoice({ off: true })}
          />{' '}
          이 프로젝트에서 공공 자료 끄기
          {notice.confirmedAt ? ` · 전송 확인 ${when(notice.confirmedAt)}` : ''}
        </label>
      ) : null}

      {candidates?.checks.length ? (
        <ul className="kit-issues">
          {candidates.checks.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ul>
      ) : null}

      {candidates?.question ? (
        <div className="site-question">
          <Card
            question={{ id: 'site-target', ...candidates.question }}
            index={0}
            count={1}
            choice={choice}
            choose={setChoice}
            disabled={disabled}
            freeLabel="PNU 직접 입력 (19자리)"
          />
          <CandidateMap points={points} chosen={targets} />
          <div className="kit-actions">
            <button type="button" data-primary disabled={disabled} onClick={choose}>
              이 필지로
            </button>
          </div>
        </div>
      ) : null}

      {targets.length ? (
        <div className="kit-card site-targets">
          <span>
            대상 필지 {targets.length}개{' '}
            <small className="kit-muted">
              {state.targets?.by === 'proposal' ? '(제안)' : '(선택)'}
            </small>
          </span>
          <ul className="site-target-list">
            {targets.map((pnu) => (
              <li key={pnu}>
                {lotOf(pnu)} <small className="kit-muted">{pnu}</small>{' '}
                <button
                  type="button"
                  className="kit-button"
                  aria-label={`${lotOf(pnu)} 빼기`}
                  disabled={disabled}
                  onClick={() => void putTargets(targets.filter((p) => p !== pnu))}
                >
                  빼기
                </button>
              </li>
            ))}
          </ul>
          <form
            className="site-search"
            onSubmit={(event) => {
              event.preventDefault();
              const pnu = adding.replace(/[\s-]/g, '');
              if (!PNU.test(pnu)) return setMessage('PNU는 19자리 숫자입니다.');
              setAdding('');
              void putTargets([...targets, pnu]);
            }}
          >
            <input
              type="text"
              aria-label="필지 더하기 (PNU)"
              placeholder="합필: 필지 더하기 (PNU)"
              value={adding}
              disabled={disabled}
              onChange={(event) => setAdding(event.target.value)}
            />
            <button type="submit" className="kit-button" disabled={disabled || !adding.trim()}>
              더하기
            </button>
          </form>
          <p className={confirmed ? 'kit-muted' : 'kit-notice'} role="status">
            {confirmed
              ? '대상 필지를 확정했습니다.'
              : '대상 필지 미확정 — 확정 전에는 Rhino에 만들기가 막힙니다.'}
          </p>
          <div className="kit-actions">
            {!confirmed ? (
              <button
                type="button"
                data-primary
                disabled={disabled || !jig.reports.confirmTarget}
                onClick={() => void jig.confirmStep('confirmTarget')}
              >
                대상 필지 확정
              </button>
            ) : null}
            <button
              type="button"
              disabled={disabled || !!notice?.off}
              onClick={() => void collect()}
            >
              {state.collection ? '다시 가져오기' : '가져오기'}
            </button>
          </div>
          {state.collection ? (
            <small className="kit-muted">
              가져온 시각 {when(state.collection.fetchedAt)}
              {state.previous?.length ? ` · 이전 사본 ${state.previous.length}` : ''}
              {sources.success
                ? ` · ${sources.data.filter((s) => s.status === 'ok').length}/${sources.data.length} 자료 가져옴`
                : ''}
            </small>
          ) : null}
        </div>
      ) : null}

      {state.pending ? (
        <div className="kit-confirm" role="group" aria-label="다시 가져온 사본">
          <strong>다시 가져온 사본에 바뀐 항목 {state.pending.changes.length}건</strong>
          <ul className="kit-issues">
            {state.pending.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
          <div className="kit-actions">
            <button
              type="button"
              data-primary
              disabled={disabled}
              onClick={() => void pending(true)}
            >
              새 사본 받기
            </button>
            <button type="button" disabled={disabled} onClick={() => void pending(false)}>
              이전 사본 유지
            </button>
          </div>
        </div>
      ) : null}

      <div className="site-shp">
        <label className="kit-muted">
          SHP 넣기 (연속지적도·수치지형도, .shp·.dbf·.prj·.cpg 또는 .zip){' '}
          <input
            type="file"
            multiple
            accept=".shp,.dbf,.prj,.cpg,.shx,.zip"
            aria-label="SHP 넣기"
            disabled={disabled}
            onChange={(event) => {
              putShp(event.target.files);
              event.target.value = '';
            }}
          />
        </label>
        {state.shp ? (
          <small className="kit-muted">
            넣은 파일 {state.shp.files.length}개 · 이 작업본에만 둡니다{' '}
            <button
              type="button"
              className="kit-button"
              disabled={disabled}
              onClick={() =>
                void act(async () => {
                  await call('shp', 'POST', { clear: true });
                  setShpNote(undefined);
                })
              }
            >
              비우기
            </button>
          </small>
        ) : null}
        {shpNote ? <small className="kit-muted">{shpNote}</small> : null}
      </div>
      {message ? (
        <p className="kit-muted" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
