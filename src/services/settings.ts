import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../contracts/errors.ts';
import {
  CLAWDE_FEATURES,
  serviceSettingsUpdateSchema,
  type ClawdeFeature,
  type ClawdeFeatures,
  type ServiceSettingsView,
  type ServiceStatus,
  type ServiceToken,
} from '../contracts/services.ts';
import { SecretStore } from './secrets.ts';

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
  }),
});
type Stored = z.infer<typeof storedSchema>;
const empty = (): Stored => storedSchema.parse({ services: { clawde: {} } });

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
  constructor({
    directory,
    secrets,
    account,
    now = () => new Date(),
  }: {
    directory: string | undefined;
    secrets: SecretStore;
    account?: AccountTokens;
    now?: () => Date;
  }) {
    this.file = directory === undefined ? undefined : join(directory, 'service-settings.json');
    this.secrets = secrets;
    this.account = account;
    this.now = now;
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
    const run = this.queue.then(async () => {
      await this.load();
      const next = structuredClone(this.stored);
      change(next.services.clawde);
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
    };
  }
  /** `PUT /api/v1/settings/services`. A static token replaces any account token. */
  async update(input: unknown) {
    const { clawde } = serviceSettingsUpdateSchema.parse(input);
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
    return this.view();
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
