import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../core/store.ts';
import type { Provider } from '../contracts/ai-settings.ts';
import { subscriptionEnvironment, killOwnedProcess } from './claude-cli.ts';
import { codexEnvironment } from './codex-cli.ts';

type State = 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled';
export interface LoginStatus {
  id: string;
  provider: Provider;
  profileId: string;
  state: State;
  startedAt: string;
  operation: 'login' | 'logout';
  reason?: string;
}
interface Job {
  status: LoginStatus;
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  stopped?: 'LOGIN_CANCELLED' | 'LOGIN_TIMEOUT';
}
interface Options {
  spawnProcess?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
  kill?: (child: ChildProcess) => Promise<boolean>;
  timeoutMs?: number;
}
/** Owns only login processes started by VIDE. Raw CLI output never crosses this boundary. */
export class AccountLogin {
  private jobs = new Map<Provider, Job>();
  private options: Options;
  constructor(options: Options = {}) {
    this.options = options;
  }
  busy(provider: Provider) {
    const state = this.jobs.get(provider)?.status.state;
    return state === 'running' || state === 'stopping';
  }
  list() {
    return [...this.jobs.values()].map((job) => ({ ...job.status }));
  }
  start(input: {
    provider: Provider;
    profileId: string;
    directory: string;
    executable: string;
    verify: () => Promise<{ available: boolean; reason?: string }>;
    operation?: 'login' | 'logout';
  }) {
    if (this.busy(input.provider)) throw new DomainError('PROFILE_LOGIN_IN_PROGRESS');
    const codex = input.provider === 'codex-cli';
    const logout = input.operation === 'logout';
    const env = codex ? codexEnvironment() : subscriptionEnvironment();
    env[codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = input.directory;
    const child = (this.options.spawnProcess ?? spawn)(
      input.executable,
      codex
        ? [
            logout ? 'logout' : 'login',
            '-c',
            'cli_auth_credentials_store="file"',
            '-c',
            'forced_login_method="chatgpt"',
          ]
        : logout
          ? ['auth', 'logout']
          : ['auth', 'login', '--claudeai'],
      { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // Consume without buffering, forwarding or persisting authentication URLs / secrets.
    child.stdout?.resume();
    child.stderr?.resume();
    let resolve!: () => void;
    const done = new Promise<void>((finish) => {
      resolve = finish;
    });
    const job: Job = {
      status: {
        id: randomUUID(),
        provider: input.provider,
        profileId: input.profileId,
        state: 'running',
        startedAt: new Date().toISOString(),
        operation: input.operation ?? 'login',
      },
      child,
      done,
      timer: setTimeout(
        () => this.stop(input.provider, 'LOGIN_TIMEOUT'),
        this.options.timeoutMs ?? 300000,
      ),
    };
    this.jobs.set(input.provider, job);
    let finishing = false;
    const finish = async (code: number | null) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(job.timer);
      let authenticated = false;
      if (code === 0 && !job.stopped) {
        try {
          const status = await input.verify();
          authenticated = logout
            ? !status.available && status.reason === 'SUBSCRIPTION_LOGIN_REQUIRED'
            : status.available;
        } catch {
          authenticated = false;
        }
      }
      job.status.state = job.stopped
        ? job.stopped === 'LOGIN_CANCELLED'
          ? 'cancelled'
          : 'failed'
        : authenticated
          ? 'succeeded'
          : 'failed';
      job.status.reason = job.stopped ?? (authenticated ? undefined : 'LOGIN_FAILED');
      resolve();
    };
    child.once('error', () => {
      void finish(null);
    });
    child.once('close', (code) => {
      void finish(code);
    });
    return { ...job.status };
  }
  private stop(provider: Provider, reason: 'LOGIN_CANCELLED' | 'LOGIN_TIMEOUT') {
    const job = this.jobs.get(provider);
    if (!job || !this.busy(provider)) return;
    job.stopped ??= reason;
    job.status.state = 'stopping';
    clearTimeout(job.timer);
    void (this.options.kill ?? killOwnedProcess)(job.child).catch(() => false);
  }
  cancel(provider: Provider) {
    this.stop(provider, 'LOGIN_CANCELLED');
    return this.list();
  }
  async close() {
    const active = [...this.jobs.values()].filter((job) => this.busy(job.status.provider));
    for (const job of active) this.stop(job.status.provider, 'LOGIN_CANCELLED');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(active.map((job) => job.done)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('LOGIN_TERMINATION_UNCONFIRMED')), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
