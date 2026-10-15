// Cloudflare 게시 (PLAN-54 T-347, SPEC-05.11 Cloudflare 행, ARCH-01 「게시 템플릿」, Design SCR-43):
// a report folder goes to a Worker in the person's own account with the password-site template
// (`src/sharing/deploy-templates/password-site/worker.js`) in front of its static files — through
// the Cloudflare REST API only, without wrangler (SPIKE-2026-10-15-cloudflare-api-deploy).
//
// Order: assets upload session → upload the buckets the API asks for → script upload (worker.js
// + metadata with the completion JWT) → secrets (REPORT_PASSWORD, SESSION_SECRET) → workers.dev.
// The token goes only to the API base in the Authorization header. The password and the session
// key go only to the secrets endpoint — never into script metadata, a thrown error or a log.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { DomainError } from '../contracts/errors.ts';
export type { PublishRecord, PublishSourceRun } from '../contracts/publish.ts';
export { publishRecordSchema } from '../contracts/publish.ts';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
/** Cloudflare's per-file limit for Worker static assets (both plans). */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
/** Files per Worker version on the free plan (paid: 100,000). */
export const MAX_ASSET_FILES = 20_000;

const TEMPLATE = new URL('../sharing/deploy-templates/password-site/', import.meta.url);

/**
 * Codes this module throws that need an HTTP status (spread into server.ts `statuses`). It also
 * throws SERVICE_UNREACHABLE (502, serviceSettingsStatuses), and ACCOUNT_NOT_CONNECTED /
 * ACCOUNT_SCOPE like the GitHub client (T-344/T-346 register those).
 */
export const cloudflareDeployStatuses: Record<string, number> = {
  INVALID_SITE_NAME: 400,
  INVALID_ACCOUNT_ID: 400,
  INVALID_PASSWORD: 400,
  INVALID_PUBLISH_FILES: 400,
  PUBLISH_TOO_LARGE: 413,
  PUBLISH_FAILED: 502,
};

/** A failed publish with the API's first error message (one line, for '서비스 응답: <요약>'). */
export class CloudflareDeployError extends DomainError {
  detail?: string;
  constructor(code: string, detail?: string) {
    super(code);
    if (detail) this.detail = detail.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
}

/** Worker script names: lowercase ASCII kebab, 1–63 (it is also the workers.dev host label). */
export const workerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The default site name for a report: lowercase kebab of its ASCII part, ≤ 63. */
export function workerNameOf(...parts: string[]): string {
  const name = parts
    .join('-')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return name || 'vide-report';
}

/** The template's `compatibility_date` (one place to bump it, shared with the hand-deploy file). */
export function templateCompatibilityDate(): string {
  const text = readFileSync(new URL('wrangler.template.jsonc', TEMPLATE), 'utf8');
  const date = /"compatibility_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/.exec(text)?.[1];
  if (!date) throw new Error('password-site template has no compatibility_date');
  return date;
}

/** The template's Worker module, uploaded unchanged. */
export function templateWorker(): string {
  return readFileSync(new URL('worker.js', TEMPLATE), 'utf8');
}

export interface CloudflareTarget {
  /** REST base (`https://api.cloudflare.com/client/v4`); tests point it at a fake server. */
  api?: string;
  accountId: string;
  token: string;
  /** Worker script name (see workerNamePattern). */
  name: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DeployPasswordSiteInput extends CloudflareTarget {
  /** Report folder files by relative path ('index.html', 'img/a.png'); '/' separators. */
  files: Map<string, Buffer | string>;
  /**
   * The site password. Omitted on a re-publish to keep the previous one: the script upload keeps
   * existing secret bindings (`keep_bindings: ['secret_text']`) and no secret is sent.
   */
  password?: string;
  /** Cookie signing key; a new random one when the password is set and this is omitted. */
  sessionSecret?: string;
  /** Asset paths served without a password (e.g. ['/logo.png']). Default none. */
  publicPaths?: string[];
}

export interface DeployResult {
  url: string;
  workerName: string;
  /** The uploaded script's etag, when the API returns one. */
  scriptVersion?: string;
  /** Whether this call set the password (false = the previous one was kept). */
  passwordChanged: boolean;
}

interface Envelope {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: unknown;
}

function client(target: CloudflareTarget) {
  if (!workerNamePattern.test(target.name)) throw new CloudflareDeployError('INVALID_SITE_NAME');
  if (!/^[0-9a-f]{32}$/i.test(target.accountId))
    throw new CloudflareDeployError('INVALID_ACCOUNT_ID');
  const base = (target.api ?? CLOUDFLARE_API).replace(/\/+$/, '');
  const fetcher = target.fetchImpl ?? fetch;
  const timeoutMs = target.timeoutMs ?? 120_000;
  const account = `/accounts/${target.accountId}`;
  const script = `${account}/workers/scripts/${target.name}`;

  async function call(
    path: string,
    init: { method: string; json?: unknown; form?: FormData; bearer?: string },
  ): Promise<{ status: number; body: Envelope | null }> {
    let response: Response;
    try {
      response = await fetcher(base + path, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${init.bearer ?? target.token}`,
          ...(init.json === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CloudflareDeployError('SERVICE_UNREACHABLE');
    }
    const body = (await response.json().catch(() => null)) as Envelope | null;
    return { status: response.status, body };
  }

  /** Refuses a failed call; returns the envelope's `result`. */
  function ok(reply: { status: number; body: Envelope | null }, okStatus = [200, 201]): unknown {
    if (okStatus.includes(reply.status) && reply.body?.success !== false) return reply.body?.result;
    const first = reply.body?.errors?.[0];
    const detail = first?.message
      ? first.code
        ? `${first.message} (${first.code})`
        : first.message
      : undefined;
    if (reply.status === 401) throw new CloudflareDeployError('ACCOUNT_NOT_CONNECTED', detail);
    if (reply.status === 403) throw new CloudflareDeployError('ACCOUNT_SCOPE', detail);
    if (reply.status >= 500 && !detail) throw new CloudflareDeployError('SERVICE_UNREACHABLE');
    throw new CloudflareDeployError('PUBLISH_FAILED', detail ?? `HTTP ${reply.status}`);
  }

  return { call, ok, account, script };
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
};
const contentType = (path: string) =>
  CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

interface Asset {
  path: string;
  hash: string;
  bytes: Buffer;
}

/** The manifest: '/'-rooted paths, SHA-256 hex cut to 32 chars (the API's asset hash), size. */
export function assetManifest(files: Map<string, Buffer | string>): Asset[] {
  if (files.size === 0)
    throw new CloudflareDeployError('INVALID_PUBLISH_FILES', '올릴 파일이 없습니다');
  if (files.size > MAX_ASSET_FILES)
    throw new CloudflareDeployError('PUBLISH_TOO_LARGE', `파일 ${files.size}개`);
  const assets: Asset[] = [];
  const seen = new Set<string>();
  for (const [name, content] of files) {
    const parts = name.replace(/^\/+/, '').split('/');
    if (
      name.includes('\\') ||
      parts.some((part) => !part || part === '.' || part === '..') ||
      /[\0-\x1f]/.test(name)
    )
      throw new CloudflareDeployError('INVALID_PUBLISH_FILES', name);
    const path = '/' + parts.join('/');
    if (seen.has(path)) throw new CloudflareDeployError('INVALID_PUBLISH_FILES', name);
    seen.add(path);
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (bytes.length > MAX_ASSET_BYTES)
      throw new CloudflareDeployError('PUBLISH_TOO_LARGE', path.slice(1));
    // The documented asset hash (Direct Upload sample): SHA-256 of the base64 text + the extension
    // without its dot, first 32 hex characters. Unchanged files are then skipped by the API.
    const hash = createHash('sha256')
      .update(bytes.toString('base64') + extname(path).slice(1))
      .digest('hex')
      .slice(0, 32);
    assets.push({ path, hash, bytes });
  }
  return assets;
}

/**
 * Publishes (or re-publishes over) a password-protected report site. Rejects with a
 * CloudflareDeployError: INVALID_SITE_NAME, INVALID_ACCOUNT_ID, INVALID_PASSWORD,
 * INVALID_PUBLISH_FILES, PUBLISH_TOO_LARGE (25 MiB a file, 20,000 files),
 * ACCOUNT_NOT_CONNECTED (401), ACCOUNT_SCOPE (403 — the token may not edit Workers),
 * PUBLISH_FAILED (with the API's first error message in `detail`), SERVICE_UNREACHABLE.
 */
export async function deployPasswordSite(input: DeployPasswordSiteInput): Promise<DeployResult> {
  const { call, ok, account, script } = client(input);
  const assets = assetManifest(input.files);
  if (input.password !== undefined && !input.password)
    throw new CloudflareDeployError('INVALID_PASSWORD');

  // 1. Upload session: the API answers with the hashes it does not have yet, in buckets.
  const session = ok(
    await call(`${script}/assets-upload-session`, {
      method: 'POST',
      json: {
        manifest: Object.fromEntries(
          assets.map((asset) => [asset.path, { hash: asset.hash, size: asset.bytes.length }]),
        ),
      },
    }),
  ) as { jwt?: unknown; buckets?: unknown } | undefined;
  if (typeof session?.jwt !== 'string')
    throw new CloudflareDeployError('PUBLISH_FAILED', 'upload session without a token');
  const buckets = Array.isArray(session.buckets) ? (session.buckets as unknown[]) : [];

  // 2. Upload each bucket with the session JWT; the last answer (201) carries the completion JWT.
  //    Nothing to upload → the session JWT is the completion JWT.
  let completion = session.jwt;
  const byHash = new Map(assets.map((asset) => [asset.hash, asset]));
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    const form = new FormData();
    for (const hash of bucket) {
      const asset = byHash.get(String(hash));
      if (!asset) throw new CloudflareDeployError('PUBLISH_FAILED', 'unknown asset hash');
      form.append(
        asset.hash,
        new File([asset.bytes.toString('base64')], asset.hash, { type: contentType(asset.path) }),
        asset.hash,
      );
    }
    const uploaded = ok(
      await call(`${account}/workers/assets/upload?base64=true`, {
        method: 'POST',
        form,
        bearer: session.jwt,
      }),
    ) as { jwt?: unknown } | undefined;
    if (typeof uploaded?.jwt === 'string') completion = uploaded.jwt;
  }

  // 3. The script: the template module + metadata. Secrets are kept across re-publishes by
  //    `keep_bindings`; none is sent here.
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: templateCompatibilityDate(),
    assets: {
      jwt: completion,
      config: {
        run_worker_first: true,
        html_handling: 'auto-trailing-slash',
        not_found_handling: 'none',
      },
    },
    bindings: [
      { type: 'assets', name: 'ASSETS' },
      { type: 'plain_text', name: 'PUBLIC_PATHS', text: (input.publicPaths ?? []).join(',') },
    ],
    keep_bindings: ['secret_text'],
  };
  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
    'metadata.json',
  );
  form.append(
    'worker.js',
    new File([templateWorker()], 'worker.js', { type: 'application/javascript+module' }),
    'worker.js',
  );
  const uploadedScript = ok(await call(script, { method: 'PUT', form })) as
    | { etag?: unknown }
    | undefined;

  // 4. Secrets, one PUT each (each replaces the previous value).
  if (input.password !== undefined) {
    const secrets = {
      REPORT_PASSWORD: input.password,
      SESSION_SECRET: input.sessionSecret ?? randomBytes(48).toString('hex'),
    };
    for (const [name, text] of Object.entries(secrets))
      ok(
        await call(`${script}/secrets`, {
          method: 'PUT',
          json: { name, text, type: 'secret_text' },
        }),
      );
  }

  // 5. The workers.dev address: the account's subdomain + turn the script's route on.
  const subdomain = ok(await call(`${account}/workers/subdomain`, { method: 'GET' })) as
    | { subdomain?: unknown }
    | undefined;
  if (typeof subdomain?.subdomain !== 'string' || !subdomain.subdomain)
    throw new CloudflareDeployError('PUBLISH_FAILED', 'workers.dev 하위 도메인이 없습니다');
  ok(
    await call(`${script}/subdomain`, {
      method: 'POST',
      json: { enabled: true, previews_enabled: false },
    }),
  );

  return {
    url: `https://${input.name}.${subdomain.subdomain}.workers.dev/`,
    workerName: input.name,
    ...(typeof uploadedScript?.etag === 'string' ? { scriptVersion: uploadedScript.etag } : {}),
    passwordChanged: input.password !== undefined,
  };
}

/** [내리기]: deletes the Worker (its assets and secrets go with it). A missing one is fine. */
export async function undeploy(target: CloudflareTarget): Promise<{ removed: boolean }> {
  const { call, ok, script } = client(target);
  const reply = await call(`${script}?force=true`, { method: 'DELETE' });
  if (reply.status === 404) return { removed: false };
  ok(reply);
  return { removed: true };
}
