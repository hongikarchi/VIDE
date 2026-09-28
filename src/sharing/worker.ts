import { createAuth, manualApproval, type Env } from './auth';
import { HttpError, json } from './http';
import { acceptInvitation, projectRoute } from './projects';
import { publicationRoute } from './publications';
import { commentRoute, exportComment } from './comments';
import { hostDeviceRoute, hostRoute } from './hosts';

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (
      !env.AUTH_SECRET ||
      env.AUTH_SECRET.length < 32 ||
      !env.AUTH_ORIGIN ||
      url.origin !== env.AUTH_ORIGIN
    )
      throw new HttpError(503, 'SHARING_NOT_CONFIGURED');
    if (url.pathname === '/api/config' && request.method === 'GET')
      return json({
        manualApproval: manualApproval(env),
        uploadsEnabled: env.UPLOADS_ENABLED !== 'false',
      });
    if (
      manualApproval(env) &&
      url.pathname.startsWith('/api/auth/') &&
      ![
        '/api/auth/sign-up/email',
        '/api/auth/sign-in/email',
        '/api/auth/sign-out',
        '/api/auth/get-session',
      ].includes(url.pathname)
    )
      throw new HttpError(403, 'AUTH_FEATURE_UNAVAILABLE');
    const auth = createAuth(env, ctx);
    if (url.pathname.startsWith('/api/auth/')) return auth.handler(request);
    if (!url.pathname.startsWith('/api/')) {
      if (env.WEB && ['GET', 'HEAD'].includes(request.method)) return env.WEB.fetch(request);
      throw new HttpError(404, 'NOT_FOUND');
    }
    // Desktop hosts authenticate with a pairing code or host key, not a browser session.
    if (url.pathname === '/api/hosts/pair' || url.pathname === '/api/hosts/heartbeat')
      return await hostDeviceRoute(request, env, url.pathname);
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      request.headers.get('Origin') !== env.AUTH_ORIGIN
    )
      throw new HttpError(403, 'ORIGIN_REJECTED');
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user || (!manualApproval(env) && !session.user.emailVerified))
      throw new HttpError(401, 'LOGIN_REQUIRED');
    if (
      env.UPLOADS_ENABLED === 'false' &&
      url.pathname.includes('/publications') &&
      !['GET', 'HEAD'].includes(request.method)
    )
      throw new HttpError(503, 'UPLOADS_DISABLED');
    const actor = { id: session.user.id, email: session.user.email };
    if (url.pathname === '/api/invitations/accept' && request.method === 'POST')
      return await acceptInvitation(request, env, actor);
    const path = url.pathname.split('/').filter(Boolean);
    if (
      path[1] === 'projects' &&
      path[2] &&
      path[3] === 'publications' &&
      path[4] &&
      path[5] === 'comments' &&
      path[6] &&
      path[7] === 'export' &&
      path.length === 8
    )
      return await exportComment(request, env, actor, path[2], path[4], path[6]);
    if (
      path[1] === 'projects' &&
      path[2] &&
      path[3] === 'publications' &&
      path[4] &&
      path[5] === 'comments' &&
      path.length === 6
    )
      return await commentRoute(request, env, actor, path[2], path[4]);
    if (path[1] === 'projects' && path[2] && path[3] === 'publications')
      return await publicationRoute(request, env, actor, path[2], path.slice(4));
    if (path[1] === 'projects') return await projectRoute(request, env, actor, path.slice(2));
    if (path[1] === 'hosts') return await hostRoute(request, env, actor, path.slice(2));
    throw new HttpError(404, 'NOT_FOUND');
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code }, error.status);
    // No request bodies, tokens or provider exception details in public responses.
    console.error('Sharing request failed', error instanceof Error ? error.name : 'UnknownError');
    return json({ error: 'INTERNAL_ERROR' }, 500);
  }
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const result = await handle(request, env, ctx),
      response = new Response(result.body, result);
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return response;
  },
} satisfies ExportedHandler<Env>;
