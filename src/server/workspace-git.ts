// 프로젝트 로컬 git 준비 (PLAN-52 T-314, ADR-042): when [폴더로 만들기] has '이력 관리(git)' on, the
// new work folder becomes a git repository with a default `.gitignore` and a first commit. No
// remote, no push, no account (PLAN-54). The ignore list follows the 규모검토 folder (논현동 7-3):
// binaries, originals, archives and outputs stay out; the manifest, analysis JSON, md and HTML are
// tracked. Folder names come from the manifest's role paths, never from code.
import { execFile } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceRole } from '../core/workspace-template.ts';

const run = (args: string[], cwd?: string, timeout = 30_000) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
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
  return [
    '# VIDE 작업 폴더 — 설정·분석 JSON·md·HTML만 기록합니다(모델·도면·원본·산출물·보관 제외).',
    '# 이 파일은 사람이 고쳐도 됩니다. VIDE는 처음 만들 때만 씁니다.',
    '',
    '# 원본·산출물·보관 폴더',
    ...folders,
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
