// 역반영 (SPEC-14.8~14.12, PLAN-47 T-232·T-233): the rows of one root drawing and the xref drawings it
// shows, computed from the source snapshot, the drawings' entities, the baselines in the project DB
// (schema 14), the root's layer table (T-227) and the xref graph (T-200); and their apply. Reading
// is a seam (`BackflowReader`, src/server/drawing-backflow-host.ts): the open drawing or a hidden
// ZWCAD copy, and the Rhino link's newest Sync. Writing is the `BackflowWriter`: an open linked
// drawing is changed in place, one UNDO step per file (ADR-022), all files or none (ADR-027); a
// closed drawing is written as a new file beside it after the save card (SPEC-14.7), never over
// the original. Only applied rows become baselines; an undo restores the previous ones.
import { existsSync, constants } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, win32 } from 'node:path';
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
  frameOf,
  mapGeometry,
  metresPerUnit,
  recordBaseline,
  writable,
  type BackflowResult,
  type BackflowRow,
  type DrawingBackflowStore,
  type DrawingBaseline,
  type DrawingEntities,
  type PairInput,
  type Relation,
  type SourceSnapshot,
} from '../core/drawing-backflow.ts';
import {
  appliedOps,
  dimensionsToCheck,
  opsOfRows,
  preservation,
  type BackflowOp,
  type DimensionToCheck,
  type FileApply,
  type PreservationCheck,
} from '../core/drawing-backflow-apply.ts';
import { backflowName, dwgVersionOf, type OutputTokens } from '../core/drawing-output.ts';
import { DIRECT_MAX_DELETES, type HostTarget } from '../contracts/host-documents.ts';
import { projectPath, realPath } from './project-path.ts';
import { sha256File, type BackflowWriter } from './drawing-backflow-host.ts';

/** Reads what a backflow compares (hosts/zwcad and the Rhino link; a fake in tests). */
export interface BackflowReader {
  available(): Promise<boolean>;
  /** The source document's snapshot, in metres. */
  source(projectId: string, linkId: string): Promise<SourceSnapshot>;
  /** Entities of the drawings by original path (read from the open drawing or a copy). */
  drawings(projectId: string, paths: readonly string[]): Promise<Map<string, DrawingEntities>>;
  /** Per path a value that changes with the drawing (default: the file's size and time). */
  fingerprints?(projectId: string, paths: readonly string[]): Promise<string[]>;
  /** One stored Rhino Sync as the source (the Sync jig's own run). */
  sourceOfSync?(projectId: string, syncId: string, linkId: string): SourceSnapshot;
}
export interface DrawingBackflowServiceOptions {
  store: DrawingBackflowStore;
  layers: DrawingLayerStore;
  xref: XrefStore;
  reader: BackflowReader | undefined;
  writer?: BackflowWriter | undefined;
  /** Output tokens (T-226) for closed drawings: computed copies in `workRoot`, then the save card. */
  tokens?: OutputTokens;
  /** The engine's drawing work folder (computed copies until the save card is confirmed). */
  workRoot?: string;
  folders: (projectId: string) => string[];
  denied: (path: string) => boolean;
  now?: () => Date;
  /** Deletes beyond this need a second confirmation (SPEC-14.10 3, SPEC-02.13). */
  maxDeletes?: number;
}
export interface BackflowDiff extends BackflowResult {
  id: string;
  /** false: a drawing changed while the rows were computed; compute again (SPEC-14.10 4). */
  settled: boolean;
  changed: string[];
  computedAt: string;
}

/** One file of an apply as the screen shows it (SPEC-14.6). */
export interface AppliedFile {
  /** The drawing the rows were computed for. */
  path: string;
  /** open: changed in ZWCAD (not saved); closed: written as `written` beside it. */
  mode: 'open' | 'closed';
  written: string | null;
  rows: string[];
  check: PreservationCheck | null;
  dimensions: DimensionToCheck[];
  undoId: string | null;
}
export type ApplyAnswer =
  | { state: 'applied'; id: string; files: AppliedFile[] }
  | {
      state: 'confirm';
      id: string;
      /** Every file the save would write (SPEC-14.7 4) and the open drawings changed with it. */
      files: (Omit<AppliedFile, 'undoId'> & { version: string | null })[];
      expiresAt: string;
    }
  | {
      state: 'failed';
      code: string;
      path: string | null;
      failed: { id: string; code: string }[];
      rolledBack: string[];
      undoFailed: string[];
    }
  | { state: 'unclear'; path: string; applied: string[]; notApplied: string[] };

/** Diffs kept for the apply, newest last. */
const KEEP = 20;
/** A computed copy waits this long for the save card. */
const PENDING_MS = 30 * 60_000;
const fingerprint = async (path: string) => {
  const info = await stat(path).catch(() => null);
  return info ? `${info.size}:${info.mtime.toISOString()}` : 'missing';
};
const OPEN = 'open:';

interface FilePlan {
  path: string;
  ops: BackflowOp[];
  rows: BackflowRow[];
  target: HostTarget | null;
  /** What the file must still be: `open:<documentHash>` or the original's sha256. */
  expected: string;
  stamp: number;
}
interface Computed {
  plan: FilePlan;
  /** The computed copy in the work folder and the name it gets beside the original. */
  copy: string;
  name: string;
  version: string;
  sha256: string;
  apply: FileApply;
  check: PreservationCheck;
  dimensions: DimensionToCheck[];
}
interface Pending {
  projectId: string;
  linkId: string;
  source: SourceSnapshot;
  open: FilePlan[];
  closed: Computed[];
  work: string;
  expiresAt: number;
}
interface Applied {
  projectId: string;
  files: {
    path: string;
    target: HostTarget | null;
    undoId: string | null;
    previous: DrawingBaseline | null;
    key: string;
  }[];
  undone: boolean;
}

const changesOf = (plan: FilePlan, apply: FileApply) => {
  const handles = new Map(apply.results.map((r) => [r.id, r.handle.toUpperCase()]));
  const before = new Map(apply.before.entities.map((e) => [e.handle.toUpperCase(), e]));
  const after = new Map(apply.after.entities.map((e) => [e.handle.toUpperCase(), e]));
  const done = { modified: [] as string[], added: [] as string[], deleted: [] as string[] };
  const changes: {
    handle: string;
    before: FileApply['before']['entities'][number]['geometry'];
    after: FileApply['after']['entities'][number]['geometry'];
  }[] = [];
  for (const op of plan.ops) {
    const handle = op.op === 'add' ? handles.get(op.id) : op.handle.toUpperCase();
    if (!handle) continue;
    (op.op === 'modify' ? done.modified : op.op === 'add' ? done.added : done.deleted).push(handle);
    if (op.op !== 'add')
      changes.push({
        handle,
        before: before.get(handle)?.geometry ?? null,
        after: after.get(handle)?.geometry ?? null,
      });
  }
  return {
    check: preservation(apply.before, apply.after, done),
    dimensions: dimensionsToCheck(apply.before.dims, apply.after.dims, changes),
  };
};

export class DrawingBackflowService {
  private readonly options: DrawingBackflowServiceOptions;
  private readonly now: () => Date;
  private readonly diffs = new Map<
    string,
    { projectId: string; diff: BackflowDiff; link: string }
  >();
  private readonly pending = new Map<string, Pending>();
  private readonly applied = new Map<string, Applied>();
  private readonly busy = new Set<string>();
  constructor(options: DrawingBackflowServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

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
  private outside(projectId: string) {
    const folders = this.options.folders(projectId);
    return (path: string) => !projectPath(folders, path, this.options.denied);
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
      ? buildXrefGraph(new Map(files.map((file) => [file.path, file.read])), existsSync, realPath)
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
  private writer() {
    const writer = this.options.writer;
    if (!writer) throw new DomainError('NO_ZWCAD');
    return writer;
  }
  private fingerprints(projectId: string, reader: BackflowReader, paths: readonly string[]) {
    return reader.fingerprints
      ? reader.fingerprints(projectId, paths)
      : Promise.all(paths.map(fingerprint));
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
    const before = await this.fingerprints(projectId, reader, paths);
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
      // A Rhino Sync stores float32 offsets (ARCH-01 §5): 0.01 mm is the closest equal.
      tolerance: 0.01,
    });
    const after = await this.fingerprints(projectId, reader, paths);
    const changed = paths.filter((_, i) => before[i] !== after[i]);
    const diff: BackflowDiff = {
      id: randomBytes(12).toString('hex'),
      ...result,
      settled: !changed.length,
      changed,
      computedAt: this.now().toISOString(),
    };
    this.diffs.set(diff.id, { projectId, diff, link: input.link });
    while (this.diffs.size > KEEP) this.diffs.delete(this.diffs.keys().next().value!);
    return diff;
  }
  /** A diff computed earlier for this project, or null. */
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

  // ---- apply (T-233) -------------------------------------------------------------------------

  private async exclusive<T>(projectId: string, work: () => Promise<T>) {
    if (this.busy.has(projectId)) throw new DomainError('PROJECT_BUSY');
    this.busy.add(projectId);
    try {
      return await work();
    } finally {
      this.busy.delete(projectId);
    }
  }

  /** Each file's plan: its ops, whether it is open, and what it must still be. */
  private async plans(
    projectId: string,
    rows: readonly BackflowRow[],
    linkId: string,
    drawings: readonly { path: string; sha256: string }[],
  ) {
    const writer = this.writer();
    const plans: FilePlan[] = [];
    for (const [path, ops] of opsOfRows(rows, linkId)) {
      const target = await writer.open(path);
      const read = drawings.find((d) => pathKey(d.path) === pathKey(path));
      if (!read) throw new DomainError('DRAWING_NOT_READ');
      // The drawing must be what the rows were computed from (SPEC-14.13 4 for the drawing side).
      if (target ? !read.sha256.startsWith(OPEN) : read.sha256.startsWith(OPEN))
        throw new DomainError('FILE_CHANGED');
      if (!target && (await sha256File(path).catch(() => '')) !== read.sha256)
        throw new DomainError('FILE_CHANGED');
      plans.push({
        path,
        ops,
        rows: rows.filter((row) => pathKey(row.path) === pathKey(path)),
        target,
        expected: target ? read.sha256.slice(OPEN.length) : read.sha256,
        stamp: (this.options.store.baseline(projectId, path)?.revision ?? 0) + 1,
      });
    }
    return plans;
  }

  /**
   * [반영] (SPEC-14.11): the chosen rows of a settled diff (default its selected rows; `cover`:
   * conflict rows the person covers with the model). Open drawings only → applied now. Any closed
   * drawing → its result is computed in the work folder and the answer is the save card
   * (`state: 'confirm'`); nothing is written beside a drawing before `confirm`.
   */
  async apply(
    projectId: string,
    input: { diff: string; rows?: string[]; cover?: string[]; confirmDeletes?: boolean },
  ): Promise<ApplyAnswer> {
    return this.exclusive(projectId, async () => {
      const kept = this.diffs.get(input.diff);
      if (!kept || kept.projectId !== projectId) throw new DomainError('DIFF_NOT_FOUND');
      const { diff, link } = kept;
      if (!diff.settled) throw new DomainError('DIFF_NOT_SETTLED');
      const reader = await this.reader();
      this.writer();
      const cover = new Set(input.cover ?? []);
      const wanted = new Set(
        input.rows ?? diff.rows.filter((row) => row.selected).map((r) => r.id),
      );
      for (const id of cover) wanted.add(id);
      const chosen = diff.rows.filter((row) => wanted.has(row.id));
      if (!chosen.length || chosen.length !== wanted.size) throw new DomainError('INVALID_INPUT');
      for (const row of chosen) {
        const covered =
          cover.has(row.id) &&
          row.kind === 'conflict' &&
          (row.reason === 'BOTH_CHANGED' || row.reason === 'NO_BASELINE') &&
          !!row.after &&
          !!row.handle;
        if (!covered && !row.selectable) throw new DomainError('ROW_NOT_SELECTABLE');
      }
      const deletes = chosen.filter((row) => row.kind === 'delete').length;
      if (deletes > (this.options.maxDeletes ?? DIRECT_MAX_DELETES) && !input.confirmDeletes)
        throw new DomainError('DELETE_CONFIRMATION_REQUIRED');
      // The model must still be what the rows were computed from (SPEC-14.13 4).
      const source = await reader.source(projectId, link);
      if (source.revision !== diff.sourceRevision) throw new DomainError('SOURCE_CHANGED');
      const plans = await this.plans(projectId, chosen, link, diff.drawings);
      return this.run(projectId, link, source, plans);
    });
  }

  /** Computes closed files (then the card) or applies open files now. */
  private async run(
    projectId: string,
    linkId: string,
    source: SourceSnapshot,
    plans: FilePlan[],
  ): Promise<ApplyAnswer> {
    const open = plans.filter((plan) => plan.target),
      closed = plans.filter((plan) => !plan.target);
    if (!closed.length) return this.applyOpen(projectId, source, open, []);
    const id = randomBytes(12).toString('hex');
    const work = join(this.workRoot(), 'apply-' + id);
    let computed: Computed[];
    try {
      computed = await this.compute(closed, work);
    } catch (error) {
      await rm(work, { recursive: true, force: true }).catch(() => {});
      const code = (error as { code?: string }).code;
      if (code === 'APPLY_FAILED' || code === 'OP_REFUSED')
        return {
          state: 'failed',
          code: 'OP_REFUSED',
          path: null,
          failed: (
            (error as { jobs?: { failed: { id: string; code: string }[] }[] }).jobs ?? []
          ).flatMap((job) => job.failed.map(({ id, code }) => ({ id, code }))),
          rolledBack: [],
          undoFailed: [],
        };
      throw error;
    }
    const expiresAt = this.now().getTime() + PENDING_MS;
    this.pending.set(id, { projectId, linkId, source, open, closed: computed, work, expiresAt });
    this.sweep();
    return {
      state: 'confirm',
      id,
      expiresAt: new Date(expiresAt).toISOString(),
      files: [
        ...computed.map((c) => ({
          path: c.plan.path,
          mode: 'closed' as const,
          written: join(dirname(c.plan.path), c.name),
          version: c.version,
          rows: c.plan.ops.map((op) => op.id),
          check: c.check,
          dimensions: c.dimensions,
        })),
        ...open.map((plan) => ({
          path: plan.path,
          mode: 'open' as const,
          written: null,
          version: null,
          rows: plan.ops.map((op) => op.id),
          check: null,
          dimensions: [],
        })),
      ],
    };
  }

  private workRoot() {
    if (!this.options.workRoot || !this.options.tokens) throw new DomainError('NO_ZWCAD');
    return this.options.workRoot;
  }

  /** Closed files: copies applied in a hidden ZWCAD, one run per DWG version (one token each). */
  private async compute(plans: FilePlan[], work: string): Promise<Computed[]> {
    const tokens = this.options.tokens!;
    const writer = this.writer();
    await mkdir(join(work, 'src'), { recursive: true });
    const byVersion = new Map<string, { plan: FilePlan; copy: string; index: number }[]>();
    for (const [index, plan] of plans.entries()) {
      const copy = join(work, 'src', `d${index + 1}.dwg`);
      await copyFile(plan.path, copy);
      if ((await sha256File(copy)) !== plan.expected) throw new DomainError('FILE_CHANGED');
      const version = await dwgVersionOf(copy);
      byVersion.set(version, [...(byVersion.get(version) ?? []), { plan, copy, index }]);
    }
    const out: Computed[] = [];
    for (const [version, group] of byVersion) {
      const folder = join(work, 'v' + version);
      await mkdir(folder, { recursive: true });
      const names = group.map((g) => `r${g.index + 1}.dwg`);
      const token = tokens.issue({ folder, names, version });
      try {
        const results = await writer.applyClosed({
          tokens,
          token: token.id,
          work,
          jobs: group.map((g, i) => ({
            id: String(g.index),
            source: g.copy,
            target: join(folder, names[i]),
            ops: g.plan.ops,
            revision: g.plan.stamp,
          })),
        });
        for (const g of group) {
          const result = results.find((r) => r.id === String(g.index));
          if (!result) throw new DomainError('APPLY_FAILED');
          const taken = (name: string) => existsSync(join(dirname(g.plan.path), name));
          out.push({
            plan: g.plan,
            copy: result.path,
            name: backflowName(g.plan.path, this.now(), taken),
            version,
            sha256: await sha256File(result.path),
            apply: result,
            ...changesOf(g.plan, result),
          });
        }
      } finally {
        tokens.revoke(token.id);
      }
    }
    return out;
  }

  /** Open files, in order; any failure undoes the files already changed (ADR-027). */
  private async applyOpen(
    projectId: string,
    source: SourceSnapshot,
    plans: FilePlan[],
    closed: {
      path: string;
      written: string;
      apply: FileApply;
      plan: FilePlan;
      check: PreservationCheck;
      dimensions: DimensionToCheck[];
    }[],
    rollback?: () => Promise<void>,
  ): Promise<ApplyAnswer> {
    const writer = this.writer();
    const done: { plan: FilePlan; apply: FileApply; undoId: string | null }[] = [];
    const undoAll = async () => {
      const rolledBack: string[] = [],
        undoFailed: string[] = [];
      for (const item of [...done].reverse()) {
        const undone = item.undoId
          ? await writer.undoOpen(item.plan.target!, item.undoId).catch(() => ({ ok: false }))
          : { ok: false };
        (undone.ok ? rolledBack : undoFailed).push(item.plan.path);
      }
      await rollback?.();
      return { rolledBack, undoFailed };
    };
    for (const plan of plans) {
      let answer;
      try {
        answer = await writer.applyOpen(plan.target!, {
          ops: plan.ops,
          expected: plan.expected,
          stamp: plan.stamp,
        });
      } catch (error) {
        if (error instanceof DomainError && error.code !== 'HOST_BUSY') {
          const undone = await undoAll();
          return { state: 'failed', code: error.code, path: plan.path, failed: [], ...undone };
        }
        // The result is not known: never apply again; read the drawing and say what it shows.
        const read = await writer.readOpen(plan.target!, false).catch(() => null);
        const seen = read
          ? appliedOps(plan.ops, read.state.entities)
          : { applied: [], notApplied: plan.ops.map((op) => op.id) };
        await rollback?.();
        return { state: 'unclear', path: plan.path, ...seen };
      }
      if (!answer.ok) {
        const undone = await undoAll();
        return {
          state: 'failed',
          code: answer.code,
          path: plan.path,
          failed: answer.failed ?? [],
          ...undone,
        };
      }
      done.push({ plan, apply: answer.apply, undoId: answer.undoId });
    }
    // Baselines: only the rows applied (SPEC-14.11 3); the previous ones are kept for an undo.
    const id = randomBytes(12).toString('hex');
    const record: Applied = { projectId, files: [], undone: false };
    const files: AppliedFile[] = [];
    const remember = (
      path: string,
      key: string,
      target: HostTarget | null,
      undoId: string | null,
      plan: FilePlan,
      apply: FileApply,
    ) => {
      const previous = this.options.store.baseline(projectId, key);
      // A new file beside a closed drawing carries the original's other pairs (same handles).
      const carried = previous ?? this.options.store.baseline(projectId, path);
      const pairs = plan.ops.flatMap((op) => {
        const row = plan.rows.find((r) => r.id === op.id);
        const handle = apply.results.find((r) => r.id === op.id)?.handle;
        return op.op !== 'delete' && row?.sourceId && handle
          ? [{ sourceId: row.sourceId, handle, via: 'backflow' as const }]
          : [];
      });
      const { baseline } = recordBaseline(
        { path: key, units: null, sha256: '', entities: apply.after.entities },
        pairs,
        source,
        carried,
        this.now(),
      );
      this.options.store.save(projectId, baseline);
      record.files.push({ path, target, undoId, previous, key });
    };
    for (const item of done) {
      const { check, dimensions } = changesOf(item.plan, item.apply);
      remember(
        item.plan.path,
        item.plan.path,
        item.plan.target,
        item.undoId,
        item.plan,
        item.apply,
      );
      files.push({
        path: item.plan.path,
        mode: 'open',
        written: null,
        rows: item.plan.ops.map((op) => op.id),
        check,
        dimensions,
        undoId: item.undoId,
      });
    }
    for (const item of closed) {
      remember(item.path, item.written, null, null, item.plan, item.apply);
      files.push({
        path: item.path,
        mode: 'closed',
        written: item.written,
        rows: item.plan.ops.map((op) => op.id),
        check: item.check,
        dimensions: item.dimensions,
        undoId: null,
      });
    }
    this.applied.set(id, record);
    while (this.applied.size > KEEP) this.applied.delete(this.applied.keys().next().value!);
    return { state: 'applied', id, files };
  }

  /**
   * [저장] on the save card: open drawings first (ADR-027), then each computed copy goes beside its
   * original under a confirmed token (no overwrite, same version, same bytes as checked). A failure
   * removes the files this step wrote and undoes the open drawings.
   */
  async confirm(projectId: string, id: string): Promise<ApplyAnswer> {
    const pending = this.pending.get(id);
    if (!pending || pending.projectId !== projectId || pending.expiresAt < this.now().getTime())
      throw new DomainError('APPLY_NOT_FOUND');
    return this.exclusive(projectId, async () => {
      this.pending.delete(id);
      const tokens = this.options.tokens!;
      const written: string[] = [];
      const removeWritten = async () => {
        for (const path of written) await rm(path, { force: true }).catch(() => {});
      };
      try {
        const reader = await this.reader();
        const source = await reader.source(projectId, pending.linkId);
        if (source.revision !== pending.source.revision) throw new DomainError('SOURCE_CHANGED');
        for (const c of pending.closed)
          if ((await sha256File(c.plan.path).catch(() => '')) !== c.plan.expected)
            throw new DomainError('FILE_CHANGED');
        const closed = [];
        for (const c of pending.closed) {
          const folder = dirname(c.plan.path);
          const token = tokens.issue({
            folder,
            names: [c.name],
            version: c.version,
            confirmed: true,
          });
          try {
            const target = tokens.authorize(token.id, join(folder, c.name));
            await copyFile(c.copy, target.path, constants.COPYFILE_EXCL);
            written.push(target.path);
            tokens.written(token.id, target.path);
            if (
              (await dwgVersionOf(target.path)) !== c.version ||
              (await sha256File(target.path)) !== c.sha256
            )
              throw new DomainError('OUTPUT_UNCLEAR');
            closed.push({
              path: c.plan.path,
              written: target.path,
              apply: c.apply,
              plan: c.plan,
              check: c.check,
              dimensions: c.dimensions,
            });
          } finally {
            tokens.revoke(token.id);
          }
        }
        const answer = await this.applyOpen(
          projectId,
          pending.source,
          pending.open,
          closed,
          removeWritten,
        );
        return answer;
      } catch (error) {
        await removeWritten();
        throw error;
      } finally {
        await rm(pending.work, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  /** [취소] on the save card: the computed copies go; nothing was written beside a drawing. */
  async cancel(projectId: string, id: string) {
    const pending = this.pending.get(id);
    if (!pending || pending.projectId !== projectId) throw new DomainError('APPLY_NOT_FOUND');
    this.pending.delete(id);
    await rm(pending.work, { recursive: true, force: true }).catch(() => {});
    return { cancelled: true };
  }

  /**
   * [되돌리기] (SPEC-14.11 1·3): ZWCAD's U for each open file of the apply, newest first, while it is
   * still that drawing's latest change; their baselines go back to the previous ones. New files
   * written beside closed drawings stay (the person deletes or uses them).
   */
  async undo(projectId: string, id: string) {
    const record = this.applied.get(id);
    if (!record || record.projectId !== projectId || record.undone)
      throw new DomainError('APPLY_NOT_FOUND');
    const writer = this.writer();
    const files = [];
    for (const file of [...record.files].reverse()) {
      if (!file.target || !file.undoId) {
        files.push({ path: file.path, undone: false, reason: 'closed' });
        continue;
      }
      const result = await writer.undoOpen(file.target, file.undoId).catch(() => ({
        ok: false,
        reason: 'unreachable',
      }));
      if (result.ok) {
        const current = this.options.store.baseline(projectId, file.key);
        if (file.previous)
          this.options.store.save(projectId, {
            ...file.previous,
            revision: current?.revision ?? 0,
          });
        else if (current)
          this.options.store.save(projectId, { ...current, pairs: [], handles: {} });
      }
      files.push({
        path: file.path,
        undone: result.ok,
        reason: result.ok ? null : ((result as { reason?: string }).reason ?? null),
      });
    }
    record.undone = true;
    return { files };
  }

  private sweep() {
    const now = this.now().getTime();
    for (const [id, pending] of this.pending)
      if (pending.expiresAt < now) {
        this.pending.delete(id);
        void rm(pending.work, { recursive: true, force: true }).catch(() => {});
      }
  }

  /**
   * Sync jig "CAD를 Rhino에 맞춤" (SPEC-05.8 3, T-233): the chosen rows of a Sync jig run on its open
   * drawing through the same apply. Offset and matched rows rewrite the drawing entity to the Rhino
   * object's shape (line, polyline with arcs, arc, circle, insert position/rotation; the type stays),
   * Rhino-only rows add the object on an existing layer, CAD-only rows delete the entity. The pairs
   * become baselines, so a later [모델 변경 반영] knows them.
   */
  async syncApply(
    projectId: string,
    input: {
      rhino: string;
      cad: string;
      relation: Relation;
      rows: {
        id: string;
        state: 'match' | 'offset' | 'rhino-only' | 'cad-only';
        rhino?: string;
        cad?: string;
        layer?: string | null;
      }[];
      path: string;
      linkId: string;
      confirmDeletes?: boolean;
    },
  ): Promise<ApplyAnswer & { refused?: { id: string; code: string }[] }> {
    return this.exclusive(projectId, async () => {
      const reader = await this.reader();
      const writer = this.writer();
      if (!reader.sourceOfSync) throw new DomainError('NO_ZWCAD');
      const target = await writer.open(input.path);
      if (!target) throw new DomainError('ZWCAD_ATTACHED_EDIT_UNAVAILABLE');
      const source = reader.sourceOfSync(projectId, input.rhino, input.linkId);
      const read = await writer.readOpen(target, false);
      const scale = metresPerUnit(read.units);
      if (!scale) throw new DomainError('UNITS_NOT_MM');
      const frame = frameOf(input.relation, scale, null);
      if ('error' in frame) throw new DomainError('INVALID_INPUT');
      const objects = new Map(source.objects.map((o) => [o.id, o]));
      const entities = new Map(read.state.entities.map((e) => [e.handle.toUpperCase(), e]));
      const layers = new Set(read.state.layers.filter((name) => !name.includes('|')));
      const refused: { id: string; code: string }[] = [];
      const rows: BackflowRow[] = [];
      const base = {
        reason: null,
        via: 'sync' as const,
        selectable: true,
        selected: true,
        absoluteXref: false,
        affectedRoots: [],
        path: input.path,
      };
      for (const row of input.rows) {
        const object = row.rhino ? objects.get(row.rhino) : undefined;
        const entity = row.cad ? entities.get(row.cad.toUpperCase()) : undefined;
        if (row.state === 'cad-only') {
          if (!entity) refused.push({ id: row.id, code: 'ENTITY_MISSING' });
          else
            rows.push({
              ...base,
              id: row.id,
              kind: 'delete',
              sourceId: null,
              sourceLayer: null,
              handle: entity.handle,
              layer: entity.layer,
              before: entity.geometry,
              after: null,
            });
          continue;
        }
        if (!object?.geometry) {
          refused.push({ id: row.id, code: 'SOURCE_TYPE' });
          continue;
        }
        const after = mapGeometry(object.geometry, frame);
        if (row.state === 'rhino-only') {
          if (after.kind === 'insert') refused.push({ id: row.id, code: 'SOURCE_TYPE' });
          else if (!row.layer || !layers.has(row.layer))
            refused.push({ id: row.id, code: 'LAYER_NEEDED' });
          else
            rows.push({
              ...base,
              id: row.id,
              kind: 'add',
              sourceId: object.id,
              sourceLayer: object.layer,
              handle: null,
              layer: row.layer,
              before: null,
              after,
            });
          continue;
        }
        if (!entity) refused.push({ id: row.id, code: 'ENTITY_MISSING' });
        else if (!entity.geometry) refused.push({ id: row.id, code: 'ENTITY_TYPE' });
        else if (entity.dynamic || entity.xref)
          refused.push({ id: row.id, code: entity.xref ? 'XREF_INSERT' : 'DYNAMIC_BLOCK' });
        else if (!writable(object.geometry, entity.geometry))
          refused.push({ id: row.id, code: 'TYPE_CHANGED' });
        else
          rows.push({
            ...base,
            id: row.id,
            kind: 'modify',
            sourceId: object.id,
            sourceLayer: object.layer,
            handle: entity.handle,
            layer: entity.layer,
            before: entity.geometry,
            after,
          });
      }
      if (!rows.length)
        return {
          state: 'failed',
          code: 'NOTHING_TO_APPLY',
          path: input.path,
          failed: refused,
          rolledBack: [],
          undoFailed: [],
          refused,
        };
      const deletes = rows.filter((row) => row.kind === 'delete').length;
      if (deletes > (this.options.maxDeletes ?? DIRECT_MAX_DELETES) && !input.confirmDeletes)
        throw new DomainError('DELETE_CONFIRMATION_REQUIRED');
      const plan: FilePlan = {
        path: input.path,
        ops: [...opsOfRows(rows, input.linkId).values()][0],
        rows,
        target,
        expected: read.documentHash,
        stamp: (this.options.store.baseline(projectId, input.path)?.revision ?? 0) + 1,
      };
      return { ...(await this.applyOpen(projectId, source, [plan], [])), refused };
    });
  }
}
