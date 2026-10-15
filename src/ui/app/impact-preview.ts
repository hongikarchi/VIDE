// 요청 전 영향 미리보기 (PLAN-52 T-319, Design SCR-39): while a request is written, the file it
// names — a path chip, a file name in the words, or the linked file it works on (pins, file words)
// — is looked up in the project's 파일 지도 and the files tied to it show as one line over the send
// button. It never blocks sending; it goes when the request is sent or names no mapped file.
import { worksOnFile } from '../request-route.ts';
import { fetchWorkspaceMap, impactOf, impactParts, resolveTargets } from '../workspace-map-api.ts';
import { draftState } from '../store/draft.ts';
import { sessionState } from '../store/session.ts';
import { panelMode } from './context.ts';
import { routedLink } from './composer.ts';
import { hideImpactCard, showImpactCard } from './thread.ts';

let timer: ReturnType<typeof setTimeout> | undefined;
let asked = 0;
/** The signature of what the strip was last worked out for (no refetch while it stays). */
let last = '';

/** Works the strip out again shortly after the draft changed (typing stays smooth). */
export function updateImpactPreview() {
  clearTimeout(timer);
  timer = setTimeout(() => void preview(), 250);
}

async function preview() {
  const project = sessionState.project;
  const state = draftState.state;
  if (!project || panelMode || sessionState.busy || draftState.routing) {
    last = '';
    hideImpactCard();
    return;
  }
  const text = state.body;
  const paths = (state.paths ?? [])
    .filter((entry) => entry.kind === 'file')
    .map((entry) => entry.path);
  const linkIds: string[] = [];
  if (state.pins.length || worksOnFile(text)) {
    const link = routedLink();
    if (link) linkIds.push(link.id);
  }
  if (!text.trim() && !paths.length) {
    last = '';
    hideImpactCard();
    return;
  }
  const signature = JSON.stringify([project.id, text, paths, linkIds]);
  if (signature === last) return;
  const mine = ++asked;
  let map;
  try {
    map = await fetchWorkspaceMap(project.id);
  } catch {
    hideImpactCard();
    return;
  }
  if (mine !== asked || sessionState.project?.id !== project.id) return;
  last = signature;
  // No work folder, no file map: the strip is not shown (SPEC-02.17 7, SPEC-01.13 7).
  if (!map.root) {
    hideImpactCard();
    return;
  }
  const targets = resolveTargets(map, { paths, linkIds, text });
  const impact = impactOf(map, targets);
  if (!impact.items.length) {
    hideImpactCard();
    return;
  }
  const { parts, more } = impactParts(impact);
  showImpactCard({
    kind: 'impact',
    count: impact.items.length,
    parts,
    more,
    showMap: () =>
      void import('../files-tab.tsx').then((screen) => screen.showFilesMap(project.id, targets)),
  });
}

/** The request went: the strip goes with it. */
export function clearImpactPreview() {
  clearTimeout(timer);
  asked++;
  last = '';
  hideImpactCard();
}
