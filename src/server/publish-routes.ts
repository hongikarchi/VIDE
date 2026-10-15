import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DomainError } from '../contracts/errors.ts';
import { publishRecordSchema, type PublishRecord } from '../contracts/publish.ts';
import {
  CloudflareDeployError,
  cloudflareDeployStatuses,
  deployPasswordSite,
  undeploy,
  workerNameOf,
  workerNamePattern,
} from './cloudflare-deploy.ts';
import {
  listPublicReports,
  readPublicReportFile,
  type PublicReportRow,
} from './workspace-outputs.ts';

/**
 * 보고용 게시 (PLAN-54 T-343, SPEC-07.11 공유 경로 둘, SPEC-04.14, SPEC-05.11, Design SCR-43,
 * ARCH-01 「외부 도메인 서비스」 사용자 계정 서비스):
 *
 * - `GET  /api/v1/projects/:p/outputs/:name/publish` → {published, passwordKept, defaultSiteName,
 *   siteLinked} — never the password.
 * - `POST /api/v1/projects/:p/outputs/:name/publish {target:'vide-site'|'cloudflare', siteName?,
 *   password?}` → {published}. `vide-site` uploads the 보고용 page and CSVs to the account site's
 *   password link (`/api/hosts/device/report-publications`, SPEC-04.14); `cloudflare` deploys the
 *   password-site template to the user's own account (cloudflare-deploy.ts). A `password` sets
 *   (or on a re-publish, changes) it and is sealed under `publish.<project>.<name>`; without one
 *   the sealed password is used for a first publish and the live one is kept on a re-publish.
 * - `POST …/unpublish` → removes it there; `publish.json` keeps the record with `revokedAt`.
 *
 * All writes are this PC's session only (remote 403). Only 보고용 files are sent (the folder's
 * `.html`/`.csv`/images; never `report.json`, `publish.json` or anything of 검토용).
 */

/** The account-site link of this PC (RemoteAccess). */
export interface SiteDevice {
  deviceFetch(path: string, method?: string, data?: unknown): Promise<Response | undefined>;
}
export interface PublishSecrets {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string | undefined): Promise<void>;
}
export interface PublishRouteDeps {
  dataDirectory: string;
  body: () => Promise<unknown>;
  send: (status: number, value: unknown) => void;
  remote: boolean;
  site: SiteDevice;
  /** Whether this PC is signed in to the VIDE account (the site link). */
  siteLinked?: () => Promise<boolean>;
  /** accountConnection(settings, 'cloudflare') (src/services/account-services.ts). */
  cloudflare: () => Promise<{
    api: string;
    token: string;
    accountId: string | null;
    timeoutMs: number;
  }>;
  secrets: PublishSecrets;
  /** The project's display name (throws NOT_FOUND for an unknown project). */
  projectName: (projectId: string) => string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /**
   * The project's output role folder now (`06_산출물`), or null. `publish.json` goes next to the
   * work folder copy only when that copy is directly inside it (ARCH-01: writes stay under the
   * work folder root). Omitted (tests), the recorded folder is trusted.
   */
  outputFolder?: (projectId: string) => Promise<string | null>;
}

export const publishStatuses: Record<string, number> = {
  ...cloudflareDeployStatuses,
  PUBLISH_PASSWORD_REQUIRED: 400,
  PUBLISH_TARGET_LIVE: 409,
  PUBLISH_NAME_LIVE: 409,
  NOT_PUBLISHED: 409,
};

/** Codes registered elsewhere (serviceSettingsStatuses) that a detailed reply needs here too. */
const ACCOUNT_STATUSES: Record<string, number> = {
  ACCOUNT_NOT_CONNECTED: 409,
  ACCOUNT_NOT_LINKED: 409,
  ACCOUNT_SCOPE: 403,
  SERVICE_UNREACHABLE: 502,
};
/** Upload kinds the site and the template both serve. */
const UPLOAD = /\.(html|csv|png|jpe?g|webp|svg)$/i;
const SECRET = (projectId: string, name: string) => `publish.${projectId}.${name}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** `<project>-<title>` kebab plus a short tag of the folder, so two outputs never share a Worker. */
export function defaultSiteName(
  projectName: string,
  title: string,
  projectId: string,
  name: string,
) {
  const tag = sha(`${projectId}/${name}`).slice(0, 6);
  const base = workerNameOf(projectName, title);
  return `${base.slice(0, 63 - tag.length - 1).replace(/-+$/, '')}-${tag}`;
}

export function validPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 || /\s/.test(value))
    throw new CloudflareDeployError('INVALID_PASSWORD');
  return value;
}

/** A failure with the service's one-line answer (Design SCR-43 '서비스 응답: <한 줄 요약>'). */
export class PublishError extends DomainError {
  detail?: string;
  constructor(code: string, detail?: string) {
    super(code);
    if (detail) this.detail = detail.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
}

const SITE_DETAIL: Record<string, string> = {
  UPLOADS_DISABLED: '사이트가 지금 새 업로드를 받지 않습니다',
  PROJECT_NOT_FOUND: '사이트에 이 프로젝트가 없습니다 — 계정 연결을 확인하세요',
  OWNER_REQUIRED: '프로젝트를 만든 계정만 게시할 수 있습니다',
  PUBLICATION_LIMIT: '파일이 너무 많거나 큽니다',
  PUBLICATION_NOT_FOUND: '사이트에 이전 게시가 없습니다',
};

async function siteCall(site: SiteDevice, path: string, method: string, data?: unknown) {
  let response: Response | undefined;
  try {
    response = await site.deviceFetch(path, method, data);
  } catch {
    throw new PublishError('SERVICE_UNREACHABLE');
  }
  if (!response) throw new PublishError('ACCOUNT_NOT_LINKED');
  const reply = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return reply;
  if (response.status === 401) throw new PublishError('ACCOUNT_NOT_LINKED');
  const code = typeof reply.error === 'string' ? reply.error : '';
  if (response.status >= 500 && !code) throw new PublishError('SERVICE_UNREACHABLE');
  throw new PublishError(
    'PUBLISH_FAILED',
    SITE_DETAIL[code] ?? `사이트가 받지 않았습니다 (${response.status})`,
  );
}

export interface SiteUpload {
  projectId: string;
  title: string;
  files: [string, Buffer][];
  /** Required for a new link; on a re-publish omitted = keep the live password. */
  password?: string;
  /** The publication to overwrite (다시 게시). */
  id?: string;
}
/**
 * Upload a 보고용 folder to the account site's password link (SPEC-04.14): start (or re-open) the
 * publication, send every file (big ones in parts), then switch the link to the new files.
 */
export async function publishToSite(site: SiteDevice, input: SiteUpload) {
  const base = '/report-publications';
  let started: Record<string, unknown>;
  try {
    started = await siteCall(site, base, 'POST', {
      projectId: input.projectId,
      title: input.title,
      ...(input.password !== undefined ? { password: input.password } : {}),
      ...(input.id ? { id: input.id } : {}),
    });
  } catch (error) {
    // The site lost the old one (removed on the site): a new link, with the password.
    if (
      !input.id ||
      !(error instanceof PublishError) ||
      error.detail !== SITE_DETAIL.PUBLICATION_NOT_FOUND ||
      input.password === undefined
    )
      throw error;
    started = await siteCall(site, base, 'POST', {
      projectId: input.projectId,
      title: input.title,
      password: input.password,
    });
  }
  const id = String(started.id);
  const partBytes = Number(started.partBytes) || 5 * 1024 * 1024;
  const at = `${base}/${encodeURIComponent(id)}`;
  for (const [path, bytes] of input.files) {
    const parts = Math.max(1, Math.ceil(bytes.length / partBytes));
    if (parts === 1) {
      await siteCall(site, `${at}/files`, 'PUT', { path, data: bytes.toString('base64') });
      continue;
    }
    const etags: string[] = [];
    let uploadId = '';
    for (let part = 1; part <= parts; part++) {
      const chunk = bytes.subarray((part - 1) * partBytes, part * partBytes);
      const reply = await siteCall(site, `${at}/files`, 'PUT', {
        path,
        data: chunk.toString('base64'),
        part,
        parts,
        ...(part > 1 ? { uploadId } : {}),
        ...(part === parts ? { etags } : {}),
      });
      if (part === 1) uploadId = String(reply.uploadId);
      if (part < parts) etags.push(String(reply.etag));
    }
  }
  const finished = await siteCall(site, `${at}/finish`, 'POST', {});
  return { id, url: String(finished.url ?? started.url) };
}

// --- the folder ----------------------------------------------------------------------------

async function outputOf(dataDirectory: string, projectId: string, name: string) {
  const row = (await listPublicReports(dataDirectory, projectId)).find((r) => r.name === name);
  if (!row) throw new DomainError('NOT_FOUND');
  return row;
}
const recordOf = (row: PublicReportRow): PublishRecord | null => {
  const parsed = publishRecordSchema.safeParse(row.published);
  return parsed.success ? parsed.data : null;
};
const live = (record: PublishRecord | null) => !!record && !record.revokedAt;

/** The work folder copy's marker line (`<!-- VIDE 사본 … vide-copy:… -->`) never goes online. */
export function withoutCopyMark(data: Buffer): Buffer {
  const text = data.toString('utf8');
  const stripped = text.replace(
    /^(\s*<!doctype[^>]*>\s*)?<!-- VIDE 사본 [^\n]*?vide-copy:[^\n]*?-->\n?/i,
    '$1',
  );
  return stripped === text ? data : Buffer.from(stripped, 'utf8');
}

async function uploadFiles(dataDirectory: string, projectId: string, row: PublicReportRow) {
  const files: [string, Buffer][] = [];
  for (const file of row.files.filter((f) => UPLOAD.test(f))) {
    const data = await readPublicReportFile(dataDirectory, projectId, row.name, file);
    if (data) files.push([file, file === 'index.html' ? withoutCopyMark(data) : data]);
  }
  if (!files.some(([f]) => f === 'index.html'))
    throw new CloudflareDeployError('INVALID_PUBLISH_FILES');
  // The page first, so a cut-off upload never leaves CSVs without it… and the site checks it.
  return files.sort(([a], [b]) =>
    a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b),
  );
}

/** `publish.json` next to the 보고용 copy in the data folder and, when written, the work folder. */
async function writeRecord(
  deps: Pick<PublishRouteDeps, 'dataDirectory' | 'outputFolder'>,
  projectId: string,
  row: PublicReportRow,
  record: PublishRecord,
) {
  const text = JSON.stringify(record, null, 2) + '\n';
  await writeFile(
    join(deps.dataDirectory, 'projects', projectId, 'outputs', row.name, 'publish.json'),
    text,
    'utf8',
  );
  if (!row.folder) return;
  if (deps.outputFolder) {
    const output = await deps.outputFolder(projectId).catch(() => null);
    const inside = output ? relative(resolve(output), resolve(row.folder)) : '';
    // Only a folder directly inside the output role (no `..`, no deeper path, not elsewhere).
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || /[\\/]/.test(inside)) return;
  }
  await writeFile(join(row.folder, 'publish.json'), text, 'utf8').catch(() => {});
}

function sourceRunOf(row: PublicReportRow): PublishRecord['sourceRun'] {
  const run = row.sourceRun;
  if (!run || typeof run.instanceId !== 'string') return null;
  return {
    instanceId: run.instanceId,
    jigId: typeof run.jigId === 'string' ? run.jigId : '',
    ...(typeof run.version === 'number' ? { version: run.version } : {}),
    ...(typeof run.reportId === 'string' ? { report: run.reportId } : {}),
    ...(typeof run.at === 'string' ? { at: run.at } : {}),
  };
}

// --- routes --------------------------------------------------------------------------------

const PATH = /^\/api\/v1\/projects\/([^/]+)\/outputs\/([^/]+)\/(publish|unpublish)$/;

export async function publishRoutes(
  url: URL,
  method: string,
  deps: PublishRouteDeps,
): Promise<boolean> {
  const match = PATH.exec(url.pathname);
  if (!match) return false;
  const projectId = match[1];
  let name: string;
  try {
    name = decodeURIComponent(match[2]);
  } catch {
    throw new DomainError('NOT_FOUND');
  }
  const action = match[3];
  const projectName = deps.projectName(projectId);
  const row = await outputOf(deps.dataDirectory, projectId, name);
  const record = recordOf(row);
  if (action === 'publish' && method === 'GET') {
    deps.send(200, {
      published: record,
      passwordKept: !!(await deps.secrets.get(SECRET(projectId, name))),
      defaultSiteName: defaultSiteName(projectName, row.title, projectId, name),
      siteLinked: deps.siteLinked ? await deps.siteLinked().catch(() => false) : true,
    });
    return true;
  }
  if (method !== 'POST') return false;
  // FR-18, SPEC-05.11: a person on this PC presses [게시]/[내리기]; never a remote session.
  if (deps.remote) throw new DomainError('FORBIDDEN');
  try {
    if (action === 'unpublish') {
      if (!record || !live(record)) throw new DomainError('NOT_PUBLISHED');
      if (record.target === 'vide-site') {
        if (record.publicationId)
          await siteCall(
            deps.site,
            `/report-publications/${encodeURIComponent(record.publicationId)}`,
            'DELETE',
          );
      } else if (!record.workerName) {
        // A broken record names no Worker: mark it down here and say what to do by hand.
        await writeRecord(deps, projectId, row, {
          ...record,
          revokedAt: (deps.now?.() ?? new Date()).toISOString(),
        });
        throw new PublishError(
          'PUBLISH_FAILED',
          '게시 기록에 사이트 이름이 없습니다 — Cloudflare 대시보드에서 직접 내리세요',
        );
      } else {
        const cf = await deps.cloudflare();
        await undeploy({
          api: cf.api,
          accountId: cf.accountId ?? '',
          token: cf.token,
          name: record.workerName,
          fetchImpl: deps.fetchImpl,
          timeoutMs: cf.timeoutMs,
        });
      }
      const revoked: PublishRecord = {
        ...record,
        revokedAt: (deps.now?.() ?? new Date()).toISOString(),
      };
      await writeRecord(deps, projectId, row, revoked);
      deps.send(200, { published: revoked });
      return true;
    }
    const input = ((await deps.body()) ?? {}) as Record<string, unknown>;
    const target = input.target;
    if (target !== 'vide-site' && target !== 'cloudflare') throw new DomainError('INVALID_INPUT');
    // One live place per 보고용 (publish.json holds one record): take the other one down first.
    if (live(record) && record!.target !== target) throw new DomainError('PUBLISH_TARGET_LIVE');
    const typed =
      input.password === undefined || input.password === null
        ? undefined
        : validPassword(input.password);
    const key = SECRET(projectId, name);
    const sealed = await deps.secrets.get(key);
    const again = live(record) && record!.target === target;
    // A new place needs a password; a re-publish keeps the live one unless a new one was made.
    const password = typed ?? (again ? undefined : sealed);
    if (!again && password === undefined) throw new DomainError('PUBLISH_PASSWORD_REQUIRED');
    const files = await uploadFiles(deps.dataDirectory, projectId, row);
    const publishedAt = (deps.now?.() ?? new Date()).toISOString();
    let next: PublishRecord;
    if (target === 'vide-site') {
      const done = await publishToSite(deps.site, {
        projectId,
        title: row.title,
        files,
        ...(again && record!.publicationId ? { id: record!.publicationId } : {}),
        // Re-publish: only a changed password goes; the fallback for a lost link is the sealed one.
        password: typed ?? (again ? undefined : password),
      }).catch(async (error) => {
        // A re-publish whose link the site no longer has: a new link with the sealed password.
        if (
          again &&
          typed === undefined &&
          sealed &&
          error instanceof PublishError &&
          error.detail === SITE_DETAIL.PUBLICATION_NOT_FOUND
        )
          return publishToSite(deps.site, { projectId, title: row.title, files, password: sealed });
        throw error;
      });
      next = {
        target,
        url: done.url,
        publishedAt,
        passwordSet: true,
        sourceRun: sourceRunOf(row),
        publicationId: done.id,
      };
    } else {
      const siteName =
        typeof input.siteName === 'string' && input.siteName.trim()
          ? input.siteName.trim()
          : again && record!.workerName
            ? record!.workerName
            : defaultSiteName(projectName, row.title, projectId, name);
      if (!workerNamePattern.test(siteName)) throw new CloudflareDeployError('INVALID_SITE_NAME');
      // One 보고용 = one address: a live Worker is renamed only after [내리기]; otherwise the old
      // one would stay open with no record left to take it down.
      if (again && record!.workerName && record!.workerName !== siteName)
        throw new DomainError('PUBLISH_NAME_LIVE');
      const sameWorker = again && record!.workerName === siteName;
      // A new Worker has no secret to keep: it needs the typed or the sealed password.
      const workerPassword = typed ?? (sameWorker ? undefined : (password ?? sealed));
      if (!sameWorker && workerPassword === undefined)
        throw new DomainError('PUBLISH_PASSWORD_REQUIRED');
      const cf = await deps.cloudflare();
      if (!cf.accountId) throw new DomainError('ACCOUNT_NOT_CONNECTED');
      const done = await deployPasswordSite({
        api: cf.api,
        accountId: cf.accountId,
        token: cf.token,
        name: siteName,
        files: new Map(files),
        password: workerPassword,
        fetchImpl: deps.fetchImpl,
        timeoutMs: cf.timeoutMs,
      });
      next = {
        target,
        url: done.url,
        workerName: done.workerName,
        publishedAt,
        passwordSet: true,
        sourceRun: sourceRunOf(row),
      };
    }
    if (typed !== undefined) await deps.secrets.set(key, typed);
    await writeRecord(deps, projectId, row, next);
    deps.send(200, { published: next });
    return true;
  } catch (error) {
    // A service answer goes to the screen as one line (Design SCR-43); other errors as usual.
    const detail =
      error instanceof CloudflareDeployError || error instanceof PublishError
        ? error.detail
        : undefined;
    if (detail && error instanceof DomainError) {
      // `reason` is the screen's sentence (the UI's api() shows it as the error's message).
      deps.send({ ...publishStatuses, ...ACCOUNT_STATUSES }[error.code] ?? 502, {
        code: error.code,
        detail,
        ...(error.code === 'PUBLISH_FAILED'
          ? { reason: `올리지 못했습니다 — 서비스 응답: ${detail}` }
          : {}),
      });
      return true;
    }
    throw error;
  }
}
