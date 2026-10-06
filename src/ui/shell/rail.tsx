// Rail (PLAN-26 T-113, region A; user decision 2026-10-01): the fixed destinations, one pressed for
// the screen shown. The model screen's two left-panel sections are two destinations (모델, 작업
// 이력); a context tab (a jig instance) belongs to JIG. Pressed is a soft background only
// (style.css `.rail`). It renders from the workspace tabs (src/ui/workspaces.ts) and the layout
// slice. The settings button is wired by src/ui/workspace-status.ts; the other icons are filled by
// paintIcons (src/ui/icons.ts), except the theme toggle's, which this component draws.
import { memo } from 'react';
import { useStore } from '../store/core.ts';
import {
  layoutState,
  paintThemeToggle,
  revealPanel,
  selectSection,
  setMobileView,
} from '../store/layout.ts';
import { sessionState } from '../store/session.ts';
import {
  activeWorkspace,
  setWorkspace,
  workspaceDestination,
  workspacesState,
} from '../workspaces.ts';
import { showFeedback } from '../feedback.ts';
import { currentTheme, setTheme } from '../theme.ts';
import { iconSvg } from '../icons.ts';

/**
 * 대시보드 · 자료 · 노트·일지 · JIG (the list) · 산출물 open their screens once a project is open. Order (user
 * 2026-10-06): 홈 · 대시보드 · 자료 · 노트·일지 · 모델 · 이력 · JIG · 산출물.
 */
function openTarget(target: string) {
  if (sessionState.project) setWorkspace(target);
}
/** 모델 and 작업 이력 open the model screen on their left-panel section. */
function openSection(section: 'document-tree' | 'task-list') {
  revealPanel('left');
  // Mobile navigation owns visibility of the same panels: 모델 is the model view there and 작업
  // 이력 the documents view.
  setMobileView(section === 'task-list' ? 'documents' : 'model');
  selectSection(section);
  // The documents panel belongs to the model screen: 모델 and 작업 이력 bring that screen back.
  if (activeWorkspace() !== 'model') setWorkspace('model');
}

export const Rail = memo(function Rail() {
  useStore(workspacesState, (s) => s.version);
  const ready = useStore(layoutState, (s) => s.ready);
  const section = useStore(layoutState, (s) => s.section);
  const theme = useStore(layoutState, (s) => s.railTheme);
  const homeShown = useStore(layoutState, (s) => s.homeShown);
  const homeHref = useStore(layoutState, (s) => s.homeHref);
  const destination = workspaceDestination();
  const current =
    destination === 'model' && activeWorkspace() === 'model' && section === 'task-list'
      ? 'history'
      : destination;
  // Pressed exists once the panels are set up (before, the markup had none).
  const pressed = (target: string) =>
    ready ? (String(target === current) as 'true' | 'false') : undefined;
  const dark = theme === 'dark';
  const themeLabel = dark ? '라이트 테마로 전환' : '다크 테마로 전환';
  const themeIcon = dark ? 'sun' : 'moon';
  return (
    <>
      <nav className="rail" aria-label="작업 공간 탐색">
        <a
          id="rail-home"
          className="rail-home"
          hidden={!homeShown}
          href={homeHref}
          title="모든 프로젝트 (웹사이트)"
          aria-label="모든 프로젝트"
          data-icon="home"
        />
        <button
          id="rail-dashboard"
          data-workspace-target="dashboard"
          title="대시보드 · 이 프로젝트의 연결 파일·jig·최근 작업"
          aria-label="대시보드"
          data-icon="dashboard"
          aria-pressed={pressed('dashboard')}
          onClick={() => openTarget('dashboard')}
        />
        <button
          id="rail-facts"
          data-workspace-target="data"
          title="자료 · 이 프로젝트의 DB"
          aria-label="자료"
          data-icon="database"
          aria-pressed={pressed('data')}
          onClick={() => openTarget('data')}
        />
        <button
          id="rail-notes"
          data-workspace-target="notes"
          title="노트·일지 · 구성원이 함께 쓰는 노트"
          aria-label="노트·일지"
          data-icon="notebook"
          aria-pressed={pressed('notes')}
          onClick={() => openTarget('notes')}
        />
        <button
          data-workspace-target="model"
          data-section="document-tree"
          title="모델 · 3D 뷰와 작업 문서"
          aria-label="모델"
          data-icon="cube"
          aria-pressed={pressed('model')}
          onClick={() => openSection('document-tree')}
        />
        <button
          data-workspace-target="history"
          data-section="task-list"
          title="작업 이력 · 요청 기록"
          aria-label="작업 이력"
          data-icon="history"
          aria-pressed={pressed('history')}
          onClick={() => openSection('task-list')}
        />
        <button
          id="jigs"
          data-workspace-target="jig"
          title="JIG · jig 목록과 새로 만들기 (열어 둔 작업본은 위쪽 줄)"
          aria-label="JIG"
          data-icon="jig"
          aria-pressed={pressed('jig')}
          onClick={() => openTarget('jig')}
        />
        <button
          data-workspace-target="output"
          title="산출물 · 도면 · 보고서 · 검토본 · 렌더링"
          aria-label="산출물"
          data-icon="output"
          aria-pressed={pressed('output')}
          onClick={() => openTarget('output')}
        />
        <button
          id="rail-feedback"
          className="rail-feedback"
          title="피드백 보내기"
          aria-label="피드백 보내기"
          data-icon="message"
          onClick={() => void showFeedback()}
        />
        <button
          id="rail-theme"
          title={themeLabel}
          aria-label={themeLabel}
          data-icon={themeIcon}
          dangerouslySetInnerHTML={{ __html: iconSvg(themeIcon) }}
          onClick={() => {
            setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
            paintThemeToggle();
          }}
        />
        <button id="workspace-settings" className="rail-settings" title="설정" aria-label="설정">
          ⚙
        </button>
      </nav>
    </>
  );
});
