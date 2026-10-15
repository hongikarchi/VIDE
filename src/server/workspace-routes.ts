import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, win32 } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type { ProjectFolders } from '../core/project-folders.ts';
import {
  layoutOf,
  promoteConfig,
  readWorkspaceConfig,
  VIDE_WORKSPACE_SCHEMA,
  WORKSPACE_CONFIG_FILE,
  workspaceConfigStatuses,
  workspaceOf,
  writeWorkspaceConfig,
  type VideWorkspaceConfig,
  type Workspace,
  type WorkspaceConfig,
} from '../core/workspace-config.ts';
import {
  loadTemplate,
  safeRelativeFolder,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from '../core/workspace-template.ts';
import { writeGuideFiles } from '../core/workspace-files.ts';
import { pathKey } from '../core/xref-graph.ts';
import { checkFolder, type FileContext } from './project-files.ts';
import {
  commit,
  ensureRemote,
  gitAvailability,
  gitHistoryStatuses,
  gitStatus,
  initRepository,
  pull,
  push,
  type GitSetup,
} from './workspace-git.ts';
import { GithubApi, repoNameOf } from './github-api.ts';
import { checkoutRoutes, checkoutStatuses, type CheckoutRouteDeps } from './workspace-checkout.ts';

/**
 * 작업 폴더 (SPEC-01.13 7~10, ARCH-01 「작업 폴더(PLAN-52)」): `GET /api/v1/projects/:p/workspace`
 * (the project's work folder: root, schema, role paths resolved to absolute paths, server memory,
 * template), `GET …/workspace/paths` (root and role paths only, for the terminal entry point) and
 * `GET /api/v1/settings/workspace-template` (the template a new folder would get). A project with
 * no manifest in its project folders is `NO_WORKSPACE`. Later stages append their routes here.
 *
 * T-308/T-314 (this PC only, refused in a remote session): `GET /api/v1/workspace/git` (whether
 * git runs here), `POST /api/v1/workspace/inspect {dir}` (what a chosen folder is: its manifest,
 * the project it names, whether that project is here, another project that already has it),
 * `POST /api/v1/workspace/create {dir, name?, folders?, git?}` ([폴더로 만들기]: the role tree,
 * `project.config.json`, `README.md`, `AGENTS.md`, a new project with the folder as its first
 * project folder, optionally a local git repository) and `POST /api/v1/workspace/open {dir,
 * promote?}` ([폴더 열기]: the manifest's project made again with the same id, or opened when it is
 * here; a new one starts 자료 정리).
 */
export const workspaceStatuses: Record<string, number> = {
  ...workspaceConfigStatuses,
  NO_WORKSPACE: 404,
  WORKSPACE_EXISTS: 409,
  WORKSPACE_PROMOTE_REQUIRED: 409,
  WORKSPACE_ACCESS_DENIED: 403,
  // 체크아웃·서버에 반영 (T-310~T-312).
  ...checkoutStatuses,
  // 이력: 저장점·원격·푸시·가져오기 (PLAN-54 T-346).
  ...gitHistoryStatuses,
};

export interface WorkspaceRouteDeps {
  folders: ProjectFolders;
  /** Throws NOT_FOUND for an unknown project. */
  project: (projectId: string) => unknown;
  /** Whether an id is a project on this PC (a manifest naming another one here conflicts). */
  isProject: (projectId: string) => boolean;
  /** `<데이터>`; undefined for an in-memory store (the default template). */
  dataDirectory: string | undefined;
  send: (status: number, value: unknown) => void;
  /** The create/open routes (T-308); without them those paths are not routed here. */
  setup?: WorkspaceSetupDeps;
  /** 체크아웃·서버에 반영·도면 보호 (T-310~T-312); without it those paths are not routed here. */
  checkout?: CheckoutRouteDeps;
  /** 이력 — 저장점·원격·푸시·가져오기 (PLAN-54 T-346); without it those paths are not routed here. */
  history?: WorkspaceHistoryDeps;
}

export interface WorkspaceHistoryDeps {
  body: () => Promise<Record<string, unknown>>;
  /** A remote session reads the history line but never commits, pushes or pulls. */
  remote: boolean;
  /**
   * The person's GitHub account (설정 → 외부 서비스): its REST address and token
   * (`accountConnection(settings, 'github')`); throws ACCOUNT_NOT_CONNECTED or ACCOUNT_SCOPE.
   */
  github: () => Promise<{ api: string; token: string; timeoutMs?: number }>;
  /** [폴더 열기] for a folder that differs from its remote (default: Explorer). */
  launch?: (path: string) => void;
}

const explorer = (path: string) =>
  // A start that fails emits 'error'; unheard, it would end the engine.
  spawn('explorer.exe', [path], { detached: true, stdio: 'ignore', windowsHide: false })
    .on('error', () => {})
    .unref();

export interface WorkspaceSetupDeps {
  body: () => Promise<Record<string, unknown>>;
  /** A remote session sees projects but never makes folders on this PC. */
  remote: boolean;
  /** Where folders may be (checkFolder's rule: no drive root, no VIDE data, no key folders). */
  context: FileContext;
  /** Every project on this PC (to find one that already has the folder). */
  projects: () => { id: string; name: string }[];
  /** Creates the project with this id, or renames it (Store.ensureProject); may be async. */
  ensureProject: (id: string, name: string) => unknown;
  /** Starts 자료 정리 for a project (KnowledgeCollector.start); its refusals are reported. */
  collect?: (projectId: string) => Promise<unknown>;
  /** Tells the account site about a new project (RemoteAccess.pushProject). */
  announce?: (project: { id: string; name: string }) => Promise<unknown>;
  /** Who makes the folder (`vide.createdBy`); the Windows user name when absent. */
  actor?: () => string | null | undefined;
}

/** The project's work folder or `NO_WORKSPACE`. */
export async function requireWorkspace(
  folders: ProjectFolders,
  projectId: string,
  isProject: (projectId: string) => boolean,
): Promise<Workspace> {
  const found = await workspaceOf(folders, projectId, { isProject });
  if (!found) throw new DomainError('NO_WORKSPACE');
  return found;
}

/** True when the route was this one. */
export async function workspaceRoutes(
  url: URL,
  method: string | undefined,
  {
    folders,
    project,
    isProject,
    dataDirectory,
    send,
    setup,
    checkout,
    history,
  }: WorkspaceRouteDeps,
) {
  if (checkout && (await checkoutRoutes(url, method, project, send, checkout))) return true;
  const action = /^\/api\/v1\/workspace\/(git|inspect|create|open)$/.exec(url.pathname)?.[1];
  if (action && setup) {
    if (setup.remote) throw new DomainError('FORBIDDEN');
    if (action === 'git') {
      if (method !== 'GET') throw new DomainError('NOT_FOUND');
      send(200, await gitAvailability(url.searchParams.has('fresh')));
      return true;
    }
    if (method !== 'POST') throw new DomainError('NOT_FOUND');
    const deps = { folders, isProject, dataDirectory, ...setup };
    if (action === 'inspect') send(200, await inspectFolder(await setup.body(), deps));
    else if (action === 'create') send(201, await createWorkspace(await setup.body(), deps));
    else send(200, await openWorkspace(await setup.body(), deps));
    return true;
  }
  const historyMatch =
    history &&
    /^\/api\/v1\/projects\/([^/]+)\/workspace\/git\/(status|commit|remote|push|pull|open)$/.exec(
      url.pathname,
    );
  if (history && historyMatch) {
    const [, projectId, step] = historyMatch;
    send(
      200,
      await historyRoute(step, method, projectId, { folders, project, isProject, history }),
    );
    return true;
  }
  if (url.pathname === '/api/v1/settings/workspace-template') {
    if (method !== 'GET') throw new DomainError('NOT_FOUND');
    send(200, await loadTemplate(dataDirectory));
    return true;
  }
  const match = /^\/api\/v1\/projects\/([^/]+)\/workspace(\/paths)?$/.exec(url.pathname);
  if (!match) return false;
  const [, projectId, pathsOnly] = match;
  if (method !== 'GET') throw new DomainError('NOT_FOUND');
  project(projectId);
  const found = await requireWorkspace(folders, projectId, isProject);
  if (pathsOnly) {
    send(200, { root: found.root, paths: found.paths });
    return true;
  }
  const { cfg } = found;
  send(200, {
    hasWorkspace: true,
    root: found.root,
    schema: found.schema,
    readOnly: found.readOnly,
    matched: found.matched,
    title: cfg.title ?? null,
    paths: found.paths,
    reviewParts: found.reviewParts,
    outside: found.outside,
    server: cfg.schema === 'vide-workspace/1' ? (cfg.server ?? null) : null,
    template: cfg.schema === 'vide-workspace/1' ? (cfg.template ?? null) : null,
    projectId: cfg.schema === 'vide-workspace/1' ? (cfg.vide?.projectId ?? null) : null,
  });
  return true;
}

// ---------------------------------------------------------------------------------------------
// 폴더로 만들기 · 폴더 열기 (T-308, T-314)

type SetupContext = WorkspaceSetupDeps & {
  folders: ProjectFolders;
  isProject: (projectId: string) => boolean;
  dataDirectory: string | undefined;
};

const dirSchema = z.string().min(1).max(4096);
const inspectSchema = z.object({ dir: dirSchema }).strict();
const createSchema = z
  .object({
    dir: dirSchema,
    name: z.string().max(200).optional(),
    /** Role → folder name; null or '' leaves that role out. Missing roles keep the template's. */
    folders: z.record(z.string(), z.string().max(200).nullable()).optional(),
    git: z.boolean().optional(),
  })
  .strict();
const openSchema = z.object({ dir: dirSchema, promote: z.boolean().optional() }).strict();

const accessCodes = new Set(['EACCES', 'EPERM', 'EROFS']);
/** File system refusals as `WORKSPACE_ACCESS_DENIED`; anything else unchanged. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (accessCodes.has((error as NodeJS.ErrnoException).code ?? ''))
      throw new DomainError('WORKSPACE_ACCESS_DENIED');
    throw error;
  }
}

/** Another project on this PC that already has `root` as a project folder. */
/** Projects here that already have `root` as a project folder. */
function ownersOf(root: string, deps: SetupContext) {
  const key = pathKey(root);
  const owners: { id: string; name: string }[] = [];
  for (const row of deps.projects()) {
    let listed;
    try {
      listed = deps.folders.list(row.id);
    } catch {
      continue;
    }
    if (listed.some((folder) => folder.kind === 'project' && pathKey(folder.path) === key))
      owners.push({ id: row.id, name: row.name });
  }
  return owners;
}

function ownerOf(root: string, deps: SetupContext, except?: string) {
  return ownersOf(root, deps).find((row) => row.id !== except) ?? null;
}

/**
 * The project a manifest without its own project id is opened as: the one project here that
 * already has the folder (규모검토 folders added before), else a new id. Two owners conflict.
 */
function adoptedId(root: string, deps: SetupContext) {
  const owners = ownersOf(root, deps);
  if (owners.length > 1) throw new DomainError('WORKSPACE_PROJECT_CONFLICT');
  return owners[0]?.id ?? randomUUID();
}

const folderName = (root: string) => win32.basename(root.replace(/[\\/]+$/, '')) || root;

const actorOf = (deps: SetupContext) => {
  try {
    return deps.actor?.() || userInfo().username || null;
  } catch {
    return null;
  }
};

/** The 1-based line a JSON parse failure points at, when the engine says where. */
function brokenLine(text: string): number | undefined {
  try {
    JSON.parse(text.replace(/^﻿/, ''));
    return undefined;
  } catch (error) {
    const message = String((error as Error).message);
    const line = /line (\d+)/.exec(message);
    if (line) return Number(line[1]);
    const position = /position (\d+)/.exec(message);
    if (!position) return undefined;
    return text.slice(0, Number(position[1])).split('\n').length;
  }
}

/** What a chosen folder is, for the confirm card (never throws for a broken manifest). */
export async function inspectFolder(input: Record<string, unknown>, deps: SetupContext) {
  const { dir } = inspectSchema.parse(input);
  const root = await checkFolder(dir, deps.context);
  const owners = ownersOf(root, deps);
  const owner = owners[0] ?? null;
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (accessCodes.has((error as NodeJS.ErrnoException).code ?? ''))
      return { path: root, name: folderName(root), state: 'denied' as const, owner };
  }
  const base = { path: root, name: folderName(root), empty: entries.length === 0, owner };
  let cfg: WorkspaceConfig | null;
  try {
    cfg = await readWorkspaceConfig(root);
  } catch (error) {
    if ((error as DomainError).code !== 'WORKSPACE_CONFIG_INVALID') throw error;
    const text = await readFile(join(root, WORKSPACE_CONFIG_FILE), 'utf8').catch(() => '');
    return { ...base, state: 'invalid' as const, line: brokenLine(text) ?? null };
  }
  if (!cfg) return { ...base, state: 'none' as const };
  const projectId = cfg.schema === VIDE_WORKSPACE_SCHEMA ? (cfg.vide?.projectId ?? null) : null;
  // A manifest without its project id opens as the one project that already has the folder.
  const adopted = !projectId && owners.length === 1 ? owners[0] : null;
  const here =
    adopted ?? (projectId ? (deps.projects().find((row) => row.id === projectId) ?? null) : null);
  return {
    ...base,
    state: 'config' as const,
    schema: cfg.schema,
    title: cfg.title ?? null,
    projectId,
    createdAt: cfg.schema === VIDE_WORKSPACE_SCHEMA ? (cfg.vide?.createdAt ?? null) : null,
    roles: Object.keys(layoutOf(cfg).roles).length,
    here: here ? { id: here.id, name: here.name } : null,
    // The folder belongs to another project here than the one its manifest names.
    owner: adopted ? null : (owners.find((row) => row.id !== projectId) ?? null),
  };
}

/** Role paths of a new folder: the template's names with the person's edits (null/'' = none). */
function chosenPaths(
  template: Record<WorkspaceRole, string>,
  edits: Record<string, string | null> | undefined,
): Partial<Record<WorkspaceRole, string>> {
  for (const key of Object.keys(edits ?? {}))
    if (!(WORKSPACE_ROLES as readonly string[]).includes(key))
      throw new DomainError('INVALID_INPUT');
  const paths: Partial<Record<WorkspaceRole, string>> = {};
  for (const role of WORKSPACE_ROLES) {
    const edited = edits && role in edits ? edits[role] : template[role];
    const value = typeof edited === 'string' ? edited.trim() : edited;
    if (!value) continue;
    if (!safeRelativeFolder(value)) throw new DomainError('INVALID_INPUT');
    paths[role] = value;
  }
  const keys = Object.values(paths).map((path) => win32.normalize(path!).toLowerCase());
  if (new Set(keys).size !== keys.length) throw new DomainError('INVALID_INPUT');
  return paths;
}

async function absolutePaths(deps: SetupContext, projectId: string) {
  const found = await workspaceOf(deps.folders, projectId, { isProject: deps.isProject });
  return found?.paths ?? {};
}

const NO_GIT = { mode: 'none', root: null, branch: null, remote: null } as const;

/**
 * [폴더로 만들기]: the role folders, `project.config.json`, `README.md` and `AGENTS.md` in `dir`,
 * a new project (its id in the manifest) with `dir` as its first project folder, and — when asked
 * and git runs here — a local repository with a first commit (T-314).
 */
export async function createWorkspace(input: Record<string, unknown>, deps: SetupContext) {
  const value = createSchema.parse(input);
  const root = await checkFolder(value.dir, deps.context);
  // A folder that already has a manifest is opened, not made again (a broken one says so).
  if (await guarded(() => readWorkspaceConfig(root))) throw new DomainError('WORKSPACE_EXISTS');
  if (ownerOf(root, deps)) throw new DomainError('WORKSPACE_PROJECT_CONFLICT');
  const { template } = await loadTemplate(deps.dataDirectory);
  const paths = chosenPaths(template.folders, value.folders);
  const name = value.name?.trim() || folderName(root);
  const id = randomUUID();
  const wantsGit = value.git === true && (await gitAvailability()).available;
  const cfg: VideWorkspaceConfig = {
    schema: VIDE_WORKSPACE_SCHEMA,
    project_id: id,
    title: name,
    paths: paths as VideWorkspaceConfig['paths'],
    template: { name: template.name, version: template.version },
    git: wantsGit
      ? { mode: 'project-local', root: '.', branch: 'main', remote: null }
      : { ...NO_GIT },
    vide: { projectId: id, createdBy: actorOf(deps), createdAt: new Date().toISOString() },
  };
  // Files first: a refused folder leaves no project behind.
  let written = await guarded(async () => {
    for (const relative of Object.values(paths))
      await mkdir(win32.resolve(root, relative!), { recursive: true });
    const saved = await writeWorkspaceConfig(root, cfg);
    await writeGuideFiles(root, {
      name,
      cfg: saved,
      readme: template.readme,
      agents: template.agents,
    });
    return saved;
  });
  await deps.ensureProject(id, name);
  deps.folders.add(id, root, 'project');
  let git: GitSetup | null = null;
  if (value.git) {
    git = wantsGit ? await initRepository(root, paths) : { state: 'unavailable' };
    if (
      wantsGit &&
      git.state !== 'committed' &&
      git.state !== 'initialized' &&
      git.state !== 'exists'
    )
      written = await writeWorkspaceConfig(root, { ...written, git: { ...NO_GIT } }).catch(
        () => written,
      );
  }
  void written;
  await deps.announce?.({ id, name }).catch(() => undefined);
  return { project: { id, name }, root, paths: await absolutePaths(deps, id), git };
}

/**
 * [폴더 열기]: the manifest's project made again with the same id (재현), or the one here opened.
 * A 규모검토 manifest becomes `vide-workspace/1` only when the person confirmed (`promote`); its
 * fields are kept. A project made again starts 자료 정리; refusals there are reported, not thrown.
 */
export async function openWorkspace(input: Record<string, unknown>, deps: SetupContext) {
  const { dir, promote } = openSchema.parse(input);
  const root = await checkFolder(dir, deps.context);
  let cfg = await guarded(() => readWorkspaceConfig(root));
  if (!cfg) throw new DomainError('NO_WORKSPACE');
  // Ownership is settled before anything is written: a refused folder keeps its file as it was.
  const named = cfg.schema === VIDE_WORKSPACE_SCHEMA ? cfg.vide?.projectId : undefined;
  if (named && ownerOf(root, deps, named)) throw new DomainError('WORKSPACE_PROJECT_CONFLICT');
  if (cfg.schema !== VIDE_WORKSPACE_SCHEMA) {
    if (!promote) throw new DomainError('WORKSPACE_PROMOTE_REQUIRED');
    const promoted = promoteConfig(cfg, {
      projectId: adoptedId(root, deps),
      createdBy: actorOf(deps),
    });
    cfg = await guarded(() => writeWorkspaceConfig(root, promoted));
  } else if (!named) {
    // A VIDE manifest written by hand without its project: give it one, keep the rest.
    const given: VideWorkspaceConfig = {
      ...cfg,
      vide: {
        ...(cfg.vide ?? {}),
        projectId: adoptedId(root, deps),
        createdBy: actorOf(deps),
        createdAt: new Date().toISOString(),
      },
    };
    cfg = await guarded(() => writeWorkspaceConfig(root, given));
  }
  const vide = cfg as VideWorkspaceConfig;
  const id = vide.vide!.projectId;
  if (ownerOf(root, deps, id)) throw new DomainError('WORKSPACE_PROJECT_CONFLICT');
  const here = deps.projects().find((row) => row.id === id);
  const name = here?.name ?? (vide.title?.trim() || folderName(root));
  if (!here) await deps.ensureProject(id, name);
  deps.folders.add(id, root, 'project');
  // The VIDE part of the guide files follows the manifest; the person's text stays.
  await writeGuideFiles(root, { name, cfg: vide }).catch(() => undefined);
  let collect: { requested: boolean; state?: string; error?: string } = { requested: false };
  if (!here) {
    await deps.announce?.({ id, name }).catch(() => undefined);
    if (deps.collect)
      try {
        const state = (await deps.collect(id)) as { state?: string } | undefined;
        collect = { requested: true, state: state?.state };
      } catch (error) {
        collect = {
          requested: true,
          error: (error as DomainError).code ?? String((error as Error).message ?? error),
        };
      }
  }
  return {
    project: { id, name },
    created: !here,
    root,
    paths: await absolutePaths(deps, id),
    collect,
  };
}

// ---------------------------------------------------------------------------------------------
// 이력 — 저장점·원격·푸시·가져오기 (PLAN-54 T-346, SPEC-05.11, Design SCR-42)

const commitSchema = z.object({ message: z.string().max(2000).optional() }).strict();
const remoteSchema = z
  .object({
    name: z.string().max(100).optional(),
    private: z.boolean().optional(),
    reuse: z.boolean().optional(),
  })
  .strict();

/** Whether a usable GitHub token is set (the panel's [푸시] is dim without one); never the token. */
async function githubConnected(history: WorkspaceHistoryDeps) {
  try {
    return !!(await history.github()).token;
  } catch {
    return false;
  }
}

/**
 * `GET …/workspace/git/status` → GitStatus + `github` (a token is set) + `suggestedName`;
 * `POST …/commit {message?}`, `…/remote {name?, private?, reuse?}`, `…/push`, `…/pull` and
 * `…/open` (the folder in Explorer, for a folder that differs from its remote) — this PC only.
 * A folder on a server share is `WORKSPACE_READ_ONLY`.
 */
async function historyRoute(
  step: string,
  method: string | undefined,
  projectId: string,
  {
    folders,
    project,
    isProject,
    history,
  }: Pick<WorkspaceRouteDeps, 'folders' | 'project' | 'isProject'> & {
    history: WorkspaceHistoryDeps;
  },
) {
  if (step === 'status' ? method !== 'GET' : method !== 'POST') throw new DomainError('NOT_FOUND');
  if (step !== 'status' && history.remote) throw new DomainError('FORBIDDEN');
  project(projectId);
  const { root } = await requireWorkspace(folders, projectId, isProject);
  if (step === 'status')
    return {
      ...(await gitStatus(root)),
      github: await githubConnected(history),
      suggestedName: repoNameOf(folderName(root)),
    };
  if (step === 'commit') {
    const { message } = commitSchema.parse(await history.body());
    return commit(root, message);
  }
  if (step === 'remote') {
    const value = remoteSchema.parse(await history.body());
    return ensureRemote(root, value, async () => {
      const { api, token, timeoutMs } = await history.github();
      return new GithubApi({ token, base: api, timeoutMs });
    });
  }
  if (step === 'push') return push(root, (await history.github()).token);
  if (step === 'open') {
    (history.launch ?? explorer)(root);
    return { opened: true };
  }
  // A pull needs no token for a public or local remote; with one it reads a private one too.
  let token: string | undefined;
  try {
    token = (await history.github()).token;
  } catch {
    token = undefined;
  }
  return pull(root, token);
}
