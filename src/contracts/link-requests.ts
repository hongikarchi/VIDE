// Which requests belong to a linked file (SPEC-01.11): the engine (listing, removal) and the page
// (hiding, the work-result row) use the same rule, so a file's records never fall between the two.

/** The file name an import request was made for ("<name> 불러오기"). */
export const importedName = (body: string) => body.replace(/ 불러오기$/, '');

interface LinkLike {
  id: string;
  host: string;
  name: string;
  /** A file opened in VIDE ("파일에서 열기") rather than a host window. */
  file: boolean;
}
interface RequestLike {
  input: { linkId?: unknown; source?: unknown; host?: unknown; body?: unknown };
}

/** Its own Syncs (input.linkId); for a file item also older imports of the same name. */
export function belongsToLink(link: LinkLike, request: RequestLike) {
  const input = request.input;
  if (input.linkId === link.id) return true;
  return (
    link.file &&
    !input.linkId &&
    input.source === 'file' &&
    input.host === link.host &&
    typeof input.body === 'string' &&
    importedName(input.body).toLowerCase() === link.name.toLowerCase()
  );
}
