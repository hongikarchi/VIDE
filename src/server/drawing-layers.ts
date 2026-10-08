// 도면 읽기와 레이어 대응 (SPEC-14.3, PLAN-47 T-227): a project drawing is read only when the person
// asks; the original is copied into the VIDE data folder and only the copy is read, by one hidden
// ZWCAD this engine starts and stops (hosts/zwcad/drawing-inspect.ts). The read and each drawing's
// layer table live in the project DB (schema 15). Nothing is written to a drawing.
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, join, win32 } from 'node:path';
import { DomainError } from '../core/store.ts';
import { pathKey } from '../core/xref-graph.ts';
import { projectPath } from './project-path.ts';
import { DWG_VERSIONS } from '../core/drawing-output.ts';
import {
  copyLayerMap,
  drawingEligibility,
  inspectionOf,
  layerMap,
  targetLayers,
  type DrawingInspection,
  type DrawingInspector,
  type DrawingLayerMapRow,
  type DrawingLayerStore,
  type DrawingReadRow,
} from '../core/drawing-layers.ts';

/** Drawings read in one request at most. */
export const MAX_READ = 50;

export interface DrawingSummary {
  path: string;
  name: string;
  readAt: string;
  version: string | null;
  /** `2018` … for the versions VIDE writes; null for another. */
  release: string | null;
  units: number | null;
  unitsAssumed: boolean;
  eligible: boolean;
  /** Why the drawing is not a target: unreadable, not mm, gone, or changed since the read. */
  reason: 'READ_FAILED' | 'UNITS_NOT_MM' | 'FILE_MISSING' | 'FILE_CHANGED' | null;
  error: string | null;
  counts: Record<'layers' | 'linetypes' | 'textStyles' | 'dimStyles' | 'blocks' | 'xrefs', number>;
  /** The layer table: sources and how many still need a layer; null: none yet. */
  map: { sources: number; unmapped: number; revision: number } | null;
}
export interface DrawingLayersState {
  state: 'idle' | 'reading' | 'done' | 'failed';
  done: number;
  total: number;
  error: string | null;
  drawings: DrawingSummary[];
}
export interface DrawingLayerServiceOptions {
  store: DrawingLayerStore;
  inspector: DrawingInspector | undefined;
  /** This project's folders of kind 'project'. */
  folders: (projectId: string) => string[];
  denied: (path: string) => boolean;
  /** Where drawing copies are made for a read (removed after it). */
  workRoot: string;
}

async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
export { within } from './project-path.ts';

export class DrawingLayerService {
  private readonly options: DrawingLayerServiceOptions;
  private readonly jobs = new Map<string, { done: number; total: number }>();
  private readonly last = new Map<string, { state: 'done' | 'failed'; error: string | null }>();
  constructor(options: DrawingLayerServiceOptions) {
    this.options = options;
  }

  /** An absolute `.dwg` path inside this project's folders and not denied; else refused. */
  private checkPath(projectId: string, path: unknown) {
    if (typeof path !== 'string' || !isAbsolute(path) || !/\.dwg$/i.test(path))
      throw new DomainError('INVALID_INPUT');
    const folders = this.options.folders(projectId);
    if (!folders.length) throw new DomainError('NO_PROJECT_FOLDER');
    // A mapped or subst drive letter counts as the folder it stands for (SPEC-01.13 1).
    const inside = projectPath(folders, path, this.options.denied);
    if (!inside) throw new DomainError('PATH_NOT_IN_PROJECT');
    return inside;
  }

  private async summary(projectId: string, row: DrawingReadRow): Promise<DrawingSummary> {
    const { read } = row;
    const base = drawingEligibility(read);
    let reason: DrawingSummary['reason'] = base.reason;
    if (!reason) {
      const info = await stat(row.path).catch(() => null);
      if (!info) reason = 'FILE_MISSING';
      else if (info.size !== row.size || info.mtime.toISOString() !== row.mtime)
        reason = 'FILE_CHANGED';
    }
    const map = this.options.store.map(projectId, row.path);
    return {
      path: row.path,
      name: win32.basename(row.path),
      readAt: row.readAt,
      version: read.version,
      release: (read.version && DWG_VERSIONS[read.version as keyof typeof DWG_VERSIONS]) || null,
      units: read.units,
      unitsAssumed: base.unitsAssumed,
      eligible: !reason,
      reason,
      error: read.error,
      counts: {
        layers: read.layers.length,
        linetypes: read.linetypes.length,
        textStyles: read.textStyles.length,
        dimStyles: read.dimStyles.length,
        blocks: read.blocks.length,
        xrefs: read.xrefs.length,
      },
      map: map
        ? {
            sources: map.entries.length,
            unmapped: map.entries.filter((entry) => entry.layer === null).length,
            revision: map.revision,
          }
        : null,
    };
  }

  async status(projectId: string): Promise<DrawingLayersState> {
    const job = this.jobs.get(projectId);
    const last = this.last.get(projectId);
    const drawings = await Promise.all(
      this.options.store.reads(projectId).map((row) => this.summary(projectId, row)),
    );
    return {
      state: job ? 'reading' : (last?.state ?? 'idle'),
      done: job?.done ?? 0,
      total: job?.total ?? 0,
      error: job ? null : (last?.error ?? null),
      drawings,
    };
  }

  /** One drawing: its summary, the whole read and its layer table. */
  async drawing(projectId: string, path: unknown) {
    const row = this.options.store.read(projectId, this.checkPath(projectId, path));
    if (!row) throw new DomainError('DRAWING_NOT_READ');
    return {
      drawing: await this.summary(projectId, row),
      read: row.read,
      map: this.options.store.map(projectId, row.path),
    };
  }

  /** [도면 읽기]: copy each drawing and read the copies in one hidden ZWCAD. */
  async read(projectId: string, paths: unknown[], wait = false) {
    if (!paths.length || paths.length > MAX_READ) throw new DomainError('INVALID_INPUT');
    const checked = [
      ...new Map(
        paths.map((p) => this.checkPath(projectId, p)).map((p) => [pathKey(p), p]),
      ).values(),
    ];
    for (const path of checked)
      if (!(await stat(path).catch(() => null))?.isFile()) throw new DomainError('FILE_MISSING');
    const inspector = this.options.inspector;
    if (!inspector || !(await inspector.available())) throw new DomainError('NO_ZWCAD');
    if (this.jobs.has(projectId)) throw new DomainError('PROJECT_BUSY');
    const job = { done: 0, total: checked.length };
    this.jobs.set(projectId, job);
    const running = this.run(projectId, checked, inspector, job);
    if (wait) await running;
    return this.status(projectId);
  }

  private async run(
    projectId: string,
    paths: string[],
    inspector: DrawingInspector,
    job: { done: number; total: number },
  ) {
    // Short: the hidden ZWCAD's script lives under it (a long `/b` path is refused).
    const work = join(this.options.workRoot, randomBytes(4).toString('hex'));
    try {
      await mkdir(work, { recursive: true });
      const items: {
        id: number;
        path: string;
        copy: string;
        size: number;
        mtime: string;
        hash: string | null;
      }[] = [];
      for (const [index, path] of paths.entries()) {
        const id = index + 1,
          copy = join(work, `d${id}.dwg`);
        const info = await stat(path);
        let hash: string | null = null;
        try {
          await copyFile(path, copy);
          hash = await sha256(copy);
        } catch {
          /* Recorded as COPY_FAILED below. */
        }
        items.push({ id, path, copy, size: info.size, mtime: info.mtime.toISOString(), hash });
      }
      const copies = items.filter((item) => item.hash).map(({ id, copy }) => ({ id, path: copy }));
      const results = copies.length
        ? await inspector.inspect(copies, work, (done) => (job.done = done))
        : new Map<number, DrawingInspection>();
      const readAt = new Date().toISOString();
      for (const item of items) {
        const answer = results.get(item.id);
        // Checked again here: the inspector is a seam (a fake in tests, the worker in use).
        const read: DrawingInspection = answer
          ? inspectionOf(answer as unknown as Record<string, unknown>)
          : {
              error: item.hash ? 'NOT_READ' : 'COPY_FAILED',
              version: null,
              units: null,
              layers: [],
              linetypes: [],
              textStyles: [],
              dimStyles: [],
              blocks: [],
              xrefs: [],
            };
        this.options.store.saveRead(projectId, {
          path: item.path,
          size: item.size,
          mtime: item.mtime,
          sha256: item.hash ?? '',
          readAt,
          read,
        });
      }
      job.done = job.total;
      this.last.set(projectId, { state: 'done', error: null });
    } catch (cause) {
      this.last.set(projectId, {
        state: 'failed',
        error: (cause as { code?: string }).code ?? (cause as Error).message,
      });
    } finally {
      this.jobs.delete(projectId);
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** A read drawing that may take a layer table now (eligible and unchanged since the read). */
  private async target(projectId: string, path: unknown) {
    const row = this.options.store.read(projectId, this.checkPath(projectId, path));
    if (!row) throw new DomainError('DRAWING_NOT_READ');
    const summary = await this.summary(projectId, row);
    if (summary.reason) throw new DomainError(summary.reason);
    return row;
  }

  /** Saves a drawing's whole layer table: same names map themselves, `chosen` the rest. */
  async saveMap(
    projectId: string,
    input: {
      path: string;
      sources: string[];
      chosen?: Record<string, string | null>;
      revision?: number;
    },
  ): Promise<DrawingLayerMapRow> {
    const row = await this.target(projectId, input.path);
    const entries = layerMap(input.sources, targetLayers(row.read), input.chosen ?? {});
    return this.options.store.saveMap(projectId, row.path, entries, row.sha256, input.revision);
  }

  /** Copies one drawing's table to another drawing of the project (SPEC-14.3 1). */
  async copyMap(projectId: string, input: { from: string; to: string; sources?: string[] }) {
    const from = this.options.store.map(projectId, this.checkPath(projectId, input.from));
    if (!from) throw new DomainError('NOT_FOUND');
    const row = await this.target(projectId, input.to);
    if (pathKey(row.path) === pathKey(from.path)) throw new DomainError('INVALID_INPUT');
    const { entries, dropped } = copyLayerMap(
      from.entries,
      targetLayers(row.read),
      input.sources ?? [],
    );
    return {
      map: this.options.store.saveMap(projectId, row.path, entries, row.sha256),
      dropped,
    };
  }
}
