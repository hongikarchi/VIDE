// 연결 폴더의 구조 읽기 → 역할 제안 → 사람 확정 → 기억 (SPEC-01.13 8, ARCH-01 「작업 폴더(PLAN-52)」,
// PLAN-52 T-309, Design SCR-36). A connected folder (often a company share) keeps its own names and
// structure: VIDE reads only the top two levels (folder names, file counts by extension, whether
// external references show) and *guesses* a role per folder. Nothing is stored from a guess: only
// what a person confirms on the card (or names in a later sentence) goes to the work folder's
// manifest `server` part. File contents are never opened.
import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { DomainError } from '../contracts/errors.ts';
import type { ProjectFolder } from '../core/project-folders.ts';
import {
  manifestProjectId,
  realPathOf,
  updateServerMemory,
  VIDE_WORKSPACE_SCHEMA,
  workspaceOf,
  writeWorkspaceConfig,
  type VideWorkspaceConfig,
  type Workspace,
  type WorkspaceServer,
} from '../core/workspace-config.ts';
import {
  isWorkspaceRole,
  safeRelativeFolder,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from '../core/workspace-template.ts';
import { generatedFile, skipDir } from '../knowledge/collect/inventory.ts';

/** The words a person reads for each role (Design SCR-36 chips; §07 terms). */
export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  ops: '운영',
  raw: '자료',
  rhino: '모델',
  cad: '도면',
  review: '검토',
  output: '보고서',
  snapshots: '검토본',
  references: '레퍼런스',
  tools: '도구',
  archive: '아카이브',
};
/** Roles a connected folder usually has; one with no folder is named in `missing`. */
const EXPECTED: readonly WorkspaceRole[] = [
  'cad',
  'rhino',
  'raw',
  'references',
  'output',
  'archive',
];

/** Name tokens per role. ASCII tokens match as whole words; Korean ones as parts of the name. */
const NAME_TOKENS: Record<WorkspaceRole, readonly string[]> = {
  cad: ['도면', '캐드', '설계도', 'cad', 'dwg', 'drawing', 'drawings'],
  rhino: ['라이노', '모델', '모델링', 'rhino', '3dm', 'model', 'models', 'modeling'],
  output: ['보고서', '발표', '산출', '제출', '납품', 'report', 'output', 'presentation'],
  raw: ['원본', '자료', '법규', '대장', '측량', '지적', '받은', 'raw', 'source'],
  references: ['참고', '레퍼런스', '이미지', '사례', 'reference', 'references', 'ref', 'image'],
  archive: ['아카이브', '구버전', '백업', '이전', 'archive', 'backup', 'old'],
  ops: ['운영', '회의', '회의록', '일지', '협의', '업무', 'meeting', 'minutes'],
  review: ['분석', '검토', 'analysis', 'review'],
  snapshots: ['검토본', '스냅샷', 'snapshot', 'snapshots'],
  tools: ['도구', '엔진', '스크립트', 'tool', 'tools', 'script', 'scripts'],
};
/** Extensions that say what a folder holds (PDF says nothing on its own). */
const EXTENSION_ROLES: Record<string, WorkspaceRole> = {
  dwg: 'cad',
  dxf: 'cad',
  '3dm': 'rhino',
  gh: 'rhino',
  ghx: 'rhino',
  jpg: 'references',
  jpeg: 'references',
  png: 'references',
  webp: 'references',
  heic: 'references',
  gif: 'references',
  tif: 'references',
  tiff: 'references',
  pptx: 'output',
  ppt: 'output',
  indd: 'output',
  key: 'output',
  hwp: 'raw',
  hwpx: 'raw',
  xlsx: 'raw',
  xls: 'raw',
  csv: 'raw',
};
const XREF_NAME = /xref|x-ref|외부\s*참조|^x[-_]/i;

export type SchemaStatus = 'ok' | 'empty' | 'no-access' | 'unreachable';
export type SchemaConfidence = 'high' | 'medium' | 'low';
export interface SchemaFolder {
  /** Relative to the connected folder (`05 도면`, `05 보고서\VIDE`). */
  path: string;
  depth: 1 | 2;
  /** Files counted: the folder's own and, for a top folder, its sub folders' own. */
  files: number;
  byExtension: Record<string, number>;
  hasXref: boolean;
  xrefs: number;
  /** The guessed role; null when none or when two roles compete (`candidates`). */
  guess: WorkspaceRole | null;
  /** Two or more roles guessed for this one folder: a person picks (SPEC-01.13 8). */
  candidates: WorkspaceRole[];
  confidence: SchemaConfidence | null;
  /** The evidence a person reads: 'DWG 41개 · xref 3', '3dm 6개', '비어 있음'. */
  reason: string;
  /** The folder could not be read (its own contents only; the rest goes on). */
  unreadable?: boolean;
}
export interface SchemaProposal {
  /** The connected folder (real spelling, UNC for a share). */
  root: string;
  status: SchemaStatus;
  folders: SchemaFolder[];
  /** Expected roles no folder was guessed for ('보고서를 둘 곳이 보이지 않습니다'). */
  missing: WorkspaceRole[];
  /** Folders with competing guesses (their `path`). */
  conflicts: string[];
  /** Too many top folders: only one level was read (Design SCR-36 막힌 상태). */
  shallow: boolean;
  readAt: string;
}

export interface ScanOptions {
  /** More top folders than this: their sub folders are not read (`shallow`). */
  maxTopFolders?: number;
  /** Rows on the card at most. */
  maxRows?: number;
  /** For tests: the directory reader. */
  readDir?: (path: string) => Promise<Dirent[]>;
  now?: () => Date;
}

const readEntries = (path: string) => readdir(path, { withFileTypes: true });
const visible = (entries: Dirent[]) =>
  entries.filter((entry) =>
    entry.isDirectory()
      ? !skipDir(entry.name) && !entry.name.startsWith('.')
      : !generatedFile(entry.name),
  );
const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};
/** Why the folder itself could not be read: no permission, or gone / not reachable now. */
function failureOf(error: unknown): 'no-access' | 'unreachable' {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' ? 'no-access' : 'unreachable';
}

interface Counted {
  files: number;
  byExtension: Record<string, number>;
  xrefs: number;
}
function countFiles(entries: Dirent[], into: Counted, xrefFolder = false) {
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    into.files += 1;
    const ext = extensionOf(entry.name) || '(없음)';
    into.byExtension[ext] = (into.byExtension[ext] ?? 0) + 1;
    if ((ext === 'dwg' || ext === 'dxf') && (xrefFolder || XREF_NAME.test(entry.name)))
      into.xrefs += 1;
  }
}

/** The roles a folder name points at (a token inside a longer token of another role is dropped). */
export function nameRoles(name: string): WorkspaceRole[] {
  const plain = name.toLowerCase().replace(/^[\d\s._-]+/, '');
  const hits: { role: WorkspaceRole; token: string }[] = [];
  for (const role of WORKSPACE_ROLES)
    for (const token of NAME_TOKENS[role]) {
      const found = /^[a-z0-9]+$/.test(token)
        ? new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`).test(plain)
        : plain.includes(token);
      if (found) hits.push({ role, token });
    }
  const kept = hits.filter(
    (hit) =>
      !hits.some(
        (other) =>
          other.role !== hit.role &&
          other.token.length > hit.token.length &&
          other.token.includes(hit.token),
      ),
  );
  return [...new Set(kept.map((hit) => hit.role))];
}
/** The role most of a folder's telling files point at (3 files or more, 60 % or more). */
export function extensionRole(byExtension: Record<string, number>): WorkspaceRole | null {
  const counts = new Map<WorkspaceRole, number>();
  let total = 0;
  for (const [ext, count] of Object.entries(byExtension)) {
    const role = EXTENSION_ROLES[ext];
    if (!role) continue;
    counts.set(role, (counts.get(role) ?? 0) + count);
    total += count;
  }
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return best && best[1] >= 3 && best[1] / total >= 0.6 ? best[0] : null;
}
/** A folder's guess from its name and files (SPEC-01.13 8: an estimate, never stored by itself). */
export function inferRole(
  name: string,
  counted: Counted,
): Pick<SchemaFolder, 'guess' | 'candidates' | 'confidence'> {
  const byName = nameRoles(name);
  const byFiles = extensionRole(counted.byExtension);
  const strongFiles = byFiles === 'cad' || byFiles === 'rhino';
  if (byName.length === 1) {
    const [role] = byName;
    if (!byFiles || byFiles === role)
      return { guess: role, candidates: [], confidence: byFiles ? 'high' : 'medium' };
    // An archive or a raw-material folder holds drawings and models too; elsewhere the files win a say.
    if (strongFiles && role !== 'archive')
      return { guess: null, candidates: [role, byFiles], confidence: null };
    return { guess: role, candidates: [], confidence: 'medium' };
  }
  if (byName.length > 1) {
    if (byFiles && byName.includes(byFiles))
      return { guess: byFiles, candidates: [], confidence: 'medium' };
    return { guess: null, candidates: byName.slice(0, 3), confidence: null };
  }
  if (byFiles)
    return {
      guess: byFiles,
      candidates: [],
      confidence: byFiles === 'cad' && counted.xrefs ? 'medium' : 'low',
    };
  return { guess: null, candidates: [], confidence: null };
}
/** 'DWG 41개 · xref 3', '3dm 6개', '하위 폴더 4개', '비어 있음'. */
export function evidenceOf(counted: Counted, subFolders: number) {
  const top = Object.entries(counted.byExtension)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([ext, n]) => `${/^\d/.test(ext) || ext === '(없음)' ? ext : ext.toUpperCase()} ${n}개`);
  if (counted.xrefs) top.push(`xref ${counted.xrefs}`);
  if (!top.length) return subFolders ? `하위 폴더 ${subFolders}개` : '비어 있음';
  return top.join(' · ');
}

/**
 * Reads the top two levels of a connected folder and guesses a role per folder. Never throws for
 * the folder itself: a folder that cannot be read gives `no-access` or `unreachable`, one with
 * nothing in it `empty`. Sub folders that cannot be read are rows marked `unreadable`.
 */
export async function scanConnectedFolder(
  root: string,
  {
    maxTopFolders = 60,
    maxRows = 40,
    readDir = readEntries,
    now = () => new Date(),
  }: ScanOptions = {},
): Promise<SchemaProposal> {
  const base: SchemaProposal = {
    root,
    status: 'ok',
    folders: [],
    missing: [],
    conflicts: [],
    shallow: false,
    readAt: now().toISOString(),
  };
  let top: Dirent[];
  try {
    top = visible(await readDir(root));
  } catch (error) {
    return { ...base, status: failureOf(error) };
  }
  const dirs = top
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  if (!top.length) return { ...base, status: 'empty' };
  const shallow = dirs.length > maxTopFolders;
  const rows: SchemaFolder[] = [];
  const read = async (path: string) => {
    try {
      return { entries: visible(await readDir(path)) };
    } catch {
      return { entries: [] as Dirent[], failed: true };
    }
  };
  const tops = await Promise.all(
    dirs.map(async (dir) => {
      const path = join(root, dir.name);
      const own = await read(path);
      const counted: Counted = { files: 0, byExtension: {}, xrefs: 0 };
      countFiles(own.entries, counted, XREF_NAME.test(dir.name));
      const subs = own.entries.filter((entry) => entry.isDirectory());
      const children: { name: string; counted: Counted; failed?: boolean; subFolders: number }[] =
        [];
      if (!shallow)
        for (const sub of subs) {
          const inner = await read(join(path, sub.name));
          const mine: Counted = { files: 0, byExtension: {}, xrefs: 0 };
          countFiles(inner.entries, mine, XREF_NAME.test(sub.name) || XREF_NAME.test(dir.name));
          countFiles(inner.entries, counted, XREF_NAME.test(sub.name) || XREF_NAME.test(dir.name));
          children.push({
            name: sub.name,
            counted: mine,
            failed: inner.failed,
            subFolders: inner.entries.filter((entry) => entry.isDirectory()).length,
          });
        }
      return { dir, counted, failed: own.failed, subs: subs.length, children };
    }),
  );
  for (const { dir, counted, failed, subs, children } of tops) {
    const parent = inferRole(dir.name, counted);
    rows.push({
      path: dir.name,
      depth: 1,
      files: counted.files,
      byExtension: counted.byExtension,
      hasXref: counted.xrefs > 0,
      xrefs: counted.xrefs,
      ...parent,
      reason: failed ? '읽을 권한 없음' : evidenceOf(counted, subs),
      ...(failed ? { unreadable: true } : {}),
    });
    // A sub folder is a row of its own only when its name says another role than its parent's.
    for (const child of children) {
      const byName = nameRoles(child.name);
      if (!byName.length || (parent.guess && byName.includes(parent.guess))) continue;
      rows.push({
        path: join(dir.name, child.name),
        depth: 2,
        files: child.counted.files,
        byExtension: child.counted.byExtension,
        hasXref: child.counted.xrefs > 0,
        xrefs: child.counted.xrefs,
        ...inferRole(child.name, child.counted),
        reason: child.failed ? '읽을 권한 없음' : evidenceOf(child.counted, child.subFolders),
        ...(child.failed ? { unreadable: true } : {}),
      });
    }
  }
  const folders = rows.slice(0, maxRows);
  const seen = new Set(folders.flatMap((row) => (row.guess ? [row.guess] : row.candidates)));
  return {
    ...base,
    folders,
    shallow,
    missing: EXPECTED.filter((role) => !seen.has(role)),
    conflicts: folders.filter((row) => row.candidates.length > 1).map((row) => row.path),
  };
}

// ---------------------------------------------------------------------------------------------
// Which folder, where the memory lives

export interface SchemaSources {
  folders: { list(projectId: string): ProjectFolder[] };
  /** Whether an id is a project on this PC (a manifest naming another one conflicts). */
  isProject: (projectId: string) => boolean;
}
const same = (a: string, b: string) =>
  win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
const inside = (root: string, path: string) => {
  const r = win32.resolve(root).toLowerCase().replace(/\\+$/, '');
  const p = win32.resolve(path).toLowerCase();
  return p === r || p.startsWith(r + '\\');
};
/** The real spelling of a folder (a mapped drive as its share), or the spelling given. */
const realOf = (path: string) => {
  try {
    return realPathOf(path);
  } catch {
    return resolve(path);
  }
};

/** The work folder whose manifest keeps the memory, or why there is none to write. */
export async function memoryWorkspace(
  { folders, isProject }: SchemaSources,
  projectId: string,
): Promise<Workspace> {
  const found = await workspaceOf(folders, projectId, { isProject });
  if (!found) throw new DomainError('NO_WORKSPACE');
  if (found.cfg.schema !== VIDE_WORKSPACE_SCHEMA) throw new DomainError('WORKSPACE_READ_ONLY');
  const owner = manifestProjectId(found.cfg);
  if (owner && owner !== projectId) throw new DomainError('WORKSPACE_PROJECT_CONFLICT');
  return found;
}
/** The connected folders: project folders outside the work folder. */
function connectedFolders(list: readonly ProjectFolder[], workRoot: string) {
  return list.filter((folder) => folder.kind === 'project' && !inside(workRoot, folder.path));
}
/**
 * Whether a connected folder waits for a role proposal (T-309 trigger): the project has a VIDE work
 * folder and a connected folder that is not the one its memory is about. Never throws.
 */
export async function schemaPending(
  sources: SchemaSources,
  projectId: string,
): Promise<{ pending: boolean; folder?: string; remembered?: string | null }> {
  let ws: Workspace;
  try {
    ws = await memoryWorkspace(sources, projectId);
  } catch {
    return { pending: false };
  }
  const remembered = (ws.cfg as VideWorkspaceConfig).server?.root ?? null;
  const waiting = connectedFolders(sources.folders.list(projectId), ws.root).find(
    (folder) => !remembered || !same(realOf(folder.path), remembered),
  );
  return waiting
    ? { pending: true, folder: waiting.path, remembered }
    : { pending: false, remembered };
}
/** The connected folder to read: the one named (must be a project folder) or the waiting one. */
async function connectedFolderFor(
  sources: SchemaSources,
  projectId: string,
  ws: Workspace,
  given?: string,
) {
  const list = connectedFolders(sources.folders.list(projectId), ws.root);
  if (given) {
    const hit = list.find((folder) => same(folder.path, given));
    if (!hit) throw new DomainError('NOT_FOUND');
    return hit.path;
  }
  const remembered = (ws.cfg as VideWorkspaceConfig).server?.root ?? null;
  const waiting =
    list.find((folder) => !remembered || !same(realOf(folder.path), remembered)) ??
    list.find((folder) => remembered && same(realOf(folder.path), remembered));
  if (!waiting) throw new DomainError('NOT_FOUND');
  return waiting.path;
}

// ---------------------------------------------------------------------------------------------
// The card and its ledger record

export const SCHEMA_QUESTION_PREFIX = 'workspace-schema-';
export const isSchemaQuestion = (id: string) => id.startsWith(SCHEMA_QUESTION_PREFIX);
/** The card's three answers (Design SCR-36): store the guesses, store after edits, not now. */
export const SCHEMA_OPTIONS = {
  remember: '이대로 기억',
  edit: '고쳐서 기억',
  later: '나중에',
} as const;
export type SchemaOption = keyof typeof SCHEMA_OPTIONS;

/** What `appAction: 'workspace-schema'` records: the card's rows, as the answer checks them. */
export interface SchemaRecord {
  appAction: 'workspace-schema';
  by: 'ai';
  questionId: string;
  root: string;
  workspaceRoot: string;
  proposedAt: string;
  folders: Pick<SchemaFolder, 'path' | 'depth' | 'guess' | 'candidates' | 'reason'>[];
  missing: WorkspaceRole[];
  options: Record<SchemaOption, { label: string }>;
}

const folderName = (path: string) => win32.basename(path.replace(/[\\/]+$/, '')) || path;

/**
 * Reads the connected folder and, when there is something to propose, makes the card and its
 * record. `card` is undefined for the blocked states (no access, empty, unreachable, nothing).
 */
export async function proposeSchema(
  sources: SchemaSources,
  projectId: string,
  { folder, scan }: { folder?: string; scan?: ScanOptions } = {},
) {
  const ws = await memoryWorkspace(sources, projectId);
  const connected = await connectedFolderFor(sources, projectId, ws, folder);
  const root = realOf(connected);
  const proposal = await scanConnectedFolder(root, scan);
  const server = (ws.cfg as VideWorkspaceConfig).server ?? null;
  const remembered = server && same(server.root, root) ? server : null;
  if (proposal.status !== 'ok' || !proposal.folders.length)
    return { proposal, workspaceRoot: ws.root, remembered };
  const questionId = `${SCHEMA_QUESTION_PREFIX}${randomBytes(3).toString('hex')}`;
  const guessed = proposal.folders.filter((row) => row.guess).length;
  const card = {
    id: questionId,
    title: `폴더 역할 제안 · ${folderName(root)}`,
    options: [
      {
        id: 'remember',
        label: SCHEMA_OPTIONS.remember,
        hint: `추정한 역할 ${guessed}곳을 이 프로젝트의 기억으로 저장`,
        recommended: true,
      },
      {
        id: 'edit',
        label: SCHEMA_OPTIONS.edit,
        hint: '폴더마다 역할을 고른 뒤 저장',
        recommended: false,
      },
      {
        id: 'later',
        label: SCHEMA_OPTIONS.later,
        hint: '지금은 기억하지 않음',
        recommended: false,
      },
    ],
    blocks: '폴더 역할 기억',
    allowFree: false,
  };
  const record: SchemaRecord = {
    appAction: 'workspace-schema',
    by: 'ai',
    questionId,
    root,
    workspaceRoot: ws.root,
    proposedAt: proposal.readAt,
    folders: proposal.folders.map(({ path, depth, guess, candidates, reason }) => ({
      path,
      depth,
      guess,
      candidates,
      reason,
    })),
    missing: proposal.missing,
    options: {
      remember: { label: SCHEMA_OPTIONS.remember },
      edit: { label: SCHEMA_OPTIONS.edit },
      later: { label: SCHEMA_OPTIONS.later },
    },
  };
  return { proposal, workspaceRoot: ws.root, remembered, card, record };
}

/** The person's choice on a schema card: an option and the roles they set per row. */
export interface SchemaChoice {
  option: SchemaOption;
  /** Row path → role (or null = 역할 없음) the person set; rows left out keep the guess. */
  roles?: Record<string, WorkspaceRole | null>;
}
/**
 * What a person's answer stores (pure): role → server path for each row with a role. A row with
 * competing guesses that the person did not pick is left out (`skipped`); a second row with the
 * same role keeps the first (`extra`). `later` stores nothing (null).
 */
export function memoryFromChoice(record: Pick<SchemaRecord, 'folders'>, choice: SchemaChoice) {
  if (choice.option === 'later') return null;
  const known = new Set(record.folders.map((row) => row.path));
  for (const [path, role] of Object.entries(choice.roles ?? {}))
    if (!known.has(path) || (role !== null && !isWorkspaceRole(role)))
      throw new DomainError('INVALID_INPUT');
  const paths: Partial<Record<WorkspaceRole, string>> = {};
  const skipped: string[] = [];
  const extra: string[] = [];
  const picked = (row: SchemaRecord['folders'][number]) =>
    !!choice.roles && Object.hasOwn(choice.roles, row.path);
  // The person's own picks first: a guess never takes a role the person gave another folder.
  const order = [...record.folders.filter(picked), ...record.folders.filter((row) => !picked(row))];
  for (const row of order) {
    const role = picked(row)
      ? choice.roles![row.path]
      : row.candidates.length > 1
        ? undefined
        : row.guess;
    if (role === undefined) {
      skipped.push(row.path);
      continue;
    }
    if (role === null) continue;
    if (paths[role]) extra.push(row.path);
    else paths[role] = row.path;
  }
  return { paths, skipped, extra };
}
/** '폴더 역할 기억 · 도면=05 도면 · 자료=02 자료 · 보고서=반영할 때 묻기' (Design SCR-36). */
export function memorySummary(server: Pick<WorkspaceServer, 'paths' | 'targets'>) {
  const parts = WORKSPACE_ROLES.flatMap((role) => {
    const path = server.paths[role];
    const target = server.targets?.[role];
    if (path) return [`${ROLE_LABELS[role]}=${path}`];
    if (typeof target === 'string') return [`${ROLE_LABELS[role]}→${target}`];
    return [];
  });
  return `폴더 역할 기억 · ${parts.length ? parts.join(' · ') : '없음'}`;
}
const personName = () => {
  try {
    return userInfo().username || null;
  } catch {
    return null;
  }
};

/**
 * Stores what a person confirmed (`workspace_schema_confirm`, reached only from the card's answer):
 * the connected folder's role paths replace the memory for that folder; another folder's memory
 * is replaced whole. The connected folder must still be one of the project's folders.
 */
export async function confirmWorkspaceSchema(
  sources: SchemaSources,
  projectId: string,
  input: {
    root: string;
    paths: Partial<Record<WorkspaceRole, string>>;
    targets?: Partial<Record<WorkspaceRole, string | null>>;
    proposedAt?: string | null;
    confirmedBy?: string | null;
  },
  now = new Date(),
) {
  const ws = await memoryWorkspace(sources, projectId);
  const still = connectedFolders(sources.folders.list(projectId), ws.root).some(
    (folder) => same(realOf(folder.path), input.root) || same(folder.path, input.root),
  );
  if (!still) throw new DomainError('NOT_FOUND');
  for (const [role, path] of Object.entries(input.paths))
    if (!isWorkspaceRole(role) || !safeRelativeFolder(path)) throw new DomainError('INVALID_INPUT');
  const cfg = ws.cfg as VideWorkspaceConfig;
  const sameRoot = !!cfg.server && same(cfg.server.root, input.root);
  const start: VideWorkspaceConfig = sameRoot ? cfg : { ...cfg, server: null };
  const before = sameRoot ? (cfg.server?.paths ?? {}) : {};
  const paths: Partial<Record<WorkspaceRole, string | null>> = {};
  for (const role of WORKSPACE_ROLES)
    if (input.paths[role]) paths[role] = input.paths[role]!;
    else if (before[role]) paths[role] = null;
  const next = updateServerMemory(start, {
    root: input.root,
    paths,
    ...(input.targets ? { targets: input.targets } : {}),
    proposedAt: input.proposedAt ?? null,
    confirmedBy: input.confirmedBy ?? personName(),
    confirmedAt: now.toISOString(),
  });
  const written = await writeWorkspaceConfig(ws.root, next, now);
  return {
    workspaceRoot: ws.root,
    server: written.server!,
    summary: memorySummary(written.server!),
  };
}

/**
 * Changes one remembered value from a later sentence (`workspace_memory_set`): where a role's
 * files are on the server (`serverPath`) or where its outputs go back (`target`, null = '둘 곳
 * 없음'). The memory must exist; an absolute path must be inside the remembered server folder.
 */
export async function setWorkspaceMemory(
  sources: SchemaSources,
  projectId: string,
  input: { role: WorkspaceRole; serverPath?: string; target?: string | null },
  now = new Date(),
) {
  const ws = await memoryWorkspace(sources, projectId);
  const cfg = ws.cfg as VideWorkspaceConfig;
  const server = cfg.server;
  if (!server?.root) throw new DomainError('NO_SERVER_MEMORY');
  const relative = (value: string) => {
    const cleaned = value.trim().replace(/\//g, '\\').replace(/\\+$/, '');
    if (!win32.isAbsolute(cleaned)) return cleaned;
    if (!inside(server.root, cleaned) || same(server.root, cleaned))
      throw new DomainError('OUTSIDE_WORKSPACE');
    return win32.relative(server.root, cleaned);
  };
  const field = input.serverPath !== undefined ? 'paths' : 'targets';
  const value =
    input.serverPath !== undefined
      ? relative(input.serverPath)
      : input.target === null || input.target === undefined
        ? null
        : relative(input.target);
  if (value !== null && !safeRelativeFolder(value)) throw new DomainError('INVALID_INPUT');
  const before =
    field === 'paths' ? (server.paths[input.role] ?? null) : (server.targets?.[input.role] ?? null);
  const next = updateServerMemory(cfg, { [field]: { [input.role]: value } });
  const written = await writeWorkspaceConfig(ws.root, next, now);
  return {
    role: input.role,
    field,
    before,
    after: value,
    summary: memorySummary(written.server!),
    /** The change line (Design SCR-36): '기억 바뀜 · 보고서 → 05 보고서\VIDE'. */
    line: `기억 바뀜 · ${ROLE_LABELS[input.role]} → ${value ?? '둘 곳 없음'}`,
  };
}

/** Whether a path appears in the person's words (slashes, case and spaces around ignored). */
export function namedBy(words: readonly string[], path: string) {
  const norm = (text: string) => text.toLowerCase().replace(/\//g, '\\').replace(/\s+/g, ' ');
  const wanted = norm(path).replace(/\\+$/, '');
  // A whole path the person said, not a short piece of one ('05' or 'VIDE' of '05 보고서\VIDE').
  if (wanted.length < 3) return false;
  return words.some((word) => {
    const said = norm(word);
    for (let at = said.indexOf(wanted); at >= 0; at = said.indexOf(wanted, at + 1))
      if (said.charAt(at - 1) !== '\\' && said.charAt(at + wanted.length) !== '\\') return true;
    return false;
  });
}

/** The person asked for no place (둘 곳 없음 / 매번 묻기) in their own words. */
export const saidNoPlace = (words: readonly string[]) =>
  words.some((word) => /둘\s*곳\s*없|매번\s*물|그때그때\s*물|기억하지\s*마|지워|없애/.test(word));
