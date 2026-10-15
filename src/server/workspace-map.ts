// 파일 지도 (PLAN-52 T-318, ARCH-01 「작업 폴더(PLAN-52)」, Design SCR-38): how the project's files
// are tied together and what happened to them, gathered into one read. Nodes are the files of the
// work folder's role folders, the connected server folder's files (the remembered roles first, the
// others folded), the linked documents, the jig results and the notes; links are the relations
// each feature already keeps (xref reads, Sync pairs of the drawing backflow baselines, jig inputs
// and outputs, data → report copies, checkouts, reference images → requests, files named in
// notes); events are Syncs, checkouts and releases, jig runs, requests that changed a file and
// server file times. Everything is read from the records VIDE already keeps and from folder
// listings; host files (3dm, dwg) are never opened — only VIDE's own Markdown and JSON are read.
// Nothing is stored: the event index of ARCH-01 is computed on each read (see the routes' cache).
import { createHash } from 'node:crypto';
import { existsSync, type Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '../core/store.ts';
import type { ProjectFolder } from '../core/project-folders.ts';
import {
  workspaceOf,
  type VideWorkspaceConfig,
  type Workspace,
  type WorkspaceRole,
} from '../core/workspace-config.ts';
import { WORKSPACE_ROLES } from '../core/workspace-template.ts';
import { buildXrefGraph, pathKey, type XrefFileRead } from '../core/xref-graph.ts';

import type {
  MapCheckout,
  MapEvent,
  MapLink,
  MapLinkKind,
  MapNode,
  MapNodeKind,
  MapHost,
  WorkspaceMap,
} from '../contracts/workspace-map.ts';
export type * from '../contracts/workspace-map.ts';
export { MAP_LINK_KINDS } from '../contracts/workspace-map.ts';

/** File system access, injectable so a test can prove which files were read. */
export interface MapIo {
  readdir(dir: string): Promise<Dirent[]>;
  stat(path: string): Promise<{ mtimeMs: number } | null>;
  /** Reads VIDE's own text files only (Markdown notes, JSON records). */
  readText(path: string): Promise<string | null>;
  exists(path: string): boolean;
}
const MAX_TEXT = 256 * 1024;
export const nodeIo: MapIo = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  stat: (path) => stat(path).catch(() => null),
  readText: async (path) => {
    try {
      const info = await stat(path);
      if (info.size > MAX_TEXT) return null;
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  exists: (path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  },
};

export interface MapSources {
  store: Store;
  folders: { list(projectId: string): ProjectFolder[] };
  isProject?: (id: string) => boolean;
  /** `<데이터>` (notes and reference boards live there); undefined in memory. */
  dataDirectory?: string;
  io?: MapIo;
  now?: () => Date;
}

const LIMITS = {
  localFiles: 3000,
  localDepth: 6,
  roleFiles: 600,
  roleDepth: 4,
  foldedFiles: 300,
  foldedDepth: 2,
  notes: 300,
  events: 3000,
};
const SKIP = new Set(['.git', 'node_modules', '.vide', '$recycle.bin', 'thumbs.db', 'desktop.ini']);
const HOST_FILE = /\.(3dm|3dmbak|dwg|dxf|dwl|dwl2|bak|rvt|rfa)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i;
const PATH_TOKEN = /\[파일 · ([^\]\n]+)\]/g;

const idOf = (path: string) =>
  'n' + createHash('sha1').update(pathKey(path)).digest('hex').slice(0, 16);
const nameOf = (path: string) => win32.basename(path.replace(/[\\/]+$/, '')) || path;
const iso = (ms: number) => new Date(ms).toISOString();
const json = (text: unknown) => {
  try {
    return typeof text === 'string' ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const under = (root: string, path: string) => {
  const base = pathKey(root).replace(/\\+$/, '');
  const target = pathKey(path);
  return target === base || target.startsWith(base + '\\');
};
/** Runs a query on a table that may not exist yet (derived tables, later migrations). */
function rows(db: DatabaseSync, sql: string, ...args: (string | number)[]) {
  try {
    return db.prepare(sql).all(...args) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

function kindOf(path: string, role: WorkspaceRole | null): MapNodeKind {
  const lower = path.toLowerCase();
  if (/\.3dm(bak)?$/.test(lower)) return 'model';
  if (/\.(dwg|dxf)$/.test(lower)) return 'drawing';
  if (IMAGE.test(lower)) return 'image';
  if (role === 'review' && /[\\/]data\.json$/.test(lower)) return 'jig';
  if (/\.html?$/.test(lower) && (role === 'review' || role === 'output' || role === 'snapshots'))
    return 'report';
  if (/\.md$/.test(lower) && role === 'ops') return 'note';
  return 'file';
}
function hostOf(path: string, kind: MapNodeKind): MapHost {
  if (kind === 'model') return 'rhino';
  if (kind === 'drawing') return 'zwcad';
  if (kind === 'jig' || kind === 'report' || kind === 'note') return 'vide';
  return /\.(json|html?)$/i.test(path) && /vide/i.test(path) ? 'vide' : 'doc';
}

/** Gathers the map of one project. Never throws for a missing record or folder. */
export async function collectWorkspaceMap(
  sources: MapSources,
  projectId: string,
): Promise<WorkspaceMap> {
  const io = sources.io ?? nodeIo;
  const now = sources.now ?? (() => new Date());
  const db = sources.store.db(projectId);
  const nodes = new Map<string, MapNode>();
  const links = new Map<string, MapLink>();
  const events: MapEvent[] = [];
  let truncated = false;

  let ws: Workspace | null = null;
  try {
    ws = await workspaceOf(sources.folders, projectId, { isProject: sources.isProject });
  } catch {
    ws = null; // a broken manifest: the map still shows what the records hold
  }
  const server =
    ws && ws.cfg.schema === 'vide-workspace/1'
      ? ((ws.cfg as VideWorkspaceConfig).server ?? null)
      : null;
  /** Role folders, longest first: [absolute folder, role, origin]. */
  const roleFolders: [string, WorkspaceRole, 'local' | 'server'][] = [];
  if (ws)
    for (const role of WORKSPACE_ROLES) {
      const dir = ws.paths[role];
      if (dir) roleFolders.push([dir, role, 'local']);
    }
  if (server?.root)
    for (const role of WORKSPACE_ROLES) {
      const relative = server.paths?.[role];
      if (typeof relative === 'string')
        roleFolders.push([win32.resolve(server.root, relative), role, 'server']);
    }
  roleFolders.sort((a, b) => b[0].length - a[0].length);
  const placeOf = (path: string): { role: WorkspaceRole | null; origin: 'local' | 'server' } => {
    for (const [dir, role, origin] of roleFolders) if (under(dir, path)) return { role, origin };
    if (ws && under(ws.root, path)) return { role: null, origin: 'local' };
    const remote = path.startsWith('\\\\') || (!!server?.root && under(server.root, path));
    return { role: null, origin: remote ? 'server' : 'local' };
  };

  const addFile = (path: string, extra: Partial<MapNode> & { mtimeMs?: number } = {}): MapNode => {
    const id = idOf(path);
    const known = nodes.get(id);
    if (known) {
      if (extra.linkId && !known.linkId) known.linkId = extra.linkId;
      if (extra.folded === false) delete known.folded;
      return known;
    }
    const place = placeOf(path);
    const role = extra.role !== undefined ? extra.role : place.role;
    const kind = extra.kind ?? kindOf(path, role);
    const node: MapNode = {
      id,
      path,
      name: nameOf(path),
      role,
      host: extra.host ?? hostOf(path, kind),
      origin: extra.origin ?? place.origin,
      checkout: null,
      kind,
      ...(extra.folded ? { folded: true } : {}),
      modifiedAt: extra.mtimeMs ? iso(extra.mtimeMs) : null,
      ...(extra.linkId ? { linkId: extra.linkId } : {}),
      ...(extra.instanceId ? { instanceId: extra.instanceId } : {}),
    };
    nodes.set(id, node);
    return node;
  };
  const link = (
    from: string | undefined,
    to: string | undefined,
    kind: MapLinkKind,
    at: string | null,
  ) => {
    if (!from || !to || from === to) return;
    const key = `${kind}|${from}|${to}`;
    const known = links.get(key);
    if (known) {
      if (at && (!known.at || at < known.at)) known.at = at;
      return;
    }
    links.set(key, { from, to, kind, at });
  };

  /** Files under a folder (names and times only; contents are never read here). */
  async function walk(
    dir: string,
    depth: number,
    limit: number,
    visit: (path: string, mtimeMs: number) => void,
  ) {
    let count = 0;
    const queue: [string, number][] = [[dir, 0]];
    while (queue.length) {
      const [folder, level] = queue.shift()!;
      let entries: Dirent[];
      try {
        entries = await io.readdir(folder);
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (SKIP.has(entry.name.toLowerCase()) || entry.name.startsWith('~$')) continue;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          if (level + 1 < depth) queue.push([path, level + 1]);
          continue;
        }
        if (!entry.isFile()) continue;
        if (count >= limit) {
          truncated = true;
          return;
        }
        count++;
        const info = await io.stat(path);
        visit(path, info?.mtimeMs ?? 0);
      }
    }
  }

  // 1. The work folder's role folders (local tree).
  if (ws)
    for (const role of WORKSPACE_ROLES) {
      const dir = ws.paths[role];
      if (!dir) continue;
      await walk(dir, LIMITS.localDepth, LIMITS.localFiles, (path, mtimeMs) => {
        addFile(path, { mtimeMs });
      });
    }
  // 2. The connected server folder: remembered roles in full, the rest folded.
  if (server?.root) {
    const remembered = Object.values(server.paths ?? {})
      .filter((value): value is string => typeof value === 'string')
      .map((relative) => win32.resolve(server.root, relative));
    for (const dir of remembered)
      await walk(dir, LIMITS.roleDepth, LIMITS.roleFiles, (path, mtimeMs) => {
        const node = addFile(path, { mtimeMs, origin: 'server' });
        if (mtimeMs)
          events.push({ at: iso(mtimeMs), kind: 'server-updated', nodeIds: [node.id], ref: null });
      });
    await walk(server.root, LIMITS.foldedDepth, LIMITS.foldedFiles, (path, mtimeMs) => {
      if (remembered.some((dir) => under(dir, path))) return;
      addFile(path, { mtimeMs, origin: 'server', role: null, folded: true });
    });
  }
  // Other project folders (not the work folder, not the server memory): folded.
  for (const folder of sources.folders.list(projectId)) {
    if (folder.kind !== 'project') continue;
    if (ws && (under(ws.root, folder.path) || under(folder.path, ws.root))) continue;
    if (server?.root && (under(server.root, folder.path) || under(folder.path, server.root)))
      continue;
    await walk(folder.path, LIMITS.foldedDepth, LIMITS.foldedFiles, (path, mtimeMs) => {
      addFile(path, {
        mtimeMs,
        role: null,
        folded: true,
        origin: path.startsWith('\\\\') ? 'server' : 'local',
      });
    });
  }

  // 3. Linked documents (SPEC-01.11).
  const linkNode = new Map<string, MapNode>();
  for (const row of rows(
    db,
    'SELECT id, host, name, path FROM document_links WHERE projectId=? AND hidden=0',
    projectId,
  )) {
    const id = String(row.id);
    const host = row.host === 'zwcad' ? 'zwcad' : 'rhino';
    const path = str(row.path);
    let node: MapNode;
    if (path) {
      node = addFile(path, { linkId: id, folded: false });
      node.role ??= host === 'rhino' ? 'rhino' : 'cad';
    } else {
      node = {
        id: 'link:' + id,
        path: null,
        name: String(row.name),
        role: host === 'rhino' ? 'rhino' : 'cad',
        host,
        origin: 'local',
        checkout: null,
        kind: host === 'rhino' ? 'model' : 'drawing',
        linkId: id,
      };
      nodes.set(node.id, node);
    }
    linkNode.set(id, node);
  }

  // Requests → the linked file they worked on (their own linkId, else their basis Sync's).
  const requestRows = rows(
    db,
    `SELECT id, createdAt, json_extract(input,'$.linkId') AS linkId,
       json_extract(input,'$.baseRequestId') AS base, json_extract(input,'$.files') AS files
       FROM workspace_requests WHERE projectId=?`,
    projectId,
  );
  const requestLink = new Map<string, string>();
  const requestBase = new Map<string, string>();
  const requestAt = new Map<string, string>();
  for (const row of requestRows) {
    const id = String(row.id);
    requestAt.set(id, String(row.createdAt));
    if (str(row.linkId)) requestLink.set(id, String(row.linkId));
    if (str(row.base)) requestBase.set(id, String(row.base));
  }
  const linkOfRequest = (requestId: string) => {
    let current: string | undefined = requestId;
    for (let hop = 0; current && hop < 8; hop++) {
      const own = requestLink.get(current);
      if (own) return linkNode.get(own);
      current = requestBase.get(current);
    }
    return undefined;
  };

  // 4. xref (SPEC-01.11 11): the drawings read and the references resolved from them.
  const xrefRows = rows(
    db,
    'SELECT path, readAt, data FROM xref_files WHERE projectId=? ORDER BY path',
    projectId,
  );
  if (xrefRows.length) {
    const reads = new Map<string, XrefFileRead>();
    const readAt = new Map<string, string>();
    for (const row of xrefRows) {
      const data = json(row.data);
      if (!data) continue;
      reads.set(String(row.path), data as XrefFileRead);
      readAt.set(pathKey(String(row.path)), String(row.readAt));
    }
    const graph = buildXrefGraph(reads, (path) => io.exists(path));
    for (const edge of graph.edges) {
      if (!edge.child || edge.missing) continue;
      const parent = addFile(edge.parent, { folded: false });
      const child = addFile(edge.child, { folded: false });
      link(parent.id, child.id, 'xref', readAt.get(pathKey(edge.parent)) ?? null);
    }
  }

  // 5. Sync pairs (SPEC-05.8): a drawing's baseline pairs Rhino objects with its entities; the
  // Rhino file is the linked model whose Sync holds those objects (else the only one there is).
  const rhinoLinks = [...linkNode.values()].filter((node) => node.host === 'rhino');
  for (const row of rows(
    db,
    'SELECT path, data, updatedAt FROM drawing_backflow_baselines WHERE projectId=?',
    projectId,
  )) {
    const data = record(json(row.data));
    const pairs = Array.isArray(data.pairs) ? data.pairs.map(record) : [];
    if (!pairs.length) continue;
    const drawing = addFile(String(row.path), { folded: false });
    const models = new Set<MapNode>();
    for (const pair of pairs.slice(0, 5)) {
      const sourceId = str(pair.sourceId);
      if (!sourceId) continue;
      for (const hit of rows(
        db,
        `SELECT DISTINCT json_extract(r.input,'$.linkId') AS linkId FROM sync_manifest_items i
           JOIN workspace_requests r ON r.id=i.requestId
           WHERE i.projectId=? AND i.kind='object' AND i.key=? LIMIT 4`,
        projectId,
        sourceId,
      )) {
        const node = str(hit.linkId) && linkNode.get(String(hit.linkId));
        if (node && node.host === 'rhino') models.add(node);
      }
    }
    if (!models.size && rhinoLinks.length === 1) models.add(rhinoLinks[0]!);
    for (const model of models) link(model.id, drawing.id, 'sync-pair', str(row.updatedAt) ?? null);
  }

  // 6. Jig results (SPEC-07.5): inputs → result, earlier results → later ones, data → report.
  const runFolders = new Map<string, { data?: MapNode; reports: MapNode[]; folder: string }>();
  for (const node of nodes.values()) {
    if (!node.path || node.role !== 'review') continue;
    const folder = win32.dirname(node.path);
    const lower = node.name.toLowerCase();
    if (lower !== 'data.json' && !/^report(-.+)?\.html?$/.test(lower)) continue;
    const entry = runFolders.get(pathKey(folder)) ?? { reports: [], folder };
    if (lower === 'data.json') entry.data = node;
    else entry.reports.push(node);
    runFolders.set(pathKey(folder), entry);
  }
  for (const entry of runFolders.values()) {
    if (!entry.data) continue;
    for (const report of entry.reports)
      link(entry.data.id, report.id, 'data-report', report.modifiedAt ?? null);
  }
  /** The latest run folder copy of an instance (`…-<id 8>[-N]`, newest name last). */
  const copyOf = (instanceId: string) => {
    const short = instanceId.replace(/-/g, '').slice(0, 8).toLowerCase();
    const short2 = instanceId.slice(0, 8).toLowerCase();
    let best: { data?: MapNode; folder: string } | undefined;
    for (const entry of runFolders.values()) {
      if (!entry.data) continue;
      const name = win32.basename(entry.folder).toLowerCase();
      const match = /-([0-9a-z]{8})(?:-\d+)?$/.exec(name);
      if (!match || (match[1] !== short && match[1] !== short2)) continue;
      if (!best || win32.basename(entry.folder) > win32.basename(best.folder)) best = entry;
    }
    return best?.data;
  };
  const instanceRows = rows(
    db,
    'SELECT id, jigId, title, body, createdAt, updatedAt FROM jig_instances WHERE projectId=?',
    projectId,
  );
  const instanceNode = new Map<string, MapNode>();
  const instanceInputs = new Map<string, { from: string; at: string }[]>();
  const instanceUp = new Map<string, string[]>();
  for (const row of instanceRows) {
    const id = String(row.id);
    const body = record(json(row.body));
    const linkIds = new Set<string>();
    for (const role of Object.values(record(body.assembly)))
      for (const source of Array.isArray(record(role).sources)
        ? (record(role).sources as unknown[])
        : [])
        if (str(record(source).linkId)) linkIds.add(String(record(source).linkId));
    for (const field of ['hostDocuments', 'hostSurfaces', 'hostCurves'])
      for (const ref of Object.values(record(body[field])))
        if (str(record(ref).linkId)) linkIds.add(String(record(ref).linkId));
    const ups = new Set<string>();
    for (const field of ['jigOutputs', 'jigOutputsUsed'])
      for (const ref of Object.values(record(body[field])))
        if (str(record(ref).instanceId)) ups.add(String(record(ref).instanceId));
    const at = String(row.createdAt);
    instanceInputs.set(
      id,
      [...linkIds].flatMap((linkId) => {
        const node = linkNode.get(linkId);
        return node ? [{ from: node.id, at }] : [];
      }),
    );
    instanceUp.set(id, [...ups]);
    const copy = copyOf(id);
    if (copy) {
      copy.instanceId = id;
      instanceNode.set(id, copy);
    }
  }
  const nodeOfInstance = (id: string) => {
    let node = instanceNode.get(id);
    if (node) return node;
    const row = instanceRows.find((entry) => String(entry.id) === id);
    if (!row) return undefined;
    node = {
      id: 'jig:' + id,
      path: null,
      name: String(row.title || row.jigId),
      role: 'review',
      host: 'vide',
      origin: 'local',
      checkout: null,
      kind: 'jig',
      instanceId: id,
      modifiedAt: str(row.updatedAt) ?? null,
    };
    nodes.set(node.id, node);
    instanceNode.set(id, node);
    return node;
  };
  for (const row of instanceRows) {
    const id = String(row.id);
    const inputs = instanceInputs.get(id) ?? [];
    const ups = (instanceUp.get(id) ?? []).filter((up) =>
      instanceRows.some((entry) => String(entry.id) === up),
    );
    // A result with no file relation and no copy stays off the map.
    if (!inputs.length && !ups.length && !instanceNode.has(id)) continue;
    const target = nodeOfInstance(id);
    if (!target) continue;
    for (const input of inputs) link(input.from, target.id, 'jig-io', input.at);
    for (const up of ups) link(nodeOfInstance(up)?.id, target.id, 'jig-io', String(row.createdAt));
  }

  // 7. Checkouts (T-310/311): the local copy ↔ the server original, when that table exists.
  for (const row of rows(
    db,
    `SELECT id, server_path, local_path, user_id, checked_out_at, released_at FROM checkouts
       WHERE projectId=?`,
    projectId,
  )) {
    const serverPath = str(row.server_path);
    const localPath = str(row.local_path);
    const at = str(row.checked_out_at);
    if (!serverPath || !at) continue;
    const released = str(row.released_at) ?? null;
    const state: MapCheckout = {
      state: released ? 'released' : 'out',
      by: str(row.user_id) ?? null,
      at,
      releasedAt: released,
    };
    const original = addFile(serverPath, { origin: 'server', folded: false });
    if (!original.checkout || original.checkout.at < at) original.checkout = state;
    const ids = [original.id];
    if (localPath) {
      const copy = addFile(localPath, { origin: 'local', role: original.role, folded: false });
      if (!copy.checkout || copy.checkout.at < at) copy.checkout = state;
      link(copy.id, original.id, 'checkout', at);
      ids.unshift(copy.id);
    }
    const ref = str(row.id) ?? null;
    events.push({ at, kind: 'checkout', nodeIds: ids, ref });
    if (released) events.push({ at: released, kind: 'release', nodeIds: ids, ref });
  }

  // 8. Reference images → the file the request worked on (SPEC-09).
  const imageNode = (file: Record<string, unknown>) => {
    const path = str(file.path);
    if (!path) return undefined;
    const node = addFile(path, {
      role: placeOf(path).role ?? 'references',
      kind: 'image',
      host: 'doc',
      folded: false,
    });
    if (str(file.displayName) || str(file.name)) node.name = String(file.displayName || file.name);
    return node;
  };
  const filesOf = new Map<string, Record<string, unknown>[]>();
  for (const row of requestRows) {
    const files = json(row.files);
    if (!Array.isArray(files)) continue;
    const images = files.map(record).filter((file) => file.kind === 'image' && str(file.id));
    if (!images.length) continue;
    filesOf.set(String(row.id), images);
    const target = linkOfRequest(String(row.id));
    if (!target) continue;
    for (const image of images)
      link(imageNode(image)?.id, target.id, 'reference', String(row.createdAt));
  }
  if (sources.dataDirectory) {
    const boards = join(sources.dataDirectory, 'reference-boards', projectId);
    let entries: Dirent[] = [];
    try {
      entries = await io.readdir(boards);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f]{24}\.json$/.test(entry.name)) continue;
      const board = record(json(await io.readText(join(boards, entry.name))));
      const attachmentId = str(board.attachmentId);
      const versions = Array.isArray(board.versions) ? board.versions.map(record) : [];
      for (const version of versions) {
        const confirmed = record(version.confirmed);
        const requestId = str(confirmed.requestId);
        if (!requestId || !attachmentId) continue;
        const target = linkOfRequest(requestId);
        let image: Record<string, unknown> | undefined;
        for (const files of filesOf.values()) {
          image = files.find((file) => file.id === attachmentId);
          if (image) break;
        }
        if (!target || !image) continue;
        link(imageNode(image)?.id, target.id, 'reference', str(confirmed.at) ?? null);
      }
    }
  }

  // 9. Files named in notes and minutes: '[파일 · 이름]' chips and the plain names of known files.
  const notes: { path: string; node?: MapNode; mtimeMs: number }[] = [];
  for (const node of nodes.values())
    if (node.kind === 'note' && node.path && notes.length < LIMITS.notes)
      notes.push({
        path: node.path,
        node,
        mtimeMs: node.modifiedAt ? Date.parse(node.modifiedAt) : 0,
      });
  if (!ws?.paths.ops && sources.dataDirectory) {
    const folder = join(sources.dataDirectory, 'projects', projectId, 'notes');
    await walk(folder, 1, LIMITS.notes, (path, mtimeMs) => {
      if (!/\.md$/i.test(path) || /readme\.md$/i.test(path)) return;
      notes.push({ path, mtimeMs });
    });
  }
  const named = [...nodes.values()].filter(
    (node) =>
      node.path &&
      node.kind !== 'note' &&
      !node.folded &&
      /\.[a-z0-9]{2,5}$/i.test(node.name) &&
      node.name.length >= 5,
  );
  const byName = new Map<string, MapNode[]>();
  for (const node of nodes.values()) {
    const key = node.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), node]);
  }
  for (const note of notes) {
    if (HOST_FILE.test(note.path)) continue; // never: notes are Markdown
    const text = await io.readText(note.path);
    if (!text) continue;
    const lower = text.toLowerCase();
    const found = new Set<MapNode>();
    for (const match of text.matchAll(PATH_TOKEN)) {
      const name = match[1]!
        .replace(/ \(\d+\)$/, '')
        .trim()
        .toLowerCase();
      for (const node of byName.get(name) ?? []) found.add(node);
    }
    for (const node of named) if (lower.includes(node.name.toLowerCase())) found.add(node);
    if (!found.size) continue;
    const source =
      note.node ??
      addFile(note.path, {
        role: 'ops',
        kind: 'note',
        host: 'vide',
        origin: 'local',
        mtimeMs: note.mtimeMs,
      });
    const at = note.mtimeMs ? iso(note.mtimeMs) : null;
    for (const node of found) link(source.id, node.id, 'mention', at);
  }

  // 10. Events from the records: Syncs, jig runs, requests that changed a file.
  for (const row of rows(
    db,
    `SELECT m.requestId AS id, r.createdAt AS at, json_extract(r.input,'$.linkId') AS linkId
       FROM sync_manifests m JOIN workspace_requests r ON r.id=m.requestId WHERE m.projectId=?`,
    projectId,
  )) {
    const node = str(row.linkId) && linkNode.get(String(row.linkId));
    if (node)
      events.push({ at: String(row.at), kind: 'sync', nodeIds: [node.id], ref: String(row.id) });
  }
  const runGroups = new Map<string, MapEvent>();
  for (const row of rows(
    db,
    `SELECT r.instanceId AS id, r.at AS at FROM jig_runs r JOIN jig_instances i ON i.id=r.instanceId
       WHERE i.projectId=? ORDER BY r.at`,
    projectId,
  )) {
    const node = instanceNode.get(String(row.id));
    if (!node) continue;
    const at = String(row.at);
    const key = `${row.id}|${at.slice(0, 16)}`;
    if (!runGroups.has(key))
      runGroups.set(key, { at, kind: 'jig-run', nodeIds: [node.id], ref: String(row.id) });
  }
  events.push(...runGroups.values());
  // Changes are read only from requests that are not Syncs (a Sync's result is large).
  for (const row of rows(
    db,
    `SELECT id, createdAt, json_extract(result,'$.changes') AS changes,
       json_extract(result,'$.executions') AS executions FROM workspace_requests
       WHERE projectId=? AND result IS NOT NULL
         AND id NOT IN (SELECT requestId FROM sync_manifests WHERE projectId=?)`,
    projectId,
    projectId,
  )) {
    const count = (value: unknown) => {
      const changes = record(value);
      return ['added', 'removed', 'modified'].reduce(
        (sum, key) => sum + (Array.isArray(changes[key]) ? (changes[key] as unknown[]).length : 0),
        0,
      );
    };
    let changed = count(json(row.changes));
    const executions = json(row.executions);
    if (Array.isArray(executions))
      for (const execution of executions) changed += count(record(execution).changes);
    if (!changed) continue;
    const node = linkOfRequest(String(row.id));
    if (node)
      events.push({
        at: String(row.createdAt),
        kind: 'request-change',
        nodeIds: [node.id],
        ref: String(row.id),
      });
  }

  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (events.length > LIMITS.events) {
    events.splice(0, events.length - LIMITS.events);
    truncated = true;
  }
  return {
    nodes: [...nodes.values()],
    links: [...links.values()],
    events,
    generatedAt: now().toISOString(),
    root: ws?.root ?? null,
    truncated,
  };
}
