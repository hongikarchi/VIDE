// Official bake templates (ARCH-03 §9.1): fixed C# method bodies in `templates/*.cs` with one
// placeholder, `{{DATA_BASE64}}`. Rendering substitutes the base64 data block and then proves the
// result is the template text with only that placeholder replaced, so a jig value can never become
// code. A worker body is at most 65,536 characters; larger bakes go in several chunks that run in
// the same work copy (deletes only in the first).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { packageRoot } from '../../core/package-root.ts';
import {
  encodeDataBlock,
  itemBytes,
  originOf,
  type BakeItem,
  type DataBlockHeader,
  type TemplateName,
} from './data-block.ts';

export const PLACEHOLDER = '{{DATA_BASE64}}';
/** The worker refuses longer bodies (WorkerExecutor `INVALID_CODE`). */
export const MAX_BODY_CHARS = 65536;
/** Official read templates (ARCH-03 §9.1): write nothing; run by `direct-read` (PLAN-49 T-251). */
export const READ_TEMPLATE_NAMES = ['vide.read.surface-grid@1'] as const;
export type ReadTemplateName = (typeof READ_TEMPLATE_NAMES)[number];
type AnyTemplateName = TemplateName | ReadTemplateName;
const FILES: Record<AnyTemplateName, string> = {
  'vide.bake.curves@1': 'curves.cs',
  'vide.bake.sweep-h@1': 'sweep-h.cs',
  'vide.bake.extrude-column@1': 'extrude-column.cs',
  'vide.bake.textdot@1': 'textdot.cs',
  'vide.bake.extrude-polygon@1': 'extrude-polygon.cs',
  'vide.bake.brep-faces@1': 'brep-faces.cs',
  'vide.bake.mesh@1': 'mesh.cs',
  'vide.read.surface-grid@1': 'read-surface-grid.cs',
};
/**
 * Shared template text (SPEC-16.3 2): a line `//@include <file>.cs` is replaced by that file, so
 * the read and make templates compute the face fingerprint with the very same host function.
 */
export const INCLUDE_FILES = ['face-hash.cs'] as const;
const INCLUDE = /^\/\/@include ([a-z0-9-]+\.cs)$/gm;
export interface Template {
  name: AnyTemplateName;
  text: string;
  /** sha256 of the template text (recorded with every bake). */
  hash: string;
  /** Where the placeholder sits. */
  at: number;
}
const loaded = new Map<AnyTemplateName, Template>();
export function templateDirectory() {
  return join(fileURLToPath(packageRoot), 'src', 'jigs', 'bake', 'templates');
}
const readText = (file: string) =>
  readFileSync(join(templateDirectory(), file), 'utf8').replace(/\r\n/g, '\n');
/** The template text, read once; a template with no or several placeholders is a build error. */
export function loadTemplate(name: AnyTemplateName): Template {
  const cached = loaded.get(name);
  if (cached) return cached;
  const text = readText(FILES[name]).replace(INCLUDE, (_line, file: string) => {
    if (!(INCLUDE_FILES as readonly string[]).includes(file))
      throw new Error('BAKE_TEMPLATE_INCLUDE');
    const included = readText(file);
    if (included.includes(PLACEHOLDER) || /^\/\/@include /m.test(included))
      throw new Error('BAKE_TEMPLATE_INCLUDE');
    return included.replace(/\n$/, '');
  });
  const at = text.indexOf(PLACEHOLDER);
  if (at < 0 || text.indexOf(PLACEHOLDER, at + 1) >= 0)
    throw new Error('BAKE_TEMPLATE_PLACEHOLDER');
  const template: Template = {
    name,
    text,
    hash: createHash('sha256').update(text).digest('hex'),
    at,
  };
  loaded.set(name, template);
  return template;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
export interface RenderedBody {
  code: string;
  templateHash: string;
  /** sha256 of the data block bytes. */
  dataHash: string;
  bytes: number;
}
/** Substitute the data block and verify the body is template text + base64 + template text. */
export function renderTemplate(name: AnyTemplateName, block: Buffer): RenderedBody {
  const template = loadTemplate(name);
  const base64 = block.toString('base64');
  if (!BASE64.test(base64)) throw new Error('BAKE_DATA_ENCODING');
  const head = template.text.slice(0, template.at);
  const tail = template.text.slice(template.at + PLACEHOLDER.length);
  const code = head + base64 + tail;
  // The proof: nothing but the placeholder changed, and the inserted text is base64 only.
  if (
    !code.startsWith(head) ||
    !code.endsWith(tail) ||
    code.length !== head.length + base64.length + tail.length ||
    code.slice(head.length, head.length + base64.length) !== base64 ||
    code.includes(PLACEHOLDER)
  )
    throw new Error('BAKE_RENDER_MISMATCH');
  if (code.length > MAX_BODY_CHARS) throw new Error('BAKE_BODY_TOO_LARGE');
  return {
    code,
    templateHash: template.hash,
    dataHash: createHash('sha256').update(block).digest('hex'),
    bytes: block.length,
  };
}

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;
/** Bytes of a block with no items (header, origin, delete list). */
function headerBytes(header: DataBlockHeader) {
  return encodeDataBlock(header, []).length;
}
export interface BakeChunk extends RenderedBody {
  keys: string[];
  deleteIds: string[];
}
/**
 * Encode the items in as few bodies as fit the worker limit. All chunks share the header and the
 * origin; only the first deletes. An item that alone exceeds the limit is refused.
 */
export function renderChunks(
  header: DataBlockHeader,
  items: readonly BakeItem[],
  limit = MAX_BODY_CHARS,
): BakeChunk[] {
  const template = loadTemplate(header.template);
  const fixed = template.text.length - PLACEHOLDER.length;
  const origin = originOf(items);
  const chunks: BakeChunk[] = [];
  let pending: BakeItem[] = [];
  let bytes = headerBytes(header);
  const flush = (deleteIds: string[]) => {
    const block = encodeDataBlock({ ...header, deleteIds }, pending, origin);
    chunks.push({
      ...renderTemplate(header.template, block),
      keys: pending.map((item) => item.key),
      deleteIds,
    });
    pending = [];
  };
  const fits = (size: number) => fixed + base64Length(size) <= limit;
  for (const item of items) {
    const size = itemBytes(header.template, item);
    if (!fits(bytes + size)) {
      if (!pending.length) throw new Error('BAKE_ITEM_TOO_LARGE');
      flush(chunks.length ? [] : header.deleteIds);
      bytes = headerBytes({ ...header, deleteIds: [] });
      if (!fits(bytes + size)) throw new Error('BAKE_ITEM_TOO_LARGE');
    }
    pending.push(item);
    bytes += size;
  }
  if (pending.length || !chunks.length) flush(chunks.length ? [] : header.deleteIds);
  return chunks;
}
