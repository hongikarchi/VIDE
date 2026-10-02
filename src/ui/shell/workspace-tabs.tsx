// WorkspaceTabs (PLAN-26 T-113, region A; Design §03 작업공간 탭): the row over the centre column
// with one closable tab per open context (a jig instance, a reference image), and below 900 px one
// menu that also lists the fixed screens. It renders from src/ui/workspaces.ts; a host panel never
// initializes the row, so it stays empty there. The panel width handles render here too, as direct
// children of `.workspace` (PanelResize).
import { memo, type KeyboardEvent } from 'react';
import { useStore } from '../store/core.ts';
import {
  closeContextTab,
  menuWorkspaces,
  setWorkspace,
  tabId,
  workspacesState,
  type ContextTab,
} from '../workspaces.ts';
import { jigIconSvg } from '../jig-icons.ts';
import { PanelResize } from './panel-resize.tsx';

function TabButton(props: {
  id: string;
  label: string;
  title?: string;
  icon?: string;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      data-workspace={props.id}
      aria-selected={props.selected}
      tabIndex={props.selected ? 0 : -1}
      title={props.title || undefined}
      onClick={() => setWorkspace(props.id)}
    >
      {props.icon ? (
        // The jig's icon, like the rail's (aria-hidden: the name stays the tab's name).
        <span
          className="workspace-tab-icon"
          dangerouslySetInnerHTML={{ __html: jigIconSvg(props.icon) }}
        />
      ) : null}
      {props.label}
    </button>
  );
}
function CloseButton({ tab, focusable }: { tab: ContextTab; focusable: boolean }) {
  return (
    <button
      type="button"
      className="workspace-tab-close"
      tabIndex={focusable ? 0 : -1}
      aria-label={`${tab.label} 탭 닫기`}
      title={
        tab.kind === 'reference'
          ? '탭 닫기 · 영역은 남고 첨부의 [영역 표시]로 다시 엽니다'
          : '탭 닫기 · 작업본은 남고 JIG 목록에서 다시 엽니다'
      }
      onClick={(event) => {
        event.stopPropagation();
        closeContextTab(tab.instanceId, tab.kind);
      }}
    >
      ×
    </button>
  );
}

function onListKey(event: KeyboardEvent<HTMLDivElement>) {
  const list = event.currentTarget;
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const at = tabs.findIndex((button) => button === document.activeElement);
  if (at < 0) return;
  const current = tabs[at].dataset.workspace!;
  const bar = () => document.getElementById('workspace-tabs');
  const move = (k: number) => {
    event.preventDefault();
    setWorkspace(tabs[(k + tabs.length) % tabs.length].dataset.workspace!);
    bar()?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  };
  const context = workspacesState.context;
  if (event.key === 'ArrowRight') move(at + 1);
  else if (event.key === 'ArrowLeft') move(at - 1);
  else if (event.key === 'Home') move(0);
  else if (event.key === 'End') move(tabs.length - 1);
  else if (event.key === 'Delete' && context.some((tab) => tabId(tab) === current)) {
    event.preventDefault();
    const tab = context.find((entry) => tabId(entry) === current)!;
    closeContextTab(tab.instanceId, tab.kind);
    bar()?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }
}

function Row({ active, context }: { active: string; context: readonly ContextTab[] }) {
  const open = context.find((tab) => tabId(tab) === active);
  return (
    <>
      {/* Only what is open: the fixed screens are the rail's (user decision 2026-10-01). */}
      <div className="workspace-tablist" role="tablist" aria-label="작업공간" onKeyDown={onListKey}>
        {context.map((tab) => {
          const id = tabId(tab);
          return (
            <span
              key={id}
              className="workspace-context-tab"
              data-active={id === active ? '' : undefined}
            >
              <TabButton
                id={id}
                label={tab.label}
                title={tab.title ?? tab.label}
                icon={tab.icon}
                selected={id === active}
              />
              <CloseButton tab={tab} focusable={id === active} />
            </span>
          );
        })}
      </div>
      {/* Narrow screens: one menu in the centre's head instead of the row. */}
      <div className="workspace-menu">
        <select
          aria-label="작업공간"
          // The 만들기 screen shows as JIG, the screen it belongs to.
          value={active === 'make' ? 'jig' : active}
          onChange={(event) => setWorkspace(event.currentTarget.value)}
        >
          {menuWorkspaces().map((tab) => (
            <option key={tab.id} value={tab.id} disabled={!tab.ready} title={tab.title}>
              {tab.ready ? tab.label : `${tab.label} · 준비 중`}
            </option>
          ))}
          {(
            [
              ['jig', '열린 jig'],
              ['reference', '참고 이미지'],
            ] as const
          ).map(([kind, label]) => {
            const tabs = context.filter((tab) => (tab.kind ?? 'jig') === kind);
            if (!tabs.length) return null;
            return (
              <optgroup key={kind} label={label}>
                {tabs.map((tab) => (
                  <option key={tabId(tab)} value={tabId(tab)}>
                    {tab.label}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        {open ? <CloseButton key={tabId(open)} tab={open} focusable /> : null}
      </div>
    </>
  );
}

export const WorkspaceTabs = memo(function WorkspaceTabs() {
  useStore(workspacesState, (s) => s.version);
  const { mounted, active, context } = workspacesState;
  return (
    <>
      {/* With nothing open the row hides where the rail is shown, so the content gets the space. */}
      <div
        className="workspace-tabs"
        id="workspace-tabs"
        data-empty={mounted && !context.length ? '' : undefined}
      >
        {mounted ? <Row active={active} context={context} /> : null}
      </div>
      <PanelResize />
    </>
  );
});
