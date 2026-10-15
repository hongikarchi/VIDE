/**
 * 시점 형상 (PLAN-53 T-335, ARCH-01 §5 「시점 형상」, SPEC-17.5, Design SCR-46 구현 기준): the dated
 * moments of a project's model — each linked file's successful document Syncs (a pruned one has no
 * geometry left and is left out) and the saved 검토본. Pure: no DOM, no three.js. The timeline draws
 * their ticks; a cursor date picks, per linked file, the latest moment on or before it, and that
 * file's Sync is drawn in its place when it is not the file's latest (replaced, never overlaid —
 * SPEC-17 R-86). A 검토본 of a request that is no linked file's Sync (an AI result) is a tick only.
 */

export interface MomentSyncInput {
  /** The Sync's request id. */
  requestId: string;
  linkId: string;
  /** The linked file's name (the tick's hover line). */
  linkName: string;
  createdAt: string;
  /** `result.modelStore === 'pruned'`: no geometry left. */
  pruned?: boolean;
}
export interface MomentReviewInput {
  id: string;
  requestId: string;
  title: string;
  createdAt: string;
}
export interface Moment {
  kind: 'sync' | 'review';
  /** The Sync shown for this moment (a 검토본's own `requestId`). */
  requestId: string;
  /** The linked file whose place it takes; absent for a 검토본 of no linked Sync (tick only). */
  linkId?: string;
  reviewId?: string;
  /** Local date 'YYYY-MM-DD'. */
  date: string;
  at: string;
  /** '10-01 검토본 · A안' / '09-30 동기화 · A.3dm'. */
  line: string;
}
export interface MomentTick {
  date: string;
  /** A day with a 검토본 draws as a 검토본 tick (taller). */
  kind: 'review' | 'sync';
  lines: string[];
}
export interface MomentPick {
  /** Per linked file: the Sync to draw in its place (only where it is not the file's latest). */
  overrides: Map<string, string>;
  /** The latest of the chosen moments (the basis line), or null: current model, parts only. */
  basis: Moment | null;
}

const two = (n: number) => String(n).padStart(2, '0');
/** The local calendar date of an ISO time ('YYYY-MM-DD'); '' when unreadable. */
export function localDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}
const short = (date: string) => date.slice(5);

/** Every moment, oldest first (same time: the Sync before its 검토본). */
export function buildMoments(
  syncs: readonly MomentSyncInput[],
  reviews: readonly MomentReviewInput[],
): Moment[] {
  const byRequest = new Map<string, MomentSyncInput>();
  const moments: Moment[] = [];
  for (const sync of syncs) {
    if (sync.pruned) continue;
    const date = localDate(sync.createdAt);
    if (!date) continue;
    byRequest.set(sync.requestId, sync);
    moments.push({
      kind: 'sync',
      requestId: sync.requestId,
      linkId: sync.linkId,
      date,
      at: sync.createdAt,
      line: `${short(date)} 동기화 · ${sync.linkName}`,
    });
  }
  for (const review of reviews) {
    const date = localDate(review.createdAt);
    if (!date) continue;
    const sync = byRequest.get(review.requestId);
    moments.push({
      kind: 'review',
      requestId: review.requestId,
      ...(sync ? { linkId: sync.linkId } : {}),
      reviewId: review.id,
      date,
      at: review.createdAt,
      line: `${short(date)} 검토본 · ${review.title}`,
    });
  }
  return moments.sort(
    (a, b) => a.at.localeCompare(b.at) || (a.kind === b.kind ? 0 : a.kind === 'sync' ? -1 : 1),
  );
}

/** One tick per day: a 검토본 day is a 검토본 tick; every moment of the day is a hover line. */
export function momentTicks(moments: readonly Moment[]): MomentTick[] {
  const days = new Map<string, MomentTick>();
  for (const moment of moments) {
    const tick = days.get(moment.date);
    if (!tick)
      days.set(moment.date, { date: moment.date, kind: moment.kind, lines: [moment.line] });
    else {
      tick.lines.push(moment.line);
      if (moment.kind === 'review') tick.kind = 'review';
    }
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The moments shown at `date` ('YYYY-MM-DD', inclusive). `latest`: each linked file's latest Sync
 * (its current geometry) — a file whose chosen moment is that Sync needs no override. A file with
 * no moment on or before `date` stays current.
 */
export function pickMoments(
  moments: readonly Moment[],
  date: string,
  latest: ReadonlyMap<string, string | undefined>,
): MomentPick {
  const chosen = new Map<string, Moment>();
  for (const moment of moments) {
    if (!moment.linkId || moment.date > date) continue;
    // Oldest first: a later moment of the file replaces an earlier one.
    chosen.set(moment.linkId, moment);
  }
  const overrides = new Map<string, string>();
  let basis: Moment | null = null;
  for (const [linkId, moment] of chosen) {
    if (latest.get(linkId) !== moment.requestId) overrides.set(linkId, moment.requestId);
    if (!basis || moment.at > basis.at) basis = moment;
  }
  return { overrides, basis };
}

/** The basis line over the viewport. */
export function basisText(basis: Moment | null, loading = false): string {
  if (!basis) return '현재 모델 · 부위만 표시';
  const kind = basis.kind === 'review' ? '검토본' : '동기화';
  return loading ? `${basis.date} ${kind} 불러오는 중…` : `${basis.date} ${kind} 기준`;
}
