import { DomainError } from '../contracts/errors.ts';
import { serviceTokenSchema } from '../contracts/services.ts';
import type { ClawdeClient } from '../services/clawde.ts';
import type { LegalService } from '../services/legal.ts';
import type { AccountTokens, ServiceSettings } from '../services/settings.ts';
import type { RemoteAccess } from './remote-access.ts';

/**
 * The account-site token exchange (ARCH-01 「토큰 받기」): this PC signs the call with its host key
 * (the VIDE account link, ADR-039) at `POST /api/hosts/device/services/<service>/token` and gets
 * `{accessToken, expiresAt}`. A site without the route (404) is SERVICE_TOKEN_UNAVAILABLE: the
 * static development token is then the only way to connect.
 */
export function accountTokens(remote: RemoteAccess): AccountTokens {
  return {
    linked: async () => (await remote.status()).linked,
    token: async (service) => {
      let response: Response | undefined;
      try {
        response = await remote.deviceFetch(`/services/${service}/token`, 'POST', {});
      } catch {
        throw new DomainError('SITE_UNREACHABLE');
      }
      if (!response) throw new DomainError('ACCOUNT_NOT_LINKED');
      if (response.status === 401) throw new DomainError('ACCOUNT_NOT_LINKED');
      if (!response.ok) throw new DomainError('SERVICE_TOKEN_UNAVAILABLE');
      const parsed = serviceTokenSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new DomainError('SERVICE_TOKEN_UNAVAILABLE');
      return parsed.data;
    },
  };
}

/**
 * External service settings (SPEC-13.11, ARCH-01 「cLAWde 연결 계약」, PLAN-46 T-217):
 * `GET/PUT /api/v1/settings/services`, `POST …/services/clawde/connect` ([연결], the VIDE account),
 * `POST …/clawde/disconnect` ([끊기]) and `POST …/clawde/check` (one `meta` call for the status).
 * Answers never carry the token. Remote sessions read only (the server gate refuses their writes
 * to `/api/v1/settings` too; this check keeps the rule with the routes).
 */
export async function serviceSettingsRoutes(
  url: URL,
  method: string | undefined,
  {
    settings,
    client,
    body,
    send,
    remote,
  }: {
    settings: ServiceSettings;
    client: ClawdeClient;
    body: () => Promise<Record<string, unknown>>;
    send: (status: number, value: unknown) => void;
    remote: boolean;
  },
) {
  const path = url.pathname;
  if (path !== '/api/v1/settings/services' && !path.startsWith('/api/v1/settings/services/'))
    return false;
  if (method !== 'GET' && remote) throw new DomainError('FORBIDDEN');
  if (path === '/api/v1/settings/services') {
    if (method === 'GET') send(200, await settings.view());
    else if (method === 'PUT') send(200, await settings.update(await body()));
    else throw new DomainError('NOT_FOUND');
    return true;
  }
  const action = /^\/api\/v1\/settings\/services\/clawde\/(connect|disconnect|check)$/.exec(path);
  if (!action || method !== 'POST') throw new DomainError('NOT_FOUND');
  if (action[1] === 'connect') {
    await settings.connect();
    await client.meta().catch(() => {});
  } else if (action[1] === 'disconnect') await settings.disconnect();
  // The status is what the call found: '연결됨', '로그인 필요' or '닿지 않음'.
  else if (await settings.ready()) await client.meta().catch(() => {});
  send(200, await settings.view());
  return true;
}

/**
 * 법규 Q&A for a project (SPEC-13.3·13.4·13.9, ARCH-01 「엔진 API」, PLAN-46 T-219):
 * `GET/PUT …/projects/:id/legal/profile`, `POST …/legal/ask {question, stage?, confirmSendHash?,
 * exclude?, refresh?}` → `{answer, number, cached}` or `{needsConfirm: {items, hash, stage}}`,
 * `GET …/legal/answers[?number=]`. Remote sessions may ask and read answers (SPEC-13.11) but not
 * change the profile.
 */
export async function legalRoutes(
  url: URL,
  method: string | undefined,
  {
    legal,
    body,
    send,
    remote,
  }: {
    legal: LegalService;
    body: () => Promise<Record<string, unknown>>;
    send: (status: number, value: unknown) => void;
    remote: boolean;
  },
) {
  const match = /^\/api\/v1\/projects\/([^/]+)\/legal\/(profile|ask|answers)$/.exec(url.pathname);
  if (!match) return false;
  const [, projectId, name] = match;
  if (name === 'profile' && method === 'GET') send(200, legal.profileView(projectId));
  else if (name === 'profile' && method === 'PUT') {
    if (remote) throw new DomainError('FORBIDDEN');
    send(200, legal.updateProfile(projectId, await body()));
  } else if (name === 'ask' && method === 'POST')
    send(200, await legal.askProject(projectId, await body()));
  else if (name === 'answers' && method === 'GET') {
    const number = url.searchParams.get('number');
    if (number === null) send(200, await legal.list(projectId));
    else {
      if (!/^[1-9]\d{0,8}$/.test(number)) throw new DomainError('INVALID_INPUT');
      send(200, { answer: await legal.get(projectId, Number(number)) });
    }
  } else throw new DomainError('NOT_FOUND');
  return true;
}
