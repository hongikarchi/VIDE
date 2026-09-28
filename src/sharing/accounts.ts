import type { Env } from './auth';
import { HttpError, body, digest, json } from './http';

// ID + password accounts. Better Auth keeps email accounts, so an ID maps to a reserved,
// undeliverable address; an input containing "@" still signs in an existing email account.
// Sign-up needs the owner's sign-up code (SIGNUP_CODE secret).
export const USER_DOMAIN = 'users.vide.invalid';
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,29}$/;
export const loginEmail = (id: string) => {
  const value = id.trim().toLowerCase();
  return value.includes('@') ? value : `${value}@${USER_DOMAIN}`;
};
export const displayName = (email: string, name: string) =>
  email.endsWith('@' + USER_DOMAIN) ? email.slice(0, -USER_DOMAIN.length - 1) : name || email;

interface AuthHandler {
  handler: (request: Request) => Promise<Response>;
}
/** Run a Better Auth endpoint (rate limits, cookies) with a rewritten JSON body. */
export function forwardAuth(
  auth: AuthHandler,
  request: Request,
  env: Env,
  path: string,
  data: unknown,
) {
  const headers = new Headers(request.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('Origin', env.AUTH_ORIGIN);
  headers.delete('Content-Length');
  return auth.handler(
    new Request(env.AUTH_ORIGIN + path, { method: 'POST', headers, body: JSON.stringify(data) }),
  );
}
const password = (value: unknown) => {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128)
    throw new HttpError(400, 'INVALID_PASSWORD');
  return value;
};
export const username = (value: unknown) => {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!id || id.length > 254) throw new HttpError(400, 'INVALID_USERNAME');
  return id;
};

/** Verify an ID/password pair; returns the Better Auth response (with its session cookie). */
export async function signIn(
  auth: AuthHandler,
  request: Request,
  env: Env,
  id: unknown,
  pw: unknown,
) {
  return forwardAuth(auth, request, env, '/api/auth/sign-in/email', {
    email: loginEmail(username(id)),
    password: password(pw),
    rememberMe: true,
  });
}

export async function accountRoute(request: Request, env: Env, auth: AuthHandler, path: string) {
  if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
  if (request.headers.get('Origin') !== env.AUTH_ORIGIN)
    throw new HttpError(403, 'ORIGIN_REJECTED');
  const input = await body(request);
  if (path === '/api/account/sign-in') {
    const response = await signIn(auth, request, env, input.username, input.password);
    if (response.status === 401 || response.status === 403)
      throw new HttpError(401, 'INVALID_LOGIN');
    return response;
  }
  if (path === '/api/account/sign-up') {
    if (!env.SIGNUP_CODE) throw new HttpError(403, 'SIGNUP_CLOSED');
    if (
      typeof input.code !== 'string' ||
      (await digest(input.code.trim())) !== (await digest(env.SIGNUP_CODE))
    )
      throw new HttpError(403, 'INVALID_SIGNUP_CODE');
    const id = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    if (!USERNAME.test(id)) throw new HttpError(400, 'INVALID_USERNAME');
    const email = loginEmail(id);
    // Better Auth answers a duplicate sign-up like a new one; IDs are public, so say it is taken.
    if (await env.DB.prepare('SELECT 1 FROM user WHERE email=?').bind(email).first())
      throw new HttpError(409, 'USERNAME_TAKEN');
    const response = await forwardAuth(auth, request, env, '/api/auth/sign-up/email', {
      email,
      password: password(input.password),
      name: id,
    });
    if (!response.ok) {
      const reply = (await response.json().catch(() => ({}))) as { code?: string };
      if (response.status === 422 || /EXISTS/.test(reply.code ?? ''))
        throw new HttpError(409, 'USERNAME_TAKEN');
      throw new HttpError(response.status === 429 ? 429 : 400, reply.code || 'SIGNUP_FAILED');
    }
    // The sign-up code is the gate; ID accounts have no mailbox to verify.
    await env.DB.prepare('UPDATE user SET emailVerified=1 WHERE email=?').bind(email).run();
    return json({ created: true, username: id }, 201);
  }
  throw new HttpError(404, 'NOT_FOUND');
}
