// 파일 지도 응답 (PLAN-52 T-318, ARCH-01 「작업 폴더(PLAN-52)」 `GET /projects/:id/workspace/map`): the
// shape the engine (src/server/workspace-map.ts) sends and the 파일 tab (src/ui/files-tab.tsx) reads.
/** The role keys of src/core/workspace-template.ts (kept here so the page needs no Node code). */
export type MapRole =
  | 'ops'
  | 'raw'
  | 'rhino'
  | 'cad'
  | 'review'
  | 'output'
  | 'snapshots'
  | 'references'
  | 'tools'
  | 'archive';

export type MapHost = 'rhino' | 'zwcad' | 'vide' | 'doc';
export type MapNodeKind = 'model' | 'drawing' | 'jig' | 'report' | 'note' | 'image' | 'file';
export type MapLinkKind =
  | 'xref'
  | 'sync-pair'
  | 'jig-io'
  | 'data-report'
  | 'checkout'
  | 'reference'
  | 'mention';
export type MapEventKind =
  | 'sync'
  | 'checkout'
  | 'release'
  | 'jig-run'
  | 'request-change'
  | 'server-updated';
export const MAP_LINK_KINDS: readonly MapLinkKind[] = [
  'xref',
  'sync-pair',
  'jig-io',
  'data-report',
  'checkout',
  'reference',
  'mention',
];

export interface MapCheckout {
  state: 'out' | 'released';
  /** Who checked it out (the record's user), when known. */
  by: string | null;
  at: string;
  releasedAt: string | null;
}
export interface MapNode {
  id: string;
  /** The file's path on this PC (UNC for a share); null for a record with no file (a jig result). */
  path: string | null;
  name: string;
  role: MapRole | null;
  host: MapHost;
  origin: 'local' | 'server';
  checkout: MapCheckout | null;
  kind: MapNodeKind;
  /** A server file with no remembered role: shown in the folded '그 밖 n' group. */
  folded?: boolean;
  modifiedAt?: string | null;
  linkId?: string;
  instanceId?: string;
}
export interface MapLink {
  from: string;
  to: string;
  kind: MapLinkKind;
  /** When the relation was first known (null: always shown). */
  at: string | null;
}
export interface MapEvent {
  at: string;
  kind: MapEventKind;
  nodeIds: string[];
  /** The record behind it (request, jig instance, checkout id), when any. */
  ref: string | null;
}
export interface WorkspaceMap {
  nodes: MapNode[];
  links: MapLink[];
  events: MapEvent[];
  generatedAt: string;
  /** The work folder's root, or null when the project has none (the map still shows records). */
  root: string | null;
  /** Some listing stopped at its limit. */
  truncated: boolean;
}
