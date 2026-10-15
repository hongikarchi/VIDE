// 프로젝트 로컬 git 준비 (PLAN-52 T-314, ADR-042): when [폴더로 만들기] has '이력 관리(git)' on, the
// new work folder becomes a git repository with a default `.gitignore` and a first commit (remote,
// push and pull with the person's own GitHub account: PLAN-54 T-346, below). The ignore list
// follows the 규모검토 folder (논현동 7-3): binaries, originals, archives and outputs stay out; the
// manifest, analysis JSON, md and HTML are tracked. Folder names come from the manifest's role
// paths, never from code.
import { execFile } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DomainError } from '../contracts/errors.ts';
import { RECORD_ORIGINALS } from '../contracts/records.ts';
import type { WorkspaceRole } from '../core/workspace-template.ts';
import { repoNameOf, repoNamePattern, type GithubRepo } from './github-api.ts';

const run = (
  args: string[],
  cwd?: string,
  timeout = 30_000,
  /** Extra environment for this one call (the push credential); never logged. */
  extra?: Record<string, string>,
) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extra },
      },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code as number)
            : -1
          : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });

export interface GitAvailability {
  available: boolean;
  version?: string;
}

let cached: Promise<GitAvailability> | undefined;
/** Whether `git` runs on this PC (asked once per engine; `fresh` asks again). */
export function gitAvailability(fresh = false): Promise<GitAvailability> {
  if (!cached || fresh)
    cached = run(['--version'], undefined, 10_000).then(({ code, stdout }) =>
      code === 0 && /git version/i.test(stdout)
        ? { available: true, version: stdout.trim().replace(/^git version\s*/i, '') }
        : { available: false },
    );
  return cached;
}

/**
 * Roles whose folders hold originals, outputs or old copies: not tracked at all. The model,
 * drawing and reference folders stay tracked for their text files (모델 구성 JSON and the like);
 * their binaries are left out by type below.
 */
const UNTRACKED_ROLES: readonly WorkspaceRole[] = ['raw', 'output', 'archive'];

const BINARIES = [
  '# 모델·도면·바이너리',
  '*.3dm',
  '*.3dmbak',
  '*.rhl',
  '*.rui',
  '*.gh',
  '*.ghx',
  '*.dwg',
  '*.dwl',
  '*.dwl2',
  '*.dxf',
  '*.bak',
  '*.sv$',
  '*.ctb',
  '*.stb',
  '*.pdf',
  '*.hwp',
  '*.hwpx',
  '*.docx',
  '*.xlsx',
  '*.pptx',
  '*.zip',
  '*.7z',
  '*.rar',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.bmp',
  '*.tif',
  '*.tiff',
  '*.webp',
  '*.psd',
  '*.ai',
  '*.mp4',
  '*.mov',
  '*.shp',
  '*.shx',
  '*.dbf',
  '*.sqlite',
  '*.sqlite-*',
];

const gitPath = (relative: string) =>
  relative
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
    .replace(/([*?[\]!#])/g, '\\$1');

/**
 * The default `.gitignore` for a work folder whose role paths are `paths` (relative): the
 * original/output/archive role folders and binary types out, temporary files out; everything else
 * (manifest, guide files, review JSON and HTML, ops notes, project jig definitions) tracked.
 */
/** Secret file names never committed (the same kinds the project folder gate refuses). */
const SECRETS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  '*.kdbx',
  'id_rsa*',
  'id_ed25519*',
  '.git-credentials',
  '.npmrc',
  'credentials*',
];

export function defaultGitignore(paths: Partial<Record<WorkspaceRole, string>>): string {
  const folders = UNTRACKED_ROLES.map((role) => paths[role])
    .filter((path): path is string => !!path && path !== '.' && path !== './')
    .map((path) => `/${gitPath(path)}/`);
  // Imported KakaoTalk chats and mail (`<ops>/기록/원문/`, SPEC-17.6, PLAN-53 T-331).
  const ops = paths.ops && paths.ops !== '.' && paths.ops !== './' ? `/${gitPath(paths.ops)}` : '';
  return [
    '# VIDE 작업 폴더 — 설정·분석 JSON·md·HTML만 기록합니다(모델·도면·원본·산출물·보관 제외).',
    '# 이 파일은 사람이 고쳐도 됩니다. VIDE는 처음 만들 때만 씁니다.',
    '',
    '# 원본·산출물·보관 폴더',
    ...folders,
    '',
    '# 가져온 카카오톡·메일 원문',
    `${ops}/${RECORD_ORIGINALS.join('/')}/`,
    '',
    ...BINARIES,
    '',
    '# 비밀 파일(키·인증 정보)은 기록하지 않습니다 — 원격 저장소로 나가지 않게',
    ...SECRETS,
    '',
    '# 임시 파일',
    '*.tmp',
    '~$*',
    'Thumbs.db',
    'desktop.ini',
    '.DS_Store',
    '.vide/',
    '',
  ].join('\n');
}

export interface GitSetup {
  /** `committed`: repository and first commit; `exists`: already a repository (left alone). */
  state: 'committed' | 'initialized' | 'exists' | 'unavailable' | 'failed';
  branch?: string;
  /** git's own message when a step failed (shown as a detail, not translated). */
  error?: string;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * `git init` in `root`, a `.gitignore` (only when there is none) and a first commit of what the
 * ignore list keeps. A folder that already is a repository is left as it is. Never throws.
 */
export async function initRepository(
  root: string,
  paths: Partial<Record<WorkspaceRole, string>>,
  message = 'VIDE: 작업 폴더 만들기',
): Promise<GitSetup> {
  if (!(await gitAvailability()).available) return { state: 'unavailable' };
  if (await exists(join(root, '.git'))) return { state: 'exists' };
  const branch = 'main';
  let init = await run(['init', `--initial-branch=${branch}`], root);
  // git before 2.28 has no --initial-branch: plain init, then name the unborn branch.
  if (init.code !== 0) {
    init = await run(['init'], root);
    if (init.code === 0) await run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], root);
  }
  if (init.code !== 0) return { state: 'failed', error: (init.stderr || init.stdout).trim() };
  try {
    if (!(await exists(join(root, '.gitignore'))))
      await writeFile(join(root, '.gitignore'), defaultGitignore(paths), 'utf8');
  } catch (error) {
    return { state: 'initialized', branch, error: String((error as Error).message ?? error) };
  }
  const added = await run(['add', '-A'], root, 120_000);
  if (added.code !== 0)
    return { state: 'initialized', branch, error: (added.stderr || added.stdout).trim() };
  // The person's own identity when git has one; otherwise the commit is signed as VIDE.
  const email = await run(['config', 'user.email'], root);
  const name = await run(['config', 'user.name'], root);
  const identity = [
    ...(name.code === 0 && name.stdout.trim() ? [] : ['-c', 'user.name=VIDE']),
    ...(email.code === 0 && email.stdout.trim() ? [] : ['-c', 'user.email=vide@localhost']),
  ];
  const commit = await run([...identity, 'commit', '--allow-empty', '-m', message], root, 120_000);
  if (commit.code !== 0)
    return { state: 'initialized', branch, error: (commit.stderr || commit.stdout).trim() };
  return { state: 'committed', branch };
}

// ---------------------------------------------------------------------------------------------
// 이력 — 저장점·원격·푸시·가져오기 (PLAN-54 T-346, SPEC-05.11, SPEC-01.13 10, Design SCR-42).
// Only what the person presses: a commit of the folder ([저장점 만들기]), a repository in their own
// GitHub account, a push and a fast-forward pull. VIDE never merges, rebases or resolves a
// conflict: a folder that differs from its remote stops with REMOTE_DIVERGED. A folder on a
// server share (UNC) never gets git (ADR-042). The token is handed to git for one call through
// the process environment and a credential helper that reads it from there; it is never written
// to `.git/config`, the remote address, a message or a log.

export interface GitRemoteState {
  /** The origin address without any user part. */
  url: string;
  /** Commits here that the remote's last known state does not have, and the reverse. */
  ahead: number;
  behind: number;
  diverged: boolean;
  /** Whether the branch is on the remote at all (false before the first push). */
  pushed: boolean;
  /** When this PC last pushed (from git's own record of the remote branch), ISO. */
  lastPush: string | null;
}

export interface GitStatus {
  /** False: the folder is not a repository of its own (no line in the panel). */
  repository: boolean;
  branch: string | null;
  /** 저장점 count on the branch. */
  commits: number;
  /** Changed paths the next 저장점 would take (ignored files left out). */
  dirty: number;
  /** Of those: new files, and changed or removed ones. */
  added: number;
  modified: number;
  remote: GitRemoteState | null;
  /** The one-line message VIDE proposes for the next 저장점. */
  draft: string;
}

/** A server share: `\\server\share\…` (or the same with forward slashes). */
export const onServerShare = (root: string) => /^(\\\\|\/\/)[^\\/]/.test(root);

function assertLocal(root: string) {
  if (onServerShare(root)) throw new DomainError('WORKSPACE_READ_ONLY');
}

/** One history action per folder at a time (a push and a commit never interleave). */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(root: string, work: () => Promise<T>): Promise<T> {
  const key = root.toLowerCase();
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

/** The folder must be a repository of its own: a folder inside another repository is not. */
async function requireRepository(root: string) {
  if (!(await gitAvailability()).available) throw new DomainError('GIT_UNAVAILABLE');
  if (!(await exists(join(root, '.git')))) throw new DomainError('NO_REPOSITORY');
}

const HELPER =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$VIDE_GIT_TOKEN"; }; f';

/**
 * The git arguments and environment for one network call. Helpers from the PC's own git setup
 * are cleared (no credential window may open); with a token, one helper answers for
 * `https://github.com` only, reading the token from the environment of this call.
 */
export function gitAuth(token?: string): { args: string[]; env: Record<string, string> } {
  const args = ['-c', 'credential.helper='];
  const env: Record<string, string> = { GCM_INTERACTIVE: 'never' };
  if (token) {
    args.push('-c', `credential.https://github.com.helper=${HELPER}`);
    // The token is in this call's environment: the folder's own hooks (pre-push…) do not run
    // with it (a hooks folder that does not exist).
    args.push('-c', `core.hooksPath=${join(tmpdir(), 'vide-no-git-hooks')}`);
    env.VIDE_GIT_TOKEN = token;
  }
  return { args, env };
}

/** An address with any `user:password@` part removed (what the panel may show). */
const plainUrl = (url: string) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');

const pad = (value: number) => String(value).padStart(2, '0');
/** '작업 저장 2026-10-15 14:05 · 바뀐 파일 3' */
export function commitDraft(changed: number, now = new Date()) {
  const when = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `작업 저장 ${when} · 바뀐 파일 ${changed}`;
}

async function changes(root: string) {
  const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root);
  if (status.code !== 0) throw new DomainError('GIT_FAILED');
  const parts = status.stdout.split('\0');
  let added = 0;
  let modified = 0;
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    if (code === '??' || code[0] === 'A') added++;
    else modified++;
    // A rename or copy is followed by its old path.
    if (code[0] === 'R' || code[0] === 'C') i++;
  }
  return { added, modified, dirty: added + modified };
}

async function currentBranch(root: string) {
  const head = await run(['symbolic-ref', '--short', '-q', 'HEAD'], root);
  return head.code === 0 && head.stdout.trim() ? head.stdout.trim() : null;
}

async function originUrl(root: string) {
  const url = await run(['remote', 'get-url', 'origin'], root);
  return url.code === 0 && url.stdout.trim() ? url.stdout.trim() : null;
}

async function lastPushOf(root: string, branch: string) {
  const log = await run(
    [
      'reflog',
      'show',
      '-n',
      '50',
      '--date=iso-strict',
      '--format=%gd%x09%gs',
      `refs/remotes/origin/${branch}`,
      '--',
    ],
    root,
  );
  if (log.code !== 0) return null;
  for (const line of log.stdout.split('\n')) {
    const [selector, subject] = line.split('\t');
    if (!/^update by push/i.test(subject ?? '')) continue;
    const when = /@\{(.+)\}$/.exec(selector ?? '')?.[1];
    const date = when ? new Date(when) : null;
    if (date && !Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

async function remoteState(
  root: string,
  branch: string | null,
  commits: number,
): Promise<GitRemoteState | null> {
  const url = await originUrl(root);
  if (!url) return null;
  const tracking = branch ? `refs/remotes/origin/${branch}` : null;
  const known =
    !!tracking && (await run(['rev-parse', '--verify', '-q', tracking], root)).code === 0;
  if (!known || !branch)
    return {
      url: plainUrl(url),
      ahead: commits,
      behind: 0,
      diverged: false,
      pushed: false,
      lastPush: null,
    };
  const counts = await run(['rev-list', '--left-right', '--count', `HEAD...${tracking}`], root);
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  const a = Number.isFinite(ahead) ? ahead : 0;
  const b = Number.isFinite(behind) ? behind : 0;
  return {
    url: plainUrl(url),
    ahead: a,
    behind: b,
    diverged: a > 0 && b > 0,
    pushed: true,
    lastPush: await lastPushOf(root, branch),
  };
}

async function readStatus(root: string): Promise<GitStatus> {
  const branch = await currentBranch(root);
  const count = await run(['rev-list', '--count', 'HEAD'], root);
  const commits = count.code === 0 ? Number(count.stdout.trim()) || 0 : 0;
  const { added, modified, dirty } = await changes(root);
  return {
    repository: true,
    branch,
    commits,
    dirty,
    added,
    modified,
    remote: await remoteState(root, branch, commits),
    draft: commitDraft(dirty),
  };
}

const NOT_A_REPOSITORY: GitStatus = {
  repository: false,
  branch: null,
  commits: 0,
  dirty: 0,
  added: 0,
  modified: 0,
  remote: null,
  draft: '',
};

/** The history line: 저장점 count, uncommitted changes and the remote's last known state. */
export async function gitStatus(root: string): Promise<GitStatus> {
  assertLocal(root);
  if (!(await gitAvailability()).available) throw new DomainError('GIT_UNAVAILABLE');
  if (!(await exists(join(root, '.git')))) return { ...NOT_A_REPOSITORY };
  return readStatus(root);
}

async function identity(root: string) {
  const email = await run(['config', 'user.email'], root);
  const name = await run(['config', 'user.name'], root);
  return [
    ...(name.code === 0 && name.stdout.trim() ? [] : ['-c', 'user.name=VIDE']),
    ...(email.code === 0 && email.stdout.trim() ? [] : ['-c', 'user.email=vide@localhost']),
  ];
}

/**
 * [저장점 만들기]: every change the ignore list keeps, as one commit. `message` is the one line
 * the person edited (empty → the draft). Nothing to take is `NOTHING_TO_COMMIT`.
 */
export async function commit(root: string, message?: string): Promise<GitStatus> {
  assertLocal(root);
  return serial(root, async () => {
    await requireRepository(root);
    const added = await run(['add', '-A'], root, 120_000);
    if (added.code !== 0) throw new DomainError('GIT_FAILED');
    const staged = await run(['diff', '--cached', '--quiet'], root);
    if (staged.code === 0) throw new DomainError('NOTHING_TO_COMMIT');
    const files = await run(['diff', '--cached', '--name-only', '-z'], root);
    const count = files.stdout.split('\0').filter(Boolean).length;
    const line = (message ?? '').split(/\r?\n/)[0].trim().slice(0, 200) || commitDraft(count);
    const made = await run([...(await identity(root)), 'commit', '-m', line], root, 120_000);
    if (made.code !== 0) throw new DomainError('GIT_FAILED');
    return readStatus(root);
  });
}

/** The repository maker ensureRemote uses (a GithubApi with the person's token). */
export interface RepoMaker {
  me(): Promise<{ login: string }>;
  createRepo(name: string, isPrivate?: boolean): Promise<GithubRepo>;
  getRepo(owner: string, name: string): Promise<GithubRepo | null>;
}

export interface RemoteResult {
  status: GitStatus;
  /** True when a repository was made now. */
  created: boolean;
  /** `owner/name` when it came from GitHub now. */
  repository: string | null;
}

/**
 * The origin of the folder. Already set: left as it is. Otherwise a new repository named `name`
 * (default: the folder's name as lower-case kebab) in the person's account, private unless asked;
 * a taken name is `REMOTE_EXISTS`, and `reuse` sets origin to that existing repository instead
 * ([이어 쓰기]).
 */
export async function ensureRemote(
  root: string,
  options: { name?: string; private?: boolean; reuse?: boolean },
  github: () => Promise<RepoMaker>,
): Promise<RemoteResult> {
  assertLocal(root);
  return serial(root, async () => {
    await requireRepository(root);
    if (await originUrl(root))
      return { status: await readStatus(root), created: false, repository: null };
    const name = options.name?.trim() || repoNameOf(basename(root.replace(/[\\/]+$/, '')));
    if (!repoNamePattern.test(name)) throw new DomainError('INVALID_INPUT');
    const api = await github();
    let repo: GithubRepo;
    if (options.reuse) {
      const { login } = await api.me();
      const found = await api.getRepo(login, name);
      if (!found) throw new DomainError('NO_REMOTE');
      repo = found;
    } else repo = await api.createRepo(name, options.private !== false);
    const added = await run(['remote', 'add', 'origin', plainUrl(repo.cloneUrl)], root);
    if (added.code !== 0) throw new DomainError('GIT_FAILED');
    return { status: await readStatus(root), created: !options.reuse, repository: repo.fullName };
  });
}

/** git's refusal of a network call, as the codes the panel explains. */
function networkFailure(stderr: string): never {
  if (/\[rejected\]|non-fast-forward|fetch first|failed to push some refs/i.test(stderr))
    throw new DomainError('REMOTE_DIVERGED');
  if (
    /authentication failed|could not read (username|password)|terminal prompts disabled|permission to .* denied|\b403\b|invalid username or (password|token)/i.test(
      stderr,
    )
  )
    throw new DomainError('ACCOUNT_SCOPE');
  if (/repository not found|does not appear to be a git repository/i.test(stderr))
    throw new DomainError('NO_REMOTE');
  if (/could not resolve host|unable to access|timed out|connection (refused|reset)/i.test(stderr))
    throw new DomainError('SERVICE_UNREACHABLE');
  throw new DomainError('GIT_FAILED');
}

/**
 * [푸시]: the branch to origin (only a fast-forward there; the remote moved on is
 * `REMOTE_DIVERGED`). The person pressed it; nothing else calls this.
 */
export async function push(root: string, token: string): Promise<GitStatus> {
  assertLocal(root);
  return serial(root, async () => {
    await requireRepository(root);
    if (!(await originUrl(root))) throw new DomainError('NO_REMOTE');
    const branch = await currentBranch(root);
    if (!branch) throw new DomainError('GIT_FAILED');
    const auth = gitAuth(token);
    const pushed = await run(
      [...auth.args, 'push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`],
      root,
      180_000,
      auth.env,
    );
    if (pushed.code !== 0) {
      // Refused because the remote moved on: learn where it is, so the line keeps saying so.
      if (/\[rejected\]|non-fast-forward|fetch first/i.test(pushed.stderr))
        await run([...auth.args, 'fetch', 'origin'], root, 180_000, auth.env);
      networkFailure(pushed.stderr);
    }
    return readStatus(root);
  });
}

/**
 * [가져오기]: the remote's new 저장점 applied here as a fast-forward. Local 저장점 the remote does
 * not have is `REMOTE_DIVERGED` (never merged or rebased); uncommitted changes are
 * `UNCOMMITTED_CHANGES` (the panel offers [저장점 만들고 가져오기]). `token` is optional: a public
 * or local remote needs none.
 */
export async function pull(root: string, token?: string): Promise<GitStatus> {
  assertLocal(root);
  return serial(root, async () => {
    await requireRepository(root);
    if (!(await originUrl(root))) throw new DomainError('NO_REMOTE');
    const branch = await currentBranch(root);
    if (!branch) throw new DomainError('GIT_FAILED');
    const auth = gitAuth(token);
    const fetched = await run(
      [...auth.args, 'fetch', '--prune', 'origin'],
      root,
      180_000,
      auth.env,
    );
    if (fetched.code !== 0) networkFailure(fetched.stderr);
    const before = await readStatus(root);
    const remote = before.remote;
    if (!remote?.pushed || remote.behind === 0) return before;
    if (remote.ahead > 0) throw new DomainError('REMOTE_DIVERGED');
    if (before.dirty > 0) throw new DomainError('UNCOMMITTED_CHANGES');
    const merged = await run(
      ['merge', '--ff-only', '--no-edit', `refs/remotes/origin/${branch}`],
      root,
      120_000,
    );
    if (merged.code !== 0) throw new DomainError('REMOTE_DIVERGED');
    return readStatus(root);
  });
}

/** Codes of the history actions and their HTTP statuses (spread into the workspace routes). */
export const gitHistoryStatuses: Record<string, number> = {
  GIT_UNAVAILABLE: 409,
  NO_REPOSITORY: 409,
  NOTHING_TO_COMMIT: 409,
  NO_REMOTE: 409,
  REMOTE_EXISTS: 409,
  REMOTE_DIVERGED: 409,
  UNCOMMITTED_CHANGES: 409,
  GIT_FAILED: 500,
  ACCOUNT_NOT_CONNECTED: 409,
  ACCOUNT_SCOPE: 403,
  SERVICE_UNREACHABLE: 502,
};
