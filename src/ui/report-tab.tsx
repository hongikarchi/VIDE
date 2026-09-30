// The 보고서 workspace tab (PLAN-22 T-057, SPEC-07.11, Design SCR-17): the left column lists the
// report frames of the project's jig instances (작업본) and the chosen report's gates; the centre
// previews it on the chosen paper (A3 landscape or A4 portrait) with print and save. The engine
// resolves and renders the report (src/server/report.ts); the app draws the resolved model with
// the kit's ReportPage (the app's CSP forbids the exported page's inline styles in a frame), and
// [HTML 저장] keeps the engine's self-contained page without scripts. The in-app report has one way
// back, to the instance and the settings it was made from; the exported page has no controls.
import { useCallback, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReportModel } from '../jigs/runtime/report-format.ts';
import { api, errors } from './gateway.ts';
import { ReportPage } from './kit/report.tsx';
import { setWorkspace } from './workspaces.ts';
import './report-tab.css';

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
export interface RenderedReport {
  report: FrameInfo;
  instance: { id: string; title: string; jig: { name: string; version: string } };
  origin: { project: string; instance: string; version: string; at?: string };
  model: ReportModel;
  html: string;
}
export type Paper = 'a3' | 'a4';

const GATE_LABEL: Record<string, string> = {
  'claim-consistent': '주장과 결과 일치',
  'numbers-in-source': '숫자의 출처',
  'unchecked-listed': '검토하지 않은 항목 표시',
};
const PAPER: Record<Paper, string> = { a3: 'A3 가로', a4: 'A4 세로' };
const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;
const message = (error: unknown) => {
  const code = error instanceof Error ? error.message : String(error);
  return errors[code] ?? '보고서를 불러오지 못했습니다.';
};
/** A file name for the saved page: instance and report title, no path characters. */
export const reportFileName = (r: Pick<RenderedReport, 'instance' | 'report'>) =>
  `${r.instance.title}-${r.report.title}`.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) + '.html';
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

function ReportTab({ projectId }: { projectId: string }) {
  const [list, setList] = useState<ListedReports[] | null>(null);
  const [error, setError] = useState<string>();
  const [chosen, setChosen] = useState<{ instanceId: string; reportId: string }>();
  const [shown, setShown] = useState<RenderedReport>();
  const [loading, setLoading] = useState(false);
  const [paper, setPaper] = useState<Paper>('a3');

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
  const render = useCallback(async () => {
    if (!chosen) {
      setShown(undefined);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      setShown(
        (await api(
          `${projectPath(projectId)}/jig-instances/${encodeURIComponent(chosen.instanceId)}/reports/${encodeURIComponent(chosen.reportId)}`,
        )) as RenderedReport,
      );
    } catch (e) {
      setShown(undefined);
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, chosen]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);
  useEffect(() => {
    void render();
  }, [render]);
  useEffect(() => {
    // Coming back to the tab reads the list and the report again (results may have changed).
    const again = () => {
      void refreshList();
      void render();
    };
    window.addEventListener('vide:reports-shown', again);
    return () => window.removeEventListener('vide:reports-shown', again);
  }, [refreshList, render]);

  const print = () => {
    // Print CSS (report-tab.css) keeps only the report page, on the chosen paper.
    document.body.dataset.reportPaper = paper;
    window.print();
  };
  const save = () => {
    if (!shown) return;
    const url = URL.createObjectURL(new Blob([shown.html], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = reportFileName(shown);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const back = () => shown && setWorkspace('', { instanceId: shown.instance.id });

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
              {shown.model.sections.map((s) => (
                <li key={s.id}>
                  {s.no} {s.title.text}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </nav>
      <div className="report-preview">
        <div className="report-toolbar">
          <strong>{shown ? `${shown.instance.title} · ${shown.model.title}` : '보고서'}</strong>
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
          <button type="button" onClick={print} disabled={!shown}>
            인쇄
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!shown}
            title="스크립트 없는 HTML 한 파일로 저장합니다"
          >
            HTML 저장
          </button>
        </div>
        {error ? (
          <p className="report-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="report-paper" data-paper={paper} aria-busy={loading}>
          {shown ? (
            <div className="report-sheet">
              <ReportPage model={shown.model} origin={shown.origin} onBack={back} />
            </div>
          ) : (
            <p className="report-empty">
              {loading ? '보고서를 만드는 중' : list?.length ? '보고서를 고르십시오.' : ''}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

let root: Root | undefined;
let shownFor: string | undefined;

/** Show the report tab of a project (mounts once; later calls read the list again). */
export function showReports(projectId: string) {
  const workspace = document.querySelector<HTMLElement>('.workspace');
  if (!workspace) return;
  if (!root) {
    const host = document.createElement('section');
    host.className = 'report-workspace';
    host.setAttribute('aria-label', '보고서');
    workspace.append(host);
    root = createRoot(host);
  }
  if (shownFor !== projectId) {
    shownFor = projectId;
    root.render(<ReportTab key={projectId} projectId={projectId} />);
  } else window.dispatchEvent(new Event('vide:reports-shown'));
}
