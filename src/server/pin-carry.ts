// Pins carried over a Rhino restart (SPEC-02.16, user decision 2026-10-02). A pin names an object
// of one Sync (its basis). When Rhino is closed and the same file reopened, the new window's Sync
// carries the same link id but a new Rhino instance, and the old instance no longer answers: a
// request on the old basis failed with STALE_CONNECTION before the AI ran (request 6ee24721).
// At submission each pin whose basis is a Sync of an older instance moves to the newest Sync of the
// same link, matched by object id (Rhino keeps object ids in the saved file) or native id. The
// request's baseRequestId (and a linked target) on that basis moves with it. Only when some pinned
// object is not in the newest Sync is the request refused, naming how many were not found.
import { DomainError } from '../contracts/errors.ts';

/** A refusal whose reason names the count; the server sends `reason` beside `code`. */
export class PinCarryError extends DomainError {
  reason: string;
  constructor(missing: number, total: number) {
    super('PINS_NOT_FOUND');
    this.reason =
      `Rhino 문서를 다시 연 뒤 고정한 객체 ${total}개 중 ${missing}개를 찾지 못했습니다. ` +
      '다시 고정하세요.';
  }
}

interface Row {
  id: string;
  state?: string;
  input?: unknown;
  result?: unknown;
}
export interface PinCarryStore {
  /** Requests in stored order (light rows: no display geometry). */
  list(projectId: string): readonly Row[];
  summary(projectId: string, id: string): Row;
}

type Loose = Record<string, unknown>;
const record = (value: unknown): Loose =>
  value && typeof value === 'object' ? (value as Loose) : {};
/** The Rhino window a Sync came from: its link and instance (null for anything else). */
function windowOf(row: Row | undefined) {
  if (!row || row.state !== 'succeeded') return null;
  const result = record(row.result);
  if (!result.hostExecuted || (result.host ?? 'rhino') !== 'rhino') return null;
  const source = record(result.sourceDocument);
  const link = record(row.input).linkId ?? source.linkId;
  if (typeof link !== 'string' || typeof source.instance !== 'string') return null;
  // A turn's result names the Sync snapshot it stands on (sourceDocument.id); a Sync names itself.
  const sync = typeof source.id === 'string' ? source.id : row.id;
  return { link, instance: source.instance, documentId: source.documentId, sync };
}
const objectsOf = (row: Row) => {
  const objects = record(row.result).objects;
  return (Array.isArray(objects) ? objects : []) as { id?: unknown; nativeId?: unknown }[];
};

/**
 * Rewrites `input.pins`, `input.baseRequestId` and `input.linkedTargets[].baseRequestId` in place
 * when their basis is a Sync of an older Rhino instance of the same link. Returns how many pins
 * moved. Throws PinCarryError when a pinned object is not in the newest Sync.
 */
export function carryPins(store: PinCarryStore, projectId: string, input: Loose): number {
  const pins = Array.isArray(input.pins) ? (input.pins as Loose[]) : [];
  if (!pins.length) return 0;
  const rows = store.list(projectId);
  const moved = new Map<string, Row | null>();
  const newer = (basis: string) => {
    if (moved.has(basis)) return moved.get(basis)!;
    let old: Row | undefined;
    try {
      old = store.summary(projectId, basis);
    } catch {
      old = undefined; // An unknown basis is refused by the workspace as before.
    }
    const from = windowOf(old);
    const latest = from
      ? rows.filter((row) => row.id !== basis && windowOf(row)?.link === from.link).at(-1)
      : undefined;
    const to = windowOf(latest);
    // Only another Rhino window (a restart or reopen) moves the pins; the same window keeps them.
    let target: Row | null = null;
    if (
      to &&
      to.sync !== basis &&
      (to.instance !== from!.instance || to.documentId !== from!.documentId)
    )
      try {
        target = store.summary(projectId, to.sync);
      } catch {
        target = null;
      }
    moved.set(basis, target);
    return target;
  };
  let carried = 0;
  let missing = 0;
  const next = pins.map((pin) => {
    if (typeof pin.basis !== 'string' || typeof pin.id !== 'string') return pin;
    const target = newer(pin.basis);
    if (!target) return pin;
    const before = objectsOf(store.summary(projectId, pin.basis)).find((o) => o.id === pin.id);
    const native = typeof before?.nativeId === 'string' ? before.nativeId : pin.id;
    const found = objectsOf(target).find((o) => o.id === pin.id || o.nativeId === native);
    if (!found || typeof found.id !== 'string') {
      missing++;
      return pin;
    }
    carried++;
    return { ...pin, id: found.id, basis: target.id };
  });
  if (missing) throw new PinCarryError(missing, pins.length);
  if (!carried) return 0;
  input.pins = next;
  const moveBase = (id: unknown) =>
    typeof id === 'string' && moved.get(id) ? moved.get(id)!.id : id;
  if (typeof input.baseRequestId === 'string') input.baseRequestId = moveBase(input.baseRequestId);
  if (Array.isArray(input.linkedTargets))
    input.linkedTargets = (input.linkedTargets as Loose[]).map((item) => ({
      ...item,
      baseRequestId: moveBase(item.baseRequestId),
    }));
  return carried;
}
