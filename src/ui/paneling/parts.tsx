import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../gateway.ts';
import { Card } from '../question-card.tsx';
import { SettingRow } from '../kit/settings.tsx';
import { BakePart } from '../jig-panel/bake-parts.tsx';
import type { InstanceState } from '../jig-panel/instance.ts';
import type { PanelHost } from '../jig-panel/panel.tsx';
import type { PanelingView } from './context.ts';
import {
  CLASS_TEXT,
  COLOR_BY,
  MORE_KEYS,
  OVERLAY_PANELS,
  SCHEDULE_TITLES,
  STAGES,
  answerValue,
  assumedOf,
  exportMarks,
  exportName,
  headCells,
  headNotices,
  legendOf,
  makeGate,
  mmText,
  panelItems,
  panelRows,
  plateHint,
  scheduleCsv,
  settingInUse,
  settingShown,
  settingsOfStage,
  shownValue,
  sourceOf,
  stageMeta,
  stageQuestions,
  tagOf,
  type ScheduleKind,
} from './model.ts';
import './paneling.css';

// 패널링 jig 화면의 부품 (Design SCR-33, SPEC-16.1·16.3·16.4·16.8·16.9·16.10·16.11, PLAN-49 T-253):
// `paneling-stages` — the three-stage rail with 가정 counts; `paneling-surface` — the 기준 면 card;
// `paneling-settings` — the chosen stage's settings with '물어볼 것'·'가정' and the question cards;
// `paneling-make` — the stage's [Rhino에 만들기], closed while assumed values remain;
// `paneling-summary` — head numbers, '다시 계산 필요' and notices; `paneling-result` — panels in
// 3D by 색 기준 and the schedule drawer (패널 · 타입 · 결합부 · 실패) with CSV. They draw the
// engine's step outputs as they are; nothing is computed or hidden here.

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const time = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '';
const swatch = (tone: string) => ({ background: `var(--${tone})` });

// ── 단계 레일 ──────────────────────────────────────────────────────────────────────────────

export function PanelingStages({ view, title }: { view: PanelingView; title?: string }) {
  return (
    <section className="kit-section pnl-stages">
      <h4>{title ?? '단계'}</h4>
      <ol className="pnl-rail" aria-label="패널링 단계">
        {STAGES.map((stage, i) => {
          const status = view.status[stage.id];
          const before = i > 0 ? view.status[STAGES[i - 1].id] : undefined;
          const assumed = assumedOf(view.settings, [stage.id], view.values).length;
          const state = status.stale
            ? 'stale'
            : status.failed
              ? 'failed'
              : status.computed
                ? 'done'
                : 'pending';
          const text = {
            stale: '다시 계산 필요',
            failed: '막힘',
            done: '계산됨',
            pending: '계산 전',
          }[state];
          return (
            <li key={stage.id}>
              <button
                type="button"
                data-stage={stage.id}
                data-state={state}
                data-dim={before && !before.computed ? '' : undefined}
                aria-pressed={view.stage === stage.id}
                onClick={() => view.setStage(stage.id)}
              >
                <span className="pnl-rail-no">{stage.no}</span>
                <span className="pnl-rail-name">{stage.title}</span>
                <span className="pnl-rail-state">
                  {text}
                  {assumed && status.computed ? ` · 가정 ${assumed}` : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ── 기준 면 카드 ───────────────────────────────────────────────────────────────────────────

export function PanelingSurface({ view, title }: { view: PanelingView; title?: string }) {
  const surface = view.surface;
  const extent = surface?.extent;
  return (
    <section className="kit-card pnl-surface" data-surface={surface ? 'read' : 'none'}>
      <header className="pnl-surface-head">
        <strong>{title ?? '기준 면'}</strong>
        {surface?.documentName ? <span className="pnl-mono">{surface.documentName}</span> : null}
        {surface?.readAt ? <span className="kit-muted">읽음 {time(surface.readAt)}</span> : null}
      </header>
      {surface ? (
        <p className="pnl-line" data-surface-line="">
          면 {surface.faces}
          {extent
            ? ` · ${extent
                .slice(0, 2)
                .map((v) => v.toFixed(2))
                .join(' × ')} m 범위`
            : ''}
          {surface.unit ? ` · ${surface.unit} 문서` : ''}
        </p>
      ) : (
        <p className="pnl-empty">Rhino에서 면을 고른 뒤 [고른 면 쓰기]를 누르세요.</p>
      )}
      {surface?.changed ? (
        <p className="pnl-warn" role="status" data-surface-changed="">
          기준 면이 바뀜 · 다시 읽기
        </p>
      ) : null}
      {view.surfaceError ? (
        <p className={view.meshRefused ? 'pnl-warn' : 'kit-notice'} role="alert">
          {view.surfaceError}
        </p>
      ) : null}
      {view.remote ? (
        <p className="kit-muted">면 읽기는 작업 PC 화면에서 합니다.</p>
      ) : surface ? (
        <div className="kit-actions">
          <button
            type="button"
            className="link-button"
            disabled={view.reading}
            onClick={() => void view.pickSurface('reread')}
          >
            {view.reading ? '읽는 중…' : '다시 읽기'}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="kit-button pnl-wide"
          data-primary
          disabled={view.reading}
          onClick={() => void view.pickSurface('pick')}
        >
          {view.reading ? '읽는 중…' : '고른 면 쓰기'}
        </button>
      )}
      <CurvesRows view={view} />
    </section>
  );
}

/** The tile (pattern 'tile') and the attractors (an opening ratio above 0) under the 기준 면
 *  (SPEC-16.13 3·4): what was picked and [고른 곡선 쓰기] / [지우기]. */
function CurvesRows({ view }: { view: PanelingView }) {
  const opening = [view.values.openNear, view.values.openFar].some(
    (v) => typeof v === 'number' && v > 0,
  );
  const shown = view.curves.filter((c) =>
    c.accept === 'tile' ? view.values.pattern === 'tile' : c.accept === 'attractor' && opening,
  );
  if (!shown.length) return null;
  return (
    <>
      {shown.map((c) => {
        const tile = c.accept === 'tile';
        const reading = view.curvesReading === c.key;
        const error = view.curvesError[c.key];
        return (
          <div key={c.key} className="pnl-curves" data-curves={c.key}>
            <p className="pnl-line">
              <strong>{c.title || (tile ? '타일 곡선' : '어트랙터')}</strong>{' '}
              {c.count === null ? (
                <span className="kit-muted">
                  {tile
                    ? 'Rhino에서 평면 XY에 그린 닫힌 곡선을 고르세요'
                    : '없음 · 모든 패널이 먼 개구율'}
                </span>
              ) : (
                <span>
                  {tile ? `조각 ${c.count}` : `점·곡선 ${c.count}`}
                  {c.readAt ? ` · 읽음 ${time(c.readAt)}` : ''}
                </span>
              )}
            </p>
            {error ? (
              <p className="kit-notice" role="alert">
                {error}
              </p>
            ) : null}
            {view.remote ? null : (
              <div className="kit-actions">
                <button
                  type="button"
                  className="link-button"
                  disabled={reading}
                  onClick={() => void view.pickCurves(c.key, 'pick')}
                >
                  {reading ? '읽는 중…' : tile ? '고른 곡선 쓰기' : '고른 점·곡선 쓰기'}
                </button>
                {c.count !== null ? (
                  <button
                    type="button"
                    className="link-button"
                    disabled={reading}
                    onClick={() => void view.pickCurves(c.key, 'clear')}
                  >
                    지우기
                  </button>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ── 설정 묶음과 질문 카드 ──────────────────────────────────────────────────────────────────

function Questions({ view, onDone }: { view: PanelingView; onDone: () => void }) {
  const questions = useMemo(
    () => stageQuestions(view.settings, view.stage, view.values),
    [view.settings, view.stage, view.values],
  );
  const [choices, setChoices] = useState<Record<string, { optionId?: string; text?: string }>>({});
  const [error, setError] = useState('');
  if (!questions.length) return null;
  const send = () => {
    const values: { key: string; value: number | string | boolean }[] = [];
    for (const q of questions) {
      const setting = view.settings.find((s) => s.key === q.id)!;
      const choice = choices[q.id] ?? {};
      const answer = choice.text?.trim()
        ? { text: choice.text }
        : { optionId: choice.optionId ?? q.options.find((o) => o.recommended)?.id };
      const got = answerValue(setting, answer);
      if ('error' in got) {
        setError(got.error);
        return;
      }
      values.push({ key: q.id, value: got.value });
    }
    setError('');
    void view.answer(values).then(onDone);
  };
  return (
    <div className="pnl-questions" role="group" aria-label="빠진 값 질문">
      {questions.map((q, i) => (
        <Card
          key={q.id}
          question={q}
          index={i}
          count={questions.length}
          choice={choices[q.id] ?? {}}
          choose={(choice) => setChoices((current) => ({ ...current, [q.id]: choice }))}
          disabled={false}
          freeLabel="직접 입력"
        />
      ))}
      {error ? (
        <p className="kit-notice" role="alert">
          {error}
        </p>
      ) : null}
      <div className="kit-actions">
        <button type="button" className="kit-button" data-primary onClick={send}>
          이 답으로 진행
        </button>
        <button type="button" className="kit-button" onClick={onDone}>
          닫기
        </button>
      </div>
    </div>
  );
}

export function PanelingSettings({
  view,
  jig,
  title,
}: {
  view: PanelingView;
  jig: InstanceState;
  title?: string;
}) {
  const stage = view.stage;
  const status = view.status[stage];
  const box = useRef<HTMLElement>(null);
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState<string>();
  useEffect(() => {
    if (view.reveal) box.current?.scrollIntoView?.({ block: 'nearest' });
  }, [view.reveal]);
  useEffect(() => setAsking(false), [stage]);
  const list = settingsOfStage(view.settings, stage).filter((s) => settingShown(s, view.values));
  const main = list.filter((s) => !MORE_KEYS.has(s.key));
  const more = list.filter((s) => MORE_KEYS.has(s.key));
  const missing = assumedOf(list, [stage], view.values).length;
  const row = (setting: (typeof list)[number]) => {
    const tag = tagOf(setting, status.computed);
    return (
      <div key={setting.key} className="pnl-setting" data-tag={tag} data-source={sourceOf(setting)}>
        {/* The tag below says '물어볼 것'·'가정'; the row's own chip keeps only where it came from. */}
        <SettingRow
          setting={{ ...setting, basis: undefined }}
          value={view.values[setting.key] ?? setting.value}
          stale={status.stale}
          disabled={jig.busy || view.remote}
          onChange={(value, phase) => jig.change(setting.key, value, phase)}
        />
        <div className="pnl-source">
          {tag === 'ask' ? (
            <span className="pnl-ask" data-ask={setting.key}>
              물어볼 것 <span className="kit-muted">추천 {shownValue(setting)}</span>
            </span>
          ) : tag === 'assumed' ? (
            <>
              <button
                type="button"
                className="pnl-tag"
                data-assumed={setting.key}
                aria-expanded={open === setting.key}
                title="눌러서 이 값으로 확인"
                onClick={() => setOpen(open === setting.key ? undefined : setting.key)}
              >
                가정
              </button>
              {open === setting.key && !view.remote ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setOpen(undefined);
                    void view.confirm([setting.key]);
                  }}
                >
                  이 값으로 확인
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        {setting.key === 'joint' ? (
          <small className="kit-muted pnl-hint">{plateHint(view.values)}</small>
        ) : null}
      </div>
    );
  };
  return (
    <section ref={box} className="kit-section pnl-settings" data-stage={stage}>
      <h4>
        {title ?? '설정'} · {stageMeta(stage).no} {stageMeta(stage).title}
      </h4>
      {list.length ? (
        <>
          {main.map(row)}
          {more.length ? (
            <details className="pnl-more">
              <summary>더 보기</summary>
              {more.map(row)}
            </details>
          ) : null}
        </>
      ) : (
        <p className="kit-muted">이 단계의 설정값이 없습니다.</p>
      )}
      {view.notice ? (
        <p className="kit-notice" role="alert">
          {view.notice}
        </p>
      ) : null}
      {missing && !view.remote ? (
        asking ? (
          <Questions view={view} onDone={() => setAsking(false)} />
        ) : (
          <button type="button" className="link-button" onClick={() => setAsking(true)}>
            빠진 값 묻기 {missing}
          </button>
        )
      ) : null}
    </section>
  );
}

// ── Rhino에 만들기 ─────────────────────────────────────────────────────────────────────────

export function PanelingMake({
  view,
  jig,
  host,
  instanceId,
  title,
}: {
  view: PanelingView;
  jig: InstanceState;
  host: PanelHost;
  instanceId: string;
  title?: string;
}) {
  const meta = stageMeta(view.stage);
  const status = view.status[view.stage];
  if (view.remote)
    return (
      <section className="kit-section pnl-make">
        <p className="kit-muted">만들기는 작업 PC 화면에서 합니다.</p>
      </section>
    );
  const gate = makeGate(view.stage, view.settings, view.values, status);
  const previewAssumed =
    view.stage === 'preview' ? assumedOf(view.settings, ['preview'], view.values).length : 0;
  if (!gate.allowed)
    return (
      <section className="kit-section pnl-make" data-make={meta.bake} data-blocked="">
        <button type="button" className="kit-button pnl-wide" data-primary disabled>
          {meta.make}
        </button>
        <p className="kit-muted" data-make-reason="">
          {gate.reason}
        </p>
        {gate.assumed ? (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              const first = ['preview', 'members', 'optimize'].find(
                (id) => assumedOf(view.settings, [id as typeof view.stage], view.values).length > 0,
              ) as typeof view.stage | undefined;
              view.showAssumed(first ?? view.stage);
            }}
          >
            가정 값 보기
          </button>
        ) : null}
      </section>
    );
  return (
    <section className="kit-section pnl-make" data-make={meta.bake}>
      {previewAssumed ? (
        <p className="kit-muted">
          가정 값 {previewAssumed}개로 만듭니다 · 객체에 vide-assumed 표시
        </p>
      ) : null}
      <BakePart
        projectId={host.projectId}
        instanceId={instanceId}
        title={title ?? 'Rhino에 만들기'}
        label={meta.make}
        bake={[meta.bake, ...(meta.also ?? [])]}
        revision={jig.lastRun?.getTime()}
        onRecompute={() => void jig.recompute()}
      />
    </section>
  );
}

// ── 머리 수치 ──────────────────────────────────────────────────────────────────────────────

export function PanelingSummary({ view, jig }: { view: PanelingView; jig: InstanceState }) {
  const stage = view.stage;
  const status = view.status[stage];
  const cells = headCells(stage, view.results);
  const target =
    typeof view.values.width === 'number' && typeof view.values.height === 'number'
      ? ([view.values.width, view.values.height] as const)
      : undefined;
  const notices = headNotices(view.results, target);
  return (
    <div className="pnl-summary" data-stage={stage} data-stale={status.stale ? 'true' : undefined}>
      {status.stale ? (
        <div className="pnl-stale" role="status" data-stale-band="">
          <span>다시 계산 필요 · 설정이나 기준 면이 바뀌었습니다</span>
          {view.remote ? null : (
            <button
              type="button"
              className="kit-button"
              disabled={jig.busy || jig.computing}
              onClick={() => void jig.recompute()}
            >
              다시 계산
            </button>
          )}
        </div>
      ) : null}
      {view.reads[stage].kind === 'invalid' ? (
        <p className="kit-notice" role="alert">
          이 단계의 결과가 형식과 달라 그리지 않았습니다.
        </p>
      ) : null}
      <div className="kit-kpis pnl-kpis" role="group" aria-label="핵심 수치">
        {cells.map((cell) => (
          <div key={cell.label} className="kit-kpi" data-kpi={cell.label}>
            <div className="kit-kpi-title">
              <span className={status.stale ? 'kit-stale' : undefined}>{cell.label}</span>
              {cell.bad ? <span className="pnl-bad">실패 있음</span> : null}
            </div>
            {cell.value === undefined ? (
              <div className="kit-kpi-value" data-empty>
                — 계산 전
              </div>
            ) : (
              <div className="kit-kpi-value">
                {cell.value}
                {cell.unit ? <small>{cell.unit}</small> : null}
              </div>
            )}
            {cell.note ? <div className="kit-kpi-note">{cell.note}</div> : null}
          </div>
        ))}
      </div>
      {notices.map((text) => (
        <p key={text} className="pnl-notice" data-notice="">
          {text}
        </p>
      ))}
    </div>
  );
}

// ── 3D 겹침과 일람표 서랍 ──────────────────────────────────────────────────────────────────

type Tab = 'panels' | 'types' | 'connections' | 'failed';
const PAGE = 300;

function Outline({ points }: { points: readonly (readonly [number, number])[] | null }) {
  if (!points || points.length < 3) return <span className="pnl-outline" />;
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const minX = Math.min(...xs),
    minY = Math.min(...ys);
  const size = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
  const d = points
    .map(
      (p, i) =>
        `${i ? 'L' : 'M'}${(((p[0] - minX) / size) * 20 + 2).toFixed(2)},${(22 - ((p[1] - minY) / size) * 20).toFixed(2)}`,
    )
    .join(' ');
  return (
    <svg className="pnl-outline" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d={`${d} Z`} />
    </svg>
  );
}

export function PanelingResult({
  view,
  host,
}: {
  view: PanelingView;
  host: Pick<PanelHost, 'overlay' | 'focus' | 'onOverlayPick'>;
}) {
  const { results, stage, colorBy } = view;
  const [tab, setTab] = useState<Tab>('panels');
  const [shown, setShown] = useState(PAGE);
  const flatnessTol =
    typeof view.values.flatnessTol === 'number' ? view.values.flatnessTol : undefined;
  const items = useMemo(
    () => panelItems(results, colorBy, { stage, flatnessTol }),
    [results, colorBy, stage, flatnessTol],
  );
  const legend = useMemo(
    () => legendOf(results, colorBy, { flatnessTol }),
    [results, colorBy, flatnessTol],
  );
  const rows = useMemo(() => panelRows(results), [results]);
  const failed = rows.filter((row) => row.status === '실패');

  // 3D: the panels while the drawer is open; a picked panel opens its row.
  useEffect(() => {
    host.overlay(OVERLAY_PANELS, items.length ? items : null);
  }, [host, items]);
  useEffect(() => () => host.overlay(OVERLAY_PANELS, null), [host]);
  useEffect(
    () =>
      host.onOverlayPick?.((hit) => {
        if (hit.key !== OVERLAY_PANELS) return;
        view.select(hit.itemId);
        setTab('panels');
      }),
    [host, view.select],
  );
  const selectedIndex = view.selected ? rows.findIndex((r) => r.id === view.selected) : -1;
  useEffect(() => {
    if (selectedIndex >= shown) setShown(selectedIndex + 1);
  }, [selectedIndex, shown]);
  const choose = (id: string) => {
    view.select(id);
    host.focus({ overlay: OVERLAY_PANELS, itemId: id });
  };

  const stale = view.status[stage].stale;
  const assumed = assumedOf(view.settings, ['preview', 'members', 'optimize'], view.values).length;
  const typing = results.typing;
  const connections = (typing?.nodes.length ?? 0) + (typing?.joints.length ?? 0);
  const tabs: { id: Tab; title: string; count: number }[] = [
    { id: 'panels', title: '패널', count: rows.length },
    { id: 'types', title: '타입', count: typing?.types.length ?? 0 },
    { id: 'connections', title: '결합부', count: connections },
    { id: 'failed', title: '실패', count: failed.length },
  ];
  const exportable: ScheduleKind[] = typing ? ['panels', 'types', 'nodes', 'joints'] : ['panels'];
  const marks = { assumed, stale };
  const [reportNote, setReportNote] = useState('');
  // 보고서(HTML, SPEC-16.11): the engine resolves the jig's frame `reports/paneling.json`.
  const exportReport = async () => {
    setReportNote('');
    try {
      const out = (await api(`${view.base}/reports/paneling`)) as {
        html?: string;
        model?: { exportRefused?: string[] };
      };
      if (!out.html) {
        setReportNote(out.model?.exportRefused?.join(' · ') || '보고서를 내보낼 수 없습니다');
        return;
      }
      const name = exportName('panels', new Date(), marks)
        .replace('-패널-', '-보고서-')
        .replace(/\.csv$/, '.html');
      download(name, out.html, 'text/html;charset=utf-8');
    } catch (error) {
      setReportNote(error instanceof Error ? error.message : String(error));
    }
  };

  if (!results.layout)
    return (
      <div className="pnl-drawer" data-empty="">
        <p className="kit-muted" role="status">
          {view.surface
            ? '1단계를 계산하면 패널이 여기에 보입니다.'
            : '기준 면을 고르면 패널이 여기에 보입니다.'}
        </p>
      </div>
    );

  const panelTable = (list: typeof rows, label: string) => (
    <table className="pnl-table" aria-label={label}>
      <thead>
        <tr>
          <th>번호</th>
          <th>타입</th>
          <th>등급</th>
          <th className="pnl-num">크기</th>
          <th className="pnl-num">평면도</th>
          <th>이유</th>
        </tr>
      </thead>
      <tbody>
        {list.slice(0, shown).map((row) => (
          <tr
            key={row.id}
            className="pnl-row"
            data-panel={row.id}
            data-status={row.status}
            aria-selected={view.selected === row.id}
            onClick={() => choose(row.id)}
          >
            <td className="pnl-mono">{row.id}</td>
            <td>
              {row.type ? (
                <span className="pnl-chip">
                  <span
                    className="pnl-swatch"
                    style={swatch(
                      row.typeRank !== null && row.typeRank < 12
                        ? `ov-cat-${row.typeRank + 1}`
                        : 'na',
                    )}
                  />
                  {row.type}
                </span>
              ) : (
                '—'
              )}
            </td>
            <td>{row.cls ? CLASS_TEXT[row.cls] : '—'}</td>
            <td className="pnl-num">
              {(row.size[0] * 1000).toFixed(0)} × {(row.size[1] * 1000).toFixed(0)}
              <small>{row.plate ? ' 판' : ''}</small>
            </td>
            <td className="pnl-num">{row.flatness === null ? '—' : mmText(row.flatness, 1)}</td>
            <td className="pnl-reason">
              {row.status === '정상' ? '' : `${row.status} · ${row.reason}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="pnl-drawer" data-stale={stale ? 'true' : undefined}>
      <div className="pnl-drawer-head">
        <div className="kit-view-tabs" role="tablist" aria-label="일람표">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.title} {t.count}
            </button>
          ))}
        </div>
        <label className="pnl-colorby">
          색 기준{' '}
          <select
            aria-label="색 기준"
            value={colorBy}
            onChange={(event) => view.setColorBy(event.target.value as typeof colorBy)}
          >
            {COLOR_BY.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <details className="pnl-csv">
          <summary className="kit-button">CSV ▾</summary>
          <div className="pnl-csv-menu">
            {exportable.map((kind) => (
              <button
                key={kind}
                type="button"
                className="kit-button"
                data-csv={kind}
                onClick={() =>
                  download(
                    exportName(kind, new Date(), marks),
                    scheduleCsv(kind, results),
                    'text/csv;charset=utf-8',
                  )
                }
              >
                {SCHEDULE_TITLES[kind]}
              </button>
            ))}
          </div>
        </details>
        <button type="button" className="kit-button" data-report="" onClick={exportReport}>
          보고서
        </button>
        {assumed || stale ? (
          <span className="kit-muted" data-export-note="">
            {exportMarks(marks).join(' · ')}
          </span>
        ) : null}
        {reportNote ? (
          <span className="kit-muted" role="status" data-report-note="">
            {reportNote}
          </span>
        ) : null}
      </div>
      <ul className="pnl-legend" aria-label="색 기준 범례">
        {legend.map((row) => (
          <li key={`${row.tone}:${row.text}`} data-tone={row.tone}>
            <span className="pnl-swatch" style={swatch(row.tone)} />
            {row.text} <b>{row.count}</b>
          </li>
        ))}
      </ul>
      <div className="pnl-body">
        {tab === 'panels' ? (
          <>
            {panelTable(rows, '패널 일람표')}
            {rows.length > shown ? (
              <button type="button" className="link-button" onClick={() => setShown(shown + PAGE)}>
                {rows.length - shown}개 더 보기
              </button>
            ) : null}
          </>
        ) : tab === 'failed' ? (
          failed.length ? (
            panelTable(failed, '실패 패널')
          ) : (
            <p className="kit-muted">실패한 패널이 없습니다.</p>
          )
        ) : tab === 'types' ? (
          typing ? (
            <table className="pnl-table" aria-label="타입 일람표">
              <thead>
                <tr>
                  <th>타입</th>
                  <th />
                  <th className="pnl-num">수</th>
                  <th>등급</th>
                  <th className="pnl-num">판 크기</th>
                  <th className="pnl-num">최대 편차</th>
                  <th>거울상</th>
                </tr>
              </thead>
              <tbody>
                {typing.types.map((type, i) => {
                  const flat = typing.panels.find((p) => p.panelId === type.representative)?.flat;
                  return (
                    <tr
                      key={type.type}
                      className="pnl-row"
                      data-type={type.type}
                      aria-selected={view.selected === type.representative}
                      onClick={() => choose(type.representative)}
                    >
                      <td>
                        <span className="pnl-chip">
                          <span
                            className="pnl-swatch"
                            style={swatch(i < 12 ? `ov-cat-${i + 1}` : 'na')}
                          />
                          {type.type}
                        </span>
                      </td>
                      <td>
                        <Outline points={flat ?? null} />
                      </td>
                      <td className="pnl-num">{type.count}</td>
                      <td>{CLASS_TEXT[type.class]}</td>
                      <td className="pnl-num">
                        {(type.size[0] * 1000).toFixed(0)} × {(type.size[1] * 1000).toFixed(0)}
                      </td>
                      <td className="pnl-num">{mmText(type.maxDeviation, 1)}</td>
                      <td>{type.mirrorOf ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="kit-muted">3단계를 계산하면 타입이 보입니다.</p>
          )
        ) : typing ? (
          <>
            <table className="pnl-table" aria-label="노드 타입">
              <thead>
                <tr>
                  <th>노드 타입</th>
                  <th className="pnl-num">수</th>
                  <th className="pnl-num">만나는 수</th>
                  <th>각(°)</th>
                </tr>
              </thead>
              <tbody>
                {typing.nodes.map((node) => (
                  <tr key={node.type}>
                    <td className="pnl-mono">{node.type}</td>
                    <td className="pnl-num">{node.count}</td>
                    <td className="pnl-num">{node.valence}</td>
                    <td>{node.angles.map((a) => a.toFixed(1)).join(' / ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="pnl-table" aria-label="줄눈 타입">
              <thead>
                <tr>
                  <th>줄눈 타입</th>
                  <th className="pnl-num">수</th>
                  <th>꺾인 각(°)</th>
                  <th className="pnl-num">길이</th>
                  <th className="pnl-num">길이 합</th>
                </tr>
              </thead>
              <tbody>
                {typing.joints.map((joint) => (
                  <tr key={joint.type}>
                    <td className="pnl-mono">{joint.type}</td>
                    <td className="pnl-num">{joint.count}</td>
                    <td>
                      {joint.dihedral[0].toFixed(1)}~{joint.dihedral[1].toFixed(1)}
                    </td>
                    <td className="pnl-num">{mmText(joint.length)}</td>
                    <td className="pnl-num">{joint.totalLength.toFixed(1)} m</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="kit-muted">3단계를 계산하면 결합부가 보입니다.</p>
        )}
      </div>
    </div>
  );
}
