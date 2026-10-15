// Fake Cloudflare API (PLAN-54 T-347): the Workers endpoints `src/server/cloudflare-deploy.ts`
// calls, with the two-step static asset upload, so the deploy client is tested without a real
// account. It remembers what was uploaded (scripts, metadata, assets, secrets, workers.dev switch)
// and logs every request. All ids and tokens here are fake.
//
//   const cf = await startFakeCloudflare();      // { api, accountId, token, state, requests,
//   … deployPasswordSite({ api: cf.api, … })    //   fail(step, reply), close() }
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

export const FAKE_CF_TOKEN = 'cf_test_token';
export const FAKE_CF_ACCOUNT = '00000000000000000000000000000000';
export const FAKE_CF_SUBDOMAIN = 'fake-account';
/** Hashes per upload bucket (small, so tests see more than one bucket). */
const BUCKET = 2;

const envelope = (result, status = 200) => ({
  status,
  body: { success: true, errors: [], messages: [], result },
});
const failure = (status, message, code = 10000) => ({
  status,
  body: { success: false, errors: [{ code, message }], messages: [], result: null },
});

export async function startFakeCloudflare({
  token = FAKE_CF_TOKEN,
  accountId = FAKE_CF_ACCOUNT,
  subdomain = FAKE_CF_SUBDOMAIN,
} = {}) {
  const state = {
    /** name → { metadata, modules: {name: text}, secrets: Map, workersDev, assets: Map path→hash, etag } */
    scripts: new Map(),
    /** hash → base64 content (the account's asset store). */
    stored: new Map(),
    /** upload JWT → { script, manifest, pending: Set<hash> } */
    sessions: new Map(),
    /** completion JWT → manifest */
    completions: new Map(),
    subdomain,
  };
  const requests = [];
  /** step → reply; steps: session, upload, script, secrets, subdomain, enable, delete. */
  const failures = new Map();

  const route = async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/client\/v4/, '');
    const auth = request.headers.get('authorization') ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const type = request.headers.get('content-type') ?? '';
    let json;
    let form;
    if (type.startsWith('application/json')) json = await request.json();
    else if (type.startsWith('multipart/form-data')) form = await request.formData();
    const formFields = form
      ? [...form.entries()].map(([name, value]) =>
          typeof value === 'string'
            ? { name, value }
            : { name, filename: value.name, type: value.type, size: value.size },
        )
      : undefined;
    requests.push({ method: request.method, path: path + url.search, json, formFields });

    const prefix = `/accounts/${accountId}/workers`;
    const step = (name) => failures.get(name);

    // Asset upload uses the session JWT, everything else the account token.
    if (request.method === 'POST' && path === `${prefix}/assets/upload`) {
      if (step('upload')) return step('upload');
      if (url.searchParams.get('base64') !== 'true') return failure(400, 'base64 must be true');
      const session = state.sessions.get(bearer);
      if (!session) return failure(401, 'Invalid upload token', 10001);
      for (const [hash, file] of form.entries()) {
        if (!session.pending.has(hash)) return failure(400, `Unexpected hash ${hash}`);
        const text = typeof file === 'string' ? file : await file.text();
        state.stored.set(hash, text);
        session.pending.delete(hash);
      }
      if (session.pending.size) return envelope({}, 200);
      const completion = 'completion-' + randomUUID();
      state.completions.set(completion, session.manifest);
      return envelope({ jwt: completion }, 201);
    }
    if (bearer !== token) return failure(401, 'Authentication error');
    if (!path.startsWith(prefix)) return failure(404, 'Not found', 7003);

    if (request.method === 'GET' && path === `${prefix}/subdomain`)
      return step('subdomain') ?? envelope({ subdomain: state.subdomain });

    const match = /^\/scripts\/([^/]+)(\/.*)?$/.exec(path.slice(prefix.length));
    if (!match) return failure(404, 'Not found', 7003);
    const [, name, rest = ''] = match;
    const script = state.scripts.get(name);

    if (request.method === 'POST' && rest === '/assets-upload-session') {
      if (step('session')) return step('session');
      const manifest = json?.manifest ?? {};
      const missing = [...new Set(Object.values(manifest).map((entry) => entry.hash))].filter(
        (hash) => !state.stored.has(hash),
      );
      const jwt = 'upload-' + randomUUID();
      state.sessions.set(jwt, { script: name, manifest, pending: new Set(missing) });
      if (!missing.length) state.completions.set(jwt, manifest);
      const buckets = [];
      for (let index = 0; index < missing.length; index += BUCKET)
        buckets.push(missing.slice(index, index + BUCKET));
      return envelope({ jwt, buckets });
    }

    if (request.method === 'PUT' && rest === '') {
      if (step('script')) return step('script');
      const metadataPart = form?.get('metadata');
      if (!metadataPart) return failure(400, 'No metadata part', 10021);
      const metadata = JSON.parse(
        typeof metadataPart === 'string' ? metadataPart : await metadataPart.text(),
      );
      const main = form.get(metadata.main_module);
      if (!main) return failure(400, 'main_module not found in upload', 10021);
      const manifest = state.completions.get(metadata.assets?.jwt);
      if (!manifest) return failure(400, 'Invalid assets completion token', 10021);
      const keepSecrets = (metadata.keep_bindings ?? []).includes('secret_text');
      const etag = createHash('sha256').update(randomUUID()).digest('hex');
      state.scripts.set(name, {
        metadata,
        modules: { [metadata.main_module]: typeof main === 'string' ? main : await main.text() },
        secrets: keepSecrets && script ? script.secrets : new Map(),
        workersDev: script?.workersDev ?? false,
        assets: new Map(Object.entries(manifest).map(([p, entry]) => [p, entry.hash])),
        etag,
      });
      return envelope({ id: name, etag, has_assets: true });
    }

    if (!script) return failure(404, 'This Worker does not exist on your account.', 10007);

    if (request.method === 'PUT' && rest === '/secrets') {
      if (step('secrets')) return step('secrets');
      if (json?.type !== 'secret_text' || !json.name) return failure(400, 'Bad secret');
      script.secrets.set(json.name, json.text);
      return envelope({ name: json.name, type: 'secret_text' });
    }
    if (request.method === 'POST' && rest === '/subdomain') {
      if (step('enable')) return step('enable');
      script.workersDev = json?.enabled === true;
      return envelope({ enabled: script.workersDev, previews_enabled: false });
    }
    if (request.method === 'DELETE' && rest === '') {
      if (step('delete')) return step('delete');
      state.scripts.delete(name);
      return envelope(null);
    }
    return failure(405, 'Method not allowed');
  };

  const server = createServer((incoming, outgoing) => {
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', async () => {
      try {
        const body = Buffer.concat(chunks);
        const request = new Request(`http://127.0.0.1${incoming.url}`, {
          method: incoming.method,
          headers: incoming.headers,
          body: body.length && !['GET', 'HEAD'].includes(incoming.method) ? body : undefined,
        });
        const reply = await route(request);
        outgoing.writeHead(reply.status, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify(reply.body));
      } catch (error) {
        outgoing.writeHead(500, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ success: false, errors: [{ message: String(error) }] }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    api: `http://127.0.0.1:${port}/client/v4`,
    accountId,
    token,
    state,
    requests,
    /** Makes one step answer `{status, message, code}` until cleared with `fail(step)`. */
    fail(step, reply) {
      if (!reply) failures.delete(step);
      else failures.set(step, failure(reply.status, reply.message, reply.code));
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
