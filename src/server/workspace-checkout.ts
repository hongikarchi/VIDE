// 체크아웃 · 서버에 반영 · 작업 중 · 도면 보호 (SPEC-01.13 9, ARCH-01 「작업 폴더(PLAN-52)」, PLAN-52
// T-310~T-312, Design SCR-37). A model file of the connected (server) folder is never edited where it
// is: [체크아웃] copies it into the work folder's model role folder and records who has it; only a
// person's [서버에 반영] writes the server, after the previous server version is copied to the
// archive role folder. Drawings stay on the server by default (external references keep working)
// and are copied to the archive once a day before the first AI edit; the work folder's server
// memory `checkout.cad = "local"` gives drawings the same checkout instead.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat, chmod } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { win32 } from 'node:path';
import { DomainError } from '../contracts/errors.ts';
import type { ProjectFolder } from '../core/project-folders.ts';
import { Checkouts, type CheckoutRole, type CheckoutRow } from '../core/checkouts.ts';
import {
  insideWorkspace,
  realPathOf,
  updateServerMemory,
  VIDE_WORKSPACE_SCHEMA,
  workspaceOf,
  writeWorkspaceConfig,
  type VideWorkspaceConfig,
  type Workspace,
  type WorkspaceServer,
} from '../core/workspace-config.ts';
import { safeRelativeFolder } from '../core/workspace-template.ts';
import { pathKey } from '../core/xref-graph.ts';

export const CHECKOUT_ROLES: readonly CheckoutRole[] = ['rhino', 'cad'];
const EXTENSIONS: Record<CheckoutRole, string> = { rhino: '.3dm', cad: '.dwg' };
/** Server files listed per role (two levels under the role folder, like the structure read). */
const MAX_FILES = 200;
const SITE_TIMEOUT_MS = 3000;

export const checkoutStatuses: Record<string, number> = {
  SERVER_FILE_LOCKED: 409,
  SERVER_ACCESS_DENIED: 403,
  SERVER_CHANGED_SINCE_CHECKOUT: 409,
  SERVER_UNREACHABLE: 503,
  SERVER_WRITE_UNVERIFIED: 502,
  NEEDS_TARGET: 409,
  CHECKED_OUT_ELSEWHERE: 409,
  LOCAL_COPY_EXISTS: 409,
  LOCAL_COPY_MISSING: 409,
  CHECKOUT_RELEASED: 409,
  CAD_SERVER_DIRECT: 409,
  NOT_A_SERVER_FILE: 400,
  WORKSPACE_ROLE_MISSING: 409,
  NO_SERVER_MEMORY: 404,
};

/** A refusal with what the screen needs to show it (the holder, the server version, a suggestion). */
export class CheckoutRefusal extends DomainError {
  details: Record<string, unknown>;
  constructor(code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.details = details;
  }
}

/** A checkout another PC put on the account site (`project_checkouts`, 0016). */
export interface SiteCheckout {
  fileKey: string;
  role: string;
  serverPath: string;
  userName: string;
  checkedOutAt: string;
  /** This PC's own row. */
  mine: boolean;
}
export interface Holder {
  user: string;
  at: string;
  /** '이 PC' / '다른 PC'. */
  here: boolean;
}
export interface ObjectChanges {
  added: number;
  modified: number;
  removed: number;
}

export interface CheckoutOptions {
  folders: { list(projectId: string): ProjectFolder[] };
  isProject?: (projectId: string) => boolean;
  checkouts: Checkouts;
  /** This PC (the checkout row's `pc_id`); the computer name when absent. */
  pcId?: () => string;
  /** Who takes the file (the VIDE account name, else the Windows user name). */
  actor?: () => string | null | undefined;
  /** Other PCs' checkouts from the account site; null when the site cannot be asked. */
  site?: (projectId: string) => Promise<SiteCheckout[] | null>;
  /** Objects changed in the local copy since `since` by applied requests (SPEC-02.13). */
  changes?: (projectId: string, localPath: string, since: string) => ObjectChanges | null;
  /** Sync mismatches of the local copy against its drawing pair, null when no baseline exists. */
  syncMismatch?: (projectId: string, localPath: string) => number | null;
  /** Something about the project's checkouts changed (the site copy goes up). */
  onChange?: (projectId: string) => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
  now?: () => Date;
}

// ---------------------------------------------------------------------------------------------
// Paths and file facts

const trimmed = (path: string) => pathKey(win32.resolve(path)).replace(/\\+$/, '');
/** `path` is `folder` or inside it (Windows keys, as written). */
export const atOrUnder = (folder: string, path: string) => {
  const base = trimmed(folder);
  const key = trimmed(path);
  return key === base || key.startsWith(base + '\\');
};
const realOf = (path: string) => {
  try {
    return realPathOf(path);
  } catch {
    return win32.resolve(path);
  }
};
/** The file key shared with the site: the server file's real path without case. */
export const fileKey = (serverPath: string) => trimmed(serverPath);
const pad = (n: number) => String(n).padStart(2, '0');
export const localDay = (at: Date) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
export const localMinute = (at: Date) =>
  `${localDay(at)}-${pad(at.getHours())}${pad(at.getMinutes())}`;

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

/** A server-side file failure as one of the codes the screen explains (ARCH-01). */
export function serverFailure(error: unknown, writing = false): string {
  const code = (error as { code?: string } | null)?.code ?? '';
  if (code === 'EBUSY' || code === 'ELOCKED' || code === 'ETXTBSY') return 'SERVER_FILE_LOCKED';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return writing ? 'SERVER_FILE_LOCKED' : 'SERVER_ACCESS_DENIED';
  return 'SERVER_UNREACHABLE';
}
const deniedOrGone = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code ?? '';
  return code === 'EACCES' || code === 'EPERM' ? 'SERVER_ACCESS_DENIED' : 'SERVER_UNREACHABLE';
};

/** `<folder>` or `<folder>-2`, `-3` … — the first that does not exist yet. */
/** A local write target that stays in the work folder (junctions included), or OUTSIDE_WORKSPACE. */
function local(root: string, path: string) {
  if (!insideWorkspace(root, path)) throw new DomainError('OUTSIDE_WORKSPACE');
  return path;
}

/**
 * The project folder `folder` holds `path`: compared as written and by real spelling, so a drawing
 * opened through a mapped drive matches the UNC folder kept for the project (SPEC-01.13 1).
 */
export function folderHolds(folder: string, path: string) {
  if (atOrUnder(folder, path)) return true;
  const real = realOf(path);
  return atOrUnder(folder, real) || atOrUnder(realOf(folder), real);
}

async function freeFolder(folder: string) {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? folder : `${folder}-${n}`;
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The service

export interface ServerFileRow {
  /** Absolute server path (real spelling). */
  path: string;
  /** Relative to the remembered server folder. */
  relative: string;
  name: string;
  size: number;
  /** The server version's time (mtime, ISO). */
  serverAt: string;
  /** This PC's open checkout of the file, with the local copy. */
  mine: (CheckoutRow & { changed: ObjectChanges | null; localExists: boolean }) | null;
  /** Others who have it (the account site's rows of other PCs). */
  others: Holder[];
  /** Drawing kept on the server: today's archive copy before the first AI edit. */
  backup?: { at: string; path: string } | null;
}
export interface ServerRoleFiles {
  role: CheckoutRole;
  /** 'local' = checkout; 'server' = opened where it is (drawings by default). */
  mode: 'local' | 'server';
  folder: string;
  status: 'ok' | 'empty' | 'no-access' | 'unreachable';
  files: ServerFileRow[];
  truncated?: boolean;
}

export class WorkspaceCheckouts {
  private readonly options: CheckoutOptions;
  constructor(options: CheckoutOptions) {
    this.options = options;
  }
  private get now() {
    return this.options.now?.() ?? new Date();
  }
  private pcId() {
    return this.options.pcId?.() || hostname() || 'pc';
  }
  private actor() {
    try {
      return this.options.actor?.() || userInfo().username || '사용자';
    } catch {
      return '사용자';
    }
  }
  private changed(projectId: string) {
    try {
      this.options.onChange?.(projectId);
    } catch {
      /* the site copy follows on the next heartbeat */
    }
  }
  private async workspace(projectId: string): Promise<Workspace> {
    const ws = await workspaceOf(this.options.folders, projectId, {
      isProject: this.options.isProject,
    });
    if (!ws) throw new DomainError('NO_WORKSPACE');
    return ws;
  }
  private memory(ws: Workspace): WorkspaceServer | null {
    return ws.cfg.schema === VIDE_WORKSPACE_SCHEMA
      ? ((ws.cfg as VideWorkspaceConfig).server ?? null)
      : null;
  }
  /** Connected folders: the project's `project` folders outside the work folder. */
  private connected(projectId: string, ws: Workspace) {
    return this.options.folders
      .list(projectId)
      .filter((folder) => folder.kind === 'project' && !atOrUnder(ws.root, folder.path))
      .map((folder) => folder.path);
  }
  private async siteRows(projectId: string): Promise<SiteCheckout[] | null> {
    if (!this.options.site) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.options.site(projectId),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), SITE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  /** Who else has the server file: this PC's table rows of another PC, then the site's. */
  private holders(projectId: string, serverPath: string, site: SiteCheckout[] | null) {
    const key = fileKey(serverPath);
    const pc = this.pcId();
    const local = this.options.checkouts
      .active(projectId)
      .filter((row) => fileKey(row.serverPath) === key && row.pcId !== pc)
      .map((row) => ({ user: row.userId, at: row.checkedOutAt, here: false }));
    const remote = (site ?? [])
      .filter((row) => !row.mine && row.fileKey === key)
      .map((row) => ({ user: row.userName, at: row.checkedOutAt, here: false }));
    return [...local, ...remote];
  }
  private mineFor(projectId: string, serverPath: string) {
    const key = fileKey(serverPath);
    const pc = this.pcId();
    return (
      this.options.checkouts
        .active(projectId)
        .find((row) => fileKey(row.serverPath) === key && row.pcId === pc) ?? null
    );
  }
  private changesOf(projectId: string, row: CheckoutRow) {
    try {
      return this.options.changes?.(projectId, row.localPath, row.checkedOutAt) ?? null;
    } catch {
      return null;
    }
  }

  /** Today's archive copy of a drawing kept on the server, if one was made. */
  private async backupOf(ws: Workspace, serverRoot: string, serverPath: string) {
    const archive = ws.paths.archive;
    if (!archive) return null;
    const path = win32.join(
      archive,
      '서버백업',
      localDay(this.now),
      win32.relative(serverRoot, serverPath),
    );
    try {
      const info = await stat(path);
      return { at: info.mtime.toISOString(), path };
    } catch {
      return null;
    }
  }

  /**
   * The model and drawing files of the remembered server folders (Design SCR-37 서버 파일): each
   * with its server version time, this PC's checkout and local copy, others who have it, and for
   * drawings opened on the server today's backup. Null when the project has no server memory.
   */
  async serverFiles(projectId: string, only?: CheckoutRole) {
    const ws = await this.workspace(projectId);
    const server = this.memory(ws);
    if (!server?.root) return { workspaceRoot: ws.root, server: null, roles: [] };
    const site = await this.siteRows(projectId);
    const roles: ServerRoleFiles[] = [];
    for (const role of CHECKOUT_ROLES) {
      if (only && only !== role) continue;
      const relative = server.paths[role];
      if (!relative) continue;
      const folder = win32.resolve(server.root, relative);
      const mode = role === 'rhino' || server.checkout?.cad === 'local' ? 'local' : 'server';
      const found: { path: string; size: number; mtime: Date }[] = [];
      let status: ServerRoleFiles['status'] = 'ok';
      let truncated = false;
      const walk = async (dir: string, depth: number) => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (found.length >= MAX_FILES) {
            truncated = true;
            return;
          }
          const path = win32.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (depth < 2 && !entry.name.startsWith('.'))
              await walk(path, depth + 1).catch(() => undefined);
          } else if (
            entry.isFile() &&
            win32.extname(entry.name).toLowerCase() === EXTENSIONS[role]
          ) {
            try {
              const info = await stat(path);
              found.push({ path, size: info.size, mtime: info.mtime });
            } catch {
              /* gone while listing */
            }
          }
        }
      };
      try {
        await walk(folder, 1);
        if (!found.length) status = 'empty';
      } catch (error) {
        status = deniedOrGone(error) === 'SERVER_ACCESS_DENIED' ? 'no-access' : 'unreachable';
      }
      found.sort((a, b) => a.path.localeCompare(b.path, 'ko'));
      const files: ServerFileRow[] = [];
      for (const file of found) {
        const mine = this.mineFor(projectId, file.path);
        let localExists = false;
        if (mine)
          try {
            await stat(mine.localPath);
            localExists = true;
          } catch {
            /* the local copy was moved or deleted */
          }
        files.push({
          path: file.path,
          relative: win32.relative(server.root, file.path),
          name: win32.basename(file.path),
          size: file.size,
          serverAt: file.mtime.toISOString(),
          mine: mine ? { ...mine, changed: this.changesOf(projectId, mine), localExists } : null,
          others: this.holders(projectId, file.path, site),
          ...(mode === 'server' ? { backup: await this.backupOf(ws, server.root, file.path) } : {}),
        });
      }
      roles.push({ role, mode, folder, status, files, ...(truncated ? { truncated } : {}) });
    }
    return {
      workspaceRoot: ws.root,
      server: { root: server.root, targets: server.targets ?? {} },
      siteChecked: site !== null,
      roles,
    };
  }

  /** The server root a checked-out path belongs to: the remembered folder, else a connected one. */
  private serverRootOf(projectId: string, ws: Workspace, path: string) {
    const server = this.memory(ws);
    if (server?.root && atOrUnder(server.root, path)) return server.root;
    const hit = this.connected(projectId, ws).find(
      (folder) => atOrUnder(folder, path) || atOrUnder(realOf(folder), path),
    );
    if (!hit) throw new DomainError('NOT_A_SERVER_FILE');
    return atOrUnder(hit, path) ? hit : realOf(hit);
  }
  private roleOf(ws: Workspace, serverRoot: string, path: string): CheckoutRole {
    const server = this.memory(ws);
    for (const role of CHECKOUT_ROLES) {
      const relative = server?.paths[role];
      if (relative && atOrUnder(win32.resolve(serverRoot, relative), path)) return role;
    }
    const extension = win32.extname(path).toLowerCase();
    if (extension === EXTENSIONS.rhino) return 'rhino';
    if (extension === EXTENSIONS.cad) return 'cad';
    throw new DomainError('NOT_A_SERVER_FILE');
  }

  /**
   * [체크아웃]: the server file is copied to `<role folder>/<name>` and recorded as 작업 중. Taking
   * it again on this PC answers the open checkout. When another PC has it, only `readOnly` copies
   * (`<name> (읽기 전용).3dm`, read-only attribute, not recorded). A local file of the same name is
   * replaced only with `overwrite`.
   */
  async checkout(
    projectId: string,
    input: { serverPath: string; overwrite?: boolean; readOnly?: boolean },
  ) {
    if (typeof input.serverPath !== 'string' || !win32.isAbsolute(input.serverPath))
      throw new DomainError('INVALID_INPUT');
    const ws = await this.workspace(projectId);
    const serverPath = realOf(input.serverPath);
    const serverRoot = this.serverRootOf(projectId, ws, serverPath);
    const role = this.roleOf(ws, serverRoot, serverPath);
    if (win32.extname(serverPath).toLowerCase() !== EXTENSIONS[role])
      throw new DomainError('NOT_A_SERVER_FILE');
    if (role === 'cad' && this.memory(ws)?.checkout?.cad !== 'local')
      throw new DomainError('CAD_SERVER_DIRECT');
    const folder = ws.paths[role];
    if (!folder) throw new CheckoutRefusal('WORKSPACE_ROLE_MISSING', { role });
    let info;
    try {
      info = await stat(serverPath);
    } catch (error) {
      const code = deniedOrGone(error);
      throw new CheckoutRefusal(code === 'SERVER_UNREACHABLE' ? 'SERVER_UNREACHABLE' : code);
    }
    if (!info.isFile()) throw new DomainError('NOT_A_SERVER_FILE');
    const existing = this.mineFor(projectId, serverPath);
    if (existing && !input.readOnly) return { checkout: existing, existing: true, readOnly: false };
    const holders = this.holders(projectId, serverPath, await this.siteRows(projectId));
    const name = win32.basename(serverPath);
    if (input.readOnly) {
      const ext = win32.extname(name);
      const target = local(
        ws.root,
        win32.join(folder, `${name.slice(0, -ext.length)} (읽기 전용)${ext}`),
      );
      await mkdir(folder, { recursive: true });
      local(ws.root, folder);
      await chmod(target, 0o666).catch(() => undefined);
      await this.copyIn(serverPath, target);
      await chmod(target, 0o444).catch(() => undefined);
      return { checkout: null, existing: false, readOnly: true, localPath: target, holders };
    }
    if (holders.length) throw new CheckoutRefusal('CHECKED_OUT_ELSEWHERE', { holders });
    const localPath = local(ws.root, win32.join(folder, name));
    let exists = false;
    try {
      await stat(localPath);
      exists = true;
    } catch {
      /* free */
    }
    if (exists && !input.overwrite) throw new CheckoutRefusal('LOCAL_COPY_EXISTS', { localPath });
    await mkdir(folder, { recursive: true });
    local(ws.root, folder);
    if (exists) await chmod(localPath, 0o666).catch(() => undefined);
    const hash = await this.copyIn(serverPath, localPath);
    const row = this.options.checkouts.add(projectId, {
      id: randomUUID(),
      role,
      serverPath,
      localPath,
      pcId: this.pcId(),
      userId: this.actor(),
      checkedOutAt: this.now.toISOString(),
      serverMtime: info.mtime.toISOString(),
      serverHash: hash,
    });
    this.changed(projectId);
    return { checkout: row, existing: false, readOnly: false };
  }
  /** Copies a server file in through a temporary name; its SHA-256. */
  private async copyIn(serverPath: string, localPath: string) {
    const temporary = `${localPath}.${randomUUID().slice(0, 8)}.vide-tmp`;
    try {
      await copyFile(serverPath, temporary);
      const hash = await sha256Of(temporary);
      await rename(temporary, localPath);
      return hash;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      const code = (error as { code?: string }).code;
      if (code === 'EBUSY') throw new CheckoutRefusal('SERVER_FILE_LOCKED');
      throw new CheckoutRefusal(deniedOrGone(error));
    }
  }

  /** [체크아웃 풀기]: no longer 작업 중; the local copy stays where it is. */
  release(projectId: string, checkoutId: string) {
    const row = this.options.checkouts.get(projectId, checkoutId);
    if (!row) throw new DomainError('NOT_FOUND');
    if (row.releasedAt) return { checkout: row };
    const released = this.options.checkouts.release(projectId, checkoutId, this.now.toISOString());
    this.changed(projectId);
    return { checkout: released };
  }

  private open(projectId: string, checkoutId: string) {
    const row = this.options.checkouts.get(projectId, checkoutId);
    if (!row) throw new DomainError('NOT_FOUND');
    if (row.releasedAt) throw new DomainError('CHECKOUT_RELEASED');
    return row;
  }
  /** Where [서버에 반영] writes: the remembered target folder for the role, or null. */
  private rememberedTarget(ws: Workspace, role: CheckoutRole) {
    const target = this.memory(ws)?.targets?.[role];
    return typeof target === 'string' ? target : null;
  }

  /**
   * The [서버에 반영] summary (SCR-37): objects changed since the checkout, Sync mismatches, the
   * server version now against the one taken, and where it would go.
   */
  async publishSummary(projectId: string, checkoutId: string) {
    const row = this.open(projectId, checkoutId);
    const ws = await this.workspace(projectId);
    const serverRoot = this.serverRootOf(projectId, ws, row.serverPath);
    let server: { at: string; hash: string } | null = null;
    let reason: string | undefined;
    try {
      const info = await stat(row.serverPath);
      server = { at: info.mtime.toISOString(), hash: await sha256Of(row.serverPath) };
    } catch (error) {
      reason =
        (error as { code?: string }).code === 'ENOENT' ? 'SERVER_FILE_GONE' : deniedOrGone(error);
    }
    let syncMismatch: number | null = null;
    try {
      syncMismatch = this.options.syncMismatch?.(projectId, row.localPath) ?? null;
    } catch {
      syncMismatch = null;
    }
    const target = this.rememberedTarget(ws, row.role);
    return {
      checkout: row,
      changed: this.changesOf(projectId, row),
      syncMismatch,
      server: server
        ? { ...server, changedSinceCheckout: server.hash !== row.serverHash }
        : { at: null, hash: null, changedSinceCheckout: false, error: reason },
      serverRoot,
      target,
      remembered: target !== null,
      /** The folder the file came from, relative to the server folder (a first answer). */
      suggestion: win32.dirname(win32.relative(serverRoot, row.serverPath)).replace(/^\.$/, ''),
      archive: ws.paths.archive ?? null,
    };
  }

  /**
   * [서버에 반영]: the local copy replaces the server file in the target folder (the remembered
   * one, or `target`, which is then remembered). The previous server version is first copied to
   * `<archive>/서버반영/<YYYY-MM-DD-HHmm>/<server relative path>`. A server file changed since the
   * checkout is not overwritten unless `seenServerHash` names the version the person saw. Nothing
   * on the server changes before the copy: a failure leaves it as it was.
   */
  async publish(
    projectId: string,
    input: { checkoutId: string; target?: string; keepCheckout?: boolean; seenServerHash?: string },
  ) {
    const row = this.open(projectId, input.checkoutId);
    const ws = await this.workspace(projectId);
    const serverRoot = this.serverRootOf(projectId, ws, row.serverPath);
    // Where it goes.
    let target = this.rememberedTarget(ws, row.role);
    let remember = false;
    if (typeof input.target === 'string' && input.target.trim()) {
      let value = input.target.trim().replace(/\//g, '\\').replace(/\\+$/, '');
      if (win32.isAbsolute(value)) {
        if (!atOrUnder(serverRoot, value)) throw new DomainError('OUTSIDE_WORKSPACE');
        value = win32.relative(serverRoot, value);
      }
      if (value !== '' && !safeRelativeFolder(value)) throw new DomainError('INVALID_INPUT');
      remember = value !== target;
      target = value;
    }
    if (target === null)
      throw new CheckoutRefusal('NEEDS_TARGET', {
        role: row.role,
        suggestion: win32.dirname(win32.relative(serverRoot, row.serverPath)).replace(/^\.$/, ''),
      });
    const destination = win32.join(serverRoot, target, win32.basename(row.serverPath));
    if (!atOrUnder(serverRoot, destination)) throw new DomainError('OUTSIDE_WORKSPACE');
    const archiveRoot = ws.paths.archive;
    if (!archiveRoot) throw new CheckoutRefusal('WORKSPACE_ROLE_MISSING', { role: 'archive' });
    // The local copy.
    let localHash: string;
    try {
      localHash = await sha256Of(row.localPath);
    } catch {
      throw new CheckoutRefusal('LOCAL_COPY_MISSING', { localPath: row.localPath });
    }
    // The server version now.
    let current: { hash: string; mtime: Date } | null = null;
    try {
      const info = await stat(destination);
      current = { hash: await sha256Of(destination), mtime: info.mtime };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'ENOENT') throw new CheckoutRefusal(deniedOrGone(error));
      // A missing target folder on an unreachable share is told apart from a new file.
      try {
        await stat(win32.dirname(destination));
      } catch (folderError) {
        const folderCode = (folderError as { code?: string }).code;
        if (folderCode !== 'ENOENT') throw new CheckoutRefusal(deniedOrGone(folderError));
        try {
          await stat(serverRoot);
        } catch (rootError) {
          throw new CheckoutRefusal(deniedOrGone(rootError));
        }
      }
    }
    if (
      current &&
      fileKey(destination) === fileKey(row.serverPath) &&
      current.hash !== row.serverHash &&
      input.seenServerHash !== current.hash
    )
      throw new CheckoutRefusal('SERVER_CHANGED_SINCE_CHECKOUT', {
        server: { at: current.mtime.toISOString(), hash: current.hash },
        checkedOutAt: row.checkedOutAt,
      });
    // Keep the previous server version, then write.
    const at = this.now;
    let archived: string | null = null;
    if (current) {
      const folder = await freeFolder(win32.join(archiveRoot, '서버반영', localMinute(at)));
      archived = local(ws.root, win32.join(folder, win32.relative(serverRoot, destination)));
      await mkdir(win32.dirname(archived), { recursive: true });
      local(ws.root, archived);
      try {
        await copyFile(destination, archived);
      } catch (error) {
        await rm(folder, { recursive: true, force: true }).catch(() => undefined);
        throw new CheckoutRefusal(serverFailure(error));
      }
    }
    const temporary = win32.join(
      win32.dirname(destination),
      `.${win32.basename(destination)}.${randomUUID().slice(0, 8)}.vide-tmp`,
    );
    try {
      await mkdir(win32.dirname(destination), { recursive: true });
      await copyFile(row.localPath, temporary);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new CheckoutRefusal(serverFailure(error), { archived });
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      // The temporary copy was written in the same folder, so the folder allows writing: a refused
      // replace is the file being held by another program.
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new CheckoutRefusal(serverFailure(error, true), { archived });
    }
    const written = await stat(destination);
    const serverHash = await sha256Of(destination);
    // Written but not read back the same: the server file did change (the previous one is kept).
    if (serverHash !== localHash)
      throw new CheckoutRefusal('SERVER_WRITE_UNVERIFIED', { archived });
    // Remember a target the person gave, only once the write is confirmed (VIDE manifest with
    // server memory only).
    let remembered = false;
    if (remember) {
      const server = this.memory(ws);
      if (server?.root && fileKey(server.root) === fileKey(serverRoot)) {
        const next = updateServerMemory(ws.cfg, { targets: { [row.role]: target } });
        await writeWorkspaceConfig(ws.root, next, this.now);
        remembered = true;
      }
    }
    let checkout =
      fileKey(destination) === fileKey(row.serverPath)
        ? this.options.checkouts.rebase(projectId, row.id, {
            mtime: written.mtime.toISOString(),
            hash: serverHash,
          })
        : row;
    if (!input.keepCheckout)
      checkout = this.options.checkouts.release(projectId, row.id, at.toISOString());
    this.changed(projectId);
    this.options.log?.('workspace-publish', {
      projectId,
      checkoutId: row.id,
      role: row.role,
      archived: !!archived,
      released: !input.keepCheckout,
    });
    return {
      serverPath: destination,
      serverAt: written.mtime.toISOString(),
      hash: serverHash,
      archived,
      target,
      remembered,
      released: !input.keepCheckout,
      checkout,
    };
  }

  /**
   * Before an AI edit of a drawing opened on the server (T-312): the first edit of the day copies
   * it to `<archive>/서버백업/<YYYY-MM-DD>/<server relative path>`. Only drawings inside the
   * remembered drawing folder, kept on the server; otherwise nothing. Never throws.
   */
  async beforeDwgEdit(projectId: string, serverPath: string) {
    try {
      const ws = await this.workspace(projectId);
      const server = this.memory(ws);
      const relative = server?.paths.cad;
      if (!server?.root || !relative || server.checkout?.cad === 'local') return { backup: null };
      const path = realOf(serverPath);
      if (!atOrUnder(win32.resolve(server.root, relative), path)) return { backup: null };
      if (win32.extname(path).toLowerCase() !== EXTENSIONS.cad) return { backup: null };
      const archive = ws.paths.archive;
      if (!archive) return { backup: null };
      const backup = local(
        ws.root,
        win32.join(archive, '서버백업', localDay(this.now), win32.relative(server.root, path)),
      );
      try {
        await stat(backup);
        return { backup, made: false };
      } catch {
        /* the first edit today */
      }
      await mkdir(win32.dirname(backup), { recursive: true });
      local(ws.root, backup);
      const temporary = `${backup}.${randomUUID().slice(0, 8)}.vide-tmp`;
      try {
        await copyFile(path, temporary);
        await rename(temporary, backup);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      this.options.log?.('workspace-dwg-backup', { projectId });
      return { backup, made: true };
    } catch (error) {
      this.options.log?.('workspace-dwg-backup-failed', {
        projectId,
        code: (error as { code?: string }).code ?? 'UNKNOWN',
      });
      return { backup: null, error: (error as { code?: string }).code ?? 'UNKNOWN' };
    }
  }

  /** This PC's open checkouts as the site keeps them (`project_checkouts`, 0016). */
  siteItems(projectId: string) {
    return this.options.checkouts
      .active(projectId)
      .filter((row) => row.pcId === this.pcId())
      .map((row) => ({
        fileKey: fileKey(row.serverPath),
        role: row.role,
        serverPath: row.serverPath,
        userName: row.userId,
        checkedOutAt: row.checkedOutAt,
      }));
  }
}

// ---------------------------------------------------------------------------------------------
// Routes (appended to workspaceRoutes)

export interface CheckoutRouteDeps {
  service: WorkspaceCheckouts;
  body: () => Promise<Record<string, unknown>>;
  /** A remote session sees the rows but never copies files on this PC. */
  remote: boolean;
}

const CHECKOUT_PATH =
  /^\/api\/v1\/projects\/([^/]+)\/workspace\/(server-files|checkout|release|publish-summary|publish)$/;

/**
 * `GET …/workspace/server-files[?role=rhino|cad]`, `POST …/workspace/checkout {serverPath,
 * overwrite?, readOnly?}`, `POST …/workspace/release {checkoutId}`, `GET
 * …/workspace/publish-summary?checkoutId=`, `POST …/workspace/publish {checkoutId, target?,
 * keepCheckout?, seenServerHash?}`. Refusals carrying details answer `{code, …details}`.
 */
export async function checkoutRoutes(
  url: URL,
  method: string | undefined,
  project: (projectId: string) => unknown,
  send: (status: number, value: unknown) => void,
  deps: CheckoutRouteDeps,
) {
  const match = CHECKOUT_PATH.exec(url.pathname);
  if (!match) return false;
  const [, projectId, action] = match;
  project(projectId);
  const { service } = deps;
  try {
    if (action === 'server-files') {
      if (method !== 'GET') throw new DomainError('NOT_FOUND');
      const role = url.searchParams.get('role');
      send(
        200,
        await service.serverFiles(projectId, role === 'rhino' || role === 'cad' ? role : undefined),
      );
      return true;
    }
    if (action === 'publish-summary') {
      if (method !== 'GET') throw new DomainError('NOT_FOUND');
      const id = url.searchParams.get('checkoutId');
      if (!id) throw new DomainError('INVALID_INPUT');
      send(200, await service.publishSummary(projectId, id));
      return true;
    }
    if (method !== 'POST') throw new DomainError('NOT_FOUND');
    if (deps.remote) throw new DomainError('FORBIDDEN');
    const input = await deps.body();
    const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
    if (action === 'checkout') {
      const serverPath = text(input.serverPath);
      if (!serverPath) throw new DomainError('INVALID_INPUT');
      send(
        200,
        await service.checkout(projectId, {
          serverPath,
          overwrite: input.overwrite === true,
          readOnly: input.readOnly === true,
        }),
      );
    } else if (action === 'release') {
      const id = text(input.checkoutId);
      if (!id) throw new DomainError('INVALID_INPUT');
      send(200, service.release(projectId, id));
    } else {
      const id = text(input.checkoutId);
      if (!id) throw new DomainError('INVALID_INPUT');
      send(
        200,
        await service.publish(projectId, {
          checkoutId: id,
          target: text(input.target),
          keepCheckout: input.keepCheckout === true,
          seenServerHash: text(input.seenServerHash),
        }),
      );
    }
    return true;
  } catch (error) {
    if (error instanceof CheckoutRefusal) {
      send(checkoutStatuses[error.code] ?? 409, { code: error.code, ...error.details });
      return true;
    }
    throw error;
  }
}

/** Objects changed in a linked file since a time: applied executions of requests on its links. */
export function changesFromRequests(
  links: { path?: string | null; id: string }[],
  requests: { createdAt?: string; result?: unknown }[],
  localPath: string,
  since: string,
): ObjectChanges | null {
  const key = fileKey(localPath);
  const ids = new Set(
    links.filter((link) => link.path && fileKey(link.path) === key).map((link) => link.id),
  );
  if (!ids.size) return null;
  const total: ObjectChanges = { added: 0, modified: 0, removed: 0 };
  const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  for (const request of requests) {
    const executions = (request.result as { executions?: unknown } | null | undefined)?.executions;
    if (!Array.isArray(executions)) continue;
    for (const entry of executions as Record<string, unknown>[]) {
      const file = entry.file as { linkId?: string } | undefined;
      if (entry.state !== 'applied' || !file?.linkId || !ids.has(file.linkId)) continue;
      if (typeof entry.at === 'string' && entry.at < since) continue;
      const changes = (entry.changes ?? {}) as Record<string, unknown>;
      total.added += count(changes.added);
      total.modified += count(changes.changed ?? changes.modified);
      total.removed += count(changes.removed ?? changes.erased);
    }
  }
  return total;
}
