import type { z } from 'zod';
import { DomainError } from '../contracts/errors.ts';
import {
  clawdeAnswerSchema,
  clawdeArticleSchema,
  clawdeChecklistSchema,
  clawdeContributionReceiptSchema,
  clawdeGoldenSchema,
  clawdeMetaSchema,
  clawdeRecipeSchema,
  clawdeSearchSchema,
  clawdeVerifyResultSchema,
  type clawdeChecklistRequestSchema,
  type ClawdeAnswer,
  type ClawdeArticle,
  type ClawdeAskRequest,
  type ClawdeChecklist,
  type ClawdeContributionReceipt,
  type ClawdeContributionRequest,
  type ClawdeGolden,
  type ClawdeMeta,
  type ClawdeRecipe,
  type ClawdeVerifyRequest,
  type ClawdeVerifyResult,
} from '../contracts/clawde.ts';
import { CLAWDE_FEATURES, type ClawdeFeature } from '../contracts/services.ts';
import { sanitizeSvg } from './clawde-check.ts';
import { endpointName, type ServiceSettings } from './settings.ts';

/**
 * The engine's cLAWde connector (ARCH-01 「cLAWde 연결 계약」, SPEC-13.12, PLAN-46 T-217·T-218).
 * Only the engine calls the service. Each call has a time limit and is never retried: a timeout or
 * network failure is SERVICE_UNAVAILABLE ('닿지 않음'), 401 is SERVICE_AUTH ('로그인 필요'), an
 * answer outside the contract is SERVICE_BAD_RESPONSE and is not used. An endpoint the service does
 * not offer yet (501 `NOT_IMPLEMENTED`, or left out of `meta.endpoints`) is SERVICE_NOT_IMPLEMENTED
 * and a service up but not published yet (503 `NO_PUBLICATION`·`PUBLISHING`) is SERVICE_NOT_READY
 * ('서비스 준비 중'); neither marks the service unreachable (PLAN-48 T-240).
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
    // A feature the service does not answer yet is not called at all.
    const feature = featureOf(url, baseUrl);
    if (feature && !this.settings.features()[feature])
      throw new DomainError('SERVICE_NOT_IMPLEMENTED');
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
    if (response.status === 501) {
      await response.body?.cancel().catch(() => {});
      if (feature) this.settings.reportNotImplemented(feature);
      else await this.settings.report('connected');
      throw new DomainError('SERVICE_NOT_IMPLEMENTED');
    }
    if (response.status === 503) {
      const code = await errorCode(response);
      if (code === 'NO_PUBLICATION' || code === 'PUBLISHING') {
        this.settings.reportNotReady();
        throw new DomainError('SERVICE_NOT_READY');
      }
      await this.settings.report('unreachable');
      throw new DomainError('SERVICE_UNAVAILABLE');
    }
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
    this.lastMeta = meta;
    // Records the law DB date and which endpoints answer (features()).
    await this.settings.report('connected', meta);
    return meta;
  }
  /** The last `meta` this engine saw (labels of stages and profile keys), if any. */
  lastMeta: ClawdeMeta | undefined;

  ask(request: ClawdeAskRequest): Promise<ClawdeAnswer> {
    return this.call('/v1/ask', clawdeAnswerSchema, { method: 'POST', body: request });
  }
  checklist(request: z.infer<typeof clawdeChecklistRequestSchema>): Promise<ClawdeChecklist> {
    return this.call('/v1/checklist', clawdeChecklistSchema, { method: 'POST', body: request });
  }
  article(ref: string): Promise<ClawdeArticle> {
    return this.call(`/v1/articles/${encodeURIComponent(ref)}`, clawdeArticleSchema);
  }
  search(q: string, limit = 10) {
    const query = new URLSearchParams({ q, limit: String(limit) });
    return this.call(`/v1/search?${query}`, clawdeSearchSchema);
  }
  /** `POST /v1/contributions` (SPEC-13.10): the service dedupes on `idempotencyKey`. */
  contribute(request: ClawdeContributionRequest): Promise<ClawdeContributionReceipt> {
    return this.call('/v1/contributions', clawdeContributionReceiptSchema, {
      method: 'POST',
      body: request,
    });
  }
  /** A versioned recipe never changes: cached by `(id, version)` for the engine's life. */
  async recipe(id: string, version: string): Promise<ClawdeRecipe> {
    const key = `${id}@${version}`;
    const cached = this.recipes.get(key);
    if (cached) return cached;
    const query = new URLSearchParams({ version });
    const recipe = await this.call(
      `/v1/recipes/${encodeURIComponent(id)}?${query}`,
      clawdeRecipeSchema,
    );
    if (recipe.id !== id || recipe.version !== version)
      throw new DomainError('SERVICE_BAD_RESPONSE');
    this.recipes.set(key, recipe);
    return recipe;
  }
  private readonly recipes = new Map<string, ClawdeRecipe>();
  verify(request: ClawdeVerifyRequest): Promise<ClawdeVerifyResult> {
    return this.call('/v1/verify', clawdeVerifyResultSchema, { method: 'POST', body: request });
  }
  golden(recipeId: string): Promise<ClawdeGolden> {
    const query = new URLSearchParams({ recipe: recipeId });
    return this.call(`/v1/golden?${query}`, clawdeGoldenSchema);
  }

  /**
   * An answer's figures as data URLs (ARCH-01 「엔진 검사」): fetched from the service's own origin
   * with the token, PNG kept as is, SVG cleaned of scripts and outside references. A figure that
   * cannot be fetched or cleaned is dropped; the answer stays.
   */
  async inlineFigures(answer: ClawdeAnswer): Promise<ClawdeAnswer> {
    if (!answer.figures?.length) return answer;
    const figures: NonNullable<ClawdeAnswer['figures']> = [];
    for (const figure of answer.figures.slice(0, MAX_FIGURES)) {
      try {
        const response = await this.raw(figure.url, { accept: figure.mime });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_FIGURE_BYTES) continue;
        if (figure.mime === 'image/png') {
          if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) continue;
          figures.push({ ...figure, url: `data:image/png;base64,${bytes.toString('base64')}` });
        } else {
          const svg = sanitizeSvg(bytes.toString('utf8'));
          if (!svg) continue;
          figures.push({
            ...figure,
            url: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
          });
        }
      } catch {
        /* Dropped: an unreachable or refused figure does not cost the answer. */
      }
    }
    return { ...answer, figures };
  }
}

/** The feature a service path belongs to (`/v1/ask` → `ask`); undefined for always-on paths. */
function featureOf(url: string, baseUrl: string): ClawdeFeature | undefined {
  const path = new URL(url).pathname;
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  if (!path.startsWith(basePath + '/v1/')) return undefined;
  const name = endpointName(path.slice(basePath.length));
  return (Object.keys(CLAWDE_FEATURES) as ClawdeFeature[]).find(
    (feature) => CLAWDE_FEATURES[feature] === name,
  );
}
/** `{error: {code}}` of a refused response, if it has one. */
async function errorCode(response: Response) {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } } | null;
    return typeof body?.error?.code === 'string' ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

const MAX_FIGURES = 6;
const MAX_FIGURE_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
