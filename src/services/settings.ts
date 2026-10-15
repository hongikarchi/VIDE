import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../contracts/errors.ts';
import {
  CLAWDE_FEATURES,
  serviceSettingsUpdateSchema,
  type AccountService,
  type AccountStatus,
  type ClawdeFeature,
  type ClawdeFeatures,
  type ServiceSettingsUpdate,
  type ServiceSettingsView,
  type ServiceStatus,
  type ServiceToken,
} from '../contracts/services.ts';
import { SecretStore } from './secrets.ts';
import {
  accountApis,
  checkCloudflare,
  checkGithub,
  githubScopesEnough,
  type AccountApis,
} from './account-services.ts';

/**
 * External service settings (SPEC-13.11, ARCH-01 「cLAWde 연결 계약」 설정·비밀·토큰 받기, PLAN-46
 * T-217): `<data>/service-settings.json` holds the address, the on/off switch, the projects that
 * send nothing, where the token came from and the last `meta` result. The token is in the sealed
 * secret store (secrets.ts) and never in this file or the view.
 */

/** Gets a short-lived service token for this PC's VIDE account from the account site. */
export interface AccountTokens {
  /** Whether this PC is signed in to the VIDE account. */
  linked(): Promise<boolean>;
  /** Rejects with a DomainError: ACCOUNT_NOT_LINKED, SITE_UNREACHABLE, SERVICE_TOKEN_UNAVAILABLE. */
  token(service: 'clawde'): Promise<ServiceToken>;
}

export const serviceSettingsStatuses: Record<string, number> = {
  ACCOUNT_NOT_LINKED: 409,
  SITE_UNREACHABLE: 503,
  SERVICE_TOKEN_UNAVAILABLE: 503,
  SERVICE_NOT_CONNECTED: 409,
  SERVICE_AUTH: 401,
  SERVICE_UNAVAILABLE: 503,
  SERVICE_BAD_RESPONSE: 502,
  SERVICE_NOT_IMPLEMENTED: 409,
  SERVICE_NOT_READY: 503,
  SECRETS_UNAVAILABLE: 500,
  // The user's own accounts (SPEC-05.11).
  ACCOUNT_NOT_CONNECTED: 409,
  ACCOUNT_SCOPE: 403,
  SERVICE_UNREACHABLE: 502,
};

const storedSchema = z.object({
  services: z.object({
    clawde: z.object({
      baseUrl: z.string().nullable().default(null),
      enabled: z.boolean().default(false),
      projectsOff: z.array(z.string()).default([]),
      tokenSource: z.enum(['static', 'account']).nullable().default(null),
      tokenExpiresAt: z.string().nullable().default(null),
      lawDbDate: z.string().nullable().default(null),
      checkedAt: z.string().nullable().default(null),
      /** The last `meta`'s `endpoints`·`plannedEndpoints` (null: the service did not say). */
      endpoints: z.array(z.string()).nullable().default(null),
      plannedEndpoints: z.array(z.string()).nullable().default(null),
    }),
    /** The user's own accounts (SPEC-05.11, ARCH-01): no secret here; the tokens are sealed. */
    github: z
      .object({
        enabled: z.boolean().default(false),
        login: z.string().nullable().default(null),
        scopes: z.array(z.string()).default([]),
        scopesChecked: z.boolean().default(false),
        rejected: z.boolean().default(false),
        checkedAt: z.string().nullable().default(null),
        status: z.enum(['connected', 'scope-missing', 'unreachable']).nullable().default(null),
      })
      .prefault({}),
    cloudflare: z
      .object({
        enabled: z.boolean().default(false),
        accountId: z.string().nullable().default(null),
        accountName: z.string().nullable().default(null),
        rejected: z.boolean().default(false),
        checkedAt: z.string().nullable().default(null),
        status: z.enum(['connected', 'scope-missing', 'unreachable']).nullable().default(null),
      })
      .prefault({}),
  }),
});
type Stored = z.infer<typeof storedSchema>;
const empty = (): Stored => storedSchema.parse({ services: { clawde: {} } });
const ACCOUNT_SECRET: Record<AccountService, string> = {
  github: 'github.token',
  cloudflare: 'cloudflare.token',
};

const TOKEN_SECRET = 'clawde.token';
/** An account token is renewed this long before it expires. */
const RENEW_BEFORE_MS = 60_000;

export class ServiceSettings {
  private readonly file: string | undefined;
  private readonly secrets: SecretStore;
  private readonly account: AccountTokens | undefined;
  private readonly now: () => Date;
  private stored: Stored = empty();
  private loaded: Promise<void> | undefined;
  /** The last call's outcome; not kept across restarts ('unchecked' until the first call). */
  private lastStatus: 'connected' | 'unreachable' | 'login-required' | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private renewing: Promise<string> | undefined;
  /** Endpoint names that answered 501 since the last `meta` (not kept across restarts). */
  private readonly notImplemented = new Set<string>();
  /** The last call found the service not ready (503 NO_PUBLICATION·PUBLISHING). */
  private lastNotReady = false;
  private readonly apis: AccountApis;
  constructor({
    directory,
    secrets,
    account,
    now = () => new Date(),
    apis,
  }: {
    directory: string | undefined;
    secrets: SecretStore;
    account?: AccountTokens;
    now?: () => Date;
    /** The user's account APIs (test seams; default env `VIDE_GITHUB_API`… or the real ones). */
    apis?: { githubApi?: string; cloudflareApi?: string; timeoutMs?: number };
  }) {
    this.file = directory === undefined ? undefined : join(directory, 'service-settings.json');
    this.secrets = secrets;
    this.account = account;
    this.now = now;
    this.apis = accountApis(apis);
  }
  private load() {
    return (this.loaded ??= (async () => {
      if (!this.file) return;
      try {
        this.stored = storedSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
      } catch {
        this.stored = empty();
      }
    })());
  }
  private save(change: (clawde: Stored['services']['clawde']) => void) {
    return this.saveAll((services) => change(services.clawde));
  }
  private saveAll(change: (services: Stored['services']) => void) {
    const run = this.queue.then(async () => {
      await this.load();
      const next = structuredClone(this.stored);
      change(next.services);
      if (this.file) {
        await mkdir(join(this.file, '..'), { recursive: true });
        await writeFile(this.file + '.tmp', JSON.stringify(next, null, 2));
        await rename(this.file + '.tmp', this.file);
      }
      this.stored = next;
    });
    this.queue = run.catch(() => {});
    return run;
  }
  private get clawde() {
    return this.stored.services.clawde;
  }
  async view(): Promise<ServiceSettingsView> {
    await this.load();
    const c = this.clawde;
    const tokenSet = !!(await this.secrets.get(TOKEN_SECRET));
    let status: ServiceStatus;
    if (!c.baseUrl || !tokenSet) status = 'not-configured';
    else if (!c.enabled) status = 'off';
    else status = this.lastStatus ?? 'unchecked';
    return {
      clawde: {
        baseUrl: c.baseUrl,
        enabled: c.enabled,
        projectsOff: c.projectsOff,
        token: {
          set: tokenSet,
          source: tokenSet ? c.tokenSource : null,
          expiresAt: tokenSet && c.tokenSource === 'account' ? c.tokenExpiresAt : null,
        },
        status,
        lawDbDate: c.lawDbDate,
        checkedAt: c.checkedAt,
        accountLinked: (await this.account?.linked().catch(() => false)) ?? false,
        features: this.features(),
        ...(this.lastNotReady ? { notReady: true } : {}),
      },
      ...(await this.accountsView()),
    };
  }
  private async accountsView() {
    const { github: g, cloudflare: f } = this.stored.services;
    const githubSet = !!(await this.secrets.get(ACCOUNT_SECRET.github));
    const cloudflareSet = !!(await this.secrets.get(ACCOUNT_SECRET.cloudflare));
    const status = (set: boolean, enabled: boolean, stored: AccountStatus | null): AccountStatus =>
      !set ? 'not-configured' : !enabled ? 'off' : (stored ?? 'unchecked');
    return {
      github: {
        enabled: g.enabled,
        login: g.login,
        scopes: g.scopes,
        scopesChecked: g.scopesChecked,
        rejected: g.rejected,
        token: { set: githubSet, checkedAt: githubSet ? g.checkedAt : null },
        status: status(githubSet, g.enabled, g.status),
        checkedAt: g.checkedAt,
      },
      cloudflare: {
        enabled: f.enabled,
        accountId: f.accountId,
        accountName: f.accountName,
        rejected: f.rejected,
        token: { set: cloudflareSet, checkedAt: cloudflareSet ? f.checkedAt : null },
        status: status(cloudflareSet && !!f.accountId, f.enabled, f.status),
        checkedAt: f.checkedAt,
      },
    };
  }
  /** `PUT /api/v1/settings/services`. A static token replaces any account token. */
  async update(input: unknown) {
    const { clawde, github, cloudflare } = serviceSettingsUpdateSchema.parse(input);
    if (github) await this.updateGithub(github);
    if (cloudflare) await this.updateCloudflare(cloudflare);
    if (clawde) await this.updateClawde(clawde);
    return this.view();
  }
  private async updateClawde(clawde: NonNullable<ServiceSettingsUpdate['clawde']>) {
    if (clawde.token !== undefined) {
      await this.secrets.set(TOKEN_SECRET, clawde.token ?? undefined);
      this.lastStatus = undefined;
    }
    await this.save((c) => {
      if (clawde.baseUrl !== undefined) {
        const next = clawde.baseUrl && new URL(clawde.baseUrl).href.replace(/\/+$/, '');
        if (next !== c.baseUrl) {
          this.lastStatus = undefined;
          this.forgetEndpoints(c);
        }
        c.baseUrl = next;
      }
      if (clawde.enabled !== undefined) c.enabled = clawde.enabled;
      if (clawde.projectsOff !== undefined) c.projectsOff = [...new Set(clawde.projectsOff)];
      if (clawde.token !== undefined) {
        c.tokenSource = clawde.token === null ? null : 'static';
        c.tokenExpiresAt = null;
      }
      // Saving a token with an address turns the service on, as [연결] does.
      if (clawde.token && clawde.enabled === undefined) c.enabled = true;
    });
  }
  /** A new token (or none) forgets the last check; saving one turns the account on. */
  private async updateGithub(github: NonNullable<ServiceSettingsUpdate['github']>) {
    if (github.token !== undefined)
      await this.secrets.set(ACCOUNT_SECRET.github, github.token ?? undefined);
    await this.saveAll(({ github: g }) => {
      if (github.token !== undefined) {
        Object.assign(g, {
          login: null,
          scopes: [],
          scopesChecked: false,
          rejected: false,
          checkedAt: null,
          status: null,
        });
        g.enabled = github.token !== null;
      }
      if (github.enabled !== undefined) g.enabled = github.enabled;
    });
  }
  private async updateCloudflare(cloudflare: NonNullable<ServiceSettingsUpdate['cloudflare']>) {
    if (cloudflare.token !== undefined)
      await this.secrets.set(ACCOUNT_SECRET.cloudflare, cloudflare.token ?? undefined);
    await this.saveAll(({ cloudflare: f }) => {
      const nextId =
        cloudflare.accountId === undefined
          ? f.accountId
          : (cloudflare.accountId?.toLowerCase() ?? null);
      if (cloudflare.token !== undefined || nextId !== f.accountId)
        Object.assign(f, { accountName: null, rejected: false, checkedAt: null, status: null });
      f.accountId = nextId;
      if (cloudflare.token !== undefined) f.enabled = cloudflare.token !== null;
      if (cloudflare.enabled !== undefined) f.enabled = cloudflare.enabled;
    });
  }
  /**
   * [연결] for the user's own account (SPEC-05.11): one 'who am I' call with the saved token. The
   * outcome is kept and shown; a token short of rights stays saved. No token (or no Cloudflare
   * account ID) is ACCOUNT_NOT_CONNECTED. Turns the account on.
   */
  async checkAccount(service: AccountService) {
    await this.load();
    const token = await this.secrets.get(ACCOUNT_SECRET[service]);
    const at = this.now().toISOString();
    if (service === 'github') {
      if (!token) throw new DomainError('ACCOUNT_NOT_CONNECTED');
      const found = await checkGithub(this.apis, token);
      await this.saveAll(({ github: g }) => {
        g.enabled = true;
        g.checkedAt = at;
        g.rejected = found.kind === 'rejected';
        if (found.kind === 'ok') {
          g.login = found.login;
          g.scopes = found.scopes ?? [];
          g.scopesChecked = found.scopes !== null;
          g.status = githubScopesEnough(found.scopes) ? 'connected' : 'scope-missing';
        } else g.status = found.kind === 'rejected' ? 'scope-missing' : 'unreachable';
      });
    } else {
      const accountId = this.stored.services.cloudflare.accountId;
      if (!token || !accountId) throw new DomainError('ACCOUNT_NOT_CONNECTED');
      const found = await checkCloudflare(this.apis, token, accountId);
      await this.saveAll(({ cloudflare: f }) => {
        f.enabled = true;
        f.checkedAt = at;
        f.rejected = found.kind === 'rejected';
        if (found.kind === 'ok') {
          f.accountName = found.accountName;
          f.status = 'connected';
        } else f.status = found.kind === 'rejected' ? 'scope-missing' : 'unreachable';
      });
    }
    return this.view();
  }
  /**
   * [끊기] for the user's own account: the token and what the check found are forgotten and the
   * account is off. Repositories and published sites stay as they are (SPEC-05.11).
   */
  async disconnectAccount(service: AccountService) {
    await this.secrets.set(ACCOUNT_SECRET[service], undefined);
    await this.saveAll((services) => {
      if (service === 'github')
        Object.assign(services.github, {
          enabled: false,
          login: null,
          scopes: [],
          scopesChecked: false,
          rejected: false,
          checkedAt: null,
          status: null,
        });
      else
        Object.assign(services.cloudflare, {
          enabled: false,
          accountId: null,
          accountName: null,
          rejected: false,
          checkedAt: null,
          status: null,
        });
    });
    return this.view();
  }
  /**
   * The saved token, API address and last status of the user's `service` account, or undefined
   * when it cannot be used (no token, off, or Cloudflare without an account ID). Callers outside
   * this module use `accountTokenFor`·`accountConnection` (account-services.ts).
   */
  async accountConnection(service: AccountService) {
    await this.load();
    const token = await this.secrets.get(ACCOUNT_SECRET[service]);
    const stored = this.stored.services[service];
    const accountId = service === 'cloudflare' ? this.stored.services.cloudflare.accountId : null;
    if (!token || !stored.enabled || (service === 'cloudflare' && !accountId)) return undefined;
    return {
      api: this.apis[service],
      token,
      accountId,
      status: stored.status,
      rejected: stored.rejected,
      timeoutMs: this.apis.timeoutMs,
    };
  }
  /** [연결]: a token from the VIDE account (ADR-039). Refused on a PC not signed in. */
  async connect() {
    if (!this.account || !(await this.account.linked().catch(() => false)))
      throw new DomainError('ACCOUNT_NOT_LINKED');
    await this.load();
    if (!this.clawde.baseUrl) throw new DomainError('SERVICE_NOT_CONNECTED');
    const token = await this.account.token('clawde');
    await this.secrets.set(TOKEN_SECRET, token.accessToken);
    this.lastStatus = undefined;
    await this.save((c) => {
      c.tokenSource = 'account';
      c.tokenExpiresAt = token.expiresAt;
      c.enabled = true;
    });
    return this.view();
  }
  /** [끊기]: forget the token and turn the service off. Cached answers stay. */
  async disconnect() {
    await this.secrets.set(TOKEN_SECRET, undefined);
    this.lastStatus = undefined;
    await this.save((c) => {
      c.enabled = false;
      c.tokenSource = null;
      c.tokenExpiresAt = null;
    });
    return this.view();
  }
  async projectOff(projectId: string) {
    await this.load();
    return this.clawde.projectsOff.includes(projectId);
  }
  /** Whether a call may be made now (address, token and switch); the view says why not. */
  async ready() {
    const view = await this.view();
    return view.clawde.status !== 'not-configured' && view.clawde.status !== 'off';
  }
  /**
   * What the connector needs for one call: the address and the bearer token. An account token
   * close to expiry is renewed first (one renewal at a time); a failed renewal is 'login-required'.
   */
  async connection(): Promise<{ baseUrl: string; token: string }> {
    await this.load();
    const c = this.clawde;
    const stored = await this.secrets.get(TOKEN_SECRET);
    if (!c.baseUrl || !stored || !c.enabled) throw new DomainError('SERVICE_NOT_CONNECTED');
    if (
      c.tokenSource === 'account' &&
      (!c.tokenExpiresAt || Date.parse(c.tokenExpiresAt) - this.now().getTime() < RENEW_BEFORE_MS)
    ) {
      const token = await (this.renewing ??= this.renew().finally(() => {
        this.renewing = undefined;
      }));
      return { baseUrl: c.baseUrl, token };
    }
    return { baseUrl: c.baseUrl, token: stored };
  }
  private async renew() {
    try {
      if (!this.account) throw new DomainError('ACCOUNT_NOT_LINKED');
      const token = await this.account.token('clawde');
      await this.secrets.set(TOKEN_SECRET, token.accessToken);
      await this.save((c) => {
        c.tokenExpiresAt = token.expiresAt;
      });
      return token.accessToken;
    } catch {
      this.lastStatus = 'login-required';
      throw new DomainError('SERVICE_AUTH');
    }
  }
  /**
   * The connector's report after each call; a `meta` answer also records the law DB date and the
   * endpoints it lists (PLAN-48 T-240), which replace the 501s seen before.
   */
  async report(
    status: 'connected' | 'unreachable' | 'login-required',
    meta?: { lawDbDate: string; endpoints?: string[]; plannedEndpoints?: string[] },
  ) {
    this.lastStatus = status;
    this.lastNotReady = false;
    if (meta) {
      this.notImplemented.clear();
      await this.save((c) => {
        c.lawDbDate = meta.lawDbDate;
        c.checkedAt = this.now().toISOString();
        c.endpoints = meta.endpoints?.map(endpointName) ?? null;
        c.plannedEndpoints = meta.plannedEndpoints?.map(endpointName) ?? null;
      });
    }
  }
  /** A 503 `NO_PUBLICATION`·`PUBLISHING`: the service is up but not ready; the status stays. */
  reportNotReady() {
    this.lastNotReady = true;
  }
  /** A 501 on `feature`'s endpoint: off until the next `meta`; the status is 'connected'. */
  reportNotImplemented(feature: ClawdeFeature) {
    this.notImplemented.add(CLAWDE_FEATURES[feature]);
    this.lastStatus = 'connected';
    this.lastNotReady = false;
  }
  /**
   * Which features the service answers now: listed in the last `meta`'s `endpoints` (all of them
   * when it gave none, an older service), not in `plannedEndpoints` and no 501 since. Reads the
   * loaded settings; before the first load every feature counts as on.
   */
  features(): ClawdeFeatures {
    const { endpoints, plannedEndpoints } = this.clawde;
    const on = (feature: ClawdeFeature) => {
      const name = CLAWDE_FEATURES[feature];
      if (this.notImplemented.has(name)) return false;
      if (endpoints) return endpoints.includes(name);
      return !plannedEndpoints?.includes(name);
    };
    return {
      ask: on('ask'),
      checklist: on('checklist'),
      contribute: on('contribute'),
      verify: on('verify'),
      golden: on('golden'),
      recipes: on('recipes'),
    };
  }
  private forgetEndpoints(c: Stored['services']['clawde']) {
    c.endpoints = null;
    c.plannedEndpoints = null;
    this.notImplemented.clear();
    this.lastNotReady = false;
  }
  /** The newest law DB date the service announced (answers older than it are stale). */
  async lawDbDate() {
    await this.load();
    return this.clawde.lawDbDate;
  }
  /** The last call's outcome, for marking cached answers offline. */
  get status() {
    return this.lastStatus;
  }
}

/**
 * An endpoint entry of `meta` as its first path segment: `POST /v1/ask` → `ask`,
 * `GET /v1/recipes/{id}` → `recipes`, `ask` → `ask`.
 */
export function endpointName(entry: string) {
  const path = entry.trim().split(/\s+/).at(-1) ?? '';
  const segments = path.replace(/^\/?v1\//, '').split(/[/?]/);
  return segments[0] ?? '';
}
