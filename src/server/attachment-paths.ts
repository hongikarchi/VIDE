import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, parse, resolve } from 'node:path';
import { DomainError } from '../core/store.ts';
import type { AttachmentStore } from './attachments.ts';
import { deniedPath, secretName, type FileContext } from './project-files.ts';

/**
 * Images named by a path in the composer's words (SPEC-09.11 2·3, PLAN-26 T-090 (e)): the user
 * wrote the path and picks one image, so it is copied like the paperclip's pick (SPEC-01.12 2)
 * without the AI's permission question; locations SPEC-01.13 4 never reads are left out and
 * refused, and a remote session reads no path of this PC.
 */
export const MAX_PATH_IMAGES = 24;
const MAX_CANDIDATES = 8;
const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;

const error = (code: string) => new DomainError(code);
/** An absolute path without quotes, or undefined (device paths and odd input are skipped). */
function pathOf(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const path = value
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();
  if (!path || path.length > 1024 || path.includes('\0') || /^[\\/]{2}[?.][\\/]/.test(path))
    return undefined;
  return isAbsolute(path) ? resolve(path) : undefined;
}
async function realOf(path: string) {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}
/** The real path of an existing, readable (not denied) location. */
async function allowed(path: string, context: FileContext) {
  if (deniedPath(path, context)) return undefined;
  const target = await realOf(path);
  if (!target || deniedPath(target, context)) return undefined;
  return target;
}

export interface PathImages {
  /** The path that was found (as written), or null when none of the candidates holds images. */
  path: string | null;
  kind?: 'file' | 'folder';
  /** All images in the folder (or 1 for a file). */
  total: number;
  images: { name: string; path: string; size: number }[];
}

/**
 * The first candidate path that is an image file or a folder with images: the folder's images by
 * name (first MAX_PATH_IMAGES), subfolders not read.
 */
export async function imagesAtPath(candidates: unknown, context: FileContext): Promise<PathImages> {
  const list = Array.isArray(candidates) ? candidates.slice(0, MAX_CANDIDATES) : [];
  for (const candidate of list) {
    const path = pathOf(candidate);
    if (!path) continue;
    const target = await allowed(path, context);
    if (!target) continue;
    const info = await stat(target).catch(() => undefined);
    if (!info) continue;
    if (info.isFile()) {
      if (!IMAGE_NAME.test(target) || secretName(basename(target))) continue;
      return {
        path,
        kind: 'file',
        total: 1,
        images: [{ name: basename(path), path, size: info.size }],
      };
    }
    if (!info.isDirectory()) continue;
    const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
    const names = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          IMAGE_NAME.test(entry.name) &&
          !secretName(entry.name) &&
          !deniedPath(join(target, entry.name), context),
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
    if (!names.length) continue;
    const images = await Promise.all(
      names.slice(0, MAX_PATH_IMAGES).map(async (name) => ({
        name,
        path: join(path, name),
        size: (await stat(join(target, name)).catch(() => undefined))?.size ?? 0,
      })),
    );
    return { path, kind: 'folder', total: names.length, images };
  }
  return { path: null, total: 0, images: [] };
}

/** A drive root (`C:\`) or a UNC share root (`\\server\share`). */
const isRoot = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, '');
  return !trimmed || trimmed === parse(path).root.replace(/[\\/]+$/, '');
};
export const MAX_PATH_KINDS = 64;
export interface PathKindItem {
  /** The path as written. */
  path: string;
  /** null: not on this PC, not readable (SPEC-01.13 4), a drive or share root, or odd input. */
  kind: 'file' | 'folder' | null;
  name: string;
}
/**
 * What each pasted path is (SPEC-01.12 6, PLAN-31 T-141): a file, a folder or nothing. The user
 * pasted the paths, so they are checked without the permission question; denied places, secret
 * names and roots are `null`.
 */
export async function pathKinds(values: unknown, context: FileContext): Promise<PathKindItem[]> {
  const list = Array.isArray(values) ? values.slice(0, MAX_PATH_KINDS) : [];
  return Promise.all(
    list.map(async (value): Promise<PathKindItem> => {
      const written = typeof value === 'string' ? value : '';
      const path = pathOf(value);
      const none = { path: written, kind: null, name: '' } as const;
      if (!path || isRoot(path)) return none;
      const target = await allowed(path, context);
      if (!target || isRoot(target)) return none;
      const info = await stat(target).catch(() => undefined);
      if (info?.isFile() && !secretName(basename(target)))
        return { path: written, kind: 'file', name: basename(path) };
      if (info?.isDirectory()) return { path: written, kind: 'folder', name: basename(path) };
      return none;
    }),
  );
}

/**
 * Copies the file at `value` into the project's attachments, any type (SPEC-01.12 2·6): an image
 * picked on the reference card or a pasted file chip.
 */
export async function attachFromPath(
  store: AttachmentStore,
  projectId: string,
  value: unknown,
  context: FileContext,
) {
  const path = pathOf(value);
  if (!path) throw error('INVALID_INPUT');
  if (deniedPath(path, context)) throw error('FILE_FORBIDDEN');
  const target = await realOf(path);
  if (!target) throw error('FILE_NOT_FOUND');
  if (deniedPath(target, context) || secretName(basename(target))) throw error('FILE_FORBIDDEN');
  const info = await stat(target);
  if (!info.isFile()) throw error('INVALID_INPUT');
  return store.save(projectId, basename(path), createReadStream(target));
}

/**
 * `POST /api/v1/projects/:p/attachments/path-images` {paths}, `…/attachments/path-kinds` {paths}
 * and `…/attachments/from-path` {path}. True when the route was one of these.
 */
export async function attachmentPathRoutes(
  url: URL,
  method: string | undefined,
  {
    attachments,
    context,
    project,
    body,
    send,
    remote,
  }: {
    attachments: AttachmentStore | undefined;
    context: FileContext;
    project: (projectId: string) => unknown;
    body: () => Promise<Record<string, unknown>>;
    send: (status: number, value: unknown) => void;
    remote: boolean;
  },
) {
  const match =
    /^\/api\/v1\/projects\/([^/]+)\/attachments\/(path-images|path-kinds|from-path)$/.exec(
      url.pathname,
    );
  if (!match) return false;
  const [, projectId, action] = match;
  project(projectId);
  if (method !== 'POST') throw error('NOT_FOUND');
  // Paths of this PC are read at this PC only (SPEC-09.11 3).
  if (remote) throw error('FORBIDDEN');
  if (!attachments) throw error('NOT_FOUND');
  const input = await body();
  if (action === 'path-images') send(200, await imagesAtPath(input.paths, context));
  else if (action === 'path-kinds') send(200, { items: await pathKinds(input.paths, context) });
  else send(200, await attachFromPath(attachments, projectId, input.path, context));
  return true;
}
