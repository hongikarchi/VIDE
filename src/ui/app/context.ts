// Page context (PLAN-26 T-113, region E): the host panel mode (?panel=rhino|zwcad, Design SCR-12)
// and the open project.
import { setTheme, storedTheme } from '../theme.ts';
import { type PanelState } from '../host-panel.tsx';
import { sessionState } from '../store/session.ts';

export const panelParams = new URLSearchParams(location.search);
export const panelHost = (['rhino', 'zwcad'] as const).find(
  (host) => host === panelParams.get('panel'),
);
export const panelMode = panelHost !== undefined;
/** What the panel header shows; refreshed by the host poll. */
export const panelView: {
  file: string;
  state: PanelState;
  detail: string;
  selection: string[];
} = { file: panelParams.get('name') ?? '', state: 'checking', detail: '', selection: [] };
export function currentProject() {
  if (!sessionState.project) throw Error('프로젝트를 먼저 여세요.');
  return sessionState.project;
}

export function initContext1() {
  // The work screen's theme is the one this browser chose; a host panel follows its host below.
  if (!panelMode) setTheme(storedTheme(), false);
}
