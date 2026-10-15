// The 보고서 view of the 산출물 tab (PLAN-22 T-057, PLAN-26 T-081, SPEC-07.11, Design SCR-17;
// it was its own workspace tab before T-081): the left column lists the
// report frames of the project's jig instances (작업본) and the chosen report's gates; the centre
// previews it on the chosen paper (A3 landscape or A4 portrait) with print and save. The engine
// resolves and renders the report (src/server/report.ts); the app draws the resolved model with
// the kit's ReportPage (the app's CSP forbids the exported page's inline styles in a frame), and
// [HTML 저장] keeps the engine's self-contained page without scripts. The in-app report has one way
// back, to the instance and the settings it was made from; the exported page has no controls.
//
// 두 등급 (PLAN-54 T-342, SPEC-07.11, Design SCR-40): the toolbar switches [검토용]·[보고용]. The
// 검토용 header says where the engine's copy went in the work folder ('폴더에 씀 · …' / '폴더에 아직
// 안 씀'); [보고용 만들기] (a final result only) opens the range dialog — sections with the frame's
// public ones checked, the first-page summary locked, a live paper preview and the title with the
// folder it goes to. A made 보고용 is shown as the engine's own page (served with its own CSP) with
// the run it came from, where it was saved, and the [공유] slot that T-343 mounts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReportModel } from '../jigs/runtime/report-format.ts';
import { dayOf, safeName } from '../core/workspace-paths.ts';
import { api, errors } from './gateway.ts';
import { ReportPage } from './kit/report.tsx';
import { setWorkspace } from './workspaces.ts';
import './report-tab.css';
import { mountPublishCard } from './publish-card.tsx';

interface InstanceRow {
  id: string;
  jigId: string;
  version: string;
  title: string;
}
interface FrameInfo {
  id: string;
  title: string;
  file: string;
}
export interface ListedReports {
  instance: InstanceRow;
  reports: FrameInfo[];
}
/** The 검토용 run a 보고용 comes from (report.json `sourceRun`). */
export interface SourceRun {
  instanceId: string;
  reportId: string;
  at: string;
  revision?: string;
}
/** [보고용 만들기]'s choice on a report (engine `public`). */
export interface PublicChoice {
  sections: { id: string; no: string; title: string; public: boolean }[];
  allowed: boolean;
  reason?: string;
  sourceRun: SourceRun;
  defaultTitle: string;
  /** The project's work folder and its output role (absolute), or null when it has none. */
  workFolder: { root: string; output: string | null } | null;
}
export interface RenderedReport {
  report: FrameInfo;
  instance: { id: string; title: string; jig: { name: string; version: string } };
  origin: { project: string; instance: string; version: string; at?: string };
  model: ReportModel;
  html: string;
  /** Where the 검토용 copy went in the work folder (absolute file), or null. */
  copy?: string | null;
  public?: PublicChoice;
}
/** A made 보고용 (GET /projects/:p/outputs). */
export interface PublicOutput {
  name: string;
  title: string;
  madeAt: string | null;
  folder: string | null;
  reason?: string;
  sourceRun: SourceRun | null;
  sections: string[];
  files: string[];
  published?: Record<string, unknown>;
}
export type Paper = 'a3' | 'a4';
export type Tier = 'review' | 'public';
/**
 * Mounts the [공유] card of a 보고용 (T-343, Design SCR-43) into `el`; may return a cleanup.
 * Register it once with `setPublishSlotMount`; the 검토용 never gets one.
 */
export type PublishSlotMount = (
  el: HTMLElement,
  context: { projectId: string; outputName: string; sourceRun: SourceRun | null },
) => void | (() => void);

const GATE_LABEL: Record<string, string> = {
  'claim-consistent': '주장과 결과 일치',
  'numbers-in-source': '숫자의 출처',
  'unchecked-listed': '검토하지 않은 항목 표시',
};
const PAPER: Record<Paper, string> = { a3: 'A3 가로', a4: 'A4 세로' };
const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;
const message = (error: unknown, fallback = '보고서를 불러오지 못했습니다.') => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return (typeof code === 'string' && errors[code]) || fallback;
};
/** A file name for the saved page: instance and report title, no path characters. */
export const reportFileName = (r: Pick<RenderedReport, 'instance' | 'report'>) =>
  `${r.instance.title}-${r.report.title}`.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) + '.html';
/** The appendix section is labelled '부록' instead of its number (T-058). */
export const sectionNo = (s: { id: string; no: string }) => (s.id === 'appendix' ? '부록' : s.no);
/** The model as the page draws it: numbered sections, the appendix labelled. */
export const pageModel = (model: ReportModel): ReportModel => ({
  ...model,
  sections: model.sections.map((s) => ({ ...s, no: sectionNo(s) })),
});
/** The report to show after the list is read again: the same one while it exists, else the first. */
export function keepChoice(
  list: readonly ListedReports[],
  current?: { instanceId: string; reportId: string },
) {
  const still = list.some(
    (entry) =>
      entry.instance.id === current?.instanceId &&
      entry.reports.some((r) => r.id === current.reportId),
  );
  if (still) return current;
  const first = list.find((entry) => entry.reports.length);
  return first ? { instanceId: first.instance.id, reportId: first.reports[0].id } : undefined;
}

/** A path under the work folder as the person reads it: `05_검토/…` (forward slashes). */
export function relativeTo(root: string, path: string) {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  const [r, p] = [norm(root), norm(path)];
  return p.toLowerCase().startsWith(r.toLowerCase() + '/') ? p.slice(r.length + 1) : p;
}
const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '');
const pad = (n: number) => String(n).padStart(2, '0');
/** `YYYY-MM-DD HH:mm` of an ISO time. */
export const stampOf = (iso: string | null | undefined) => {
  const at = new Date(iso ?? '');
  return Number.isNaN(at.getTime())
    ? ''
    : `${dayOf(at)} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
};
/** The folder a 보고용 of `title` would get today (`-2` … when the name is taken). */
export function folderNameFor(title: string, taken: readonly string[], now = new Date()) {
  const base = `${dayOf(now)}-${safeName(title, '보고서')}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!taken.includes(name)) return name;
  }
}
/** Why a 보고용 is not in the work folder, as the header line says it. */
const NOT_WRITTEN: Record<string, string> = {
  'no-workspace': '폴더에 아직 안 씀 — 작업 폴더가 없습니다',
  'no-output-role': '폴더에 아직 안 씀 — 산출물 폴더가 정해지지 않았습니다',
  failed: '폴더에 아직 안 씀 — 폴더에 쓸 수 없습니다',
};

let publishSlot: PublishSlotMount | undefined = mountPublishCard;
/** T-343 registers the [공유] card here (Design SCR-43); the 보고용 head mounts it. */
export function setPublishSlotMount(mount: PublishSlotMount | undefined) {
  publishSlot = mount;
  window.dispatchEvent(new Event('vide:publish-slot'));
}

function ReportTab({
  projectId,
  mountPublishSlot,
}: {
  projectId: string;
  /** Overrides the registered [공유] mount (setPublishSlotMount). */
  mountPublishSlot?: PublishSlotMount;
}) {
  const [list, setList] = useState<ListedReports[] | null>(null);
  const [error, setError] = useState<string>();
  // A report asked for from a jig panel (openReport) is the first choice.
  const [chosen, setChosen] = useState<{ instanceId: string; reportId: string } | undefined>(
    takeAsked,
  );
  const [shown, setShown] = useState<RenderedReport>();
  const [loading, setLoading] = useState(false);
  const [paper, setPaper] = useState<Paper>('a3');
  const [tier, setTier] = useState<Tier>('review');
  const [outputs, setOutputs] = useState<PublicOutput[]>([]);
  const [outputName, setOutputName] = useState<string>();
  const [making, setMaking] = useState(false);
  const [remaking, setRemaking] = useState(false);
  const reading = useRef(0);
  const frame = useRef<HTMLIFrameElement>(null);

  const refreshList = useCallback(async () => {
    try {
      const out = (await api(`${projectPath(projectId)}/jig-reports`)) as {
        instances: ListedReports[];
      };
      setList(out.instances);
      setChosen((current) => keepChoice(out.instances, current));
    } catch (e) {
      setList([]);
      setError(message(e));
    }
  }, [projectId]);
  const refreshOutputs = useCallback(async () => {
    try {
      const out = (await api(`${projectPath(projectId)}/outputs`)) as { outputs: PublicOutput[] };
      setOutputs(out.outputs);
    } catch {
      setOutputs([]);
    }
  }, [projectId]);
  const render = useCallback(async () => {
    // Only the latest read shows: an older one finishing later (a stale handler's) is dropped.
    const ticket = ++reading.current;
    if (!chosen) {
      setShown(undefined);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const report = (await api(
        `${projectPath(projectId)}/jig-instances/${encodeURIComponent(chosen.instanceId)}/reports/${encodeURIComponent(chosen.reportId)}`,
      )) as RenderedReport;
      if (ticket === reading.current) setShown(report);
    } catch (e) {
      if (ticket !== reading.current) return;
      setShown(undefined);
      setError(message(e));
    } finally {
      if (ticket === reading.current) setLoading(false);
    }
  }, [projectId, chosen]);

  useEffect(() => {
    void refreshList();
    void refreshOutputs();
  }, [refreshList, refreshOutputs]);
  useEffect(() => {
    void render();
  }, [render]);
  useEffect(() => {
    // Another report: back to its 검토용.
    setTier('review');
    setOutputName(undefined);
  }, [chosen?.instanceId, chosen?.reportId]);
  useEffect(() => {
    // Coming back to the tab reads the list and the report again (results may have changed).
    const again = () => {
      void refreshList();
      void render();
      void refreshOutputs();
    };
    const asked = () => {
      const choice = takeAsked();
      if (choice) setChosen(choice);
    };
    window.addEventListener('vide:report-asked', asked);
    window.addEventListener('vide:reports-shown', again);
    return () => {
      window.removeEventListener('vide:report-asked', asked);
      window.removeEventListener('vide:reports-shown', again);
    };
  }, [refreshList, render, refreshOutputs]);

  // The 보고용 made from this report, newest first.
  const made = useMemo(
    () =>
      outputs.filter(
        (o) =>
          o.sourceRun?.instanceId === chosen?.instanceId &&
          o.sourceRun?.reportId === chosen?.reportId,
      ),
    [outputs, chosen?.instanceId, chosen?.reportId],
  );
  const current =
    tier === 'public' ? (made.find((o) => o.name === outputName) ?? made[0]) : undefined;
  const fileUrl = (o: PublicOutput, file: string, download = false) =>
    `/api/v1${projectPath(projectId)}/outputs/${encodeURIComponent(o.name)}/files/${encodeURIComponent(file)}${download ? '?download' : ''}`;

  const print = () => {
    if (current) {
      frame.current?.contentWindow?.print();
      return;
    }
    // Print CSS (report-tab.css) keeps only the report page, on the chosen paper.
    document.body.dataset.reportPaper = paper;
    window.print();
  };
  // A report whose frame says it may not be exported now (SPEC-12.13 4) has no page to save.
  const refused = shown?.model.exportRefused ?? [];
  const save = () => {
    if (current) {
      const link = document.createElement('a');
      link.href = fileUrl(current, 'index.html', true);
      link.download = `${current.name}.html`;
      link.click();
      return;
    }
    if (!shown || refused.length || !shown.html) return;
    const url = URL.createObjectURL(new Blob([shown.html], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = reportFileName(shown);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const back = () => shown && setWorkspace('', { instanceId: shown.instance.id });
  const folder = shown?.public?.workFolder;
  const outputRole = folder?.output ? relativeTo(folder.root, folder.output) : null;
  const onMade = async (name: string) => {
    setMaking(false);
    await refreshOutputs();
    setOutputName(name);
    setTier('public');
  };
  const remake = async () => {
    if (!current || !chosen) return;
    setRemaking(true);
    setError(undefined);
    try {
      const out = (await api(
        `${projectPath(projectId)}/jig-instances/${encodeURIComponent(chosen.instanceId)}/reports/${encodeURIComponent(chosen.reportId)}/public`,
        'POST',
        { title: current.title, sections: current.sections },
      )) as { name: string };
      await onMade(out.name);
    } catch (e) {
      setError(message(e, '보고용을 만들지 못했습니다.'));
    } finally {
      setRemaking(false);
    }
  };

  const choice = shown?.public;
  const reviewLine = !shown?.html
    ? null
    : !folder
      ? { warn: true, text: '폴더에 아직 안 씀 — 작업 폴더가 없습니다' }
      : shown.copy
        ? { warn: false, text: `폴더에 씀 · ${relativeTo(folder.root, dirOf(shown.copy))}` }
        : { warn: true, text: '폴더에 아직 안 씀 — 폴더에 쓸 수 없습니다' };

  return (
    <>
      <nav className="report-list" aria-label="보고서 목록">
        <p className="caption">보고서</p>
        {list === null ? <small>불러오는 중</small> : null}
        {list?.length === 0 && !error ? (
          <p className="report-empty">
            보고서가 있는 작업본이 없습니다. JIG 탭에서 작업본을 만들고 단계를 실행하면 여기에서
            봅니다.
          </p>
        ) : null}
        {list?.map((entry) => (
          <section key={entry.instance.id} className="report-group">
            <h3>{entry.instance.title}</h3>
            <ul>
              {entry.reports.map((r) => {
                const active = chosen?.instanceId === entry.instance.id && chosen.reportId === r.id;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => setChosen({ instanceId: entry.instance.id, reportId: r.id })}
                    >
                      {r.title === r.id ? '보고서' : r.title}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {shown ? (
          <div className="report-checks" aria-label="보고서 점검">
            <p className="caption">점검</p>
            <ul>
              {shown.model.gates.map((g) => (
                <li key={g.id} data-ok={String(g.ok)}>
                  {g.ok ? '✓' : '!'} {GATE_LABEL[g.id] ?? g.id}
                </li>
              ))}
            </ul>
            <p className="caption">포함 항목</p>
            <ul>
              {shown.model.sections
                .filter((s) => !current || current.sections.includes(s.id))
                .map((s) => (
                  <li key={s.id}>
                    {current ? '' : `${sectionNo(s)} `}
                    {s.title.text}
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
      </nav>
      <div className="report-preview">
        <div className="report-toolbar">
          <div className="report-tiers" role="group" aria-label="보고서 등급">
            <button
              type="button"
              aria-pressed={tier === 'review'}
              onClick={() => setTier('review')}
              disabled={!shown}
            >
              검토용
            </button>
            <button
              type="button"
              aria-pressed={tier === 'public'}
              onClick={() => setTier('public')}
              disabled={!made.length}
              title={made.length ? undefined : '아직 만든 보고용이 없습니다'}
            >
              보고용
            </button>
          </div>
          {tier === 'public' && made.length > 1 ? (
            <select
              aria-label="만든 보고용"
              value={current?.name}
              onChange={(e) => setOutputName(e.currentTarget.value)}
            >
              {made.map((o) => (
                <option key={o.name} value={o.name}>
                  {o.title} · {stampOf(o.madeAt)}
                </option>
              ))}
            </select>
          ) : null}
          <strong>{shown ? `${shown.instance.title} · ${shown.model.title}` : '보고서'}</strong>
          {tier === 'review' ? (
            <>
              <label>
                판형{' '}
                <select value={paper} onChange={(e) => setPaper(e.currentTarget.value as Paper)}>
                  {(Object.keys(PAPER) as Paper[]).map((p) => (
                    <option key={p} value={p}>
                      {PAPER[p]}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => void render()} disabled={!chosen || loading}>
                다시 만들기
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={print}
            disabled={current ? false : !shown || refused.length > 0}
          >
            인쇄
          </button>
          <button
            type="button"
            onClick={save}
            disabled={current ? false : !shown || refused.length > 0}
            title="스크립트 없는 HTML 한 파일로 저장합니다"
          >
            HTML 저장
          </button>
          {tier === 'review' ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => setMaking(true)}
              disabled={!choice?.allowed}
            >
              보고용 만들기
            </button>
          ) : null}
        </div>
        {tier === 'review' && shown && choice && !choice.allowed ? (
          <p className="report-line" data-make-refused="">
            {choice.reason ?? '먼저 다시 계산하면 만들 수 있습니다'}
          </p>
        ) : null}
        {tier === 'review' && reviewLine ? (
          <p className="report-line" data-folder-line="" data-warn={String(reviewLine.warn)}>
            {reviewLine.text}
          </p>
        ) : null}
        {current ? (
          <div className="report-public-head" data-public-head="">
            <p className="report-line">
              {current.sourceRun ? `검토용 ${stampOf(current.sourceRun.at)} 회차에서 만듦 · ` : ''}
              <span data-warn={String(!current.folder)}>
                {current.folder && folder
                  ? relativeTo(folder.root, current.folder)
                  : current.folder
                    ? current.folder
                    : (NOT_WRITTEN[current.reason ?? ''] ?? NOT_WRITTEN.failed)}
              </span>
            </p>
            <button
              type="button"
              className="link-button"
              disabled={remaking || !choice?.allowed}
              onClick={() => void remake()}
            >
              같은 범위로 다시 만들기
            </button>
            <PublishSlot
              key={current.name}
              projectId={projectId}
              output={current}
              mount={mountPublishSlot}
            />
          </div>
        ) : null}
        {refused.length && tier === 'review' ? (
          <p className="report-error" role="alert" data-export-refused="">
            내보내지 않음 · {refused.join(' · ')}
          </p>
        ) : null}
        {error ? (
          <p className="report-error" role="alert">
            {error}
          </p>
        ) : null}
        {current ? (
          <div className="report-paper" data-tier="public">
            <iframe
              ref={frame}
              className="report-public-frame"
              title="보고용 보고서"
              src={fileUrl(current, 'index.html')}
            />
          </div>
        ) : (
          <div className="report-paper" data-paper={paper} aria-busy={loading}>
            {shown ? (
              <div className="report-sheet">
                <ReportPage model={pageModel(shown.model)} origin={shown.origin} onBack={back} />
              </div>
            ) : (
              <p className="report-empty">
                {loading ? '보고서를 만드는 중' : list?.length ? '보고서를 고르십시오.' : ''}
              </p>
            )}
          </div>
        )}
      </div>
      {making && shown && choice && chosen ? (
        <MakeDialog
          projectId={projectId}
          chosen={chosen}
          choice={choice}
          outputRole={outputRole}
          taken={outputs.map((o) => o.name)}
          onClose={() => setMaking(false)}
          onMade={(name) => void onMade(name)}
        />
      ) : null}
    </>
  );
}

/** The [공유] card's place in the 보고용 head (T-343 mounts into it). */
function PublishSlot({
  projectId,
  output,
  mount,
}: {
  projectId: string;
  output: PublicOutput;
  mount?: PublishSlotMount;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [registered, setRegistered] = useState(0);
  useEffect(() => {
    const changed = () => setRegistered((n) => n + 1);
    window.addEventListener('vide:publish-slot', changed);
    return () => window.removeEventListener('vide:publish-slot', changed);
  }, []);
  useEffect(() => {
    const use = mount ?? publishSlot;
    if (!el.current || !use) return;
    const cleanup = use(el.current, {
      projectId,
      outputName: output.name,
      sourceRun: output.sourceRun,
    });
    return typeof cleanup === 'function' ? cleanup : undefined;
  }, [mount, registered, projectId, output.name, output.sourceRun]);
  return <div id="report-publish-slot" ref={el} />;
}

/** 보고용 만들기 (Design SCR-40 범위 선택 창, 720px). */
function MakeDialog({
  projectId,
  chosen,
  choice,
  outputRole,
  taken,
  onClose,
  onMade,
}: {
  projectId: string;
  chosen: { instanceId: string; reportId: string };
  choice: PublicChoice;
  outputRole: string | null;
  taken: readonly string[];
  onClose: () => void;
  onMade: (name: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const publicIds = choice.sections.filter((s) => s.public).map((s) => s.id);
  const [picked, setPicked] = useState<string[]>(publicIds);
  const [title, setTitle] = useState(choice.defaultTitle);
  const [previewTitle, setPreviewTitle] = useState(choice.defaultTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setPreviewTitle(title), 300);
    return () => clearTimeout(timer);
  }, [title]);
  const base = `${projectPath(projectId)}/jig-instances/${encodeURIComponent(chosen.instanceId)}/reports/${encodeURIComponent(chosen.reportId)}`;
  // In the frame's order.
  const ordered = choice.sections.filter((s) => picked.includes(s.id)).map((s) => s.id);
  const preview = `/api/v1${base}?${new URLSearchParams({
    tier: 'public',
    as: 'html',
    sections: ordered.join(','),
    title: previewTitle.trim() || choice.defaultTitle,
  }).toString()}`;
  const name = folderNameFor(title.trim() || choice.defaultTitle, taken);
  const toggle = (id: string) =>
    setPicked((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));
  const make = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const out = (await api(`${base}/public`, 'POST', {
        title: title.trim() || choice.defaultTitle,
        sections: ordered,
      })) as { name: string };
      onMade(out.name);
    } catch (e) {
      setError(message(e, '보고용을 만들지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={ref}
      className="report-make"
      aria-label="보고용 만들기"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2>보고용 만들기</h2>
      <div className="report-make-body">
        <div className="report-make-list">
          <div className="report-make-quick">
            <button type="button" className="link-button" onClick={() => setPicked(publicIds)}>
              공개 절만
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => setPicked(choice.sections.map((s) => s.id))}
            >
              모두
            </button>
          </div>
          <ul>
            <li data-locked="">
              <label>
                <input type="checkbox" checked disabled /> 첫 쪽 가정·미검토 요약
              </label>
              <small>늘 들어감</small>
            </li>
            {choice.sections.map((s) => (
              <li key={s.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.includes(s.id)}
                    onChange={() => toggle(s.id)}
                  />{' '}
                  <span className="report-make-no">{s.id === 'appendix' ? '부록' : s.no}</span>{' '}
                  {s.title}
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="report-make-preview">
          {ordered.length ? (
            <iframe title="보고용 미리보기" src={preview} />
          ) : (
            <p className="report-empty">넣을 절을 하나 이상 고르세요.</p>
          )}
        </div>
      </div>
      <label className="report-make-title">
        제목
        <input value={title} maxLength={120} onChange={(e) => setTitle(e.currentTarget.value)} />
      </label>
      <p className="report-line" data-save-at="">
        {outputRole
          ? `저장 위치 · ${outputRole}/${name}/`
          : '저장 위치 · 작업 폴더의 산출물 폴더가 없어 VIDE 안에만 둡니다'}
      </p>
      {error ? (
        <p className="report-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="report-make-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy || !ordered.length}
          onClick={() => void make()}
        >
          {busy ? '만드는 중…' : '만들기'}
        </button>
        <button type="button" onClick={onClose} disabled={busy}>
          취소
        </button>
      </div>
    </dialog>
  );
}

/** The report a jig panel asked for, until the tab takes it. */
let askedReport: { instanceId: string; reportId: string } | undefined;
function takeAsked() {
  const choice = askedReport;
  askedReport = undefined;
  return choice;
}
/**
 * Show one instance's report in 산출물 → 보고서 (a jig panel's report action, T-048): the view
 * mounts with it chosen, or chooses it when already mounted, and reads it again.
 */
export function openReport(instanceId: string, reportId: string) {
  askedReport = { instanceId, reportId };
  window.dispatchEvent(new Event('vide:report-asked'));
  setWorkspace('output', { outputView: 'report' });
}

let root: Root | undefined;
let rootIn: HTMLElement | undefined;
let shownFor: string | undefined;

/**
 * Show the reports of a project in `mount`, the 산출물 tab's 보고서 view (mounts once; later
 * calls read the list again).
 */
export function showReports(projectId: string, mount: HTMLElement) {
  if (!root || rootIn !== mount) {
    root?.unmount();
    shownFor = undefined;
    const host = document.createElement('section');
    host.className = 'report-workspace';
    host.setAttribute('aria-label', '보고서');
    mount.replaceChildren(host);
    rootIn = mount;
    root = createRoot(host);
  }
  if (shownFor !== projectId) {
    shownFor = projectId;
    root.render(<ReportTab key={projectId} projectId={projectId} />);
  } else window.dispatchEvent(new Event('vide:reports-shown'));
}
