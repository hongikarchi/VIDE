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
/** The open document a link names: the same path, or (unsaved) the same window and document. */
export function openDocumentOf<T extends OpenDocument>(
  link: Pick<DocumentLink, 'host' | 'path' | 'instance' | 'documentId'>,
  open: readonly T[],
): T | undefined {
  return open.find(
    (item) =>
      (item.host ?? 'rhino') === link.host &&
      (link.path && item.path
        ? item.path.toLowerCase() === link.path.toLowerCase()
        : item.instance === link.instance && item.id === link.documentId),
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
 * The project's host links with their attached open document, if any. Files opened in VIDE
 * (`file:` entries) and work copies VIDE opened itself are never live: only a document a user's
 * host window holds through the connection plugin can be read and edited in place.
 */
export function liveLinksOf(
  links: readonly DocumentLink[],
  open: readonly OpenDocument[],
): LiveLink[] {
  const attached = open.filter(
    (item) => (item.connection ?? 'attached-editor') === 'attached-editor',
  );
  return links
    .filter((link) => !isFileLink(link))
    .map((link) => {
      const doc = openDocumentOf(link, attached);
      return {
        id: link.id,
        host: link.host,
        name: link.name,
        open: doc?.instance ? { instance: doc.instance, documentId: doc.id } : null,
      };
    });
}
