// Jig authoring routes (ARCH-03 §7 `jig-drafts`, PLAN-22 T-063): the drafts of the
// make-conversation. `server.ts` delegates `/api/v1/projects/:id/jig-drafts…` here. Validate,
// test and preview run on the draft folder (AI-written steps only in the compute box); pin is a
// confirmed action (SPEC-02.19 T2) that remote sessions may not take; delete removes the draft
// folder and the provider transcripts of the draft's conversations.

import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type { Workspace } from '../core/workspace.ts';
import { JigStore } from '../core/jig-store.ts';
import { DRAFT_LIMITS, DRAFT_TEMPLATES, JigDrafts, failureReason } from '../jigs/runtime/drafts.ts';
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
  MAKE_STOPPED: 409,
};

const id = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/);
/**
 * A new draft: from a starting example (`name` required), or with `from: {jig, version?}` a copy of
 * an installed or checkout jig ([수정하기], PLAN-26 T-101; the version defaults to the one pinned
 * to this project, and the name is the jig's).
 */
const createInput = z.union([
  z
    .object({
      name: z.string().trim().min(1).max(100),
      from: z.enum(DRAFT_TEMPLATES).optional(),
    })
    .strict(),
  z
    .object({
      from: z
        .object({ jig: z.string().min(1).max(200), version: z.string().max(50).optional() })
        .strict(),
    })
    .strict(),
]);
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
    /^\/api\/v1\/projects\/([^/]+)\/jig-drafts(?:\/([^/]+)(?:\/(validate|test|preview|pin|icon))?)?$/.exec(
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
    if ('name' in input) {
      send(201, drafts.create(projectId, input));
      return true;
    }
    const { jig: jigId, version } = input.from;
    const pinned = new JigStore(workspace.store.db)
      .pinned(projectId)
      .find((row) => row.jigId === jigId);
    const jig = await jigRuntimeFor(workspace, context.dataDirectory).registry.resolve(
      jigId,
      version ?? pinned?.version,
    );
    if (jig.manifest.kind !== 'tool') throw new DomainError('INVALID_INPUT');
    send(
      201,
      drafts.fork(projectId, {
        dir: jig.dir,
        id: jig.id,
        version: jig.version,
        name: jig.manifest.name,
      }),
    );
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
  // The draft's icon (PLAN-26 T-100): a name from the fixed list into its jig.json.
  if (action === 'icon') {
    if (method !== 'PUT') return false;
    const { icon } = z
      .object({ icon: z.string().max(40) })
      .strict()
      .parse(await body(request));
    send(200, drafts.setIcon(projectId, draftId, icon));
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

// --- make-conversation turns (SPEC-07.9 상한과 멈춤, PLAN-22 T-063) -------------------------------

/** The budget of every make turn, the answer turn of its question cards included (SPEC-07.9). */
export const MAKE_LIMITS = { maxToolCalls: 100, maxHostCommands: 12, timeoutSeconds: 600 } as const;
/** A make-conversation asks to start over after this many turns (and every as many after). */
export const MAKE_TURN_CAP = 20;
/** Validate/test failures for the same reason in a row that stop the turn. */
export const MAKE_FAILURE_STREAK = 3;
/** Why a make turn stopped instead of going on. */
export type MakeStop =
  | { reason: 'failures'; count: number; detail: string[] }
  | { reason: 'turn-cap'; turns: number };
type CheckReport = Parameters<typeof failureReason>[0];

/** The readable lines of a failed report: issue messages or failing cases (at most five). */
function failureLines(report: CheckReport): string[] {
  const issues = (report.issues ?? []).filter((entry) => entry.level !== 'warn');
  if (issues.length) return issues.slice(0, 5).map((entry) => entry.message.slice(0, 200));
  return (report.cases ?? [])
    .filter((entry) => !entry.ok)
    .slice(0, 5)
    .map((entry) =>
      `${entry.name}: ${entry.error?.split('\n')[0] ?? entry.mismatches.map((m) => m.path).join(', ')}`.slice(
        0,
        200,
      ),
    );
}

/**
 * The stop rule of one make turn: validate/test failing for the same reason three times in a row
 * (whichever of the two ran), or a turn past the turn cap. Once stopped, the make tools refuse
 * (`MAKE_STOPPED`) and the turn ends with a card (`makeTurnResult`).
 */
export class MakeTurnGuard {
  readonly turns: number;
  stop?: MakeStop;
  #reason?: string;
  #count = 0;
  constructor(turns: number) {
    this.turns = turns;
    if (turns > MAKE_TURN_CAP && (turns - 1) % MAKE_TURN_CAP === 0)
      this.stop = { reason: 'turn-cap', turns };
  }
  /** Counts one validate or test report; returns the stop it caused, if any. */
  record(report: CheckReport): MakeStop | undefined {
    const reason = failureReason(report);
    if (!reason) {
      this.#reason = undefined;
      this.#count = 0;
      return undefined;
    }
    this.#count = reason === this.#reason ? this.#count + 1 : 1;
    this.#reason = reason;
    if (!this.stop && this.#count >= MAKE_FAILURE_STREAK)
      this.stop = { reason: 'failures', count: this.#count, detail: failureLines(report) };
    return this.stop;
  }
  /** Refuses further make work after a stop. */
  check() {
    if (this.stop) throw new DomainError('MAKE_STOPPED');
  }
}
/** What a make tool says when it stops the turn. */
export const makeStopNotice = (stop: MakeStop) => ({
  stop: stop.reason,
  next:
    stop.reason === 'failures'
      ? 'Stop now: the same check failed for the same reason three times in a row. Change nothing more; end this turn with a short Korean summary of what you built and what keeps failing. VIDE asks the user how to go on.'
      : 'Stop now: this make-conversation passed its turn limit. Change nothing; end this turn with a short Korean summary of the draft. VIDE asks the user to start a new conversation on the draft.',
});

/** The files a Codex make turn returns in its structured output (it has no file tools). */
const turnFiles = z
  .array(
    z
      .object({
        path: z.string().min(1).max(300),
        // null deletes the file.
        content: z.string().max(DRAFT_LIMITS.fileBytes).nullable(),
      })
      .strict(),
  )
  .max(50);
function filesOf(result: { text?: unknown; structured?: unknown }) {
  let value = result.structured;
  if (value === undefined && typeof result.text === 'string')
    try {
      value = JSON.parse(result.text);
    } catch {
      return undefined;
    }
  const files = (value as { files?: unknown } | null)?.files;
  if (files === undefined || files === null) return undefined;
  const parsed = turnFiles.safeParse(files);
  return parsed.success ? parsed.data : ('invalid' as const);
}

export interface MakeTurnDraft {
  draftId: string;
  drafts: Pick<JigDrafts, 'writeFile' | 'deleteFile' | 'validate' | 'test'>;
  guard?: MakeTurnGuard;
}
/** The card of a stopped make turn: one question card, the reason and the model's own words. */
function stopCard(stop: MakeStop, turns: number, text: string) {
  const question =
    stop.reason === 'failures'
      ? {
          id: `make-stop-${turns}`,
          title: '같은 점검·시험이 같은 이유로 세 번 잇달아 실패해 멈췄습니다. 어떻게 할까요?',
          options: [
            { id: 'retry-other', label: '다른 방법으로 다시 시도', recommended: true },
            { id: 'narrow', label: '범위를 줄여 다시 시도', recommended: false },
            { id: 'stop-here', label: '여기서 멈추고 직접 보기', recommended: false },
          ],
          blocks: '초안 작성',
          allowFree: true,
        }
      : {
          id: `make-turn-cap-${turns}`,
          title: `이 만들기 대화가 ${MAKE_TURN_CAP}턴을 넘었습니다. 여기까지 저장하고 새로 시작할까요?`,
          options: [
            {
              id: 'new-conversation',
              label: '저장하고 새 대화로',
              hint: '초안 파일과 점검 결과는 그대로 남습니다',
              recommended: true,
            },
            { id: 'continue', label: '이 대화로 계속', recommended: false },
          ],
          blocks: '다음 턴',
          allowFree: false,
        };
  const why =
    stop.reason === 'failures'
      ? ['멈춘 이유: 같은 이유로 세 번 잇달아 실패', ...stop.detail.map((line) => `- ${line}`)]
      : [`멈춘 이유: ${MAKE_TURN_CAP}턴 초과 (${stop.turns}번째 턴)`];
  return {
    text: [text.trim(), why.join('\n')].filter(Boolean).join('\n\n'),
    turnOutput: { status: 'question', questions: [question], stop },
  };
}

/**
 * The end of a make-conversation turn (execution.ts, after the structured output is checked): a
 * Codex turn's `files` are written into the draft with the same path rule as the file tools (null
 * deletes), then validated and tested; a turn the guard stopped ends with the stop card in place
 * of whatever the model said it would do next. Returns the fields to merge into the result.
 */
export async function makeTurnResult(
  projectId: string,
  draft: MakeTurnDraft,
  result: { text?: unknown; structured?: unknown },
  answer: { text?: unknown },
): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  const files = draft.guard?.stop ? undefined : filesOf(result);
  // Files that do not fit the output shape are not guessed at: nothing is written, the reason goes back.
  if (files === 'invalid')
    patch.makeFiles = {
      written: [],
      deleted: [],
      refused: [{ path: '', code: 'MAKE_FILES_INVALID' }],
    };
  else if (files?.length) {
    const written: string[] = [],
      deleted: string[] = [],
      refused: { path: string; code: string }[] = [];
    for (const file of files)
      try {
        if (file.content === null) {
          draft.drafts.deleteFile(projectId, draft.draftId, file.path);
          deleted.push(file.path);
        } else {
          draft.drafts.writeFile(projectId, draft.draftId, file.path, file.content);
          written.push(file.path);
        }
      } catch (error) {
        refused.push({ path: file.path, code: (error as { code?: string }).code ?? 'FAILED' });
      }
    const made: Record<string, unknown> = { written, deleted, refused };
    if (written.length || deleted.length) {
      const validation = await draft.drafts.validate(projectId, draft.draftId);
      draft.guard?.record(validation);
      made.validate = { ok: validation.ok, issues: validation.issues.length };
      if (validation.ok) {
        const tested = await draft.drafts.test(projectId, draft.draftId);
        draft.guard?.record(tested);
        made.test = { ok: tested.ok, failed: tested.cases.filter((c) => !c.ok).length };
      }
    }
    patch.makeFiles = made;
  }
  const stop = draft.guard?.stop;
  if (stop)
    Object.assign(
      patch,
      stopCard(stop, draft.guard!.turns, typeof answer.text === 'string' ? answer.text : ''),
    );
  return patch;
}
