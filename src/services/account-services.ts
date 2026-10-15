import { DomainError } from '../contracts/errors.ts';
import type { AccountService } from '../contracts/services.ts';
import type { ServiceSettings } from './settings.ts';

/**
 * The user's own GitHub and Cloudflare accounts (SPEC-05.11, ADR-043, ARCH-01 「사용자 계정 서비스」,
 * PLAN-54 T-344): the one 'who am I' call [연결] makes, and the token other parts (T-346 push,
 * T-347 publish) take from the sealed store. Nothing here logs or returns a token in an error.
 */

export const DEFAULT_GITHUB_API = 'https://api.github.com';
export const DEFAULT_CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
/** What a classic GitHub token must hold to create repositories and push (SPEC-05.11). */
export const GITHUB_REQUIRED_SCOPES = ['repo'] as const;
const TIMEOUT_MS = 15_000;

export interface AccountApis {
  github: string;
  cloudflare: string;
  timeoutMs: number;
}

/**
 * The API addresses: the test seams `githubApi`·`cloudflareApi` (server `serviceOptions`), then
 * the environment `VIDE_GITHUB_API`·`VIDE_CLOUDFLARE_API`, then the real services. The
 * environment seam is honoured for a loopback address only (a fake service in a test), so a stray
 * variable on an installed PC never sends the user's token to another host.
 */
/** An http(s) address on this PC (127.0.0.1, ::1, localhost), else undefined. */
export function loopbackOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return undefined;
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function accountApis(
  options: { githubApi?: string; cloudflareApi?: string; timeoutMs?: number } = {},
  environment: NodeJS.ProcessEnv = process.env,
): AccountApis {
  const trim = (value: string) => value.replace(/\/+$/, '');
  return {
    github: trim(
      options.githubApi ?? loopbackOnly(environment.VIDE_GITHUB_API) ?? DEFAULT_GITHUB_API,
    ),
    cloudflare: trim(
      options.cloudflareApi ??
        loopbackOnly(environment.VIDE_CLOUDFLARE_API) ??
        DEFAULT_CLOUDFLARE_API,
    ),
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
  };
}

/** One check's outcome: the account it found, the token refused, or no answer. */
export type GithubCheck =
  | { kind: 'ok'; login: string; scopes: string[] | null }
  | { kind: 'rejected' }
  | { kind: 'unreachable' };
export type CloudflareCheck =
  | { kind: 'ok'; accountName: string }
  | { kind: 'rejected' }
  | { kind: 'unreachable' };

async function call(url: string, token: string, timeoutMs: number, headers = {}) {
  try {
    return await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'VIDE', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return undefined;
  }
}

const refused = (status: number) => status === 401 || status === 403 || status === 404;

/**
 * GitHub `GET /user`: the login, and the scopes a classic token lists in `X-OAuth-Scopes`. A
 * fine-grained token sends no such header (`scopes: null`): not a failure, its permissions show
 * only when pushing.
 */
export async function checkGithub(apis: AccountApis, token: string): Promise<GithubCheck> {
  const response = await call(apis.github + '/user', token, apis.timeoutMs, {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  if (!response) return { kind: 'unreachable' };
  if (refused(response.status)) return { kind: 'rejected' };
  if (!response.ok) return { kind: 'unreachable' };
  const body = (await response.json().catch(() => null)) as { login?: unknown } | null;
  if (typeof body?.login !== 'string' || !body.login) return { kind: 'unreachable' };
  const header = response.headers.get('x-oauth-scopes');
  const scopes =
    header === null
      ? null
      : header
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean);
  return { kind: 'ok', login: body.login, scopes };
}

/** Whether the listed scopes cover creating repositories and pushing (`null`: not listed). */
export function githubScopesEnough(scopes: string[] | null) {
  return scopes === null || GITHUB_REQUIRED_SCOPES.every((scope) => scopes.includes(scope));
}

/**
 * Cloudflare `GET /user/tokens/verify` (the token is active) then `GET /accounts/{id}` (the
 * account's name). A missing Workers permission shows only when publishing (T-347).
 */
export async function checkCloudflare(
  apis: AccountApis,
  token: string,
  accountId: string,
): Promise<CloudflareCheck> {
  const verify = await call(apis.cloudflare + '/user/tokens/verify', token, apis.timeoutMs);
  if (!verify) return { kind: 'unreachable' };
  if (refused(verify.status) || verify.status === 400) return { kind: 'rejected' };
  if (!verify.ok) return { kind: 'unreachable' };
  const verified = (await verify.json().catch(() => null)) as {
    success?: unknown;
    result?: { status?: unknown };
  } | null;
  if (!verified || typeof verified.result?.status !== 'string') return { kind: 'unreachable' };
  if (verified.success !== true || verified.result.status !== 'active') return { kind: 'rejected' };
  const account = await call(
    `${apis.cloudflare}/accounts/${encodeURIComponent(accountId)}`,
    token,
    apis.timeoutMs,
  );
  if (!account) return { kind: 'unreachable' };
  if (refused(account.status) || account.status === 400) return { kind: 'rejected' };
  if (!account.ok) return { kind: 'unreachable' };
  const body = (await account.json().catch(() => null)) as {
    success?: unknown;
    result?: { name?: unknown };
  } | null;
  if (body?.success !== true || typeof body.result?.name !== 'string')
    return { kind: 'unreachable' };
  return { kind: 'ok', accountName: body.result.name };
}

/**
 * The sealed token of the user's `service` account, for a push (T-346) or a publish (T-347).
 * Throws DomainError ACCOUNT_NOT_CONNECTED (409) when no token is saved, the account is off (or
 * Cloudflare has no account ID) or the last [연결] found the token refused by the service, and
 * ACCOUNT_SCOPE (403) when the last [연결] found the token short of rights. Never put the result in a log, an answer or an error.
 */
export async function accountTokenFor(
  settings: ServiceSettings,
  service: AccountService,
): Promise<string> {
  return (await accountConnection(settings, service)).token;
}

/**
 * Everything a call to the user's account needs: the API address (test seams honoured), the
 * token and, for Cloudflare, the account ID. Same refusals as `accountTokenFor`.
 */
export async function accountConnection(
  settings: ServiceSettings,
  service: AccountService,
): Promise<{ api: string; token: string; accountId: string | null; timeoutMs: number }> {
  const connection = await settings.accountConnection(service);
  if (!connection) throw new DomainError('ACCOUNT_NOT_CONNECTED');
  // A token the service refused (401/403/404 at [연결]) is not a connection: connect again.
  if (connection.status === 'scope-missing' && connection.rejected)
    throw new DomainError('ACCOUNT_NOT_CONNECTED');
  if (connection.status === 'scope-missing') throw new DomainError('ACCOUNT_SCOPE');
  return {
    api: connection.api,
    token: connection.token,
    accountId: connection.accountId,
    timeoutMs: connection.timeoutMs,
  };
}
