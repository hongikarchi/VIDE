// Rail (PLAN-26 T-113, region A): the rail of fixed destinations. Static markup moved from
// index.html; it has no state or props and never re-renders until its region makes it stateful.
import { memo } from 'react';

export const Rail = memo(function Rail() {
  return (
    <>
      <nav className="rail" aria-label="작업 공간 탐색">
        <a
          id="rail-home"
          className="rail-home"
          hidden
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
        />
        <button
          data-workspace-target="model"
          data-section="document-tree"
          title="모델 · 3D 뷰와 작업 문서"
          aria-label="모델"
          data-icon="cube"
        />
        <button
          data-workspace-target="history"
          data-section="task-list"
          title="작업 이력 · 요청 기록"
          aria-label="작업 이력"
          data-icon="history"
        />
        <button
          id="rail-facts"
          data-workspace-target="data"
          title="자료 · 이 프로젝트의 DB"
          aria-label="자료"
          data-icon="database"
        />
        <button
          id="jigs"
          data-workspace-target="jig"
          title="JIG · jig 목록과 새로 만들기 (열어 둔 작업본은 위쪽 줄)"
          aria-label="JIG"
          data-icon="jig"
        />
        <button
          data-workspace-target="output"
          title="산출물 · 도면 · 보고서 · 검토본 · 렌더링"
          aria-label="산출물"
          data-icon="output"
        />
        <button
          id="rail-feedback"
          className="rail-feedback"
          title="피드백 보내기"
          aria-label="피드백 보내기"
          data-icon="message"
        />
        <button
          id="rail-theme"
          title="다크 테마로 전환"
          aria-label="다크 테마로 전환"
          data-icon="moon"
        />
        <button id="workspace-settings" className="rail-settings" title="설정" aria-label="설정">
          ⚙
        </button>
      </nav>
    </>
  );
});
