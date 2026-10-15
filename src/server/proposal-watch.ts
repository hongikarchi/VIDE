// 갱신 제안 (SPEC-05.12, ARCH-01 「작업 폴더(PLAN-52)」 '동기화 쌍과 갱신 제안', PLAN-54 T-349·T-351):
// when one file of a designated pair (SPEC-01.13 11) has a new Sync and the other has not, the
// Sync jig's comparison runs again on the two latest Syncs with the pair's fixed relation, and a
// card — one per pair — holds the mismatch rows until a person presses [적용]·[무시]·[나중에].
// Detection never changes a document or calls the AI; it runs after the Sync that triggered it
// (queued, `setImmediate`) so no Sync waits on it. Cards live in memory; only [무시] is kept.
import { randomBytes } from 'node:crypto';
import { DomainError } from '../contracts/errors.ts';
import {
  rowKey,
  setHash,
  type DismissedPairs,
  type PairRelation,
  type ResolvedPair,
} from '../core/sync-pairs.ts';
import { invert, type Point, type Row } from '../jigs/sync.ts';

export type ChangedSide = 'model' | 'drawing';
export type PairStatus =
  | 'ok'
  | 'file-missing'
  | 'no-relation'
  | 'not-synced'
  | 'link-closed'
  | 'both-changed'
  | 'error';

/** One mismatch row of a card: the Sync jig's row with the lines the viewport overlay draws. */
export interface ProposalRow {
  id: string;
  state: Exclude<Row['state'], 'match'>;
  rhino?: Row['rhino'];
  cad?: Row['cad'];
  deviation?: number;
  length?: number;
  /** The [무시] memory's key of this row. */
  key: string;
  /** For a Rhino-only row, the drawing layer it would go on (the Sync jig's layer pairing). */
  layer?: string | null;
  /** Model coordinates (m): the line as it is now on the side that follows, and after [적용]. */
  overlay?: { now?: [Point, Point]; after?: [Point, Point] };
}
export interface ProposalRefusal {
  rowId: string;
  reason: 'unsupported' | 'conflict' | 'broken';
  code: string;
}
export interface Proposal {
  id: string;
  pairId: string;
  changedSide: ChangedSide;
  changedAt: string;
  rows: ProposalRow[];
  refused: ProposalRefusal[];
  computedAt: string;
  /** The two Syncs the rows came from. */
  basis: { modelSync: string; drawingSync: string };
  names: { model: string; drawing: string };
  /** After an unclear result the card stays but is not applied again (SPEC-05.12 8). */
  blocked?: 'unclear';
}
/** One side of a pair on this PC: its linked file, its latest successful Sync. */
export interface PairSideState {
  /** The file exists on disk. */
  exists: boolean;
  linkId: string | null;
  syncId: string | null;
}
export interface ComputeResult {
  rows: Row[];
  layers: { rhino: string; cad: string; pairs: number }[];
}
export interface ApplyInput {
  rhino: string;
  cad: string;
  relation: { rotation: number; translation: [number, number]; dz: number };
  rows: {
    id: string;
    state: Row['state'];
    rhino?: string;
    cad?: string;
    layer?: string | null;
  }[];
  confirmDeletes?: boolean;
}
export interface ApplyAnswerLike {
  state: 'applied' | 'confirm' | 'failed' | 'unclear';
  id?: string;
  code?: string;
  refused?: { id: string; code: string }[];
  [key: string]: unknown;
}
export interface ProposalActionEvent {
  projectId: string;
  action: 'apply' | 'dismiss';
  proposalId: string;
  pairId: string;
  names: { model: string; drawing: string };
  rows: string[];
  /** Rhino objects of the rows (their parts, when the 부위 사전 maps them). */
  objects: string[];
  applyId?: string;
  at: string;
}
export interface ProposalWatchOptions {
  pairs: (projectId: string) => Promise<ResolvedPair[]>;
  /** The pair's two files as they are on this PC (linked file, latest Sync). */
  sides: (
    projectId: string,
    pair: ResolvedPair,
  ) => Promise<{ model: PairSideState; drawing: PairSideState }>;
  /** Whether a linked file is open in a connected host now, and whether that host is busy. */
  open: (projectId: string, linkId: string) => Promise<{ open: boolean; busy: boolean }>;
  /** The Sync jig's comparison of two stored Syncs with a fixed relation. */
  compute: (
    projectId: string,
    modelSync: string,
    drawingSync: string,
    relation: PairRelation,
  ) => ComputeResult;
  /** The link a Sync request belongs to (for a hook that knows only the request). */
  linkOf?: (projectId: string, requestId: string) => string | undefined;
  dismissed: {
    read: (projectId: string) => Promise<DismissedPairs>;
    write: (projectId: string, pairs: DismissedPairs) => Promise<void>;
  };
  /** The drawing follows the model (`DrawingBackflowService.syncApply`, PLAN-47). */
  apply: (projectId: string, input: ApplyInput) => Promise<ApplyAnswerLike>;
  /** SPEC-17.3 1: [적용]·[무시] become record candidates. */
  record?: (event: ProposalActionEvent) => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
  now?: () => Date;
  /** How long a link must stay quiet before its pairs are compared (ARCH-01: 2 s). */
  quietMs?: number;
  /** Test seam; default `setImmediate`. */
  defer?: (task: () => void) => void;
}

/** PROPOSAL_STALE carries the card computed again. */
export class ProposalStale extends DomainError {
  readonly proposal: Proposal | null;
  constructor(proposal: Proposal | null) {
    super('PROPOSAL_STALE');
    this.proposal = proposal;
  }
}

interface PairMemory {
  /** Link change counters when the pair was last compared. */
  basis?: { model: number; drawing: number };
  status?: 'both-changed' | 'error' | 'link-closed';
  code?: string;
  card?: Proposal;
  /** [나중에]: the card is folded until the pair's next change. */
  later?: boolean;
  /** Our own [적용] changes the drawing: that change is not a new 'drawing changed'. */
  ownChange?: ChangedSide;
  /** When [적용] set `ownChange`: only a drawing Sync soon after it is ours. */
  ownChangeAt?: number;
}

/** A drawing Sync later than this after our [적용] is a person's change again. */
const OWN_CHANGE_MS = 10_000;

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const newId = () => randomBytes(6).toString('hex');
const pairKey = (projectId: string, pairId: string) => `${projectId}|${pairId}`;
const linkKey = (projectId: string, linkId: string) => `${projectId}|${linkId}`;
const straightLine = (points: [Point, Point] | undefined, t: PairRelation) =>
  points ? (points.map((p) => invert(t, p)) as [Point, Point]) : undefined;

/** The rows a card shows: every non-matching row, with its key and overlay lines. */
export function proposalRows(result: ComputeResult, relation: PairRelation, side: ChangedSide) {
  const bestLayer = (layer: string) => result.layers.find((l) => l.rhino === layer)?.cad ?? null;
  const rows: ProposalRow[] = [];
  const refused: ProposalRefusal[] = [];
  for (const row of result.rows) {
    if (row.state === 'match') continue;
    // In model coordinates: the model's line (the drawing's mapping inverted) and the drawing's.
    const model = straightLine(row.ends?.rhino, relation);
    const drawing = row.inRhino;
    const overlay =
      side === 'model'
        ? {
            ...(row.state !== 'rhino-only' && drawing ? { now: drawing } : {}),
            ...(row.state !== 'cad-only' && model ? { after: model } : {}),
          }
        : {
            ...(row.state !== 'cad-only' && model ? { now: model } : {}),
            ...(row.state !== 'rhino-only' && drawing ? { after: drawing } : {}),
          };
    rows.push({
      id: row.id,
      state: row.state,
      ...(row.rhino ? { rhino: row.rhino } : {}),
      ...(row.cad ? { cad: row.cad } : {}),
      ...(row.deviation !== undefined ? { deviation: row.deviation } : {}),
      ...(row.length !== undefined ? { length: row.length } : {}),
      key: rowKey(row),
      ...(row.state === 'rhino-only' && row.rhino ? { layer: bestLayer(row.rhino.layer) } : {}),
      ...(overlay.now || overlay.after ? { overlay } : {}),
    });
    // A solid's section edge is compared only (SPEC-05.8): it never goes into an apply.
    if (row.rhino?.rule === 'section')
      refused.push({ rowId: row.id, reason: 'unsupported', code: 'SECTION_EDGE' });
  }
  return { rows, refused };
}

/** The pairs' change watch and its cards (one instance per engine). */
export class ProposalWatch {
  private readonly now: () => Date;
  private readonly defer: (task: () => void) => void;
  private readonly quietMs: number;
  private readonly versions = new Map<string, number>();
  private readonly memory = new Map<string, PairMemory>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Set<Promise<void>>();
  /** Per project: one comparison at a time (a burst of Syncs is not compared in parallel). */
  private readonly chains = new Map<string, Promise<void>>();
  private stopped = false;
  private readonly options: ProposalWatchOptions;
  constructor(options: ProposalWatchOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.defer = options.defer ?? ((task) => void setImmediate(task));
    this.quietMs = options.quietMs ?? 2000;
  }

  private log(event: string, fields: Record<string, unknown>) {
    try {
      this.options.log?.(event, fields);
    } catch {
      /* the diagnostics log never fails the watch */
    }
  }
  private track(work: Promise<void>) {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }
  private serial(projectId: string, work: () => Promise<void>): Promise<void> {
    const before = this.chains.get(projectId) ?? Promise.resolve();
    const next = before.then(work).catch((error: unknown) =>
      this.log('proposal-watch-failed', {
        projectId,
        code: error instanceof DomainError ? error.code : 'ERROR',
      }),
    );
    this.chains.set(projectId, next);
    this.track(next);
    return next;
  }
  /** Like `serial`, but the caller gets the result or the error (actions from the card). */
  private exclusive<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const before = this.chains.get(projectId) ?? Promise.resolve();
    const result = before.then(work);
    const next = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(projectId, next);
    this.track(next);
    return result;
  }
  private version(projectId: string, linkId: string | null) {
    return linkId ? (this.versions.get(linkKey(projectId, linkId)) ?? 0) : 0;
  }
  private mem(projectId: string, pairId: string) {
    const key = pairKey(projectId, pairId);
    let held = this.memory.get(key);
    if (!held) this.memory.set(key, (held = {}));
    return held;
  }

  /**
   * ARCH-01 `onDocumentSynced`: a linked file has a new Sync (Live Sync applied, or a manual Sync
   * saved). Returns at once; the pairs of that link are compared once it has been quiet for 2 s.
   */
  notifySynced(event: {
    projectId: string;
    linkId?: string | null;
    requestId?: string | null;
    kind: 'live' | 'manual';
  }): void {
    if (this.stopped) return;
    try {
      this.defer(() => {
        if (this.stopped) return;
        try {
          const linkId =
            event.linkId ??
            (event.requestId ? this.options.linkOf?.(event.projectId, event.requestId) : undefined);
          if (!linkId) return;
          const key = linkKey(event.projectId, linkId);
          this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
          clearTimeout(this.timers.get(key));
          const timer = setTimeout(() => {
            this.timers.delete(key);
            if (!this.stopped) void this.changed(event.projectId, linkId);
          }, this.quietMs);
          timer.unref?.();
          this.timers.set(key, timer);
        } catch (error) {
          this.log('proposal-watch-failed', {
            projectId: event.projectId,
            code: error instanceof DomainError ? error.code : 'ERROR',
          });
        }
      });
    } catch {
      /* never fails the Sync */
    }
  }

  /** Compares every ok pair that has `linkId` on one side (the link changed). */
  changed(projectId: string, linkId: string): Promise<void> {
    return this.serial(projectId, async () => {
      for (const pair of await this.options.pairs(projectId)) {
        const sides = await this.options.sides(projectId, pair);
        const side: ChangedSide | null =
          sides.model.linkId === linkId
            ? 'model'
            : sides.drawing.linkId === linkId
              ? 'drawing'
              : null;
        if (side) await this.evaluate(projectId, pair, sides, side);
      }
    });
  }

  /**
   * Once per poll of the cards: a pair whose link was closed is compared again when it is open
   * (SPEC-05.12 5) — once, not once per change made while it was closed.
   */
  reopened(projectId: string): Promise<void> {
    return this.serial(projectId, async () => {
      for (const pair of await this.options.pairs(projectId)) {
        const held = this.memory.get(pairKey(projectId, pair.id));
        if (held?.status !== 'link-closed') continue;
        const sides = await this.options.sides(projectId, pair);
        await this.evaluate(projectId, pair, sides, null);
      }
    });
  }

  /** The status of a pair (computed on read; ARCH-01 '쌍 상태'). */
  async status(
    projectId: string,
    pair: ResolvedPair,
  ): Promise<{ status: PairStatus; code?: string }> {
    const sides = await this.options.sides(projectId, pair);
    const fixed = this.fixedStatus(pair, sides);
    if (fixed) return { status: fixed };
    for (const linkId of [sides.model.linkId, sides.drawing.linkId])
      if (linkId && !(await this.options.open(projectId, linkId)).open)
        return { status: 'link-closed' };
    const held = this.memory.get(pairKey(projectId, pair.id));
    if (held?.status === 'both-changed' || held?.status === 'error')
      return { status: held.status, ...(held.code ? { code: held.code } : {}) };
    return { status: 'ok' };
  }
  private fixedStatus(
    pair: ResolvedPair,
    sides: { model: PairSideState; drawing: PairSideState },
  ): PairStatus | null {
    if (!sides.model.exists || !sides.drawing.exists) return 'file-missing';
    if (!pair.relation) return 'no-relation';
    if (!sides.model.syncId || !sides.drawing.syncId) return 'not-synced';
    return null;
  }

  private compare(projectId: string, pair: ResolvedPair, modelSync: string, drawingSync: string) {
    return this.options.compute(projectId, modelSync, drawingSync, pair.relation!);
  }

  private async evaluate(
    projectId: string,
    pair: ResolvedPair,
    sides: { model: PairSideState; drawing: PairSideState },
    trigger: ChangedSide | null,
  ) {
    const held = this.mem(projectId, pair.id);
    if (this.fixedStatus(pair, sides)) {
      held.card = undefined;
      held.status = undefined;
      return;
    }
    for (const linkId of [sides.model.linkId, sides.drawing.linkId])
      if (!linkId || !(await this.options.open(projectId, linkId)).open) {
        // SPEC-05.12 5: no card while a side is closed; compared once when it opens again.
        held.card = undefined;
        held.status = 'link-closed';
        return;
      }
    const now = { model: this.version(projectId, sides.model.linkId), drawing: 0 };
    now.drawing = this.version(projectId, sides.drawing.linkId);
    const modelChanged = held.basis ? now.model > held.basis.model : trigger === 'model';
    let drawingChanged = held.basis ? now.drawing > held.basis.drawing : trigger === 'drawing';
    // Our own [적용] rewrote the drawing: that Sync is not a person's change of the drawing.
    if (
      held.ownChange === 'drawing' &&
      this.now().getTime() - (held.ownChangeAt ?? 0) > OWN_CHANGE_MS
    )
      held.ownChange = undefined;
    if (held.ownChange === 'drawing' && drawingChanged && !modelChanged) {
      drawingChanged = false;
      held.ownChange = undefined;
    }
    held.basis = now;
    if (modelChanged && drawingChanged) {
      // SPEC-05.12 2: which side to fix cannot be told; the pair shows '양쪽 변경'.
      held.card = undefined;
      held.later = false;
      held.status = 'both-changed';
      return;
    }
    const changedSide: ChangedSide = modelChanged
      ? 'model'
      : drawingChanged
        ? 'drawing'
        : (held.card?.changedSide ?? trigger ?? 'model');
    const isChange = modelChanged || drawingChanged;
    // A quiet timer whose change an earlier comparison already counted: nothing new to compare.
    if (!isChange && trigger) return;
    if (isChange) held.later = false;
    let result: ComputeResult;
    try {
      result = this.compare(projectId, pair, sides.model.syncId!, sides.drawing.syncId!);
    } catch (error) {
      // SPEC-05.12 8 ④: no card; the pair shows the error.
      held.card = undefined;
      held.status = 'error';
      held.code = error instanceof DomainError ? error.code : 'COMPUTE_FAILED';
      this.log('proposal-compute-failed', { projectId, pairId: pair.id, code: held.code });
      return;
    }
    held.status = undefined;
    held.code = undefined;
    const { rows, refused } = proposalRows(result, pair.relation!, changedSide);
    if (!rows.length) {
      // Matched by hand in the host: the card closes itself (SPEC-05.12 4).
      held.card = undefined;
      return;
    }
    const keys = rows.map((row) => row.key);
    const dismissed = (await this.options.dismissed.read(projectId))[pair.id];
    if (dismissed) {
      const known = new Set(dismissed.rowKeys);
      if (keys.every((key) => known.has(key))) {
        held.card = undefined;
        return;
      }
    }
    const at = this.now().toISOString();
    const hash = setHash(keys);
    const before = held.card;
    const same = before && setHash(before.rows.map((row) => row.key)) === hash;
    held.card = {
      id: before?.id ?? newId(),
      pairId: pair.id,
      changedSide,
      changedAt: isChange || !before ? at : before.changedAt,
      rows: same && before ? before.rows : rows,
      refused: same && before ? before.refused : refused,
      computedAt: at,
      basis: { modelSync: sides.model.syncId!, drawingSync: sides.drawing.syncId! },
      names: { model: baseName(pair.absolute.model), drawing: baseName(pair.absolute.drawing) },
      ...(same && before?.blocked ? { blocked: before.blocked } : {}),
    };
  }

  /** The cards to show (folded [나중에] cards are not listed). */
  proposals(projectId: string): Proposal[] {
    const out: Proposal[] = [];
    for (const [key, held] of this.memory)
      if (key.startsWith(projectId + '|') && held.card && !held.later) out.push(held.card);
    return out.sort((a, b) => b.changedAt.localeCompare(a.changedAt));
  }
  private find(projectId: string, proposalId: string) {
    for (const [key, held] of this.memory)
      if (key.startsWith(projectId + '|') && held.card?.id === proposalId)
        return { held, card: held.card };
    throw new DomainError('PROPOSAL_NOT_FOUND');
  }

  /** [나중에]: folded until the pair's next change; no record (SPEC-05.12 4·7). */
  later(projectId: string, proposalId: string): { proposal: null } {
    const { held } = this.find(projectId, proposalId);
    held.later = true;
    return { proposal: null };
  }

  /** [무시]: this mismatch set is remembered; a new mismatch shows the card again. */
  dismiss(projectId: string, proposalId: string): Promise<{ proposal: null }> {
    return this.exclusive(projectId, () => this.dismissNow(projectId, proposalId));
  }
  private async dismissNow(projectId: string, proposalId: string): Promise<{ proposal: null }> {
    const { held, card } = this.find(projectId, proposalId);
    const keys = card.rows.map((row) => row.key);
    const all = await this.options.dismissed.read(projectId);
    all[card.pairId] = { setHash: setHash(keys), rowKeys: keys, at: this.now().toISOString() };
    await this.options.dismissed.write(projectId, all);
    held.card = undefined;
    this.record(projectId, 'dismiss', card, card.rows);
    return { proposal: null };
  }

  /**
   * [적용] (SPEC-05.12 6): computed again first — a different list is not applied (PROPOSAL_STALE
   * with the new card). A model-changed pair makes the drawing follow through the backflow apply.
   */
  apply(
    projectId: string,
    proposalId: string,
    input: { rows?: string[]; confirmDeletes?: boolean } = {},
  ): Promise<{ proposal: Proposal | null; result: ApplyAnswerLike }> {
    // In the project's chain: a Sync evaluation cannot put back a card [적용] just closed.
    return this.exclusive(projectId, () => this.applyNow(projectId, proposalId, input));
  }
  private async applyNow(
    projectId: string,
    proposalId: string,
    input: { rows?: string[]; confirmDeletes?: boolean },
  ): Promise<{ proposal: Proposal | null; result: ApplyAnswerLike }> {
    const { held, card } = this.find(projectId, proposalId);
    if (card.blocked === 'unclear') throw new DomainError('OUTPUT_UNCLEAR');
    // The model following the drawing waits for the PLAN-54 decision (SPEC-05.12 6, Design R-82).
    if (card.changedSide === 'drawing') throw new DomainError('PROPOSAL_DIRECTION_PENDING');
    const pair = (await this.options.pairs(projectId)).find((entry) => entry.id === card.pairId);
    if (!pair) throw new DomainError('PAIR_NOT_FOUND');
    const sides = await this.options.sides(projectId, pair);
    if (this.fixedStatus(pair, sides)) throw new DomainError('PAIR_LINK_CLOSED');
    for (const linkId of [sides.model.linkId!, sides.drawing.linkId!]) {
      const state = await this.options.open(projectId, linkId);
      if (!state.open) throw new DomainError('PAIR_LINK_CLOSED');
      if (state.busy) throw new DomainError('HOST_BUSY');
    }
    const result = this.compare(projectId, pair, sides.model.syncId!, sides.drawing.syncId!);
    const fresh = proposalRows(result, pair.relation!, card.changedSide);
    if (
      setHash(fresh.rows.map((row) => row.key)) !== setHash(card.rows.map((row) => row.key)) ||
      sides.model.syncId !== card.basis.modelSync ||
      sides.drawing.syncId !== card.basis.drawingSync
    ) {
      const at = this.now().toISOString();
      held.card = fresh.rows.length
        ? {
            ...card,
            rows: fresh.rows,
            refused: fresh.refused,
            computedAt: at,
            basis: { modelSync: sides.model.syncId!, drawingSync: sides.drawing.syncId! },
          }
        : undefined;
      throw new ProposalStale(held.card ?? null);
    }
    const refusedIds = new Set(card.refused.map((entry) => entry.rowId));
    const wanted = input.rows ? new Set(input.rows) : null;
    // SPEC-14.10 3: without a choice the default is additions and changes; a deletion
    // (CAD에만) is applied only when it was chosen.
    const chosen = card.rows.filter(
      (row) => !refusedIds.has(row.id) && (wanted ? wanted.has(row.id) : row.state !== 'cad-only'),
    );
    if (!chosen.length) throw new DomainError('ROW_NOT_SELECTABLE');
    let answer: ApplyAnswerLike;
    try {
      answer = await this.options.apply(projectId, {
        rhino: card.basis.modelSync,
        cad: card.basis.drawingSync,
        relation: {
          rotation: pair.relation!.rotation,
          translation: pair.relation!.translation,
          dz: pair.relation!.dz,
        },
        rows: chosen.map((row) => ({
          id: row.id,
          state: row.state,
          ...(row.rhino ? { rhino: row.rhino.nativeId } : {}),
          ...(row.cad ? { cad: row.cad.nativeId } : {}),
          ...(row.state === 'rhino-only' ? { layer: row.layer ?? null } : {}),
        })),
        ...(input.confirmDeletes ? { confirmDeletes: true } : {}),
      });
    } catch (error) {
      const code = error instanceof DomainError ? error.code : '';
      if (code === 'ZWCAD_ATTACHED_EDIT_UNAVAILABLE' || code === 'NO_ZWCAD')
        throw new DomainError('PAIR_LINK_CLOSED');
      if (code === 'PROJECT_BUSY') throw new DomainError('HOST_BUSY');
      throw error;
    }
    if (answer.state === 'applied') {
      held.card = undefined;
      held.ownChange = 'drawing';
      held.ownChangeAt = this.now().getTime();
      this.record(projectId, 'apply', card, chosen, answer.id);
      return { proposal: null, result: answer };
    }
    if (answer.state === 'unclear') held.card = { ...card, blocked: 'unclear' };
    return { proposal: held.card ?? null, result: answer };
  }

  private record(
    projectId: string,
    action: 'apply' | 'dismiss',
    card: Proposal,
    rows: readonly ProposalRow[],
    applyId?: string,
  ) {
    try {
      this.options.record?.({
        projectId,
        action,
        proposalId: card.id,
        pairId: card.pairId,
        names: card.names,
        rows: rows.map((row) => row.id),
        objects: [
          ...new Set(rows.flatMap((row) => (row.rhino?.nativeId ? [row.rhino.nativeId] : []))),
        ],
        ...(applyId ? { applyId } : {}),
        at: this.now().toISOString(),
      });
    } catch {
      /* a record never fails the action */
    }
  }

  /** [쌍 해제]: the card closes and the pair's memory goes (SPEC-01.13 11). */
  async forget(projectId: string, pairId: string): Promise<void> {
    this.memory.delete(pairKey(projectId, pairId));
    const all = await this.options.dismissed.read(projectId);
    if (all[pairId]) {
      delete all[pairId];
      await this.options.dismissed.write(projectId, all);
    }
  }

  /** Resolves when the queued comparisons have run (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
  /** Shutdown: waiting comparisons are dropped; nothing is queued after this. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
