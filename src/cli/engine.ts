// The running VIDE engine as the `vide` CLI reaches it (ARCH-01 「작업 폴더(PLAN-52)」 CLI 진입점):
// `<데이터>/launch.json` gives the local address and the session token, `POST /api/v1/session`
// (Origin = the engine) gives the cookie, and every call says `X-VIDE-Client: cli`. No engine,
// a stale launch file or a refused token is `ENGINE_UNAVAILABLE`.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../contracts/errors.ts';

export interface EngineClient {
  origin: string;
  call<T = unknown>(path: string, method?: string, body?: unknown): Promise<T>;
}

/** An error the engine answered: its code (DomainError) and HTTP status. */
export class EngineError extends DomainError {
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.status = status;
  }
}

/** `<데이터>`: `--data`, then VIDE_DATA_DIR, then %LOCALAPPDATA%\VIDE (src/desktop/shell/Paths.cs). */
export function dataDirectoryOf(env: Record<string, string | undefined>, flag?: string) {
  if (flag) return flag;
  if (env.VIDE_DATA_DIR) return env.VIDE_DATA_DIR;
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'VIDE');
  return null;
}

/** The launch link's origin and token, or null when it is not a local VIDE link. */
export function launchTarget(url: string): { origin: string; token: string } | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    !target.port ||
    target.username ||
    target.password ||
    target.pathname !== '/' ||
    target.search ||
    !/^#[a-f0-9]{64}$/.test(target.hash)
  )
    return null;
  return { origin: target.origin, token: target.hash.slice(1) };
}

const unavailable = () => new DomainError('ENGINE_UNAVAILABLE');

export async function connectEngine(
  dataDir: string | null,
  fetcher: typeof fetch = fetch,
): Promise<EngineClient> {
  if (!dataDir) throw unavailable();
  let url: unknown;
  try {
    url = (JSON.parse(await readFile(join(dataDir, 'launch.json'), 'utf8')) as { url?: unknown })
      .url;
  } catch {
    throw unavailable();
  }
  const target = typeof url === 'string' ? launchTarget(url) : null;
  if (!target) throw unavailable();
  const { origin, token } = target;
  let cookie: string | undefined;
  try {
    const response = await fetcher(origin + '/api/v1/session', {
      method: 'POST',
      redirect: 'error',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-VIDE-Client': 'cli' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(5000),
    });
    cookie = response.ok ? response.headers.get('set-cookie')?.split(';')[0] : undefined;
  } catch {
    throw unavailable();
  }
  if (!cookie) throw unavailable();
  return {
    origin,
    async call<T>(path: string, method = 'GET', body?: unknown) {
      let response: Response;
      try {
        response = await fetcher(origin + '/api/v1' + path, {
          method,
          redirect: 'error',
          headers: {
            Origin: origin,
            Cookie: cookie,
            'X-VIDE-Client': 'cli',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        throw unavailable();
      }
      const value = (await response.json().catch(() => null)) as { code?: unknown } | null;
      if (response.status === 401) throw unavailable();
      if (!response.ok)
        throw new EngineError(
          typeof value?.code === 'string' ? value.code : `HTTP_${response.status}`,
          response.status,
        );
      return value as T;
    },
  };
}
