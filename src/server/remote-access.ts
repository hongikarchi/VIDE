import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import { onPath } from '../ai/paths.ts';
import { downloadCloudflared } from './cloudflared.ts';

// Account link of this work PC. The PC signs in once with the VIDE account (ID/password) and keeps
// only a host key. While linked it reports to the account site that it is on, its local address
// (for a browser on this PC) and, with remote access on, a Cloudflare quick-tunnel address for
// other devices (e.g. an iPad). Browsers get a session only from a one-minute token that the site
// signs with this host's key; nothing else is trusted. Projects are listed per account on the
// site; the work data stays here.
export const DEFAULT_SHARING_ORIGIN = 'https://vide-sharing-staging.archivibe.workers.dev';
const HEARTBEAT_MS = 15_000;
const SESSION_MS = 12 * 60 * 60_000;

const deviceSchema = z.object({
  workerOrigin: z.string().url(),
  hostId: z.string().uuid(),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(80),
  username: z.string().max(254).optional(),
  remote: z.boolean().default(false),
});
type Device = z.infer<typeof deviceSchema>;
const tokenSchema = z.object({
  h: z.string(),
  n: z.string().regex(/^[a-f0-9]{32}$/),
  e: z.number(),
});
const cloudProjectsSchema = z.array(
  z.object({ id: z.string(), name: z.string(), deleted: z.boolean().default(false) }),
);
export type CloudProject = z.infer<typeof cloudProjectsSchema>[number];
/** A request left on the account site while this PC was off (PLAN-20). */
const queuedSchema = z.array(
  z.object({
    id: z.string().uuid(),
    projectId: z.string(),
    linkId: z.string().nullable(),
    body: z.string().max(4000),
    createdAt: z.number(),
  }),
);
export type QueuedRequest = z.infer<typeof queuedSchema>[number];
/**
 * A 할 일 edit made on the account site, for this PC to apply (PLAN-33; the period, 위치 and 참석자
 * from PLAN-39). A kind this PC does not know drops only that field, never the round's edits.
 */
const agendaEditSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  itemId: z.string().max(100),
  op: z.enum(['add', 'set', 'remove']),
  fields: z
    .object({
      text: z.string().max(500).optional(),
      date: z.string().nullable().optional(),
      time: z.string().nullable().optional(),
      endDate: z.string().nullable().optional(),
      endTime: z.string().nullable().optional(),
      kind: z.enum(['task', 'meeting', 'receipt', 'deadline']).optional().catch(undefined),
      location: z.string().max(200).nullable().optional(),
      attendees: z.string().max(300).nullable().optional(),
      done: z.boolean().optional(),
    })
    .strip(),
  baseRevision: z.number().int().nullable(),
  editedAt: z.number().int(),
});
export type AgendaEdit = z.infer<typeof agendaEditSchema>;
export type AgendaEditResult = {
  id: string;
  editedAt: number;
  outcome: 'applied' | 'conflict' | 'missing';
};
const failure = (code: string) => new DomainError(code);

export interface RemoteStatus {
  linked: boolean;
  username?: string;
  name?: string;
  site?: string;
  remote: boolean;
  running: boolean;
  starting: boolean;
  /** The remote access tool is being fetched (first use on this PC, PLAN-38 T-177). */
  downloading?: boolean;
  url?: string;
  lastHeartbeat?: string;
  error?: string;
}
interface Options {
  directory: string;
  port: () => number;
  /** Advisory summary shown in the PC list (connected documents). */
  status: () => Promise<Record<string, unknown>>;
  /** Local projects, pushed to the account list when the PC signs in. */
  projects?: () => { id: string; name: string }[];
  /** Last work time per local project (ms). */
  activity?: () => Record<string, number>;
  /** Projects of this PC in the account list (created or renamed on the site). */
  onProjects?: (projects: CloudProject[]) => void;
  /** Requests left on the site; returns the ids kept, which the site then marks delivered. */
  onQueue?: (items: QueuedRequest[]) => Promise<string[]> | string[];
  /** 할 일 edits made on the site; returns what was done with each, which the site then records. */
  onAgendaEdits?: (edits: AgendaEdit[]) => Promise<AgendaEditResult[]>;
  /** Runs after each successful heartbeat (offline view uploads). */
  afterHeartbeat?: () => void;
  executable?: string;
  /** Fetches cloudflared to the given path (default: the official release, `cloudflared.ts`). */
  download?: (target: string) => Promise<unknown>;
  fetcher?: typeof fetch;
  spawnProcess?: typeof spawn;
  heartbeatMs?: number;
}

export function cloudflaredPath(directory: string) {
  for (const candidate of [
    process.env.VIDE_CLOUDFLARED,
    join(directory, 'bin', 'cloudflared.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
    join(
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'cloudflared',
      'cloudflared.exe',
    ),
  ])
    if (candidate && existsSync(candidate)) return candidate;
  return onPath(['cloudflared.exe']);
}
/** Errors of the tunnel and its tool: shown only while remote access is on. */
const tunnelError = (code: string | undefined) => !!code && /^(CLOUDFLARED_|TUNNEL_)/.test(code);

export class RemoteAccess {
  private device: Device | undefined;
  private loaded: Promise<void> | undefined;
  private tunnel: ChildProcess | undefined;
  private starting: Promise<RemoteStatus> | undefined;
  private fetching: Promise<string> | undefined;
  private url: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastHeartbeat: string | undefined;
  private error: string | undefined;
  private used = new Map<string, number>();
  private sessions = new Map<string, number>();
  private closed = false;
  private reopen: ReturnType<typeof setTimeout> | undefined;
  private options: Options;
  constructor(options: Options) {
    this.options = options;
  }
  private get file() {
    return join(this.options.directory, 'remote-host.json');
  }
  private load() {
    return (this.loaded ??= (async () => {
      try {
        this.device = deviceSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
      } catch {
        this.device = undefined;
      }
    })());
  }
  private async save(device: Device) {
    await writeFile(this.file + '.tmp', JSON.stringify(device), { mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
    this.device = device;
    this.loaded = Promise.resolve();
  }
  private get fetcher() {
    return this.options.fetcher ?? fetch;
  }
  /** Public hostname of the running tunnel (requests with this Host are remote). */
  get host() {
    return this.url ? new URL(this.url).host : undefined;
  }
  /** The account site of a linked PC (for the local "hello" check and links back). */
  get site() {
    return this.device?.workerOrigin;
  }
  get hostId() {
    return this.device?.hostId;
  }
  /** Resume a saved link at startup: presence, and the tunnel if remote access was on. */
  async init() {
    await this.load();
    if (!this.device || this.closed) return;
    // Keep the account list complete (projects made while offline or before this version).
    for (const project of this.options.projects?.() ?? []) await this.pushProject(project);
    this.beat();
    if (this.device.remote) void this.start().catch(() => {});
  }
  async status(): Promise<RemoteStatus> {
    await this.load();
    return {
      linked: !!this.device,
      username: this.device?.username,
      name: this.device?.name,
      site: this.device?.workerOrigin,
      remote: !!this.device?.remote,
      running: !!this.url,
      starting: !!this.starting && !this.url,
      downloading: !!this.fetching,
      url: this.url,
      lastHeartbeat: this.lastHeartbeat,
      // A tunnel or tool error is not shown while remote access is off.
      error: !this.device?.remote && tunnelError(this.error) ? undefined : this.error,
    };
  }
  /** Sign this PC in to the account; the password is used once and never stored. */
  async link(
    username: string,
    password: string,
    name: string,
    workerOrigin = DEFAULT_SHARING_ORIGIN,
  ) {
    await this.load();
    const origin = new URL(workerOrigin).origin;
    let response: Response;
    try {
      response = await this.fetcher(origin + '/api/hosts/device/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, name }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw failure('SITE_UNREACHABLE');
    }
    if (!response.ok)
      throw failure(response.status === 401 ? 'INVALID_LOGIN' : 'ACCOUNT_LINK_FAILED');
    const reply = z
      .object({ hostId: z.string().uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(await response.json());
    if (this.device) await this.unlink();
    this.closed = false;
    // Signing in does not turn on remote access (ADR-039 3): the user turns it on in Settings.
    await this.save(
      deviceSchema.parse({ workerOrigin: origin, name, username, remote: false, ...reply }),
    );
    // Existing local projects join the account list with their ids.
    for (const project of this.options.projects?.() ?? []) await this.pushProject(project);
    this.beat();
    return this.status();
  }
  async unlink() {
    await this.load();
    const device = this.device;
    await this.stop();
    clearInterval(this.timer);
    this.timer = undefined;
    if (device)
      await this.fetcher(device.workerOrigin + '/api/hosts/device/self', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${device.hostId}.${device.secret}` },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    await unlink(this.file).catch(() => {});
    this.device = undefined;
    this.error = undefined;
    this.lastHeartbeat = undefined;
    return this.status();
  }
  /** Remote access (other devices through the tunnel) on or off; remembered across restarts. */
  async setRemote(enabled: boolean) {
    await this.load();
    if (!this.device) throw failure('ACCOUNT_NOT_LINKED');
    await this.save({ ...this.device, remote: enabled });
    if (enabled) void this.start().catch(() => {});
    else {
      // A tunnel or tool failure means nothing once remote access is off.
      if (tunnelError(this.error)) this.error = undefined;
      await this.stop();
    }
    return this.status();
  }
  /** Start presence reports now and every 15 seconds. */
  private beat() {
    clearInterval(this.timer);
    void this.heartbeat();
    this.timer = setInterval(() => void this.heartbeat(), this.options.heartbeatMs ?? HEARTBEAT_MS);
    this.timer.unref?.();
  }
  async start() {
    await this.load();
    if (!this.device) throw failure('ACCOUNT_NOT_LINKED');
    if (this.tunnel) return this.status();
    return (this.starting ??= this.open().finally(() => (this.starting = undefined)));
  }
  /** cloudflared's path; fetched into `<data>\bin` when this PC has none (ADR-039 2). */
  private async tool() {
    const found = this.options.executable ?? cloudflaredPath(this.options.directory);
    if (found) return found;
    const target = join(this.options.directory, 'bin', 'cloudflared.exe');
    this.fetching ??= (async () => {
      try {
        await (this.options.download ?? downloadCloudflared)(target);
        if (!existsSync(target)) throw failure('CLOUDFLARED_DOWNLOAD_FAILED');
        return target;
      } finally {
        this.fetching = undefined;
      }
    })();
    return this.fetching;
  }
  /**
   * The installed program's first run fetches the tool in the background so turning remote access
   * on later needs no wait. A failure is quiet: turning remote access on fetches again.
   */
  async prefetch() {
    try {
      return !!(await this.tool());
    } catch {
      return false;
    }
  }
  private async open() {
    let executable: string;
    try {
      executable = await this.tool();
    } catch (error) {
      this.error = error instanceof DomainError ? error.code : 'CLOUDFLARED_DOWNLOAD_FAILED';
      throw error instanceof DomainError ? error : failure('CLOUDFLARED_DOWNLOAD_FAILED');
    }
    this.error = undefined;
    const child = (this.options.spawnProcess ?? spawn)(
      executable,
      ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.options.port()}`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.tunnel = child;
    // The address is printed before the edge connection exists; wait for registration too.
    let address: string | undefined;
    const found = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(failure('TUNNEL_START_TIMEOUT')), 45_000);
      const scan = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        address ??= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0];
        if (address && (this.options.spawnProcess || /Registered tunnel connection/.test(text))) {
          clearTimeout(timeout);
          resolve(address);
        }
      };
      child.stdout?.on('data', scan);
      child.stderr?.on('data', scan);
      child.once('exit', () => {
        clearTimeout(timeout);
        reject(failure('TUNNEL_EXITED'));
      });
      // A start that fails (blocked or quarantined file) emits 'error', maybe without 'exit'.
      child.once('error', () => {
        clearTimeout(timeout);
        reject(failure('TUNNEL_START_FAILED'));
      });
    });
    // Without a listener an 'error' would end the engine; this one only ends the tunnel.
    child.on('error', () => {});
    child.once('exit', () => {
      if (this.tunnel !== child) return;
      this.tunnel = undefined;
      this.url = undefined;
      this.error = 'TUNNEL_EXITED';
      void this.heartbeat();
      this.reopenLater();
    });
    try {
      this.url = await found;
      await this.reachable(this.url);
    } catch (error) {
      child.kill();
      this.tunnel = undefined;
      this.url = undefined;
      this.error = error instanceof DomainError ? error.code : 'TUNNEL_START_FAILED';
      throw error;
    }
    await this.heartbeat();
    return this.status();
  }
  /**
   * cloudflared ended on its own (network change, sleep): open a new tunnel. Other devices use the
   * account site's fixed address, so their sessions carry on once the new address is reported.
   */
  private reopenLater(delay = 3000) {
    if (this.closed || this.options.spawnProcess) return;
    clearTimeout(this.reopen);
    this.reopen = setTimeout(() => {
      if (this.closed || this.tunnel || !this.device?.remote) return;
      this.start().catch(() => this.reopenLater(Math.min(delay * 2, 60_000)));
    }, delay);
    this.reopen.unref?.();
  }
  /** A new quick-tunnel name takes a few seconds to resolve; advertise it only once it answers. */
  private async reachable(url: string) {
    if (this.options.spawnProcess) return;
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      try {
        await fetch(url + '/', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    throw failure('TUNNEL_UNREACHABLE');
  }
  /** Stop the tunnel; this PC stays listed (local use) while linked. */
  async stop() {
    clearTimeout(this.reopen);
    const child = this.tunnel;
    this.tunnel = undefined;
    this.url = undefined;
    child?.kill();
    this.sessions.clear();
    if (this.device && this.timer) await this.heartbeat();
  }
  /** App shutdown: report offline and stop everything. */
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    const child = this.tunnel;
    this.tunnel = undefined;
    this.url = undefined;
    child?.kill();
    this.sessions.clear();
    if (this.device) await this.heartbeat(true).catch(() => {});
  }
  private request(path: string, method: string, data?: unknown) {
    const device = this.device!;
    return this.fetcher(device.workerOrigin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${device.hostId}.${device.secret}`,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(10_000),
    });
  }
  async heartbeat(offline = false) {
    await this.load();
    if (!this.device) return;
    try {
      const status = offline ? {} : await this.options.status().catch(() => ({}));
      const response = await this.request('/api/hosts/device/heartbeat', 'POST', {
        offline,
        url: offline ? null : (this.url ?? null),
        local: offline ? null : `http://127.0.0.1:${this.options.port()}`,
        status,
        activity: offline ? {} : (this.options.activity?.() ?? {}),
      });
      if (!response.ok)
        throw failure(response.status === 401 ? 'ACCOUNT_UNLINKED' : 'HEARTBEAT_FAILED');
      const reply = z
        .object({
          projects: cloudProjectsSchema.default([]),
          queue: queuedSchema.catch([]).default([]),
          agendaEdits: z.array(agendaEditSchema).catch([]).default([]),
        })
        .passthrough()
        .parse(await response.json());
      this.lastHeartbeat = new Date().toISOString();
      if (this.error?.startsWith('HEARTBEAT') || this.error === 'ACCOUNT_UNLINKED')
        this.error = undefined;
      if (!offline) {
        this.options.onProjects?.(reply.projects);
        if (reply.queue.length && this.options.onQueue) {
          const kept = await this.options.onQueue(reply.queue);
          if (kept.length)
            await this.request('/api/hosts/device/queue/delivered', 'POST', { ids: kept }).catch(
              () => undefined,
            );
        }
        if (reply.agendaEdits.length && this.options.onAgendaEdits) {
          const results = await this.options.onAgendaEdits(reply.agendaEdits);
          if (results.length)
            await this.request('/api/hosts/device/agenda-edits/applied', 'POST', {
              items: results,
            }).catch(() => undefined);
        }
        this.options.afterHeartbeat?.();
      }
    } catch (error) {
      this.error = error instanceof DomainError ? error.code : 'HEARTBEAT_FAILED';
    }
  }
  /** Add or rename a local project in the account list (keeps its id). */
  async pushProject(project: { id: string; name: string }) {
    await this.load();
    if (!this.device) return;
    try {
      const response = await this.request('/api/hosts/device/projects', 'POST', project);
      if (!response.ok) this.error = 'PROJECT_SYNC_FAILED';
    } catch {
      this.error = 'PROJECT_SYNC_FAILED';
    }
  }
  /**
   * A project deleted on this PC leaves the account list. A site without the route answers 404;
   * the local record of removed ids keeps the project from coming back either way.
   */
  async removeProject(projectId: string) {
    await this.load();
    if (!this.device) return;
    await this.request(`/api/hosts/device/projects/${encodeURIComponent(projectId)}`, 'DELETE')
      .then((response) => {
        if (!response.ok && response.status !== 404) this.error = 'PROJECT_SYNC_FAILED';
      })
      .catch(() => (this.error = 'PROJECT_SYNC_FAILED'));
  }
  /**
   * A call to the site's PC routes with this PC's host key (shared notes, SPEC-10). Undefined when
   * the PC is not linked; a network failure rejects.
   */
  async deviceFetch(path: string, method = 'GET', data?: unknown) {
    await this.load();
    if (!this.device) return undefined;
    return this.request('/api/hosts/device' + path, method, data);
  }
  /** Send a small preview image for the project card on the account site. */
  async pushThumbnail(projectId: string, image: string) {
    await this.load();
    if (!this.device) return false;
    const response = await this.request(
      `/api/hosts/device/projects/${encodeURIComponent(projectId)}/thumbnail`,
      'PUT',
      { image },
    ).catch(() => undefined);
    return !!response?.ok;
  }
  /**
   * Store a linked file's offline view on the account site (PLAN-20). Returns an error code, or
   * undefined when stored.
   */
  async uploadSnapshot(
    projectId: string,
    linkId: string,
    meta: { name: string; host: 'rhino' | 'zwcad'; objects: number; capturedAt: number },
    bytes: Uint8Array,
  ): Promise<string | undefined> {
    await this.load();
    const device = this.device;
    if (!device) return 'ACCOUNT_UNLINKED';
    const query = new URLSearchParams({
      name: meta.name,
      host: meta.host,
      objects: String(meta.objects),
      captured: String(Math.floor(meta.capturedAt)),
    });
    try {
      const response = await this.fetcher(
        `${device.workerOrigin}/api/hosts/device/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(linkId)}?${query}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(bytes.byteLength),
            Authorization: `Bearer ${device.hostId}.${device.secret}`,
          },
          body: bytes,
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (response.ok) return undefined;
      const reply = (await response.json().catch(() => ({}))) as { error?: unknown };
      return typeof reply.error === 'string' ? reply.error : 'SNAPSHOT_UPLOAD_FAILED';
    } catch {
      return 'SNAPSHOT_UPLOAD_FAILED';
    }
  }
  /**
   * Replace the project's 할 일 copy or work history summary on the account site (PLAN-33).
   * Returns an error code, or undefined when stored.
   */
  async uploadSummary(
    projectId: string,
    part: 'agenda' | 'history',
    items: unknown[],
  ): Promise<string | undefined> {
    await this.load();
    if (!this.device) return 'ACCOUNT_UNLINKED';
    try {
      const response = await this.request(
        `/api/hosts/device/projects/${encodeURIComponent(projectId)}/${part}`,
        'PUT',
        { items },
      );
      if (response.ok) return undefined;
      const reply = (await response.json().catch(() => ({}))) as { error?: unknown };
      return typeof reply.error === 'string' ? reply.error : 'SUMMARY_UPLOAD_FAILED';
    } catch {
      return 'SUMMARY_UPLOAD_FAILED';
    }
  }
  /** Remove the project's 할 일 copy and history summary from the site (sharing turned off). */
  async deleteSummary(projectId: string) {
    await this.load();
    if (!this.device) return false;
    const response = await this.request(
      `/api/hosts/device/projects/${encodeURIComponent(projectId)}/summary`,
      'DELETE',
    ).catch(() => undefined);
    return !!response?.ok;
  }
  async deleteSnapshot(projectId: string, linkId: string) {
    await this.load();
    if (!this.device) return false;
    const response = await this.request(
      `/api/hosts/device/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(linkId)}`,
      'DELETE',
    ).catch(() => undefined);
    return !!response?.ok;
  }
  /** Verify a site-signed one-time token (HMAC with this host's key, one minute, single use). */
  async verify(token: unknown) {
    await this.load();
    const device = this.device;
    if (!device || typeof token !== 'string' || token.length > 400) throw failure('UNAUTHORIZED');
    const [payload, signature] = token.split('.');
    const expected = createHmac('sha256', device.secret)
      .update(payload ?? '')
      .digest();
    const given = Buffer.from(signature ?? '', 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw failure('UNAUTHORIZED');
    let parsed: z.infer<typeof tokenSchema>;
    try {
      parsed = tokenSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    } catch {
      throw failure('UNAUTHORIZED');
    }
    const now = Date.now();
    for (const [nonce, expiry] of this.used) if (expiry < now) this.used.delete(nonce);
    if (
      parsed.h !== device.hostId ||
      parsed.e < now ||
      parsed.e > now + 120_000 ||
      this.used.has(parsed.n)
    )
      throw failure('UNAUTHORIZED');
    this.used.set(parsed.n, parsed.e);
  }
  /** Verify a token and open a remote (tunnel) session; returns its id. */
  async login(token: unknown) {
    if (!this.tunnel) throw failure('UNAUTHORIZED');
    await this.verify(token);
    const session = randomBytes(32).toString('hex');
    this.sessions.set(session, Date.now() + SESSION_MS);
    return session;
  }
  /** A remote browser session is valid only while the tunnel that issued it is running. */
  authorized(session: string | undefined) {
    if (!session || !this.tunnel) return false;
    const expiry = this.sessions.get(session);
    if (!expiry || expiry < Date.now()) {
      if (expiry) this.sessions.delete(session);
      return false;
    }
    return true;
  }
}
