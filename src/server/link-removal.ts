// Removing a linked file (SPEC-01.11 9): what the file left in VIDE goes — its Sync and import
// records with their geometry, the upload copies and work folders VIDE made for them. The user's
// own file and the host window are never touched; the plugin panel drops its link on its own.
import { rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DomainError } from '../core/store.ts';
import { isFileLink } from '../core/document-links.ts';
import type { DocumentLink, DocumentLinks } from '../core/document-links.ts';
import type { Workspace } from '../core/workspace.ts';
import type { StoredWork } from '../contracts/stored-work.ts';

export const importedName = (body: string) => body.replace(/ 불러오기$/, '');

/** The requests of a linked file: its Syncs, and for a file item older imports of the same name. */
export function linkRequests(link: DocumentLink, requests: StoredWork[]) {
  const file = isFileLink(link);
  return requests.filter(
    (entry) =>
      entry.input.linkId === link.id ||
      (file &&
        !entry.input.linkId &&
        entry.input.source === 'file' &&
        entry.input.host === link.host &&
        importedName(entry.input.body).toLowerCase() === link.name.toLowerCase()),
  );
}

const inside = (root: string, path: string) => {
  const base = resolve(root);
  const target = resolve(path);
  return target === base || target.startsWith(base + sep);
};
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export async function removeLink(options: {
  projectId: string;
  linkId: string;
  links: DocumentLinks;
  workspace: Workspace;
  /** VIDE's data folder; only paths inside it are deleted. */
  dataDirectory?: string;
  /** Folders holding `<projectId>/<requestId>.upload.<ext>` import copies. */
  importDirectories: string[];
  projects: () => { id: string }[];
}) {
  const { projectId, linkId, links, workspace } = options;
  const link = links.get(projectId, linkId);
  const own = linkRequests(link, workspace.list(projectId));
  if (own.some((entry) => ['queued', 'running'].includes(entry.state)))
    throw new DomainError('PROJECT_BUSY');
  const deleted = workspace.purge(
    projectId,
    own.map((entry) => entry.id),
  );
  links.remove(projectId, linkId);
  // Every request of the file leaves the view: deleted, or hidden when a publication keeps it.
  const result = { deleted: deleted.length, requestIds: own.map((entry) => entry.id) };
  if (!options.dataDirectory) return result;
  // Files left behind: work folders and upload copies nothing else still uses.
  const candidates: string[] = [];
  for (const entry of deleted) {
    const folder = text((entry.result as Record<string, unknown> | null)?.workerDirectory);
    if (folder) candidates.push(folder);
    if (entry.input.source === 'file')
      for (const directory of options.importDirectories)
        for (const extension of ['3dm', 'dwg'])
          candidates.push(join(directory, projectId, `${entry.id}.upload.${extension}`));
  }
  const inUse: string[] = [];
  for (const project of options.projects()) {
    for (const entry of workspace.list(project.id)) {
      const result = entry.result as Record<string, unknown> | null;
      for (const path of [text(result?.filename), text(result?.workerDirectory)])
        if (path) inUse.push(path);
    }
    for (const other of links.list(project.id)) if (other.path) inUse.push(other.path);
  }
  const root = options.dataDirectory;
  await Promise.all(
    candidates
      .filter((path) => inside(root, path) && resolve(path) !== resolve(root))
      .filter((path) => !inUse.some((used) => inside(path, used)))
      // A file still open elsewhere may refuse; removing the item does not depend on it.
      .map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)),
  );
  return result;
}
