import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Provider } from '../contracts/ai-settings.ts';

// The current account of each CLI's own (default) login and its usage (ADR-025, PLAN-25): VIDE
// runs every request on that login and only reads who it is. Adding, signing in and switching
// accounts is done in AccountSwitch (or the CLI itself); VIDE never writes the login files.
// Usage lookup (cswap-style, chosen by the user on 2026-09-29 despite the provider-terms risk) is
// opt-in: only with it on is the login's token sent to the provider's usage endpoint. Tokens are
// never refreshed or rewritten here (the CLI owns that), never logged or returned.
const CLAUDE_USAGE = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE = 'https://chatgpt.com/backend-api/wham/usage';
/** Claude's usage endpoint allows about 30 calls an hour per account. */
const MIN_INTERVAL_MS = 3 * 60_000;
const FORCED_INTERVAL_MS = 60_000;

export interface UsageWindow {
  percent: number;
  resetsAt: string | null;
}
/** Who the default login of one service is, from the CLI's own files (no network). */
export interface AccountIdentity {
  provider: Provider;
  signedIn: boolean;
  email?: string;
  plan?: string;
}
export interface AccountUsage extends AccountIdentity {
  /** Claude: 5-hour window; Codex: its shorter window when it has one. */
  session?: UsageWindow;
  /** 7-day window. */
  weekly?: UsageWindow;
  limitReached: boolean;
  /** Set when a request failed on this account's limit (until the reset time, or an hour). */
  limitedUntil?: string;
  checkedAt?: string;
  state: 'ok' | 'off' | 'signed-out' | 'token-expired' | 'error';
  error?: string;
}
// Older files also hold `autoSwitch` and `threshold` (in-VIDE switching, removed): ignored.
const settingsSchema = z.object({ usageLookup: z.boolean().default(false) });
export type UsageSettings = z.infer<typeof settingsSchema>;
export const PROVIDERS = ['claude-cli', 'codex-cli'] as const satisfies readonly Provider[];

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};
const jwtPayload = (token: string | undefined) => {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
};
const iso = (value: unknown) =>
  typeof value === 'number'
    ? new Date(value * 1000).toISOString()
    : typeof value === 'string' && value
      ? new Date(value).toISOString()
      : null;

/**
 * The files of a service's default login: `~/.claude…`, `~/.codex/auth.json`, or the folder the PC
 * names in CLAUDE_CONFIG_DIR / CODEX_HOME (the CLI then keeps `.claude.json` inside it too).
 */
export function loginFiles(
  provider: Provider,
  home = homedir(),
  env: Record<string, string | undefined> = process.env,
) {
  if (provider === 'claude-cli') {
    const folder = env.CLAUDE_CONFIG_DIR;
    return {
      credentials: join(folder || join(home, '.claude'), '.credentials.json'),
      account: folder ? join(folder, '.claude.json') : join(home, '.claude.json'),
    };
  }
  return { credentials: join(env.CODEX_HOME || join(home, '.codex'), 'auth.json'), account: '' };
}

/** The default login of one service as its CLI keeps it (`loginFiles`). */
export function defaultLogin(
  provider: Provider,
  home = homedir(),
  env: Record<string, string | undefined> = process.env,
) {
  const files = loginFiles(provider, home, env);
  if (provider === 'claude-cli') {
    const credentials = z
      .object({
        claudeAiOauth: z
          .object({
            accessToken: z.string(),
            expiresAt: z.number().optional(),
            subscriptionType: z.string().optional(),
          })
          .passthrough(),
      })
      .passthrough()
      .safeParse(readJson(files.credentials)).data?.claudeAiOauth;
    const account = z
      .object({ oauthAccount: z.object({ emailAddress: z.string() }).passthrough() })
      .passthrough()
      .safeParse(readJson(files.account)).data?.oauthAccount;
    return {
      token: credentials?.accessToken,
      account: undefined as string | undefined,
      expiresAt: credentials?.expiresAt,
      email: account?.emailAddress,
      plan: credentials?.subscriptionType,
    };
  }
  const tokens = z
    .object({
      tokens: z
        .object({ access_token: z.string(), account_id: z.string(), id_token: z.string() })
        .passthrough(),
    })
    .passthrough()
    .safeParse(readJson(files.credentials)).data?.tokens;
  const claims = jwtPayload(tokens?.id_token);
  const access = jwtPayload(tokens?.access_token);
  return {
    token: tokens?.access_token,
    account: tokens?.account_id,
    expiresAt: typeof access?.exp === 'number' ? access.exp * 1000 : undefined,
    email: typeof claims?.email === 'string' ? claims.email : undefined,
    plan: claims?.['https://api.openai.com/auth']?.chatgpt_plan_type as string | undefined,
  };
}

interface Options {
  /** Settings file; none keeps the settings in memory (an in-memory engine, tests). */
  file?: string;
  /** Read when `file` does not exist yet: the earlier place, next to VIDE's own account profiles. */
  legacyFile?: string;
  home?: string;
  fetch?: typeof fetch;
  now?: () => number;
}
export class AccountUsageService {
  private options: Required<Pick<Options, 'home' | 'fetch' | 'now'>> & Options;
  private cache = new Map<string, AccountUsage & { fetchedAt?: number }>();
  private pending = new Map<string, Promise<AccountUsage>>();
  private memory: UsageSettings | undefined;
  constructor(options: Options = {}) {
    this.options = { home: homedir(), fetch: globalThis.fetch, now: Date.now, ...options };
  }
  settings(): UsageSettings {
    const { file, legacyFile } = this.options;
    if (!file) return this.memory ?? settingsSchema.parse({});
    return settingsSchema.parse(
      readJson(file) ?? (legacyFile ? readJson(legacyFile) : undefined) ?? {},
    );
  }
  setSettings(next: Partial<UsageSettings>) {
    const value = settingsSchema.parse({ ...this.settings(), ...next });
    const file = this.options.file;
    if (!file) return (this.memory = value);
    mkdirSync(dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
    return value;
  }
  /** Who the default login of a service is; no network. */
  account(provider: Provider): AccountIdentity {
    const login = defaultLogin(provider, this.options.home);
    return {
      provider,
      signedIn: !!login.token,
      ...(login.email ? { email: login.email } : {}),
      ...(login.plan ? { plan: login.plan } : {}),
    };
  }
  /**
   * The cache key: the service and who is signed in, so an account changed in AccountSwitch never
   * shows the previous account's usage or limit.
   */
  private key(provider: Provider, login: ReturnType<typeof defaultLogin>) {
    return [provider, login.account ?? '', login.email ?? ''].join('\0');
  }
  /** Current usage of a service's login; network only when lookup is on and the cache is stale. */
  async get(provider: Provider, force = false): Promise<AccountUsage> {
    const login = defaultLogin(provider, this.options.home);
    const key = this.key(provider, login);
    const cached = this.cache.get(key);
    const base = {
      ...this.account(provider),
      limitedUntil:
        cached?.limitedUntil && Date.parse(cached.limitedUntil) > this.options.now()
          ? cached.limitedUntil
          : undefined,
    };
    if (!login.token) return this.store(key, { ...base, limitReached: false, state: 'signed-out' });
    if (!this.settings().usageLookup)
      return this.store(key, { ...base, limitReached: !!base.limitedUntil, state: 'off' });
    const age = cached?.fetchedAt ? this.options.now() - cached.fetchedAt : Infinity;
    if (cached?.fetchedAt && age < (force ? FORCED_INTERVAL_MS : MIN_INTERVAL_MS))
      return this.visible({
        ...cached,
        ...base,
        limitReached: cached.limitReached || !!base.limitedUntil,
      });
    // The CLI refreshes its own token on its next run; an expired one is never refreshed here.
    if (login.expiresAt && login.expiresAt < this.options.now())
      return this.store(key, {
        ...(cached ?? {}),
        ...base,
        limitReached: cached?.limitReached ?? false,
        state: 'token-expired',
      });
    let running = this.pending.get(key);
    if (!running) {
      running = this.fetchUsage(provider, login)
        .then((usage) =>
          this.store(key, {
            ...base,
            ...usage,
            state: 'ok' as const,
            fetchedAt: this.options.now(),
          }),
        )
        .catch((error: Error) =>
          this.store(key, {
            ...(cached ?? {}),
            ...base,
            limitReached: cached?.limitReached ?? false,
            state: 'error' as const,
            error: error.message,
            fetchedAt: this.options.now(),
          }),
        )
        .finally(() => this.pending.delete(key));
      this.pending.set(key, running);
    }
    return running;
  }
  private visible(value: AccountUsage & { fetchedAt?: number }): AccountUsage {
    const { fetchedAt: _fetchedAt, ...rest } = value;
    return rest;
  }
  private store(key: string, value: AccountUsage & { fetchedAt?: number }) {
    this.cache.set(key, value);
    return this.visible(value);
  }
  private async fetchUsage(
    provider: Provider,
    login: ReturnType<typeof defaultLogin>,
  ): Promise<
    Pick<AccountUsage, 'session' | 'weekly' | 'limitReached' | 'checkedAt' | 'email' | 'plan'>
  > {
    const checkedAt = new Date(this.options.now()).toISOString();
    if (provider === 'claude-cli') {
      const response = await this.options.fetch(CLAUDE_USAGE, {
        headers: {
          Authorization: 'Bearer ' + login.token,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw Error('HTTP_' + response.status);
      const window = z
        .object({ utilization: z.number(), resets_at: z.string().nullish() })
        .nullish();
      const body = z
        .object({ five_hour: window, seven_day: window })
        .passthrough()
        .parse(await response.json());
      const view = (value: z.infer<typeof window>) =>
        value ? { percent: value.utilization, resetsAt: iso(value.resets_at) } : undefined;
      const session = view(body.five_hour),
        weekly = view(body.seven_day);
      return {
        session,
        weekly,
        limitReached: [session, weekly].some((w) => (w?.percent ?? 0) >= 100),
        checkedAt,
      };
    }
    const response = await this.options.fetch(CODEX_USAGE, {
      headers: {
        Authorization: 'Bearer ' + login.token,
        'ChatGPT-Account-Id': String(login.account ?? ''),
        'User-Agent': 'codex_cli_rs',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw Error('HTTP_' + response.status);
    const window = z
      .object({
        used_percent: z.number(),
        limit_window_seconds: z.number().optional(),
        reset_at: z.number().nullish(),
      })
      .nullish();
    const body = z
      .object({
        email: z.string().optional(),
        plan_type: z.string().optional(),
        rate_limit: z
          .object({
            limit_reached: z.boolean().optional(),
            primary_window: window,
            secondary_window: window,
          })
          .nullish(),
      })
      .passthrough()
      .parse(await response.json());
    const windows = [body.rate_limit?.primary_window, body.rate_limit?.secondary_window].filter(
      (value): value is NonNullable<z.infer<typeof window>> => !!value,
    );
    const view = (value?: z.infer<typeof window>) =>
      value ? { percent: value.used_percent, resetsAt: iso(value.reset_at) } : undefined;
    // Codex reports one or two windows; the one of a week or longer is the weekly limit.
    const weekly = windows.find((w) => (w.limit_window_seconds ?? 0) >= 6 * 86400);
    const session = windows.find((w) => w !== weekly);
    return {
      session: view(session),
      weekly: view(weekly),
      limitReached: !!body.rate_limit?.limit_reached,
      checkedAt,
      email: body.email ?? login.email,
      plan: body.plan_type ?? login.plan,
    };
  }
  /** Both services' default logins. */
  async all(force = false) {
    return Promise.all(PROVIDERS.map((provider) => this.get(provider, force)));
  }
  /**
   * A request failed on this login's limit: shown as limited until its reset (or for an hour).
   * Nothing is sent again by itself; the user changes the account in AccountSwitch.
   */
  markLimited(provider: Provider) {
    const login = defaultLogin(provider, this.options.home);
    const key = this.key(provider, login);
    const cached = this.cache.get(key);
    const resets = [cached?.session, cached?.weekly]
      .filter((w) => w && w.percent >= 90 && w.resetsAt)
      .map((w) => Date.parse(w!.resetsAt!));
    const until = resets.length ? Math.max(...resets) : this.options.now() + 3600_000;
    this.cache.set(key, {
      ...(cached ?? { ...this.account(provider), state: 'ok' as const }),
      limitReached: true,
      limitedUntil: new Date(until).toISOString(),
    });
  }
}
