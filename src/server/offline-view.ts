import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Agenda } from '../core/agenda.ts';
import type { DocumentLinks } from '../core/document-links.ts';
import type { Store } from '../core/store.ts';
import type { Workspace } from '../core/workspace.ts';
import { buildSnapshot, packSnapshot, type SyncResult } from './offline-snapshot.ts';
import type { AgendaEdit, AgendaEditResult, QueuedRequest, RemoteAccess } from './remote-access.ts';
import { agendaShare, applyAgendaEdit, historySummary } from './offline-summary.ts';

// Offline view and request queue (PLAN-20). Per project, the owner may let this PC keep a
// view-only snapshot of each linked file on the account site, so the model can be looked at while
// the PC is off; requests left there come back here as an inbox to bring into the composer. They
// never run on their own: the user reads and sends them.
//
// PLAN-33 (ADR-035): independently of the snapshots, every project of a signed-in PC shares its
// 할 일 and a summary of its work history with the site, so the project opens there while the PC
// is off, unless the owner turned that off for the project. 할 일 edits made on the site come back
// with the heartbeat and are applied here (offline-summary.ts).
const MIN_INTERVAL_MS = 10 * 60_000;
/** A failed summary upload is tried again after this; the history at most this often too. */
const SUMMARY_RETRY_MS = 60_000;

const stateSchema = z.object({
  projects: z
    .record(
      z.string(),
      // `summary` (PLAN-33): 할 일 and history summary on the site; on unless turned off.
      z.object({ enabled: z.boolean(), summary: z.boolean().optional() }),
    )
    .default({}),
  summaries: z
    .record(
      z.string(),
      z.object({
        agenda: z.string().optional(),
        history: z.string().optional(),
        at: z.number().optional(),
        error: z.object({ code: z.string(), at: z.number() }).optional(),
      }),
    )
    .default({}),
  /** Site 할 일 edits done here, by edit id: the version done and the item an add made. */
  applied: z
    .record(
      z.string(),
      z.object({
        editedAt: z.number(),
        outcome: z.enum(['applied', 'conflict', 'missing']),
        itemId: z.string().optional(),
      }),
    )
    .default({}),
  uploaded: z
    .record(
      z.string(),
      z.object({
        projectId: z.string(),
        requestId: z.string(),
        /** The Sync list revision uploaded: a Live Sync fixes a Sync in place and raises it. */
        revision: z.number().nullable().optional(),
        at: z.number(),
        size: z.number(),
      }),
    )
    .default({}),
  errors: z.record(z.string(), z.object({ code: z.string(), at: z.number() })).default({}),
  inbox: z
    .array(
      z.object({
        id: z.string(),
        projectId: z.string(),
        linkId: z.string().nullable(),
        body: z.string(),
        createdAt: z.number(),
        receivedAt: z.number(),
      }),
    )
    .default([]),
});
type State = z.infer<typeof stateSchema>;

interface Options {
  directory?: string;
  store: Store;
  workspace: Workspace;
  links: DocumentLinks;
  remote: Pick<
    RemoteAccess,
    'uploadSnapshot' | 'deleteSnapshot' | 'uploadSummary' | 'deleteSummary' | 'hostId'
  >;
  agenda?: Agenda;
  now?: () => number;
}

export class OfflineView {
  private state: State = stateSchema.parse({});
  private loaded: Promise<void> | undefined;
  private busy: Promise<unknown> = Promise.resolve();
  private ticking: Promise<void> | undefined;
  private closed = false;
  private historyChecked = new Map<string, number>();
  private options: Options;
  private agenda: Agenda;
  constructor(options: Options) {
    this.options = options;
    this.agenda = options.agenda ?? new Agenda(options.store);
  }
  private get now() {
    return this.options.now?.() ?? Date.now();
  }
  private get file() {
    return this.options.directory ? join(this.options.directory, 'offline-view.json') : undefined;
  }
  private load() {
    return (this.loaded ??= (async () => {
      if (!this.file) return;
      try {
        this.state = stateSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
      } catch {
        /* First use, or an unreadable file: start empty (nothing is lost on the site). */
      }
    })());
  }
  private async save() {
    if (!this.file) return;
    await writeFile(this.file + '.tmp', JSON.stringify(this.state));
    await rename(this.file + '.tmp', this.file);
  }
  /** One change at a time; the state file is small and rewritten whole. */
  private serial<T>(work: () => Promise<T>) {
    const next = this.busy.then(work, work);
    this.busy = next.catch(() => undefined);
    return next;
  }
  /** The file's last Sync and its list revision (a Live Sync updates a Sync in place). */
  private lastSync(projectId: string, linkId: string) {
    const row = this.options.store
      .db(projectId)
      .prepare(
        `SELECT w.id, m.revision FROM workspace_requests w
         LEFT JOIN sync_manifests m ON m.requestId=w.id
         WHERE w.projectId=? AND w.state='succeeded'
         AND json_extract(w.input,'$.linkId')=? ORDER BY w.rowid DESC LIMIT 1`,
      )
      .get(projectId, linkId) as { id: string; revision: number | null } | undefined;
    return row ? { requestId: row.id, revision: row.revision ?? null } : undefined;
  }
  private static current(
    uploaded: { requestId: string; revision?: number | null } | undefined,
    last: { requestId: string; revision: number | null } | undefined,
  ) {
    return (
      !!uploaded &&
      !!last &&
      uploaded.requestId === last.requestId &&
      (uploaded.revision ?? null) === last.revision
    );
  }

  async status(projectId: string) {
    await this.load();
    const enabled = this.state.projects[projectId]?.enabled ?? false;
    const shared = this.state.summaries[projectId];
    return {
      enabled,
      summary: this.summaryOn(projectId),
      summaryAt: shared?.at ? new Date(shared.at).toISOString() : null,
      summaryError: shared?.error?.code ?? null,
      linked: !!this.options.remote.hostId,
      files: this.options.links
        .list(projectId)
        .filter((link) => !link.hidden)
        .map((link) => {
          const uploaded = this.state.uploaded[link.id];
          const last = this.lastSync(projectId, link.id);
          return {
            linkId: link.id,
            name: link.name,
            uploadedAt: uploaded ? new Date(uploaded.at).toISOString() : null,
            size: uploaded?.size ?? null,
            upToDate: OfflineView.current(uploaded, last),
            synced: !!last,
            error: this.state.errors[link.id]?.code ?? null,
          };
        }),
      inbox: this.state.inbox
        .filter((item) => item.projectId === projectId)
        .map((item) => ({
          ...item,
          createdAt: new Date(item.createdAt).toISOString(),
          receivedAt: new Date(item.receivedAt).toISOString(),
        })),
    };
  }

  private summaryOn(projectId: string) {
    return this.state.projects[projectId]?.summary ?? true;
  }

  /** 할 일 and the history summary on the site for this project (PLAN-33); off removes them. */
  setSummary(projectId: string, on: boolean) {
    return this.serial(async () => {
      await this.load();
      this.options.store.project(projectId);
      this.state.projects[projectId] = {
        enabled: this.state.projects[projectId]?.enabled ?? false,
        summary: on,
      };
      if (!on) {
        await this.options.remote.deleteSummary(projectId);
        delete this.state.summaries[projectId];
      }
      await this.save();
      if (on) void this.tick(true);
    });
  }

  setEnabled(projectId: string, enabled: boolean) {
    return this.serial(async () => {
      await this.load();
      this.options.store.project(projectId);
      this.state.projects[projectId] = { ...this.state.projects[projectId], enabled };
      if (!enabled) {
        // Turning it off removes what this PC stored on the site.
        for (const [linkId, uploaded] of Object.entries(this.state.uploaded))
          if (uploaded.projectId === projectId) {
            await this.options.remote.deleteSnapshot(projectId, linkId);
            delete this.state.uploaded[linkId];
            delete this.state.errors[linkId];
          }
      }
      await this.save();
      if (enabled) void this.tick(true);
    });
  }

  /** A deleted project: its offline views leave the site, and its settings and inbox go. */
  forget(projectId: string) {
    return this.serial(async () => {
      await this.load();
      delete this.state.projects[projectId];
      delete this.state.summaries[projectId];
      for (const [linkId, uploaded] of Object.entries(this.state.uploaded))
        if (uploaded.projectId === projectId) {
          await this.options.remote.deleteSnapshot(projectId, linkId).catch(() => undefined);
          delete this.state.uploaded[linkId];
          delete this.state.errors[linkId];
        }
      this.state.inbox = this.state.inbox.filter((item) => item.projectId !== projectId);
      await this.save();
    });
  }

  /**
   * Upload changed linked files of enabled projects (at most one per file every 10 minutes). A
   * call during a run waits for that run.
   */
  tick(force = false): Promise<void> {
    if (!this.options.remote.hostId || this.closed) return Promise.resolve();
    return (this.ticking ??= this.run(force).finally(() => {
      this.ticking = undefined;
    }));
  }
  /** Engine stop: no new uploads, and the one running (and its state file write) ends first. */
  async close() {
    this.closed = true;
    await this.ticking?.catch(() => undefined);
    await this.busy;
  }
  private async run(force: boolean) {
    await this.load();
    // 할 일 and history summaries first: small, and they do not depend on the snapshot switch.
    for (const project of this.options.store.listProjects()) {
      if (this.closed) return;
      if (!this.summaryOn(project.id)) continue;
      await this.serial(() => this.share(project.id, force));
    }
    for (const [projectId, setting] of Object.entries(this.state.projects)) {
      if (!setting.enabled) continue;
      let links;
      try {
        links = this.options.links.list(projectId);
      } catch {
        continue;
      }
      for (const link of links) {
        if (link.hidden) continue;
        const last = this.lastSync(projectId, link.id);
        const uploaded = this.state.uploaded[link.id];
        if (!last || OfflineView.current(uploaded, last)) continue;
        if (!force && uploaded && this.now - uploaded.at < MIN_INTERVAL_MS) continue;
        const failed = this.state.errors[link.id];
        if (!force && failed && this.now - failed.at < MIN_INTERVAL_MS) continue;
        await this.serial(() => this.upload(projectId, link, last));
      }
    }
  }
  private async upload(
    projectId: string,
    link: { id: string; name: string; host: 'rhino' | 'zwcad' },
    { requestId, revision }: { requestId: string; revision: number | null },
  ) {
    let code: string | undefined;
    let size = 0;
    let objects = 0;
    try {
      // Read lazily (T-129): one scene item decoded at a time, definitions only as blocks use them.
      const work = this.options.workspace.lazy(projectId, requestId);
      const snapshot = buildSnapshot((work.result ?? {}) as SyncResult, {
        name: link.name,
        host: link.host,
      });
      objects = snapshot.objectCount;
      const bytes = packSnapshot(snapshot);
      size = bytes.byteLength;
      code = await this.options.remote.uploadSnapshot(
        projectId,
        link.id,
        {
          name: link.name,
          host: link.host,
          objects,
          capturedAt: Date.parse(snapshot.capturedAt) || this.now,
        },
        bytes,
      );
    } catch {
      code = 'SNAPSHOT_BUILD_FAILED';
    }
    if (code) this.state.errors[link.id] = { code, at: this.now };
    else {
      delete this.state.errors[link.id];
      this.state.uploaded[link.id] = { projectId, requestId, revision, at: this.now, size };
    }
    await this.save();
  }

  /**
   * Uploads the project's 할 일 and history summary when they changed since the last upload
   * (`agendaOnly`: the 할 일 alone, right after site edits were applied). A failure is tried
   * again a minute later.
   */
  private async share(projectId: string, force: boolean, agendaOnly = false) {
    const shared = (this.state.summaries[projectId] ??= {});
    if (!force && shared.error && this.now - shared.error.at < SUMMARY_RETRY_MS) return;
    let changed = false,
      code: string | undefined;
    try {
      const agenda = agendaShare(this.options.store, this.agenda, projectId);
      if (agenda.key !== shared.agenda) {
        code = await this.options.remote.uploadSummary(projectId, 'agenda', agenda.items());
        if (!code) shared.agenda = agenda.key;
        changed = true;
      }
      // The history is read at most once a minute per project (its key reads the request inputs).
      const due =
        force || this.now - (this.historyChecked.get(projectId) ?? -Infinity) >= SUMMARY_RETRY_MS;
      if (!code && !agendaOnly && due) {
        this.historyChecked.set(projectId, this.now);
        const history = historySummary(this.options.store, this.options.links, projectId);
        if (history.key !== shared.history) {
          code = await this.options.remote.uploadSummary(projectId, 'history', history.items());
          if (!code) shared.history = history.key;
          changed = true;
        }
      }
    } catch {
      code = 'SUMMARY_BUILD_FAILED';
      changed = true;
    }
    if (!changed) return;
    if (code) shared.error = { code, at: this.now };
    else {
      delete shared.error;
      shared.at = this.now;
    }
    await this.save();
  }

  /**
   * 할 일 edits made on the site (PLAN-33): each applied once per version (last write wins by
   * time; a conflict is noted in the item), then the project's 할 일 goes back to the site before
   * the results are confirmed, so the site never shows the list without the edit.
   */
  applyEdits(edits: AgendaEdit[]): Promise<AgendaEditResult[]> {
    return this.serial(async () => {
      await this.load();
      const results: AgendaEditResult[] = [];
      const touched = new Set<string>();
      for (const edit of edits) {
        const done = this.state.applied[edit.id];
        if (done?.editedAt === edit.editedAt) {
          results.push({ id: edit.id, editedAt: edit.editedAt, outcome: done.outcome });
          continue;
        }
        const { outcome, itemId } = applyAgendaEdit(this.agenda, edit, done?.itemId);
        this.state.applied[edit.id] = { editedAt: edit.editedAt, outcome, itemId };
        results.push({ id: edit.id, editedAt: edit.editedAt, outcome });
        if (outcome !== 'missing') touched.add(edit.projectId);
      }
      // A small record: the oldest go first.
      const ids = Object.keys(this.state.applied);
      for (const id of ids.slice(0, Math.max(0, ids.length - 500))) delete this.state.applied[id];
      await this.save();
      for (const projectId of touched)
        if (this.summaryOn(projectId)) await this.share(projectId, true, true);
      return results;
    });
  }

  /** Requests from the site join the inbox; returns the ids now kept here. */
  receive(items: QueuedRequest[]) {
    return this.serial(async () => {
      await this.load();
      const known = new Set(this.state.inbox.map((item) => item.id));
      for (const item of items)
        if (!known.has(item.id)) this.state.inbox.push({ ...item, receivedAt: this.now });
      // A small inbox; the oldest drop off first.
      this.state.inbox = this.state.inbox.slice(-200);
      await this.save();
      return items.map((item) => item.id);
    });
  }
  dismiss(projectId: string, id: string) {
    return this.serial(async () => {
      await this.load();
      this.state.inbox = this.state.inbox.filter(
        (item) => !(item.projectId === projectId && item.id === id),
      );
      await this.save();
    });
  }
}
