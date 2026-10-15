// VIDE 보고용 게시 — 비밀번호 사이트 (PLAN-54 T-347, ARCH-01 「게시 템플릿」).
// A Worker in the user's own Cloudflare account that serves the report folder's static files
// (`ASSETS` binding, run_worker_first) only after a password form. VIDE uploads this file
// unchanged as the main module; the password and the cookie key arrive as secrets
// (REPORT_PASSWORD, SESSION_SECRET) through the secrets endpoint, never in the script.
//
// - Session: cookie `__Host-review=<expiresMs>.<hex HMAC-SHA256(expiresMs, SESSION_SECRET)>`,
//   HttpOnly · Secure · SameSite=Lax · Path=/ · 8 h.
// - Without either secret every request is 503 (a half-made deployment never opens).
// - Every response carries `X-Robots-Tag: noindex` and `Cache-Control: private, no-store`.
// - PUBLIC_PATHS (plain-text binding, comma separated, e.g. "/logo.png") lists the only asset
//   paths served without a session. Empty by default.

const COOKIE = '__Host-review';
const SESSION_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.SESSION_SECRET || !env.REPORT_PASSWORD)
      return text(503, '이 주소는 아직 준비 중입니다. 잠시 뒤 다시 열어 주세요.');
    if (url.pathname === '/robots.txt') return text(200, 'User-agent: *\nDisallow: /\n');
    const reading = request.method === 'GET' || request.method === 'HEAD';
    if (url.pathname === '/login') {
      if (request.method !== 'POST') return redirect('/');
      return login(request, env, url);
    }
    if (url.pathname === '/logout') return redirect('/', expiredCookie());
    if (reading && publicPaths(env).has(url.pathname))
      return guarded(await env.ASSETS.fetch(request));
    if (!(await validSession(request, env))) {
      if (!reading) return text(401, '로그인이 필요합니다.');
      return loginPage(401, '');
    }
    if (!reading) return text(405, '읽기만 할 수 있습니다.');
    return guarded(await env.ASSETS.fetch(request));
  },
};

async function login(request, env, url) {
  // Same-origin form posts only (a page elsewhere cannot try passwords through a visitor).
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin)
    return text(403, '이 주소의 로그인 화면에서만 들어올 수 있습니다.');
  let typed = '';
  try {
    const form = await request.formData();
    typed = String(form.get('password') ?? '');
  } catch {
    return loginPage(400, '다시 입력해 주세요.');
  }
  const ok = await sameSecret(
    typed.normalize('NFC'),
    String(env.REPORT_PASSWORD).normalize('NFC'),
    env.SESSION_SECRET,
  );
  if (!ok) return loginPage(401, '비밀번호가 맞지 않습니다.');
  const expires = String(Date.now() + SESSION_SECONDS * 1000);
  const signature = await sign(expires, env.SESSION_SECRET);
  return redirect(
    '/',
    `${COOKIE}=${expires}.${signature}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

async function validSession(request, env) {
  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.split(/;\s*/).find((part) => part.startsWith(COOKIE + '='));
  if (!match) return false;
  const [expires, signature] = match.slice(COOKIE.length + 1).split('.');
  if (!/^\d{1,16}$/.test(expires ?? '') || !/^[0-9a-f]{64}$/.test(signature ?? '')) return false;
  if (Number(expires) <= Date.now()) return false;
  return equalText(signature, await sign(expires, env.SESSION_SECRET));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function sign(value, secret) {
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(value)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Compare the MACs of both values so neither the length nor the first differing byte leaks.
async function sameSecret(typed, expected, key) {
  return equalText(await sign(typed, key), await sign(expected, key));
}

function equalText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

function publicPaths(env) {
  return new Set(
    String(env.PUBLIC_PATHS ?? '')
      .split(',')
      .map((path) => path.trim())
      .filter((path) => path.startsWith('/') && path !== '/'),
  );
}

function privateHeaders(headers) {
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

function guarded(response) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: privateHeaders(new Headers(response.headers)),
  });
}

function text(status, body) {
  return new Response(body, {
    status,
    headers: privateHeaders(new Headers({ 'Content-Type': 'text/plain; charset=utf-8' })),
  });
}

function redirect(location, cookie) {
  const headers = privateHeaders(new Headers({ Location: location }));
  if (cookie) headers.set('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function expiredCookie() {
  return `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function loginPage(status, message) {
  const notice = message ? `<p class="error" role="alert">${message}</p>` : '';
  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>비밀번호 확인</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f5f2;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1f1f1f; }
  form { width: min(320px, calc(100vw - 32px)); display: grid; gap: 12px; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  input { font: inherit; padding: 10px 12px; border: 1px solid #c9c6bf; border-radius: 6px; }
  button { font: inherit; padding: 10px 12px; border: 0; border-radius: 6px; background: #1f1f1f;
    color: #fff; cursor: pointer; }
  .error { margin: 0; color: #b42318; font-size: 14px; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>비밀번호를 입력하세요</h1>
  ${notice}
  <input type="password" name="password" autocomplete="current-password" aria-label="비밀번호" required autofocus>
  <button type="submit">열기</button>
</form>
</body>
</html>`;
  const headers = privateHeaders(new Headers({ 'Content-Type': 'text/html; charset=utf-8' }));
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  );
  return new Response(html, { status, headers });
}
