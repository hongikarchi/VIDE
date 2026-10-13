// The project's linked files as they are open right now (ADR-027, SPEC-01.11 5): a link is live
// when a connected host window holds that document. The links list (GET …/links) and a host turn
// that reads or edits other linked files both run `followOpenDocuments`: the same matcher
// (`matchOpenDocuments`, session first, one row per open document, T-095) and the same follow
// step, so a Save As made since the list's last poll is seen by the turn too, and one window is
// never two live rows.

import {
  isFileLink,
  matchOpenDocuments,
  windowKey,
  type MatchHow,
  type DocumentLink,
  type DocumentLinks,
  type OpenDocument as LinkedDocument,
} from '../core/document-links.ts';

/** One document a host connection reports open (Rhino `editors.list`, ZWCAD `attached.list`). */
export interface OpenDocument extends LinkedDocument {
  connection?: string;
}
/** One open document: its host window and document id. */
export interface OpenTarget {
  instance: string;
  documentId: number;
}
/**
 * Which open document each row shows (row id → document; `session`: matched by its window, `how`:
 * by its window, by the link id stored in the document, or by path).
 */
export type LinkMatches<D extends OpenDocument = OpenDocument> = Map<
  string,
  { document: D; session: boolean; how: MatchHow }
>;
/**
 * The links list's matcher. `prefer` (a host turn's target) only breaks a tie the matcher leaves:
 * a row whose own window is gone, reconnected by path while that file is open in two windows,
 * goes to the target window (otherwise the first one listed). `claimed`: the windows other
 * projects' rows hold (`matchProjects`, T-284), taken here only by their own row.
 */
export function matchLinks<D extends OpenDocument>(
  links: DocumentLink[],
  open: readonly D[],
  prefer?: { host: string } & OpenTarget,
  claimed?: ReadonlySet<string>,
): LinkMatches<D> {
  const preferred = (item: D) =>
    !!prefer &&
    (item.host ?? 'rhino') === prefer.host &&
    item.instance === prefer.instance &&
    item.id === prefer.documentId;
  return matchOpenDocuments(
    links,
    [...open.filter(preferred), ...open.filter((item) => !preferred(item))],
    claimed,
  );
}
/** One project's link rows, for matching open windows across projects. */
export interface ProjectRows {
  id: string;
  rows: DocumentLink[];
}
/**
 * Every project's matcher at once (SPEC-01.11 1, T-284): one open window is a live row of one
 * project. A window a project's row holds as its own (same window) is taken only by that row. A
 * window that several projects reach only by a stored id or path (a document carrying several
 * projects' link ids, reopened without a Link) goes to the row most recently tied to a document
 * (`updatedAt`, then `linkedAt`, then id); the other projects' rows read as closed.
 */
export function matchProjects<D extends OpenDocument>(
  projects: readonly ProjectRows[],
  open: readonly D[],
  prefer?: { host: string } & OpenTarget,
): Map<string, LinkMatches<D>> {
  const holders = new Map<string, Set<string>>();
  for (const project of projects)
    for (const row of project.rows) {
      if (isFileLink(row)) continue;
      const key = windowKey(row.host, row.instance, row.documentId);
      holders.set(key, (holders.get(key) ?? new Set()).add(project.id));
    }
  const result = new Map<string, LinkMatches<D>>();
  const contenders = new Map<D, { projectId: string; row: DocumentLink }[]>();
  for (const project of projects) {
    const claimed = new Set(
      [...holders].filter(([, ids]) => [...ids].some((id) => id !== project.id)).map(([k]) => k),
    );
    const matched = matchLinks(project.rows, open, prefer, claimed);
    result.set(project.id, matched);
    for (const [rowId, entry] of matched) {
      if (entry.session) continue;
      const row = project.rows.find((item) => item.id === rowId)!;
      contenders.set(entry.document, [
        ...(contenders.get(entry.document) ?? []),
        { projectId: project.id, row },
      ]);
    }
  }
  for (const entries of contenders.values()) {
    if (new Set(entries.map((entry) => entry.projectId)).size < 2) continue;
    const winner = [...entries].sort(
      (a, b) =>
        b.row.updatedAt.localeCompare(a.row.updatedAt) ||
        b.row.linkedAt.localeCompare(a.row.linkedAt) ||
        b.row.id.localeCompare(a.row.id),
    )[0];
    for (const entry of entries)
      if (entry !== winner) result.get(entry.projectId)!.delete(entry.row.id);
  }
  return result;
}
/**
 * Matches the open documents to the project's link rows and lets each matched row follow its
 * window (DocumentLinks.follow: Save As, first save, a row reconnected by path takes the window's
 * session). A work copy VIDE opened itself (`ownedOpen`: its window is not in `open` but still
 * open) keeps its own window. Returns the rows as they are after the follow step.
 */
export async function followOpenDocuments<D extends OpenDocument>(
  links: DocumentLinks,
  projectId: string,
  open: readonly D[],
  isOwnedOpen: (link: DocumentLink) => Promise<boolean | undefined>,
  prefer?: { host: string } & OpenTarget,
) {
  const ownedOpen = new Set<string>();
  for (const link of links.list(projectId))
    if (
      !isFileLink(link) &&
      !open.some((item) => item.instance === link.instance) &&
      (await isOwnedOpen(link).catch(() => false))
    )
      ownedOpen.add(link.id);
  // A window another project holds, or one another project reaches by a more recent link, is not
  // this project's to take or follow (SPEC-01.11 1, T-284).
  const others = new Map<string, DocumentLink[]>();
  for (const row of links.rowsElsewhere(projectId))
    others.set(row.projectId, [...(others.get(row.projectId) ?? []), row]);
  const matched = matchProjects(
    [
      { id: projectId, rows: links.list(projectId) },
      ...[...others].map(([id, rows]) => ({ id, rows })),
    ],
    open,
    prefer,
  ).get(projectId)!;
  for (const [id, { document, session, how }] of matched)
    if (session || !ownedOpen.has(id)) links.follow(projectId, id, document, how);
  return { rows: links.list(projectId), matched, ownedOpen };
}
/** A linked file and, when a connected (plugin-attached) window holds it now, where it is. */
export interface LiveLink {
  id: string;
  host: 'rhino' | 'zwcad';
  name: string;
  open: { instance: string; documentId: number } | null;
}
/**
 * The project's links with the open document the links list shows for each, when that is a
 * user's window attached through the connection plugin. Files opened in VIDE (`file:` entries)
 * and work copies VIDE opened itself are listed but never live: only a document a user's host
 * window holds through the plugin can be read and edited in place.
 */
export function liveLinksOf(
  links: readonly DocumentLink[],
  matched: LinkMatches,
  ownedOpen: ReadonlySet<string> = new Set(),
): LiveLink[] {
  return links.map((link) => {
    const doc =
      isFileLink(link) || ownedOpen.has(link.id) ? undefined : matched.get(link.id)?.document;
    const attached = (doc?.connection ?? 'attached-editor') === 'attached-editor';
    return {
      id: link.id,
      host: link.host,
      name: link.name,
      open: doc?.instance && attached ? { instance: doc.instance, documentId: doc.id } : null,
    };
  });
}
