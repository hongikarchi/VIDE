// The 파일 지도 data on the page (PLAN-52 T-318·T-319): the engine's map of a project, kept a few
// seconds so the 파일 tab and the composer's 영향 미리보기 share one read, the plain-language labels
// (Design §07 terms; no internal codes) and the files a request would touch.
import { api } from './gateway.ts';
import { connectedSet } from './chart/layout.ts';
import type {
  MapEventKind,
  MapLinkKind,
  MapNode,
  MapRole,
  WorkspaceMap,
} from '../contracts/workspace-map.ts';

export type { MapNode, WorkspaceMap } from '../contracts/workspace-map.ts';

const KEEP_MS = 15_000;
const kept = new Map<string, { at: number; map: Promise<WorkspaceMap> }>();

/** The project's map (kept 15 s; `fresh` reads again). */
export function fetchWorkspaceMap(projectId: string, fresh = false): Promise<WorkspaceMap> {
  const hit = kept.get(projectId);
  if (hit && !fresh && Date.now() - hit.at < KEEP_MS) return hit.map;
  const map = api(
    `/projects/${encodeURIComponent(projectId)}/workspace/map${fresh ? '?fresh' : ''}`,
    'GET',
    undefined,
    { quiet: ['NOT_FOUND', 'PROJECT_GONE'] },
  ) as Promise<WorkspaceMap>;
  kept.set(projectId, { at: Date.now(), map });
  map.catch(() => kept.delete(projectId));
  return map;
}

export const ROLE_LABEL: Record<MapRole, string> = {
  rhino: '모델',
  cad: '도면',
  raw: '자료',
  review: 'jig 결과',
  output: '보고서',
  snapshots: '검토본',
  ops: '노트',
  references: '레퍼런스',
  tools: '도구',
  archive: '아카이브',
};
export const HOST_LABEL: Record<MapNode['host'], string> = {
  rhino: 'Rhino',
  zwcad: 'ZWCAD',
  vide: 'VIDE',
  doc: '문서',
};
/** The legend's names of the relations (Design SCR-38). */
export const LINK_LABEL: Record<MapLinkKind, string> = {
  xref: 'xref',
  'sync-pair': '동기화 쌍',
  'jig-io': 'jig 입력→결과',
  'data-report': '데이터→보고서',
  checkout: '체크아웃↔원본',
  reference: '참조 이미지→요청',
  mention: '노트 언급',
};
/** The short relation words of the 영향 띠 (Design SCR-39). */
export const LINK_SHORT: Record<MapLinkKind, string> = {
  xref: 'xref',
  'sync-pair': '동기화 쌍',
  'jig-io': 'jig',
  'data-report': '데이터',
  checkout: '체크아웃',
  reference: '참조 이미지',
  mention: '노트 언급',
};
export const EVENT_LABEL: Record<MapEventKind, string> = {
  sync: '동기화',
  checkout: '체크아웃',
  release: '체크아웃 풀기',
  'jig-run': 'jig 실행',
  'request-change': '요청으로 바뀜',
  'server-updated': '서버 판 갱신',
};

const key = (path: string) => path.replace(/\//g, '\\').toLowerCase();
const base = (path: string) => key(path).split('\\').pop() ?? '';

/**
 * The map's files a request names: by path (a path chip, the linked file), by link id, or by a
 * file name written in the words (at least five characters with an extension).
 */
export function resolveTargets(
  map: WorkspaceMap,
  targets: { paths?: readonly string[]; linkIds?: readonly string[]; text?: string },
): string[] {
  const out = new Set<string>();
  const paths = new Set((targets.paths ?? []).map(key));
  const links = new Set(targets.linkIds ?? []);
  const words = (targets.text ?? '').toLowerCase();
  for (const node of map.nodes) {
    if (node.path && paths.has(key(node.path))) out.add(node.id);
    else if (node.linkId && links.has(node.linkId)) out.add(node.id);
    else if (
      words &&
      !node.folded &&
      node.name.length >= 5 &&
      /\.[a-z0-9]{2,5}$/i.test(node.name) &&
      words.includes(node.name.toLowerCase())
    )
      out.add(node.id);
  }
  // A path chip naming a file the map has under another spelling (the same name in the folder).
  if (!out.size && paths.size)
    for (const node of map.nodes)
      if (node.path && [...paths].some((path) => base(path) === base(node.path!))) out.add(node.id);
  return [...out];
}

export interface Impact {
  targets: string[];
  /** The other files tied to the targets, each with the relation it was reached by. */
  items: { node: MapNode; kind: MapLinkKind }[];
}
/** The files a change to `targets` reaches through the map's relations (the whole chain). */
export function impactOf(map: WorkspaceMap, targets: readonly string[]): Impact {
  const reached = connectedSet(map.links, targets);
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const items: Impact['items'] = [];
  for (const [id, kind] of reached) {
    const node = byId.get(id);
    if (!node || kind === null) continue;
    items.push({ node, kind: kind as MapLinkKind });
  }
  return { targets: [...targets], items };
}

/** '· A-평면.dwg(동기화 쌍) · xref 2 · …' parts of the 영향 띠, at most `max` before '… 외 n'. */
export function impactParts(impact: Impact, max = 3): { parts: string[]; more: number } {
  const groups = new Map<MapLinkKind, MapNode[]>();
  for (const item of impact.items)
    groups.set(item.kind, [...(groups.get(item.kind) ?? []), item.node]);
  const parts = [...groups].map(([kind, nodes]) =>
    nodes.length === 1
      ? `${nodes[0]!.name}(${LINK_SHORT[kind]})`
      : `${LINK_SHORT[kind]} ${nodes.length}`,
  );
  return { parts: parts.slice(0, max), more: Math.max(0, parts.length - max) };
}
