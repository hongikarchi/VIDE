import type { z } from 'zod';
import { DomainError } from '../contracts/errors.ts';
import { clawdeMetaSchema, type ClawdeMeta } from '../contracts/clawde.ts';
import type { ServiceSettings } from './settings.ts';

/**
 * The engine's cLAWde connector (ARCH-01 「cLAWde 연결 계약」, SPEC-13.12, PLAN-46 T-217·T-218).
 * Only the engine calls the service. Each call has a time limit and is never retried: a timeout or
 * network failure is SERVICE_UNAVAILABLE ('닿지 않음'), 401 is SERVICE_AUTH ('로그인 필요'), an
 * answer outside the contract is SERVICE_BAD_RESPONSE and is not used.
 */
export class ClawdeClient {
  private readonly settings: ServiceSettings;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly version: string;
  constructor({
    settings,
    fetcher = fetch,
    timeoutMs = 20_000,
    version,
  }: {
    settings: ServiceSettings;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    version: string;
  }) {
    this.settings = settings;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.version = version;
  }

  /** One call: JSON in, the response checked against `schema`. */
  async call<T extends z.ZodType>(
    path: string,
    schema: T,
    { method = 'GET', body }: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<z.infer<T>> {
    const response = await this.raw(path, {
      method,
      body,
      accept: 'application/json',
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      await this.settings.report('connected');
      throw new DomainError('SERVICE_BAD_RESPONSE');
    }
    const parsed = schema.safeParse(json);
    await this.settings.report('connected');
    if (!parsed.success) throw new DomainError('SERVICE_BAD_RESPONSE');
    return parsed.data;
  }

  /**
   * The HTTP exchange shared by JSON calls and figure downloads: auth headers, the time limit and
   * the status mapping. Returns only a 2xx response.
   */
  async raw(
    path: string,
    { method = 'GET', body, accept }: { method?: 'GET' | 'POST'; body?: unknown; accept: string },
  ): Promise<Response> {
    const { baseUrl, token } = await this.settings.connection();
    const url = /^https?:\/\//.test(path) ? path : baseUrl + path;
    // Only the service's own origin gets the token (a figure URL could point elsewhere).
    if (new URL(url).origin !== new URL(baseUrl).origin)
      throw new DomainError('SERVICE_BAD_RESPONSE');
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-VIDE-Version': this.version,
          Accept: accept,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      await this.settings.report('unreachable');
      throw new DomainError('SERVICE_UNAVAILABLE');
    }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) {
      await this.settings.report('login-required');
      throw new DomainError('SERVICE_AUTH');
    }
    if (response.status >= 500) {
      await this.settings.report('unreachable');
      throw new DomainError('SERVICE_UNAVAILABLE');
    }
    await this.settings.report('connected');
    throw new DomainError(response.status === 404 ? 'NOT_FOUND' : 'SERVICE_BAD_RESPONSE');
  }

  /** `GET /v1/meta`; also records the law DB date for the settings view and stale answers. */
  async meta(): Promise<ClawdeMeta> {
    const meta = await this.call('/v1/meta', clawdeMetaSchema);
    await this.settings.report('connected', meta);
    return meta;
  }
}
