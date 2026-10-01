import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentIdSchema,
  attachmentKindSchema,
  storedAttachments,
  type StoredAttachment,
} from '../contracts/workspace.ts';

/**
 * Composer attachments (SPEC-01.12, ARCH-01 §3 「첨부 보관과 읽기 도구」): each project keeps its
 * files under `<data>/attachments/<projectId>/<id>.<ext>` with `<id>.json` beside it; `id` is the
 * first 24 hex digits of the content's SHA-256, so the same content is kept once.
 */
type Kind = StoredAttachment['kind'];
/**
 * Images the model is shown, as capture_view's (ToolImage). A larger image is shown through the
 * view copy the composer makes (long side 1600 px JPEG, `saveView`); without one it is described.
 */
export const MAX_VIEWABLE_IMAGE_BYTES = 1_000_000;
/** One text page of attachment_read, in bytes. */
export const TEXT_PAGE_BYTES = 20_000;
export const MAX_TEXT_PAGE_BYTES = 40_000;
const projectIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const recordSchema = z.object({
  id: attachmentIdSchema,
  name: z.string(),
  size: z.number().int().min(0),
  type: z.string(),
  kind: attachmentKindSchema,
  file: z.string().regex(/^[0-9a-f]{24}(\.[a-z0-9]{1,10})?$/),
  createdAt: z.string(),
});
type AttachmentRecord = z.infer<typeof recordSchema>;
const IMAGE_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;
export type ImageType = (typeof IMAGE_TYPES)[keyof typeof IMAGE_TYPES];

/** The file name as a person gave it, without folders or control characters. */
export function attachmentName(value: unknown) {
  if (typeof value !== 'string') throw new DomainError('INVALID_INPUT');
  const name = value
    .split(/[\\/]/)
    .at(-1)!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255);
  if (!name) throw new DomainError('INVALID_INPUT');
  return name;
}
const extensionOf = (name: string) => {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return match ? '.' + match[1].toLowerCase() : '';
};

/** What a file is, from its first bytes (not its name): image type, PDF, Rhino, DWG, text, binary. */
export function sniff(head: Buffer, declared = ''): { kind: Kind; type: string } {
  const ascii = head.subarray(0, 32).toString('latin1');
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { kind: 'image', type: IMAGE_TYPES.png };
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return { kind: 'image', type: IMAGE_TYPES.jpeg };
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a'))
    return { kind: 'image', type: IMAGE_TYPES.gif };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP')
    return { kind: 'image', type: IMAGE_TYPES.webp };
  if (ascii.startsWith('%PDF-')) return { kind: 'pdf', type: 'application/pdf' };
  if (ascii.startsWith('3D Geometry File Format')) return { kind: 'rhino-3dm', type: 'model/3dm' };
  if (/^AC10\d\d/.test(ascii)) return { kind: 'dwg', type: 'image/vnd.dwg' };
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(declared) ? declared.slice(0, 200) : '';
  if (!head.includes(0)) {
    try {
      // A multi-byte character cut at the end of the head is not an error (stream mode).
      new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
      return { kind: 'text', type: type || 'text/plain' };
    } catch {
      /* not UTF-8 text */
    }
  }
  return { kind: 'binary', type: type || 'application/octet-stream' };
}

/** Moves a byte offset forward to the start of a UTF-8 character. */
const charStart = (bytes: Buffer, at: number) => {
  let index = at;
  while (index < bytes.length && (bytes[index] & 0xc0) === 0x80) index++;
  return index;
};

export class AttachmentStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  directory(projectId: string) {
    return join(this.root, projectIdSchema.parse(projectId));
  }
  /** An absolute path inside the project's folder, or a refusal. */
  #inside(projectId: string, file: string) {
    const directory = this.directory(projectId);
    const path = resolve(directory, file);
    const rel = relative(directory, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new DomainError('INVALID_INPUT');
    return path;
  }
  #record(projectId: string, id: string): AttachmentRecord | undefined {
    if (!attachmentIdSchema.safeParse(id).success || !projectIdSchema.safeParse(projectId).success)
      return undefined;
    try {
      const record = recordSchema.parse(
        JSON.parse(readFileSync(this.#inside(projectId, id + '.json'), 'utf8')),
      );
      return record.id === id && existsSync(this.#inside(projectId, record.file))
        ? record
        : undefined;
    } catch {
      return undefined;
    }
  }
  #entry(projectId: string, record: AttachmentRecord, name = record.name): StoredAttachment {
    return {
      id: record.id,
      name,
      size: record.size,
      type: record.type,
      kind: record.kind,
      path: this.#inside(projectId, record.file),
      copied: true,
    };
  }
  /** The stored attachment of `id` in the project (undefined when it is not kept). */
  get(projectId: string, id: string): StoredAttachment | undefined {
    const record = this.#record(projectId, id);
    return record && this.#entry(projectId, record);
  }

  /**
   * Keeps one uploaded file: streamed to a temporary file while hashed and counted, then renamed
   * to its content name. Over MAX_ATTACHMENT_BYTES the upload stops with INPUT_TOO_LARGE.
   */
  async save(
    projectId: string,
    rawName: unknown,
    body: AsyncIterable<Buffer | string>,
    declaredType = '',
  ): Promise<StoredAttachment> {
    const name = attachmentName(rawName);
    const directory = this.directory(projectId);
    await mkdir(directory, { recursive: true });
    const temporary = this.#inside(projectId, `.${randomBytes(8).toString('hex')}.part`);
    const hash = createHash('sha256');
    const out = createWriteStream(temporary, { flags: 'wx' });
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      for await (const raw of body) {
        const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw;
        size += chunk.length;
        if (size > MAX_ATTACHMENT_BYTES) throw new DomainError('INPUT_TOO_LARGE');
        if (head.length < 65536)
          head = Buffer.concat([head, chunk.subarray(0, 65536 - head.length)]);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((done) => out.once('drain', () => done()));
      }
      out.end();
      await finished(out);
    } catch (error) {
      out.destroy();
      await rm(temporary, { force: true });
      throw error;
    }
    const id = hash.digest('hex').slice(0, 24);
    const existing = this.#record(projectId, id);
    if (existing) {
      await rm(temporary, { force: true });
      return this.#entry(projectId, existing, name);
    }
    const { kind, type } = sniff(head, declaredType);
    const file = id + extensionOf(name);
    await rename(temporary, this.#inside(projectId, file));
    const record: AttachmentRecord = {
      id,
      name,
      size,
      type,
      kind,
      file,
      createdAt: new Date().toISOString(),
    };
    await writeFile(this.#inside(projectId, id + '.json'), JSON.stringify(record));
    return this.#entry(projectId, record);
  }

  /**
   * A request's attachment entries made to match what is kept (ARCH-01 §3): size, type, kind,
   * path and copied come from the record; an id the project does not keep is INVALID_INPUT.
   * Inline text files stay as they are.
   */
  normalize(projectId: string, files: unknown): unknown {
    if (!Array.isArray(files)) return files;
    return files.map((file) => {
      if (!file || typeof file !== 'object' || !('id' in file) || 'text' in file) return file;
      const kept = this.get(projectId, String((file as { id: unknown }).id));
      if (!kept) throw new DomainError('INVALID_INPUT');
      const name = (file as { name?: unknown }).name;
      return {
        ...file,
        ...kept,
        name: typeof name === 'string' && name.trim() ? attachmentName(name) : kept.name,
      };
    });
  }

  /** The view copy of a large image (`<id>.view`), when the composer made one. */
  #view(projectId: string, id: string) {
    const path = this.#inside(projectId, id + '.view');
    if (!existsSync(path)) return undefined;
    const head = readFileSync(path).subarray(0, 16);
    const { kind, type } = sniff(head);
    return kind === 'image' ? { path, type: type as ImageType } : undefined;
  }
  /**
   * Keeps the composer's smaller copy of a large kept image (PNG/JPEG, at most
   * MAX_VIEWABLE_IMAGE_BYTES): the model and the chip preview see it instead of the original.
   */
  async saveView(projectId: string, id: string, body: AsyncIterable<Buffer | string>) {
    const kept = this.get(projectId, id);
    if (!kept || kept.kind !== 'image') throw new DomainError('NOT_FOUND');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of body) {
      const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw;
      size += chunk.length;
      if (size > MAX_VIEWABLE_IMAGE_BYTES) throw new DomainError('INPUT_TOO_LARGE');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const { type } = sniff(bytes.subarray(0, 16));
    if (type !== IMAGE_TYPES.png && type !== IMAGE_TYPES.jpeg)
      throw new DomainError('INVALID_INPUT');
    await writeFile(this.#inside(projectId, id + '.view'), bytes);
    return { id, view: true };
  }

  /** The bytes of a kept image for the composer chip's preview; undefined for anything else. */
  async image(projectId: string, id: string) {
    const kept = this.get(projectId, id);
    if (!kept || kept.kind !== 'image') return undefined;
    const view = this.#view(projectId, id);
    return view
      ? { type: view.type, bytes: await readFile(view.path) }
      : { type: kept.type, bytes: await readFile(kept.path) };
  }

  /**
   * attachment_read: text in byte pages, an image the model sees, or what is known of the file.
   * Only ids in `allowed` (the turn's request and its conversation) are read.
   */
  async read(
    projectId: string,
    allowed: ReadonlyMap<string, string>,
    { id, offset = 0, limit = TEXT_PAGE_BYTES }: { id: string; offset?: number; limit?: number },
  ): Promise<AttachmentRead> {
    const kept = allowed.has(id) ? this.get(projectId, id) : undefined;
    if (!kept)
      throw Object.assign(new Error('ATTACHMENT_NOT_FOUND'), { code: 'ATTACHMENT_NOT_FOUND' });
    const name = allowed.get(id) || kept.name;
    const about = { id, name, kind: kept.kind, size: kept.size, type: kept.type };
    const view =
      kept.kind === 'image' && kept.size > MAX_VIEWABLE_IMAGE_BYTES
        ? this.#view(projectId, id)
        : undefined;
    return readFileContent(kept, about, { offset, limit }, view);
  }
}

/** Size and content kind of a file on disk (its first 64 KB are sniffed, not its name). */
export async function describeFile(
  path: string,
): Promise<{ size: number; kind: Kind; type: string }> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, 65536));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return { size, ...sniff(head.subarray(0, bytesRead)) };
  } finally {
    await handle.close();
  }
}

/**
 * The read result of one file (attachment_read, file_read): text in byte pages, an image the model
 * sees (`view` is a smaller copy of a large image), or what is known of it with a note.
 */
export async function readFileContent(
  file: { path: string; size: number; kind: Kind; type: string },
  about: Record<string, unknown>,
  { offset = 0, limit = TEXT_PAGE_BYTES }: { offset?: number; limit?: number } = {},
  view?: { path: string; type: ImageType },
): Promise<AttachmentRead> {
  if (file.kind === 'text') {
    const start = Math.min(offset, file.size);
    const length = Math.min(Math.max(1, limit), MAX_TEXT_PAGE_BYTES);
    // Read a few bytes more to finish the last character.
    const handle = await open(file.path, 'r');
    let bytes: Buffer;
    try {
      const buffer = Buffer.alloc(Math.min(length + 3, file.size - start));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      bytes = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const from = charStart(bytes, 0);
    let to = Math.min(bytes.length, length);
    // End before a character the page cannot finish.
    if (start + to < file.size) while (to > from && (bytes[to] & 0xc0) === 0x80) to--;
    const next = start + to;
    return {
      ...about,
      offset: start + from,
      nextOffset: next < file.size ? next : null,
      text: bytes.subarray(from, to).toString('utf8'),
    };
  }
  if (file.kind === 'image') {
    if (file.size > MAX_VIEWABLE_IMAGE_BYTES && !view)
      return {
        ...about,
        note: `The image is larger than ${MAX_VIEWABLE_IMAGE_BYTES} bytes and has no smaller view copy, so it cannot be shown; ask the user for a smaller copy or a crop.`,
      };
    return {
      image: (await readFile(view?.path ?? file.path)).toString('base64'),
      mimeType: view?.type ?? (file.type as ImageType),
      about: view ? { ...about, shown: 'reduced view copy (long side 1600 px)' } : about,
    };
  }
  const notes: Record<Exclude<Kind, 'text' | 'image'>, string> = {
    pdf: 'PDF text extraction is not available in this VIDE version. Ask the user for the pages you need as images or text.',
    'rhino-3dm':
      'Rhino model file. This tool cannot read its contents; ask the user to open it with 파일에서 열기 or Link it, then use the model tools.',
    dwg: 'DWG drawing. This tool cannot read its contents; ask the user to open it with 파일에서 열기 or Link it in ZWCAD, then use the model tools.',
    binary: 'Binary file: only its name, size and type are known.',
  };
  return { ...about, note: notes[file.kind] };
}
export type AttachmentRead =
  | { image: string; mimeType: ImageType; about: Record<string, unknown> }
  | Record<string, unknown>;

/**
 * The attachments a turn may read: the stored ones of its request and of the earlier requests of
 * the same conversation (id → name as the request gave it).
 */
export function readableAttachments(
  input: { files?: readonly unknown[]; conversationId?: string },
  conversationInputs: readonly { files?: readonly unknown[]; conversationId?: string }[] = [],
) {
  const allowed = new Map<string, string>();
  const sources = input.conversationId
    ? [
        ...conversationInputs.filter((other) => other.conversationId === input.conversationId),
        input,
      ]
    : [input];
  for (const source of sources)
    for (const file of storedAttachments(source.files ?? [])) allowed.set(file.id, file.name);
  return allowed;
}
