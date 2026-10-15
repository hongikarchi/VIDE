import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { Store } from '../core/store.ts';
import { DomainError } from '../contracts/errors.ts';
import { Records, onRecordsChanged } from '../core/records.ts';
import {
  RECORD_STATES,
  RECORD_TYPES,
  type MilestoneRow,
  type PartRow,
  type RecordRow,
  type RecordState,
  type RecordType,
} from '../contracts/records.ts';
import { workspaceOutputsFor, type WorkspaceOutputs } from './workspace-outputs.ts';
import { requestUndone } from './records-routes.ts';

/**
 * 기록의 작업 폴더 사본 (PLAN-53 T-331, SPEC-17.6, ARCH-01 §5 「프로젝트 기록」 '사본 쓰기와
 * 되들이기'): `<ops>/기록/YYYY-MM.jsonl` (the month's rows, every state, one line each, after a
 * marker line) and `<ops>/기록/README.md` (부위 사전·마일스톤·장; the whole file is VIDE's).
 * Writes follow `onRecordsChanged` after a 5 s debounce per project and go through the work-folder
 * writer's ledger (`folder-copies.json`, keys `records:YYYY-MM`·`records:readme`), so a copy the
 * person changed is not overwritten but shown as changed; [폴더 내용 들이기] takes its lines back in
 * (person's path, line by line) and [VIDE 기록으로 다시 쓰기] rewrites it from the DB. A project
 * with no work folder gets nothing (the DB stands; `written: false`).
 */

const RECORDS_MIRROR_DELAY_MS = 5000;
const MONTH = /^\d{4}-\d{2}$/;
const README_KEY = 'records:readme';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export interface RecordsMirrorStatus {
  written: boolean;
  /** `<ops>/기록`, relative to the work folder (forward slashes); absent without a work folder. */
  path?: string;
  changed: boolean;
  lastWrittenAt?: string;
}
export interface RecordsMirrorSkip {
  file: string;
  line: number;
  /** A refusal code, or `json` for a line that is not a JSON object. */
  reason: string;
}
export interface RecordsMirrorImport {
  /** Existing records changed from the copy. */
  changed: number;
  /** Lines added as new records. */
  added: number;
  skipped: RecordsMirrorSkip[];
}
type Writer = Pick<
  WorkspaceOutputs,
  | 'roleFolder'
  | 'writeRecordsCopy'
  | 'recordsCopyBase'
  | 'writeRecordsReadme'
  | 'copyKeys'
  | 'copyPath'
  | 'folderCopies'
  | 'force'
  | 'unforce'
  | 'idle'
>;
export interface RecordsMirrorOptions {
  records: Records;
  outputs: Writer;
  delayMs?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const cell = (value: string | null | undefined) =>
  (value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim() || '—';

/** The README of `<ops>/기록/` (부위 사전 표·마일스톤 표·장 목록). */
export function recordsReadme(
  parts: PartRow[],
  milestones: MilestoneRow[],
  chapterCounts: Record<string, number>,
): string {
  const lines = [
    '# 프로젝트 기록',
    '',
    '이 폴더의 `YYYY-MM.jsonl`은 VIDE 기록의 달별 사본입니다(한 줄에 기록 하나, 첫 줄은 사본 표시).',
    '이 README는 VIDE가 다시 씁니다. 메모는 같은 폴더의 다른 파일에 적어 주세요.',
    '',
    '## 부위 사전',
    '',
  ];
  if (!parts.length) lines.push('아직 부위가 없습니다.');
  else {
    lines.push('| 이름 | 그룹 | 역할(시작 → 끝) | 장 | 이어진 레이어 |', '|---|---|---|---|---|');
    for (const part of parts) {
      const role =
        part.roleFrom || part.roleTo ? `${cell(part.roleFrom)} → ${cell(part.roleTo)}` : '—';
      const layers = part.mapping.filter((m) => m.kind === 'layer').length;
      lines.push(
        `| ${cell(part.name)} | ${cell(part.grp)} | ${role} | ${cell(part.chapter)} | ${layers} |`,
      );
    }
  }
  lines.push('', '## 마일스톤', '');
  if (!milestones.length) lines.push('아직 마일스톤이 없습니다.');
  else {
    lines.push('| 날짜 | 이름 |', '|---|---|');
    for (const milestone of milestones)
      lines.push(`| ${milestone.date} | ${cell(milestone.label)} |`);
  }
  const chapters = new Set(Object.keys(chapterCounts).filter(Boolean));
  for (const part of parts) if (part.chapter) chapters.add(part.chapter);
  lines.push('', '## 장', '');
  if (!chapters.size) lines.push('아직 장이 없습니다.');
  else
    for (const chapter of [...chapters].sort((a, b) => a.localeCompare(b)))
      lines.push(`- ${cell(chapter)} (기록 ${chapterCounts[chapter] ?? 0}건)`);
  return lines.join('\n') + '\n';
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** The copy's marker line (`{"vide": "… vide-copy:…"}`), skipped when reading back. */
const isMarker = (value: Record<string, unknown>) =>
  Object.keys(value).length === 1 &&
  typeof value.vide === 'string' &&
  value.vide.includes('vide-copy:');
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');
/** Same JSON value (a line's field against the row last written). */
const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/**
 * A KakaoTalk or mail candidate nobody has sorted yet stays out of the folder copy (SPEC-17.6: raw
 * imports and their candidates are kept out of the AI and of uploads); once kept or dropped it is
 * written like any other row.
 */
export const mirrored = (row: RecordRow) =>
  !(row.state === 'candidate' && (row.source === 'kakao' || row.source === 'mail'));

export class RecordsMirror {
  private readonly records: Records;
  private readonly outputs: Writer;
  private readonly delay: number;
  private readonly log: (event: string, fields: Record<string, unknown>) => void;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The last flush per project (flushes of a project run one after another). */
  private readonly running = new Map<string, Promise<boolean>>();
  /** Hash of what was last handed to the writer per `project\0key` (unchanged months are skipped). */
  private readonly sent = new Map<string, string>();
  /** Projects written at least once since the engine started (the tab's GET then only reads). */
  private readonly flushed = new Set<string>();
  private stopped = false;
  private unsubscribe: (() => void) | null = null;
  constructor(options: RecordsMirrorOptions) {
    this.records = options.records;
    this.outputs = options.outputs;
    this.delay = options.delayMs ?? RECORDS_MIRROR_DELAY_MS;
    this.log = options.log ?? (() => {});
  }
  /** Listens to every records write of `source` (the routes, the AI tool, the candidates). */
  listen(source: Store) {
    this.unsubscribe?.();
    this.unsubscribe = onRecordsChanged(source, (projectId) => this.schedule(projectId));
  }

  /** A flush `delayMs` after the last change of the project (a new change starts it again). */
  schedule(projectId: string) {
    if (this.stopped) return;
    clearTimeout(this.timers.get(projectId));
    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      void this.flush(projectId);
    }, this.delay);
    timer.unref?.();
    this.timers.set(projectId, timer);
  }
  /** Whether a flush is waiting for the project. */
  pending(projectId: string) {
    return this.timers.has(projectId);
  }

  /**
   * Writes the project's changed months and README now. `fresh` hands every copy to the writer
   * again (after [버리기] or a forced rewrite); `months` adds months to write (their rows or an
   * empty copy). False when the project has no work folder (nothing written). Never throws.
   */
  flush(projectId: string, options: { fresh?: boolean; months?: string[] } = {}): Promise<boolean> {
    clearTimeout(this.timers.get(projectId));
    this.timers.delete(projectId);
    const previous = this.running.get(projectId) ?? Promise.resolve(false);
    const next = previous
      .catch(() => false)
      .then(() => this.write(projectId, options))
      .catch((error: unknown) => {
        this.log('records-mirror-failed', {
          projectId,
          code: error instanceof DomainError ? error.code : 'WRITE_FAILED',
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      });
    this.running.set(projectId, next);
    void next.finally(() => {
      if (this.running.get(projectId) === next) this.running.delete(projectId);
    });
    return next;
  }
  private async write(projectId: string, options: { fresh?: boolean; months?: string[] }) {
    if (!(await this.outputs.roleFolder(projectId, 'ops'))) return false;
    const list = this.records.list(projectId);
    const byMonth = new Map<string, string[]>();
    for (const row of list.records) {
      if (!mirrored(row)) continue;
      const month = row.date.slice(0, 7);
      const lines = byMonth.get(month);
      const line = JSON.stringify(row) + '\n';
      if (lines) lines.push(line);
      else byMonth.set(month, [line]);
    }
    const months = new Set([...byMonth.keys(), ...(options.months ?? [])]);
    for (const key of await this.outputs.copyKeys(projectId, 'records:'))
      months.add(key.slice('records:'.length));
    for (const month of [...months].sort()) {
      if (!MONTH.test(month)) continue;
      const jsonl = (byMonth.get(month) ?? []).join('');
      await this.hand(projectId, `records:${month}`, jsonl, options.fresh, () =>
        this.outputs.writeRecordsCopy(projectId, month, jsonl),
      );
    }
    const readme = recordsReadme(
      this.records.parts(projectId),
      this.records.milestones(projectId),
      list.counts.chapter,
    );
    await this.hand(projectId, README_KEY, readme, options.fresh, () =>
      this.outputs.writeRecordsReadme(projectId, readme),
    );
    this.flushed.add(projectId);
    return true;
  }
  private async hand(
    projectId: string,
    key: string,
    text: string,
    fresh: boolean | undefined,
    write: () => Promise<string | null>,
  ) {
    const id = `${projectId}\0${key}`;
    const hash = sha256(text);
    if (!fresh && this.sent.get(id) === hash) return;
    // Remembered only when written: a copy left alone (changed in the folder) or not written is
    // tried again at the next flush.
    if (await write()) this.sent.set(id, hash);
    else this.sent.delete(id);
  }

  /**
   * `GET …/records/mirror`: with `flush` the waiting write is done first (only when one waits or
   * none ran yet); a remote session reads the state only.
   */
  async status(projectId: string, options: { flush?: boolean } = {}): Promise<RecordsMirrorStatus> {
    const place = await this.outputs.roleFolder(projectId, 'ops');
    if (!place) return { written: false, changed: false };
    if (options.flush && (this.pending(projectId) || !this.flushed.has(projectId)))
      await this.flush(projectId);
    let copies;
    try {
      copies = (await this.outputs.folderCopies(projectId)).filter((copy) =>
        copy.key.startsWith('records:'),
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === 'NO_WORKSPACE')
        return { written: false, changed: false };
      throw error;
    }
    const path = relative(place.root, join(place.dir, '기록')).replace(/\\/g, '/');
    const last = copies
      .map((copy) => copy.writtenAt ?? '')
      .filter(Boolean)
      .sort()
      .pop();
    return {
      written:
        copies.some((copy) => copy.state === 'written') &&
        !copies.some((copy) => copy.state === 'not-written'),
      path,
      changed: copies.some((copy) => copy.state === 'changed-in-folder'),
      ...(last ? { lastWrittenAt: last } : {}),
    };
  }

  /**
   * [폴더 내용 들이기]: the month copies changed in the folder, line by line on the person's path
   * (`by`) — a known id takes the line's state·type·parts·chapter·text where they differ, an
   * unknown or missing id becomes a person's record (`manual`, the line's state or kept). A line
   * that is not JSON or is refused is skipped (not all or nothing). Then every records copy is
   * written again from the DB. `NO_WORKSPACE` without a work folder.
   */
  async importFolder(projectId: string, by: string): Promise<RecordsMirrorImport> {
    if (!(await this.outputs.roleFolder(projectId, 'ops'))) throw new DomainError('NO_WORKSPACE');
    await this.running.get(projectId);
    const copies = (await this.outputs.folderCopies(projectId)).filter(
      (copy) =>
        copy.state === 'changed-in-folder' &&
        copy.key.startsWith('records:') &&
        MONTH.test(copy.key.slice('records:'.length)),
    );
    const result: RecordsMirrorImport = { changed: 0, added: 0, skipped: [] };
    const known = new Set(this.records.parts(projectId).map((part) => part.id));
    for (const copy of copies) {
      const path = copy.path ?? (await this.outputs.copyPath(projectId, copy.key));
      if (!path) continue;
      const text = await readFile(path, 'utf8').catch(() => null);
      if (text === null) continue;
      const file = basename(path);
      // What this PC last wrote there: a field equal to it is not the person's change.
      const base = new Map<string, Record<string, unknown>>();
      const month = copy.key.slice('records:'.length);
      for (const raw of ((await this.outputs.recordsCopyBase(projectId, month)) ?? '').split('\n'))
        try {
          const row: unknown = raw.trim() ? JSON.parse(raw) : null;
          if (isObject(row) && typeof row.id === 'string') base.set(row.id, row);
        } catch {
          /* a damaged base line: that record is compared in full */
        }
      text
        .replace(/^﻿/, '')
        .split('\n')
        .forEach((raw, index) => {
          const line = raw.replace(/\r$/, '');
          if (!line.trim()) return;
          const skip = (reason: string) => result.skipped.push({ file, line: index + 1, reason });
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            return skip('json');
          }
          if (!isObject(value)) return skip('json');
          if (isMarker(value)) return;
          try {
            const was = typeof value.id === 'string' ? base.get(value.id) : undefined;
            const outcome = this.takeLine(projectId, value, known, by, was);
            if (outcome === 'changed') result.changed++;
            else if (outcome === 'added') result.added++;
          } catch (error) {
            skip(error instanceof DomainError ? error.code : 'INVALID_INPUT');
          }
        });
    }
    // The copies are VIDE's again: everything written over from the DB.
    await this.rewrite(projectId);
    return result;
  }
  private takeLine(
    projectId: string,
    line: Record<string, unknown>,
    known: Set<string>,
    by: string,
    was?: Record<string, unknown>,
  ): 'changed' | 'added' | 'same' {
    // With the row this PC last wrote (`was`) only the fields the person changed in the file count:
    // a field left as written never takes back what VIDE changed since (O/X, text …). Without it
    // (a folder from another PC) every field is compared with the DB.
    const touched = (key: string) => !was || !sameValue(line[key], was[key]);
    const parts = Array.isArray(line.parts)
      ? line.parts.filter((id): id is string => typeof id === 'string' && known.has(id))
      : undefined;
    const state = line.state;
    if (state !== undefined && !RECORD_STATES.includes(state as RecordState))
      throw new DomainError('INVALID_INPUT');
    const id = typeof line.id === 'string' ? line.id : null;
    let current: RecordRow | null = null;
    if (id)
      try {
        current = this.records.get(projectId, id);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'RECORD_NOT_FOUND')) throw error;
      }
    if (!current) {
      const input: Record<string, unknown> = { text: line.text };
      for (const key of ['date', 'time', 'type', 'chapter', 'attachments'] as const)
        if (line[key] !== undefined) input[key] = line[key];
      if (parts) input.parts = parts;
      this.records.add(projectId, input, {
        by,
        state: (state as RecordState | undefined) ?? 'kept',
        source: 'manual',
      });
      return 'added';
    }
    const patch: Record<string, unknown> = {};
    if (line.text !== undefined && touched('text') && line.text !== current.text)
      patch.text = line.text;
    if (line.type !== undefined && touched('type') && line.type !== current.type) {
      // A person never sets a record back to '?' (SPEC-17.2: automatic candidates only).
      if (line.type === '?' || !RECORD_TYPES.includes(line.type as RecordType))
        throw new DomainError('INVALID_INPUT');
      patch.type = line.type;
    }
    if (parts && touched('parts') && !sameList(parts, current.parts)) patch.parts = parts;
    if (
      line.chapter !== undefined &&
      touched('chapter') &&
      (line.chapter ?? null) !== current.chapter
    )
      patch.chapter = line.chapter;
    const nextState =
      state !== undefined && touched('state') && state !== current.state
        ? (state as RecordState)
        : null;
    if (!Object.keys(patch).length && !nextState) return 'same';
    if (Object.keys(patch).length) this.records.patch(projectId, current.id, patch, by);
    if (nextState) this.records.setStates(projectId, [current.id], nextState, by);
    return 'changed';
  }

  /**
   * [VIDE 기록으로 다시 쓰기]: every records copy written again from the DB, over the person's
   * changes. `NO_WORKSPACE` without a work folder.
   */
  async rewrite(projectId: string): Promise<{ written: boolean }> {
    if (!(await this.outputs.roleFolder(projectId, 'ops'))) throw new DomainError('NO_WORKSPACE');
    await this.running.get(projectId);
    const keys = await this.outputs.copyKeys(projectId, 'records:');
    this.outputs.force(projectId, keys);
    try {
      await this.flush(projectId, {
        fresh: true,
        months: keys.map((key) => key.slice('records:'.length)).filter((m) => MONTH.test(m)),
      });
      await this.outputs.idle();
    } finally {
      this.outputs.unforce(projectId, keys);
    }
    return { written: (await this.status(projectId)).written };
  }

  /** No new flush starts (shutdown); waiting ones are dropped (the DB is the source). */
  stop() {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  /** Resolves when every running flush and its writes have finished. */
  async idle() {
    while (this.running.size) await Promise.all([...this.running.values()]);
    await this.outputs.idle();
  }
}

const perStore = new WeakMap<Store, RecordsMirror>();
/**
 * The engine's records copy for a store (one per store), listening to `onRecordsChanged`. After
 * `stop()` a later call makes a new one.
 */
export function recordsMirrorFor(
  store: Store,
  options: { log?: (event: string, fields: Record<string, unknown>) => void } = {},
): RecordsMirror {
  let mirror = perStore.get(store);
  if (!mirror) {
    const made = new RecordsMirror({
      records: new Records(store, { undoneResolver: requestUndone(store) }),
      outputs: workspaceOutputsFor(store),
      log: options.log,
    });
    made.listen(store);
    const stop = made.stop.bind(made);
    made.stop = () => {
      stop();
      if (perStore.get(store) === made) perStore.delete(store);
    };
    perStore.set(store, made);
    mirror = made;
  }
  return mirror;
}
