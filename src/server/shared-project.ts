import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type {
  ProjectInstructionStore,
  ProjectInstructions,
} from '../ai/instructions/project-store.ts';
import type { KnowledgeReviewStore } from '../core/knowledge-review-store.ts';
import { verdicts } from '../contracts/facts.ts';
import {
  KNOWLEDGE_ROWS_PER_REQUEST,
  KNOWLEDGE_TABLE_NAMES,
  type KnowledgeRow,
  type KnowledgeTableName,
} from '../contracts/knowledge-pack.ts';
import {
  copyRevision,
  knowledgeFingerprint,
  packRows,
  writeKnowledgeCopy,
} from '../jigs/knowledge-copy.ts';

/**
 * The team's shared project layer on the work PC (ADR-037 1-3, SPEC-04.11, ARCH-01 「팀 공유
 * 프로젝트 층」). The account site is the source of truth; this PC is a member through its host
 * key and keeps copies so it works without the site:
 *  - the list of projects the account is a member of (`<data>/shared-layer/projects.json`), merged
 *    with this PC's projects on the screen; a shared project not on this PC opens as a remote
 *    project showing what the site has (PC-off view, notes, instructions, knowledge counts),
 *  - each project's AI instructions (the copy in `ProjectInstructionStore`, put into AI turns),
 *    sent when edited here (pending while the site is unreachable, the later edit wins),
 *  - the organized knowledge: the PC that crawled uploads its knowledge DB when it changes, other
 *    PCs rebuild a copy of the same columns, and people's reviews and source rules go both ways
 *    through an outbox (`<data>/shared-layer/<projectId>.json`).
 */
export const sharedProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  ownerName: z.string().nullable(),
  hostId: z.string().nullable(),
  hostName: z.string().nullable(),
  hostOnline: z.boolean(),
  here: z.boolean(),
  updatedAt: z.number().nullable(),
  instructionsRevision: z.number().default(0),
  knowledgeRevision: z.number().default(0),
  knowledgeChangedAt: z.number().nullable().default(null),
});
export type SharedProject = z.infer<typeof sharedProjectSchema>;
const membersSchema = z.object({ projects: z.array(sharedProjectSchema) });
const instructionsSchema = z.object({
  text: z.string(),
  revision: z.number(),
  updatedAt: z.number().nullable(),
  updatedByName: z.string().nullable(),
});
const putReplySchema = instructionsSchema.extend({
  applied: z.boolean(),
  conflict: instructionsSchema.optional(),
});
const knowledgeStateSchema = z.object({
  revision: z.number(),
  builtAt: z.string().nullable(),
  counts: z.record(z.string(), z.number()),
  updatedAt: z.number().nullable(),
  changedAt: z.number().nullable(),
});
const rowsSchema = z.object({
  revision: z.number(),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
  next: z.string().nullable(),
});
const reviewSchema = z.object({
  statementId: z.number().int().nonnegative(),
  verdict: z.enum(verdicts).nullable(),
  correction: z.string().nullable().optional(),
  supersededBy: z.number().int().nullable().optional(),
  reason: z.string().nullable().optional(),
  by: z.string().optional(),
  editedAt: z.number(),
});
const ruleSchema = z.object({
  pattern: z.string().min(1),
  reason: z.string().nullable().optional(),
  removed: z.boolean(),
  editedAt: z.number(),
});
const exchangeSchema = z.object({
  reviews: z.array(reviewSchema),
  rules: z.array(ruleSchema),
  at: z.number(),
});
export type ReviewChange = z.infer<typeof reviewSchema>;
export type RuleChange = z.infer<typeof ruleSchema>;
const stateSchema = z.object({
  pushed: z.object({ fingerprint: z.string(), revision: z.number() }).optional(),
  since: z.number().optional(),
  outbox: z
    .object({ reviews: z.array(reviewSchema), rules: z.array(ruleSchema) })
    .default({ reviews: [], rules: [] }),
});
type ProjectState = z.infer<typeof stateSchema>;

interface Remote {
  site: string | undefined;
  deviceFetch(path: string, method?: string, data?: unknown): Promise<Response | undefined>;
}
interface Options {
  remote: Remote;
  dataDirectory: string | undefined;
  instructions: ProjectInstructionStore;
  /** This PC's projects (they never show as shared ones). */
  localProjects: () => { id: string; name: string }[];
  /** The review layer of a project on this PC (undefined: none). */
  reviews?: () => KnowledgeReviewStore;
  /** The project's knowledge DB on this PC (undefined: not for this project). */
  knowledgeFile?: (projectId: string) => string | undefined;
  /** Seconds between the background passes (default two minutes). */
  intervalMs?: number;
}
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const fail = (code: string) => new DomainError(code);
/** The codes that mean "the site cannot be asked now": the copies answer instead. */
const OFFLINE = [
  'SITE_UNREACHABLE',
  'ACCOUNT_NOT_LINKED',
  'SITE_ERROR',
  'NOT_FOUND',
  // Not on the site yet (or no longer a member), or another edit raced this one: try later.
  'PROJECT_NOT_FOUND',
  'INSTRUCTIONS_CHANGED',
];
const offline = (error: unknown) =>
  !(error instanceof DomainError) || OFFLINE.includes(error.code) || /^SITE_/.test(error.code);

export class SharedProjects {
  private options: Options;
  private memory = { projects: undefined as SharedProject[] | undefined, states: new Map() };
  private lastPass = 0;
  private running: Promise<void> | undefined;
  constructor(options: Options) {
    this.options = options;
  }
  private get folder() {
    return this.options.dataDirectory ? join(this.options.dataDirectory, 'shared-layer') : '';
  }
  private readJson<T>(name: string, schema: z.ZodType<T>): T | undefined {
    if (!this.folder) return undefined;
    try {
      return schema.parse(JSON.parse(readFileSync(join(this.folder, name), 'utf8')));
    } catch {
      return undefined;
    }
  }
  private writeJson(name: string, value: unknown) {
    if (!this.folder) return;
    mkdirSync(this.folder, { recursive: true });
    const file = join(this.folder, name);
    writeFileSync(file + '.tmp', JSON.stringify(value), 'utf8');
    renameSync(file + '.tmp', file);
  }
  private state(projectId: string): ProjectState {
    if (!PROJECT_ID.test(projectId)) throw fail('INVALID_INPUT');
    if (!this.folder)
      return (
        (this.memory.states.get(projectId) as ProjectState | undefined) ?? stateSchema.parse({})
      );
    return this.readJson(`${projectId}.json`, stateSchema) ?? stateSchema.parse({});
  }
  private saveState(projectId: string, state: ProjectState) {
    if (!this.folder) this.memory.states.set(projectId, state);
    else this.writeJson(`${projectId}.json`, state);
  }
  private async device(path: string, method = 'GET', data?: unknown): Promise<unknown> {
    let response: Response | undefined;
    try {
      response = await this.options.remote.deviceFetch(path, method, data);
    } catch {
      throw fail('SITE_UNREACHABLE');
    }
    if (!response) throw fail('ACCOUNT_NOT_LINKED');
    const value = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (!response.ok)
      throw fail(
        typeof value.error === 'string' && /^[A-Z_]{2,64}$/.test(value.error)
          ? value.error
          : 'SITE_ERROR',
      );
    return value;
  }
  private base(projectId: string) {
    if (!PROJECT_ID.test(projectId)) throw fail('NOT_FOUND');
    return `/projects/${encodeURIComponent(projectId)}`;
  }
  private local() {
    return new Set(this.options.localProjects().map((project) => project.id));
  }

  // ── Project list (ADR-037 1) ────────────────────────────────────────────────────────────────
  private cached(): SharedProject[] {
    return (
      this.memory.projects ?? this.readJson('projects.json', z.array(sharedProjectSchema)) ?? []
    );
  }
  /** Every project the account is a member of; the last copy when the site cannot be asked. */
  async members(): Promise<{ online: boolean; error?: string; projects: SharedProject[] }> {
    try {
      const { projects } = membersSchema.parse(await this.device('/projects'));
      this.memory.projects = projects;
      this.writeJson('projects.json', projects);
      return { online: true, projects };
    } catch (error) {
      if (!offline(error)) throw error;
      return {
        online: false,
        error: error instanceof DomainError ? error.code : 'SITE_UNREACHABLE',
        projects: this.cached(),
      };
    }
  }
  /** The shared projects that are not on this PC (the screen adds them to its own list). */
  async list() {
    if (!this.options.remote.site) return { linked: false, online: false, projects: [] };
    const members = await this.members();
    const local = this.local();
    return {
      linked: true,
      online: members.online,
      ...(members.error ? { error: members.error } : {}),
      projects: members.projects.filter((project) => !local.has(project.id) && !project.here),
    };
  }
  private async project(projectId: string) {
    const known = this.cached().find((project) => project.id === projectId);
    if (known) return known;
    const { projects } = await this.members();
    return projects.find((project) => project.id === projectId) ?? fail('NOT_FOUND');
  }
  /**
   * A shared project opened on this PC as a remote project (SPEC-04.11 3): what the site has, each
   * part null when it cannot be read.
   */
  async view(projectId: string) {
    const project = await this.project(projectId);
    const base = this.base(projectId);
    const part = async <T>(path: string, schema: z.ZodType<T>) => {
      try {
        return schema.parse(await this.device(base + path));
      } catch {
        return null;
      }
    };
    const loose = z.record(z.string(), z.unknown());
    const [agenda, history, snapshots, notes, knowledge, instructions] = await Promise.all([
      part('/member/agenda', loose),
      part('/member/history', loose),
      part('/member/snapshots', loose),
      part('/notes', loose),
      part('/knowledge', knowledgeStateSchema),
      this.instructions(projectId),
    ]);
    return {
      project,
      online: [agenda, history, notes, knowledge].some((value) => value !== null),
      agenda,
      history,
      snapshots,
      notes,
      knowledge,
      instructions,
      site: this.options.remote.site ?? null,
    };
  }

  // ── AI instructions (ADR-037 2) ─────────────────────────────────────────────────────────────
  /** The copy with how it stands against the site (for the settings screen). */
  instructionState(projectId: string) {
    const row = this.options.instructions.get(projectId);
    return {
      ...row,
      shared: !this.options.remote.site
        ? ('unlinked' as const)
        : this.pending(row)
          ? ('pending' as const)
          : ('synced' as const),
    };
  }
  private pending(row: ProjectInstructions) {
    // A copy made before the PC was linked (no revision yet) goes up on the first exchange.
    return !!row.pending || (row.revision === undefined && row.text !== '');
  }
  /** Sends this PC's edit, or takes the site's newer text. Throws when the site cannot be asked. */
  async syncInstructions(projectId: string, siteRevision?: number) {
    const store = this.options.instructions;
    const local = store.get(projectId);
    if (this.pending(local)) {
      const reply = putReplySchema.parse(
        await this.device(this.base(projectId) + '/instructions', 'PUT', {
          text: local.text,
          baseRevision: local.revision ?? 0,
          editedAt:
            local.editedAt ??
            (local.updatedAt ? Date.parse(local.updatedAt) || Date.now() : Date.now()),
        }),
      );
      // Edited again while this was on its way: that edit goes next time.
      if (store.get(projectId).text !== local.text) return this.instructionState(projectId);
      store.cache(projectId, reply, true);
      if (!reply.applied)
        store.noteConflict(projectId, {
          text: local.text,
          updatedByName: '이 PC',
          updatedAt: local.editedAt ?? null,
        });
      else if (reply.conflict)
        store.noteConflict(projectId, {
          text: reply.conflict.text,
          updatedByName: reply.conflict.updatedByName,
          updatedAt: reply.conflict.updatedAt,
        });
      return this.instructionState(projectId);
    }
    if (siteRevision !== undefined && local.revision === siteRevision)
      return this.instructionState(projectId);
    const site = instructionsSchema.parse(
      await this.device(this.base(projectId) + '/instructions'),
    );
    if (site.revision > 0 || local.revision !== undefined) store.cache(projectId, site);
    return this.instructionState(projectId);
  }
  /** The copy after one exchange with the site (the copy alone when it cannot be reached). */
  async instructions(projectId: string) {
    try {
      return await this.syncInstructions(projectId);
    } catch (error) {
      if (!offline(error)) throw error;
      return this.instructionState(projectId);
    }
  }
  /** An edit made on this PC: kept here at once, sent now when the site answers. */
  async saveInstructions(projectId: string, value: unknown) {
    this.options.instructions.save(projectId, value);
    if (!this.options.remote.site) return this.instructionState(projectId);
    return this.instructions(projectId);
  }
  dismissConflict(projectId: string) {
    this.options.instructions.dismissConflict(projectId);
    return this.instructionState(projectId);
  }

  // ── Organized knowledge (ADR-037 3) ─────────────────────────────────────────────────────────
  /** A review or source rule recorded on this PC (facts routes): queued for the site. */
  recordChange(projectId: string, change: { review?: ReviewChange; rule?: RuleChange }) {
    if (!this.options.remote.site) return;
    const state = this.state(projectId);
    if (change.review) {
      const review = change.review;
      state.outbox.reviews = state.outbox.reviews.filter(
        (item) => item.statementId !== review.statementId,
      );
      state.outbox.reviews.push(review);
    }
    if (change.rule) {
      const rule = change.rule;
      state.outbox.rules = state.outbox.rules.filter((item) => item.pattern !== rule.pattern);
      state.outbox.rules.push(rule);
    }
    this.saveState(projectId, state);
  }
  /** Uploads the crawler DB when it changed (this PC crawled). Returns the site revision. */
  private async push(projectId: string, file: string) {
    const fingerprint = knowledgeFingerprint(file);
    const state = this.state(projectId);
    if (state.pushed?.fingerprint === fingerprint) return state.pushed.revision;
    const pack = packRows(file);
    const base = this.base(projectId) + '/knowledge';
    const { revision } = z
      .object({ revision: z.number() })
      .parse(await this.device(base + '/begin', 'POST', {}));
    for (const table of KNOWLEDGE_TABLE_NAMES) {
      const rows = pack.tables[table];
      for (let i = 0; i < rows.length; i += KNOWLEDGE_ROWS_PER_REQUEST)
        await this.device(base + '/rows', 'PUT', {
          revision,
          table,
          rows: rows.slice(i, i + KNOWLEDGE_ROWS_PER_REQUEST),
        });
    }
    await this.device(base + '/commit', 'POST', {
      revision,
      builtAt: pack.builtAt,
      counts: pack.counts,
    });
    this.saveState(projectId, { ...this.state(projectId), pushed: { fingerprint, revision } });
    return revision;
  }
  /** Rebuilds this PC's copy from the site's committed set. */
  private async pull(projectId: string, file: string, site: z.infer<typeof knowledgeStateSchema>) {
    const base = this.base(projectId) + '/knowledge/rows';
    const tables: Partial<Record<KnowledgeTableName, KnowledgeRow[]>> = {};
    for (const table of KNOWLEDGE_TABLE_NAMES) {
      const rows: KnowledgeRow[] = [];
      let after = '';
      for (;;) {
        const page = rowsSchema.parse(
          await this.device(`${base}?table=${table}&limit=500&after=${encodeURIComponent(after)}`),
        );
        // A newer set was committed while reading: the next pass reads that one.
        if (page.revision !== site.revision) throw fail('KNOWLEDGE_CHANGED');
        rows.push(...page.rows);
        if (!page.next) break;
        after = page.next;
      }
      tables[table] = rows;
    }
    writeKnowledgeCopy(file, site.revision, site, tables);
  }
  /**
   * Brings the project's knowledge in line with the site: upload when this PC crawled, else
   * take the site's newer set; then exchange reviews and source rules.
   */
  async syncKnowledge(projectId: string, hint?: { revision?: number; changedAt?: number | null }) {
    const file = this.options.knowledgeFile?.(projectId);
    if (!file) return;
    const copy = copyRevision(file);
    if (existsSync(file) && copy === undefined) await this.push(projectId, file);
    else if (hint?.revision === undefined || (hint.revision > 0 && hint.revision !== copy)) {
      const site = knowledgeStateSchema.parse(
        await this.device(this.base(projectId) + '/knowledge'),
      );
      if (site.revision > 0 && site.revision !== copy) await this.pull(projectId, file, site);
    }
    const state = this.state(projectId);
    if (
      state.since === undefined ||
      state.outbox.reviews.length ||
      state.outbox.rules.length ||
      (hint?.changedAt ?? Infinity) > state.since
    )
      await this.syncReviews(projectId);
  }
  /** Sends the outbox (all local rows on the first exchange) and applies the site's changes. */
  async syncReviews(projectId: string) {
    const reviewStore = this.options.reviews?.();
    if (!reviewStore) return;
    const state = this.state(projectId);
    const first = state.since === undefined;
    const sent = {
      reviews: first
        ? reviewStore.reviews(projectId).map((row) => ({
            statementId: row.statementId,
            verdict: row.verdict,
            correction: row.correction,
            supersededBy: row.supersededBy,
            reason: row.reason,
            by: row.by,
            editedAt: Date.parse(row.at) || Date.now(),
          }))
        : state.outbox.reviews,
      rules: first
        ? reviewStore.sourceRules(projectId).map((rule) => ({
            pattern: rule.pattern,
            reason: rule.reason,
            removed: false,
            // A rule kept only here loses to any edit of the same pattern on the site.
            editedAt: 1,
          }))
        : state.outbox.rules,
    };
    if (first)
      for (const item of [...state.outbox.reviews]) {
        sent.reviews = sent.reviews.filter((row) => row.statementId !== item.statementId);
        sent.reviews.push(item);
      }
    const reply = exchangeSchema.parse(
      await this.device(this.base(projectId) + '/knowledge/reviews', 'POST', {
        ...sent,
        since: state.since ?? 0,
      }),
    );
    for (const review of reply.reviews)
      try {
        if (review.verdict === null) reviewStore.removeReview(projectId, review.statementId);
        else
          reviewStore.setReview(projectId, review.statementId, {
            verdict: review.verdict,
            correction: review.correction ?? null,
            supersededBy: review.supersededBy ?? null,
            reason: review.reason ?? null,
            by: review.by || 'user',
          });
      } catch {
        /* A row the local store rejects stays as it is. */
      }
    for (const rule of reply.rules)
      if (rule.removed) reviewStore.removeSourceRule(projectId, rule.pattern);
      else reviewStore.addSourceRule(projectId, rule.pattern, rule.reason ?? null);
    // What was recorded here while this exchange ran goes next time (and is applied again now).
    const after = this.state(projectId);
    const sentReview = new Map(sent.reviews.map((row) => [row.statementId, row.editedAt]));
    const sentRule = new Map(sent.rules.map((row) => [row.pattern, row.editedAt]));
    const outbox = {
      reviews: after.outbox.reviews.filter(
        (row) => sentReview.get(row.statementId) !== row.editedAt,
      ),
      rules: after.outbox.rules.filter((row) => sentRule.get(row.pattern) !== row.editedAt),
    };
    for (const review of outbox.reviews)
      if (review.verdict === null) reviewStore.removeReview(projectId, review.statementId);
      else
        reviewStore.setReview(projectId, review.statementId, {
          verdict: review.verdict,
          correction: review.correction ?? null,
          supersededBy: review.supersededBy ?? null,
          reason: review.reason ?? null,
          by: review.by || 'user',
        });
    this.saveState(projectId, { ...after, outbox, since: reply.at });
  }

  // ── Background pass ─────────────────────────────────────────────────────────────────────────
  /**
   * After a heartbeat: at most every two minutes, the member list, then for each project on this
   * PC that the site lists, its instructions and knowledge. Errors leave the copies as they are.
   */
  tick(force = false) {
    if (!this.options.remote.site) return Promise.resolve();
    if (this.running) return this.running;
    if (!force && Date.now() - this.lastPass < (this.options.intervalMs ?? 120_000))
      return Promise.resolve();
    this.lastPass = Date.now();
    this.running = (async () => {
      const members = await this.members();
      if (!members.online) return;
      const listed = new Map(members.projects.map((project) => [project.id, project]));
      for (const project of this.options.localProjects()) {
        const info = listed.get(project.id);
        if (!info) continue;
        await this.syncInstructions(project.id, info.instructionsRevision).catch(() => undefined);
        await this.syncKnowledge(project.id, {
          revision: info.knowledgeRevision,
          changedAt: info.knowledgeChangedAt,
        }).catch(() => undefined);
      }
    })()
      .catch(() => undefined)
      .finally(() => (this.running = undefined));
    return this.running;
  }
}
