import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
  knowledgeSourceFile,
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
  /** The response, for streaming an original's bytes (`…/sources/:n/file`). */
  response?: ServerResponse;
  /** A review or source rule recorded here, for the account site (ADR-037 3, shared-project.ts). */
  onReviewChange?: (
    projectId: string,
    change: {
      review?: {
        statementId: number;
        verdict: (typeof verdicts)[number] | null;
        correction?: string | null;
        supersededBy?: number | null;
        reason?: string | null;
        by: string;
        editedAt: number;
      };
      rule?: { pattern: string; reason: string | null; removed: boolean; editedAt: number };
    },
  ) => void;
}

/** HTTP statuses of the facts error codes; server.ts merges them into its table. */
export const factStatuses: Record<string, number> = {
  SOURCE_UNAVAILABLE: 404,
  SOURCE_TOO_LARGE: 413,
};
const SOURCE_TEXT: Record<string, string> = {
  SOURCE_UNAVAILABLE:
    '원본 파일을 찾을 수 없습니다. 작업 PC에서 서버 연결과 파일 위치를 확인하세요.',
  SOURCE_TOO_LARGE: '원본이 200 MB를 넘어 원격 화면으로 보내지 않습니다. 작업 PC에서 여세요.',
};
/** `filename*` of Content-Disposition (RFC 5987), with a plain ASCII fallback. */
const disposition = (inline: boolean, name: string) =>
  `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

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
  /^\/api\/v1\/projects\/([^/]+)\/facts(?:\/(search|rules|refs)|\/(issues|statements|sources)\/(\d+)(?:\/(review|open|file))?)?$/;

export async function factRoutes(
  url: URL,
  request: IncomingMessage,
  {
    workspace,
    dataDirectory,
    body,
    send,
    remote = false,
    response,
    onReviewChange,
  }: FactRouteContext,
): Promise<boolean> {
  const match = route.exec(url.pathname);
  if (!match) return false;
  const [, projectId, list, kind, idText, action] = match;
  const method = request.method ?? 'GET';
  workspace.store.project(projectId);
  const file = knowledgeFile(dataDirectory, projectId);
  const store = new KnowledgeReviewStore(workspace.store);
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
        onReviewChange?.(projectId, {
          rule: { pattern: input.pattern, reason: null, removed: true, editedAt: Date.now() },
        });
        send(200, { rules: store.sourceRules(projectId) });
        return true;
      }
      const before = new Map(store.sourceRules(projectId).map((r) => [r.pattern, r.reason]));
      const rules = excludeFactSource(
        store,
        file,
        projectId,
        { sourceId: input.sourceId, pattern: input.pattern },
        input.reason ?? null,
        PERSON,
      );
      for (const rule of rules)
        if (!before.has(rule.pattern) || before.get(rule.pattern) !== rule.reason)
          onReviewChange?.(projectId, {
            rule: {
              pattern: rule.pattern,
              reason: rule.reason,
              removed: false,
              editedAt: Date.now(),
            },
          });
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
      const recorded = recordFactReview(store, file, projectId, id, { verdict, ...input }, PERSON);
      onReviewChange?.(projectId, {
        review: { statementId: id, verdict, ...input, by: PERSON, editedAt: Date.now() },
      });
      send(200, recorded);
      return true;
    }
    store.removeReview(projectId, id);
    onReviewChange?.(projectId, {
      review: { statementId: id, verdict: null, by: PERSON, editedAt: Date.now() },
    });
    send(200, factStatement(file, layer(), id) satisfies FactEvidence);
    return true;
  }
  if (kind === 'sources' && action === 'open' && method === 'POST') {
    // Opening an original runs a program on this PC: only the person at it (SPEC-08.4). A remote
    // screen gets the file itself instead (`…/file`).
    if (remote) throw new DomainError('FORBIDDEN');
    send(200, openKnowledgeSource(file, id));
    return true;
  }
  if (kind === 'sources' && action === 'file' && method === 'GET') {
    // The original's bytes for a browser (SPEC-08.4, the remote screen's [원본 열기]): shown when
    // a browser can (PDF, images, text), downloaded otherwise; never run here.
    if (!response) throw new DomainError('EXECUTOR_NOT_READY');
    let source: ReturnType<typeof knowledgeSourceFile>;
    let stream: ReturnType<typeof createReadStream>;
    try {
      source = knowledgeSourceFile(file, id);
      stream = createReadStream(source.path);
      await new Promise<void>((resolve, reject) => {
        stream.once('open', () => resolve());
        stream.once('error', () => reject(new DomainError('SOURCE_UNAVAILABLE')));
      });
    } catch (error) {
      // The tab the remote screen opened shows a sentence, not an error object.
      const text = error instanceof DomainError ? SOURCE_TEXT[error.code] : undefined;
      if (!text) throw error;
      response.writeHead(factStatuses[(error as DomainError).code], {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(text);
      return true;
    }
    // HTML, SVG and other active types go as downloads (octet-stream), never rendered here.
    response.writeHead(200, {
      'Content-Type': source.contentType,
      'Content-Length': String(source.size),
      'Content-Disposition': disposition(source.inline, source.name),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    stream.on('error', () => response.destroy());
    stream.pipe(response);
    return true;
  }
  throw new DomainError('NOT_FOUND');
}
