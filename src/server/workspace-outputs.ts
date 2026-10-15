import { dayOf, jigFolderName, minuteOf, safeName } from '../core/workspace-paths.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../core/store.ts';
import type { Store } from '../core/store.ts';
import { ProjectFolders, type ProjectFolder } from '../core/project-folders.ts';
import {
  insideWorkspace,
  manifestProjectId,
  realPathOf,
  workspaceOf,
  type Workspace,
  type WorkspaceRole,
} from '../core/workspace-config.ts';

/**
 * VIDE 산출물의 작업 폴더 사본 (PLAN-52 T-313, SPEC-01.13 7, ARCH-01 「작업 폴더(PLAN-52)」 산출물
 * 경로). When a project has a work folder, what VIDE keeps in its DB or data folder is also written
 * into the role folders as a copy a person reads:
 *  - jig 결과 `<review>/<jig>/<YYYY-MM-DD-HHmm>-<instanceId 앞 8자리>/` (`data.json`, `report.html`),
 *  - 일지 `<ops>/일지/<날짜>.md`, 회의록(노트) `<ops>/회의록/<날짜>-<제목>.md`,
 *  - 검토본 `<snapshots>/<YYYY-MM-DD-HHmm>-<reviewId 앞 8자리>/검토본.html`,
 *  - 프로젝트 jig `<tools>/<jig>/README.md`·`jig.json`.
 * The DB stays the source; nothing here is read back. Every copy carries a marker line
 * (`vide-copy:<key>`) so VIDE rewrites only its own files: a file of the same name a person made is
 * never overwritten — the copy takes `-2`, `-3`, …. Writes are atomic (temp file + rename) and stay
 * under the work folder's real path (`OUTSIDE_WORKSPACE` otherwise). A project with no work folder
 * gets nothing here (its outputs stay in the data folder as before).
 */

type FolderSource = { list(projectId: string): ProjectFolder[] };
export interface WorkspaceOutputsOptions {
  folders: FolderSource;
  /** Whether an id is a project on this PC (a manifest naming another one here is not written to). */
  isProject?: (projectId: string) => boolean;
  now?: () => Date;
  /** Failures of the fire-and-forget writes (the engine's diagnostics log). */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** One finished jig run (the step outputs it kept). */
export interface JigRunCopy {
  jigId: string;
  instanceId: string;
  title: string;
  status?: string;
  mode?: string;
  outputs: Record<string, unknown>;
}
export interface JigReportCopy {
  reportId: string;
  title: string;
  html: string;
  /** The jig has only this report: the file is `report.html`, else `report-<id>.html`. */
  single: boolean;
}
export interface NoteCopy {
  id: string;
  kind: string;
  title: string;
  journalDate?: string | null;
  createdAt?: number | string;
}
export interface SnapshotCopy {
  id: string;
  title: string;
  createdAt?: string;
}
export interface ProjectJigCopy {
  id: string;
  version?: string;
  readme?: string;
  manifest?: string;
}

const MARK = 'vide-copy:';
const HEAD_BYTES = 4096;
// Folder and file names: one rule with the `vide` CLI (src/core/workspace-paths.ts).
export { dayOf, jigFolderName, minuteOf, safeName } from '../core/workspace-paths.ts';

/** The one-line marker of a copy in Markdown or HTML. */
export const copyHeader = (source: string, key: string) =>
  `<!-- VIDE 사본 · 정본은 ${source} · 직접 고쳐도 반영되지 않고 VIDE가 다시 쓴다 · ${MARK}${key} -->`;
/** The marker after `<!doctype html>` (a comment before it is allowed, but keep the doctype first). */
function markHtml(html: string, header: string) {
  const doctype = /^\s*<!doctype[^>]*>\s*/i.exec(html);
  return doctype
    ? doctype[0].trimEnd() + '\n' + header + '\n' + html.slice(doctype[0].length)
    : header + '\n' + html;
}

async function head(path: string): Promise<string> {
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}
/** Whether `path` is a VIDE copy written for `key` (the marker is in its first bytes). */
async function owned(path: string, key: string) {
  const text = await head(path);
  const at = text.indexOf(MARK + key);
  if (at < 0) return false;
  // The key ends there (no longer key with the same start).
  const next = text.charAt(at + MARK.length + key.length);
  return !/[A-Za-z0-9:_-]/.test(next);
}
const candidate = (base: string, n: number, ext = '') => `${base}${n === 1 ? '' : `-${n}`}${ext}`;

export class WorkspaceOutputs {
  private readonly options: WorkspaceOutputsOptions;
  /** Writes per project, in order (a later copy of the same item never lands before an earlier one). */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** The last run folder per instance, with the hash of its outputs. */
  private readonly runs = new Map<string, { dir: string; hash: string }>();
  log: (event: string, fields: Record<string, unknown>) => void;
  constructor(options: WorkspaceOutputsOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }

  /**
   * The work folder copies go to: the project's work folder when its manifest names this project
   * or names none (a 규모검토 manifest); null when there is none, or it is of another project, or
   * it cannot be read (the copies are skipped, the DB write stands).
   */
  async target(projectId: string): Promise<Workspace | null> {
    let found: Workspace | null;
    try {
      found = await workspaceOf(this.options.folders, projectId, {
        isProject: this.options.isProject,
      });
    } catch {
      return null;
    }
    if (!found) return null;
    const named = manifestProjectId(found.cfg);
    if (named && named !== projectId) return null;
    // A manifest that names no project (규모검토, not converted) on a network share is the
    // company server's folder: VIDE writes there only through [서버에 반영] (SPEC-01.13 9).
    if (!named && /^\\\\/.test(realPathOf(found.root))) return null;
    return found;
  }
  /** The role folder, or null when the project has no work folder or no such role. */
  async roleFolder(projectId: string, role: WorkspaceRole) {
    const ws = await this.target(projectId);
    const dir = ws?.paths[role];
    return ws && dir ? { root: ws.root, dir } : null;
  }

  /** Queues a write for the project; failures are logged and resolve to null. */
  private queue<T>(projectId: string, what: string, task: () => Promise<T>): Promise<T | null> {
    const previous = this.chains.get(projectId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      this.log('workspace-output-failed', {
        projectId,
        what,
        code: error instanceof DomainError ? error.code : 'WRITE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    this.chains.set(projectId, next);
    void next.finally(() => {
      if (this.chains.get(projectId) === next) this.chains.delete(projectId);
    });
    return next;
  }
  /** Resolves when every queued write has finished (tests, shutdown). */
  async idle() {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  // --- files -----------------------------------------------------------------------------------
  private check(root: string, path: string) {
    if (!insideWorkspace(root, path)) throw new DomainError('OUTSIDE_WORKSPACE');
  }
  /** Temp file + rename; an unchanged file is left as it is. */
  private async put(root: string, path: string, text: string) {
    this.check(root, path);
    if (existsSync(path)) {
      if ((await readFile(path, 'utf8').catch(() => null)) === text) return path;
    }
    const temp = `${path}.vide-${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(temp, text, 'utf8');
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    return path;
  }
  private async ensureDir(root: string, dir: string) {
    this.check(root, dir);
    await mkdir(dir, { recursive: true });
  }
  /**
   * The file for `key` in `dir`: `base.ext`, else `base-2.ext`, … skipping a file that is not this
   * copy. A copy of the same key under another name (the title changed) is removed once the new
   * one is written.
   */
  private async placeFile(root: string, dir: string, base: string, ext: string, key: string) {
    await this.ensureDir(root, dir);
    let previous: string | null = null;
    for (const name of await readdir(dir).catch(() => [] as string[]))
      if (name.endsWith(ext) && (await owned(join(dir, name), key))) {
        previous = join(dir, name);
        break;
      }
    for (let n = 1; ; n++) {
      const path = join(dir, candidate(base, n, ext));
      if (!existsSync(path) || (await owned(path, key)))
        return { path, stale: previous && previous !== path ? previous : null };
    }
  }
  /** A folder for `key` in `parent` (`base`, `base-2`, …): its `marker` file holds the key. */
  private async placeFolder(
    root: string,
    parent: string,
    base: string,
    marker: string,
    key: string,
  ) {
    await this.ensureDir(root, parent);
    for (let n = 1; ; n++) {
      const dir = join(parent, candidate(base, n));
      if (!existsSync(dir)) {
        await this.ensureDir(root, dir);
        return dir;
      }
      if (await owned(join(dir, marker), key)) return dir;
      // An empty folder this write made earlier (e.g. a crash before the marker) is reused.
      if (!(await readdir(dir).catch(() => ['?'])).length) return dir;
    }
  }

  // --- jig results -----------------------------------------------------------------------------
  private async runFolder(
    ws: Workspace,
    run: Pick<JigRunCopy, 'jigId' | 'instanceId'>,
    hash: string,
  ) {
    const review = ws.paths.review;
    if (!review) return null;
    const parent = join(review, jigFolderName(run.jigId));
    const last = this.runs.get(run.instanceId) ?? (await this.lastRun(parent, run.instanceId));
    if (last && existsSync(last.dir) && (last.hash === hash || !hash))
      return { ...last, fresh: false };
    const minute = minuteOf(this.now());
    const key = `jig-run:${run.instanceId}:${minute}`;
    const dir = await this.placeFolder(
      ws.root,
      parent,
      `${minute}-${run.instanceId.slice(0, 8)}`,
      'data.json',
      key,
    );
    return { dir, hash, fresh: true, key };
  }
  /** The newest run folder of an instance already in `parent` (after a restart). */
  private async lastRun(parent: string, instanceId: string) {
    const suffix = new RegExp(`-${instanceId.slice(0, 8).replace(/[^A-Za-z0-9]/g, '')}(-\\d+)?$`);
    const names = (await readdir(parent).catch(() => [] as string[]))
      .filter((name) => suffix.test(name))
      .sort()
      .reverse();
    for (const name of names) {
      const text = await head(join(parent, name, 'data.json'));
      if (!text.includes(`${MARK}jig-run:${instanceId}:`)) continue;
      const hash = /"hash":\s*"([0-9a-f]*)"/.exec(text)?.[1] ?? '';
      return { dir: join(parent, name), hash };
    }
    return null;
  }

  /**
   * A finished jig run → `<review>/<jig>/<회차>/data.json`. A run whose outputs equal the last
   * copied ones of the instance writes nothing; runs within the same minute share one folder.
   */
  writeJigResult(projectId: string, run: JigRunCopy): Promise<string | null> {
    return this.queue(projectId, 'jig-result', async () => {
      const ws = await this.target(projectId);
      if (!ws || !Object.keys(run.outputs).length) return null;
      const body = JSON.stringify(run.outputs);
      const hash = createHash('sha256').update(body).digest('hex');
      const place = await this.runFolder(ws, run, hash);
      if (!place) return null;
      if (!place.fresh) return place.dir;
      const at = this.now().toISOString();
      const text =
        '{"vide":' +
        JSON.stringify({
          copy: `VIDE 사본 · 정본은 VIDE 데이터(jig 결과) · ${MARK}${place.key}`,
          jigId: run.jigId,
          instanceId: run.instanceId,
          title: run.title,
          ...(run.status ? { status: run.status } : {}),
          ...(run.mode ? { mode: run.mode } : {}),
          at,
          hash,
        }) +
        ',"outputs":' +
        body +
        '}\n';
      await this.put(ws.root, join(place.dir, 'data.json'), text);
      this.runs.set(run.instanceId, { dir: place.dir, hash });
      return place.dir;
    });
  }

  /**
   * The 검토용 report of an instance → `report.html` (or `report-<id>.html`) in the instance's
   * latest run folder (made with the report's outputs when it has none yet). 보고용 등급은 PLAN-54.
   */
  writeJigReport(
    projectId: string,
    run: JigRunCopy,
    report: JigReportCopy,
  ): Promise<string | null> {
    return this.queue(projectId, 'jig-report', async () => {
      if (!report.html) return null;
      const ws = await this.target(projectId);
      if (!ws) return null;
      const body = JSON.stringify(run.outputs);
      const hash = Object.keys(run.outputs).length
        ? createHash('sha256').update(body).digest('hex')
        : '';
      const place = await this.runFolder(ws, run, '');
      if (!place) return null;
      if (place.fresh) {
        const text =
          '{"vide":' +
          JSON.stringify({
            copy: `VIDE 사본 · 정본은 VIDE 데이터(jig 결과) · ${MARK}${place.key}`,
            jigId: run.jigId,
            instanceId: run.instanceId,
            title: run.title,
            at: this.now().toISOString(),
            hash,
          }) +
          ',"outputs":' +
          body +
          '}\n';
        await this.put(ws.root, join(place.dir, 'data.json'), text);
        this.runs.set(run.instanceId, { dir: place.dir, hash });
      }
      const file = report.single ? 'report' : `report-${safeName(report.reportId, 'report')}`;
      const key = `jig-report:${run.instanceId}:${report.reportId}`;
      const { path } = await this.placeFile(ws.root, place.dir, file, '.html', key);
      await this.put(
        ws.root,
        path,
        markHtml(report.html, copyHeader(`VIDE jig 보고서(${report.title})`, key)),
      );
      return path;
    });
  }

  // --- operations (notes) ----------------------------------------------------------------------
  /**
   * A shared note's Markdown copy → `<ops>/일지/<날짜>.md` (journal) or `<ops>/회의록/<날짜>-<제목>.md`
   * (other notes). The site is the source.
   */
  writeNote(projectId: string, note: NoteCopy, markdown: string): Promise<string | null> {
    return this.queue(projectId, 'note', async () => {
      const place = await this.roleFolder(projectId, 'ops');
      if (!place) return null;
      const journal = note.kind === 'journal' && note.journalDate;
      const created = note.createdAt !== undefined ? new Date(note.createdAt) : this.now();
      const day = Number.isNaN(created.getTime()) ? dayOf(this.now()) : dayOf(created);
      const dir = join(place.dir, journal ? '일지' : '회의록');
      const base = journal ? safeName(String(note.journalDate)) : `${day}-${safeName(note.title)}`;
      return this.writeMarkdownIn(
        place.root,
        dir,
        base,
        `note:${note.id}`,
        '계정 사이트의 공유 노트',
        markdown,
      );
    });
  }
  /**
   * Any operations Markdown (`일지`, `회의록`, `할일` …) → `<ops>/<sub>/<name>.md`; `key` names the
   * item so a later copy of it replaces this one.
   */
  writeOpsMarkdown(
    projectId: string,
    copy: { sub: string; name: string; key: string; source: string },
    markdown: string,
  ): Promise<string | null> {
    return this.queue(projectId, 'ops', async () => {
      const place = await this.roleFolder(projectId, 'ops');
      if (!place) return null;
      return this.writeMarkdownIn(
        place.root,
        join(place.dir, safeName(copy.sub, '기타')),
        safeName(copy.name),
        copy.key,
        copy.source,
        markdown,
      );
    });
  }
  private async writeMarkdownIn(
    root: string,
    dir: string,
    base: string,
    key: string,
    source: string,
    markdown: string,
  ) {
    const { path, stale } = await this.placeFile(root, dir, base, '.md', key);
    await this.put(root, path, copyHeader(source, key) + '\n\n' + markdown.trimEnd() + '\n');
    if (stale && (await owned(stale, key))) await rm(stale, { force: true });
    return path;
  }

  // --- 검토본 ----------------------------------------------------------------------------------
  /** A review snapshot's page → `<snapshots>/<YYYY-MM-DD-HHmm>-<reviewId 앞 8자리>/검토본.html`. */
  writeSnapshot(projectId: string, review: SnapshotCopy, html: string): Promise<string | null> {
    return this.queue(projectId, 'snapshot', async () => {
      const place = await this.roleFolder(projectId, 'snapshots');
      if (!place) return null;
      const at = review.createdAt ? new Date(review.createdAt) : this.now();
      const minute = minuteOf(Number.isNaN(at.getTime()) ? this.now() : at);
      const key = `review:${review.id}`;
      const dir = await this.placeFolder(
        place.root,
        place.dir,
        `${minute}-${review.id.slice(0, 8)}`,
        '검토본.html',
        key,
      );
      return this.put(
        place.root,
        join(dir, '검토본.html'),
        markHtml(html, copyHeader(`VIDE 검토본(${review.title})`, key)),
      );
    });
  }

  // --- 프로젝트 jig ----------------------------------------------------------------------------
  /**
   * A project jig's description and manifest → `<tools>/<jig>/README.md`·`jig.json`. The README
   * carries the marker (a jig without one gets a short README from its manifest); `jig.json` is
   * the manifest as it is.
   */
  writeProjectJig(projectId: string, jig: ProjectJigCopy): Promise<string | null> {
    return this.queue(projectId, 'project-jig', async () => {
      const place = await this.roleFolder(projectId, 'tools');
      if (!place) return null;
      const key = `jig:${jig.id}`;
      const dir = await this.placeFolder(
        place.root,
        place.dir,
        jigFolderName(jig.id),
        'README.md',
        key,
      );
      const source = `VIDE에 설치된 프로젝트 jig(${jig.id}${jig.version ? ` ${jig.version}` : ''})`;
      const readme = jig.readme?.trim() || defaultReadme(jig);
      await this.put(
        place.root,
        join(dir, 'README.md'),
        copyHeader(source, key) + '\n\n' + readme + '\n',
      );
      if (jig.manifest !== undefined)
        await this.put(place.root, join(dir, 'jig.json'), jig.manifest);
      return dir;
    });
  }
}

function defaultReadme(jig: ProjectJigCopy) {
  let name = jig.id,
    description = '';
  try {
    const manifest = JSON.parse(jig.manifest ?? '{}') as { name?: unknown; description?: unknown };
    if (typeof manifest.name === 'string' && manifest.name.trim()) name = manifest.name.trim();
    if (typeof manifest.description === 'string') description = manifest.description.trim();
  } catch {
    /* a manifest that does not parse gives the id only */
  }
  return `# ${name}\n\n${description ? description + '\n\n' : ''}구성은 같은 폴더의 \`jig.json\`이다.`;
}

/**
 * Copies an installed project jig's `README.md` and `jig.json` from its package folder `dir`
 * into the work folder (after a pin). Never throws.
 */
export async function copyProjectJig(
  outputs: WorkspaceOutputs,
  projectId: string,
  jig: { id: string; version?: string; dir: string },
): Promise<string | null> {
  const read = (name: string) => readFile(join(jig.dir, name), 'utf8').catch(() => undefined);
  const [readme, manifest] = await Promise.all([read('README.md'), read('jig.json')]);
  return outputs.writeProjectJig(projectId, { id: jig.id, version: jig.version, readme, manifest });
}

const perStore = new WeakMap<Store, WorkspaceOutputs>();
/** The engine's writer for a store (one per store, so writes of a project stay in order). */
export function workspaceOutputsFor(store: Store): WorkspaceOutputs {
  let outputs = perStore.get(store);
  if (!outputs) {
    outputs = new WorkspaceOutputs({
      folders: new ProjectFolders(store),
      isProject: (id) => store.listProjects().some((project) => project.id === id),
    });
    perStore.set(store, outputs);
  }
  return outputs;
}
