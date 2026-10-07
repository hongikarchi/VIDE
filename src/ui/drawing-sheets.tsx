// 대시보드 › 프로젝트 폴더 › 도곽 미리보기 (SPEC-14.15, Design SCR-30, PLAN-47 T-235): pick a
// drawing that 도면 관계 read, [도곽 찾기] reads it and the drawings it shows with a hidden ZWCAD,
// and a window lists the sheets (number, title, paper) with a white-paper preview of the chosen one
// in the project's plot style table. Candidates (A-ratio blocks) become sheets only after
// [도곽으로 쓰기]. VIDE writes no file (plot and PDF stay in CAD). Remote sessions only look.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './gateway.ts';
import { remoteSession } from './remote-panel.ts';
import { createViewport } from './viewport.ts';
import { defaultDisplay } from './display-settings.ts';
import { parsePlotStyleTable } from './plot-style.ts';
import './drawing-sheets.css';

type Box = [number, number, number, number];
interface Sheet {
  id: string;
  source: 'list' | 'window' | 'layout';
  space: 'model' | 'paper';
  layout: string | null;
  box: Box;
  paper: string;
  block: string | null;
  xref: boolean;
  number: string | null;
  title: string | null;
  info: 'attributes' | 'text' | null;
  styleSheet: string | null;
  plotWindow: boolean;
  missingXrefs: string[];
}
interface Candidate {
  block: string;
  count: number;
  attributed: boolean;
  xref: boolean;
  paper: string;
  plotted: boolean;
}
interface SheetsState {
  state: 'idle' | 'reading' | 'done' | 'failed';
  done: number;
  total: number;
  error: string | null;
  drawings: { path: string; name: string }[];
  settings: { blocks: string[]; ctb: string | null };
  ctbChoices: { path: string; name: string; where: 'project' | 'cad' }[];
  plotStyle: {
    source: 'project' | 'drawing' | 'builtin';
    name: string;
    path: string | null;
    notice: string | null;
  };
  result: {
    root: string;
    name: string;
    readAt: string;
    files: { name: string; xref: boolean; error: string | null }[];
    sheets: Sheet[];
    candidates: Candidate[];
    missingXrefs: string[];
    styleNames: string[];
  } | null;
}

const REASONS: Record<string, string> = {
  NO_ZWCAD: '이 PC에 ZWCAD 2023이 없어 도면을 읽지 못합니다.',
  NOT_FOUND: '그 도면을 찾지 못했습니다. 도면 관계에서 [다시 읽기]를 누르세요.',
  PROJECT_BUSY: '이 프로젝트의 도면을 읽는 중입니다. 끝난 뒤 다시 누르세요.',
  FORBIDDEN: '도곽 찾기는 작업 PC에서 합니다.',
  NOT_READ: '도면을 읽지 못했습니다.',
  COPY_FAILED: '도면 사본을 만들지 못했습니다.',
};
const reasonOf = (code: string) => REASONS[code] ?? code;
const NOTICES: Record<string, string> = {
  NO_CTB: '등록한 CTB가 없고 도면이 가리키는 CTB도 찾지 못했습니다.',
  CTB_MISSING: '등록한 CTB 파일이 없습니다.',
  CTB_HEADER: '등록한 파일이 CTB 형식이 아닙니다.',
  CTB_LENGTH: '등록한 CTB 파일이 잘렸습니다.',
  CTB_CORRUPT: '등록한 CTB 파일이 손상되었습니다.',
  NOT_CTB: '이름 있는 플롯 스타일(.stb)은 지원하지 않습니다.',
  STB_UNSUPPORTED: '도면이 이름 있는 플롯 스타일(.stb)을 씁니다. 지원하지 않습니다.',
};
const SOURCES: Record<Sheet['source'], string> = {
  list: '도곽 블록',
  window: '모형 창 범위',
  layout: '배치',
};
const POLL_MS = 1000;
const PAPER_SCALE = 100;

function plotStyleText(style: SheetsState['plotStyle']) {
  if (style.source === 'project') return `${style.name} · 프로젝트 등록`;
  if (style.source === 'drawing') return `${style.name} · 도면이 가리키는 표`;
  return `내장 흑백(monochrome) · ${NOTICES[style.notice ?? ''] ?? style.notice ?? ''}`;
}

/** The white-paper preview of one sheet: a viewport of its own in plot mode. */
function SheetPreview({
  projectId,
  sheet,
  styleKey,
}: {
  projectId: string;
  sheet: Sheet;
  styleKey: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<ReturnType<typeof createViewport> | null>(null);
  const [status, setStatus] = useState('읽는 중…');
  useEffect(() => {
    if (!host.current) return;
    // The model screen's viewport stays the diagnostic one (window.videViewport).
    const holder = window as unknown as { videViewport?: unknown; videSheetPreview?: unknown };
    const previous = holder.videViewport;
    const view = createViewport(
      host.current,
      [],
      () => {},
      () => {},
    );
    holder.videViewport = previous;
    holder.videSheetPreview = view;
    view.display({ ...defaultDisplay, plot: true, colorSource: 'object' });
    view.plane('XY');
    viewport.current = view;
    return () => {
      view.dispose();
      viewport.current = null;
      if (holder.videSheetPreview === view) holder.videSheetPreview = undefined;
    };
  }, []);
  useEffect(() => {
    let live = true;
    const base = `/projects/${encodeURIComponent(projectId)}/drawing/sheets`;
    setStatus('읽는 중…');
    void (async () => {
      try {
        const [preview, style] = (await Promise.all([
          api(`${base}/preview?sheet=${encodeURIComponent(sheet.id)}`),
          api(`${base}/plot-style`),
        ])) as [{ scene: Record<string, unknown>[] }, { table: unknown }];
        const view = viewport.current;
        if (!live || !view) return;
        // A paper space sheet is in paper metres (0.42 m for A3): scaled up to frame like a model one.
        const paper = sheet.space === 'paper';
        const scale = paper
          ? [PAPER_SCALE, 0, 0, 0, 0, PAPER_SCALE, 0, 0, 0, 0, PAPER_SCALE, 0, 0, 0, 0, 1]
          : null;
        const scene = paper
          ? preview.scene.map((row) => ({ ...row, placement: scale }))
          : preview.scene;
        const k = paper ? PAPER_SCALE : 1;
        const [x0, y0, x1, y1] = sheet.box.map((v) => v * k);
        view.plotStyle(parsePlotStyleTable(style.table));
        view.replace(scene as never);
        view.setSection({ mode: 'box', min: [x0, y0, -1e5], max: [x1, y1, 1e5] });
        view.plane('XY');
        view.focus({ min: [x0, y0, 0], max: [x1, y1, 0] });
        setStatus(preview.scene.length ? '' : '이 시트 범위에 보이는 개체가 없습니다.');
      } catch (error) {
        if (live)
          setStatus(reasonOf((error as { code?: string }).code ?? (error as Error).message));
      }
    })();
    return () => {
      live = false;
    };
  }, [projectId, sheet, styleKey]);
  return (
    <div className="sheets-preview">
      <div className="sheets-paper" ref={host} data-testid="sheet-preview" />
      {status ? (
        <p className="sheets-preview-status" role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}

function SheetsWindow({
  projectId,
  state,
  onState,
  onClose,
}: {
  projectId: string;
  state: SheetsState;
  onState: (next: SheetsState) => void;
  onClose: () => void;
}) {
  const remote = remoteSession();
  const base = `/projects/${encodeURIComponent(projectId)}/drawing/sheets`;
  const result = state.result;
  const [chosen, setChosen] = useState<string | null>(result?.sheets[0]?.id ?? null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!result?.sheets.some((s) => s.id === chosen)) setChosen(result?.sheets[0]?.id ?? null);
  }, [result, chosen]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const act = async (path: string, method: string, value: Record<string, unknown>) => {
    setBusy(true);
    setReason('');
    try {
      onState((await api(path, method, value)) as SheetsState);
    } catch (error) {
      setReason(reasonOf((error as { code?: string }).code ?? (error as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const sheet = result?.sheets.find((s) => s.id === chosen) ?? null;
  const sized = result?.candidates.filter((c) => c.plotted || c.paper !== 'A계열 비율') ?? [];
  const others = result?.candidates.filter((c) => !c.plotted && c.paper === 'A계열 비율') ?? [];
  const candidateRow = (c: Candidate) => (
    <li key={c.block} className="sheets-candidate">
      <span className="sheets-mono" title={c.block}>
        {c.block}
      </span>
      <span className="sheets-count">×{c.count}</span>
      <span className="sheets-badge">{c.paper}</span>
      {c.plotted ? (
        <span className="sheets-badge" data-tone="ok">
          모형 창 범위와 같음
        </span>
      ) : null}
      {c.xref ? <span className="sheets-badge">xref 안</span> : null}
      {c.attributed ? <span className="sheets-badge">속성 있음</span> : null}
      {remote ? null : (
        <button
          type="button"
          className="link-button"
          disabled={busy}
          aria-label={`${c.block} 도곽으로 쓰기`}
          onClick={() => void act(`${base}/pick`, 'POST', { block: c.block })}
        >
          도곽으로 쓰기
        </button>
      )}
    </li>
  );
  return (
    <div className="sheets-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheets-window" role="dialog" aria-modal="true" aria-label="도곽 미리보기">
        <header className="sheets-head">
          <h3>
            도곽 미리보기 <span className="sheets-mono">{result?.name}</span>
          </h3>
          <span className="sheets-ctb" title={state.plotStyle.path ?? undefined}>
            CTB: {plotStyleText(state.plotStyle)}
          </span>
          <button type="button" className="sheets-close" aria-label="닫기" onClick={onClose}>
            ×
          </button>
        </header>
        {reason ? (
          <p className="sheets-reason" role="alert">
            {reason}
          </p>
        ) : null}
        <div className="sheets-body">
          <aside className="sheets-side">
            <h4>시트 {result?.sheets.length ?? 0}</h4>
            {result?.sheets.length ? (
              <ul className="sheets-list" aria-label="시트 목록">
                {result.sheets.map((s, index) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="sheets-row"
                      aria-pressed={s.id === chosen}
                      onClick={() => setChosen(s.id)}
                    >
                      <span className="sheets-order">{index + 1}</span>
                      <span className="sheets-mono">{s.number ?? '—'}</span>
                      <span className="sheets-title">{s.title ?? '(도면명 없음)'}</span>
                      <span className="sheets-badge">{SOURCES[s.source]}</span>
                      {s.missingXrefs.length ? (
                        <span
                          className="sheets-badge"
                          data-tone="warn"
                          title={s.missingXrefs.join(', ')}
                        >
                          누락 xref {s.missingXrefs.length}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sheets-empty">도곽 없음 · 아래 후보에서 도곽 블록을 고르세요.</p>
            )}
            <h4>도곽 후보 {result?.candidates.length ?? 0}</h4>
            <p className="sheets-hint">
              용지 비율(A계열) 블록입니다. 고르기 전에는 시트로 세지 않습니다.
            </p>
            {sized.length ? <ul className="sheets-candidates">{sized.map(candidateRow)}</ul> : null}
            {others.length ? (
              <>
                <button type="button" className="link-button" onClick={() => setMore(!more)}>
                  비율만 맞는 블록 {others.length}종 {more ? '접기' : '보기'}
                </button>
                {more ? <ul className="sheets-candidates">{others.map(candidateRow)}</ul> : null}
              </>
            ) : null}
            <h4>설정</h4>
            <div className="sheets-blocks" aria-label="도곽 블록 목록">
              {state.settings.blocks.length ? (
                state.settings.blocks.map((block) => (
                  <span key={block} className="sheets-chip">
                    <span className="sheets-mono">{block}</span>
                    {remote ? null : (
                      <button
                        type="button"
                        aria-label={`${block} 목록에서 빼기`}
                        disabled={busy}
                        onClick={() =>
                          void act(`${base}/settings`, 'PUT', {
                            blocks: state.settings.blocks.filter((b) => b !== block),
                          })
                        }
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))
              ) : (
                <span className="sheets-hint">도곽 블록 목록이 비었습니다.</span>
              )}
            </div>
            <label className="sheets-field">
              <span>프로젝트 CTB</span>
              <select
                value={state.settings.ctb ?? ''}
                disabled={busy || remote}
                onChange={(e) =>
                  void act(`${base}/settings`, 'PUT', { ctb: e.target.value || null })
                }
              >
                <option value="">등록 안 함(도면이 가리키는 표, 없으면 내장 흑백)</option>
                {state.ctbChoices.map((c) => (
                  <option key={c.path} value={c.path} title={c.path}>
                    {c.name} · {c.where === 'project' ? '프로젝트 폴더' : 'CAD 지원 폴더'}
                  </option>
                ))}
              </select>
            </label>
          </aside>
          <section className="sheets-main" aria-label="시트 미리보기">
            {sheet ? (
              <>
                <div className="sheets-sheet-head">
                  <span className="sheets-mono">{sheet.number ?? '—'}</span>
                  <strong>{sheet.title ?? '(도면명 없음)'}</strong>
                  <span className="sheets-badge">{sheet.paper}</span>
                  {sheet.layout ? <span className="sheets-badge">배치 {sheet.layout}</span> : null}
                  {sheet.info === 'text' ? (
                    <span className="sheets-badge" title="속성이 없어 도곽 안 문자에서 읽었습니다">
                      문자에서 읽음
                    </span>
                  ) : null}
                </div>
                <SheetPreview
                  projectId={projectId}
                  sheet={sheet}
                  styleKey={`${state.plotStyle.source}|${state.plotStyle.path}|${state.plotStyle.notice}`}
                />
                <p className="sheets-note">
                  화면 미리보기입니다. 글꼴 대체, 선가중치의 화면 픽셀 환산, 해치 패턴 등은 실제
                  플롯과 다를 수 있습니다. 플롯·PDF는 CAD에서 합니다.
                  {sheet.missingXrefs.length ? ` 누락 xref: ${sheet.missingXrefs.join(', ')}.` : ''}
                </p>
              </>
            ) : (
              <p className="sheets-empty">시트를 고르면 흰 종이 미리보기가 보입니다.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export function DrawingSheets({
  projectId,
  empty = null,
}: {
  projectId: string;
  /** Shown while no drawing has been read (the 도면 반영 jig's tab; the dashboard shows nothing). */
  empty?: ReactNode;
}) {
  const [state, setState] = useState<SheetsState | undefined>();
  const [target, setTarget] = useState('');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const remote = remoteSession();
  const base = `/projects/${encodeURIComponent(projectId)}/drawing/sheets`;
  const running = useRef(false);
  const take = useCallback((next: SheetsState) => {
    running.current = next.state === 'reading';
    setState(next);
  }, []);
  useEffect(() => {
    let live = true;
    const read = () =>
      api(base)
        .then((value) => live && take(value as SheetsState))
        .catch(() => {});
    void read();
    const timer = setInterval(() => {
      if (running.current) void read();
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [base, take]);
  if (!state || (!state.drawings.length && !state.result)) return <>{empty}</>;
  const chosen = target || state.result?.root || state.drawings[0]?.path || '';
  const reading = state.state === 'reading';
  const find = async () => {
    setReason('');
    try {
      take((await api(`${base}/read`, 'POST', { root: chosen })) as SheetsState);
      setOpen(true);
    } catch (error) {
      setReason(reasonOf((error as { code?: string }).code ?? (error as Error).message));
    }
  };
  const result = state.result;
  return (
    <div className="dash-sheets" role="group" aria-label="도곽 미리보기">
      <div className="dash-collect-row">
        {reading ? (
          <span className="dash-collect-progress" role="status">
            도곽 찾는 중{state.total ? ` ${state.done}/${state.total}` : ''}
          </span>
        ) : (
          <span className="dash-collect-last">
            도면의 도곽을 찾아 프로젝트 CTB로 시트를 미리 봅니다. 파일은 쓰지 않습니다.
          </span>
        )}
      </div>
      <div className="dash-sheets-pick">
        <select
          aria-label="도곽을 찾을 도면"
          value={chosen}
          disabled={reading}
          onChange={(e) => setTarget(e.target.value)}
        >
          {state.drawings.map((d) => (
            <option key={d.path} value={d.path} title={d.path}>
              {d.name}
            </option>
          ))}
        </select>
        {remote ? null : (
          <button type="button" disabled={reading || !chosen} onClick={() => void find()}>
            도곽 찾기
          </button>
        )}
      </div>
      {reason || (state.state === 'failed' && state.error) ? (
        <p className="dash-xref-reason" role="alert">
          {reason || reasonOf(state.error!.split(' @ ')[0])}
        </p>
      ) : null}
      {result && !reading ? (
        <p className="dash-collect-counts">
          <span className="sheets-mono">{result.name}</span> · 시트 {result.sheets.length} · 후보{' '}
          {result.candidates.length}
          {result.missingXrefs.length ? ` · 누락 xref ${result.missingXrefs.length}` : ''}{' '}
          <button type="button" className="link-button" onClick={() => setOpen(true)}>
            미리보기 열기
          </button>
        </p>
      ) : null}
      {open && result && !reading ? (
        <SheetsWindow
          projectId={projectId}
          state={state}
          onState={take}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
