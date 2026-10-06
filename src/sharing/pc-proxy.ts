import { HttpError } from './http';
import type { Env } from './auth';
import { online, type HostRow } from './hosts';

// "/pc/<hostId>/…" relays a signed-in user's own work PC through this site. The PC's quick-tunnel
// address changes whenever it restarts; this address does not, and it keeps the workspace on the
// site's origin (one home-screen app on an iPad, first-party cookies). The PC still authenticates
// every session itself: the page logs in with the one-minute token from "open", as before.
export const PROXIED = 'X-Vide-Proxied';
const PREFIX = /^\/pc\/([0-9a-f-]{36})(\/.*)?$/;

/** Browser requests that must not reach the PC as-is (site cookies, Cloudflare metadata). */
const DROPPED = ['cookie', 'origin', 'referer', 'host', 'cf-connecting-ip', 'x-forwarded-for'];

export function isPcPath(pathname: string) {
  return PREFIX.test(pathname);
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
/** Shown to a page load while the PC is off or between tunnels; it retries by itself. */
function page(status: number, title: string, detail: string, project?: string) {
  // The project opened without its PC (PLAN-33): 할 일, notes and the work history summary.
  const offline = project
    ? `<p><a href="/?offline=${encodeURIComponent(project)}">PC 없이 이 프로젝트 열기 (할 일·작업 이력)</a></p>`
    : '';
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>VIDE</title></head><body><main><h1>${escape(title)}</h1><p>${escape(detail)}</p><p>5초마다 다시 연결을 시도합니다.</p>${offline}<p><a href="/">프로젝트 목록으로</a></p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function pcProxy(request: Request, env: Env, userId: string | undefined) {
  const url = new URL(request.url);
  const [, hostId, rest] = PREFIX.exec(url.pathname) ?? [];
  if (!hostId) throw new HttpError(404, 'NOT_FOUND');
  // A page load: Safari before 16.4 (older iPads) sends no Sec-Fetch-Mode, only an HTML Accept.
  const navigation =
    request.headers.get('Sec-Fetch-Mode') === 'navigate' ||
    (request.method === 'GET' && !!request.headers.get('Accept')?.startsWith('text/html'));
  // Relative addresses in the workspace resolve against "/pc/<id>/".
  if (!rest) return Response.redirect(`${url.origin}/pc/${hostId}/${url.search}`, 302);
  if (!userId) {
    if (navigation) return Response.redirect(url.origin + '/', 302);
    throw new HttpError(401, 'LOGIN_REQUIRED');
  }
  const host = await env.DB.prepare('SELECT * FROM remote_hosts WHERE id=? AND user_id=?')
    .bind(hostId, userId)
    .first<HostRow>();
  if (!host) throw new HttpError(404, 'HOST_NOT_FOUND');
  if (!online(host) || !host.url) {
    const project = url.searchParams.get('project');
    if (navigation)
      return page(
        503,
        '작업 PC에 연결할 수 없습니다',
        !online(host)
          ? `${host.name}이(가) 꺼져 있습니다. PC에서 VIDE를 켜 주세요.`
          : `${host.name}의 원격 접속이 꺼져 있습니다. PC의 VIDE 설정에서 켜 주세요.`,
        project && /^[A-Za-z0-9-]{8,64}$/.test(project) ? project : undefined,
      );
    throw new HttpError(503, !online(host) ? 'HOST_OFFLINE' : 'HOST_REMOTE_OFF');
  }
  const tunnel = new URL(host.url);
  const headers = new Headers();
  for (const [key, value] of request.headers)
    if (!DROPPED.includes(key.toLowerCase())) headers.set(key, value);
  // The PC's own session cookie, stored per PC under this path.
  const cookie = `vide_remote_${hostId.replace(/-/g, '')}`;
  const session = request.headers
    .get('Cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(cookie + '='));
  if (session) headers.set('Cookie', 'vide_remote=' + session.slice(cookie.length + 1));
  // The PC accepts writes from its own origin only; this site vouches for the page it served.
  const origin = request.headers.get('Origin');
  if (origin) {
    if (origin !== env.AUTH_ORIGIN) throw new HttpError(403, 'ORIGIN_REJECTED');
    headers.set('Origin', tunnel.origin);
  }
  let upstream: Response;
  try {
    upstream = await fetch(new URL(rest + url.search, tunnel).toString(), {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
  } catch {
    if (navigation)
      return page(
        502,
        '작업 PC가 응답하지 않습니다',
        '잠시 후 다시 열어 주세요. PC가 방금 다시 시작됐다면 원격 주소가 곧 갱신됩니다.',
      );
    throw new HttpError(502, 'HOST_UNREACHABLE');
  }
  const response = new Response(upstream.body, upstream);
  response.headers.delete('Set-Cookie');
  for (const value of upstream.headers.getSetCookie?.() ?? []) {
    const [pair, ...attributes] = value.split(';');
    const [name, ...content] = pair.trim().split('=');
    if (name !== 'vide_remote') continue;
    const kept = attributes
      .map((part) => part.trim())
      .filter((part) => !/^path=/i.test(part) && !/^domain=/i.test(part));
    response.headers.append(
      'Set-Cookie',
      [`${cookie}=${content.join('=')}`, ...kept, `Path=/pc/${hostId}/`].join('; '),
    );
  }
  const location = response.headers.get('Location');
  if (location?.startsWith(tunnel.origin))
    response.headers.set('Location', `/pc/${hostId}` + location.slice(tunnel.origin.length));
  response.headers.set(PROXIED, '1');
  return response;
}
