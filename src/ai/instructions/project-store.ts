import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../../core/store.ts';
import { ADDENDUM_MAX_BYTES } from './index.ts';

/** One project's addendum as the settings route reads and writes it. */
export interface ProjectInstructions {
  text: string;
  /** ISO time of the last save; null when none was saved. */
  updatedAt: string | null;
}
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const stored = z.object({ text: z.string(), updatedAt: z.string() });
const update = z.object({ text: z.string() }).strict();

/**
 * The per-project addendum of the instruction bundle (PLAN-24 지침 묶음): one JSON file per project
 * under `<data>/ai-instructions/`, or memory when the engine has no data folder. The text is kept
 * as the user wrote it (at most {@link ADDENDUM_MAX_BYTES}); `bundleFor` sanitises it as data.
 */
export class ProjectInstructionStore {
  private readonly directory?: string;
  private readonly memory = new Map<string, ProjectInstructions>();
  constructor(dataDirectory?: string) {
    this.directory = dataDirectory ? join(dataDirectory, 'ai-instructions') : undefined;
  }
  private file(projectId: string) {
    if (!PROJECT_ID.test(projectId)) throw new DomainError('INVALID_INPUT');
    return this.directory ? join(this.directory, `${projectId}.json`) : undefined;
  }
  get(projectId: string): ProjectInstructions {
    const file = this.file(projectId);
    if (!file) return this.memory.get(projectId) ?? { text: '', updatedAt: null };
    try {
      const value = stored.parse(JSON.parse(readFileSync(file, 'utf8')));
      return { text: value.text, updatedAt: value.updatedAt };
    } catch {
      // Missing or unreadable: the bundle goes without an addendum.
      return { text: '', updatedAt: null };
    }
  }
  save(projectId: string, value: unknown): ProjectInstructions {
    const file = this.file(projectId);
    const parsed = update.safeParse(value);
    if (!parsed.success) throw new DomainError('INVALID_INPUT');
    const text = parsed.data.text.replace(/\r\n?/g, '\n');
    if (Buffer.byteLength(text) > ADDENDUM_MAX_BYTES) throw new DomainError('INVALID_INPUT');
    const row = { text, updatedAt: new Date().toISOString() };
    if (!file) {
      this.memory.set(projectId, row);
      return row;
    }
    mkdirSync(this.directory!, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(row), 'utf8');
    renameSync(temporary, file);
    return row;
  }
  /** The text for `bundleFor` (empty when none). */
  text(projectId: string): string {
    try {
      return this.get(projectId).text;
    } catch {
      return '';
    }
  }
}
