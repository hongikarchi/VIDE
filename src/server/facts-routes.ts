import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import { KnowledgeReviewStore, verdicts } from '../core/knowledge-review-store.ts';
import type { Workspace } from '../core/workspace.ts';
import {
  factStatusSchema,
  type FactEvidence,
  type FactIssue,
  type FactRules,
  type FactSearch,
  type FactSummary,
} from '../contracts/facts.ts';
import {
  excludeFactSource,
  factBrief,
  factIssue,
  factRefIds,
  factSearch,
  factStatement,
  factValidity,
  knowledgeFile,
  openKnowledgeSource,
  recordFactReview,
  reviewLayer,
} from '../jigs/knowledge.ts';

// Project facts routes (SPEC-08, PLAN-22 T-065): the 자료 workspace over one project's crawler DB
// with the VIDE review layer. Reviews and source rules are written only here, by the person using
// the app; AI tools read through agent-tools.ts and never write.

export interface FactRouteContext {
  workspace: Pick<Workspace, 'store'>;
  /** The engine's data folder; crawler DBs are `<data>/knowledge/<projectId>.sqlite`. */
  dataDirectory: string;
  body: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  send: (status: number, data: unknown) => void;
  /** The request came through the remote tunnel: no opening of originals on this PC. */
  remote?: boolean;
}

// `verdict: null` clears the verdict (the engine takes GET/POST/PUT only).
const review = z
  .object({
    verdict: z.enum(verdicts).nullable(),
    reason: z.string().max(4000).nullable().optional(),
    correction: z.string().max(4000).nullable().optional(),
    supersededBy: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
const rule = z
  .object({
    sourceId: z.number().int().nonnegative().optional(),
    pattern: z.string().min(1).max(4000).optional(),
    reason: z.string().max(4000).nullable().optional(),
    /** Remove the rule of this pattern instead of adding one. */
    remove: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => (value.sourceId === undefined) !== (value.pattern === undefined));
const refs = z
  .object({
    statementId: z.number().int().nonnegative().optional(),
    factRefs: z.array(z.string().max(40)).max(100).optional(),
  })
  .strict();
const statusFilter = factStatusSchema.optional();
const count = (value: string | null, fallback: number) => {
  const n = Number(value);
  return value !== null && Number.isFinite(n) ? n : fallback;
};
/** The person who reviews in this app (SPEC-08.5: people only). */
const PERSON = 'user';

const route =
  /^\/api\/v1\/projects\/([^/]+)\/facts(?:\/(search|rules|refs)|\/(issues|statements|sources)\/(\d+)(?:\/(review|open))?)?$/;

export async function factRoutes(
  url: URL,
  request: IncomingMessage,
  { workspace, dataDirectory, body, send, remote = false }: FactRouteContext,
): Promise<boolean> {
  const match = route.exec(url.pathname);
  if (!match) return false;
  const [, projectId, list, kind, idText, action] = match;
  const method = request.method ?? 'GET';
  workspace.store.project(projectId);
  const file = knowledgeFile(dataDirectory, projectId);
  const store = new KnowledgeReviewStore(workspace.store.db);
  const layer = () => reviewLayer(store, projectId);
  const id = Number(idText);
  const params = url.searchParams;

  if (!list && !kind && method === 'GET') {
    send(200, factBrief(file, layer()) satisfies FactSummary);
    return true;
  }
  if (list === 'search' && method === 'GET') {
    send(
      200,
      factSearch(file, layer(), params.get('q') ?? '', {
        kind: params.get('kind') || undefined,
        discipline: params.get('discipline') || undefined,
        status: statusFilter.parse(params.get('status') || undefined),
        excluded: params.get('excluded') === '1',
        offset: count(params.get('offset'), 0),
        limit: count(params.get('limit'), 50),
      }) satisfies FactSearch,
    );
    return true;
  }
  if (list === 'rules') {
    if (method === 'GET') {
      send(200, { rules: store.sourceRules(projectId) } satisfies FactRules);
      return true;
    }
    if (method === 'POST') {
      const input = rule.parse(await body(request));
      if (input.remove) {
        if (!input.pattern) throw new DomainError('INVALID_INPUT');
        store.removeSourceRule(projectId, input.pattern);
        send(200, { rules: store.sourceRules(projectId) });
        return true;
      }
      const rules = excludeFactSource(
        store,
        file,
        projectId,
        { sourceId: input.sourceId, pattern: input.pattern },
        input.reason ?? null,
        PERSON,
      );
      send(200, { rules } satisfies FactRules);
      return true;
    }
  }
  if (list === 'refs' && method === 'POST') {
    const ids = factRefIds(refs.parse(await body(request)));
    send(200, { refs: ids.length ? factValidity(file, layer(), ids) : [] });
    return true;
  }
  if (kind === 'issues' && !action && method === 'GET') {
    send(200, factIssue(file, layer(), id) satisfies FactIssue);
    return true;
  }
  if (kind === 'statements' && !action && method === 'GET') {
    send(200, factStatement(file, layer(), id) satisfies FactEvidence);
    return true;
  }
  if (kind === 'statements' && action === 'review' && (method === 'POST' || method === 'PUT')) {
    const { verdict, ...input } = review.parse(await body(request));
    if (verdict) {
      send(200, recordFactReview(store, file, projectId, id, { verdict, ...input }, PERSON));
      return true;
    }
    store.removeReview(projectId, id);
    send(200, factStatement(file, layer(), id) satisfies FactEvidence);
    return true;
  }
  if (kind === 'sources' && action === 'open' && method === 'POST') {
    // Opening an original runs a program on this PC: only the person at it (SPEC-08.4).
    if (remote) throw new DomainError('FORBIDDEN');
    send(200, openKnowledgeSource(file, id));
    return true;
  }
  throw new DomainError('NOT_FOUND');
}
