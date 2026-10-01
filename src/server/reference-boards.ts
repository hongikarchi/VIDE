// Reference-image boards (SPEC-09.3·09.9, PLAN-26 T-090 (a)): the regions drawn over an image
// attachment and the flattened input image made from them, kept per project and attachment under
// `<data>/reference-boards/<projectId>/<attachmentId>.json` and `<attachmentId>.masked.png`.
// The attachment itself is never copied or changed. `server.ts` delegates
// `/api/v1/projects/:id/reference-boards/:attachmentId[/masked]` here.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import {
  emptyReferenceBoard,
  referenceBoardInputSchema,
  referenceBoardSchema,
  type ReferenceBoard,
} from '../contracts/reference-board.ts';

const projectIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const attachmentIdSchema = z.string().regex(/^[0-9a-f]{24}$/);
/** The flattened input image is a PNG the page draws (long side at most 1600 px). */
export const MAX_MASKED_BYTES = 8 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class ReferenceBoards {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  #file(projectId: string, attachmentId: string, suffix: '.json' | '.masked.png') {
    return join(
      this.root,
      projectIdSchema.parse(projectId),
      attachmentIdSchema.parse(attachmentId) + suffix,
    );
  }
  async #write(path: string, bytes: Buffer | string) {
    await mkdir(join(path, '..'), { recursive: true });
    // Written beside and renamed, so a reader never sees half a record.
    const temporary = `${path}.${randomBytes(6).toString('hex')}.part`;
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  }

  /** The board of an attachment; an empty one when nothing was drawn yet. */
  get(projectId: string, attachmentId: string): ReferenceBoard {
    const path = this.#file(projectId, attachmentId, '.json');
    if (!existsSync(path)) return emptyReferenceBoard(attachmentId);
    try {
      const board = referenceBoardSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      return board.attachmentId === attachmentId ? board : emptyReferenceBoard(attachmentId);
    } catch {
      // A damaged record does not block the editor; the next save replaces it.
      return emptyReferenceBoard(attachmentId);
    }
  }

  /** Replaces the regions, letters and stage; the flattened image's note stays. */
  async save(projectId: string, attachmentId: string, input: unknown): Promise<ReferenceBoard> {
    const value = referenceBoardInputSchema.parse(input);
    const letters = new Set(value.regions.map((region) => region.letter));
    if (letters.size !== value.regions.length) throw new DomainError('INVALID_INPUT');
    const board: ReferenceBoard = {
      ...value,
      attachmentId,
      updatedAt: new Date().toISOString(),
      masked: this.get(projectId, attachmentId).masked,
    };
    await this.#write(this.#file(projectId, attachmentId, '.json'), JSON.stringify(board));
    return board;
  }

  /** Keeps the flattened input image (PNG) beside the record. */
  async saveMasked(
    projectId: string,
    attachmentId: string,
    body: AsyncIterable<Buffer | string>,
  ): Promise<ReferenceBoard> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of body) {
      const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw;
      size += chunk.length;
      if (size > MAX_MASKED_BYTES) throw new DomainError('INPUT_TOO_LARGE');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (!bytes.subarray(0, 8).equals(PNG)) throw new DomainError('INVALID_INPUT');
    await this.#write(this.#file(projectId, attachmentId, '.masked.png'), bytes);
    const board: ReferenceBoard = {
      ...this.get(projectId, attachmentId),
      masked: { savedAt: new Date().toISOString(), size: bytes.length },
    };
    await this.#write(this.#file(projectId, attachmentId, '.json'), JSON.stringify(board));
    return board;
  }

  /** The flattened input image, when one was saved. */
  async masked(projectId: string, attachmentId: string) {
    const path = this.#file(projectId, attachmentId, '.masked.png');
    return existsSync(path) ? readFile(path) : undefined;
  }

  /** Removes a board and its image (the attachment stays). */
  async remove(projectId: string, attachmentId: string) {
    await rm(this.#file(projectId, attachmentId, '.json'), { force: true });
    await rm(this.#file(projectId, attachmentId, '.masked.png'), { force: true });
  }
}

export interface ReferenceRouteContext {
  boards: ReferenceBoards | undefined;
  /** Whether the project keeps `attachmentId` as an image (only images get a board). */
  isImage: (projectId: string, attachmentId: string) => boolean;
  /** Throws NOT_FOUND for an unknown project. */
  project: (projectId: string) => unknown;
  body: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  send: (status: number, data: unknown) => void;
  response: ServerResponse;
}

/** GET/PUT a board, POST/GET its flattened input image. Returns false when the path is not ours. */
export async function referenceRoutes(
  url: URL,
  request: IncomingMessage,
  context: ReferenceRouteContext,
): Promise<boolean> {
  const match = /^\/api\/v1\/projects\/([^/]+)\/reference-boards\/([0-9a-f]{24})(\/masked)?$/.exec(
    url.pathname,
  );
  if (!match) return false;
  const [, projectId, attachmentId, masked] = match;
  context.project(projectId);
  const boards = context.boards;
  if (!boards || !context.isImage(projectId, attachmentId)) throw new DomainError('NOT_FOUND');
  if (!masked && request.method === 'GET') {
    context.send(200, boards.get(projectId, attachmentId));
    return true;
  }
  if (!masked && request.method === 'PUT') {
    context.send(200, await boards.save(projectId, attachmentId, await context.body(request)));
    return true;
  }
  if (masked && request.method === 'POST') {
    if (request.headers['content-type'] !== 'application/octet-stream')
      throw new DomainError('INVALID_INPUT');
    context.send(200, await boards.saveMasked(projectId, attachmentId, request));
    return true;
  }
  if (masked && request.method === 'GET') {
    const bytes = await boards.masked(projectId, attachmentId);
    if (!bytes) throw new DomainError('NOT_FOUND');
    context.response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    context.response.end(bytes);
    return true;
  }
  throw new DomainError('NOT_FOUND');
}
