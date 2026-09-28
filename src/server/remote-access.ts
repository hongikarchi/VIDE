import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';

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
const failure = (code: string) => new DomainError(code);

export interface RemoteStatus {
  linked: boolean;
  username?: string;
  name?: string;
  site?: string;
  remote: boolean;
  running: boolean;
  starting: boolean;
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
  executable?: string;
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
  return undefined;
}

export class RemoteAccess {
  private device: Device | undefined;
  private loaded: Promise<void> | undefined;
  private tunnel: ChildProcess | undefined;
  private starting: Promise<RemoteStatus> | undefined;
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
      url: this.url,
      lastHeartbeat: this.lastHeartbeat,
      error: this.error,
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
    await this.save(
      deviceSchema.parse({ workerOrigin: origin, name, username, remote: true, ...reply }),
    );
    // Existing local projects join the account list with their ids.
    for (const project of this.options.projects?.() ?? []) await this.pushProject(project);
    this.beat();
    void this.start().catch(() => {});
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
    else await this.stop();
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
  private async open() {
    const executable = this.options.executable ?? cloudflaredPath(this.options.directory);
    if (!executable) {
      this.error = 'CLOUDFLARED_MISSING';
      throw failure('CLOUDFLARED_MISSING');
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
    });
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
        .object({ projects: cloudProjectsSchema.default([]) })
        .passthrough()
        .parse(await response.json());
      this.lastHeartbeat = new Date().toISOString();
      if (this.error?.startsWith('HEARTBEAT') || this.error === 'ACCOUNT_UNLINKED')
        this.error = undefined;
      if (!offline) this.options.onProjects?.(reply.projects);
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
