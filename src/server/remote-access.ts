import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';

// Remote access from other devices (e.g. an iPad): a Cloudflare quick tunnel exposes this local
// server, and the sharing Worker lists it to the paired owner. Remote browsers get a session only
// from a one-minute token the Worker signs with this host's key; nothing else is trusted.
export const DEFAULT_SHARING_ORIGIN = 'https://vide-sharing-staging.archivibe.workers.dev';
const HEARTBEAT_MS = 15_000;
const SESSION_MS = 12 * 60 * 60_000;

const deviceSchema = z.object({
  workerOrigin: z.string().url(),
  hostId: z.string().uuid(),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(80),
});
type Device = z.infer<typeof deviceSchema>;
const tokenSchema = z.object({
  h: z.string(),
  n: z.string().regex(/^[a-f0-9]{32}$/),
  e: z.number(),
});
const failure = (code: string) => new DomainError(code);

export interface RemoteStatus {
  paired: boolean;
  name?: string;
  workerOrigin?: string;
  running: boolean;
  url?: string;
  lastHeartbeat?: string;
  error?: string;
}
interface Options {
  directory: string;
  port: () => number;
  /** Advisory summary shown in the host list (connected documents). */
  status: () => Promise<Record<string, unknown>>;
  executable?: string;
  fetcher?: typeof fetch;
  spawnProcess?: typeof spawn;
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
  private url: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastHeartbeat: string | undefined;
  private error: string | undefined;
  private used = new Map<string, number>();
  private sessions = new Map<string, number>();
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
  private get fetcher() {
    return this.options.fetcher ?? fetch;
  }
  /** Public hostname of the running tunnel (requests with this Host are remote). */
  get host() {
    return this.url ? new URL(this.url).host : undefined;
  }
  async status(): Promise<RemoteStatus> {
    await this.load();
    return {
      paired: !!this.device,
      name: this.device?.name,
      workerOrigin: this.device?.workerOrigin,
      running: !!this.tunnel,
      url: this.url,
      lastHeartbeat: this.lastHeartbeat,
      error: this.error,
    };
  }
  async pair(code: string, name: string, workerOrigin = DEFAULT_SHARING_ORIGIN) {
    const origin = new URL(workerOrigin).origin;
    const response = await this.fetcher(origin + '/api/hosts/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw failure(response.status === 404 ? 'PAIRING_NOT_FOUND' : 'PAIRING_FAILED');
    const reply = z
      .object({ hostId: z.string().uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(await response.json());
    const device = deviceSchema.parse({ workerOrigin: origin, name, ...reply });
    await writeFile(this.file + '.tmp', JSON.stringify(device), { mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
    this.device = device;
    this.loaded = Promise.resolve();
    return this.status();
  }
  async unpair() {
    await this.stop();
    await unlink(this.file).catch(() => {});
    this.device = undefined;
  }
  async start() {
    await this.load();
    if (!this.device) throw failure('REMOTE_NOT_PAIRED');
    if (this.tunnel) return this.status();
    const executable = this.options.executable ?? cloudflaredPath(this.options.directory);
    if (!executable) throw failure('CLOUDFLARED_MISSING');
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
      clearInterval(this.timer);
    });
    try {
      this.url = await found;
      await this.reachable(this.url);
    } catch (error) {
      child.kill();
      this.tunnel = undefined;
      this.error = error instanceof DomainError ? error.code : 'TUNNEL_START_FAILED';
      throw error;
    }
    await this.heartbeat();
    this.timer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    return this.status();
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
  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    const child = this.tunnel;
    this.tunnel = undefined;
    this.url = undefined;
    if (this.device) await this.heartbeat(true).catch(() => {});
    child?.kill();
    this.sessions.clear();
  }
  private async heartbeat(offline = false) {
    const device = this.device;
    if (!device) return;
    try {
      const status = offline ? {} : await this.options.status().catch(() => ({}));
      const response = await this.fetcher(device.workerOrigin + '/api/hosts/heartbeat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${device.hostId}.${device.secret}`,
        },
        body: JSON.stringify({ url: offline ? null : (this.url ?? null), status }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw failure(response.status === 401 ? 'REMOTE_UNPAIRED' : 'HEARTBEAT_FAILED');
      this.lastHeartbeat = new Date().toISOString();
      if (this.error?.startsWith('HEARTBEAT') || this.error === 'REMOTE_UNPAIRED')
        this.error = undefined;
    } catch (error) {
      this.error = error instanceof DomainError ? error.code : 'HEARTBEAT_FAILED';
    }
  }
  /** Verify a Worker-signed one-time token and open a remote session (returns its id). */
  async login(token: unknown) {
    await this.load();
    const device = this.device;
    if (!device || !this.tunnel || typeof token !== 'string' || token.length > 400)
      throw failure('UNAUTHORIZED');
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
    const session = randomBytes(32).toString('hex');
    this.sessions.set(session, now + SESSION_MS);
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
