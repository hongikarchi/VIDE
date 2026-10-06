import { existsSync, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
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

/**
 * Project folders and the AI's work folder (SPEC-01.13, ARCH-01 §3 「프로젝트 폴더와 파일 도구」,
 * ADR-031 8): which folders a project may name, which paths are never read, and the gate one turn's
 * built-in file and shell tools pass, with the permission question for paths outside the folders.
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

/**
 * The turn's own project data folder, `<data>/projects/<projectId>` (ADR-031 6, ADR-032): its
 * project.sqlite and knowledge.sqlite hold the project's full records (earlier executions' code
 * included), which the AI may read without a question. Only in the split data folder.
 */
export function ownProjectData(projectId: string, context: FileContext = {}) {
  const data = contextOf(context).dataDirectory;
  if (!data || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(projectId)) return undefined;
  if (!existsSync(join(data, 'app.sqlite'))) return undefined;
  return join(data, 'projects', projectId);
}
// Words that change an SQLite DB or a file (SQL, sqlite3 dot commands, Node, shells). One of them
// makes a command not "read only" (a redirect names its file, which the gate checks on its own).
const CHANGES =
  /\b(insert|update|delete|drop|alter|create|vacuum|attach|detach|reindex)\b|\.(save|output|once|import|backup|restore|clone)\b|\b(writeFile\w*|appendFile\w*|copyFile\w*|createWriteStream|unlink\w*|rmSync|rm|rmdir|rename\w*|truncate\w*|mkdir\w*|cp|mv|del|erase|move|copy|ren|Remove-Item|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Rename-Item|New-Item|Clear-Content)\b|pragma\s+\w+\s*=/i;
/**
 * A shell command that only reads an SQLite file: every database it opens is opened read-only
 * (`node:sqlite` `readOnly: true`, `sqlite3 -readonly`, a `mode=ro` URI) and nothing in it changes
 * a DB or a file. The rule for running a command on the turn's own project data folder.
 */
export function readOnlySqlite(command: string) {
  const opens = (
    command.match(/\bDatabaseSync\s*\(|\bnew\s+Database\s*\(|\bsqlite3(\.exe)?\b/gi) ?? []
  ).length;
  const readOnly = (command.match(/readOnly\s*:\s*true|\s-readonly\b|[?&]mode=ro\b/gi) ?? [])
    .length;
  return opens > 0 && readOnly >= opens && !CHANGES.test(command);
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

/**
 * One request's answers to the permission question (kept until the request ends): folders the
 * user let the AI read (`allowed`) or write and run in (`written`) this request, and the ones
 * refused.
 */
export interface TurnGrants {
  allowed: string[];
  denied: string[];
  written: string[];
  refused: string[];
  /** Commands outside the sandbox the user allowed once (Codex escalations). */
  commands: string[];
  /** Questions of one request are asked one at a time. */
  queue: Promise<unknown>;
}
export const turnGrants = (): TurnGrants => ({
  allowed: [],
  denied: [],
  written: [],
  refused: [],
  commands: [],
  queue: Promise.resolve(),
});
export type PermissionAnswer = 'once' | 'always' | 'deny' | null;
/** What a permission question is about: reading, writing a file, or running a command. */
export type PermissionAction = 'read' | 'write' | 'run';
/**
 * Asks the user whether the AI may read `folder` (for `path`), write there or run a command there;
 * null when nobody answered. `always` is offered only for reading.
 */
export type AskPermission = (
  folder: string,
  path: string,
  signal: AbortSignal,
  action?: PermissionAction,
) => Promise<PermissionAnswer>;

/**
 * The project work folder of one turn (ADR-031 8, SPEC-01.13): the CLI runs in the first project
 * folder; the project's other folders are reached too, and the folders the user let it read (kind
 * `read`) are read without asking. Missing folders are left out.
 */
export function workFolderScope(
  folders: ProjectFolders | undefined,
  projectId: string,
  context: FileContext = {},
): { cwd?: string; write: string[]; read: string[] } {
  const rows = (folders?.list(projectId) ?? []).map((folder) => {
    let found: string | undefined;
    try {
      found = realpathSync.native(folder.path);
    } catch {
      found = undefined;
    }
    return { ...folder, real: found };
  });
  const usable = rows.filter(
    (row): row is typeof row & { real: string } =>
      !!row.real && !deniedPath(row.real, context) && !isRoot(row.real),
  );
  const write = usable.filter((row) => row.kind === 'project').map((row) => row.real);
  const read = usable.filter((row) => row.kind === 'read').map((row) => row.real);
  return { cwd: write[0], write, read };
}

/** A permission request of the CLI, as the CLI adapters pass it (claude-cli.ts). */
export interface GateRequest {
  tool: string;
  input: Record<string, unknown>;
  blockedPath?: string;
  escalation?: boolean;
}
export type GateAnswer = { allow: true } | { allow: false; message: string };
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/**
 * The absolute paths a shell command names (best effort: drive paths, UNC paths, Git Bash `/c/…`
 * paths and `~`). A command that names none runs in the work folder it starts in. This scopes the
 * command's arguments, not what a program does on its own: like the script policy it is a guard,
 * not an OS boundary (ADR-031 8).
 */
export function commandPaths(full: string, home = homedir()) {
  // The program itself (`"C:\…\powershell.exe" -Command …`, `C:\Python\python.exe x.py`) is not a
  // path the command reads or writes: only its arguments are scoped.
  const command = full.trim().replace(/^("[^"]*"|\S+)/, '');
  const found = new Set<string>();
  const add = (value: string) => {
    const path = value.replace(/[\\/]+$/, '') || value;
    if (path) found.add(resolve(path));
  };
  const quoted = /"([^"]+)"|'([^']+)'/g;
  // A quoted value that is a path counts whole (it may hold spaces); any other quoted text (a
  // script passed to -Command or -c) is scanned like the rest of the command.
  for (const match of command.matchAll(quoted)) {
    const inner = (match[1] ?? match[2])!;
    if (/^([A-Za-z]:[\\/]|\\\\)/.test(inner)) add(inner);
    else if (/^\/[A-Za-z]\//.test(inner)) add(`${inner[1]!.toUpperCase()}:${inner.slice(2)}`);
    else if (/^~([\\/]|$)/.test(inner)) add(join(home, inner.slice(1)));
    // '_' stands in for the program the inner text is given to.
    else for (const path of commandPaths('_ ' + inner, home)) found.add(path);
  }
  const bare = command.replace(quoted, ' ');
  for (const match of bare.matchAll(/(?:^|[\s=<>|;&(])((?:[A-Za-z]:[\\/]|\\\\)[^\s"'`|;&<>()]*)/g))
    add(match[1]!);
  for (const match of bare.matchAll(
    /(?:^|[\s=<>|;&(])\/([A-Za-z])(\/[^\s"'`|;&<>()]*)?(?=$|[\s|;&<>()])/g,
  ))
    add(`${match[1]!.toUpperCase()}:${match[2] ?? '\\'}`);
  for (const match of bare.matchAll(/(?:^|[\s=<>|;&(])~([\\/][^\s"'`|;&<>()]*)?(?=$|[\s|;&<>()])/g))
    add(join(home, match[1] ?? ''));
  return [...found];
}
/**
 * The engine's side of the CLI's built-in file and shell tools (ADR-031 8, SPEC-01.13): inside the
 * project work folder a use is allowed at once; reading a `read` folder or one of the turn's
 * attachments too; anything else asks the user each time (once, or for reading also always), keys,
 * logins and VIDE data are never reached, and a Plan turn writes no file. A refusal answers only
 * that call; the turn goes on.
 */
export class WorkFolderGate {
  readonly #folders?: ProjectFolders;
  readonly #projectId: string;
  readonly #context: FileContext;
  readonly #grants: TurnGrants;
  readonly #ask?: AskPermission;
  readonly #onUse: (text: string) => void;
  readonly #attachments: Set<string>;
  readonly #readOnly: boolean;
  readonly #granted: string[];
  #scope?: { cwd?: string; write: string[]; read: string[] };
  constructor({
    folders,
    projectId,
    context = {},
    grants = turnGrants(),
    ask,
    onUse = () => {},
    attachments = [],
    readOnly = false,
    granted = [],
  }: {
    /** The project's folders; left out (no folder store), the turn has no work folder. */
    folders?: ProjectFolders;
    projectId: string;
    context?: FileContext;
    grants?: TurnGrants;
    /** The permission question; left out, anything outside the work folder is refused. */
    ask?: AskPermission;
    onUse?: (text: string) => void;
    /** The turn's stored attachments (their paths are read without asking). */
    attachments?: readonly string[];
    /** A Plan turn: no file is written. */
    readOnly?: boolean;
    /**
     * Folders the user pasted as chips for this turn (SPEC-01.13 5, checked on submission): read
     * like `read` folders, without asking; writing and running there still ask.
     */
    granted?: readonly string[];
  }) {
    this.#folders = folders;
    this.#projectId = projectId;
    this.#context = context;
    this.#grants = grants;
    this.#ask = ask;
    this.#onUse = onUse;
    this.#attachments = new Set(attachments.map((path) => fold(resolve(path))));
    this.#readOnly = readOnly;
    this.#granted = [...granted];
  }
  /** The work folder as it is now (read once per turn, again after [이 폴더는 항상]). */
  scope() {
    return (this.#scope ??= workFolderScope(this.#folders, this.#projectId, this.#context));
  }
  /** The scope the read judgement uses: the work folder and this turn's pasted folders. */
  #readScope() {
    const scope = this.scope();
    return this.#granted.length ? { ...scope, read: [...scope.read, ...this.#granted] } : scope;
  }
  /** The CLI's question about one tool use. */
  async decide(request: GateRequest, signal: AbortSignal): Promise<GateAnswer> {
    try {
      return await this.#decide(request, signal);
    } catch (cause) {
      const code = (cause as { code?: unknown })?.code;
      return {
        allow: false,
        message:
          code === 'INVALID_INPUT'
            ? 'VIDE could not read the path of this call; nothing ran. Name a full path.'
            : 'VIDE could not check this call; nothing ran.',
      };
    }
  }
  async #decide(request: GateRequest, signal: AbortSignal): Promise<GateAnswer> {
    const scope = this.#readScope();
    const text = (key: string) =>
      typeof request.input[key] === 'string' ? (request.input[key] as string) : undefined;
    const list = (key: string) =>
      Array.isArray(request.input[key])
        ? (request.input[key] as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];
    const base = scope.cwd ?? scope.write[0];
    const absolute = (path: string, from = base) =>
      isAbsolute(path) ? resolve(path) : from ? resolve(from, path) : undefined;
    const checks: { path: string; action: PermissionAction }[] = [];
    const push = (path: string | undefined, action: PermissionAction) => {
      if (path) checks.push({ path, action });
    };
    if (READ_TOOLS.has(request.tool)) {
      const named = text('file_path') ?? text('notebook_path') ?? text('path');
      push(request.blockedPath ?? (named ? absolute(named) : base), 'read');
    } else if (WRITE_TOOLS.has(request.tool)) {
      if (this.#readOnly) {
        this.#onUse(`파일 쓰기 거절 · ${text('file_path') ?? text('notebook_path') ?? ''} (계획)`);
        return {
          allow: false,
          message: 'This is a Plan turn: no file is written. Say what you would change instead.',
        };
      }
      const named = text('file_path') ?? text('notebook_path');
      push(named ? absolute(named) : request.blockedPath, 'write');
      for (const path of list('paths')) push(absolute(path), 'write');
      // A change whose files are not known (a Codex approval without its item): the user is asked
      // about the change itself; without a question it is refused.
      if (request.escalation && !checks.length)
        return this.#askCommand('파일 변경 (경로를 알 수 없음)', base ?? '', signal);
      if (!checks.length)
        return { allow: false, message: 'Name the file to write with a full path.' };
    } else if (SHELL_TOOLS.has(request.tool)) {
      const command = text('command') ?? '';
      const from = text('cwd') ? absolute(text('cwd')!) : base;
      if (from && (!base || !(await this.#within(from, scope, 'run')))) push(from, 'run');
      for (const path of commandPaths(command, this.#context.home)) push(path, 'run');
      if (request.blockedPath) push(absolute(request.blockedPath, from), 'run');
      // A command Codex wants to run outside its sandbox (network, a write it was refused) and
      // that names no outside path: the user is asked about the command itself.
      if (
        request.escalation &&
        !checks.some((check) => check.action === 'run' && check.path !== from)
      ) {
        if (this.#grants.commands.includes(command)) return { allow: true };
        return this.#askCommand(command, from ?? '', signal);
      }
    } else if (request.tool === 'permissions') {
      for (const path of list('read')) push(absolute(path), 'read');
      for (const path of list('write')) push(absolute(path), this.#readOnly ? 'read' : 'write');
      if (request.input.network === true)
        return { allow: false, message: 'Network access is not available to the shell in VIDE.' };
    } else return { allow: false, message: 'This tool is not available in VIDE.' };
    // A command that only reads SQLite may read the project's own records (see #check).
    const readOnlyCommand = SHELL_TOOLS.has(request.tool) && readOnlySqlite(text('command') ?? '');
    for (const check of checks) {
      const answer = await this.#check(check.path, check.action, scope, signal, readOnlyCommand);
      if (!answer.allow) return answer;
    }
    return { allow: true };
  }
  /** Inside the folders this action reaches without asking. */
  async #within(
    path: string,
    scope: { write: string[]; read: string[] },
    action: PermissionAction,
  ) {
    const target = (await real(path).catch(() => undefined)) ?? (await nearest(path));
    const roots = action === 'read' ? [...scope.write, ...scope.read] : scope.write;
    return roots.some((root) => inside(root, target));
  }
  async #check(
    path: string,
    action: PermissionAction,
    scope: { write: string[]; read: string[] },
    signal: AbortSignal,
    readOnlyCommand = false,
  ): Promise<GateAnswer> {
    const lexical = resolve(path);
    if (action === 'read' && this.#attachments.has(fold(lexical))) return { allow: true };
    const forbidden: GateAnswer = {
      allow: false,
      message:
        "FILE_FORBIDDEN: keys, logins and VIDE's own data are never read or written. Do not retry.",
    };
    // The project's own records (ADR-031 6): read without a question, never written. A command
    // there must only read SQLite (`readOnlySqlite`). Other projects and app.sqlite stay refused.
    const own = ownProjectData(this.#projectId, this.#context);
    if (own && inside(own, lexical)) {
      const target = (await real(lexical).catch(() => undefined)) ?? (await nearest(lexical));
      if (!inside(own, target) || secretName(basename(target))) {
        this.#onUse(`파일 거절 · ${lexical}`);
        return forbidden;
      }
      if (action === 'read' || (action === 'run' && readOnlyCommand)) {
        this.#onUse(`프로젝트 기록 읽기 · ${lexical}`);
        return { allow: true };
      }
      this.#onUse(`프로젝트 기록 ${action === 'write' ? '쓰기' : '명령'} 거절 · ${lexical}`);
      return {
        allow: false,
        message:
          action === 'write'
            ? "FILE_FORBIDDEN: the project's own records are read only. Nothing was written; do not retry."
            : "FILE_FORBIDDEN: a command on the project's records must only read them: open each DB read-only (node:sqlite { readOnly: true }, sqlite3 -readonly) and change nothing. Nothing ran.",
      };
    }
    if (deniedPath(lexical, this.#context)) {
      this.#onUse(`파일 거절 · ${lexical}`);
      return forbidden;
    }
    const target = (await real(lexical).catch(() => undefined)) ?? (await nearest(lexical));
    if (action === 'read' && this.#attachments.has(fold(target))) return { allow: true };
    if (deniedPath(target, this.#context)) {
      this.#onUse(`파일 거절 · ${lexical}`);
      return forbidden;
    }
    if (await this.#within(target, scope, action)) return { allow: true };
    if (this.#readOnly && action === 'write') {
      this.#onUse(`파일 쓰기 거절 · ${lexical} (계획)`);
      return { allow: false, message: 'This is a Plan turn: no file is written.' };
    }
    const granted = action === 'read' ? this.#grants.allowed : this.#grants.written;
    const refused = action === 'read' ? this.#grants.denied : this.#grants.refused;
    const folder = (await isDirectory(target)) ? target : dirname(target);
    const decided = () => {
      if (granted.some((root) => inside(root, target))) return 'allowed';
      // A write grant covers reading there too.
      if (action === 'read' && this.#grants.written.some((root) => inside(root, target)))
        return 'allowed';
      if (refused.some((root) => inside(root, target))) return 'denied';
      return undefined;
    };
    const denied: GateAnswer = {
      allow: false,
      message: `FILE_ACCESS_DENIED: ${lexical} is outside the project work folder and the user did not allow it. Do not try it again in this turn; tell the user which file or folder you need (they can attach it or add the folder in 대시보드 › 프로젝트 폴더).`,
    };
    const known = decided();
    if (known === 'allowed') return { allow: true };
    if (known === 'denied' || !this.#ask) {
      this.#onUse(`${verbOf(action)} 거절 · ${lexical}`);
      return denied;
    }
    // One question at a time; an earlier answer may already cover this path.
    const turn = this.#grants.queue.then(async () => {
      const again = decided();
      if (again) return again === 'allowed' ? 'once' : 'deny';
      return this.#ask!(folder, lexical, signal, action);
    });
    this.#grants.queue = turn.catch(() => undefined);
    const answer = await turn;
    if (answer === 'always' && action === 'read') {
      try {
        if (!this.#folders) throw new DomainError('NOT_FOUND');
        this.#folders.add(this.#projectId, await checkFolder(folder, this.#context), 'read');
        this.#scope = undefined;
      } catch {
        // A folder that cannot be kept (a drive root …) is allowed for this request only.
        this.#grants.allowed.push(folder);
      }
      this.#onUse(`${verbOf(action)} 허용 · ${lexical}`);
      return { allow: true };
    }
    if (answer === 'once' || answer === 'always') {
      granted.push(folder);
      this.#onUse(`${verbOf(action)} 허용 · ${lexical}`);
      return { allow: true };
    }
    refused.push(folder);
    this.#onUse(`${verbOf(action)} 거절 · ${lexical}`);
    return denied;
  }
  async #askCommand(command: string, cwd: string, signal: AbortSignal): Promise<GateAnswer> {
    if (!this.#ask)
      return {
        allow: false,
        message:
          'Running that outside the sandbox needs the user, who cannot be asked in this turn. Nothing ran.',
      };
    const turn = this.#grants.queue.then(() =>
      this.#ask!(cwd, command.slice(0, 300), signal, 'run'),
    );
    this.#grants.queue = turn.catch(() => undefined);
    const answer = await turn;
    if (answer === 'once' || answer === 'always') {
      this.#grants.commands.push(command);
      this.#onUse(`명령 실행 허용 · ${command.slice(0, 200)}`);
      return { allow: true };
    }
    this.#onUse(`명령 실행 거절 · ${command.slice(0, 200)}`);
    return {
      allow: false,
      message:
        'The user did not allow running that outside the project work folder sandbox. Nothing ran; do not try it again in this turn.',
    };
  }
}
const verbOf = (action: PermissionAction) =>
  action === 'read' ? '파일 읽기' : action === 'write' ? '파일 쓰기' : '명령 실행';
/** The real path of a path or of its nearest existing parent (a file about to be written). */
async function nearest(path: string): Promise<string> {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    const found = await real(current).catch(() => undefined);
    if (found) return rest.length ? join(found, ...rest.reverse()) : found;
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    rest.push(basename(current));
    current = parent;
  }
}
async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
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
