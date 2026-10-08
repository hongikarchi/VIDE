// One path, several spellings (SPEC-01.13 1): a project folder is stored by its real path
// (`checkFolder`), so a mapped drive `Z:\…` is kept as `\\server\share\…` and a subst drive as the
// folder it stands for, while a drawing or an xref may name the same file by the drive letter. The
// drawing services compare both spellings, and check the denied folders on both.
import { realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import { pathKey } from '../core/xref-graph.ts';

/**
 * The real spelling of a Windows path: links, junctions, mapped and subst drives resolved through
 * its deepest existing folder; the part below that is kept as written. Never throws.
 */
export function realPath(path: string): string {
  const full = win32.resolve(path);
  const tail: string[] = [];
  let head = full;
  for (;;) {
    try {
      return win32.join(realpathSync.native(head), ...tail);
    } catch {
      const up = win32.dirname(head);
      if (up === head) return full;
      tail.unshift(win32.basename(head));
      head = up;
    }
  }
}

/** Whether `path` is inside `folder` as written (Windows path keys, no file access). */
export const under = (folder: string, path: string) =>
  pathKey(path).startsWith(pathKey(folder).replace(/\\+$/, '') + '\\');

/** Whether `path` is inside `folder`, as written or by their real paths (another drive letter). */
export function within(folder: string, path: string) {
  if (under(folder, path)) return true;
  const real = realPath(path);
  return under(folder, real) || under(realPath(folder), real);
}

/**
 * `path` when it is inside one of `folders` and denied in neither spelling: as written when that
 * matches a folder, else its real spelling (the one the folder listings use). `null` otherwise.
 */
export function projectPath(
  folders: readonly string[],
  path: string,
  denied: (path: string) => boolean,
): string | null {
  const written = win32.normalize(path);
  if (denied(written)) return null;
  if (folders.some((folder) => under(folder, written))) {
    // A link below the folder may still lead into a denied folder.
    return denied(realPath(written)) ? null : written;
  }
  const real = realPath(written);
  if (denied(real)) return null;
  return folders.some((folder) => under(folder, real) || under(realPath(folder), real))
    ? real
    : null;
}
