import { z } from 'zod';
import { DomainError } from '../contracts/errors.ts';
import type { PairRelation, ResolvedPair, SyncPairStore } from '../core/sync-pairs.ts';
import { ProposalStale, type ProposalWatch } from './proposal-watch.ts';

/**
 * 동기화 쌍과 갱신 제안 (SPEC-01.13 11, SPEC-05.12, ARCH-01 「작업 폴더(PLAN-52)」 '동기화 쌍과 갱신
 * 제안', PLAN-54 T-349·T-351), under `/api/v1/projects/:id`:
 * `GET workspace/pairs` → `{pairs: [{…pair, absolute, status, code?, names}]}`,
 * `POST workspace/pairs {model, drawing, relation?}` → `{pair}`,
 * `PATCH workspace/pairs/:pairId {relation}` → `{pair}`, `DELETE workspace/pairs/:pairId` → 204,
 * `GET proposals` → `{proposals}`, `POST proposals/:proposalId/apply {rows?, confirmDeletes?}` ·
 * `…/dismiss` · `…/later` → `{proposal|null, result?}`. A remote session reads only.
 */
export const pairStatuses: Record<string, number> = {
  PAIR_EXISTS: 409,
  PAIR_NOT_FOUND: 404,
  PAIR_NOT_COMPARED: 409,
};
export const proposalStatuses: Record<string, number> = {
  PROPOSAL_NOT_FOUND: 404,
  PROPOSAL_STALE: 409,
  PROPOSAL_DIRECTION_PENDING: 409,
  PAIR_LINK_CLOSED: 409,
  HOST_BUSY: 409,
};

const finite = z.number().finite();
const relationSchema = z
  .object({ rotation: finite, translation: z.tuple([finite, finite]), dz: finite })
  .strict();
const path = z.string().min(3).max(1024);
const addSchema = z
  .object({ model: path, drawing: path, relation: relationSchema.optional() })
  .strict();
const patchSchema = z.object({ relation: relationSchema }).strict();
const applySchema = z
  .object({
    rows: z.array(z.string().min(1).max(40)).max(5000).optional(),
    confirmDeletes: z.boolean().optional(),
  })
  .strict();

export interface PairPreparation {
  /** The two files were compared in this project (a Sync jig pair record exists). */
  compared: boolean;
  /** The relation the pair keeps when the request names none (the Sync jig's, if any). */
  relation?: Omit<PairRelation, 'confirmedAt'>;
  linkIds?: { model?: string; drawing?: string };
}
export interface SyncPairRouteDeps {
  pairs: SyncPairStore;
  watch: ProposalWatch;
  /** Throws NOT_FOUND for an unknown project. */
  project: (projectId: string) => unknown;
  body: () => Promise<Record<string, unknown>>;
  send: (status: number, value: unknown) => void;
  /** A 204 answer with no body. */
  noContent: () => void;
  remote: boolean;
  /** Who designates (the account's display name). */
  actor?: () => string | null | undefined;
  /** Whether and how two files were compared (ARCH-01: baseline pairs or a Sync jig record). */
  prepare: (
    projectId: string,
    files: { model: string; drawing: string },
  ) => Promise<PairPreparation>;
}

const baseName = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() ?? value;
const named = (pair: ResolvedPair) => ({
  model: baseName(pair.absolute.model),
  drawing: baseName(pair.absolute.drawing),
});

export async function syncPairRoutes(
  url: URL,
  method: string | undefined,
  deps: SyncPairRouteDeps,
): Promise<boolean> {
  const pairs = /^\/api\/v1\/projects\/([^/]+)\/workspace\/pairs(?:\/([a-z0-9]{12}))?$/.exec(
    url.pathname,
  );
  const proposals =
    /^\/api\/v1\/projects\/([^/]+)\/proposals(?:\/([a-f0-9]{12})\/(apply|dismiss|later))?$/.exec(
      url.pathname,
    );
  if (!pairs && !proposals) return false;
  const projectId = decodeURIComponent((pairs ?? proposals)![1]!);
  deps.project(projectId);
  if (method !== 'GET' && deps.remote) throw new DomainError('FORBIDDEN');

  if (pairs) {
    const pairId = pairs[2];
    if (!pairId && method === 'GET') {
      const list = await deps.pairs.list(projectId);
      const out = [];
      for (const pair of list)
        out.push({ ...pair, ...(await deps.watch.status(projectId, pair)), names: named(pair) });
      deps.send(200, { pairs: out });
      return true;
    }
    if (!pairId && method === 'POST') {
      const input = addSchema.parse(await deps.body());
      const prepared = await deps.prepare(projectId, input);
      if (!prepared.compared) throw new DomainError('PAIR_NOT_COMPARED');
      const relation = input.relation ?? prepared.relation;
      const pair = await deps.pairs.add(projectId, {
        model: input.model,
        drawing: input.drawing,
        ...(relation ? { relation } : {}),
        ...(prepared.linkIds ? { linkIds: prepared.linkIds } : {}),
        createdBy: deps.actor?.() ?? null,
      });
      deps.send(200, { pair: { ...pair, names: named(pair) } });
      return true;
    }
    if (pairId && method === 'PATCH') {
      const input = patchSchema.parse(await deps.body());
      const pair = await deps.pairs.setRelation(projectId, pairId, input.relation);
      deps.send(200, { pair: { ...pair, names: named(pair) } });
      return true;
    }
    if (pairId && method === 'DELETE') {
      await deps.pairs.remove(projectId, pairId);
      await deps.watch.forget(projectId, pairId);
      deps.noContent();
      return true;
    }
    return false;
  }

  const [, , proposalId, action] = proposals!;
  if (!proposalId && method === 'GET') {
    // A closed side opened again is compared once (SPEC-05.12 5); this poll does not wait for it.
    void deps.watch.reopened(projectId);
    deps.send(200, { proposals: deps.watch.proposals(projectId) });
    return true;
  }
  if (!proposalId || method !== 'POST') return false;
  if (action === 'later') deps.send(200, deps.watch.later(projectId, proposalId));
  else if (action === 'dismiss') deps.send(200, await deps.watch.dismiss(projectId, proposalId));
  else {
    const input = applySchema.parse(await deps.body());
    try {
      deps.send(200, await deps.watch.apply(projectId, proposalId, input));
    } catch (error) {
      if (!(error instanceof ProposalStale)) throw error;
      deps.send(409, { code: error.code, proposal: error.proposal });
    }
  }
  return true;
}
