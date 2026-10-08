// The project knowledge collector (SPEC-08.9, PLAN-42 T-194): the project folders of this PC into
// the project's knowledge DB, run only when the person presses [자료 정리하기] / [자료 업데이트]
// (2026-10-07 user decision: no automatic runs while modelling). One run per project at a time:
// list → read documents → read drawings → filter (Haiku) → statements (Sonnet) → issues (Opus)
// → 할 일·일정 proposals (Opus). Only new or changed files reach the AI; removed files' statements
// are hidden. Originals are only read; the DB is the one the 자료 tab reads.
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { localDate } from '../../core/agenda.ts';
import type { AgendaItem } from '../../contracts/agenda.ts';
import { knowledgeFile } from '../../jigs/knowledge.ts';
import { copyRevision } from '../../jigs/knowledge-copy.ts';
import { DomainError } from '../../contracts/errors.ts';
import { getMeta, logRun, openKnowledgeDb, setMeta, VISIBLE, type KnowledgeDb } from './schema.ts';
import { inventory, moveRoot, rootsOf } from './inventory.ts';
import { extractDocuments } from './extract.ts';
import { extractDrawings, type DwgReader } from './dwg.ts';
import { extractStatements, selectExcerpts, updateIssues, type StageContext } from './stages.ts';
import {
  decideProposals,
  pendingProposals,
  proposeAgenda,
  type AgendaProposal,
} from './proposals.ts';
import type { CollectRunner, ModelPlan } from './ai.ts';

export type CollectStage =
  | 'list'
  | 'read'
  | 'drawings'
  | 'filter'
  | 'statements'
  | 'issues'
  | 'proposals';
export interface CollectState {
  /** idle: never run here (or the engine restarted); done/failed/stopped: the last run's end. */
  state: 'idle' | 'running' | 'done' | 'failed' | 'stopped';
  stage: CollectStage | null;
  done: number;
  total: number;
  startedAt: string | null;
  /** The last completed collection (kept in the DB). */
  collectedAt: string | null;
  /** The DB was built (by this collector or the spike): the button reads [자료 업데이트]. */
  collected: boolean;
  error: string | null;
  counts: {
    files: number;
    read: number;
    unread: Record<string, number>;
    statements: number;
    issues: number;
    proposals: number;
  } | null;
  /** The model family used: 'claude' or 'codex'. */
  models: 'claude' | 'codex' | null;
}

export interface CollectorOptions {
  dataDirectory: string;
  /** This project's folders of kind 'project' (real paths). */
  folders: (projectId: string) => string[];
  /** SPEC-01.13 4: locations and secret files never read. */
  denied: (path: string) => boolean;
  runner: CollectRunner;
  /** The models of a run, or null when no AI CLI is signed in. */
  plan: () => Promise<ModelPlan | null>;
  agenda: (projectId: string) => AgendaItem[];
  projectName?: (projectId: string) => string;
  dwgReader?: DwgReader;
  now?: () => Date;
}

interface Job {
  controller: AbortController;
  state: CollectState;
  done: Promise<void>;
}

const error = (code: string) => new DomainError(code);

export class KnowledgeCollector {
  private readonly options: CollectorOptions;
  private readonly jobs = new Map<string, Job>();
  /** The last run's end per project, while the engine runs. */
  private readonly last = new Map<string, CollectState>();
  constructor(options: CollectorOptions) {
    this.options = options;
  }
  file(projectId: string) {
    return knowledgeFile(this.options.dataDirectory, projectId);
  }
  private today() {
    return localDate(this.options.now?.() ?? new Date());
  }

  /** What the DB holds: counts by file status, visible statements, issues, pending proposals. */
  private counts(db: KnowledgeDb): NonNullable<CollectState['counts']> {
    const n = (sql: string, ...values: string[]) =>
      Number((db.prepare(sql).get(...values) as { n: number }).n);
    const unread: Record<string, number> = {};
    for (const row of db
      .prepare(
        `select coalesce(status, case when extract_error is null then 'done' else 'error' end) as status, count(*) as n
          from source where skip is null and kind <> 'binary' and extracted_sha is not null group by 1`,
      )
      .all() as { status: string; n: number }[])
      if (row.status !== 'done') unread[row.status] = Number(row.n);
    return {
      files: n("select count(*) as n from source where skip is null and kind <> 'binary'"),
      read: n(
        "select count(*) as n from source where skip is null and kind <> 'binary' and coalesce(status, 'done') = 'done' and extracted_sha is not null",
      ),
      unread,
      statements: n(`select count(*) as n from statement st where ${VISIBLE}`),
      issues: n('select count(*) as n from issue'),
      proposals: n(
        "select count(*) as n from agenda_proposal where status = 'pending' and date >= ?",
        this.today(),
      ),
    };
  }

  status(projectId: string): CollectState {
    const job = this.jobs.get(projectId);
    if (job) return { ...job.state };
    const file = this.file(projectId);
    const base: CollectState = this.last.get(projectId) ?? {
      state: 'idle',
      stage: null,
      done: 0,
      total: 0,
      startedAt: null,
      collectedAt: null,
      collected: false,
      error: null,
      counts: null,
      models: null,
    };
    if (!existsSync(file)) return { ...base, collected: false, counts: null };
    try {
      const db = openKnowledgeDb(file);
      try {
        return {
          ...base,
          collected: true,
          collectedAt: getMeta(db, 'collected_at') ?? base.collectedAt,
          counts: this.counts(db),
        };
      } finally {
        db.close();
      }
    } catch {
      return { ...base, collected: true };
    }
  }

  /** Starts a run (the first one or an update). A running one is returned as it is. */
  async start(projectId: string): Promise<CollectState> {
    if (this.jobs.has(projectId)) return this.status(projectId);
    const folders = this.options.folders(projectId).filter((folder) => {
      try {
        return statSync(folder).isDirectory() && !this.options.denied(folder);
      } catch {
        return false;
      }
    });
    const roots = rootsOf(folders);
    if (!roots) throw error('NO_PROJECT_FOLDER');
    const file = this.file(projectId);
    if (copyRevision(file) !== undefined) throw error('KNOWLEDGE_IS_COPY');
    const plan = await this.options.plan();
    if (!plan) throw error('AI_NOT_SIGNED_IN');
    const controller = new AbortController();
    const state: CollectState = {
      ...this.status(projectId),
      state: 'running',
      stage: 'list',
      done: 0,
      total: 0,
      startedAt: new Date().toISOString(),
      error: null,
      models: plan.extract.provider === 'claude-cli' ? 'claude' : 'codex',
    };
    const job: Job = { controller, state, done: Promise.resolve() };
    this.jobs.set(projectId, job);
    job.done = this.run(projectId, file, roots, plan, job)
      .then(() => {
        job.state.state = 'done';
      })
      .catch((failure: unknown) => {
        const message = String((failure as Error)?.message ?? failure);
        job.state.state = controller.signal.aborted ? 'stopped' : 'failed';
        job.state.error = controller.signal.aborted ? null : message.slice(0, 300);
      })
      .finally(() => {
        job.state.stage = null;
        this.jobs.delete(projectId);
        this.last.set(projectId, { ...job.state });
        this.last.set(projectId, this.status(projectId));
      });
    return this.status(projectId);
  }

  stop(projectId: string) {
    this.jobs.get(projectId)?.controller.abort();
    return this.status(projectId);
  }
  /** Waits for a project's run (tests, shutdown). */
  async idle(projectId?: string) {
    await Promise.all(
      [...this.jobs]
        .filter(([id]) => !projectId || id === projectId)
        .map(([, job]) => job.done.catch(() => {})),
    );
  }
  async close() {
    for (const job of this.jobs.values()) job.controller.abort();
    await this.idle();
  }

  private async run(
    projectId: string,
    file: string,
    roots: NonNullable<ReturnType<typeof rootsOf>>,
    plan: ModelPlan,
    job: Job,
  ) {
    const signal = job.controller.signal;
    const db = openKnowledgeDb(file);
    try {
      const stage = (name: CollectStage) => {
        if (signal.aborted) throw new Error('STOPPED');
        job.state.stage = name;
        job.state.done = 0;
        job.state.total = 0;
        return performance.now();
      };
      const progress = (done: number, total: number) => {
        job.state.done = done;
        job.state.total = total;
      };
      setMeta(db, 'project_id', projectId);
      const name = this.options.projectName?.(projectId);
      if (name) setMeta(db, 'project_name', name);
      const oldRoot = getMeta(db, 'root');
      if (oldRoot) moveRoot(db, oldRoot, roots.root);
      setMeta(db, 'root', roots.root);
      setMeta(db, 'folders', JSON.stringify(roots.folders));
      setMeta(db, 'collector', 'vide');
      const before = Number(
        (db.prepare('select coalesce(max(id), 0) as n from statement').get() as { n: number }).n,
      );

      let t = stage('list');
      const listed = await inventory(db, roots, this.options.denied, signal);
      logRun(db, 'inventory', t, { items: listed.files, note: listed });

      t = stage('read');
      const read = await extractDocuments(db, roots.root, progress, signal);
      logRun(db, 'extract', t, { items: read.excerpts, note: read });

      t = stage('drawings');
      const drawings = await extractDrawings(
        db,
        roots.root,
        join(this.options.dataDirectory, 'knowledge-work', projectId),
        this.options.dwgReader,
        progress,
        signal,
      );
      logRun(db, 'dwg', t, { items: drawings.files, note: drawings });

      // Every AI call of a stage failed: the run stops with the reason (work done so far is kept).
      const check = (result: object) => {
        const { llmCalls, failed } = result as { llmCalls?: number; failed?: number };
        if (signal.aborted) throw new Error('STOPPED');
        if (failed && !llmCalls) throw new Error('AI_CALLS_FAILED');
      };
      const context: StageContext = { db, runner: this.options.runner, plan, signal, progress };
      t = stage('filter');
      const selected = await selectExcerpts(context);
      logRun(db, 'select', t, { items: selected.texts, ...selected, note: selected });
      check(selected);

      t = stage('statements');
      const statements = await extractStatements(context);
      logRun(db, 'statements', t, { items: statements.excerpts, ...statements, note: statements });
      check(statements);

      t = stage('issues');
      const issues = await updateIssues(context);
      logRun(db, 'issues', t, { items: issues.statements, ...issues, note: issues });
      check(issues);

      t = stage('proposals');
      const proposals = await proposeAgenda(
        context,
        before,
        this.options.agenda(projectId),
        this.today(),
      );
      logRun(db, 'proposals', t, { items: proposals.statements, ...proposals, note: proposals });
      check(proposals);

      if (signal.aborted) throw new Error('STOPPED');
      setMeta(db, 'collected_at', new Date().toISOString());
    } finally {
      db.close();
    }
  }

  // --- 할 일·일정 proposals (T-196) ---------------------------------------------------------
  private withDb<T>(projectId: string, fn: (db: KnowledgeDb) => T, fallback: T): T {
    const file = this.file(projectId);
    if (!existsSync(file)) return fallback;
    const db = openKnowledgeDb(file);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }
  proposals(projectId: string): AgendaProposal[] {
    return this.withDb(projectId, (db) => pendingProposals(db, this.today()), []);
  }
  decide(
    projectId: string,
    decisions: readonly { id: number; status: 'added' | 'dismissed'; agendaId?: string }[],
  ) {
    return this.withDb(projectId, (db) => decideProposals(db, decisions), 0);
  }
}
