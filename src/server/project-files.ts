import { realpathSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { DomainError } from '../core/store.ts';
import type { FolderKind, ProjectFolders } from '../core/project-folders.ts';
import { describeFile, readFileContent, TEXT_PAGE_BYTES } from './attachments.ts';

/**
 * Project folders and the AI's read-only file tools (SPEC-01.13, ARCH-01 §3 「프로젝트 폴더와 파일
 * 읽기 도구」): which folders a project may name, which paths are never read, and one turn's
 * file_list / file_read with the permission question for paths outside the folders.
 */
export interface FileContext {
  /** This engine's data folder (VIDE's own records, never read by the AI). */
  dataDirectory?: string;
  home?: string;
  appData?: string;
  localAppData?: string;
}
const contextOf = (context: FileContext = {}) => {
  const home = context.home ?? homedir();
  return {
    dataDirectory: context.dataDirectory ? resolve(context.dataDirectory) : undefined,
    home,
    appData: context.appData ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming'),
    localAppData:
      context.localAppData ?? process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'),
  };
};

const windows = process.platform === 'win32';
const fold = (path: string) => (windows ? path.toLowerCase() : path);
/** `target` is `root` or below it (case-insensitive on Windows). */
export function inside(root: string, target: string) {
  const rel = relative(fold(root), fold(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

// Folders in the user's home that hold keys and logins.
const HOME_SECRETS = ['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.claude', '.codex'];
// Key folders wherever they are.
const SECRET_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws']);
const SECRET_NAMES = [
  /^\.env(\..*)?$/i,
  /^\.git-credentials$/i,
  /^[._]netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.pgpass$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^\.?credentials(\.json)?$/i,
];
const SECRET_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.pfx',
  '.p12',
  '.kdbx',
  '.ppk',
  '.jks',
  '.keystore',
]);
/** A file name the AI never reads or sees listed (keys, logins, environment files). */
export const secretName = (name: string) =>
  SECRET_NAMES.some((pattern) => pattern.test(name)) ||
  SECRET_EXTENSIONS.has(extname(name).toLowerCase());

/** Paths never read, even inside a project folder or with the user's permission (SPEC-01.13 4). */
export function deniedPath(path: string, context: FileContext = {}) {
  const c = contextOf(context);
  const folders = [
    c.dataDirectory,
    join(c.localAppData, 'VIDE'),
    ...HOME_SECRETS.map((name) => join(c.home, name)),
    join(c.appData, 'Microsoft', 'Credentials'),
    join(c.appData, 'Microsoft', 'Protect'),
    join(c.appData, 'Microsoft', 'SystemCertificates'),
    join(c.localAppData, 'Microsoft', 'Credentials'),
    join(c.localAppData, 'Google', 'Chrome', 'User Data'),
    join(c.localAppData, 'Microsoft', 'Edge', 'User Data'),
    join(c.appData, 'Mozilla', 'Firefox'),
  ].filter((folder): folder is string => !!folder);
  if (folders.some((folder) => inside(folder, path))) return true;
  const parts = resolve(path).split(/[\\/]+/);
  if (parts.some((part) => SECRET_SEGMENTS.has(part.toLowerCase()))) return true;
  return secretName(basename(path));
}

const error = (code: string) => new DomainError(code);
/** A pasted path: quotes from Explorer's "경로로 복사" removed; device paths refused. */
function pathInput(value: unknown) {
  if (typeof value !== 'string') throw error('INVALID_INPUT');
  const path = value
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();
  if (!path || path.length > 1024 || path.includes('\0') || /^[\\/]{2}[?.][\\/]/.test(path))
    throw error('INVALID_INPUT');
  return path;
}
const missing = (cause: unknown) =>
  !!cause &&
  typeof cause === 'object' &&
  'code' in cause &&
  ['ENOENT', 'ENOTDIR', 'EINVAL'].includes(String(cause.code));
/** The real path (junctions and links resolved), or undefined when it does not exist. */
async function real(path: string) {
  try {
    return realpathSync.native(path);
  } catch (cause) {
    if (missing(cause)) return undefined;
    throw cause;
  }
}
/** A drive root (`C:\`) or a UNC share root (`\\server\share`). */
const isRoot = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, '');
  return !trimmed || trimmed === parse(path).root.replace(/[\\/]+$/, '');
};

/**
 * A folder the user names for a project (or that [이 폴더는 항상] adds): an existing directory that
 * is not a drive root, not VIDE's data folder and not a denied location. Returns its real path.
 */
export async function checkFolder(value: unknown, context: FileContext = {}) {
  const path = pathInput(value);
  if (!isAbsolute(path)) throw error('INVALID_INPUT');
  const lexical = resolve(path);
  const target = await real(lexical);
  if (!target || !(await stat(target)).isDirectory()) throw error('FOLDER_NOT_FOUND');
  if (
    isRoot(lexical) ||
    isRoot(target) ||
    deniedPath(lexical, context) ||
    deniedPath(target, context)
  )
    throw error('FOLDER_NOT_ALLOWED');
  return target;
}

/** The folder list with whether each still exists (dashboard). */
export async function folderList(folders: ProjectFolders, projectId: string) {
  return Promise.all(
    folders.list(projectId).map(async (folder) => ({
      ...folder,
      exists: !!(await real(folder.path).catch(() => undefined)),
    })),
  );
}

/** One request's answers to the permission question (kept until the request ends). */
export interface TurnGrants {
  allowed: string[];
  denied: string[];
  /** Questions of one request are asked one at a time. */
  queue: Promise<unknown>;
}
export const turnGrants = (): TurnGrants => ({ allowed: [], denied: [], queue: Promise.resolve() });
export type PermissionAnswer = 'once' | 'always' | 'deny' | null;
/** Asks the user whether the AI may read `folder` (for `path`); null when nobody answered. */
export type AskPermission = (
  folder: string,
  path: string,
  signal: AbortSignal,
) => Promise<PermissionAnswer>;

const LIST_PAGE = 100;
const MAX_LIST_PAGE = 200;
/** `*` and `?` wildcards on a name, case-insensitive. */
const wildcard = (pattern: string) =>
  new RegExp(
    '^' +
      pattern
        .split('')
        .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
        .join('') +
      '$',
    'i',
  );

export class FileAccess {
  readonly #folders: ProjectFolders;
  readonly #projectId: string;
  readonly #context: FileContext;
  readonly #grants: TurnGrants;
  readonly #ask?: AskPermission;
  readonly #onUse: (text: string) => void;
  constructor({
    folders,
    projectId,
    context = {},
    grants = turnGrants(),
    ask,
    onUse = () => {},
  }: {
    folders: ProjectFolders;
    projectId: string;
    context?: FileContext;
    grants?: TurnGrants;
    /** The permission question; left out, a path outside the folders is refused. */
    ask?: AskPermission;
    onUse?: (text: string) => void;
  }) {
    this.#folders = folders;
    this.#projectId = projectId;
    this.#context = context;
    this.#grants = grants;
    this.#ask = ask;
    this.#onUse = onUse;
  }
  /** The project's folders with their current real paths (missing ones left out of `real`). */
  async #roots() {
    return Promise.all(
      this.#folders.list(this.#projectId).map(async (folder) => ({
        ...folder,
        real: await real(folder.path).catch(() => undefined),
      })),
    );
  }

  /**
   * The path the AI may read now, or a refusal (ARCH-01 §3 판정 순서). The permission question
   * names the folder itself, or the folder a file is in.
   */
  async #resolve(value: string, signal: AbortSignal, verb: string) {
    const raw = pathInput(value);
    const roots = await this.#roots();
    let lexical: string;
    if (isAbsolute(raw)) lexical = resolve(raw);
    else {
      const first = roots.find((root) => root.kind === 'project');
      if (!first) throw error('INVALID_INPUT');
      lexical = resolve(first.path, raw);
    }
    const refuse = (code: string): never => {
      this.#onUse(`${verb} 거절 · ${lexical}`);
      throw error(code);
    };
    if (deniedPath(lexical, this.#context)) refuse('FILE_FORBIDDEN');
    const target = await real(lexical);
    if (!target) throw error('FILE_NOT_FOUND');
    if (deniedPath(target, this.#context)) refuse('FILE_FORBIDDEN');
    const shown = { lexical, target, directory: (await stat(target)).isDirectory() };
    if (roots.some((root) => root.real && inside(root.real, target))) return shown;
    // A link inside a folder that leads out of it is refused, never asked (SPEC-01.13 5).
    if (
      roots.some((root) => inside(root.path, lexical) || (root.real && inside(root.real, lexical)))
    )
      refuse('FILE_FORBIDDEN');
    const folder = shown.directory ? target : dirname(target);
    const decided = () => {
      if (this.#grants.allowed.some((granted) => inside(granted, target))) return 'allowed';
      if (this.#grants.denied.some((refused) => inside(refused, target))) return 'denied';
      return undefined;
    };
    const known = decided();
    if (known === 'allowed') return shown;
    if (known === 'denied' || !this.#ask) refuse('FILE_ACCESS_DENIED');
    // One question at a time; an earlier answer may already cover this path.
    const turn = this.#grants.queue.then(async () => {
      const again = decided();
      if (again) return again === 'allowed' ? 'once' : 'deny';
      return this.#ask!(folder, lexical, signal);
    });
    this.#grants.queue = turn.catch(() => undefined);
    const answer = await turn;
    if (answer === 'always') {
      try {
        this.#folders.add(this.#projectId, await checkFolder(folder, this.#context), 'read');
      } catch {
        // A folder that cannot be kept (a drive root …) is allowed for this request only.
        this.#grants.allowed.push(folder);
      }
      return shown;
    }
    if (answer === 'once') {
      this.#grants.allowed.push(folder);
      return shown;
    }
    this.#grants.denied.push(folder);
    return refuse('FILE_ACCESS_DENIED');
  }

  /** file_list: the folders (no path), or one folder's entries a page at a time. */
  async list(
    {
      path,
      pattern,
      offset = 0,
      limit = LIST_PAGE,
    }: { path?: string; pattern?: string; offset?: number; limit?: number },
    signal: AbortSignal = new AbortController().signal,
  ) {
    if (path === undefined) {
      const folders = await folderList(this.#folders, this.#projectId);
      this.#onUse('폴더 목록 · 프로젝트 폴더');
      return {
        folders: folders.map(({ path: folder, kind, exists }) => ({ path: folder, kind, exists })),
        note: folders.length
          ? 'Project folders (kind project) and folders the user allowed (kind read). Pass one as path.'
          : 'This project has no folders set. Ask the user to set one in 대시보드 › 프로젝트 폴더, or give an absolute path (the user is asked for permission).',
      };
    }
    const shown = await this.#resolve(path, signal, '폴더 목록');
    if (!shown.directory) throw error('INVALID_INPUT');
    const match = pattern ? wildcard(pattern) : undefined;
    const names = (await readdir(shown.target, { withFileTypes: true }))
      .filter(
        (entry) =>
          !secretName(entry.name) && !deniedPath(join(shown.target, entry.name), this.#context),
      )
      .filter((entry) => !match || match.test(entry.name));
    const kinded = names.map((entry) => ({ name: entry.name, folder: entry.isDirectory() }));
    kinded.sort((a, b) =>
      a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? -1 : 1,
    );
    const size = Math.min(Math.max(1, limit), MAX_LIST_PAGE);
    const page = kinded.slice(offset, offset + size);
    const entries = await Promise.all(
      page.map(async ({ name }) => {
        try {
          const info = await stat(join(shown.target, name));
          return info.isDirectory()
            ? { name, kind: 'dir' as const, modified: info.mtime.toISOString() }
            : { name, kind: 'file' as const, size: info.size, modified: info.mtime.toISOString() };
        } catch {
          return { name, kind: 'file' as const };
        }
      }),
    );
    this.#onUse(`폴더 목록 · ${shown.lexical}`);
    return {
      path: shown.lexical,
      total: kinded.length,
      offset,
      nextOffset: offset + size < kinded.length ? offset + size : null,
      entries,
    };
  }

  /** file_read: one file's text page, image or description. */
  async read(
    {
      path,
      offset = 0,
      limit = TEXT_PAGE_BYTES,
    }: { path: string; offset?: number; limit?: number },
    signal: AbortSignal = new AbortController().signal,
  ) {
    const shown = await this.#resolve(path, signal, '파일 읽기');
    this.#onUse(`파일 읽기 · ${shown.lexical}`);
    if (shown.directory)
      return { path: shown.lexical, kind: 'directory', note: 'This is a folder; use file_list.' };
    const file = await describeFile(shown.target);
    return readFileContent(
      { path: shown.target, ...file },
      {
        path: shown.lexical,
        name: basename(shown.lexical),
        kind: file.kind,
        size: file.size,
        type: file.type,
      },
      { offset, limit },
    );
  }
}

export type { FolderKind };

/**
 * `GET·POST /api/v1/projects/:p/folders` and `POST …/folders/remove` (ARCH-01 §3): the project's
 * folders with whether each exists; POST adds a checked folder (`kind` project by default), remove
 * takes one off. True when the route was this one.
 */
export async function folderRoutes(
  url: URL,
  method: string | undefined,
  {
    folders,
    context,
    project,
    body,
    send,
  }: {
    folders: ProjectFolders;
    context: FileContext;
    project: (projectId: string) => unknown;
    body: () => Promise<Record<string, unknown>>;
    send: (status: number, value: unknown) => void;
  },
) {
  const match = /^\/api\/v1\/projects\/([^/]+)\/folders(\/remove)?$/.exec(url.pathname);
  if (!match) return false;
  const [, projectId, remove] = match;
  project(projectId);
  if (method === 'POST' && remove) {
    const input = await body();
    if (typeof input.path !== 'string' || !input.path) throw error('INVALID_INPUT');
    folders.remove(projectId, input.path);
  } else if (method === 'POST') {
    const input = await body();
    const kind = input.kind === undefined ? 'project' : input.kind;
    if (kind !== 'project' && kind !== 'read') throw error('INVALID_INPUT');
    folders.add(projectId, await checkFolder(input.path, context), kind);
  } else if (method !== 'GET' || remove) throw error('NOT_FOUND');
  send(200, { folders: await folderList(folders, projectId) });
  return true;
}
