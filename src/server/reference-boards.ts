// Reference-image boards (SPEC-09, PLAN-26 T-090, ARCH-01 §3 「참고 이미지 확인 보드」): the
// regions drawn over an image attachment, the flattened input image made from them, the 판s of
// the AI's interpretation and the image job of each 판. Kept per project and attachment under
// `<data>/reference-boards/<projectId>/<attachmentId>.json` and `<attachmentId>.masked.png`; the
// view captures and generated images are the project's outputs, under
// `<data>/outputs/<projectId>/reference/<attachmentId>/` (`view.<ext>`, `v<N>-view.<ext>`,
// `v<N>.png`). The attachment itself is never copied or changed. `server.ts` delegates
// `/api/v1/projects/:id/reference-boards/…` and `…/reference-settings` here, and hands the
// reference turns (`input.reference`) to `before`/`prepare`/`turnItem`/`afterTurn`.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import { hostUse } from '../contracts/request-scope.ts';
import type { StoredWork } from '../contracts/stored-work.ts';
import {
  UNKNOWN_TARGET,
  effectiveRegions,
  emptyReferenceBoard,
  referenceBoardInputSchema,
  referenceBoardSchema,
  referenceRequestSchema,
  regionBox,
  type ReferenceAction,
  type ReferenceBoard,
  type ReferenceOutput,
  type ReferenceRequest,
  type ReferenceVersion,
  type VersionImage,
} from '../contracts/reference-board.ts';
import type { ReferenceTurn } from './conversations.ts';
import {
  imageJobPrompt,
  runImageJob,
  type ImageJobOptions,
  type ImageJobResult,
} from './reference-image.ts';

const projectIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const attachmentIdSchema = z.string().regex(/^[0-9a-f]{24}$/);
/** The flattened input image is a PNG the page draws (long side at most 1600 px). */
export const MAX_MASKED_BYTES = 8 * 1024 * 1024;
/** The 3D view capture the page sends with a reference turn (PNG or JPEG). */
export const MAX_VIEW_BYTES = 4 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const isJpeg = (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const sourceLabel = { user: '사용자', estimated: '추정', unknown: '모름' } as const;

export const settingsSchema = z.object({ images: z.boolean() }).strict();
export type ReferenceSettings = z.infer<typeof settingsSchema>;

// --- What the AI is told (ARCH-01 §3; the board draws from the checked output, never the text) ---

const SHAPE_RULES =
  'summary = one Korean sentence of what to apply where; ' +
  'imagePrompt = an English instruction for an image model that redraws a 3D view of OUR building ' +
  'with the element(s) applied (no text in the image); regions = one entry per region letter you ' +
  'are asked about, never a letter that is not given: element (short Korean name), anchor {x, y} ' +
  "(fractions of the image width/height, a point inside the region the bubble's leader points at, " +
  'or null), values [{name, value, unit or null, source}] where source is "user" when the value ' +
  'comes from the user\'s note or correction, "estimated" when you read it from the image (write ' +
  'such values as approximate, e.g. 약 600), "unknown" when it cannot be decided; line = the ' +
  'bubble sentence in Korean, at most about 60 characters, starting with the letter (e.g. "A: 수직 ' +
  '루버 · 간격 약 600 · 깊이 300 느낌"); openQuestions = what the image cannot decide (material, ' +
  'end detail…), in Korean; target = where in OUR model it applies as the user said it (pinned ' +
  'object, layer, facade…), or exactly "unknown" when nothing says so: never guess a location.';
const OUTPUT_RULES =
  'Fill `reference` of the output: ' +
  SHAPE_RULES +
  ' text = the same interpretation in plain Korean sentences for the chat. status "done"; do not ' +
  'ask question cards for this check.';
const INTERPRET_RULES =
  "Reference image check (SPEC-09). The turn shows the reference with the user's regions drawn " +
  'over it as translucent fills with letter badges (the image); the original reference is the ' +
  "turn's `file` item: read it with attachment_read when you need its detail. `regions` lists " +
  "each region: letter, the user's note (may be empty) and " +
  'box [x0, y0, x1, y1] in fractions of the image. Read only what the regions mark, following ' +
  'the notes. ' +
  OUTPUT_RULES;
const regionRules = (letter: string) =>
  `Reference image check (SPEC-09): the user corrects region ${letter} only (correction in ` +
  '`note`). `current` is the interpretation so far; the other regions stay exactly as they are. ' +
  `Return in reference.regions only region ${letter}, read again with the correction (values the ` +
  'correction gives get source "user"); summary and imagePrompt cover the whole board after the ' +
  'correction. ' +
  OUTPUT_RULES;
const CHAT_RULES =
  'This conversation has a reference image board (SPEC-09); `current` is its interpretation. If ' +
  "the user's message corrects it, return `reference` with only the corrected regions (letters " +
  'from `current`; values the user gives get source "user"), summary and imagePrompt for the ' +
  'whole board. If it corrects the board but you cannot tell which region, ask which one ' +
  '(status "question") and return reference null. Otherwise reference null. In `reference`: ' +
  SHAPE_RULES;
/**
 * A turn with the host (or a jig's) has no structured output: a correction comes as a fenced
 * block at the end of the reply, which the engine takes out of the text (`takeReferenceBlock`).
 */
const CHAT_BLOCK_RULES =
  'This conversation has a reference image board (SPEC-09); `current` is its interpretation. ' +
  "Do the user's request as usual. If the message also corrects the board, end the reply with " +
  'one fenced json block {"reference": {"summary": ..., "imagePrompt": ..., "regions": [...]}} ' +
  'holding only the corrected regions (letters from `current`; values the user gives get source ' +
  '"user"), summary and imagePrompt for the whole board; VIDE makes the next version from it. ' +
  'If it corrects the board but you cannot tell which region, ask which one and add no block. ' +
  'Otherwise add no block. In the block: ' +
  SHAPE_RULES;
const CONFIRM_RULES =
  'The user confirmed this interpretation of a reference image with [맞음] (판 `number`). Model ' +
  'it now in the open document. Use the values as given; values with source "estimated" are used ' +
  'as given and reported in the result as 이미지에서 추정한 값. If a value has to change, ask ' +
  'before changing it. `target` says where each region applies (as the user answered it).';

/** The 판's regions as the AI and the ledger see them. */
const interpretationData = (version: ReferenceVersion) => ({
  number: version.number,
  summary: version.summary,
  regions: version.regions.map((region) => ({
    letter: region.letter,
    element: region.element,
    values: region.values,
    openQuestions: region.openQuestions,
    target: region.target,
  })),
});

/**
 * The [맞음] turn's text at most (UTF-8 bytes): the request keeps its body under 20000 characters
 * and the whole stored request under 200 KB with two images (SPEC-09.8 3); the turn's
 * `reference-board` item always carries every region.
 */
export const CONFIRM_TEXT_BYTES = 12_000;
/** The text of the [맞음] turn: what was confirmed, readable in the chat and the ledger. */
export function confirmText(version: ReferenceVersion, name: string) {
  const lines = [
    `맞음 → 모델링 반영 · 판 ${version.number} · 참고 이미지 ${name}`,
    `요약: ${version.summary}`,
  ];
  let size = Buffer.byteLength(lines.join('\n'));
  for (const [index, region] of version.regions.entries()) {
    const values = region.values
      .map(
        (value) =>
          `${value.name} ${value.value}${value.unit ? ' ' + value.unit : ''}(${sourceLabel[value.source]})`,
      )
      .join(' · ');
    const line = `${region.letter} ${region.element} → ${region.target}${values ? ': ' + values : ''}`;
    const more = `… 영역 ${version.regions.length - index}개 더 · 전체는 판 ${version.number}의 데이터에 있습니다`;
    if (size + Buffer.byteLength(line) + Buffer.byteLength(more) + 2 > CONFIRM_TEXT_BYTES) {
      lines.push(more);
      break;
    }
    lines.push(line);
    size += Buffer.byteLength(line) + 1;
  }
  return lines.join('\n');
}

/**
 * The next 판 from a reference turn's checked output (SPEC-09.4·09.6), or why there is none. The
 * whole board must come back with exactly the drawn letters; a region turn changes only its
 * region; a chat correction only the letters it names (unknown letters: nothing changes).
 */
export function nextVersion(
  board: ReferenceBoard,
  turn: {
    action: ReferenceAction | 'spoken';
    letter?: string;
    output: ReferenceOutput;
    requestId: string;
    conversationId: string;
    now: string;
  },
): { version: ReferenceVersion } | { problem: string } | undefined {
  const last = board.versions.at(-1);
  const base = {
    number: (last?.number ?? 0) + 1,
    conversationId: turn.conversationId,
    requestId: turn.requestId,
    createdAt: turn.now,
    summary: turn.output.summary,
    imagePrompt: turn.output.imagePrompt,
    confirmed: null,
    image: { state: 'waiting' } as VersionImage,
  };
  if (turn.action === 'interpret') {
    const expected = effectiveRegions(board.regions).map((region) => region.letter);
    const given = new Map(turn.output.regions.map((region) => [region.letter, region]));
    if (given.size !== expected.length || expected.some((letter) => !given.has(letter)))
      return { problem: 'REGION_MISMATCH' };
    return {
      version: {
        ...base,
        kind: 'all',
        changed: expected,
        regions: expected.map((letter) => given.get(letter)!),
      },
    };
  }
  if (!last || last.confirmed) return turn.action === 'spoken' ? undefined : { problem: 'NO_BASE' };
  const known = new Set(last.regions.map((region) => region.letter));
  if (turn.action === 'region') {
    const region = turn.output.regions.find((entry) => entry.letter === turn.letter);
    if (!region || !known.has(region.letter)) return { problem: 'REGION_MISMATCH' };
    return {
      version: {
        ...base,
        kind: 'region',
        changed: [region.letter],
        regions: last.regions.map((entry) => (entry.letter === region.letter ? region : entry)),
      },
    };
  }
  const changed = turn.output.regions.filter((region) => known.has(region.letter));
  if (!changed.length || changed.length !== turn.output.regions.length) return undefined;
  const byLetter = new Map(changed.map((region) => [region.letter, region]));
  return {
    version: {
      ...base,
      kind: 'spoken',
      changed: changed.map((region) => region.letter),
      regions: last.regions.map((entry) => byLetter.get(entry.letter) ?? entry),
    },
  };
}

const terminal = (state: string) => !['queued', 'running'].includes(state);

interface ImageJob {
  /** The 판 the job draws for, and the 판s carried on from it while it runs ([새 판으로 고치기]). */
  number: number;
  numbers: Set<number>;
  controller: AbortController;
  done: Promise<void>;
}

export interface ReferenceBoardsOptions {
  /** `<data>/outputs`: view captures and generated images per project (the 산출물). */
  outputs?: string;
  image?: ImageJobOptions;
  /** Test seam: the image job (default `runImageJob`). */
  runImage?: typeof runImageJob;
}

export class ReferenceBoards {
  readonly root: string;
  readonly outputs: string;
  /** The stored request of an id (set by the server once the workspace exists). */
  lookup?: (projectId: string, requestId: string) => StoredWork | undefined;
  private readonly options: ReferenceBoardsOptions;
  readonly #jobs = new Map<string, ImageJob>();
  readonly #queues = new Map<string, Promise<unknown>>();
  /** The engine is stopping: no image job starts any more (`close`). */
  #closing = false;
  constructor(root: string, options: ReferenceBoardsOptions = {}) {
    this.root = resolve(root);
    this.outputs = resolve(options.outputs ?? join(root, '..', 'outputs'));
    this.options = options;
  }
  #file(projectId: string, attachmentId: string, suffix: '.json' | '.masked.png') {
    return join(
      this.root,
      projectIdSchema.parse(projectId),
      attachmentIdSchema.parse(attachmentId) + suffix,
    );
  }
  /** The board's outputs folder (view captures, generated images). */
  outputFolder(projectId: string, attachmentId: string) {
    return join(
      this.outputs,
      projectIdSchema.parse(projectId),
      'reference',
      attachmentIdSchema.parse(attachmentId),
    );
  }
  async #write(path: string, bytes: Buffer | string) {
    await mkdir(join(path, '..'), { recursive: true });
    // Written beside and renamed, so a reader never sees half a record.
    const temporary = `${path}.${randomBytes(6).toString('hex')}.part`;
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  }
  /** One change of a board at a time (the page, a turn's end and an image job all write). */
  #update<T>(projectId: string, attachmentId: string, change: () => Promise<T>): Promise<T> {
    const key = `${projectId}/${attachmentId}`;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(change);
    this.#queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }
  #put(projectId: string, board: ReferenceBoard) {
    return this.#write(
      this.#file(projectId, board.attachmentId, '.json'),
      JSON.stringify({ ...board, updatedAt: new Date().toISOString() }),
    );
  }

  /** The record as stored; an empty one when nothing was drawn yet. */
  #read(projectId: string, attachmentId: string): ReferenceBoard {
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
  /** The board of an attachment; an image job no longer running reads as interrupted. */
  get(projectId: string, attachmentId: string): ReferenceBoard {
    const board = this.#read(projectId, attachmentId);
    const job = this.#jobs.get(`${projectId}/${attachmentId}`);
    return {
      ...board,
      versions: board.versions.map((version) =>
        version.image.state === 'running' && !job?.numbers.has(version.number)
          ? { ...version, image: { state: 'failed', code: 'IMAGE_INTERRUPTED' } }
          : version,
      ),
    };
  }

  /** Whether the board's reference turn is still on its way (queued or running). */
  #answering(projectId: string, board: ReferenceBoard) {
    const running = board.pending && this.lookup?.(projectId, board.pending.requestId);
    return !!running && !terminal(running.state);
  }

  /**
   * Replaces the regions, letters and stage; the image, 판s and turn state stay. While a check is
   * answering the regions it was sent with stay (REFERENCE_BUSY): its answer is read against them.
   */
  async save(projectId: string, attachmentId: string, input: unknown): Promise<ReferenceBoard> {
    const value = referenceBoardInputSchema.parse(input);
    const letters = new Set(value.regions.map((region) => region.letter));
    if (letters.size !== value.regions.length) throw new DomainError('INVALID_INPUT');
    return this.#update(projectId, attachmentId, async () => {
      const current = this.#read(projectId, attachmentId);
      if (
        this.#answering(projectId, current) &&
        (JSON.stringify(current.regions) !== JSON.stringify(value.regions) ||
          current.nextIndex !== value.nextIndex)
      )
        throw new DomainError('REFERENCE_BUSY');
      const board: ReferenceBoard = { ...current, ...value };
      await this.#put(projectId, board);
      return this.get(projectId, attachmentId);
    });
  }

  /** Keeps the flattened input image (PNG) beside the record. */
  async saveMasked(
    projectId: string,
    attachmentId: string,
    body: AsyncIterable<Buffer | string>,
  ): Promise<ReferenceBoard> {
    const bytes = await collect(body, MAX_MASKED_BYTES);
    if (!bytes.subarray(0, 8).equals(PNG)) throw new DomainError('INVALID_INPUT');
    return this.#update(projectId, attachmentId, async () => {
      if (this.#answering(projectId, this.#read(projectId, attachmentId)))
        throw new DomainError('REFERENCE_BUSY');
      await this.#write(this.#file(projectId, attachmentId, '.masked.png'), bytes);
      await this.#put(projectId, {
        ...this.#read(projectId, attachmentId),
        masked: { savedAt: new Date().toISOString(), size: bytes.length },
      });
      return this.get(projectId, attachmentId);
    });
  }

  /** The flattened input image, when one was saved. */
  async masked(projectId: string, attachmentId: string) {
    const path = this.#file(projectId, attachmentId, '.masked.png');
    return existsSync(path) ? readFile(path) : undefined;
  }

  /** Keeps the 3D view capture the next image job draws on (PNG or JPEG). */
  async saveView(projectId: string, attachmentId: string, body: AsyncIterable<Buffer | string>) {
    const bytes = await collect(body, MAX_VIEW_BYTES);
    const extension = bytes.subarray(0, 8).equals(PNG) ? 'png' : isJpeg(bytes) ? 'jpg' : '';
    if (!extension) throw new DomainError('INVALID_INPUT');
    const folder = this.outputFolder(projectId, attachmentId);
    await rm(join(folder, extension === 'png' ? 'view.jpg' : 'view.png'), { force: true });
    await this.#write(join(folder, `view.${extension}`), bytes);
    return { size: bytes.length };
  }
  #view(projectId: string, attachmentId: string, prefix = 'view') {
    const folder = this.outputFolder(projectId, attachmentId);
    for (const extension of ['png', 'jpg'])
      if (existsSync(join(folder, `${prefix}.${extension}`)))
        return join(folder, `${prefix}.${extension}`);
  }

  /** A 판's generated image (PNG), when the job made one. */
  async generated(projectId: string, attachmentId: string, number: number) {
    const path = join(this.outputFolder(projectId, attachmentId), `v${number}.png`);
    return existsSync(path) ? readFile(path) : undefined;
  }

  /** Removes a board, its image and its outputs (the attachment stays). */
  async remove(projectId: string, attachmentId: string) {
    this.cancelImage(projectId, attachmentId);
    await rm(this.#file(projectId, attachmentId, '.json'), { force: true });
    await rm(this.#file(projectId, attachmentId, '.masked.png'), { force: true });
    await rm(this.outputFolder(projectId, attachmentId), { recursive: true, force: true });
  }

  // --- Project setting (SPEC-09.7 6) ---------------------------------------------------------

  settings(projectId: string): ReferenceSettings {
    try {
      return settingsSchema.parse(
        JSON.parse(
          readFileSync(join(this.root, projectIdSchema.parse(projectId), 'settings.json'), 'utf8'),
        ),
      );
    } catch {
      return { images: true };
    }
  }
  async saveSettings(projectId: string, value: unknown) {
    const settings = settingsSchema.parse(value);
    await this.#write(
      join(this.root, projectIdSchema.parse(projectId), 'settings.json'),
      JSON.stringify(settings),
    );
    // Turned off: the project's running jobs stop and their 판s read '이미지 생성 꺼짐'.
    if (!settings.images)
      for (const [key, job] of this.#jobs)
        if (key.startsWith(`${projectId}/`)) job.controller.abort('off');
    return settings;
  }

  // --- Reference turns (SPEC-09.4·09.6·09.8) --------------------------------------------------

  /**
   * Before a reference request is placed in its conversation: a region correction and [맞음] go
   * to the conversation the board's 판 came from, on its own service and model.
   */
  before(projectId: string, input: Record<string, unknown>) {
    const reference = referenceRequestSchema.parse(input.reference);
    if (reference.action === 'interpret') return reference;
    const last = this.get(projectId, reference.attachmentId).versions.at(-1);
    if (!last) throw new DomainError('REFERENCE_NOT_READY');
    input.conversationId = last.conversationId;
    delete input.model;
    delete input.routing;
    return reference;
  }

  /**
   * A reference request once placed (the conversation id is final): checks the board, writes the
   * turn's text, mode and host use, stores the request with `submit` and only then records the
   * turn on the board (답하는 중, or the 판 confirmed and frozen). A request the workspace refuses
   * (size, basis…) leaves the board as it was.
   */
  async prepare<T extends { created: boolean }>(
    projectId: string,
    input: Record<string, unknown>,
    { name, remote = false }: { name: string; remote?: boolean },
    submit: () => T,
  ): Promise<T> {
    const reference = referenceRequestSchema.parse(input.reference);
    const requestId = String(input.id);
    const conversationId = String(input.conversationId ?? '');
    if (!conversationId) throw new DomainError('INVALID_INPUT');
    return this.#update(projectId, reference.attachmentId, async () => {
      const board = this.get(projectId, reference.attachmentId);
      if (this.#answering(projectId, board)) throw new DomainError('REFERENCE_BUSY');
      const last = board.versions.at(-1);
      const now = new Date().toISOString();
      if (reference.action === 'confirm') {
        if (!last || last.number !== reference.version) throw new DomainError('STALE_REFERENCE');
        // A 판 is confirmed once: a second [맞음] (another window, a resend) runs nothing.
        if (last.confirmed) throw new DomainError('REFERENCE_FROZEN');
        const answers = reference.targets ?? {};
        const regions = last.regions.map((region) =>
          region.target === UNKNOWN_TARGET && answers[region.letter]
            ? { ...region, target: answers[region.letter] }
            : region,
        );
        if (regions.some((region) => region.target === UNKNOWN_TARGET))
          throw new DomainError('REFERENCE_TARGET_UNKNOWN');
        const confirmed: ReferenceVersion = { ...last, regions, confirmed: { at: now, requestId } };
        // [맞음] is the user's confirmation: the turn runs in 자동 even from 계획 (2026-10-01).
        input.mode = 'auto';
        input.permission = 'candidate';
        if (input.hostUse === 'none') delete input.hostUse;
        input.body = confirmText(confirmed, name);
        const submitted = submit();
        if (submitted.created)
          await this.#put(projectId, {
            ...board,
            versions: [...board.versions.slice(0, -1), confirmed],
          });
        return submitted;
      }
      if (reference.action === 'region') {
        if (!last) throw new DomainError('REFERENCE_NOT_READY');
        if (last.confirmed) throw new DomainError('REFERENCE_FROZEN');
        if (!last.regions.some((region) => region.letter === reference.letter))
          throw new DomainError('INVALID_INPUT');
        input.body = `영역 ${reference.letter}만 다시 · ${reference.note}`;
      } else {
        if (!board.masked) throw new DomainError('REFERENCE_NOT_READY');
        const letters = effectiveRegions(board.regions).map((region) => region.letter);
        input.body = `이해 확인 · 참고 이미지 ${name} · 영역 ${letters.join(', ')}`;
      }
      // The check reads; it never touches the host.
      input.mode = 'plan';
      input.permission = 'review';
      input.hostUse = 'none';
      const submitted = submit();
      if (submitted.created)
        await this.#put(projectId, {
          ...board,
          conversationId,
          problem: null,
          pending: {
            requestId,
            action: reference.action,
            ...(reference.letter ? { letter: reference.letter } : {}),
            ...(reference.note ? { note: reference.note } : {}),
            startedAt: now,
            ...(remote ? { remote: true } : {}),
            view: reference.view === true,
          },
        });
      return submitted;
    });
  }

  /** A board bound to the conversation whose latest 판 can still be corrected (spoken). */
  #bound(projectId: string, conversationId: string): ReferenceBoard | undefined {
    let names: string[] = [];
    try {
      names = readdirSync(join(this.root, projectIdSchema.parse(projectId)));
    } catch {
      return undefined;
    }
    return names
      .filter((name) => /^[0-9a-f]{24}\.json$/.test(name))
      .map((name) => this.get(projectId, name.slice(0, 24)))
      .filter(
        (board) =>
          board.conversationId === conversationId &&
          board.versions.length > 0 &&
          !board.versions.at(-1)!.confirmed,
      )
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
  }

  /** The board's data a turn carries (ConversationService `reference` option). */
  turnItem(request: StoredWork): ReferenceTurn | undefined {
    const input = request.input as Record<string, unknown>;
    const parsed = referenceRequestSchema.safeParse(input.reference);
    const item = (data: Record<string, unknown>) => ({
      id: 'reference-board',
      type: 'reference-board',
      data,
    });
    if (!parsed.success) {
      // Any turn of the conversation may correct its board (SPEC-09.6 4): a turn without the
      // host answers in its structured output, a host or jig turn with a block in its reply.
      if (typeof input.conversationId !== 'string') return;
      const board = this.#bound(request.projectId, input.conversationId);
      const last = board?.versions.at(-1);
      if (!board || !last) return;
      const structured = input.jig === undefined && hostUse(input as never) === 'none';
      return {
        item: item({
          rules: structured ? CHAT_RULES : CHAT_BLOCK_RULES,
          attachmentId: board.attachmentId,
          current: interpretationData(last),
        }),
        output: 'optional',
        // The board this turn saw: its correction goes there and nowhere else.
        attachmentId: board.attachmentId,
      };
    }
    const reference = parsed.data;
    const board = this.get(request.projectId, reference.attachmentId);
    const regions = effectiveRegions(board.regions).map((region) => ({
      letter: region.letter,
      note: region.note,
      box: region.whole ? [0, 0, 1, 1] : regionBox(region),
    }));
    const last = board.versions.at(-1);
    if (reference.action === 'confirm') {
      const confirmed = board.versions.find((version) => version.number === reference.version);
      if (!confirmed) return;
      // The confirmed 판 with the regions it reads (SPEC-09.8 3); the page sends the reference
      // with its regions drawn and the last generated image.
      return {
        item: item({ rules: CONFIRM_RULES, ...interpretationData(confirmed), drawn: regions }),
      };
    }
    if (reference.action === 'region')
      return {
        item: item({
          rules: regionRules(reference.letter!),
          letter: reference.letter,
          note: reference.note,
          regions,
          current: last ? interpretationData(last) : null,
        }),
        output: 'required',
      };
    return {
      item: item({
        rules: INTERPRET_RULES,
        image: { width: board.width ?? null, height: board.height ?? null },
        regions,
      }),
      output: 'required',
    };
  }

  /**
   * A finished turn (Execution `onFinished`): the board's pending check becomes its next 판 (or
   * the reason it did not), a chat turn's correction becomes one; the image job starts.
   */
  async afterTurn(row: StoredWork) {
    const input = row.input as Record<string, unknown>;
    const parsed = referenceRequestSchema.safeParse(input.reference);
    if (parsed.success) {
      if (parsed.data.action !== 'confirm')
        await this.settle(row.projectId, parsed.data.attachmentId, row);
      return;
    }
    const result = row.result as { reference?: unknown; referenceBoard?: unknown } | null;
    const attachmentId = attachmentIdSchema.safeParse(result?.referenceBoard);
    if (
      !['succeeded', 'needs-confirmation'].includes(row.state) ||
      !result?.reference ||
      !attachmentId.success ||
      typeof input.conversationId !== 'string'
    )
      return;
    await this.#update(row.projectId, attachmentId.data, async () => {
      const current = this.get(row.projectId, attachmentId.data);
      if (current.conversationId !== input.conversationId) return;
      const next = nextVersion(current, {
        action: 'spoken',
        output: result.reference as ReferenceOutput,
        requestId: row.id,
        conversationId: input.conversationId as string,
        now: new Date().toISOString(),
      });
      if (!next || 'problem' in next) return;
      // A request through the remote tunnel starts no image job (SPEC-09.10 4): the server marks it.
      await this.#addVersion(row.projectId, current, next.version, {
        remote: input.remote === true,
        view: true,
      });
    });
  }

  /** The pending reference turn's end, once (idempotent; also run when the board is read). */
  settle(projectId: string, attachmentId: string, row?: StoredWork) {
    return this.#update(projectId, attachmentId, async () => {
      const board = this.get(projectId, attachmentId);
      const pending = board.pending;
      if (!pending) return;
      const done =
        row?.id === pending.requestId ? row : this.lookup?.(projectId, pending.requestId);
      if (done && !terminal(done.state)) return;
      const result = (done?.result ?? null) as {
        reference?: unknown;
        referenceError?: unknown;
        code?: unknown;
      } | null;
      const now = new Date().toISOString();
      const fail = (code: string) =>
        this.#put(projectId, {
          ...board,
          pending: null,
          problem: {
            code,
            requestId: pending.requestId,
            at: now,
            action: pending.action,
            ...(pending.letter ? { letter: pending.letter } : {}),
            ...(pending.note ? { note: pending.note } : {}),
          },
        });
      if (!done || done.state !== 'succeeded')
        return fail(
          done?.state === 'cancelled'
            ? 'TURN_CANCELLED'
            : typeof result?.code === 'string'
              ? result.code
              : 'TURN_FAILED',
        );
      if (!result?.reference)
        return fail(
          typeof result?.referenceError === 'string'
            ? result.referenceError
            : 'REFERENCE_OUTPUT_MISSING',
        );
      const next = nextVersion(board, {
        action: pending.action,
        letter: pending.letter,
        output: result.reference as ReferenceOutput,
        requestId: pending.requestId,
        conversationId: String(
          (done.input as { conversationId?: unknown }).conversationId ?? board.conversationId ?? '',
        ),
        now,
      });
      if (!next || 'problem' in next) return fail(next ? next.problem : 'REGION_MISMATCH');
      await this.#addVersion(projectId, { ...board, pending: null, problem: null }, next.version, {
        remote: pending.remote === true,
        view: pending.view === true,
      });
    });
  }

  /** Adds a 판 and starts its image job (inside the board's update). */
  async #addVersion(
    projectId: string,
    board: ReferenceBoard,
    version: ReferenceVersion,
    { remote, view }: { remote: boolean; view: boolean },
  ) {
    const folder = this.outputFolder(projectId, board.attachmentId);
    let image: VersionImage;
    const capture = view ? this.#view(projectId, board.attachmentId) : undefined;
    if (!this.settings(projectId).images) image = { state: 'off' };
    else if (remote) image = { state: 'remote' };
    else if (!capture) image = { state: 'no-model' };
    // The engine is stopping: the 판 keeps [다시 생성] for the next start.
    else if (this.#closing) image = { state: 'failed', code: 'IMAGE_INTERRUPTED' };
    else {
      const extension = capture.endsWith('.png') ? 'png' : 'jpg';
      await mkdir(folder, { recursive: true });
      await copyFile(capture, join(folder, `v${version.number}-view.${extension}`));
      image = { state: 'running', startedAt: new Date().toISOString() };
    }
    await this.#put(projectId, {
      ...board,
      versions: [...board.versions, { ...version, image }],
    });
    if (image.state === 'running') this.#run(projectId, board.attachmentId, version.number);
    else this.cancelImage(projectId, board.attachmentId);
  }

  /** Starts the image job of a 판 (one per board: a running one is cancelled). */
  #run(projectId: string, attachmentId: string, number: number) {
    const key = `${projectId}/${attachmentId}`;
    this.#jobs.get(key)?.controller.abort();
    if (this.#closing) return;
    const controller = new AbortController();
    const folder = this.outputFolder(projectId, attachmentId);
    const view = this.#view(projectId, attachmentId, `v${number}-view`);
    const masked = this.#file(projectId, attachmentId, '.masked.png');
    const version = this.#read(projectId, attachmentId).versions.find((v) => v.number === number);
    const job: ImageJob = {
      number,
      numbers: new Set([number]),
      controller,
      done: Promise.resolve(),
    };
    job.done = (async () => {
      let result: ImageJobResult;
      try {
        result =
          !view || !version
            ? { ok: false, code: 'IMAGE_FAILED', elapsedMs: 0 }
            : await (this.options.runImage ?? runImageJob)(
                {
                  prompt: imageJobPrompt(version),
                  images: existsSync(masked) ? [view, masked] : [view],
                  outFile: join(folder, `v${number}.png`),
                  signal: controller.signal,
                },
                this.options.image,
              );
      } catch {
        result = { ok: false, code: 'IMAGE_FAILED', elapsedMs: 0 };
      }
      // Why it stopped: the project turned images off, the engine stopped, or [생성 취소] / a
      // newer 판.
      const reason: unknown = controller.signal.reason;
      const image: VersionImage = result.ok
        ? { state: 'ready', elapsedMs: result.elapsedMs, size: result.size }
        : reason === 'off'
          ? { state: 'off' }
          : reason === 'closing'
            ? { state: 'failed', elapsedMs: result.elapsedMs, code: 'IMAGE_INTERRUPTED' }
            : {
                state:
                  result.code === 'IMAGE_TIMEOUT'
                    ? 'timeout'
                    : result.code === 'IMAGE_CANCELLED'
                      ? 'cancelled'
                      : 'failed',
                elapsedMs: result.elapsedMs,
                code: result.code,
              };
      await this.#update(projectId, attachmentId, async () => {
        // Inside the update: [새 판으로 고치기] adds its 판 to the job until here.
        if (this.#jobs.get(key) === job) this.#jobs.delete(key);
        if (result.ok)
          for (const carried of job.numbers)
            if (carried !== number)
              await copyFile(join(folder, `v${number}.png`), join(folder, `v${carried}.png`));
        const board = this.#read(projectId, attachmentId);
        await this.#put(projectId, {
          ...board,
          versions: board.versions.map((entry) =>
            job.numbers.has(entry.number) && entry.image.state === 'running'
              ? { ...entry, image }
              : entry,
          ),
        });
      });
    })();
    this.#jobs.set(key, job);
  }

  /** [생성 취소]: stops the board's running job (its 판 shows '취소됨'). */
  cancelImage(projectId: string, attachmentId: string) {
    const job = this.#jobs.get(`${projectId}/${attachmentId}`);
    job?.controller.abort();
    return job?.done;
  }
  /** The running job of a board (tests wait on it). */
  imageJob(projectId: string, attachmentId: string) {
    return this.#jobs.get(`${projectId}/${attachmentId}`)?.done;
  }

  /**
   * The engine stops: no image job starts from now on (a turn ending while the engine closes
   * leaves its 판 '끊김' with [다시 생성]); running jobs end their process and clean up.
   */
  async close() {
    this.#closing = true;
    const jobs = [...this.#jobs.values()];
    for (const job of jobs) job.controller.abort('closing');
    await Promise.allSettled(jobs.map((job) => job.done));
  }
  /** Every board write queued so far has ended (after `close`, before the data folder goes). */
  async idle() {
    await Promise.allSettled([...this.#queues.values()]);
  }

  /** [다시 생성]: the latest 판's image job again (never from a remote session). */
  retryImage(projectId: string, attachmentId: string, number: number) {
    return this.#update(projectId, attachmentId, async () => {
      const board = this.get(projectId, attachmentId);
      const last = board.versions.at(-1);
      if (!last || last.number !== number) throw new DomainError('STALE_REFERENCE');
      if (!this.settings(projectId).images) throw new DomainError('REFERENCE_IMAGES_OFF');
      const view =
        this.#view(projectId, attachmentId, `v${number}-view`) ??
        this.#view(projectId, attachmentId);
      if (!view) throw new DomainError('REFERENCE_NO_VIEW');
      const extension = view.endsWith('.png') ? 'png' : 'jpg';
      const target = join(
        this.outputFolder(projectId, attachmentId),
        `v${number}-view.${extension}`,
      );
      if (resolve(view) !== resolve(target)) await copyFile(view, target);
      await this.#put(projectId, {
        ...board,
        versions: board.versions.map((entry) =>
          entry.number === number
            ? { ...entry, image: { state: 'running', startedAt: new Date().toISOString() } }
            : entry,
        ),
      });
      this.#run(projectId, attachmentId, number);
      return this.get(projectId, attachmentId);
    });
  }

  /**
   * [새 판으로 고치기]: the confirmed 판 carried on as a new, correctable 판 (SPEC-09.8 5). Its
   * image is the confirmed 판's: a ready picture is copied, a running job fills both 판s, and any
   * other state (off, no-model, failed…) is kept as it was.
   */
  continueBoard(projectId: string, attachmentId: string) {
    return this.#update(projectId, attachmentId, async () => {
      const board = this.get(projectId, attachmentId);
      const last = board.versions.at(-1);
      if (!last?.confirmed) throw new DomainError('INVALID_INPUT');
      const number = last.number + 1;
      const folder = this.outputFolder(projectId, attachmentId);
      const job = this.#jobs.get(`${projectId}/${attachmentId}`);
      let image: VersionImage = { ...last.image };
      if (last.image.state === 'ready') {
        if (existsSync(join(folder, `v${last.number}.png`)))
          await copyFile(join(folder, `v${last.number}.png`), join(folder, `v${number}.png`));
        else image = { state: 'failed', code: 'IMAGE_NOT_CREATED' };
      } else if (last.image.state === 'running') job?.numbers.add(number);
      for (const extension of ['png', 'jpg'])
        if (existsSync(join(folder, `v${last.number}-view.${extension}`)))
          await copyFile(
            join(folder, `v${last.number}-view.${extension}`),
            join(folder, `v${number}-view.${extension}`),
          );
      await this.#put(projectId, {
        ...board,
        versions: [
          ...board.versions,
          {
            ...last,
            number,
            kind: 'continue',
            changed: [],
            createdAt: new Date().toISOString(),
            confirmed: null,
            image,
          },
        ],
      });
      return this.get(projectId, attachmentId);
    });
  }
}

async function collect(body: AsyncIterable<Buffer | string>, max: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of body) {
    const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw;
    size += chunk.length;
    if (size > max) throw new DomainError('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
  /** Through the remote tunnel: no image job is started (SPEC-09.10 4). */
  remote?: boolean;
}

const png = (response: ServerResponse, bytes: Buffer) => {
  response.writeHead(200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(bytes);
};

/** The board routes. Returns false when the path is not ours. */
export async function referenceRoutes(
  url: URL,
  request: IncomingMessage,
  context: ReferenceRouteContext,
): Promise<boolean> {
  const settings = /^\/api\/v1\/projects\/([^/]+)\/reference-settings$/.exec(url.pathname);
  if (settings) {
    context.project(settings[1]);
    if (!context.boards) throw new DomainError('NOT_FOUND');
    if (request.method === 'GET') context.send(200, context.boards.settings(settings[1]));
    else if (request.method === 'PUT') {
      if (context.remote) throw new DomainError('FORBIDDEN');
      context.send(
        200,
        await context.boards.saveSettings(settings[1], await context.body(request)),
      );
    } else return false;
    return true;
  }
  const match =
    /^\/api\/v1\/projects\/([^/]+)\/reference-boards\/([0-9a-f]{24})(?:\/(masked|view|image|image\/cancel|continue|images\/(\d{1,6})))?$/.exec(
      url.pathname,
    );
  if (!match) return false;
  const [, projectId, attachmentId, action, imageNumber] = match;
  context.project(projectId);
  const boards = context.boards;
  if (!boards || !context.isImage(projectId, attachmentId)) throw new DomainError('NOT_FOUND');
  const binary = () => {
    if (request.headers['content-type'] !== 'application/octet-stream')
      throw new DomainError('INVALID_INPUT');
  };
  if (!action && request.method === 'GET') {
    // A check whose turn ended while nobody waited on it is settled when the board is read.
    if (boards.get(projectId, attachmentId).pending) await boards.settle(projectId, attachmentId);
    context.send(200, boards.get(projectId, attachmentId));
    return true;
  }
  if (!action && request.method === 'PUT') {
    context.send(200, await boards.save(projectId, attachmentId, await context.body(request)));
    return true;
  }
  if (action === 'masked' && request.method === 'POST') {
    binary();
    context.send(200, await boards.saveMasked(projectId, attachmentId, request));
    return true;
  }
  if (action === 'masked' && request.method === 'GET') {
    const bytes = await boards.masked(projectId, attachmentId);
    if (!bytes) throw new DomainError('NOT_FOUND');
    png(context.response, bytes);
    return true;
  }
  if (action === 'view' && request.method === 'POST') {
    binary();
    context.send(200, await boards.saveView(projectId, attachmentId, request));
    return true;
  }
  if (imageNumber && request.method === 'GET') {
    const bytes = await boards.generated(projectId, attachmentId, Number(imageNumber));
    if (!bytes) throw new DomainError('NOT_FOUND');
    png(context.response, bytes);
    return true;
  }
  if (action === 'image' && request.method === 'POST') {
    if (context.remote) throw new DomainError('FORBIDDEN');
    const { version } = z
      .object({ version: z.number().int().min(1) })
      .strict()
      .parse(await context.body(request));
    context.send(200, await boards.retryImage(projectId, attachmentId, version));
    return true;
  }
  if (action === 'image/cancel' && request.method === 'POST') {
    await boards.cancelImage(projectId, attachmentId);
    context.send(200, boards.get(projectId, attachmentId));
    return true;
  }
  if (action === 'continue' && request.method === 'POST') {
    context.send(200, await boards.continueBoard(projectId, attachmentId));
    return true;
  }
  throw new DomainError('NOT_FOUND');
}
