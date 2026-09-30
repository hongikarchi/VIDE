// Jig authoring routes (ARCH-03 §7 `jig-drafts`, PLAN-22 T-063): the drafts of the
// make-conversation. `server.ts` delegates `/api/v1/projects/:id/jig-drafts…` here. Validate,
// test and preview run on the draft folder (AI-written steps only in the compute box); pin is a
// confirmed action (SPEC-02.19 T2) that remote sessions may not take; delete removes the draft
// folder and the provider transcripts of the draft's conversations.

import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type { Workspace } from '../core/workspace.ts';
import { DRAFT_TEMPLATES, JigDrafts } from '../jigs/runtime/drafts.ts';
import { JigInvalidError } from '../jigs/runtime/loader.ts';
import type { ConversationService } from './conversations.ts';
import { jigRuntimeFor } from './jig-routes.ts';

export interface MakeRouteContext {
  workspace: Workspace;
  body: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  send: (status: number, data: unknown) => void;
  /** The engine's data folder (`<data>` of ARCH-03 §2.3). */
  dataDirectory: string;
  /** The request came through the remote tunnel: pinning is refused. */
  remote?: boolean;
  /** Removes the transcripts of a discarded draft's conversations. */
  conversations?: Pick<ConversationService, 'store' | 'close' | 'purge'>;
}

/** HTTP statuses of the draft error codes; server.ts merges them into its table. */
export const makeStatuses: Record<string, number> = {
  DRAFT_NOT_OPEN: 409,
  DRAFT_OUTSIDE: 422,
  DRAFT_FORBIDDEN_FILE: 422,
  DRAFT_PATH_INVALID: 422,
  DRAFT_TEMPLATE_MISSING: 500,
};

const id = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/);
const createInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    from: z.enum(DRAFT_TEMPLATES).optional(),
  })
  .strict();
const previewInput = z
  .object({
    fixture: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}$/)
      .optional(),
  })
  .strict();
const pinInput = z
  .object({
    jigId: z.string().max(200).optional(),
    version: z.string().max(50).optional(),
    approvedCaps: z.array(z.string().max(40)).max(20).optional(),
    confirm: z.literal(true).optional(),
  })
  .strict();

/** The draft store of an engine (its database and data folder). */
export function draftsFor(workspace: Workspace, dataDirectory: string) {
  return new JigDrafts({
    db: workspace.store.db,
    dataDir: dataDirectory,
    onInstalled: (jigId, version) =>
      jigRuntimeFor(workspace, dataDirectory).registry.forget(jigId, version),
  });
}

/** Answers `/api/v1/projects/:id/jig-drafts…`; false when the request is not one. */
export async function makeRoutes(
  url: URL,
  request: IncomingMessage,
  context: MakeRouteContext,
): Promise<boolean> {
  const route =
    /^\/api\/v1\/projects\/([^/]+)\/jig-drafts(?:\/([^/]+)(?:\/(validate|test|preview|pin))?)?$/.exec(
      url.pathname,
    );
  if (!route) return false;
  const { workspace, body, send, remote = false } = context;
  const method = request.method ?? 'GET';
  const [, projectId, rawDraft, action] = route;
  workspace.store.project(projectId);
  const drafts = draftsFor(workspace, context.dataDirectory);
  if (!rawDraft) {
    if (method === 'GET') {
      send(200, { drafts: drafts.list(projectId) });
      return true;
    }
    if (method !== 'POST') return false;
    const input = createInput.parse(await body(request));
    send(201, drafts.create(projectId, input));
    return true;
  }
  const draftId = id.parse(rawDraft);
  if (!action) {
    if (method === 'GET') {
      send(200, drafts.get(projectId, draftId));
      return true;
    }
    if (method !== 'DELETE') return false;
    const draft = drafts.discard(projectId, draftId);
    let transcriptsRemoved = 0;
    const service = context.conversations;
    if (service)
      for (const conversation of service.store.list(projectId))
        if (conversation.draftId === draftId) {
          if (conversation.state === 'open') await service.close(projectId, conversation.id);
          transcriptsRemoved += await service.purge(conversation.id);
        }
    send(200, { draft, transcriptsRemoved });
    return true;
  }
  if (method !== 'POST') return false;
  if (action === 'validate') send(200, await drafts.validate(projectId, draftId));
  else if (action === 'test') send(200, await drafts.test(projectId, draftId));
  else if (action === 'preview')
    send(200, await drafts.preview(projectId, draftId, previewInput.parse(await body(request))));
  else {
    if (remote) throw new DomainError('FORBIDDEN');
    const input = pinInput.parse(await body(request));
    if (!input.confirm) throw new DomainError('CONFIRMATION_REQUIRED');
    try {
      send(200, await drafts.pin(projectId, draftId, input));
    } catch (error) {
      if (error instanceof JigInvalidError) {
        send(422, { code: 'JIG_INVALID', issues: error.issues });
        return true;
      }
      throw error;
    }
  }
  return true;
}
