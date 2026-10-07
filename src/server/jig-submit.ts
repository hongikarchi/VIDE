// jig 관리자 제출 (ADR-041, SPEC-07.19, ARCH-01 §6 「jig 관리자 제출」, PLAN-43 T-201). A draft of the
// make screen or a project jig installed on this PC is packed with the existing pack code (format
// check, this PC's signature; no bundle, no self-test — the admin runs the tests in the
// repository) and sent with a note to the account site's admin box with this PC's host key.
// Sending is a confirmed action (SPEC-02.19 T2) that remote sessions may not take; the list shows
// only this account's submissions as the site answers them.
//
//   POST /api/v1/jig-submissions {projectId, draftId} | {jigId, version}, note?, confirm: true
//   GET  /api/v1/jig-submissions → {linked, online, submissions, error?}

import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type { Workspace } from '../core/workspace.ts';
import { JigStore } from '../core/jig-store.ts';
import { JigInvalidError } from '../jigs/runtime/loader.ts';
import { validateDraftDir } from '../jigs/runtime/drafts.ts';
import type { JigSource } from '../jigs/runtime/manifest.ts';
import { packJig, validateJig } from '../jigs/runtime/pack.ts';
import { draftsFor } from './make-routes.ts';

/** The largest pack sent (the site's default cap). */
export const SUBMISSION_MAX_BYTES = 8 * 1024 * 1024;
export const NOTE_MAX = 2000;

/** The account site as this route uses it (RemoteAccess; a fake in tests). */
export interface JigSubmitSite {
  uploadJigSubmission(
    meta: { jigId: string; version: string; name: string; note: string },
    bytes: Uint8Array,
  ): Promise<{ submission: unknown } | { error: string }>;
  deviceFetch(path: string, method?: string, data?: unknown): Promise<Response | undefined>;
}
export interface JigSubmitContext {
  workspace: Workspace;
  body: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  send: (status: number, data: unknown) => void;
  dataDirectory: string;
  /** The request came through the remote tunnel: sending is refused. */
  remote?: boolean;
  site?: JigSubmitSite;
}

/** HTTP statuses of the submission codes; server.ts merges them into its table. */
export const jigSubmitStatuses: Record<string, number> = {
  ACCOUNT_NOT_LINKED: 409,
  ACCOUNT_UNLINKED: 409,
  JIG_SUBMISSION_TOO_LARGE: 413,
  JIG_SUBMISSIONS_FULL: 429,
  JIG_PACK_INVALID: 422,
  JIG_SUBMIT_FAILED: 502,
  UPLOADS_DISABLED: 503,
};

const note = z.string().max(NOTE_MAX).optional();
const submitInput = z.union([
  z
    .object({
      projectId: z.string().min(1).max(100),
      draftId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
      note,
      confirm: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      jigId: z.string().min(1).max(200),
      version: z.string().min(1).max(50),
      note,
      confirm: z.literal(true).optional(),
    })
    .strict(),
]);

/** Pack what the input names: a draft folder of a project or an installed project jig. */
async function packFor(
  input: z.infer<typeof submitInput>,
  workspace: Workspace,
  dataDirectory: string,
) {
  let dir: string, source: JigSource;
  if ('draftId' in input) {
    workspace.store.project(input.projectId);
    dir = draftsFor(workspace, dataDirectory).dir(input.projectId, input.draftId);
    source = 'ai-draft';
    const report = await validateDraftDir(dir);
    if (!report.ok) throw new JigInvalidError(report.issues);
  } else {
    // Only a jig installed on this PC; official and checkout jigs are in the repository already.
    const row = new JigStore(workspace.store).package(input.jigId, input.version);
    dir = row.path;
    source = row.source;
    const report = await validateJig(dir, { source });
    if (!report.ok) throw new JigInvalidError(report.issues);
  }
  return packJig(dir, { dataDir: dataDirectory, bundle: false, skipTests: true, source });
}

/** Answers `/api/v1/jig-submissions`; false when the request is not one. */
export async function jigSubmitRoutes(
  url: URL,
  request: IncomingMessage,
  context: JigSubmitContext,
): Promise<boolean> {
  if (url.pathname !== '/api/v1/jig-submissions') return false;
  const { send, site } = context;
  const method = request.method ?? 'GET';
  if (method === 'GET') {
    let response: Response | undefined;
    try {
      response = await site?.deviceFetch('/jig-submissions');
    } catch {
      send(200, { linked: true, online: false, error: 'SITE_UNREACHABLE', submissions: [] });
      return true;
    }
    if (!response) {
      send(200, { linked: false, online: false, submissions: [] });
      return true;
    }
    const reply = (await response.json().catch(() => ({}))) as {
      submissions?: unknown;
      error?: unknown;
    };
    if (!response.ok || !Array.isArray(reply.submissions)) {
      send(200, {
        linked: response.status !== 401,
        online: true,
        error:
          response.status === 401
            ? 'ACCOUNT_UNLINKED'
            : typeof reply.error === 'string'
              ? reply.error
              : 'JIG_SUBMIT_FAILED',
        submissions: [],
      });
      return true;
    }
    send(200, { linked: true, online: true, submissions: reply.submissions });
    return true;
  }
  if (method !== 'POST') return false;
  if (context.remote) throw new DomainError('FORBIDDEN');
  const input = submitInput.parse(await context.body(request));
  if (!input.confirm) throw new DomainError('CONFIRMATION_REQUIRED');
  if (!site) throw new DomainError('ACCOUNT_NOT_LINKED');
  let packed;
  try {
    packed = await packFor(input, context.workspace, context.dataDirectory);
  } catch (error) {
    if (error instanceof JigInvalidError) {
      send(422, { code: 'JIG_INVALID', issues: error.issues });
      return true;
    }
    throw error;
  }
  if (packed.bytes.length > SUBMISSION_MAX_BYTES) throw new DomainError('JIG_SUBMISSION_TOO_LARGE');
  const reply = await site.uploadJigSubmission(
    {
      jigId: packed.jig.id,
      version: packed.jig.version,
      name: packed.jig.manifest.name,
      note: (input.note ?? '').trim(),
    },
    packed.bytes,
  );
  if ('error' in reply) throw new DomainError(reply.error);
  send(201, { submission: reply.submission, size: packed.bytes.length });
  return true;
}
