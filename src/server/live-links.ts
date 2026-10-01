// The project's linked files as they are open right now (ADR-027, SPEC-01.11 5): a link is live
// when a connected host window holds that document. The links list (GET …/links) and a host turn
// that reads or edits other linked files match links to open documents the same way.

import { isFileLink, type DocumentLink } from '../core/document-links.ts';

/** One document a host connection reports open (Rhino `editors.list`, ZWCAD `attached.list`). */
export interface OpenDocument {
  instance?: string;
  id: number;
  host?: string;
  path?: string;
  connection?: string;
}
/** One open document: its host window and document id. */
export interface OpenTarget {
  instance: string;
  documentId: number;
}
/**
 * The open document a link names: the same path, or (unsaved) the same window and document. The
 * same file open in two windows: `prefer` (the turn's target) first, then the window and document
 * the link was made from, then the first one listed.
 */
export function openDocumentOf<T extends OpenDocument>(
  link: Pick<DocumentLink, 'host' | 'path' | 'instance' | 'documentId'>,
  open: readonly T[],
  prefer?: OpenTarget,
): T | undefined {
  const candidates = open.filter(
    (item) =>
      (item.host ?? 'rhino') === link.host &&
      (link.path && item.path
        ? item.path.toLowerCase() === link.path.toLowerCase()
        : item.instance === link.instance && item.id === link.documentId),
  );
  const at = (target: OpenTarget | undefined) =>
    target &&
    candidates.find((item) => item.instance === target.instance && item.id === target.documentId);
  return (
    at(prefer) ?? at({ instance: link.instance, documentId: link.documentId }) ?? candidates[0]
  );
}
/** A linked file and, when a connected (plugin-attached) window holds it now, where it is. */
export interface LiveLink {
  id: string;
  host: 'rhino' | 'zwcad';
  name: string;
  open: { instance: string; documentId: number } | null;
}
/**
 * The project's links with their attached open document, if any. Files opened in VIDE (`file:`
 * entries) are listed but never live, like work copies VIDE opened itself: only a document a
 * user's host window holds through the connection plugin can be read and edited in place.
 * `prefer`: the turn's target, for a file open in two windows.
 */
export function liveLinksOf(
  links: readonly DocumentLink[],
  open: readonly OpenDocument[],
  prefer?: { host: string } & OpenTarget,
): LiveLink[] {
  const attached = open.filter(
    (item) => (item.connection ?? 'attached-editor') === 'attached-editor',
  );
  return links.map((link) => {
    if (isFileLink(link)) return { id: link.id, host: link.host, name: link.name, open: null };
    const doc = openDocumentOf(link, attached, prefer?.host === link.host ? prefer : undefined);
    return {
      id: link.id,
      host: link.host,
      name: link.name,
      open: doc?.instance ? { instance: doc.instance, documentId: doc.id } : null,
    };
  });
}
