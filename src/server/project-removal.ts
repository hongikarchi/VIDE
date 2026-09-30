// Deleting a project (SPEC-01.11): its rows go (requests, links, jig instances, conversations,
// knowledge review layer — Store.deleteProject) and so do the files VIDE made for it inside the data
// folder. Nothing outside the data folder is touched: the user's own models stay where they are.
//
// A removed id is remembered in `<data>/removed-projects.json`, so the account site's list (which
// still carries it until the site learns of the delete) cannot recreate it on the next heartbeat.
// A project deleted on the account site is hidden the same way; its data stays on this PC, as the
// site intends ("kept for the PC's own copy"). Hidden and removed projects leave GET /projects,
// which the plugins' Link dialog and the app's picker both read.
import { readFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Store } from '../core/store.ts';
import type { Workspace } from '../core/workspace.ts';
import type { DocumentLinks } from '../core/document-links.ts';

const inside = (root: string, path: string) => {
  const base = resolve(root);
  const target = resolve(path);
  return target !== base && target.startsWith(base + sep);
};
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/** Ids of projects removed here or deleted on the account site. */
export class RemovedProjects {
  private ids = new Set<string>();
  private readonly file?: string;
  private writing: Promise<unknown> = Promise.resolve();
  constructor(dataDirectory?: string) {
    this.file = dataDirectory ? join(dataDirectory, 'removed-projects.json') : undefined;
    if (!this.file) return;
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (Array.isArray(value))
        for (const id of value) if (typeof id === 'string') this.ids.add(id);
    } catch {
      /* First use or unreadable: nothing removed yet. */
    }
  }
  has(id: string) {
    return this.ids.has(id);
  }
  add(id: string) {
    if (this.ids.has(id)) return Promise.resolve();
    this.ids.add(id);
    const file = this.file;
    if (!file) return Promise.resolve();
    const body = JSON.stringify([...this.ids]);
    const next = this.writing.then(async () => {
      await writeFile(file + '.tmp', body);
      await rename(file + '.tmp', file);
    });
    this.writing = next.catch(() => undefined);
    return next;
  }
  /** Projects to list: the store's, without hidden or removed ones. */
  visible<T extends { id: string }>(projects: T[]) {
    return projects.filter((project) => !this.ids.has(project.id));
  }
}

export async function removeProject(options: {
  projectId: string;
  store: Store;
  workspace: Workspace;
  links: DocumentLinks;
  removed: RemovedProjects;
  /** VIDE's data folder; only paths inside it are deleted. */
  dataDirectory?: string;
  /** Folders holding `<projectId>/…` import copies (models, cad-models). */
  importDirectories: string[];
  /** Folders holding one `<projectId>.<ext>` file per project (structure, ai-instructions, …). */
  projectFiles: string[];
}) {
  const { projectId, store, workspace, links, dataDirectory } = options;
  store.project(projectId);
  // Paths the project's rows point at, read before the rows go.
  const candidates: string[] = [];
  for (const entry of workspace.list(projectId)) {
    const result = entry.result as Record<string, unknown> | null;
    for (const path of [text(result?.workerDirectory), text(result?.filename)])
      if (path) candidates.push(path);
  }
  for (const row of store.db
    .prepare('SELECT path FROM jig_drafts WHERE projectId=?')
    .all(projectId)) {
    const path = text(row.path);
    if (path) candidates.push(path);
  }
  store.deleteProject(projectId);
  await options.removed.add(projectId);
  if (!dataDirectory) return { id: projectId };
  for (const directory of options.importDirectories) candidates.push(join(directory, projectId));
  for (const file of options.projectFiles) candidates.push(file);
  // Files another project still uses stay (a shared model copy).
  const inUse: string[] = [];
  for (const project of store.listProjects()) {
    for (const entry of workspace.list(project.id)) {
      const result = entry.result as Record<string, unknown> | null;
      for (const path of [text(result?.filename), text(result?.workerDirectory)])
        if (path) inUse.push(path);
    }
    for (const other of links.list(project.id)) if (other.path) inUse.push(other.path);
  }
  await Promise.all(
    candidates
      .filter((path) => inside(dataDirectory, path))
      .filter(
        (path) => !inUse.some((used) => inside(path, used) || resolve(path) === resolve(used)),
      )
      // A file still open elsewhere may refuse; the project is gone either way.
      .map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)),
  );
  return { id: projectId };
}
