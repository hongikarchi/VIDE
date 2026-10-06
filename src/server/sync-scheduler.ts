// The engine decides when linked documents are Synced (SPEC-01.11 10, ARCH-01 §7 「엔진 주관
// Sync(T-084)」). Every second it reads the open documents, matches them to the project's linked
// files and, per open document, runs at most one Sync: a Live Sync when the file's last Sync is a
// Rhino display Sync, a full Sync otherwise. The pages (VIDE window, Rhino panel, browser tabs)
// only read the result: the links list carries the state and the display revision.
//
// When: the first Sync of a newly linked file, a change of the document's change number
// (`generation`), and a Live file opened again while the engine had not seen it — the rules the
// page used before (PLAN-27 2단계). Held: work queued or running on the file's Syncs, a brief or
// direct write on the document, or a page's draft lease (5 s). Moving documents (SOURCE_CHANGED,
// host busy) are retried after 1, 2, 4, 8… s for up to 30 s, then wait for the next change or ⟳.
import { randomUUID } from 'node:crypto';
import { isFileLink, type DocumentLink, type DocumentLinks } from '../core/document-links.ts';
import type { Workspace } from '../core/workspace.ts';
import type { StoredWork } from '../contracts/stored-work.ts';
import { linkRequests } from './link-removal.ts';
import { matchLinks, type OpenDocument } from './live-links.ts';
import { LIVE_RETRY } from './live-sync.ts';

export type SyncState = 'idle' | 'syncing' | 'held' | 'waiting' | 'failed';
/** A linked open document as the host reports it (Rhino `editors.list`, ZWCAD `attached.list`). */
export interface ScheduledDocument extends OpenDocument {
  generation?: number;
  live?: boolean;
  hostBusy?: boolean;
  connection?: string;
}
type LiveReply = { resync: true } | { retry: string } | { requestId: string };
/** The document a user's Sync read (`POST …/capture`). */
export interface UserSyncTarget {
  instance: string;
  documentId: number;
  linkId?: string;
}
export interface SchedulerOptions {
  workspace: Workspace;
  links: Pick<DocumentLinks, 'list'>;
  projects: () => { id: string }[];
  /** The documents open in connected hosts now. */
  open: () => Promise<readonly ScheduledDocument[]>;
  /** A full Sync (`runDocumentSync`, never `fresh`). */
  fullSync: (
    projectId: string,
    target: { id: string; instance: string; documentId: number; linkId: string },
  ) => Promise<{ result: StoredWork }>;
  /** True when VIDE's own work-copy window of this link is open (it gets its first Sync). */
  isOwnedOpen?: (link: DocumentLink) => Promise<boolean | undefined>;
  /** A Live Sync (`LiveSync.run`); without it every change is a full Sync. */
  liveSync?: (
    projectId: string,
    input: { instance: string; documentId: number; basisId: string; revision: number },
  ) => Promise<LiveReply>;
  log?: (event: string, data: Record<string, unknown>) => void;
  now?: () => number;
  intervalMs?: number;
  /** How long a page's draft lease holds a file without being renewed. */
  leaseMs?: number;
  /** How long a moving document is retried before waiting for the next change. */
  retryWindowMs?: number;
}
interface DocumentState {
  seen?: number;
  state: SyncState;
  code?: string;
  at: string;
  running?: Promise<void>;
  attempts: number;
  firstFailure?: number;
  retryAt?: number;
  /** The file's last successful Sync when the state was set (⟳ elsewhere resets a wait). */
  lastSync?: string;
}

const RETRY = new Set([...LIVE_RETRY, 'HOST_BUSY']);
const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'SYNC_FAILED';

export class SyncScheduler {
  private readonly options: SchedulerOptions;
  private readonly states = new Map<string, DocumentState>();
  /** Page → draft lease: the files whose automatic Syncs it holds, until when. */
  private readonly leases = new Map<
    string,
    { projectId: string; links: Set<string>; bases: Set<string>; until: number }
  >();
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private stopped = false;
  constructor(options: SchedulerOptions) {
    this.options = options;
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 1000);
    this.timer.unref();
  }
  /** Stops ticking and waits for the Syncs that are running. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking?.catch(() => {});
    await Promise.allSettled([...this.states.values()].map((state) => state.running));
  }
  /** Waits for the current pass and the Syncs it started. */
  async settled() {
    await this.ticking?.catch(() => {});
    await Promise.allSettled([...this.states.values()].map((state) => state.running));
  }
  /** True while no Sync runs (storage upkeep waits for this). */
  idle() {
    return [...this.states.values()].every((state) => !state.running);
  }
  /**
   * A page holds the automatic Syncs of these files while its draft uses them (ARCH-01 §7 ③). The
   * lease ends when the page stops renewing it (`leaseMs`, 5 s) or renews it with no files.
   * `bases` are the Syncs the draft uses (its pins, its follow-up base): a user's Live Sync never
   * edits those in place (T-127).
   */
  hold(projectId: string, page: string, linkIds: string[], bases: string[] = []) {
    if (!linkIds.length) this.leases.delete(page);
    else
      this.leases.set(page, {
        projectId,
        links: new Set(linkIds),
        bases: new Set(bases),
        until: this.now() + (this.options.leaseMs ?? 5000),
      });
  }
  /** The Syncs the drafts of pages holding files of this project use now (T-127). */
  heldBases(projectId: string) {
    const now = this.now();
    const bases = new Set<string>();
    for (const lease of this.leases.values())
      if (lease.projectId === projectId && lease.until >= now)
        for (const id of lease.bases) bases.add(id);
    return [...bases];
  }
  private key(projectId: string, document: ScheduledDocument) {
    return [projectId, document.host ?? 'rhino', document.instance ?? '', document.id].join('|');
  }
  /** The linked file a user's Sync of this document belongs to (its link id, else its window). */
  private linkOf(projectId: string, target: UserSyncTarget) {
    return this.options.links
      .list(projectId)
      .find((row) =>
        target.linkId
          ? row.id === target.linkId
          : !isFileLink(row) &&
            row.instance === target.instance &&
            row.documentId === target.documentId,
      );
  }
  /**
   * True when the engine holds this document's automatic Sync now (a page's draft lease, work on
   * its Syncs, a write on it): a user's Live Sync then writes into a copy and leaves the shown Sync
   * the draft uses as it is (SPEC-01.11 6, T-123).
   */
  holds(projectId: string, target: UserSyncTarget) {
    const link = this.linkOf(projectId, target);
    if (!link) return false;
    const requests = this.options.workspace.list(projectId);
    return this.held(projectId, link, linkRequests(link, requests), requests, {
      host: link.host,
      instance: target.instance,
      id: target.documentId,
      name: link.name,
    });
  }
  /**
   * ⟳, 지금 Sync or the plugin's Sync brought this document up to date (T-123): a wait or a failure
   * shown on its row is over. A Live Sync in place keeps the Sync's id, so the id alone cannot tell.
   */
  userSynced(projectId: string, target: UserSyncTarget) {
    for (const host of ['rhino', 'zwcad'] as const) {
      const state = this.states.get(
        this.key(projectId, { host, instance: target.instance, id: target.documentId, name: '' }),
      );
      if (!state || state.running) continue;
      state.attempts = 0;
      state.firstFailure = state.retryAt = undefined;
      state.lastSync = undefined;
      this.set(state, 'idle');
    }
  }
  /** The state the links list shows for a linked file open in this document. */
  status(projectId: string, document: ScheduledDocument | undefined) {
    if (!document) return undefined;
    const state = this.states.get(this.key(projectId, document));
    return state
      ? { state: state.state, ...(state.code ? { code: state.code } : {}), at: state.at }
      : undefined;
  }
  /** One pass over every project's open linked files; a pass never overlaps the previous one. */
  tick(): Promise<void> {
    if (this.ticking || this.stopped) return this.ticking ?? Promise.resolve();
    const pass = this.pass()
      .catch((error) => this.options.log?.('sync-scheduler-failed', { code: errorCode(error) }))
      .finally(() => {
        this.ticking = undefined;
      });
    this.ticking = pass;
    return pass;
  }
  private async pass() {
    const now = this.now();
    for (const [page, lease] of this.leases) if (lease.until < now) this.leases.delete(page);
    const projects = this.options
      .projects()
      .map((project) => ({
        id: project.id,
        rows: this.options.links.list(project.id).filter((row) => !isFileLink(row)),
      }))
      .filter((project) => project.rows.length);
    if (!projects.length) return;
    const open = (await this.options.open()).filter(
      (document): document is ScheduledDocument & { instance: string } =>
        typeof document.instance === 'string',
    );
    if (this.stopped) return;
    for (const project of projects) {
      const matched = matchLinks(project.rows, open);
      const requests = this.options.workspace.list(project.id);
      for (const row of project.rows) {
        const found = matched.get(row.id);
        if (found && (found.document.connection ?? 'attached-editor') === 'attached-editor')
          this.consider(project.id, row, found.document, requests);
        else if (!found) await this.firstOfWorkCopy(project.id, row, requests);
      }
    }
  }
  private consider(
    projectId: string,
    link: DocumentLink,
    document: ScheduledDocument & { instance: string },
    requests: StoredWork[],
  ) {
    const key = this.key(projectId, document);
    const state: DocumentState = this.states.get(key) ?? {
      state: 'idle',
      at: new Date(this.now()).toISOString(),
      attempts: 0,
    };
    this.states.set(key, state);
    if (state.running) return;
    const generation = document.generation ?? 0;
    const own = linkRequests(link, requests);
    const last = own.filter((entry) => entry.state === 'succeeded').at(-1);
    // ⟳ (or a plugin Sync) brought a newer Sync: a wait or a failure is over.
    if (
      last &&
      state.lastSync !== undefined &&
      last.id !== state.lastSync &&
      state.state !== 'held'
    ) {
      this.set(state, 'idle');
      state.attempts = 0;
      state.firstFailure = state.retryAt = undefined;
    }
    const seen = state.seen;
    const first = !last && seen === undefined;
    const changed = seen !== undefined && generation > seen;
    // Opened again while the engine had not seen it: a Live file catches up once.
    const reopened = seen === undefined && !!last && !!document.live;
    const retrying = state.retryAt !== undefined;
    if (changed && retrying) {
      // Changed again while retrying: count from 0 and Sync now.
      state.attempts = 0;
      state.firstFailure = state.retryAt = undefined;
    } else if (retrying && state.retryAt! > this.now()) return;
    if (!first && !changed && !reopened && !(retrying && state.retryAt! <= this.now())) {
      if (seen === undefined) state.seen = generation;
      return;
    }
    if (document.hostBusy) return;
    if (!first && this.held(projectId, link, own, requests, document)) {
      if (state.state !== 'held') {
        this.set(state, 'held');
        this.options.log?.('sync-scheduler', {
          document: key,
          action: 'held',
          generation,
        });
      }
      return;
    }
    state.seen = generation;
    state.running = this.act(projectId, key, link, document, last, state).finally(() => {
      state.running = undefined;
    });
  }
  /**
   * A work copy VIDE opened itself (not in the hosts' list of attached documents) gets its first
   * Sync once; after that it is Synced with ⟳ only (SPEC-01.11).
   */
  private async firstOfWorkCopy(projectId: string, link: DocumentLink, requests: StoredWork[]) {
    if (!this.options.isOwnedOpen) return;
    const document = {
      host: link.host,
      instance: link.instance,
      id: link.documentId,
      name: link.name,
    };
    if (this.states.has(this.key(projectId, document))) return;
    if (linkRequests(link, requests).some((entry) => entry.state === 'succeeded')) return;
    if (!(await this.options.isOwnedOpen(link).catch(() => false))) return;
    this.consider(projectId, link, { ...document, generation: 0, live: false }, requests);
  }
  /** Work on this file holds its automatic Sync (SPEC-01.11 6, ARCH-01 §7 보류). */
  private held(
    projectId: string,
    link: DocumentLink,
    own: StoredWork[],
    requests: StoredWork[],
    document: ScheduledDocument,
  ) {
    const now = this.now();
    for (const lease of this.leases.values())
      if (lease.projectId === projectId && lease.until >= now && lease.links.has(link.id))
        return true;
    const byId = new Map(requests.map((entry) => [entry.id, entry]));
    const ownIds = new Set(own.map((entry) => entry.id));
    // A request's basis chain reaches one of this file's Syncs.
    const uses = (id: unknown) => {
      for (let depth = 0; typeof id === 'string' && depth < 30; depth++) {
        if (ownIds.has(id)) return true;
        const entry = byId.get(id);
        id = entry?.input.baseRequestId ?? entry?.result?.baseRequestId;
      }
      return false;
    };
    for (const entry of this.options.workspace.claimRows(projectId)) {
      if (!['queued', 'running'].includes(entry.state) || ownIds.has(entry.id)) continue;
      const input = entry.input as StoredWork['input'] & {
        linkedTargets?: { baseRequestId?: string }[];
        sourceDocument?: { instance?: unknown; documentId?: unknown };
        hostUse?: unknown;
      };
      if (
        uses(input.baseRequestId) ||
        (input.linkedTargets ?? []).some((target) => uses(target.baseRequestId)) ||
        input.pins.some((pin) => uses((pin as { basis?: unknown }).basis))
      )
        return true;
      // A brief write (a jig's direct bake) or a direct write on this very document.
      if (
        input.source === 'document' &&
        input.hostUse === 'write' &&
        input.sourceDocument?.instance === document.instance &&
        input.sourceDocument?.documentId === document.id
      )
        return true;
    }
    return false;
  }
  private set(state: DocumentState, value: SyncState, code?: string) {
    state.state = value;
    state.code = code;
    state.at = new Date(this.now()).toISOString();
  }
  private async act(
    projectId: string,
    key: string,
    link: DocumentLink,
    document: ScheduledDocument & { instance: string },
    last: StoredWork | undefined,
    state: DocumentState,
  ) {
    const started = this.now();
    const generation = document.generation ?? 0;
    const target = { instance: document.instance, documentId: document.id };
    this.set(state, 'syncing');
    let action: 'live' | 'full' = 'full';
    let code: string | undefined;
    let syncId: string | undefined;
    try {
      const basis = last && this.options.workspace.brief(projectId, last.id).result;
      const revision = (basis?.sourceDocument as { revision?: unknown } | undefined)?.revision;
      if (
        this.options.liveSync &&
        last &&
        // ZWCAD too (T-128): its Syncs carry a revision only when the plugin reports changes.
        basis?.displayOnly === true &&
        typeof revision === 'number'
      ) {
        action = 'live';
        const reply = await this.options.liveSync(projectId, {
          ...target,
          basisId: last.id,
          revision,
        });
        if ('retry' in reply) code = reply.retry;
        else if ('requestId' in reply) syncId = reply.requestId;
        else action = 'full';
      }
      if (action === 'full') {
        const id = randomUUID();
        const { result } = await this.options.fullSync(projectId, {
          id,
          ...target,
          linkId: link.id,
        });
        if (result.state === 'succeeded') syncId = result.id;
        else {
          code = String(result.result?.code ?? result.state);
          // A moving document is retried, not recorded as a failed Sync.
          if (RETRY.has(code) && result.id === id)
            try {
              this.options.workspace.purge(projectId, [id]);
            } catch {
              /* Kept as a failed record when it cannot be removed. */
            }
        }
      }
    } catch (error) {
      code = errorCode(error);
    }
    const ms = this.now() - started;
    if (syncId) {
      state.attempts = 0;
      state.firstFailure = state.retryAt = undefined;
      state.lastSync = syncId;
      this.set(state, 'idle');
      this.options.log?.('sync-scheduler', { document: key, action, generation, ms });
      return;
    }
    state.lastSync = last?.id;
    if (code && RETRY.has(code)) {
      const now = this.now();
      state.firstFailure ??= now;
      state.attempts++;
      const delay = 1000 * 2 ** (state.attempts - 1);
      if (now + delay - state.firstFailure > (this.options.retryWindowMs ?? 30_000)) {
        state.retryAt = undefined;
        state.attempts = 0;
        state.firstFailure = undefined;
        this.set(state, 'waiting', code);
        this.options.log?.('sync-scheduler', {
          document: key,
          action: 'wait',
          generation,
          code,
          ms,
        });
      } else {
        state.retryAt = now + delay;
        this.set(state, 'waiting', code);
        this.options.log?.('sync-scheduler', {
          document: key,
          action: 'retry',
          generation,
          code,
          delay,
          ms,
        });
      }
      return;
    }
    state.retryAt = undefined;
    this.set(state, 'failed', code);
    this.options.log?.('sync-scheduler', { document: key, action, generation, code, ms });
  }
}
