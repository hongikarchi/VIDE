import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { dirname } from 'node:path';
import { z } from 'zod';
import { queryPageFields } from './query-page.ts';
import {
  agentToolNames,
  type AgentConnection,
  type ConversationScope,
} from '../ai/agent-connection.ts';
import { DomainError } from '../core/store.ts';
import { DocumentLinks } from '../core/document-links.ts';
import type { Workspace } from '../core/workspace.ts';
import { structureSummarySchema, type StructureSummary } from '../contracts/structure-model.ts';
import {
  layersOf,
  rowsOfLayers,
  type JigRuntime,
  type ReadModel,
} from '../jigs/runtime/runtime.ts';
import { jigRuntimeFor } from './jig-routes.ts';
import { skillCatalog } from './skill-catalog.ts';
import { MakeTurnGuard, draftsFor, makeStopNotice } from './make-routes.ts';
import type { JigDrafts } from '../jigs/runtime/drafts.ts';
import { turnOutputSchema } from './turn-output.ts';
import { existsSync } from 'node:fs';
import { KnowledgeReviewStore } from '../core/knowledge-review-store.ts';
import {
  factBrief,
  factChecks,
  factIssue,
  factSearch,
  factStatement,
  knowledgeFile,
  reviewLayer,
  type FactLayer,
  type FactState,
  type FactStatement,
} from '../jigs/knowledge.ts';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const failure = (code: string) => Object.assign(new Error(code), { code });
const target = z.string().min(1).max(256);
// The make tools act on the conversation's own draft: targetRef may be left out (T-064).
const draftTarget = target.optional();
// A conversation turn's scope has one target: its tools accept targetRef left out (T-062).
const scoped = target.optional();
const id = z.string().min(1).max(128);
/** Left out, the jig the conversation has open (its id is in the turn's rules). */
const scopedInstance = id.optional();
/** One end of a measured distance: an object id or a point [x, y, z]. */
const measureEnd = z.union([
  z.string().min(1).max(100),
  z.tuple([z.number(), z.number(), z.number()]),
]);
const page = {
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
const definitions = {
  query: {
    description:
      'Read a bounded page of the current task target. Use page.nextOffset with expectedRevision for subsequent pages, or objectIds for specific objects. Never treat one page as the whole model.',
    schema: z.object({ targetRef: target, ...queryPageFields }).strict(),
  },
  execute: {
    description:
      'Run SDK code on the task target. In Auto mode the target is the open user document: each call runs directly in it as ONE undo record (Ctrl+Z / VIDE [되돌리기] reverts it) and returns undoId and the added/changed/removed objects. Bulk deletion above the limit, layer deletion and purge are held back: such a call returns ok:false with "guarded" and nothing stays applied; then stop and tell the user what needs confirmation. Plan mode has no execute. The task goal names the target.',
    schema: z.object({ targetRef: target, code: z.string().min(1).max(65536) }).strict(),
  },
  // The AI's eyes (PLAN-24): an image of the target's model view and measurements of its objects.
  capture_view: {
    description:
      'See the task target: returns a PNG of its current model view (default 1200x800, at most 1600 px a side) and the camera. Frame objects with fitIds, look through a namedView, and switch layers on or off for this image only (working copies). Nothing in the document changes. Look after edits to check the result.',
    schema: z
      .object({
        targetRef: target,
        width: z.number().int().min(64).max(1600).optional(),
        height: z.number().int().min(64).max(1600).optional(),
        namedView: z.string().min(1).max(200).optional(),
        fitIds: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
        showLayers: z.array(z.string().min(1).max(1000)).max(200).optional(),
        hideLayers: z.array(z.string().min(1).max(1000)).max(200).optional(),
      })
      .strict(),
  },
  measure: {
    description:
      'Measure objects of the task target in model units: bounding box and size, curve length, area, and volume of closed solids for each id; and closest distances between pairs whose ends are object ids or [x,y,z] points (with the two closest points and dx/dy/dz). Quote these numbers instead of estimating.',
    schema: z
      .object({
        targetRef: target,
        ids: z.array(z.string().min(1).max(100)).max(50).optional(),
        distances: z
          .array(
            z
              .object({
                a: measureEnd,
                b: measureEnd,
              })
              .strict(),
          )
          .max(20)
          .optional(),
      })
      .strict(),
  },
  status: { description: 'Read the current task execution status.', schema: z.object({}).strict() },
  cancel: {
    description:
      'Request cancellation of the current task. The result determines whether stopping was confirmed.',
    schema: z.object({}).strict(),
  },
  // Conversation tools (PLAN-24 T-062): the conversation's project only. Reads are T1; jig_set and
  // jig_run act only on the jig the conversation has open, and nothing here writes a host document.
  jig_list: {
    description:
      "List the jig instances (작업본) of this project. 'open' marks the one this conversation works on.",
    schema: z.object({ targetRef: scoped }).strict(),
  },
  jig_state: {
    description:
      'Read one jig instance: its settings (value, unit, who set it, fixedAtPin, range) and the status of each step.',
    schema: z.object({ targetRef: scoped, instanceId: scopedInstance }).strict(),
  },
  jig_output: {
    description:
      'Read the kept output of one step, one page at a time. Without path you get an outline; give path (dotted keys) to read a value, and offset/limit to page an array. Quote only numbers you read here.',
    schema: z
      .object({
        targetRef: scoped,
        instanceId: scopedInstance,
        stepId: id,
        path: z.string().max(200).optional(),
        ...page,
      })
      .strict(),
  },
  jig_set: {
    description:
      "Change settings of the jig this conversation has open (value in the setting's unit, or give unit). Reversible; recorded in the conversation. fixedAtPin settings are refused. Steps after the change become stale until jig_run.",
    schema: z
      .object({
        targetRef: scoped,
        instanceId: scopedInstance,
        values: z
          .array(
            z
              .object({
                key: z.string().min(1).max(100),
                value: z.union([z.number(), z.string().max(200), z.boolean()]),
                unit: z.string().max(20).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(10),
        reason: z.string().max(300).optional(),
      })
      .strict(),
  },
  jig_run: {
    description:
      'Run the steps of the jig this conversation has open (cached steps are reused), up to until. Steps waiting for a person stay waiting.',
    schema: z
      .object({
        targetRef: scoped,
        instanceId: scopedInstance,
        until: id.optional(),
        mode: z.enum(['geometry', 'preview']).optional(),
      })
      .strict(),
  },
  // Screen actions (RESEARCH-12 §6.3): recorded in the conversation ledger; the screen carries
  // them out through startSkill / setWorkspace. Nothing is computed or written here.
  jig_open: {
    description:
      "Open a jig of this project's skill catalog on the user's screen (id from the catalog, e.g. project/s06-frame or structure). reuse 'last' opens its latest instance, 'new' a new one. The screen opens its tab, binds the instance to this conversation and computes up to the first step a person confirms. user-only jigs are refused. Returns at once; the screen does the work.",
    schema: z
      .object({
        targetRef: scoped,
        jigId: z.string().min(1).max(100),
        reuse: z.enum(['last', 'new']).optional(),
      })
      .strict(),
  },
  ui_go: {
    description:
      "Switch the user's screen: stage 'model' (3D), 'jig' (the open jig's tab, or the JIG list), 'report' (the 보고서 view of the 산출물 tab), 'data' (project records) or 'make'. view 'plan' or '3d' sets the 3D projection. Only the screen changes.",
    schema: z
      .object({
        targetRef: scoped,
        stage: z.enum(['model', 'jig', 'report', 'data', 'make']),
        view: z.enum(['3d', 'plan']).optional(),
      })
      .strict(),
  },
  structure_summary: {
    description:
      "Read the structure analysis summary a jig step keeps: label ('확정 결과' or '미확정 미리보기', quote it with every number), status, worst ratio, counts, steel weight, combinations, issues, assumptions, what is not checked.",
    schema: z.object({ targetRef: scoped, instanceId: scopedInstance }).strict(),
  },
  structure_checks: {
    description:
      'Page through member checks of the structure summary: member, verdict, ratio, clause, reference deflection. Filter by status (ok/warn/ng/na/err); order worst puts the highest ratio first.',
    schema: z
      .object({
        targetRef: scoped,
        instanceId: scopedInstance,
        status: z.enum(['ok', 'warn', 'ng', 'na', 'err']).optional(),
        order: z.enum(['stored', 'worst']).optional(),
        ...page,
      })
      .strict(),
  },
  links_layers: {
    description:
      'Layer table of each linked file of this project (from its latest stored Sync): layer path and object count.',
    schema: z.object({ targetRef: scoped, linkId: id.optional() }).strict(),
  },
  sync_sample: {
    description:
      'A small sample of the stored Sync rows of one layer of a linked file (id, type, bounds, measures). At most 50 rows per call.',
    schema: z
      .object({
        targetRef: scoped,
        linkId: id,
        layer: z.string().min(1).max(1000),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
  },
  // Make-conversation tools (PLAN-22 T-063): the conversation's jig draft only. Checks run on
  // the draft folder; AI-written steps run only in the compute box.
  jig_validate: {
    description:
      'Check the jig draft: forbidden files, jig.json v3, declared files, panel.json parts and step sources. Returns ok and the issues to fix.',
    schema: z.object({ targetRef: draftTarget }).strict(),
  },
  jig_test: {
    description:
      "Run the draft's fixture cases (fixtures/<case>/input.json, params.json, expect.json) with every code step in the compute box. Returns each case's result, mismatches and step errors.",
    schema: z.object({ targetRef: draftTarget }).strict(),
  },
  jig_preview: {
    description:
      'Compute the draft on one fixture case (default: the first) in the compute box for the preview the user sees. Returns step statuses and an outline of each step output.',
    schema: z
      .object({
        targetRef: draftTarget,
        fixture: z
          .string()
          .regex(/^[A-Za-z0-9_.-]{1,100}$/)
          .optional(),
      })
      .strict(),
  },
  jig_delete_file: {
    description:
      'Delete one file of the jig draft (path relative to the draft folder, e.g. steps/old.ts). Not jig.json; agent and settings files and paths outside the draft are refused. Empty folders left behind go too.',
    schema: z.object({ targetRef: draftTarget, path: z.string().min(1).max(300) }).strict(),
  },
  ask_user: {
    description:
      'Ask the user one decision the supplied data does not settle, as a question card: an id naming what it decides (ASCII words), the question in plain Korean, 2-5 options with exactly one recommended. After calling it, end the turn with status "question" and this card in questions.',
    schema: z
      .object({
        targetRef: draftTarget,
        question: z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
            title: z.string().min(1).max(200),
            options: z
              .array(
                z
                  .object({
                    id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
                    label: z.string().min(1).max(80),
                    hint: z.string().max(200).nullable().optional(),
                    recommended: z.boolean(),
                  })
                  .strict(),
              )
              .min(2)
              .max(5),
            blocks: z.string().max(200).nullable().optional(),
            allowFree: z.boolean().optional(),
          })
          .strict(),
      })
      .strict(),
  },
  // Project facts tools (SPEC-08.7, PLAN-22 T-065): this project's 자료 only, read-only. Rejected,
  // contaminated and excluded-source statements never come back. Cite statements as [S<id>].
  project_brief: {
    description:
      "Project status from the project's 자료: decided/blocked/changed, issues by discipline, counts and review counts. Only statements a person confirmed are facts; cite statements as [S<id>].",
    schema: z.object({ targetRef: scoped, discipline: z.string().max(40).optional() }).strict(),
  },
  project_search: {
    description:
      "Search this project's statements (all words must match; confirmed first). Each item has ref (S<id>), state ('confirmed' or 'unconfirmed'/'superseded' — say 미확정 when quoting those), party, date, content, path. Cite only refs returned by a tool in this turn, as [S<id>].",
    schema: z
      .object({
        targetRef: scoped,
        query: z.string().max(200),
        kind: z.string().max(40).optional(),
        discipline: z.string().max(40).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(30).optional(),
      })
      .strict(),
  },
  project_issue: {
    description:
      'One issue note (conclusions, open items, conditions, history with cited statement ids) and its statements. Cite statements as [S<id>].',
    schema: z.object({ targetRef: scoped, issueId: z.number().int().min(0) }).strict(),
  },
  project_statement: {
    description:
      'One statement with its review state and the source excerpt (truncated). Excluded statements are refused (FACT_EXCLUDED). Cite as [S<id>].',
    schema: z.object({ targetRef: scoped, statementId: z.number().int().min(0) }).strict(),
  },
  project_checks: {
    description:
      "Compare a jig instance's settings with the numbers of their basis statements (code compares): match, conflict, no-number, no-basis, invalid-basis. Without instanceId it uses the jig this conversation has open. Quote the verdicts; do not recompute.",
    schema: z.object({ targetRef: scoped, instanceId: id.optional() }).strict(),
  },
};
type ToolName = keyof typeof definitions;
type ToolArgs<N extends ToolName> = z.infer<(typeof definitions)[N]['schema']>;
type Handler<N extends ToolName> = (
  args: ToolArgs<N>,
  context: { signal: AbortSignal },
) => unknown | Promise<unknown>;
type Handlers = { [N in ToolName]?: Handler<N> };
interface ScopeOptions {
  targetRef: string | string[];
  handlers: Handlers;
  isCurrent: () => boolean | Promise<boolean>;
  maxCalls?: number;
  ttlMs?: number;
}
interface Run {
  targets: Set<string>;
  handlers: Handlers;
  isCurrent: ScopeOptions['isCurrent'];
  remaining: number;
  expires: number;
  abort: AbortController;
  busy: boolean;
}
function toolName(value: string): value is ToolName {
  return Object.hasOwn(definitions, value);
}
function invoke(name: ToolName, handlers: Handlers, args: unknown, signal: AbortSignal) {
  const handler = handlers[name] as Handler<ToolName>;
  return handler(definitions[name].schema.parse(args) as ToolArgs<ToolName>, { signal });
}
// The allowlist the CLI connection accepts is the same set of names (one registry).
if (
  agentToolNames.length !== Object.keys(definitions).length ||
  agentToolNames.some((name) => !toolName(name))
)
  throw new Error('agent tool names differ from their definitions');
const knownErrors = new Set([
  'INVALID_INPUT',
  'QUERY_RESULT_TOO_LARGE',
  'STALE_REFERENCE',
  'HOST_OWNERSHIP_MISMATCH',
  'HOST_LEASE_EXPIRED',
  'HOST_UNAVAILABLE',
  'HOST_RESULT_UNKNOWN',
  'HOST_REJECTED',
  'HOST_COMMAND_LIMIT',
  'EXECUTOR_NOT_READY',
  'CANCELLED',
  'NOT_FOUND',
  'PARAM_FIXED',
  'OUT_OF_RANGE',
  'UNIT_MISMATCH',
  'JIG_NOT_OPEN',
  'JIG_USER_ONLY',
  'STRUCTURE_NOT_COMPUTED',
  'DRAFT_NOT_OPEN',
  'DRAFT_OUTSIDE',
  'DRAFT_FORBIDDEN_FILE',
  'DRAFT_PATH_INVALID',
  'MAKE_STOPPED',
  'FACT_EXCLUDED',
  'NO_VIEW',
  'LAYER_OPTION_UNAVAILABLE',
  'CAPTURE_FAILED',
  'MEASURE_FAILED',
]);
/** Tools that change or occupy the target: one at a time, after the basis check. */
// capture_view moves the camera and layers of the target for one image, so it takes the turn too.
const controlledTools = new Set<ToolName>([
  'execute',
  'query',
  'jig_set',
  'jig_run',
  'capture_view',
]);
/**
 * Plan mode (ADR-022 2): the AI reads, measures, captures, plans and asks; nothing that writes a
 * document, a jig setting or a draft file.
 */
export const PLAN_MODE_TOOLS: ReadonlySet<string> = new Set<ToolName>([
  'query',
  'capture_view',
  'measure',
  'status',
  'cancel',
  'jig_list',
  'jig_state',
  'jig_output',
  // Screen-only (RESEARCH-12 §6.3): opening a jig and switching the screen compute nothing.
  'jig_open',
  'ui_go',
  'structure_summary',
  'structure_checks',
  'links_layers',
  'sync_sample',
  'ask_user',
  'project_brief',
  'project_search',
  'project_issue',
  'project_statement',
  'project_checks',
]);
/** The handlers Plan mode keeps (PLAN_MODE_TOOLS). */
export function planModeHandlers<H extends Handlers>(handlers: H): H {
  return Object.fromEntries(
    Object.entries(handlers).filter(([name]) => PLAN_MODE_TOOLS.has(name)),
  ) as H;
}

/** Internal controller capability, never minted by browser/agent input. No CAD executor is installed by default. */
export class AgentTools {
  #runs = new Map<string, Run>();
  #now: () => number;
  /** The engine's own origin (`http://127.0.0.1:<port>`); the MCP endpoint is `<origin>/mcp`. */
  origin?: string | (() => string);
  constructor({
    now = Date.now,
    origin,
  }: { now?: () => number; origin?: AgentTools['origin'] } = {}) {
    this.#now = now;
    this.origin = origin;
  }

  /**
   * The scope of one conversation turn (PLAN-24 T-062): target `conversation:<id>`, the project's
   * read tools and, when the conversation has a jig open, jig_set/jig_run on that instance only.
   * Undefined when the engine origin is not known (the turn then runs without tools).
   */
  issueConversation(
    sources: ConversationToolSources,
    {
      isCurrent = () => true,
      maxCalls = 20,
      ttlMs = 120000,
      readOnly = false,
    }: {
      isCurrent?: ScopeOptions['isCurrent'];
      maxCalls?: number;
      ttlMs?: number;
      /** Plan mode (ADR-022): only the tools of PLAN_MODE_TOOLS. */
      readOnly?: boolean;
    } = {},
  ): { connection: AgentConnection; revoke: () => void } | undefined {
    const origin = typeof this.origin === 'function' ? this.origin() : this.origin;
    if (!origin) return undefined;
    const all = conversationHandlers(sources);
    const handlers = readOnly ? planModeHandlers(all) : all;
    if (!Object.keys(handlers).length) return undefined;
    const scope = this.issue({
      targetRef: conversationTarget(sources.conversationId),
      handlers,
      isCurrent,
      maxCalls,
      ttlMs,
    });
    return {
      connection: Object.freeze({
        url: new URL('/mcp', origin).href,
        token: scope.token,
        tools: Object.freeze(Object.keys(handlers)),
        ...(sources.draft ? { draftDir: sources.draft.dir } : {}),
        scope: conversationScope(sources),
      }),
      revoke: scope.revoke,
    };
  }

  issue({ targetRef, handlers, isCurrent, maxCalls = 20, ttlMs = 120000 }: ScopeOptions) {
    const targets = Array.isArray(targetRef) ? targetRef : [targetRef];
    if (
      targets.length < 1 ||
      targets.length > 8 ||
      new Set(targets).size !== targets.length ||
      targets.some((value) => !target.safeParse(value).success) ||
      typeof isCurrent !== 'function' ||
      !handlers ||
      !Object.keys(handlers).length ||
      Object.entries(handlers).some(
        ([name, handler]) => !toolName(name) || typeof handler !== 'function',
      ) ||
      !Number.isInteger(maxCalls) ||
      maxCalls < 1 ||
      maxCalls > 100 ||
      !Number.isFinite(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 600000
    )
      throw failure('INVALID_AGENT_SCOPE');
    // Bound retained capabilities even when callers forget to release completed runs.
    for (const [key, run] of this.#runs) if (run.expires <= this.#now()) this.#revoke(key);
    if (this.#runs.size >= 32) throw failure('AGENT_CAPACITY');
    const token = randomBytes(32).toString('hex'),
      key = digest(token);
    const run = {
      targets: new Set(targets),
      handlers: { ...handlers },
      isCurrent,
      remaining: maxCalls,
      expires: this.#now() + ttlMs,
      abort: new AbortController(),
      busy: false,
    };
    this.#runs.set(key, run);
    return { token, revoke: () => this.#revoke(key) };
  }

  #revoke(key: string) {
    const run = this.#runs.get(key);
    if (run) {
      run.abort.abort();
      this.#runs.delete(key);
    }
  }
  close() {
    for (const key of this.#runs.keys()) this.#revoke(key);
  }

  /** Controller-only dispatch; applies the same checks as MCP without a loopback HTTP hop. */
  async call(token: string, name: ToolName, raw: unknown): Promise<CallToolResult> {
    const run = this.#runs.get(digest(token));
    if (!run)
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: 'AGENT_UNAUTHORIZED' }) }],
      };
    if (!toolName(name) || !run.handlers[name])
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: 'AGENT_TOOL_UNAVAILABLE' }) }],
      };
    const parsed = definitions[name].schema.safeParse(raw);
    if (!parsed.success)
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: 'INVALID_INPUT' }) }],
      };
    return this.#invoke(run, name, parsed.data);
  }
  async #invoke(run: Run, name: ToolName, args: { targetRef?: string }): Promise<CallToolResult> {
    const error = (code: string): CallToolResult => ({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ code }) }],
    });
    if (run.abort.signal.aborted || run.expires <= this.#now()) return error('AGENT_SCOPE_EXPIRED');
    if (args.targetRef && !run.targets.has(args.targetRef)) return error('TARGET_MISMATCH');
    // Left out, targetRef means the scope's only target; with several it must be named.
    if (!args.targetRef && run.targets.size !== 1 && 'targetRef' in definitions[name].schema.shape)
      return error('TARGET_MISMATCH');
    const controlled = controlledTools.has(name);
    if (controlled && run.busy) return error('AGENT_BUSY');
    if (run.remaining <= 0) return error('AGENT_CALL_LIMIT');
    run.remaining--;
    if (controlled) run.busy = true;
    try {
      if (controlled && !(await run.isCurrent())) return error('STALE_REFERENCE');
      // Conditions may change while the revision check is awaiting storage.
      if (run.abort.signal.aborted || run.expires <= this.#now())
        return error('AGENT_SCOPE_EXPIRED');
      const result = await invoke(name, run.handlers, args, run.abort.signal);
      if (result instanceof ToolImage)
        return {
          content: [
            { type: 'image', data: result.data, mimeType: result.mimeType },
            { type: 'text', text: JSON.stringify(result.meta) },
          ],
        };
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (cause) {
      const code =
        cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
          ? cause.code
          : '';
      return error(knownErrors.has(code) ? code : 'AGENT_TOOL_FAILED');
    } finally {
      if (controlled) run.busy = false;
    }
  }
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    readBody: (request: IncomingMessage) => Promise<unknown>,
  ) {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '')?.[1];
    const key = token && digest(token),
      run = key && this.#runs.get(key);
    if (!run || run.expires <= this.#now()) {
      if (run && key) this.#revoke(key);
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 'AGENT_UNAUTHORIZED' }));
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return;
    }
    const input = await readBody(request);
    const server = new McpServer({ name: 'vide-task', version: '0.1.0' });
    for (const name of Object.keys(run.handlers)) {
      if (!toolName(name)) continue;
      const definition = definitions[name];
      server.registerTool(
        name,
        { description: definition.description, inputSchema: definition.schema },
        async (args: { targetRef?: string }): Promise<CallToolResult> => {
          return this.#invoke(run, name, args);
        },
      );
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.once('close', () => {
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, input);
    } catch (error) {
      await server.close();
      throw error;
    }
  }
}

// --- conversation tools (PLAN-24 T-062) ---------------------------------------------------------

/**
 * The values the turn's rules name (T-062): the one target, the open jig and the project's linked
 * files (ids and hosts only; names stay behind links_layers).
 */
export function conversationScope(sources: ConversationToolSources): ConversationScope {
  let links: { id: string; host: string; target?: boolean }[] = [];
  try {
    links = (sources.links?.list(sources.projectId) ?? []).slice(0, 50).map((link) => ({
      id: link.id,
      host: link.host,
      ...(sources.targetLinkIds?.includes(link.id) ? { target: true } : {}),
    }));
  } catch {
    /* The links table cannot be read: the rules name no files, links_layers still answers. */
  }
  return {
    targetRef: conversationTarget(sources.conversationId),
    ...(sources.openInstanceId ? { openInstanceId: sources.openInstanceId } : {}),
    links,
  };
}

export const conversationTarget = (conversationId: string) => `conversation:${conversationId}`;
/** What a conversation turn's tools read and change; everything is bound to one project. */
export interface ConversationToolSources {
  projectId: string;
  conversationId: string;
  /** The jig instance the conversation works on; jig_set/jig_run exist only with one. */
  openInstanceId: string | null;
  /** The turn's request (param log and ledger reference). */
  requestId?: string;
  /** The linked files the conversation names as its targets. */
  targetLinkIds?: readonly string[] | null;
  workspace: Pick<Workspace, 'list' | 'get'>;
  jigs?: Pick<JigRuntime, 'list' | 'view' | 'output' | 'setParams' | 'run'>;
  links?: Pick<DocumentLinks, 'list' | 'get'>;
  /** Records a ledger item of the conversation (a setting the AI changed, a screen action). */
  ledger?: (item: {
    kind: 'param-change' | 'code' | 'result-ref';
    body: unknown;
    requestId?: string;
  }) => unknown;
  /** The project's skill catalog (jig_open checks the id and `invocation`). */
  skills?: () => Promise<readonly { id: string; name: string; invocation: string }[]>;
  /** The jig draft of a make-conversation (PLAN-22 T-063); jig_validate/test/preview and ask_user. */
  draft?: {
    draftId: string;
    dir: string;
    drafts: Pick<JigDrafts, 'validate' | 'test' | 'preview' | 'deleteFile' | 'writeFile'>;
    /** The turn's stop rule (SPEC-07.9): repeated failures or the turn cap end the turn. */
    guard?: MakeTurnGuard;
  };
  /** The project's crawler DB and review layer (SPEC-08); project_* exist only with one. */
  facts?: {
    file: string;
    layer: () => FactLayer;
    /** Statements tools returned this turn, for the citation gate (knowledge.ts citationGate). */
    returned?: Map<number, FactState>;
  };
}
/** Each tool result stays small: the model pages instead of receiving a whole output. */
const RESULT_BYTES = 48 * 1024;
const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '');
const bounded = <T>(value: T): T => {
  if (sizeOf(value) > RESULT_BYTES) throw new DomainError('QUERY_RESULT_TOO_LARGE');
  return value;
};
const pageOf = <T>(rows: readonly T[], offset = 0, limit = 50) => {
  const items = rows.slice(offset, offset + limit);
  const next = offset + items.length;
  return { total: rows.length, offset, items, nextOffset: next < rows.length ? next : null };
};
/** A value's shape without its contents: object keys with their types, array lengths. */
function outline(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (value && typeof value === 'object') {
    if (depth >= 1) return { type: 'object', keys: Object.keys(value).length };
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 80)
        .map(([key, entry]) => [key, outline(entry, depth + 1)]),
    );
  }
  return typeof value === 'string' && value.length > 200 ? value.slice(0, 200) + '…' : value;
}
function atPath(value: unknown, path: string | undefined) {
  if (!path) return value;
  let current = value;
  for (const key of path.split('.')) {
    if (current && typeof current === 'object' && Object.hasOwn(current, key))
      current = (current as Record<string, unknown>)[key];
    else throw new DomainError('NOT_FOUND');
  }
  return current;
}
type Jigs = NonNullable<ConversationToolSources['jigs']>;
/** The structure summary a step of the instance keeps (the output itself or its `summary`). */
async function structureOf(
  jigs: Jigs,
  projectId: string,
  instanceId: string,
): Promise<StructureSummary> {
  const view = await jigs.view(projectId, instanceId);
  for (const step of [...view.steps].reverse()) {
    if (!step.hasOutput) continue;
    let output: unknown;
    try {
      output = jigs.output(projectId, instanceId, step.id);
    } catch {
      continue;
    }
    for (const candidate of [output, (output as { summary?: unknown } | null)?.summary]) {
      const parsed = structureSummarySchema.safeParse(candidate);
      if (parsed.success) return parsed.data;
    }
  }
  throw new DomainError('STRUCTURE_NOT_COMPUTED');
}
/** The newest finished Sync (stored display model) of a link; host documents are never read here. */
function latestSync(
  workspace: ConversationToolSources['workspace'],
  projectId: string,
  linkId: string,
) {
  const entry = workspace
    .list(projectId)
    .filter((row) => row.state === 'succeeded' && row.input.linkId === linkId)
    .at(-1);
  if (!entry) return undefined;
  const full = workspace.get(projectId, entry.id);
  return Array.isArray(full.result?.scene)
    ? { syncId: full.id, model: full.result as unknown as ReadModel }
    : undefined;
}
/** Scalar fields and short numeric arrays of a Sync row; geometry payloads stay out. */
function sampleRow(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith('64')) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
      out[key] =
        typeof value === 'string' && value.length > 200 ? value.slice(0, 200) + '…' : value;
    else if (
      Array.isArray(value) &&
      value.length <= 12 &&
      value.every(
        (entry) =>
          typeof entry === 'number' ||
          (Array.isArray(entry) && entry.length <= 3 && entry.every((n) => typeof n === 'number')),
      )
    )
      out[key] = value;
  }
  return out;
}
type StepView = Awaited<ReturnType<JigRuntime['view']>>['steps'][number];
const stepRow = (step: StepView) => {
  const failed = (step.gates ?? []).filter((gate) => (gate as { ok?: unknown }).ok === false);
  return {
    id: step.id,
    title: step.title,
    kind: step.kind,
    status: step.status,
    ...(step.at ? { at: step.at } : {}),
    ...(step.hasOutput ? { hasOutput: true } : {}),
    ...(failed.length ? { failedGates: failed.slice(0, 10).map((gate) => outline(gate)) } : {}),
  };
};

/** The handlers of a conversation turn's scope; every call is bound to the conversation's project. */
export function conversationHandlers(sources: ConversationToolSources): Handlers {
  const { projectId, openInstanceId, workspace, jigs, links, ledger, requestId } = sources;
  const runtime = () => {
    if (!jigs) throw new DomainError('EXECUTOR_NOT_READY');
    return jigs;
  };
  const open = (instanceId: string) => {
    if (!openInstanceId || instanceId !== openInstanceId) throw new DomainError('JIG_NOT_OPEN');
    return runtime();
  };
  /** instanceId left out is the jig the conversation has open. */
  const pick = (instanceId: string | undefined) => {
    const chosen = instanceId ?? openInstanceId;
    if (!chosen) throw new DomainError('JIG_NOT_OPEN');
    return chosen;
  };
  const handlers: Handlers = {
    jig_list: () =>
      bounded({
        instances: runtime()
          .list(projectId)
          .slice(-50)
          .map((row) => ({ ...row, ...(row.id === openInstanceId ? { open: true } : {}) })),
      }),
    jig_state: async ({ instanceId: given }) => {
      const instanceId = pick(given);
      const view = await runtime().view(projectId, instanceId);
      return bounded({
        id: view.id,
        open: view.id === openInstanceId,
        jig: { id: view.jig.id, version: view.jig.version, name: view.jig.name },
        title: view.title,
        status: view.status,
        steps: view.steps.map(stepRow),
        params: view.params.map((param) => ({
          key: param.key,
          title: param.title,
          value: param.displayValue,
          unit: param.displayUnit,
          by: param.by,
          ...(param.fixedAtPin ? { fixedAtPin: true } : {}),
          ...(param.range ? { range: param.range } : {}),
          ...(param.choices ? { choices: param.choices } : {}),
        })),
      });
    },
    jig_output: ({ instanceId: given, stepId, path, offset, limit }) => {
      const instanceId = pick(given);
      const value = atPath(runtime().output(projectId, instanceId, stepId), path);
      const at = { stepId, path: path ?? null };
      if (Array.isArray(value)) return bounded({ ...at, ...pageOf(value, offset, limit ?? 20) });
      return bounded({
        ...at,
        ...(sizeOf(value) <= 8 * 1024 ? { value } : { outline: outline(value) }),
      });
    },
    structure_summary: async ({ instanceId: given }) => {
      const instanceId = pick(given);
      const summary = await structureOf(runtime(), projectId, instanceId);
      const { members, reactions, statusCodes: _codes, colorBands: _bands, ...head } = summary;
      return bounded({
        ...head,
        members: members.length,
        reactions: {
          sumZ_kN: reactions.sumZ_kN,
          maxLateral_kN: reactions.maxLateral_kN,
          columns: reactions.perColumn.length,
        },
        issues: head.issues.slice(0, 20),
        issueCount: head.issues.length,
      });
    },
    structure_checks: async ({ instanceId: given, status, order, offset, limit }) => {
      const instanceId = pick(given);
      const summary = await structureOf(runtime(), projectId, instanceId);
      let rows = summary.members.map(
        ([member, code, ratio, clause, deflection, limitMm, segments]) => ({
          member,
          status: summary.statusCodes[code],
          ratio,
          clause: clause === null ? null : (summary.clauses[clause] ?? null),
          referenceDeflection_mm: deflection,
          limit_mm: limitMm,
          segments: segments.length,
        }),
      );
      if (status) rows = rows.filter((row) => row.status === status);
      if (order === 'worst') rows = [...rows].sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1));
      return bounded({
        label: summary.label,
        mode: summary.mode,
        ...pageOf(rows, offset, limit ?? 50),
      });
    },
    links_layers: ({ linkId }) => {
      if (!links) throw new DomainError('EXECUTOR_NOT_READY');
      const chosen = linkId ? [links.get(projectId, linkId)] : links.list(projectId);
      return bounded({
        links: chosen.slice(0, 8).map((link) => {
          const sync = latestSync(workspace, projectId, link.id);
          return {
            linkId: link.id,
            host: link.host,
            name: link.name,
            syncId: sync?.syncId ?? null,
            layers: sync ? layersOf(sync.model).slice(0, 300) : [],
          };
        }),
      });
    },
    sync_sample: ({ linkId, layer, offset, limit }) => {
      if (!links) throw new DomainError('EXECUTOR_NOT_READY');
      links.get(projectId, linkId);
      const sync = latestSync(workspace, projectId, linkId);
      if (!sync) throw new DomainError('NOT_FOUND');
      const found = pageOf(rowsOfLayers(sync.model, [layer]).rows, offset, limit ?? 20);
      return bounded({ syncId: sync.syncId, layer, ...found, items: found.items.map(sampleRow) });
    },
  };
  // Screen actions: a ledger item the screen reads while it follows the turn (app.ts); only a
  // turn that records in a conversation ledger gets them.
  if (ledger) Object.assign(handlers, screenHandlers(sources));
  if (openInstanceId) {
    handlers.jig_set = async ({ instanceId: given, values, reason }) => {
      const instanceId = pick(given);
      const rt = open(instanceId);
      const before = new Map(
        (await rt.view(projectId, instanceId)).params.map((param) => [param.key, param]),
      );
      const done = await rt.setParams(projectId, instanceId, {
        values,
        by: 'ai',
        reason: reason ?? conversationTarget(sources.conversationId),
        ...(requestId ? { requestId } : {}),
      });
      const changes = done.changed.map((key) => {
        const after = done.instance.params.find((param) => param.key === key);
        return {
          key,
          title: after?.title ?? key,
          from: before.get(key)?.displayValue ?? null,
          to: after?.displayValue ?? null,
          unit: after?.displayUnit ?? '',
        };
      });
      // Reversible: the param log keeps each change and undo takes its seq; the ledger records it.
      ledger?.({
        kind: 'param-change',
        body: { instanceId, by: 'ai', seqs: done.seqs, changes, ...(reason ? { reason } : {}) },
        ...(requestId ? { requestId } : {}),
      });
      return bounded({ changes, seqs: done.seqs, staleSteps: done.affected });
    };
    handlers.jig_run = async ({ instanceId: given, until, mode }) => {
      const instanceId = pick(given);
      const report = await open(instanceId).run(projectId, instanceId, {
        until,
        mode: mode ?? 'geometry',
      });
      return bounded({
        status: report.status,
        steps: report.steps.map((step) => ({
          id: step.id,
          status: step.status,
          ...(typeof step.ms === 'number' ? { ms: step.ms } : {}),
          ...(step.cached ? { cached: true } : {}),
        })),
      });
    };
  }
  if (sources.facts && existsSync(sources.facts.file))
    Object.assign(handlers, factHandlers(sources));
  if (sources.draft) Object.assign(handlers, makeHandlers(sources));
  return handlers;
}

/** jig_open and ui_go (RESEARCH-12 §6.3): recorded for the screen, nothing computed or written. */
function screenHandlers(sources: ConversationToolSources): Handlers {
  const { ledger, requestId } = sources;
  const record = ledger!;
  return {
    jig_open: async ({ jigId, reuse }) => {
      const catalog = (await sources.skills?.()) ?? [];
      const entry = catalog.find((skill) => skill.id === jigId);
      if (!entry) throw new DomainError('NOT_FOUND');
      if (entry.invocation === 'user-only') throw new DomainError('JIG_USER_ONLY');
      record({
        kind: 'result-ref',
        body: { appAction: 'jig_open', jigId, reuse: reuse ?? 'last', by: 'ai' },
        ...(requestId ? { requestId } : {}),
      });
      return {
        ok: true,
        jig: { id: entry.id, name: entry.name },
        note: 'The screen opens the jig and binds it to this conversation; use jig_state in the next turn.',
      };
    },
    ui_go: async ({ stage, view }) => {
      record({
        kind: 'result-ref',
        body: { appAction: 'ui_go', stage, ...(view ? { view } : {}), by: 'ai' },
        ...(requestId ? { requestId } : {}),
      });
      return { ok: true };
    },
  };
}

// --- project facts tools (SPEC-08.7) ------------------------------------------------------------

/** What a tool shows of a statement; the model cites `ref`. */
const factRow = (fact: FactStatement) => ({
  ref: fact.ref,
  state: fact.state,
  kind: fact.kind,
  party: fact.party,
  subject: fact.subject,
  content: fact.content,
  saidOn: fact.saidOn,
  path: fact.path,
});
function factHandlers(sources: ConversationToolSources): Handlers {
  const facts = sources.facts!;
  const { projectId, openInstanceId, jigs } = sources;
  const seen = (rows: FactStatement[]) => {
    for (const row of rows) facts.returned?.set(row.id, row.state);
    return rows.map(factRow);
  };
  return {
    project_brief: ({ discipline }) => {
      const brief = factBrief(facts.file, facts.layer());
      if (!brief.available) return { available: false };
      const disciplines = brief.disciplines
        .filter((entry) => !discipline || entry.key === discipline)
        .map((entry) => ({ ...entry, issues: entry.issues.slice(0, 20) }));
      return bounded({ ...brief, disciplines });
    },
    project_search: ({ query, kind, discipline, offset, limit }) => {
      const found = factSearch(facts.file, facts.layer(), query, {
        kind,
        discipline,
        offset,
        limit: limit ?? 20,
      });
      return bounded({
        items: seen(found.items),
        total: found.total,
        offset: found.offset,
        nextOffset: found.nextOffset,
        excluded: found.excluded,
      });
    },
    project_issue: ({ issueId }) => {
      const issue = factIssue(facts.file, facts.layer(), issueId);
      return bounded({ ...issue, statements: seen(issue.statements.slice(0, 60)) });
    },
    project_statement: ({ statementId }) => {
      const fact = factStatement(facts.file, facts.layer(), statementId, { people: false });
      seen([fact]);
      const text = fact.text.length > 2000 ? fact.text.slice(0, 2000) + '…' : fact.text;
      return bounded({ ...factRow(fact), quote: fact.quote, locator: fact.locator, excerpt: text });
    },
    project_checks: async ({ instanceId }) => {
      const chosen = instanceId ?? openInstanceId;
      if (!chosen) throw new DomainError('JIG_NOT_OPEN');
      if (!jigs) throw new DomainError('EXECUTOR_NOT_READY');
      const view = await jigs.view(projectId, chosen);
      const settings = view.params.map((param) => ({
        key: param.key,
        title: param.title,
        value: param.displayValue,
        unit: param.displayUnit,
        // A value set from a fact rests on that statement; otherwise the declared basis.
        basis: param.by === 'fact' && param.ref ? { factRefs: [param.ref] } : param.basis,
      }));
      return bounded({
        instanceId: chosen,
        checks: factChecks(facts.file, facts.layer(), settings).slice(0, 100),
      });
    },
  };
}

/** A conversation turn's sources from the engine's own stores (no host access). */
export function conversationSources(
  workspace: Workspace,
  conversation: {
    id: string;
    projectId: string;
    jigInstanceId: string | null;
    kind?: string;
    draftId?: string | null;
    targets?: string[] | null;
  },
  { requestId, ledger }: Pick<ConversationToolSources, 'requestId' | 'ledger'> = {},
): ConversationToolSources {
  const file = workspace.store.db.location();
  return {
    projectId: conversation.projectId,
    conversationId: conversation.id,
    openInstanceId: conversation.jigInstanceId,
    requestId,
    targetLinkIds: conversation.targets ?? null,
    workspace,
    jigs: file ? jigRuntimeFor(workspace, dirname(file)) : undefined,
    links: new DocumentLinks(workspace.store.db),
    ledger,
    ...(file
      ? { skills: () => skillCatalog(workspace, dirname(file), conversation.projectId) }
      : {}),
    ...(file ? { facts: factsOf(workspace, dirname(file), conversation.projectId) } : {}),
    ...(file && conversation.kind === 'jig-make' && conversation.draftId
      ? {
          draft: draftOf(workspace, dirname(file), conversation.projectId, conversation.draftId, {
            turns: turnCount(workspace, conversation.projectId, conversation.id),
          }),
        }
      : {}),
  };
}
/** The project's crawler DB and review layer; undefined for an id that names no DB file. */
function factsOf(workspace: Workspace, dataDirectory: string, projectId: string) {
  let file: string;
  try {
    file = knowledgeFile(dataDirectory, projectId);
  } catch {
    return undefined;
  }
  return {
    file,
    layer: () => reviewLayer(new KnowledgeReviewStore(workspace.store.db), projectId),
    returned: new Map<number, FactState>(),
  };
}

// --- make-conversation tools (PLAN-22 T-063) ----------------------------------------------------

/** The open draft a make-conversation writes; undefined when it is not open (no make tools). */
function draftOf(
  workspace: Workspace,
  dataDirectory: string,
  projectId: string,
  draftId: string,
  { turns = 1 }: { turns?: number } = {},
) {
  const drafts = draftsFor(workspace, dataDirectory);
  try {
    const draft = drafts.get(projectId, draftId);
    return draft.state === 'open'
      ? { draftId, dir: draft.path, drafts, guard: new MakeTurnGuard(turns) }
      : undefined;
  } catch {
    return undefined;
  }
}
/** The turns of a conversation so far, the running one included (its requests). */
function turnCount(workspace: Pick<Workspace, 'list'>, projectId: string, conversationId: string) {
  try {
    return Math.max(
      1,
      workspace.list(projectId).filter((row) => row.input.conversationId === conversationId).length,
    );
  } catch {
    return 1;
  }
}
function makeHandlers(sources: ConversationToolSources): Handlers {
  const { projectId } = sources;
  const { draftId, drafts, guard } = sources.draft!;
  // After a stop every make tool refuses; the check that stopped the turn says so in its result.
  const checked = <T extends object>(report: Parameters<MakeTurnGuard['record']>[0], shown: T) => {
    const stop = guard?.record(report);
    return stop ? { ...shown, ...makeStopNotice(stop) } : shown;
  };
  return {
    jig_validate: async () => {
      guard?.check();
      const report = await drafts.validate(projectId, draftId);
      return checked(report, bounded({ ...report, issues: report.issues.slice(0, 50) }));
    },
    jig_delete_file: ({ path }) => {
      guard?.check();
      return drafts.deleteFile(projectId, draftId, path);
    },
    jig_test: async () => {
      guard?.check();
      const report = await drafts.test(projectId, draftId);
      return checked(
        report,
        bounded({
          ok: report.ok,
          id: report.id,
          version: report.version,
          ...(report.issues ? { issues: report.issues.slice(0, 50) } : {}),
          cases: report.cases.slice(0, 20).map((c) => ({
            name: c.name,
            ok: c.ok,
            ...(c.error ? { error: c.error.slice(0, 2000) } : {}),
            mismatches: c.mismatches.slice(0, 20).map((m) => outline(m)),
            steps: c.steps.map((step) => ({
              id: step.id,
              status: step.status,
              ...(step.error ? { error: step.error } : {}),
            })),
          })),
        }),
      );
    },
    jig_preview: async ({ fixture }) => {
      guard?.check();
      const preview = await drafts.preview(projectId, draftId, { fixture });
      return bounded({
        ok: preview.ok,
        fixture: preview.fixture,
        panel: preview.panel !== null,
        ...(preview.issues ? { issues: preview.issues.slice(0, 50) } : {}),
        steps: preview.steps,
        outputs: Object.fromEntries(
          Object.entries(preview.outputs).map(([step, output]) => [step, outline(output)]),
        ),
      });
    },
    // The card itself travels in the turn output (T-062); this checks it and says so.
    ask_user: ({ question }) => {
      const parsed = turnOutputSchema.safeParse({
        status: 'question',
        text: '',
        questions: [
          {
            ...question,
            blocks: question.blocks ?? null,
            allowFree: question.allowFree ?? false,
            options: question.options.map((o) => ({ ...o, hint: o.hint ?? null })),
          },
        ],
      });
      const options = question.options;
      if (
        !parsed.success ||
        options.filter((o) => o.recommended).length !== 1 ||
        new Set(options.map((o) => o.id)).size !== options.length
      )
        throw new DomainError('INVALID_INPUT');
      return {
        question: parsed.data.questions[0],
        next: 'End this turn with status "question" and exactly this card in questions; VIDE shows it to the user and the answer comes as the next turn.',
      };
    },
  };
}

// --- the AI's eyes (PLAN-24) ---------------------------------------------------------------------

/** A tool result that is an image: the model receives it as image content with `meta` as text. */
export class ToolImage {
  readonly data: string;
  readonly mimeType: 'image/png' | 'image/jpeg';
  readonly meta: Record<string, unknown>;
  constructor(data: string, mimeType: ToolImage['mimeType'], meta: Record<string, unknown> = {}) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || Buffer.byteLength(data, 'base64') > 1_000_000)
      throw new DomainError('QUERY_RESULT_TOO_LARGE');
    this.data = data;
    this.mimeType = mimeType;
    this.meta = meta;
  }
}
type CaptureArgs = Omit<ToolArgs<'capture_view'>, 'targetRef'>;
type MeasureArgs = Omit<ToolArgs<'measure'>, 'targetRef'>;
/** What capture_view and measure read: a worker working copy or an attached editor channel. */
export interface VisionSource {
  captureView(options: CaptureArgs): Promise<{
    mimeType: 'image/png';
    data: string;
    width: number;
    height: number;
    [key: string]: unknown;
  }>;
  measure(options: MeasureArgs): Promise<unknown>;
}
/** capture_view and measure on one host source; `onUse` records each call (activity log). */
export function visionHandlers(
  source: VisionSource,
  onUse: (tool: 'capture_view' | 'measure') => void = () => {},
): Handlers {
  return {
    capture_view: async ({ targetRef: _target, ...options }) => {
      const { data, mimeType, ...meta } = await source.captureView(options);
      onUse('capture_view');
      return new ToolImage(data, mimeType, meta);
    },
    measure: async ({ targetRef: _target, ...options }) => {
      if (!options.ids?.length && !options.distances?.length)
        throw new DomainError('INVALID_INPUT');
      const result = await source.measure(options);
      onUse('measure');
      return bounded(result);
    },
  };
}
