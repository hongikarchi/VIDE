// The project's linked files as they are open right now (ADR-027, SPEC-01.11 5): a link is live
// when a connected host window holds that document. The links list (GET …/links) and a host turn
// that reads or edits other linked files both run `followOpenDocuments`: the same matcher
// (`matchOpenDocuments`, session first, one row per open document, T-095) and the same follow
// step, so a Save As made since the list's last poll is seen by the turn too, and one window is
// never two live rows.

import {
  isFileLink,
  matchOpenDocuments,
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
 * goes to the target window (otherwise the first one listed).
 */
export function matchLinks<D extends OpenDocument>(
  links: DocumentLink[],
  open: readonly D[],
  prefer?: { host: string } & OpenTarget,
): LinkMatches<D> {
  const preferred = (item: D) =>
    !!prefer &&
    (item.host ?? 'rhino') === prefer.host &&
    item.instance === prefer.instance &&
    item.id === prefer.documentId;
  return matchOpenDocuments(links, [
    ...open.filter(preferred),
    ...open.filter((item) => !preferred(item)),
  ]);
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
  const matched = matchLinks(links.list(projectId), open, prefer);
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
