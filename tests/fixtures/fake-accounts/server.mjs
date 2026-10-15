// Fake GitHub and Cloudflare APIs for the user's own accounts (SPEC-05.11, PLAN-54 T-344): GitHub
// `GET /user` (with `X-OAuth-Scopes` for a classic token) and Cloudflare `GET /user/tokens/verify`
// and `GET /accounts/:id`. Tokens and the account ID are plainly fake. `startFakeAccounts()` gives
// `{github, cloudflare, control(patch), calls, close()}`; `github`·`cloudflare` are the API bases to
// pass as `serviceOptions.githubApi`·`cloudflareApi`.
import { createServer } from 'node:http';

export const FAKE_GITHUB_TOKEN = 'ghp_test_fake_token_0001';
export const FAKE_GITHUB_LOGIN = 'vide-test-user';
export const FAKE_CLOUDFLARE_TOKEN = 'cf_test_fake_token_0001';
export const FAKE_CLOUDFLARE_ACCOUNT = '0123456789abcdef0123456789abcdef';
export const FAKE_CLOUDFLARE_NAME = '시험 계정';

const defaults = () => ({
  /** `X-OAuth-Scopes` value; `null` sends no header (a fine-grained token). */
  githubScopes: 'repo, workflow',
  /** An HTTP status every call answers with instead (e.g. 500), or 'drop' to close the socket. */
  fail: null,
  /** Cloudflare's token status ('active', 'disabled', 'expired'). */
  cloudflareStatus: 'active',
});

export async function startFakeAccounts() {
  let state = defaults();
  const calls = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fake');
    const auth = request.headers.authorization ?? '';
    calls.push({ method: request.method, path: url.pathname });
    const json = (status, value, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(value));
    };
    if (state.fail === 'drop') return request.socket.destroy();
    if (state.fail) return json(state.fail, { message: 'fake failure' });
    if (request.method === 'GET' && url.pathname === '/github/user') {
      if (auth !== `Bearer ${FAKE_GITHUB_TOKEN}`) return json(401, { message: 'Bad credentials' });
      return json(
        200,
        { login: FAKE_GITHUB_LOGIN, id: 1 },
        state.githubScopes === null ? {} : { 'X-OAuth-Scopes': state.githubScopes },
      );
    }
    if (url.pathname.startsWith('/cloudflare/')) {
      if (auth !== `Bearer ${FAKE_CLOUDFLARE_TOKEN}`)
        return json(401, { success: false, errors: [{ code: 1000, message: 'Invalid token' }] });
      if (request.method === 'GET' && url.pathname === '/cloudflare/user/tokens/verify')
        return json(200, {
          success: true,
          result: { id: 'fake-token-id', status: state.cloudflareStatus },
        });
      const account = /^\/cloudflare\/accounts\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && account) {
        if (account[1] !== FAKE_CLOUDFLARE_ACCOUNT)
          return json(403, { success: false, errors: [{ code: 9109, message: 'Unauthorized' }] });
        return json(200, {
          success: true,
          result: { id: FAKE_CLOUDFLARE_ACCOUNT, name: FAKE_CLOUDFLARE_NAME },
        });
      }
    }
    json(404, { message: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    github: origin + '/github',
    cloudflare: origin + '/cloudflare',
    calls,
    control(patch) {
      state = { ...state, ...patch };
    },
    reset() {
      state = defaults();
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
