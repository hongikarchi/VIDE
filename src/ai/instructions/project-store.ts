import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../../core/store.ts';
import { ADDENDUM_MAX_BYTES } from './index.ts';

/** The text another member saved over, or that stayed instead of this PC's edit (SPEC-04.11 4). */
export interface InstructionConflict {
  text: string;
  updatedByName: string | null;
  /** ms; null when the site did not say. */
  updatedAt: number | null;
}
/** One project's addendum as the settings route reads and writes it. */
export interface ProjectInstructions {
  text: string;
  /** ISO time of the last save; null when none was saved. */
  updatedAt: string | null;
  /** The site's revision this copy holds (ADR-037 2); absent before the first exchange. */
  revision?: number;
  /** Edited on this PC and not on the site yet. */
  pending?: boolean;
  /** When this PC's edit was made (ms), sent so the later edit wins. */
  editedAt?: number;
  updatedByName?: string | null;
  conflict?: InstructionConflict | null;
}
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const stored = z.object({
  text: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative().optional(),
  pending: z.boolean().optional(),
  editedAt: z.number().optional(),
  updatedByName: z.string().nullable().optional(),
  conflict: z
    .object({
      text: z.string(),
      updatedByName: z.string().nullable(),
      updatedAt: z.number().nullable(),
    })
    .nullable()
    .optional(),
});
const update = z.object({ text: z.string() }).strict();
const normalize = (text: string) => text.replace(/\r\n?/g, '\n');

/**
 * The per-project addendum of the instruction bundle (PLAN-24 지침 묶음): one JSON file per project
 * under `<data>/ai-instructions/`, or memory when the engine has no data folder. The text is kept
 * as the user wrote it (at most {@link ADDENDUM_MAX_BYTES}); `bundleFor` sanitises it as data.
 * On a PC signed in to the account site the file is the copy of the site's instructions
 * (ADR-037 2, `src/server/shared-project.ts`): local edits are `pending` until the site has them.
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
      return stored.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      // Missing or unreadable: the bundle goes without an addendum.
      return { text: '', updatedAt: null };
    }
  }
  private write(projectId: string, row: ProjectInstructions) {
    const file = this.file(projectId);
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
  /** An edit on this PC: applied to the copy at once and marked for the site. */
  save(projectId: string, value: unknown): ProjectInstructions {
    this.file(projectId);
    const parsed = update.safeParse(value);
    if (!parsed.success) throw new DomainError('INVALID_INPUT');
    const text = normalize(parsed.data.text);
    if (Buffer.byteLength(text) > ADDENDUM_MAX_BYTES) throw new DomainError('INVALID_INPUT');
    const current = this.get(projectId);
    return this.write(projectId, {
      ...current,
      text,
      updatedAt: new Date().toISOString(),
      pending: true,
      editedAt: Date.now(),
    });
  }
  /**
   * The site's text replaces the copy (a newer revision, or the answer to this PC's save). A
   * pending edit stays unless `force` (the site answered it).
   */
  cache(
    projectId: string,
    site: {
      text: string;
      revision: number;
      updatedAt: number | null;
      updatedByName: string | null;
    },
    force = false,
  ): ProjectInstructions {
    const current = this.get(projectId);
    if (current.pending && !force) return current;
    if (!force && current.revision !== undefined && site.revision <= current.revision)
      return current;
    return this.write(projectId, {
      text: normalize(site.text),
      updatedAt: new Date(site.updatedAt ?? Date.now()).toISOString(),
      revision: site.revision,
      pending: false,
      updatedByName: site.updatedByName,
      conflict: current.conflict ?? null,
    });
  }
  /** Notes a conflict for the person to see (cleared by {@link dismissConflict}). */
  noteConflict(projectId: string, conflict: InstructionConflict) {
    return this.write(projectId, { ...this.get(projectId), conflict });
  }
  dismissConflict(projectId: string) {
    return this.write(projectId, { ...this.get(projectId), conflict: null });
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
