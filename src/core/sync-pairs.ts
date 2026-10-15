// 동기화 쌍 (SPEC-01.13 11, SPEC-05.12, ARCH-01 「작업 폴더(PLAN-52)」 '동기화 쌍과 갱신 제안', PLAN-54
// T-349): the pairs a person designated, kept in the work folder manifest's `pairs` key (the other
// keys of the manifest are kept as they are), or in `<data>/projects/<p>/pairs.json` when there is
// no manifest to write (no work folder, a read-only `architecture-workspace/1` folder). The
// [무시] memory of the update proposals lives next to it in `proposals-dismissed.json`.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../contracts/errors.ts';
import {
  readWorkspaceConfig,
  VIDE_WORKSPACE_SCHEMA,
  writeWorkspaceConfig,
  type Workspace,
  type WorkspaceConfig,
} from './workspace-config.ts';
import { WORKSPACE_ROLES, type WorkspaceRole } from './workspace-template.ts';
import { pathKey } from './xref-graph.ts';

export const PAIRS_FILE = 'pairs.json';
export const DISMISSED_FILE = 'proposals-dismissed.json';

const finite = z.number().finite();
export const pairRelationSchema = z
  .object({
    rotation: finite,
    translation: z.tuple([finite, finite]),
    dz: finite,
    confirmedAt: z.string().max(40).nullable().optional(),
  })
  .passthrough();
const sideSchema = z
  .object({ role: z.string().max(40).nullable(), path: z.string().min(1).max(1024) })
  .passthrough();
export const syncPairSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]{12}$/),
    model: sideSchema,
    drawing: sideSchema,
    relation: pairRelationSchema.optional(),
    linkIds: z
      .object({ model: z.string().max(200).optional(), drawing: z.string().max(200).optional() })
      .passthrough()
      .optional(),
    createdBy: z.string().max(200),
    createdAt: z.string().max(40),
  })
  .passthrough();
export interface PairRelation {
  rotation: number;
  translation: [number, number];
  dz: number;
  confirmedAt?: string | null;
}
export interface PairSide {
  role: string | null;
  path: string;
}
export interface SyncPair {
  id: string;
  model: PairSide;
  drawing: PairSide;
  relation?: PairRelation;
  linkIds?: { model?: string; drawing?: string };
  createdBy: string;
  createdAt: string;
  [key: string]: unknown;
}
/** A pair with both files' absolute paths on this PC and where it is kept. */
export interface ResolvedPair extends SyncPair {
  absolute: { model: string; drawing: string };
  /** `manifest`: the work folder's `project.config.json`; `file`: `pairs.json` in VIDE's data. */
  where: 'manifest' | 'file';
}

/** A new pair id: 12 lower-case letters and digits. */
export function newPairId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(12);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

/** The pairs a manifest holds; entries of another shape are skipped (and kept when written). */
export function pairsOf(cfg: WorkspaceConfig | null | undefined): SyncPair[] {
  const list = (cfg as { pairs?: unknown } | null | undefined)?.pairs;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const parsed = syncPairSchema.safeParse(entry);
    return parsed.success ? [parsed.data as SyncPair] : [];
  });
}

/**
 * `cfg` with `pairs` changed by `change` (pure; the caller writes it). Entries this code cannot
 * read stay where they were. An `architecture-workspace/1` manifest is `WORKSPACE_READ_ONLY`.
 */
export function withPairs(
  cfg: WorkspaceConfig,
  change: (pairs: SyncPair[]) => SyncPair[],
): WorkspaceConfig {
  if (cfg.schema !== VIDE_WORKSPACE_SCHEMA) throw new DomainError('WORKSPACE_READ_ONLY');
  const held = (cfg as { pairs?: unknown }).pairs;
  const raw: unknown[] = Array.isArray(held) ? held : [];
  const unknownEntries = raw.filter((entry) => !syncPairSchema.safeParse(entry).success);
  return { ...cfg, pairs: [...change(pairsOf(cfg)), ...unknownEntries] };
}

const slash = (path: string) => path.replace(/\\/g, '/');
const under = (root: string, path: string) => {
  const relative = win32.relative(root, path);
  return relative && !relative.startsWith('..') && !win32.isAbsolute(relative)
    ? relative
    : undefined;
};

/**
 * How a file is written in the manifest: relative to the role folder holding it, else to the work
 * folder root; null when the file is outside the work folder.
 */
export function sideOf(
  workspace: Pick<Workspace, 'root' | 'paths'>,
  absolute: string,
): PairSide | null {
  for (const role of WORKSPACE_ROLES) {
    const folder = workspace.paths[role];
    if (!folder) continue;
    const relative = under(folder, absolute);
    if (relative) return { role, path: slash(relative) };
  }
  const relative = under(workspace.root, absolute);
  return relative ? { role: null, path: slash(relative) } : null;
}
/** A manifest side's absolute path on this PC. */
export function absoluteOf(workspace: Pick<Workspace, 'root' | 'paths'>, side: PairSide): string {
  const base =
    (side.role && workspace.paths[side.role as WorkspaceRole]) ||
    (side.role ? null : workspace.root);
  return win32.resolve(base ?? workspace.root, side.path);
}

const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);

async function writeJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface SyncPairStoreOptions {
  /** VIDE's data folder (`<data>/projects/<projectId>/…`). */
  dataDirectory: string;
  /** The project's work folder, or null (no manifest). */
  workspaceOf: (projectId: string) => Promise<Workspace | null>;
  now?: () => Date;
}
export interface NewPair {
  model: string;
  drawing: string;
  relation?: Omit<PairRelation, 'confirmedAt'> & { confirmedAt?: string | null };
  linkIds?: { model?: string; drawing?: string };
  createdBy?: string | null;
}

/** The project's pairs, read and written where SPEC-01.13 11 and ARCH-01 put them. */
export class SyncPairStore {
  private readonly now: () => Date;
  private readonly options: SyncPairStoreOptions;
  private chain = Promise.resolve();
  constructor(options: SyncPairStoreOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }
  private fileOf(projectId: string) {
    return join(this.options.dataDirectory, 'projects', projectId, PAIRS_FILE);
  }
  /** One change at a time (two quick presses must not lose one pair). */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private async workspace(projectId: string) {
    try {
      return await this.options.workspaceOf(projectId);
    } catch {
      return null;
    }
  }
  private async filePairs(projectId: string): Promise<SyncPair[]> {
    const value = await readJson(this.fileOf(projectId));
    return Array.isArray(value?.pairs)
      ? value.pairs.flatMap((entry) => {
          const parsed = syncPairSchema.safeParse(entry);
          return parsed.success ? [parsed.data as SyncPair] : [];
        })
      : [];
  }
  /** Every pair of the project: the manifest's first, then those kept in VIDE's data. */
  async list(projectId: string): Promise<ResolvedPair[]> {
    const workspace = await this.workspace(projectId);
    const out: ResolvedPair[] = [];
    if (workspace)
      for (const pair of pairsOf(workspace.cfg))
        out.push({
          ...pair,
          absolute: {
            model: absoluteOf(workspace, pair.model),
            drawing: absoluteOf(workspace, pair.drawing),
          },
          where: 'manifest',
        });
    for (const pair of await this.filePairs(projectId))
      out.push({
        ...pair,
        absolute: { model: pair.model.path, drawing: pair.drawing.path },
        where: 'file',
      });
    return out;
  }
  async get(projectId: string, pairId: string): Promise<ResolvedPair> {
    const pair = (await this.list(projectId)).find((entry) => entry.id === pairId);
    if (!pair) throw new DomainError('PAIR_NOT_FOUND');
    return pair;
  }
  /** Designates a pair (`model`, `drawing`: absolute paths on this PC). PAIR_EXISTS when held. */
  add(projectId: string, input: NewPair): Promise<ResolvedPair> {
    return this.serial(async () => {
      if (!win32.isAbsolute(input.model) || !win32.isAbsolute(input.drawing))
        throw new DomainError('INVALID_INPUT');
      const existing = await this.list(projectId);
      if (
        existing.some(
          (pair) =>
            samePath(pair.absolute.model, input.model) &&
            samePath(pair.absolute.drawing, input.drawing),
        )
      )
        throw new DomainError('PAIR_EXISTS');
      const at = this.now().toISOString();
      const base = {
        id: newPairId(),
        ...(input.relation
          ? {
              relation: {
                rotation: input.relation.rotation,
                translation: input.relation.translation,
                dz: input.relation.dz,
                confirmedAt: input.relation.confirmedAt ?? at,
              },
            }
          : {}),
        ...(input.linkIds && (input.linkIds.model || input.linkIds.drawing)
          ? { linkIds: input.linkIds }
          : {}),
        createdBy: input.createdBy?.trim() || 'user',
        createdAt: at,
      };
      const workspace = await this.workspace(projectId);
      const model = workspace && !workspace.readOnly ? sideOf(workspace, input.model) : null;
      const drawing = workspace && !workspace.readOnly ? sideOf(workspace, input.drawing) : null;
      if (workspace && model && drawing) {
        const pair: SyncPair = { ...base, model, drawing };
        const fresh = (await readWorkspaceConfig(workspace.root)) ?? workspace.cfg;
        await writeWorkspaceConfig(
          workspace.root,
          withPairs(fresh, (pairs) => [...pairs, pair]),
          this.now(),
        );
        return {
          ...pair,
          absolute: {
            model: absoluteOf(workspace, model),
            drawing: absoluteOf(workspace, drawing),
          },
          where: 'manifest' as const,
        };
      }
      // No manifest to write: absolute paths in VIDE's data (other PCs do not see this pair).
      const pair: SyncPair = {
        ...base,
        model: { role: null, path: input.model },
        drawing: { role: null, path: input.drawing },
      };
      const kept = await this.filePairs(projectId);
      await writeJson(this.fileOf(projectId), { pairs: [...kept, pair] });
      return {
        ...pair,
        absolute: { model: input.model, drawing: input.drawing },
        where: 'file' as const,
      };
    });
  }
  /** Replaces a pair's relation (the Sync jig confirmed it again). */
  setRelation(
    projectId: string,
    pairId: string,
    relation: Omit<PairRelation, 'confirmedAt'>,
  ): Promise<ResolvedPair> {
    return this.change(projectId, pairId, (pair) => ({
      ...pair,
      relation: {
        rotation: relation.rotation,
        translation: relation.translation,
        dz: relation.dz,
        confirmedAt: this.now().toISOString(),
      },
    }));
  }
  /** Ends a pair ([쌍 해제]). */
  async remove(projectId: string, pairId: string): Promise<void> {
    await this.change(projectId, pairId, () => null);
  }
  private change(
    projectId: string,
    pairId: string,
    edit: (pair: SyncPair) => SyncPair | null,
  ): Promise<ResolvedPair> {
    return this.serial(async () => {
      const held = await this.get(projectId, pairId);
      const strip = ({ absolute: _a, where: _w, ...pair }: ResolvedPair): SyncPair => pair;
      const next = edit(strip(held));
      if (held.where === 'manifest') {
        const workspace = await this.workspace(projectId);
        if (!workspace) throw new DomainError('PAIR_NOT_FOUND');
        const fresh = (await readWorkspaceConfig(workspace.root)) ?? workspace.cfg;
        await writeWorkspaceConfig(
          workspace.root,
          withPairs(fresh, (pairs) =>
            pairs.flatMap((pair) => (pair.id === pairId ? (next ? [next] : []) : [pair])),
          ),
          this.now(),
        );
      } else {
        const kept = await this.filePairs(projectId);
        await writeJson(this.fileOf(projectId), {
          pairs: kept.flatMap((pair) => (pair.id === pairId ? (next ? [next] : []) : [pair])),
        });
      }
      return next ? { ...held, ...next } : held;
    });
  }
}

// ---------------------------------------------------------------------------------------------
// [무시] memory (ARCH-01: `proposals-dismissed.json {pairs: {<pairId>: {setHash, rowKeys[], at}}}`)

export interface DismissedSet {
  setHash: string;
  rowKeys: string[];
  at: string;
}
export type DismissedPairs = Record<string, DismissedSet>;

const dismissedFile = (dataDirectory: string, projectId: string) =>
  join(dataDirectory, 'projects', projectId, DISMISSED_FILE);
export async function readDismissed(
  dataDirectory: string,
  projectId: string,
): Promise<DismissedPairs> {
  const value = await readJson(dismissedFile(dataDirectory, projectId));
  const pairs = value?.pairs;
  if (!pairs || typeof pairs !== 'object' || Array.isArray(pairs)) return {};
  const out: DismissedPairs = {};
  for (const [id, entry] of Object.entries(pairs as Record<string, unknown>)) {
    const row = entry as Partial<DismissedSet> | null;
    if (row && typeof row.setHash === 'string' && Array.isArray(row.rowKeys))
      out[id] = {
        setHash: row.setHash,
        rowKeys: row.rowKeys.filter((key): key is string => typeof key === 'string'),
        at: typeof row.at === 'string' ? row.at : '',
      };
  }
  return out;
}
export async function writeDismissed(
  dataDirectory: string,
  projectId: string,
  pairs: DismissedPairs,
): Promise<void> {
  await writeJson(dismissedFile(dataDirectory, projectId), { pairs });
}

/** One mismatch row as the [무시] memory knows it (no row number: it changes between runs). */
export interface RowKeyInput {
  state: string;
  rhino?: { nativeId: string } | undefined;
  cad?: { nativeId: string } | undefined;
  deviation?: number | undefined;
  length?: number | undefined;
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** `<분류>:<Rhino 객체 ID|->:<CAD Handle|->:<바뀌는 값(m, 1 mm 반올림)>` → SHA-256, first 16. */
export function rowKey(row: RowKeyInput): string {
  const value = row.state === 'offset' ? row.deviation : row.length;
  const rounded = value === undefined ? '-' : (Math.round(value * 1000) / 1000).toFixed(3);
  return sha(
    `${row.state}:${row.rhino?.nativeId ?? '-'}:${row.cad?.nativeId?.toUpperCase() ?? '-'}:${rounded}`,
  ).slice(0, 16);
}
/** The SHA-256 of the sorted row keys. */
export function setHash(keys: readonly string[]): string {
  return sha([...keys].sort().join('\n'));
}
