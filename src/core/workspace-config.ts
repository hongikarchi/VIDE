// The work folder's manifest `project.config.json` (SPEC-01.13 7~9, ARCH-01 「작업 폴더(PLAN-52)」,
// ADR-042): two schemas read, one written. The role paths in the manifest are the source of truth;
// folder names differ per project and code only knows the role keys. The `server` part is memory
// (what a person confirmed), never a convention. No server imports here: the real-path rule of
// `src/server/project-path.ts` (junctions, mapped and subst drives) is repeated in `realPathOf`.
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../contracts/errors.ts';
import type { ProjectFolder } from './project-folders.ts';
import { pathKey } from './xref-graph.ts';
import {
  isWorkspaceRole,
  safeRelativeFolder,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from './workspace-template.ts';

export { WORKSPACE_ROLES, isWorkspaceRole, type WorkspaceRole } from './workspace-template.ts';

export const WORKSPACE_CONFIG_FILE = 'project.config.json';
export const VIDE_WORKSPACE_SCHEMA = 'vide-workspace/1';
export const ARCHITECTURE_WORKSPACE_SCHEMA = 'architecture-workspace/1';

/**
 * Codes this module throws (as `DomainError`) and the HTTP status the routes give them.
 * `WORKSPACE_READ_ONLY`: a write to an `architecture-workspace/1` manifest (it is promoted first).
 */
export const workspaceConfigStatuses: Record<string, number> = {
  WORKSPACE_CONFIG_INVALID: 422,
  WORKSPACE_PROJECT_CONFLICT: 409,
  WORKSPACE_READ_ONLY: 409,
  OUTSIDE_WORKSPACE: 403,
  WORKSPACE_ACCESS_DENIED: 403,
};

// ---------------------------------------------------------------------------------------------
// `architecture-workspace/1` (규모검토 folders, read only)

/** Its path keys that are one of our roles, by our role key. */
export const ARCHITECTURE_ROLE_MAP: Readonly<Record<string, WorkspaceRole>> = {
  raw: 'raw',
  rhino: 'rhino',
  analysis: 'review',
  output: 'output',
  references: 'references',
  archive: 'archive',
};
/** Its path keys read as sub paths of the review role. */
export const ARCHITECTURE_REVIEW_PARTS = ['project_data', 'law_review', 'site_modeling'] as const;
/** Its path keys kept as reference paths without a role. */
export const ARCHITECTURE_OTHER_PATHS = ['engine', 'rcp', 'presentation'] as const;

const gitSchema = z
  .object({
    mode: z.string().optional(),
    root: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    remote: z.string().nullable().optional(),
  })
  .passthrough();

const architectureSchema = z
  .object({
    schema: z.literal(ARCHITECTURE_WORKSPACE_SCHEMA),
    project_id: z.string().optional(),
    title: z.string().optional(),
    paths: z.record(z.string(), z.unknown()).default({}),
    authority: z.record(z.string(), z.unknown()).optional(),
    git: gitSchema.optional(),
  })
  .passthrough();

export interface ArchitectureWorkspaceConfig {
  schema: typeof ARCHITECTURE_WORKSPACE_SCHEMA;
  project_id?: string;
  title?: string;
  /** Path keys of 규모검토; non-string values are kept but have no meaning here. */
  paths: Record<string, unknown>;
  authority?: Record<string, unknown>;
  git?: { mode?: string; root?: string | null; branch?: string | null; remote?: string | null };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------------
// `vide-workspace/1` (read and written)

const isoOrNull = z.string().nullable().optional();
const serverSchema = z
  .object({
    root: z.string().min(1),
    paths: z.record(z.string(), z.string()).default({}),
    targets: z.record(z.string(), z.string().nullable()).default({}),
    checkout: z
      .object({ rhino: z.literal('local').default('local'), cad: z.enum(['server', 'local']) })
      .passthrough()
      .default({ rhino: 'local', cad: 'server' }),
    proposedAt: isoOrNull,
    confirmedBy: isoOrNull,
    confirmedAt: isoOrNull,
  })
  .passthrough();

const videSchema = z
  .object({
    schema: z.literal(VIDE_WORKSPACE_SCHEMA),
    project_id: z.string().optional(),
    title: z.string().optional(),
    paths: z.record(z.string(), z.string()).default({}),
    server: serverSchema.nullable().optional(),
    template: z
      .object({ name: z.string(), version: z.union([z.number(), z.string()]) })
      .passthrough()
      .optional(),
    authority: z.record(z.string(), z.unknown()).optional(),
    git: gitSchema.extend({ mode: z.enum(['project-local', 'none']) }).optional(),
    vide: z
      .object({
        projectId: z.uuid(),
        createdBy: z.string().nullable().optional(),
        createdAt: z.string().nullable().optional(),
        updatedAt: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface WorkspaceServer {
  /** The connected server folder, by its real spelling (UNC when it is a share). */
  root: string;
  /** Confirmed "server folder → role": role key → path relative to `root`. */
  paths: Partial<Record<WorkspaceRole, string>>;
  /** Confirmed [서버에 반영] place per kind: role key → path relative to `root`, or null. */
  targets: Partial<Record<WorkspaceRole, string | null>>;
  checkout: { rhino: 'local'; cad: 'server' | 'local' };
  proposedAt?: string | null;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
  [key: string]: unknown;
}

export interface VideWorkspaceConfig {
  schema: typeof VIDE_WORKSPACE_SCHEMA;
  project_id?: string;
  title?: string;
  /** Role key → path relative to the work folder root; a missing key = no such role. */
  paths: Partial<Record<WorkspaceRole, string>> & Record<string, string>;
  server?: WorkspaceServer | null;
  template?: { name: string; version: number | string; [key: string]: unknown };
  authority?: Record<string, unknown>;
  git?: {
    mode: 'project-local' | 'none';
    root?: string | null;
    branch?: string | null;
    remote?: string | null;
  };
  vide?: {
    projectId: string;
    createdBy?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type WorkspaceConfig = VideWorkspaceConfig | ArchitectureWorkspaceConfig;

/** A manifest's paths by meaning: roles, review sub paths (규모검토) and paths with no role. */
export interface WorkspaceLayout {
  roles: Partial<Record<WorkspaceRole, string>>;
  reviewParts: Record<string, string>;
  otherPaths: Record<string, string>;
}

export function layoutOf(cfg: WorkspaceConfig): WorkspaceLayout {
  const roles: Partial<Record<WorkspaceRole, string>> = {};
  const reviewParts: Record<string, string> = {};
  const otherPaths: Record<string, string> = {};
  for (const [key, value] of Object.entries(cfg.paths ?? {})) {
    if (typeof value !== 'string' || !value) continue;
    if (cfg.schema === ARCHITECTURE_WORKSPACE_SCHEMA) {
      const role = ARCHITECTURE_ROLE_MAP[key];
      if (role) roles[role] = value;
      else if ((ARCHITECTURE_REVIEW_PARTS as readonly string[]).includes(key))
        reviewParts[key] = value;
      else otherPaths[key] = value;
    } else if (isWorkspaceRole(key)) roles[key] = value;
    else otherPaths[key] = value;
  }
  return { roles, reviewParts, otherPaths };
}

/** The VIDE project id a manifest names (only `vide-workspace/1` has one). */
export const manifestProjectId = (cfg: WorkspaceConfig) =>
  cfg.schema === VIDE_WORKSPACE_SCHEMA ? cfg.vide?.projectId : undefined;

const invalid = () => new DomainError('WORKSPACE_CONFIG_INVALID');

/** A manifest object (already parsed JSON) checked against the two schemas; throws INVALID. */
export function parseWorkspaceConfig(value: unknown): WorkspaceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const schema = (value as { schema?: unknown }).schema;
  const parsed =
    schema === VIDE_WORKSPACE_SCHEMA
      ? videSchema.safeParse(value)
      : schema === ARCHITECTURE_WORKSPACE_SCHEMA
        ? architectureSchema.safeParse(value)
        : null;
  if (!parsed?.success) throw invalid();
  return parsed.data as WorkspaceConfig;
}

export interface ReadOptions {
  /** The project the folder is registered to; a manifest of another project here conflicts. */
  projectId?: string;
  /** Whether a project id is a project on this PC (other than `projectId`). */
  isProject?: (projectId: string) => boolean;
}

/**
 * `<dir>/project.config.json`: null when the folder has none, the checked manifest otherwise.
 * Throws `WORKSPACE_CONFIG_INVALID` (broken JSON, unknown `schema`, wrong field types) and
 * `WORKSPACE_PROJECT_CONFLICT` (its `vide.projectId` is another project on this PC).
 */
export async function readWorkspaceConfig(
  dir: string,
  options: ReadOptions = {},
): Promise<WorkspaceConfig | null> {
  let text: string;
  try {
    text = await readFile(join(dir, WORKSPACE_CONFIG_FILE), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    // A file that cannot be read is not a broken file (an unreachable share, no permission).
    throw new DomainError('WORKSPACE_ACCESS_DENIED');
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw invalid();
  }
  const cfg = parseWorkspaceConfig(value);
  const id = manifestProjectId(cfg);
  if (id && options.projectId && id !== options.projectId && options.isProject?.(id))
    throw new DomainError('WORKSPACE_PROJECT_CONFLICT');
  return cfg;
}

/**
 * Writes a `vide-workspace/1` manifest atomically (a temporary file renamed over the old one) and
 * returns what was written: `vide.updatedAt` set to now, unknown keys kept. An
 * `architecture-workspace/1` manifest is never rewritten (`WORKSPACE_READ_ONLY`; promote it first).
 */
export async function writeWorkspaceConfig(
  dir: string,
  cfg: WorkspaceConfig,
  now = new Date(),
): Promise<VideWorkspaceConfig> {
  if (cfg.schema !== VIDE_WORKSPACE_SCHEMA) throw new DomainError('WORKSPACE_READ_ONLY');
  const next = parseWorkspaceConfig({
    ...cfg,
    ...(cfg.vide ? { vide: { ...cfg.vide, updatedAt: now.toISOString() } } : {}),
  }) as VideWorkspaceConfig;
  const file = join(dir, WORKSPACE_CONFIG_FILE);
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', 'utf8');
  try {
    // Another program reading the manifest can hold it for a moment on Windows: a few retries.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES'))
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return next;
}

/**
 * A `vide-workspace/1` manifest made from an `architecture-workspace/1` one, for when a person
 * presses [VIDE 형식으로 바꾸기]: role paths mapped, the other path keys, `authority`, `git` and
 * unknown keys kept. Pure; the caller writes it.
 */
export function promoteConfig(
  cfg: ArchitectureWorkspaceConfig,
  vide: { projectId: string; createdBy?: string | null; createdAt?: string },
): VideWorkspaceConfig {
  const { roles, reviewParts, otherPaths } = layoutOf(cfg);
  const { schema: _schema, paths: original, git, ...rest } = cfg;
  void _schema;
  // The original path keys stay (규모검토 tools reading the same file still find them); role
  // keys are added next to them.
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(original ?? {}))
    if (typeof value === 'string') kept[key] = value;
  return parseWorkspaceConfig({
    ...rest,
    schema: VIDE_WORKSPACE_SCHEMA,
    paths: { ...kept, ...otherPaths, ...reviewParts, ...roles },
    ...(git ? { git: { ...git, mode: git.mode === 'none' ? 'none' : 'project-local' } } : {}),
    vide: {
      projectId: vide.projectId,
      createdBy: vide.createdBy ?? null,
      createdAt: vide.createdAt ?? new Date().toISOString(),
    },
  }) as VideWorkspaceConfig;
}

// ---------------------------------------------------------------------------------------------
// Paths

/**
 * The real spelling of a Windows path (links, junctions, mapped and subst drives resolved through
 * its deepest existing folder; the rest kept as written). Same rule as `project-path.ts` realPath.
 */
export function realPathOf(path: string): string {
  const full = win32.resolve(path);
  const tail: string[] = [];
  let head = full;
  for (;;) {
    try {
      return win32.join(realpathSync.native(head), ...tail);
    } catch {
      const up = win32.dirname(head);
      if (up === head) return full;
      tail.unshift(win32.basename(head));
      head = up;
    }
  }
}

const trimmed = (path: string) => pathKey(path).replace(/\\+$/, '');
/** `path` is `folder` or inside it, as written (Windows path keys, no file access). */
const atOrUnder = (folder: string, path: string) => {
  const base = trimmed(folder);
  const key = trimmed(path);
  return key === base || key.startsWith(base + '\\');
};

/**
 * Whether `path` (absolute, or relative to `root`) stays inside the work folder `root`: as written
 * and by its real path, so a junction or link inside the folder that leads elsewhere is outside.
 */
export function insideWorkspace(root: string, path: string): boolean {
  const written = win32.resolve(root, path);
  if (!atOrUnder(root, written)) return false;
  const real = realPathOf(written);
  return atOrUnder(root, real) || atOrUnder(realPathOf(root), real);
}

/**
 * The absolute path of `role` in the work folder at `root`, or null when the manifest has no such
 * role. Throws `OUTSIDE_WORKSPACE` when the role path leaves the root (`..`, another drive, a
 * junction to elsewhere).
 */
export function resolveRolePath(
  root: string,
  cfg: WorkspaceConfig,
  role: WorkspaceRole,
): string | null {
  const relative = layoutOf(cfg).roles[role];
  if (!relative) return null;
  if (!insideWorkspace(root, relative)) throw new DomainError('OUTSIDE_WORKSPACE');
  return win32.resolve(root, relative);
}

// ---------------------------------------------------------------------------------------------
// Server memory

export interface ServerMemoryPatch {
  root?: string;
  /** Role → server path; null forgets the role. */
  paths?: Partial<Record<WorkspaceRole, string | null>>;
  /** Role → reflect target; null is remembered as "no place for this kind"; undefined leaves it. */
  targets?: Partial<Record<WorkspaceRole, string | null>>;
  checkout?: { cad?: 'server' | 'local' };
  proposedAt?: string | null;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
}

/**
 * `cfg` with its server memory changed (pure; the caller writes it). Only confirmed values belong
 * here (SPEC-01.13 8). Server paths must be relative to the server root; bad ones are
 * `INVALID_INPUT`, a server memory without a root is `INVALID_INPUT`, and an
 * `architecture-workspace/1` manifest is `WORKSPACE_READ_ONLY`.
 */
export function updateServerMemory(
  cfg: WorkspaceConfig,
  patch: ServerMemoryPatch,
): VideWorkspaceConfig {
  if (cfg.schema !== VIDE_WORKSPACE_SCHEMA) throw new DomainError('WORKSPACE_READ_ONLY');
  const before = cfg.server ?? null;
  const root = patch.root ?? before?.root;
  if (!root || !(win32.isAbsolute(root) || root.startsWith('\\\\')))
    throw new DomainError('INVALID_INPUT');
  const paths: Partial<Record<WorkspaceRole, string>> = { ...(before?.paths ?? {}) };
  for (const [role, value] of Object.entries(patch.paths ?? {})) {
    if (!isWorkspaceRole(role) || value === undefined) throw new DomainError('INVALID_INPUT');
    if (value === null) delete paths[role];
    else if (safeRelativeFolder(value)) paths[role] = value;
    else throw new DomainError('INVALID_INPUT');
  }
  const targets: Partial<Record<WorkspaceRole, string | null>> = { ...(before?.targets ?? {}) };
  for (const [role, value] of Object.entries(patch.targets ?? {})) {
    if (!isWorkspaceRole(role)) throw new DomainError('INVALID_INPUT');
    if (value === undefined) continue;
    if (value !== null && !safeRelativeFolder(value)) throw new DomainError('INVALID_INPUT');
    targets[role] = value;
  }
  const server: WorkspaceServer = {
    ...(before ?? {}),
    root,
    paths,
    targets,
    checkout: { rhino: 'local', cad: patch.checkout?.cad ?? before?.checkout?.cad ?? 'server' },
  };
  for (const key of ['proposedAt', 'confirmedBy', 'confirmedAt'] as const)
    if (patch[key] !== undefined) server[key] = patch[key];
  return { ...cfg, server };
}

// ---------------------------------------------------------------------------------------------
// Finding a project's work folder

export interface FoundWorkspace {
  root: string;
  cfg: WorkspaceConfig;
  /** False when the manifest names no VIDE project or another one (the first config was taken). */
  matched: boolean;
}

/**
 * The project's work folder among its folders: the first `project` folder whose manifest's
 * `vide.projectId` is `projectId`; else the first `project` folder with any readable manifest
 * (`matched: false`); else null. A folder with a broken manifest or one of another project here
 * is skipped, and its error is thrown only when no folder had a usable manifest.
 */
export async function findWorkspaceRoot(
  folders: readonly (ProjectFolder | string)[],
  projectId: string,
  options: Pick<ReadOptions, 'isProject'> = {},
): Promise<FoundWorkspace | null> {
  let fallback: FoundWorkspace | null = null;
  let failure: unknown = null;
  for (const folder of folders) {
    if (typeof folder !== 'string' && folder.kind !== 'project') continue;
    const root = typeof folder === 'string' ? folder : folder.path;
    let cfg: WorkspaceConfig | null;
    try {
      cfg = await readWorkspaceConfig(root, { projectId, isProject: options.isProject });
    } catch (error) {
      // An unreadable folder is skipped like one with no manifest; broken files are reported.
      if ((error as DomainError).code !== 'WORKSPACE_ACCESS_DENIED') failure ??= error;
      continue;
    }
    if (!cfg) continue;
    if (manifestProjectId(cfg) === projectId) return { root, cfg, matched: true };
    fallback ??= { root, cfg, matched: false };
  }
  if (fallback) return fallback;
  if (failure) throw failure;
  return null;
}

export interface Workspace extends FoundWorkspace {
  schema: WorkspaceConfig['schema'];
  /** `architecture-workspace/1` manifests are not rewritten. */
  readOnly: boolean;
  /** Role → absolute path, only roles the manifest has and that stay inside the root. */
  paths: Partial<Record<WorkspaceRole, string>>;
  /** 규모검토 sub paths of the review role, absolute (same rule). */
  reviewParts: Record<string, string>;
  /** Manifest path keys refused because they leave the root. */
  outside: string[];
}

/**
 * The work folder of a project, for the stages that write into it (outputs, checkout, file map,
 * CLI): `{root, cfg, paths, …}` or null when none of its project folders has a manifest. Throws
 * like `findWorkspaceRoot`.
 */
export async function workspaceOf(
  folders: { list(projectId: string): ProjectFolder[] },
  projectId: string,
  options: Pick<ReadOptions, 'isProject'> = {},
): Promise<Workspace | null> {
  const found = await findWorkspaceRoot(folders.list(projectId), projectId, options);
  if (!found) return null;
  const { root, cfg } = found;
  const layout = layoutOf(cfg);
  const paths: Partial<Record<WorkspaceRole, string>> = {};
  const reviewParts: Record<string, string> = {};
  const outside: string[] = [];
  for (const role of WORKSPACE_ROLES) {
    const relative = layout.roles[role];
    if (!relative) continue;
    if (insideWorkspace(root, relative)) paths[role] = win32.resolve(root, relative);
    else outside.push(role);
  }
  for (const [key, relative] of Object.entries(layout.reviewParts)) {
    if (insideWorkspace(root, relative)) reviewParts[key] = win32.resolve(root, relative);
    else outside.push(key);
  }
  return {
    ...found,
    schema: cfg.schema,
    readOnly: cfg.schema !== VIDE_WORKSPACE_SCHEMA,
    paths,
    reviewParts,
    outside,
  };
}
