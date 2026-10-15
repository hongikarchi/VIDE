// The work folder the `vide` CLI stands in (SPEC-01.13 10): the nearest `project.config.json` at or
// above the current folder, its role paths (offline), and where an export goes in the tree
// (ARCH-01 「작업 폴더(PLAN-52)」 산출물 경로). Every write target is checked with insideWorkspace.
import {
  dayOf,
  jigFolderName,
  minuteOf,
  runFolderName,
  safeName,
} from '../core/workspace-paths.ts';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { DomainError } from '../contracts/errors.ts';
import {
  insideWorkspace,
  layoutOf,
  manifestProjectId,
  readWorkspaceConfig,
  resolveRolePath,
  type WorkspaceConfig,
} from '../core/workspace-config.ts';
import { WORKSPACE_ROLES, isWorkspaceRole } from '../core/workspace-template.ts';

export interface LocalWorkspace {
  root: string;
  cfg: WorkspaceConfig;
  /** `vide.projectId` of a `vide-workspace/1` manifest; undefined for 규모검토 folders. */
  projectId?: string;
}

/** Walks up from `cwd` to the first folder with a manifest; `NO_WORKSPACE` when none. */
export async function findLocalWorkspace(cwd: string): Promise<LocalWorkspace> {
  let dir = win32.resolve(cwd);
  for (;;) {
    const cfg = await readWorkspaceConfig(dir);
    if (cfg) {
      const projectId = manifestProjectId(cfg);
      return { root: dir, cfg, ...(projectId ? { projectId } : {}) };
    }
    const up = win32.dirname(dir);
    if (up === dir) throw new DomainError('NO_WORKSPACE');
    dir = up;
  }
}

export interface RoleEntry {
  role: string;
  /** Absolute path, null when the manifest has no such role. */
  path: string | null;
  /** Refused because it leaves the work folder. */
  outside?: boolean;
}

/** Every role (and 규모검토 review part) with its absolute path; nothing is read from disk. */
export function roleEntries(ws: LocalWorkspace): RoleEntry[] {
  const out: RoleEntry[] = [];
  for (const role of WORKSPACE_ROLES) {
    try {
      out.push({ role, path: resolveRolePath(ws.root, ws.cfg, role) });
    } catch {
      out.push({ role, path: null, outside: true });
    }
  }
  for (const [part, relative] of Object.entries(layoutOf(ws.cfg).reviewParts)) {
    const inside = insideWorkspace(ws.root, relative);
    out.push({
      role: part,
      path: inside ? win32.resolve(ws.root, relative) : null,
      ...(inside ? {} : { outside: true }),
    });
  }
  return out;
}

/** One role's absolute path: `WORKSPACE_ROLE_MISSING` when the manifest has none. */
export function rolePath(ws: LocalWorkspace, role: string): string {
  const entry = roleEntries(ws).find((e) => e.role === role);
  if (!entry) throw new DomainError(isWorkspaceRole(role) ? 'WORKSPACE_ROLE_MISSING' : 'NO_ROLE');
  if (entry.outside) throw new DomainError('OUTSIDE_WORKSPACE');
  if (!entry.path) throw new DomainError('WORKSPACE_ROLE_MISSING');
  return entry.path;
}

export interface Listing {
  exists: boolean;
  entries: { name: string; kind: 'folder' | 'file' }[];
}

/** The top level of a folder: folders first, then files, each by name. */
export async function listFolder(path: string): Promise<Listing> {
  try {
    if (!(await stat(path)).isDirectory()) return { exists: false, entries: [] };
  } catch {
    return { exists: false, entries: [] };
  }
  const dirents = await readdir(path, { withFileTypes: true });
  const entries = dirents
    .map((d) => ({ name: d.name, kind: d.isDirectory() ? ('folder' as const) : ('file' as const) }))
    .sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name, 'ko') : a.kind === 'folder' ? -1 : 1,
    );
  return { exists: true, entries };
}

// --- export paths ------------------------------------------------------------------------------

// Names follow the engine's copies (src/core/workspace-paths.ts): one jig result, one folder.
export { safeName } from '../core/workspace-paths.ts';
/** `YYYY-MM-DD` in this PC's local time. */
export const localDate = dayOf;
/** `YYYY-MM-DD-HHmm` in this PC's local time. */
export const localStamp = minuteOf;

/**
 * The folder of a jig result in the review role: `<review>/<jig 마지막 마디>/<YYYY-MM-DD-HHmm>-<id 앞
 * 8자리>` — the same name the engine's copy uses (`project/example-grid` → `example-grid`).
 */
export function reviewFolder(review: string, jigId: string, at: Date, instanceId: string) {
  return win32.join(review, jigFolderName(jigId), runFolderName(at, instanceId));
}

/** A report for others in the output role: `<output>/<YYYY-MM-DD>-<제목>` (ARCH-01). */
export function outputFolder(output: string, title: string, at: Date) {
  return win32.join(output, `${localDate(at)}-${safeName(title, '보고서')}`);
}

/**
 * Makes `folder` (or `folder-2`, `-3`, … when the name is taken) inside the work folder `root`.
 * `OUTSIDE_WORKSPACE` and nothing written when it would leave the tree.
 */
export async function makeOutputFolder(root: string, folder: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? folder : `${folder}-${n}`;
    if (!insideWorkspace(root, candidate)) throw new DomainError('OUTSIDE_WORKSPACE');
    try {
      await stat(candidate);
      continue;
    } catch {
      /* free name */
    }
    await mkdir(win32.dirname(candidate), { recursive: true });
    // The parent may have been a junction made meanwhile; check once more before the folder.
    if (!insideWorkspace(root, candidate)) throw new DomainError('OUTSIDE_WORKSPACE');
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new DomainError('EXPORT_FOLDER_TAKEN');
}
