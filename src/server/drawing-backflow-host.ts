// 역반영의 실제 읽기·쓰기 (PLAN-47 T-233): the `BackflowReader` T-232 left as a seam and the writer the
// apply uses. A drawing open in ZWCAD with the VIDE plugin (an attached connection) is read and
// written there (one UNDO step per file); any other drawing is read from a copy in the engine's
// work folder and written as a new file by a hidden ZWCAD (hosts/zwcad/drawing-backflow.ts). The
// source is the newest finished Sync of the Rhino link (stored in metres, src/core/backflow-source.ts).
import { access, copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DomainError } from '../core/store.ts';
import { pathKey } from '../core/xref-graph.ts';
import type { Workspace } from '../core/workspace.ts';
import type { HostTarget } from '../contracts/host-documents.ts';
import type { DrawingEntities, SourceSnapshot } from '../core/drawing-backflow.ts';
import { sourceFromSync } from '../core/backflow-source.ts';
import {
  stateFromRow,
  type BackflowOp,
  type DrawingState,
  type FileApply,
} from '../core/drawing-backflow-apply.ts';
import type { OutputTokens } from '../core/drawing-output.ts';
import type { AttachedZwcadDocuments } from '../../hosts/zwcad/attached-documents.ts';
import {
  applyDrawingCopies,
  readDrawingEntities,
  type ApplyJob,
  type ClosedApply,
  type ClosedRead,
} from '../../hosts/zwcad/drawing-backflow.ts';
import { inspectorOptions } from '../../hosts/zwcad/inspector.ts';
import type { BackflowReader } from './drawing-backflow.ts';

export async function sha256File(path: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

/** An open drawing's read: its state and identity (`open:<documentHash>` is its fingerprint). */
export interface OpenRead {
  state: DrawingState;
  documentHash: string;
  units: number;
  version: string;
}
export type OpenApply =
  | { ok: true; apply: FileApply; undoId: string | null; documentHash: string }
  | { ok: false; code: string; failed?: { id: string; code: string }[] };

/** What the apply writes with (a fake in tests). */
export interface BackflowWriter {
  /** The attached ZWCAD connection that has this drawing open, or null (a closed drawing). */
  open(path: string): Promise<HostTarget | null>;
  readOpen(target: HostTarget, snapshot: boolean): Promise<OpenRead>;
  applyOpen(
    target: HostTarget,
    input: { ops: BackflowOp[]; expected: string; stamp: number },
  ): Promise<OpenApply>;
  undoOpen(target: HostTarget, undoId: string): Promise<{ ok: boolean; reason?: string }>;
  /** Hidden ZWCAD: applies the jobs to copies and writes them through the token (all or none). */
  applyClosed(input: {
    tokens: OutputTokens;
    token: string;
    jobs: ApplyJob[];
    work: string;
  }): Promise<ClosedApply[]>;
}

const OPEN = 'open:';

export class ZwcadBackflowHost implements BackflowReader, BackflowWriter {
  private readonly attached: AttachedZwcadDocuments | undefined;
  private readonly workspace: Pick<Workspace, 'list' | 'lazy'>;
  private readonly workRoot: string;
  private readonly options: { executable: string; plugin: string };
  constructor({
    attached,
    workspace,
    workRoot,
    options = inspectorOptions(),
  }: {
    attached: AttachedZwcadDocuments | undefined;
    workspace: Pick<Workspace, 'list' | 'lazy'>;
    workRoot: string;
    options?: { executable: string; plugin: string };
  }) {
    this.attached = attached;
    this.workspace = workspace;
    this.workRoot = workRoot;
    this.options = options;
  }

  /** The hidden ZWCAD and its worker are installed (open drawings need only the plugin). */
  async available() {
    try {
      await Promise.all([access(this.options.executable), access(this.options.plugin)]);
      return true;
    } catch {
      return !!this.attached;
    }
  }

  /** The newest finished Sync of the Rhino link as the source snapshot (metres). */
  async source(projectId: string, linkId: string): Promise<SourceSnapshot> {
    const entry = this.workspace
      .list(projectId)
      .filter(
        (row) =>
          row.state === 'succeeded' &&
          row.input.linkId === linkId &&
          (row.result?.host ?? 'rhino') === 'rhino',
      )
      .at(-1);
    if (!entry) throw new DomainError('SOURCE_NOT_SYNCED');
    return this.sourceOfSync(projectId, entry.id, linkId);
  }
  /** One stored Rhino Sync as a snapshot; its revision is the Sync and the document's revision. */
  sourceOfSync(projectId: string, syncId: string, linkId: string): SourceSnapshot {
    const saved = this.workspace.lazy(projectId, syncId);
    if (saved.state !== 'succeeded' || !saved.result) throw new DomainError('STALE_REFERENCE');
    if ((saved.result.host ?? 'rhino') !== 'rhino') throw new DomainError('TARGET_MISMATCH');
    const document = (saved.result.sourceDocument ?? {}) as Record<string, unknown>;
    const revision = `${saved.id}:${String(document.revision ?? document.documentHash ?? '')}`;
    return sourceFromSync(saved.result as Record<string, unknown>, linkId, revision);
  }

  async open(path: string): Promise<HostTarget | null> {
    if (!this.attached) return null;
    const open = await this.attached.list().catch(() => []);
    const match = open.find((doc) => doc.path && pathKey(doc.path) === pathKey(path));
    return match ? { instance: match.instance, documentId: match.id } : null;
  }

  async readOpen(target: HostTarget, snapshot: boolean): Promise<OpenRead> {
    const row = await this.attached!.backflowRead(target, snapshot);
    return {
      state: stateFromRow(row),
      documentHash: String(row.documentHash),
      units: Number(row.units),
      version: String(row.version ?? ''),
    };
  }

  async applyOpen(
    target: HostTarget,
    input: { ops: BackflowOp[]; expected: string; stamp: number },
  ): Promise<OpenApply> {
    const row = await this.attached!.backflowApply(target, input);
    if (row.ok !== true)
      return {
        ok: false,
        code: String(row.code ?? 'APPLY_FAILED'),
        failed: Array.isArray(row.failed) ? (row.failed as { id: string; code: string }[]) : [],
      };
    return {
      ok: true,
      apply: {
        results: Array.isArray(row.results) ? (row.results as FileApply['results']) : [],
        before: stateFromRow(row.before),
        after: stateFromRow(row.after),
      },
      undoId: typeof row.undoId === 'string' ? row.undoId : null,
      documentHash: String(row.documentHash ?? ''),
    };
  }

  async undoOpen(target: HostTarget, undoId: string) {
    const result = await this.attached!.directUndo(target, undoId);
    return result.ok ? { ok: true } : { ok: false, reason: String(result.reason ?? '') };
  }

  applyClosed(input: { tokens: OutputTokens; token: string; jobs: ApplyJob[]; work: string }) {
    return applyDrawingCopies({ ...input, options: this.options });
  }

  /** Per path: `open:<documentHash>` for an open drawing, else `<size>:<mtime>` of the file. */
  async fingerprints(projectId: string, paths: readonly string[]) {
    return Promise.all(
      paths.map(async (path) => {
        const target = await this.open(path);
        if (target)
          return OPEN + (await this.attached!.fingerprint(target).catch(() => null))?.documentHash;
        const info = await stat(path).catch(() => null);
        return info ? `${info.size}:${info.mtime.toISOString()}` : 'missing';
      }),
    );
  }

  /**
   * Entities of the drawings by path: an open one from its ZWCAD (sha256 `open:<documentHash>`),
   * a closed one from a copy (sha256 of the original when copied). A drawing that cannot be read
   * is left out (its rows show DRAWING_NOT_READ).
   */
  async drawings(projectId: string, paths: readonly string[]) {
    const out = new Map<string, DrawingEntities>();
    const closed: { id: number; path: string; copy: string; sha256: string }[] = [];
    const work = join(this.workRoot, 'b' + randomBytes(6).toString('hex'));
    try {
      for (const path of paths) {
        const target = await this.open(path);
        if (target) {
          const read = await this.readOpen(target, false);
          out.set(path, {
            path,
            units: read.units,
            sha256: OPEN + read.documentHash,
            entities: read.state.entities,
          });
          continue;
        }
        if (!(await stat(path).catch(() => null))?.isFile()) continue;
        await mkdir(work, { recursive: true });
        const id = closed.length + 1,
          copy = join(work, `d${id}.dwg`);
        await copyFile(path, copy);
        closed.push({ id, path, copy, sha256: await sha256File(path) });
      }
      if (closed.length) {
        const reads: Map<number, ClosedRead> = await readDrawingEntities(
          closed.map((file) => ({ id: file.id, path: file.copy })),
          work,
          this.options,
        );
        for (const file of closed) {
          const read = reads.get(file.id);
          if (!read || read.error) continue;
          out.set(file.path, {
            path: file.path,
            units: read.units,
            sha256: file.sha256,
            entities: read.entities,
          });
        }
      }
      return out;
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
}
