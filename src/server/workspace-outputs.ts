import { dayOf, jigFolderName, minuteOf, safeName } from '../core/workspace-paths.ts';
import { scheduleMarkdown, scheduleMonths } from '../core/agenda-month.ts';
import type { AgendaItem } from '../contracts/agenda.ts';
import { journalTitle } from '../contracts/note-doc.ts';
import { RECORD_ORIGINALS } from '../contracts/records.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
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
  /**
   * `<데이터>`: where `projects/<id>/folder-copies.json` (the hash of each Markdown copy last
   * written, for '폴더에서 바뀜') is kept; absent, it is kept in memory only.
   */
  dataDirectory?: string;
}

/** One Markdown copy as last written (ARCH-01 「작업 폴더(PLAN-52)」 '폴더에서 바뀜' 판정). */
export interface FolderCopyRecord {
  path: string;
  sha256: string;
  writtenAt: string;
}
/** A copy's state for the notes screen (SPEC-10.10 3·4). */
export interface FolderCopyState {
  key: string;
  path: string | null;
  state: 'written' | 'changed-in-folder' | 'not-written';
  writtenAt: string | null;
}
const FOLDER_COPIES = 'folder-copies.json';
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

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
  /** Removed on the site: the copy stays, marked '사이트에서 지워짐' (SPEC-10.10 2). */
  deleted?: boolean;
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

/** The first line of a month's records copy (an object, so every line of the JSONL stays JSON). */
export const recordsCopyMarker = (month: string) =>
  JSON.stringify({ vide: `VIDE 사본 · 정본은 VIDE 기록 · ${MARK}records:${month}` });
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
  /** `folder-copies.json` per project (loaded on first use). */
  private readonly ledgers = new Map<string, Record<string, FolderCopyRecord>>();
  /** Copies that could not be written (권한·잠김·연결 끊김): project → key → path tried. */
  private readonly failed = new Map<string, Map<string, string | null>>();
  /** The last write asked for per copy (`project\0key`), run again by [버리기]. */
  private readonly redo = new Map<string, () => Promise<unknown>>();
  /** Copies [버리기] rewrites without the '폴더에서 바뀜' check. */
  private readonly forced = new Set<string>();
  /** The rows last written per records month (`project\0month`), without a data folder. */
  private readonly bases = new Map<string, string>();
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
  private async placeFile(
    root: string,
    dir: string,
    base: string,
    ext: string,
    key: string,
    aliases: string[] = [],
  ) {
    await this.ensureDir(root, dir);
    let previous: string | null = null;
    for (const name of await readdir(dir).catch(() => [] as string[]))
      if (name.endsWith(ext) && (await owned(join(dir, name), key))) {
        previous = join(dir, name);
        break;
      }
    for (let n = 1; ; n++) {
      const path = join(dir, candidate(base, n, ext));
      let owner: string | null = null;
      if (existsSync(path))
        for (const k of [key, ...aliases])
          if (await owned(path, k)) {
            owner = k;
            break;
          }
      if (!existsSync(path) || owner)
        return { path, owner, stale: previous && previous !== path ? previous : null };
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
   * A shared note's Markdown copy (SPEC-10.10 표) → `<ops>/일지/<날짜>.md` (journal) or
   * `<ops>/회의록/<만든 날>-<제목>.md` (meeting). Other notes (`note`, `discussion`) get no folder
   * copy. The site is the source; a note removed there keeps its copy, marked '사이트에서 지워짐'.
   */
  writeNote(projectId: string, note: NoteCopy, markdown: string): Promise<string | null> {
    const journal = note.kind === 'journal' && note.journalDate;
    if (!journal && note.kind !== 'meeting') return Promise.resolve(null);
    const key = `note:${note.id}`;
    const run = () =>
      this.queue(projectId, 'note', async () => {
        const place = await this.roleFolder(projectId, 'ops');
        if (!place) return null;
        const created = note.createdAt !== undefined ? new Date(note.createdAt) : this.now();
        const day = Number.isNaN(created.getTime()) ? dayOf(this.now()) : dayOf(created);
        const dir = join(place.dir, journal ? '일지' : '회의록');
        const base = journal
          ? safeName(String(note.journalDate))
          : `${day}-${safeName(note.title)}`;
        return this.writeMarkdownIn(
          projectId,
          place.root,
          dir,
          base,
          key,
          '계정 사이트의 공유 노트',
          markdown,
          {
            // A day's 일지 copy started by a waiting [퇴근하기] line is this note's from now on.
            aliases: journal ? [`journal:${note.journalDate}`] : [],
            mark: note.deleted
              ? '> 사이트에서 지워짐 — 계정 사이트에서 지운 노트의 마지막 사본입니다.'
              : undefined,
          },
        );
      });
    this.redo.set(`${projectId}\0${key}`, run);
    return run();
  }
  /**
   * A [퇴근하기] line waiting for the site (SPEC-10.5 3·4) → the day's 일지 copy at once. A copy
   * changed in the folder is left as it is (SPEC-10.10 3).
   */
  appendJournalLine(projectId: string, date: string, line: string): Promise<string | null> {
    return this.queue(projectId, 'journal-line', async () => {
      const place = await this.roleFolder(projectId, 'ops');
      if (!place || !line.trim()) return null;
      const dir = join(place.dir, '일지');
      const text = `${line.trim()} (사이트에 아직 안 보냄)`;
      const path = join(dir, `${safeName(date)}.md`);
      const marked = existsSync(path) ? /vide-copy:([A-Za-z0-9:_-]+)/.exec(await head(path)) : null;
      if (marked) {
        const key = marked[1];
        const ledger = await this.ledger(projectId);
        if (await this.changedInFolder(ledger[key], path)) return null;
        const next = (await readFile(path, 'utf8')).trimEnd() + '\n\n' + text + '\n';
        await this.put(place.root, path, next);
        ledger[key] = { path, sha256: sha256(next), writtenAt: this.now().toISOString() };
        await this.saveLedger(projectId);
        return path;
      }
      return this.writeMarkdownIn(
        projectId,
        place.root,
        dir,
        safeName(date),
        `journal:${date}`,
        '계정 사이트의 공유 노트(보내기 대기)',
        `# ${journalTitle(date)}\n\n${text}`,
      );
    });
  }
  /**
   * 일정 (SPEC-10.9 4, SPEC-10.10) → `<ops>/일정/<YYYY-MM>.md` for every month with dated items and
   * every month written before (a month left empty says so). Unchanged months are not rewritten.
   */
  writeSchedule(projectId: string, items: readonly AgendaItem[]): Promise<string[] | null> {
    const run = (only?: string): Promise<string[] | null> =>
      this.queue(projectId, 'schedule', async () => {
        const place = await this.roleFolder(projectId, 'ops');
        if (!place) return null;
        const ledger = await this.ledger(projectId);
        const months = new Set(scheduleMonths(items));
        for (const key of Object.keys(ledger))
          if (key.startsWith('schedule:')) months.add(key.slice('schedule:'.length));
        const written: string[] = [];
        for (const month of [...months].sort()) {
          if ((only && month !== only) || !/^\d{4}-\d{2}$/.test(month)) continue;
          const key = `schedule:${month}`;
          this.redo.set(`${projectId}\0${key}`, () => run(month));
          const path = await this.writeMarkdownIn(
            projectId,
            place.root,
            join(place.dir, '일정'),
            month,
            key,
            'VIDE 할 일·일정',
            scheduleMarkdown(items, month),
          );
          if (path) written.push(path);
        }
        return written;
      });
    return run();
  }
  /**
   * An imported 카카오톡·메일 file as it was (PLAN-53 T-329·T-330) → `<ops>/기록/원문/<name>`, with
   * no marker line (record line numbers point into it). A file of that name with the same text is
   * used as it is; another text takes `<name> (2).<ext>`, `(3)` … (a person's file is never
   * overwritten). The first write also puts `원문/.gitignore` (`*`): the originals never reach
   * the work folder's GitHub. Null when the project has no work folder or the write failed
   * (logged); `path` is relative to the work folder, with `/`.
   */
  writeRawCopy(projectId: string, name: string, text: string): Promise<{ path: string } | null> {
    return this.queue(projectId, 'raw', async () => {
      const place = await this.roleFolder(projectId, 'ops');
      if (!place) return null;
      const dir = join(place.dir, ...RECORD_ORIGINALS);
      await this.ensureDir(place.root, dir);
      const ignore = join(dir, '.gitignore');
      if (!existsSync(ignore)) await this.put(place.root, ignore, '*\n');
      const dot = name.lastIndexOf('.');
      const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
      const base = safeName(dot > 0 ? name.slice(0, dot) : name, '원문');
      for (let n = 1; ; n++) {
        const path = join(dir, `${base}${n === 1 ? '' : ` (${n})`}${ext}`);
        this.check(place.root, path);
        if (existsSync(path)) {
          if ((await readFile(path, 'utf8').catch(() => null)) !== text) continue;
        } else await this.put(place.root, path, text);
        return { path: relative(place.root, path).replaceAll('\\', '/') };
      }
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
        projectId,
        place.root,
        join(place.dir, safeName(copy.sub, '기타')),
        safeName(copy.name),
        copy.key,
        copy.source,
        markdown,
      );
    });
  }
  /**
   * Writes a Markdown copy, unless the person changed it in the folder since VIDE last wrote it
   * ('폴더에서 바뀜', SPEC-10.10 3): then nothing is written (null) until [버리기]. A copy that
   * cannot be written is '폴더에 아직 안 씀' until a later write succeeds (SPEC-10.10 4).
   */
  private writeMarkdownIn(
    projectId: string,
    root: string,
    dir: string,
    base: string,
    key: string,
    source: string,
    markdown: string,
    extra: { aliases?: string[]; mark?: string } = {},
  ): Promise<string | null> {
    const text =
      copyHeader(source, key) +
      '\n' +
      (extra.mark ? extra.mark + '\n' : '') +
      '\n' +
      markdown.trimEnd() +
      '\n';
    return this.writeCopyIn(projectId, root, dir, base, '.md', key, text, extra);
  }
  /**
   * `writeMarkdownIn` for any text whose marker the caller put in (`ext` `.md`, `.jsonl` …).
   * `adopt`: a copy of `key` already in the folder that this PC never wrote (no ledger row — e.g.
   * the folder came from another PC) and that differs is not overwritten but kept as
   * '폴더에서 바뀜', so its lines can be taken in first (기록 사본, PLAN-53 T-331).
   */
  private async writeCopyIn(
    projectId: string,
    root: string,
    dir: string,
    base: string,
    ext: string,
    key: string,
    text: string,
    extra: { aliases?: string[]; adopt?: boolean } = {},
  ): Promise<string | null> {
    const id = `${projectId}\0${key}`;
    let tried: string | null = null;
    try {
      const aliases = extra.aliases ?? [];
      const { path, owner, stale } = await this.placeFile(root, dir, base, ext, key, aliases);
      tried = path;
      const ledger = await this.ledger(projectId);
      const before = ledger[owner ?? key] ?? ledger[key];
      const forced = this.forced.delete(id);
      if (!forced && (await this.changedInFolder(before, path))) {
        this.failed.get(projectId)?.delete(key);
        return null;
      }
      if (!forced && extra.adopt && !before && owner) {
        const there = await readFile(path, 'utf8').catch(() => null);
        if (there !== null && there !== text) {
          ledger[key] = { path, sha256: '', writtenAt: '' };
          await this.saveLedger(projectId);
          this.failed.get(projectId)?.delete(key);
          return null;
        }
      }
      await this.put(root, path, text);
      for (const alias of aliases) delete ledger[alias];
      ledger[key] = { path, sha256: sha256(text), writtenAt: this.now().toISOString() };
      // The copy under its old name (a renamed note) goes, unless the person changed it there.
      if (stale && (await owned(stale, key)) && !(await this.changedInFolder(before, stale)))
        await rm(stale, { force: true });
      await this.saveLedger(projectId);
      this.failed.get(projectId)?.delete(key);
      return path;
    } catch (error) {
      let failed = this.failed.get(projectId);
      if (!failed) this.failed.set(projectId, (failed = new Map()));
      failed.set(key, tried);
      throw error;
    }
  }

  // --- 기록 사본 (PLAN-53 T-331, ARCH-01 §5 「프로젝트 기록」 '사본 쓰기와 되들이기') -----------
  /**
   * One month of records → `<ops>/기록/<YYYY-MM>.jsonl`; `jsonl` is the rows (the marker line is
   * put first here). A copy the person changed is left as it is (null), as for the notes.
   */
  writeRecordsCopy(projectId: string, month: string, jsonl: string): Promise<string | null> {
    if (!/^\d{4}-\d{2}$/.test(month)) return Promise.resolve(null);
    const key = `records:${month}`;
    return this.queue(projectId, 'records', async () => {
      const place = await this.roleFolder(projectId, 'ops');
      if (!place) return null;
      const text = recordsCopyMarker(month) + '\n' + jsonl;
      const path = await this.writeCopyIn(
        projectId,
        place.root,
        join(place.dir, '기록'),
        month,
        '.jsonl',
        key,
        text,
        { adopt: true },
      );
      if (path) await this.saveRecordsCopyBase(projectId, month, jsonl);
      return path;
    });
  }
  /**
   * The rows this PC last wrote to the month copy (no marker line), or null (never written here —
   * e.g. a folder from another PC). [폴더 내용 들이기] compares a line with it so only what the
   * person changed in the file is taken in (a line left alone never undoes a later VIDE change).
   */
  async recordsCopyBase(projectId: string, month: string): Promise<string | null> {
    const file = this.recordsBaseFile(projectId, month);
    if (!file) return this.bases.get(`${projectId}\0${month}`) ?? null;
    return readFile(file, 'utf8').catch(() => null);
  }
  private recordsBaseFile(projectId: string, month: string) {
    const data = this.options.dataDirectory;
    return data && /^[A-Za-z0-9_-]{1,120}$/.test(projectId) && /^\d{4}-\d{2}$/.test(month)
      ? join(data, 'projects', projectId, 'records-copies', `${month}.jsonl`)
      : null;
  }
  private async saveRecordsCopyBase(projectId: string, month: string, jsonl: string) {
    const file = this.recordsBaseFile(projectId, month);
    if (!file) {
      this.bases.set(`${projectId}\0${month}`, jsonl);
      return;
    }
    await mkdir(join(file, '..'), { recursive: true });
    const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temp, jsonl, 'utf8');
    await rename(temp, file);
  }
  /** `<ops>/기록/README.md` — the whole file is VIDE's (부위 사전·마일스톤·장). */
  writeRecordsReadme(projectId: string, markdown: string): Promise<string | null> {
    return this.queue(projectId, 'records', async () => {
      const place = await this.roleFolder(projectId, 'ops');
      if (!place) return null;
      return this.writeMarkdownIn(
        projectId,
        place.root,
        join(place.dir, '기록'),
        'README',
        'records:readme',
        'VIDE 기록',
        markdown,
      );
    });
  }
  /** The ledger and failed keys starting with `prefix` (written, changed or not written). */
  async copyKeys(projectId: string, prefix: string): Promise<string[]> {
    const ledger = await this.ledger(projectId);
    const keys = new Set(Object.keys(ledger).filter((key) => key.startsWith(prefix)));
    for (const key of this.failed.get(projectId)?.keys() ?? [])
      if (key.startsWith(prefix)) keys.add(key);
    return [...keys].sort();
  }
  /** Where the copy `key` was last written (absolute), if this PC wrote or adopted it. */
  async copyPath(projectId: string, key: string): Promise<string | null> {
    return (await this.ledger(projectId))[key]?.path ?? null;
  }
  /** The next write of each key goes over the person's change (기록 [다시 쓰기]·들이기 뒤). */
  force(projectId: string, keys: string[]) {
    for (const key of keys) this.forced.add(`${projectId}\0${key}`);
  }
  /** Drops what `force` left unused (a key that had nothing to write). */
  unforce(projectId: string, keys: string[]) {
    for (const key of keys) this.forced.delete(`${projectId}\0${key}`);
  }

  // --- 폴더에서 바뀜 ----------------------------------------------------------------------------
  private ledgerFile(projectId: string) {
    const data = this.options.dataDirectory;
    return data && /^[A-Za-z0-9_-]{1,120}$/.test(projectId)
      ? join(data, 'projects', projectId, FOLDER_COPIES)
      : null;
  }
  private async ledger(projectId: string): Promise<Record<string, FolderCopyRecord>> {
    let ledger = this.ledgers.get(projectId);
    if (ledger) return ledger;
    ledger = {};
    const file = this.ledgerFile(projectId);
    if (file)
      try {
        const value: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (value && typeof value === 'object' && !Array.isArray(value))
          for (const [key, row] of Object.entries(value as Record<string, unknown>)) {
            const r = row as Partial<FolderCopyRecord> | null;
            if (r && typeof r.path === 'string' && typeof r.sha256 === 'string')
              ledger[key] = {
                path: r.path,
                sha256: r.sha256,
                writtenAt: String(r.writtenAt ?? ''),
              };
          }
      } catch {
        /* none yet, or unreadable: every copy is treated as never written here */
      }
    this.ledgers.set(projectId, ledger);
    return ledger;
  }
  private async saveLedger(projectId: string) {
    const file = this.ledgerFile(projectId);
    const ledger = this.ledgers.get(projectId);
    if (!file || !ledger) return;
    await mkdir(join(file, '..'), { recursive: true });
    const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temp, JSON.stringify(ledger, null, 1), 'utf8');
    await rename(temp, file);
  }
  /** Whether the file VIDE last wrote at `path` differs now from what it wrote (a missing file does not). */
  private async changedInFolder(record: FolderCopyRecord | undefined, path: string) {
    if (!record || record.path !== path || !existsSync(path)) return false;
    const now = await readFile(path).catch(() => null);
    return now !== null && sha256(now) !== record.sha256;
  }

  /**
   * The project's Markdown copies and their state (ARCH-01: `written`, `changed-in-folder`,
   * `not-written`). `NO_WORKSPACE` when the project has no work folder here.
   */
  async folderCopies(projectId: string): Promise<FolderCopyState[]> {
    if (!(await this.target(projectId))) throw new DomainError('NO_WORKSPACE');
    await this.idle();
    const ledger = await this.ledger(projectId);
    const failed = this.failed.get(projectId) ?? new Map<string, string | null>();
    const rows: FolderCopyState[] = [];
    for (const [key, record] of Object.entries(ledger))
      rows.push({
        key,
        path: record.path,
        state: failed.has(key)
          ? 'not-written'
          : (await this.changedInFolder(record, record.path))
            ? 'changed-in-folder'
            : 'written',
        writtenAt: record.writtenAt || null,
      });
    for (const [key, path] of failed)
      if (!ledger[key]) rows.push({ key, path, state: 'not-written', writtenAt: null });
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  }
  /**
   * [버리기] (SPEC-10.10 3): writes the copy `key` again from its source, over the person's change.
   * The last write asked for in this run is used; after a restart `regenerate` makes the source
   * write it again (the notes refresh, the 일정 items). `COPY_NOT_FOUND` for a key never written.
   */
  async discardFolderCopy(
    projectId: string,
    key: string,
    regenerate?: (key: string) => Promise<unknown>,
  ): Promise<FolderCopyState> {
    if (!(await this.target(projectId))) throw new DomainError('NO_WORKSPACE');
    const ledger = await this.ledger(projectId);
    const id = `${projectId}\0${key}`;
    const redo = this.redo.get(id);
    if (!ledger[key] && !this.failed.get(projectId)?.has(key) && !redo)
      throw new DomainError('COPY_NOT_FOUND');
    this.forced.add(id);
    try {
      if (redo) await redo();
      else await regenerate?.(key);
      await this.idle();
    } finally {
      this.forced.delete(id);
    }
    const row = (await this.folderCopies(projectId)).find((copy) => copy.key === key);
    return row ?? { key, path: null, state: 'not-written', writtenAt: null };
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

  // --- 보고용 (PLAN-54 T-342·T-343, SPEC-07.11 두 등급) ----------------------------------------
  /**
   * A 보고용 report → `<output>/<YYYY-MM-DD>-<제목>/` (`index.html`, the tables as `*.csv`,
   * `report.json`; ARCH-01 산출물 경로), `-2`, `-3` when the name is taken. The same files are
   * always kept in `<data>/projects/<p>/outputs/<name>/` too, so the screen lists and downloads
   * them — also when there is no work folder, no output role, or the folder cannot be written
   * (`written: false` and the reason). Each making is a new folder (never overwrites another).
   */
  async writePublicReport(
    projectId: string,
    report: PublicReportFiles,
    dataDirectory: string,
  ): Promise<PublicReportWritten> {
    if (!SAFE_SEGMENT.test(projectId)) throw new DomainError('NOT_FOUND');
    if (report.csvs.some((c) => !SAFE_SEGMENT.test(c.name) || !c.name.endsWith('.csv')))
      throw new DomainError('INVALID_REQUEST');
    const parent = publicReportsDir(dataDirectory, projectId);
    await mkdir(parent, { recursive: true });
    const ws = await this.target(projectId);
    const out = ws?.paths.output ?? null;
    const base = `${dayOf(this.now())}-${safeName(report.title, '보고서')}`;
    let name = '';
    for (let n = 1; n < 1000 && !name; n++) {
      const cand = candidate(base, n);
      if (existsSync(join(parent, cand)) || (out && existsSync(join(out, cand)))) continue;
      try {
        await mkdir(join(parent, cand));
        name = cand;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (!name) throw new DomainError('EXPORT_FOLDER_TAKEN');
    const key = `public-report:${randomUUID()}`;
    const files: { name: string; text: string }[] = [
      { name: 'index.html', text: markHtml(report.html, copyHeader('VIDE 보고용 보고서', key)) },
      ...report.csvs.map((c) => ({ name: c.name, text: c.text })),
      { name: 'report.json', text: JSON.stringify(report.reportJson, null, 2) + '\n' },
    ];
    for (const file of files) await writeFile(join(parent, name, file.name), file.text, 'utf8');
    let folder: string | null = null;
    let reason: PublicReportWritten['reason'];
    if (!ws) reason = 'no-workspace';
    else if (!out) reason = 'no-output-role';
    else {
      folder = await this.queue(projectId, 'public-report', async () => {
        const dir = join(out, name);
        await this.ensureDir(ws.root, dir);
        for (const file of files) await this.put(ws.root, join(dir, file.name), file.text);
        return dir;
      });
      if (!folder) reason = 'failed';
    }
    await writeFile(
      join(parent, name, KEPT_META),
      JSON.stringify({ key, folder, ...(reason ? { reason } : {}) }) + '\n',
      'utf8',
    );
    return {
      name,
      folder,
      written: !!folder,
      ...(reason ? { reason } : {}),
      files: files.map((f) => f.name),
      kept: join(parent, name),
    };
  }
}

/** What [보고용 만들기] writes (PLAN-54 T-342). */
export interface PublicReportFiles {
  title: string;
  /** The 보고용 page (src/core/report-html.ts, tier `public`). */
  html: string;
  /** One CSV per table of the chosen sections; `name` is a plain file name ending in `.csv`. */
  csvs: { name: string; text: string }[];
  /** `report.json`: `{ sourceRun, sections, scenes, madeAt, title }` (ARCH-01). */
  reportJson: Record<string, unknown>;
}
export interface PublicReportWritten {
  /** The folder name (`<YYYY-MM-DD>-<제목>`, `-2` …), the same in the work folder and the data copy. */
  name: string;
  /** The work folder's `<output>/<name>` (absolute), or null when not written there. */
  folder: string | null;
  written: boolean;
  /** Why it is not in the work folder: none, no output role, or the write failed (e.g. outside). */
  reason?: 'no-workspace' | 'no-output-role' | 'failed';
  files: string[];
  /** The data folder copy (absolute). */
  kept: string;
}
export interface PublicReportRow {
  name: string;
  title: string;
  madeAt: string | null;
  folder: string | null;
  reason?: string;
  sourceRun: Record<string, unknown> | null;
  sections: unknown[];
  files: string[];
  /** `publish.json` of the folder (T-343), when it has been published. */
  published?: Record<string, unknown>;
}

const KEPT_META = 'vide.json';
/** One path segment: no separators, no `..`, no reserved characters. */
const SAFE_SEGMENT = /^(?!\.{1,2}$)[^<>:"/\\|?*\u0000-\u001f]{1,120}$/;
const publicReportsDir = (dataDirectory: string, projectId: string) =>
  join(dataDirectory, 'projects', projectId, 'outputs');
const readJson = async (path: string): Promise<Record<string, unknown> | null> => {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** The 보고용 reports kept for a project (newest first). */
export async function listPublicReports(
  dataDirectory: string,
  projectId: string,
): Promise<PublicReportRow[]> {
  if (!SAFE_SEGMENT.test(projectId)) return [];
  const parent = publicReportsDir(dataDirectory, projectId);
  const rows: PublicReportRow[] = [];
  for (const name of await readdir(parent).catch(() => [] as string[])) {
    const dir = join(parent, name);
    const meta = await readJson(join(dir, 'report.json'));
    if (!meta) continue;
    const kept = (await readJson(join(dir, KEPT_META))) ?? {};
    const folder = typeof kept.folder === 'string' ? kept.folder : null;
    const published =
      (folder ? await readJson(join(folder, 'publish.json')) : null) ??
      (await readJson(join(dir, 'publish.json')));
    const files = (await readdir(dir).catch(() => [] as string[]))
      .filter((f) => f !== KEPT_META)
      .sort();
    rows.push({
      name,
      title: typeof meta.title === 'string' ? meta.title : name,
      madeAt: typeof meta.madeAt === 'string' ? meta.madeAt : null,
      folder: folder && existsSync(folder) ? folder : null,
      ...(typeof kept.reason === 'string' ? { reason: kept.reason } : {}),
      sourceRun:
        meta.sourceRun && typeof meta.sourceRun === 'object'
          ? (meta.sourceRun as Record<string, unknown>)
          : null,
      sections: Array.isArray(meta.sections) ? meta.sections : [],
      files,
      ...(published ? { published } : {}),
    });
  }
  return rows.sort((a, b) => (b.madeAt ?? '').localeCompare(a.madeAt ?? ''));
}

/** One kept file of a 보고용 report, or null (unknown name, path characters, missing). */
export async function readPublicReportFile(
  dataDirectory: string,
  projectId: string,
  name: string,
  file: string,
): Promise<Buffer | null> {
  if (![projectId, name, file].every((s) => SAFE_SEGMENT.test(s)) || file === KEPT_META)
    return null;
  try {
    return await readFile(join(publicReportsDir(dataDirectory, projectId), name, file));
  } catch {
    return null;
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
      dataDirectory: store.dataDirectory(),
    });
    perStore.set(store, outputs);
  }
  return outputs;
}
