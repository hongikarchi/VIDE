// 도면 관계 (SPEC-01.11 11, PLAN-43 T-200): the xref relations of the drawings in the project
// folders, read only when the person presses [다시 읽기], and [모델에 반영] — a root drawing and the
// drawings it references join the project's linked files and are drawn in the root's coordinates.
// Originals are only copied (into the VIDE data folder) and never opened in a host; one hidden
// ZWCAD that this engine starts reads the copies and is then stopped (hosts/zwcad/xref-dwg.ts).
// One job per project at a time; the state lives in memory, the reads in the project DB.
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join, win32 } from 'node:path';
import { DomainError } from '../core/store.ts';
import {
  buildXrefGraph,
  pathKey,
  placementsOf,
  type XrefEdge,
  type XrefFileRead,
  type XrefGraph,
  type XrefReader,
} from '../core/xref-graph.ts';
import type { XrefFileRow, XrefStore } from '../core/xref-store.ts';
import type { DocumentLinks } from '../core/document-links.ts';
import type { Workspace } from '../core/workspace.ts';
import { linkRequests } from './link-removal.ts';

/** Folders never walked. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.vide', '$recycle.bin']);
/** Drawings listed at most (a whole file server is not a project folder). */
const MAX_FILES = 3000;
/** Rounds of reading referenced drawings outside the project folders. */
const OUTSIDE_ROUNDS = 3;

export interface XrefTreeNode {
  path: string | null;
  name: string;
  /** The path as the parent stored it (none for a root). */
  stored: string | null;
  how: XrefEdge['how'];
  overlay: boolean;
  missing: boolean;
  cycle: boolean;
  duplicate: boolean;
  /** Not in the project folders: found by the reference. */
  outside: boolean;
  error: string | null;
  unitsAssumed: boolean;
  /** INSERTs of this reference by space (model, paper, inside a block). */
  inserts: { model: number; paper: number; block: number };
  children: XrefTreeNode[];
}
export interface XrefState {
  state: 'idle' | 'reading' | 'applying' | 'done' | 'failed';
  done: number;
  total: number;
  error: string | null;
  /** The last [다시 읽기]. */
  readAt: string | null;
  roots: XrefTreeNode[];
  /** Drawings read that have no xref relation. */
  standalone: number;
  unread: { path: string; error: string }[];
  /** The last [모델에 반영]. */
  applied: {
    root: string;
    links: number;
    read: number;
    failed: { name: string; error: string }[];
  } | null;
}
export interface XrefServiceOptions {
  store: XrefStore;
  links: DocumentLinks;
  workspace: Workspace;
  reader: XrefReader | undefined;
  /** This project's folders of kind 'project'. */
  folders: (projectId: string) => string[];
  denied: (path: string) => boolean;
  /** Where drawing copies are made for a run (removed after it). */
  workRoot: string;
}

async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
/** The `.dwg` files under the folders (read only), sorted. */
async function listDrawings(folders: readonly string[], denied: (path: string) => boolean) {
  const out: string[] = [];
  const walk = async (folder: string) => {
    if (out.length >= MAX_FILES || denied(folder)) return;
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) await walk(path);
      } else if (entry.isFile() && /\.dwg$/i.test(entry.name) && !entry.name.startsWith('~'))
        if (!denied(path) && out.length < MAX_FILES) out.push(path);
    }
  };
  for (const folder of folders) await walk(folder);
  return [...new Map(out.map((path) => [pathKey(path), path])).values()].sort((a, b) =>
    a.localeCompare(b),
  );
}

function counts(edge: XrefEdge) {
  const value = { model: 0, paper: 0, block: 0 };
  for (const insert of edge.inserts)
    if (insert.nested) value.block++;
    else if (insert.space === 'paper') value.paper++;
    else if (insert.space === 'model') value.model++;
    else value.block++;
  return value;
}
/** The roots and their references as a tree; a cycle or a repeat ends a branch. */
export function xrefTree(graph: XrefGraph, inFolders: (path: string) => boolean) {
  const nodes = new Map(graph.nodes.map((node) => [pathKey(node.path), node]));
  const outgoing = new Map<string, XrefEdge[]>();
  for (const edge of graph.edges) {
    const key = pathKey(edge.parent);
    outgoing.set(key, [...(outgoing.get(key) ?? []), edge]);
  }
  const children = (path: string, stack: Set<string>): XrefTreeNode[] =>
    (outgoing.get(pathKey(path)) ?? []).map((edge) => {
      const node = edge.child ? nodes.get(pathKey(edge.child)) : undefined;
      const key = edge.child ? pathKey(edge.child) : '';
      const loops = edge.cycle || (!!key && stack.has(key));
      return {
        path: edge.child,
        name: node?.name ?? win32.basename(edge.stored.replaceAll('/', '\\')) ?? edge.name,
        stored: edge.stored,
        how: edge.how,
        overlay: edge.overlay,
        missing: edge.missing,
        cycle: loops,
        duplicate: edge.duplicate,
        outside: !!edge.child && !inFolders(edge.child),
        error: node && !node.read ? node.error : null,
        unitsAssumed: node?.unitsAssumed ?? false,
        inserts: counts(edge),
        children:
          edge.child && !loops && !edge.duplicate && stack.size < 12
            ? children(edge.child, new Set([...stack, key]))
            : [],
      };
    });
  return graph.roots.map((root) => {
    const node = nodes.get(pathKey(root))!;
    return {
      path: node.path,
      name: node.name,
      stored: null,
      how: null,
      overlay: false,
      missing: false,
      cycle: false,
      duplicate: false,
      outside: !inFolders(node.path),
      error: node.read ? null : node.error,
      unitsAssumed: node.unitsAssumed,
      inserts: { model: 0, paper: 0, block: 0 },
      children: children(node.path, new Set([pathKey(node.path)])),
    } satisfies XrefTreeNode;
  });
}

export class XrefService {
  private readonly options: XrefServiceOptions;
  private readonly jobs = new Map<string, Pick<XrefState, 'state' | 'done' | 'total'>>();
  private readonly last = new Map<
    string,
    { state: 'done' | 'failed'; error: string | null; applied: XrefState['applied'] }
  >();
  constructor(options: XrefServiceOptions) {
    this.options = options;
  }
  private graphOf(projectId: string) {
    const rows = this.options.store.files(projectId);
    const reads = new Map<string, XrefFileRead>(rows.map((row) => [row.path, row.read]));
    return { rows, graph: buildXrefGraph(reads, (path) => existsSync(path)) };
  }
  status(projectId: string): XrefState {
    const { rows, graph } = this.graphOf(projectId);
    const listed = new Set(rows.filter((row) => row.inFolders).map((row) => pathKey(row.path)));
    const related = new Set<string>();
    for (const edge of graph.edges) {
      related.add(pathKey(edge.parent));
      if (edge.child) related.add(pathKey(edge.child));
    }
    const job = this.jobs.get(projectId);
    const last = this.last.get(projectId);
    return {
      state: job?.state ?? last?.state ?? 'idle',
      done: job?.done ?? 0,
      total: job?.total ?? 0,
      error: job ? null : (last?.error ?? null),
      readAt: rows.length
        ? rows
            .map((row) => row.readAt)
            .sort()
            .at(-1)!
        : null,
      roots: xrefTree(graph, (path) => listed.has(pathKey(path))),
      standalone: rows.filter((row) => row.inFolders && !related.has(pathKey(row.path))).length,
      unread: rows
        .filter((row) => row.read.error)
        .map((row) => ({ path: row.path, error: row.read.error! })),
      applied: last?.applied ?? null,
    };
  }
  private begin(projectId: string, state: 'reading' | 'applying') {
    if (this.jobs.has(projectId)) throw new DomainError('PROJECT_BUSY');
    this.jobs.set(projectId, { state, done: 0, total: 0 });
  }
  private async run(
    projectId: string,
    work: (job: { done: number; total: number }, folder: string) => Promise<XrefState['applied']>,
  ) {
    // Short: the hidden ZWCAD's script lives under it (a long `/b` path is refused).
    const folder = join(this.options.workRoot, randomBytes(4).toString('hex'));
    const job = this.jobs.get(projectId)!;
    try {
      await mkdir(folder, { recursive: true });
      const applied = await work(job, folder);
      this.last.set(projectId, {
        state: 'done',
        error: null,
        applied: applied ?? this.last.get(projectId)?.applied ?? null,
      });
    } catch (cause) {
      this.last.set(projectId, {
        state: 'failed',
        error: (cause as { code?: string }).code ?? (cause as Error).message,
        applied: this.last.get(projectId)?.applied ?? null,
      });
    } finally {
      this.jobs.delete(projectId);
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }
  private async ready() {
    const reader = this.options.reader;
    if (!reader || !(await reader.available())) throw new DomainError('NO_ZWCAD');
    return reader;
  }

  /** [다시 읽기]: list the folders' drawings and read the new or changed ones. */
  async read(projectId: string, wait = false) {
    const folders = this.options.folders(projectId);
    if (!folders.length) throw new DomainError('NO_PROJECT_FOLDER');
    const reader = await this.ready();
    this.begin(projectId, 'reading');
    const running = this.run(projectId, async (job, work) => {
      const before = new Map(
        this.options.store.files(projectId).map((row) => [pathKey(row.path), row]),
      );
      const rows = new Map<string, XrefFileRow>();
      const readInto = async (paths: string[], inFolders: boolean) => {
        const todo: { id: number; path: string; original: string; size: number; mtime: string }[] =
          [];
        for (const path of paths) {
          let info;
          try {
            info = await stat(path);
          } catch {
            continue;
          }
          const mtime = info.mtime.toISOString();
          const known = before.get(pathKey(path));
          if (known && known.size === info.size && known.mtime === mtime && !known.read.error) {
            rows.set(pathKey(path), { ...known, path, inFolders });
            continue;
          }
          todo.push({ id: todo.length + 1, path, original: path, size: info.size, mtime });
        }
        job.total += todo.length;
        const copies: { id: number; path: string }[] = [];
        const hashes = new Map<number, string>();
        for (const item of todo) {
          const copy = join(work, `g${job.total}-${item.id}.dwg`);
          try {
            await copyFile(item.original, copy);
            hashes.set(item.id, await sha256(copy));
            copies.push({ id: item.id, path: copy });
          } catch {
            /* Unreadable original: recorded below. */
          }
        }
        const start = job.done;
        const results = copies.length
          ? await reader.graph(copies, work, (done) => (job.done = start + done))
          : new Map<number, XrefFileRead>();
        job.done = start + todo.length;
        const now = new Date().toISOString();
        for (const item of todo) {
          const result = results.get(item.id);
          rows.set(pathKey(item.path), {
            path: item.path,
            size: item.size,
            mtime: item.mtime,
            sha256: hashes.get(item.id) ?? '',
            readAt: now,
            inFolders,
            read: result ?? {
              error: hashes.has(item.id) ? 'NOT_READ' : 'COPY_FAILED',
              units: null,
              scale: null,
              unitsAssumed: false,
              xrefs: [],
              inserts: [],
            },
          });
        }
      };
      await readInto(await listDrawings(folders, this.options.denied), true);
      // Referenced drawings outside the folders (another share, a library) are read too.
      for (let round = 0; round < OUTSIDE_ROUNDS; round++) {
        const graph = buildXrefGraph(
          new Map([...rows.values()].map((row) => [row.path, row.read])),
          (path) => existsSync(path),
        );
        const outside = graph.edges
          .map((edge) => edge.child)
          .filter((child): child is string => !!child && !rows.has(pathKey(child)))
          .filter((child) => !this.options.denied(child));
        if (!outside.length) break;
        await readInto([...new Set(outside)], false);
      }
      this.options.store.replaceFiles(projectId, [...rows.values()]);
      return null;
    });
    if (wait) await running;
    return this.status(projectId);
  }

  /**
   * [모델에 반영] on a root drawing: the root and the drawings it shows become linked files (a
   * host link of the same path is used as it is), each read again only when its file changed, and
   * each placed by its insert transform in the root's metres. Nothing is written to a drawing.
   */
  async apply(projectId: string, root: string, wait = false) {
    const { graph } = this.graphOf(projectId);
    const placements = placementsOf(graph, root);
    if (!placements.length) throw new DomainError('NOT_FOUND');
    const reader = await this.ready();
    this.begin(projectId, 'applying');
    const { links, workspace, store } = this.options;
    const running = this.run(projectId, async (job, work) => {
      job.total = placements.length;
      const requests = workspace.list(projectId);
      const failed: { name: string; error: string }[] = [];
      const todo: {
        id: number;
        path: string;
        linkId: string;
        name: string;
        hash: string;
      }[] = [];
      let count = 0;
      for (const placement of placements) {
        const { link, file } = links.pathLink(projectId, 'zwcad', placement.path);
        store.place(projectId, link.id, placements[0].path, placement.matrix);
        count++;
        if (!file) continue;
        const copy = join(work, `d${todo.length + 1}.dwg`);
        try {
          await copyFile(placement.path, copy);
        } catch {
          failed.push({ name: placement.name, error: 'COPY_FAILED' });
          continue;
        }
        const hash = await sha256(copy);
        const shown = linkRequests(link, requests)
          .filter((entry) => entry.state === 'succeeded')
          .at(-1);
        if (shown?.result && (shown.result as { sourceHash?: unknown }).sourceHash === hash)
          continue;
        todo.push({ id: todo.length + 1, path: copy, linkId: link.id, name: link.name, hash });
      }
      const results = todo.length
        ? await reader.display(todo, work, (done) => (job.done = done))
        : new Map();
      for (const item of todo) {
        const result = results.get(item.id);
        if (!result || result.error || !result.objects || !result.scene) {
          failed.push({ name: item.name, error: result?.error ?? 'NOT_READ' });
          continue;
        }
        const id = randomUUID();
        workspace.submit(projectId, {
          linkId: item.linkId,
          id,
          provider: 'codex-cli',
          host: 'zwcad',
          source: 'file',
          permission: 'candidate',
          body: `${item.name} 불러오기`,
          pins: [],
          sketches: [],
          files: [],
        });
        workspace.update(projectId, id, 'running', {
          phase: 'import',
          host: 'zwcad',
          sourceHash: item.hash,
        });
        workspace.update(projectId, id, 'succeeded', {
          phase: 'import',
          host: 'zwcad',
          hostExecuted: true,
          executionMode: 'sdk',
          displayOnly: true,
          verified: false,
          referenceOnly: true,
          sourceHash: item.hash,
          sourceUnits: result.units,
          objects: result.objects,
          scene: result.scene,
          displayCoverage: result.displayCoverage,
          displayWarnings: result.displayWarnings ?? {},
          text: result.unitsAssumed
            ? '도면 관계에서 읽었습니다. 단위가 없어 mm로 보았습니다. 원본은 바꾸지 않았습니다.'
            : '도면 관계에서 읽었습니다. 원본은 바꾸지 않았습니다.',
        });
      }
      job.done = job.total;
      return { root: placements[0].path, links: count, read: todo.length, failed };
    });
    if (wait) await running;
    return this.status(projectId);
  }
}
