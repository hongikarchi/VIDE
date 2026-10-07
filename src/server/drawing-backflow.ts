// 역반영 차이 계산 (SPEC-14.8~14.10·14.12, PLAN-47 T-232): the rows of one root drawing and the xref
// drawings it shows, computed from the source snapshot, the drawings' entities, the baselines in
// the project DB (schema 14), the root's layer table (T-227) and the xref graph (T-200). Reading
// is a seam (`BackflowReader`): the open drawing or a hidden ZWCAD copy, and the Rhino link. Nothing
// is written to a drawing; only [짝 기록] writes baselines to the project DB.
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, win32 } from 'node:path';
import { DomainError } from '../core/store.ts';
import { buildXrefGraph, pathKey, placementsOf } from '../core/xref-graph.ts';
import type { XrefStore } from '../core/xref-store.ts';
import {
  drawingEligibility,
  targetLayers,
  type DrawingLayerStore,
} from '../core/drawing-layers.ts';
import {
  computeBackflow,
  recordBaseline,
  type BackflowResult,
  type DrawingBackflowStore,
  type DrawingEntities,
  type PairInput,
  type Relation,
  type SourceSnapshot,
} from '../core/drawing-backflow.ts';
import { within } from './drawing-layers.ts';

/** Reads what a backflow compares (hosts/zwcad and the Rhino link; a fake in tests). */
export interface BackflowReader {
  available(): Promise<boolean>;
  /** The source document's snapshot, in metres. */
  source(projectId: string, linkId: string): Promise<SourceSnapshot>;
  /** Entities of the drawings by original path (read from the open drawing or a copy). */
  drawings(projectId: string, paths: readonly string[]): Promise<Map<string, DrawingEntities>>;
}
export interface DrawingBackflowServiceOptions {
  store: DrawingBackflowStore;
  layers: DrawingLayerStore;
  xref: XrefStore;
  reader: BackflowReader | undefined;
  folders: (projectId: string) => string[];
  denied: (path: string) => boolean;
  now?: () => Date;
}
export interface BackflowDiff extends BackflowResult {
  id: string;
  /** false: a drawing changed while the rows were computed; compute again (SPEC-14.10 4). */
  settled: boolean;
  changed: string[];
  computedAt: string;
}

/** Diffs kept for the apply (T-233), newest last. */
const KEEP = 20;
const fingerprint = async (path: string) => {
  const info = await stat(path).catch(() => null);
  return info ? `${info.size}:${info.mtime.toISOString()}` : 'missing';
};

export class DrawingBackflowService {
  private readonly options: DrawingBackflowServiceOptions;
  private readonly now: () => Date;
  private readonly diffs = new Map<string, { projectId: string; diff: BackflowDiff }>();
  constructor(options: DrawingBackflowServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  private checkPath(projectId: string, path: unknown) {
    if (typeof path !== 'string' || !isAbsolute(path) || !/\.dwg$/i.test(path))
      throw new DomainError('INVALID_INPUT');
    const folders = this.options.folders(projectId);
    if (!folders.length) throw new DomainError('NO_PROJECT_FOLDER');
    if (!folders.some((folder) => within(folder, path)) || this.options.denied(path))
      throw new DomainError('PATH_NOT_IN_PROJECT');
    return win32.normalize(path);
  }
  private outside(projectId: string) {
    const folders = this.options.folders(projectId);
    return (path: string) =>
      !folders.some((folder) => within(folder, path)) || this.options.denied(path);
  }

  /** The root (read by T-227, mm, present) and the drawings it shows. */
  private async scope(projectId: string, rootPath: unknown) {
    const root = this.checkPath(projectId, rootPath);
    const read = this.options.layers.read(projectId, root);
    if (!read) throw new DomainError('DRAWING_NOT_READ');
    const eligible = drawingEligibility(read.read);
    if (!eligible.eligible) throw new DomainError(eligible.reason!);
    if (!(await stat(root).catch(() => null))?.isFile()) throw new DomainError('FILE_MISSING');
    const files = this.options.xref.files(projectId);
    const graph = files.length
      ? buildXrefGraph(new Map(files.map((file) => [file.path, file.read])), existsSync)
      : null;
    const outside = this.outside(projectId);
    const placed = graph ? placementsOf(graph, root).map((p) => p.path) : [];
    const paths = [
      root,
      ...placed.filter((path) => pathKey(path) !== pathKey(root) && !outside(path)),
    ];
    return { root, read, graph, outside, paths };
  }
  private async reader() {
    const reader = this.options.reader;
    if (!reader || !(await reader.available())) throw new DomainError('NO_ZWCAD');
    return reader;
  }

  /** [모델 변경 반영]: the rows (SPEC-14.10). Reads only; a drawing change leaves it unsettled. */
  async diff(
    projectId: string,
    input: {
      root: string;
      link: string;
      relation: Relation;
      pairs?: PairInput[];
      scope?: string[];
    },
  ): Promise<BackflowDiff> {
    const { root, read, graph, outside, paths } = await this.scope(projectId, input.root);
    const reader = await this.reader();
    const before = await Promise.all(paths.map(fingerprint));
    const source = await reader.source(projectId, input.link);
    const drawings = await reader.drawings(projectId, paths);
    const result = computeBackflow({
      root,
      source,
      relation: input.relation,
      drawings,
      graph,
      baselines: this.options.store.baselines(projectId, paths),
      pairs: input.pairs?.map((pair) => ({ ...pair, path: win32.normalize(pair.path) })),
      layerMap: this.options.layers.map(projectId, root)?.entries ?? [],
      rootLayers: targetLayers(read.read),
      scope: input.scope,
      outside,
    });
    const after = await Promise.all(paths.map(fingerprint));
    const changed = paths.filter((_, i) => before[i] !== after[i]);
    const diff: BackflowDiff = {
      id: randomBytes(12).toString('hex'),
      ...result,
      settled: !changed.length,
      changed,
      computedAt: this.now().toISOString(),
    };
    this.diffs.set(diff.id, { projectId, diff });
    while (this.diffs.size > KEEP) this.diffs.delete(this.diffs.keys().next().value!);
    return diff;
  }
  /** A diff computed earlier for this project (T-233 applies it), or null. */
  computed(projectId: string, id: string): BackflowDiff | null {
    const kept = this.diffs.get(id);
    return kept && kept.projectId === projectId ? kept.diff : null;
  }

  /**
   * [짝 기록]: confirmed pairs (Sync jig matched rows) become each file's baseline with the source
   * and entity digests of now. Files must be the root or drawings it shows.
   */
  async establish(projectId: string, input: { root: string; link: string; pairs: PairInput[] }) {
    const { paths } = await this.scope(projectId, input.root);
    const known = new Map(paths.map((path) => [pathKey(path), path]));
    const groups = new Map<string, PairInput[]>();
    for (const pair of input.pairs) {
      const path = known.get(pathKey(pair.path));
      if (!path) throw new DomainError('PATH_NOT_IN_PROJECT');
      groups.set(path, [...(groups.get(path) ?? []), pair]);
    }
    const reader = await this.reader();
    const source = await reader.source(projectId, input.link);
    const drawings = await reader.drawings(projectId, [...groups.keys()]);
    const byKey = new Map([...drawings].map(([path, read]) => [pathKey(path), read]));
    const files = [];
    for (const [path, pairs] of groups) {
      const read = byKey.get(pathKey(path));
      if (!read) throw new DomainError('DRAWING_NOT_READ');
      const previous = this.options.store.baseline(projectId, path);
      const { baseline, refused } = recordBaseline(
        { ...read, path },
        pairs.map((pair) => ({ ...pair, via: 'sync' as const })),
        source,
        previous,
        this.now(),
      );
      const saved = this.options.store.save(projectId, baseline, previous?.revision ?? 0);
      files.push({ path, pairs: saved.pairs.length, revision: saved.revision, refused });
    }
    return { files };
  }

  /** One file's baseline in short: pairs, entities and when it was recorded. */
  baseline(projectId: string, path: unknown) {
    const checked = this.checkPath(projectId, path);
    const baseline = this.options.store.baseline(projectId, checked);
    return baseline
      ? {
          path: baseline.path,
          revision: baseline.revision,
          updatedAt: baseline.updatedAt,
          pairs: baseline.pairs.length,
          entities: Object.keys(baseline.handles).length,
        }
      : null;
  }
}
