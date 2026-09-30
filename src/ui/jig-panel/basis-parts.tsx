import { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FactDetail } from '../knowledge-jig.tsx';
import { FactBadge } from '../kit/settings.tsx';
import type { Review } from '../facts-api.ts';
import type { PanelSetting } from './bindings.ts';
import { basisAttributes, statementOf } from './registry.ts';

// The fact window of a basis chip (Design 근거 칩 "누르면 진술 창을 연다", SCR-19, PLAN-22 T-065):
// the statement, its excerpt with the quoted passage marked, [원본 열기] (a person's action), the
// review actions and a way to the 자료 tab. One window at a time, over the page, closed with Esc.

/** A setting's basis chip that opens the fact window when the value rests on a statement. */
export function BasisChip({ setting }: { setting: PanelSetting }) {
  const id = statementOf(setting);
  if (id === undefined) return <FactBadge setting={setting} />;
  return (
    <span className="fact-basis-chip" {...basisAttributes(setting)} title={`진술 ${id} 보기`}>
      <FactBadge setting={setting} />
    </span>
  );
}

function FactWindow({
  projectId,
  statementId,
  onClose,
}: {
  projectId: string;
  statementId: number;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    addEventListener('keydown', key);
    return () => {
      removeEventListener('keydown', key);
      before?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fact-window-backdrop" onClick={onClose}>
      <div
        ref={box}
        className="fact-window"
        role="dialog"
        aria-modal="true"
        aria-label={`진술 ${statementId}`}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="fact-window-head">
          <strong>근거 진술</strong>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              onClose();
              void Promise.all([import('../facts-tab.tsx'), import('../workspaces.ts')]).then(
                ([screen, tabs]) => {
                  screen.showStatement(projectId, statementId);
                  tabs.setWorkspace('data');
                },
              );
            }}
          >
            자료 탭에서 보기
          </button>
          <button type="button" aria-label="닫기" onClick={onClose}>
            ×
          </button>
        </header>
        <FactDetail
          projectId={projectId}
          statementId={statementId}
          onReviewed={(id: number, review: Review) =>
            window.dispatchEvent(
              new CustomEvent('vide:facts-reviewed', { detail: { projectId, id, review } }),
            )
          }
        />
        <small className="knowledge-meta">
          오염·기각으로 표시하면 이 진술을 근거로 쓴 설정값은 ‘근거 무효’가 되어 계산 전 점검에서
          막힙니다.
        </small>
      </div>
    </div>
  );
}

let root: Root | undefined;
/** Open the fact window for one statement of a project (replaces a window already open). */
export function openFactWindow(projectId: string, statementId: number) {
  if (!root) {
    const host = document.createElement('div');
    host.className = 'fact-window-host';
    document.body.append(host);
    root = createRoot(host);
  }
  const close = () => root?.render(null);
  root.render(
    <FactWindow
      key={`${projectId}:${statementId}`}
      projectId={projectId}
      statementId={statementId}
      onClose={close}
    />,
  );
}
export function closeFactWindow() {
  root?.render(null);
}
