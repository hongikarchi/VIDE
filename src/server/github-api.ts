// GitHub REST (PLAN-54 T-346, SPEC-05.11, ADR-043): the two calls the work folder history needs —
// make a repository in the person's own account (`POST /user/repos`, private by default) and read
// one back for [이어 쓰기]. The token is the person's own (설정 → 외부 서비스); it goes only to the
// API base in the Authorization header and never into a message, a log line or a thrown error.
import { DomainError } from '../contracts/errors.ts';

export const GITHUB_API = 'https://api.github.com';

export interface GithubRepo {
  name: string;
  fullName: string;
  /** The https clone address (`https://github.com/<owner>/<name>.git`), no credentials in it. */
  cloneUrl: string;
  htmlUrl: string;
  private: boolean;
}

export interface GithubApiOptions {
  token: string;
  /** REST base; tests point it at a fake server. */
  base?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/** GitHub's own rule for repository names: ASCII letters, digits, `.`, `_`, `-`; up to 100. */
export const repoNamePattern = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/**
 * The default repository name for a folder: lower-case kebab of its ASCII part (a Korean folder
 * name keeps its digits and latin letters; nothing left → `vide-workspace`).
 */
export function repoNameOf(folder: string): string {
  const name = folder
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100)
    .replace(/[-.]+$/g, '');
  return name || 'vide-workspace';
}

const repoSchema = (value: unknown): GithubRepo => {
  const row = value as Record<string, unknown> | null;
  if (
    !row ||
    typeof row.name !== 'string' ||
    typeof row.full_name !== 'string' ||
    typeof row.clone_url !== 'string'
  )
    throw new DomainError('SERVICE_UNREACHABLE');
  return {
    name: row.name,
    fullName: row.full_name,
    cloneUrl: row.clone_url,
    htmlUrl: typeof row.html_url === 'string' ? row.html_url : '',
    private: row.private === true,
  };
};

export class GithubApi {
  private readonly token: string;
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  constructor({ token, base = GITHUB_API, fetcher = fetch, timeoutMs = 20_000 }: GithubApiOptions) {
    this.token = token;
    this.base = base.replace(/\/+$/, '');
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  private async call(path: string, method = 'GET', body?: unknown) {
    let response: Response;
    try {
      response = await this.fetcher(this.base + path, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'VIDE',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new DomainError('SERVICE_UNREACHABLE');
    }
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, json };
  }

  /** 401: the token is gone or revoked; 403/404 on a write: the token may not do it. */
  private refuse(status: number): never {
    if (status === 401) throw new DomainError('ACCOUNT_NOT_CONNECTED');
    if (status === 403 || status === 404) throw new DomainError('ACCOUNT_SCOPE');
    throw new DomainError('SERVICE_UNREACHABLE');
  }

  /** The account the token belongs to. */
  async me(): Promise<{ login: string }> {
    const { status, json } = await this.call('/user');
    if (status !== 200) this.refuse(status);
    if (typeof json?.login !== 'string') throw new DomainError('SERVICE_UNREACHABLE');
    return { login: json.login };
  }

  /**
   * A new empty repository in the person's account. A taken name is `REMOTE_EXISTS` (GitHub
   * answers 422 "name already exists on this account").
   */
  async createRepo(name: string, isPrivate = true): Promise<GithubRepo> {
    if (!repoNamePattern.test(name)) throw new DomainError('INVALID_INPUT');
    const { status, json } = await this.call('/user/repos', 'POST', {
      name,
      private: isPrivate,
      auto_init: false,
      description: 'VIDE 작업 폴더',
    });
    if (status === 201) return repoSchema(json);
    if (status === 422) {
      const errors = Array.isArray(json?.errors) ? (json.errors as Record<string, unknown>[]) : [];
      const taken =
        errors.some((row) => /already exists/i.test(String(row?.message ?? ''))) ||
        /already exists/i.test(String(json?.message ?? ''));
      throw new DomainError(taken ? 'REMOTE_EXISTS' : 'INVALID_INPUT');
    }
    this.refuse(status);
  }

  /** One repository of `owner`, or null when there is none the token can see. */
  async getRepo(owner: string, name: string): Promise<GithubRepo | null> {
    if (!repoNamePattern.test(name)) throw new DomainError('INVALID_INPUT');
    const { status, json } = await this.call(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    );
    if (status === 200) return repoSchema(json);
    if (status === 404) return null;
    this.refuse(status);
  }
}
