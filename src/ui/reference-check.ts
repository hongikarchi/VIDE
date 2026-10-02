import { z } from 'zod';
import { storedAttachmentSchema, type StoredAttachment } from '../contracts/workspace.ts';

/**
 * The check before sending (SPEC-09.11, PLAN-26 T-090 (e)): an image attachment with words that
 * read as a reference ("이런 느낌으로"), or a path to images in the words, asks first with one line
 * over the composer instead of sending. Judged by these word rules on this PC, never by the AI.
 */
const INTENT =
  /느낌|처럼|스타일|레퍼런스|참고|이런\s*식|저런\s*식|분위기|비슷하게|같은\s*(모양|형태|디자인|방식)/;
export const referenceIntent = (text: string) => INTENT.test(text);

/** Korean particles that may follow a path written in a sentence ("…\기둥에 있는"). */
const PARTICLE = /(에서|으로|처럼|에|의|을|를|은|는|이|가|로|와|과|도)$/;
const TRAILING = /[\s,.;:!?)\]}'"“”‘’」』>]+$/;
/**
 * The paths the words may name, shortest first: the first absolute path (a drive or a share), cut
 * at each space after it (a path may hold spaces), with trailing punctuation and a particle off.
 */
export function pathCandidates(text: string): string[] {
  const quoted = /"((?:[A-Za-z]:|\\\\)[\\/][^"\n]*)"/.exec(text);
  if (quoted) return [quoted[1].replace(TRAILING, '')];
  const match = /(?:^|[^A-Za-z0-9])((?:[A-Za-z]:|\\\\[^\\/\s]+)[\\/][^\n"<>|*?]*)/.exec(text);
  if (!match) return [];
  const span = match[1];
  const cuts = [...span.matchAll(/\s/g)].map((space) => space.index ?? 0);
  const out: string[] = [];
  for (const end of [...cuts, span.length]) {
    const path = span.slice(0, end).replace(TRAILING, '');
    if (!path || /^[A-Za-z]:[\\/]?$/.test(path)) continue;
    for (const candidate of [path, path.replace(PARTICLE, '')])
      if (!out.includes(candidate)) out.push(candidate);
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
}

const pathImagesSchema = z.object({
  path: z.string().nullable(),
  kind: z.enum(['file', 'folder']).optional(),
  total: z.number(),
  images: z.array(z.object({ name: z.string(), path: z.string(), size: z.number() })),
});
export type PathImages = z.infer<typeof pathImagesSchema>;
type Api = (path: string, method?: string, data?: unknown) => Promise<unknown>;

/** The images at the first candidate path that holds any (none: `path` null). */
export async function imagesAtPaths(api: Api, projectId: string, paths: string[]) {
  return pathImagesSchema.parse(
    await api(`/projects/${encodeURIComponent(projectId)}/attachments/path-images`, 'POST', {
      paths,
    }),
  );
}
/** Copies one image file into the project's attachments (like the paperclip's pick). */
export async function attachImagePath(
  api: Api,
  projectId: string,
  path: string,
): Promise<StoredAttachment> {
  return storedAttachmentSchema.parse(
    await api(`/projects/${encodeURIComponent(projectId)}/attachments/from-path`, 'POST', {
      path,
    }),
  );
}

/**
 * The one-line card in the composer's proposal slot (`#route-card`, Design SCR-15), drawn by
 * src/ui/shell/reference-check-card.tsx; this module stays free of the DOM (the server tests import
 * its word rules).
 */
export interface ReferenceCardOptions {
  /** Images named by a path in the words; absent for an attached image. */
  found?: PathImages;
  mark?: () => void;
  pick?: (image: PathImages['images'][number]) => void;
  send: () => void;
  close: () => void;
}
