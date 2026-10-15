// Row × time chart layout (PLAN-52 T-319 파일 지도, shared with PLAN-53's 부위×시간 차트): pure
// functions over a generic model — rows, items placed on a row at a time, links between items and
// milestones (events) on items. No DOM: the screen draws what these return, the tests check them.

export interface ChartRow {
  id: string;
  label: string;
}
export interface ChartItem {
  id: string;
  row: string;
  /** Time in ms; null: no time (drawn at the left edge of the row). */
  t: number | null;
  kind: string;
  label: string;
}
export interface ChartLink {
  from: string;
  to: string;
  kind: string;
  /** When the relation exists from (ms); null: always. */
  t?: number | null;
}
export interface ChartMilestone {
  t: number;
  kind: string;
  label: string;
  items: string[];
}
export interface ChartModel {
  rows: ChartRow[];
  items: ChartItem[];
  links: ChartLink[];
  milestones: ChartMilestone[];
}
export interface Domain {
  start: number;
  end: number;
}
export interface PlacedItem {
  id: string;
  x: number;
  y: number;
  /** The label line under the row's dot line (0 = beside the dot). */
  lane: number;
}
export interface PlacedRow {
  id: string;
  label: string;
  y: number;
  height: number;
}
export interface ChartLayout {
  rows: PlacedRow[];
  items: Map<string, PlacedItem>;
  width: number;
  height: number;
  domain: Domain;
}
export interface LayoutOptions {
  /** Width of the time area (px), after the row names. */
  width: number;
  rowHeight?: number;
  laneHeight?: number;
  /** Room kept left and right of the time area. */
  pad?: number;
  /** Estimated label width per character (px). */
  charWidth?: number;
}

const DAY = 86_400_000;

/** The time span covering the items and milestones, widened to at least a day. */
export function timeDomain(model: Pick<ChartModel, 'items' | 'milestones'>): Domain {
  const times = [
    ...model.items.flatMap((item) => (item.t === null ? [] : [item.t])),
    ...model.milestones.map((milestone) => milestone.t),
  ];
  if (!times.length) {
    const now = Date.now();
    return { start: now - DAY, end: now };
  }
  let start = Math.min(...times),
    end = Math.max(...times);
  if (end - start < DAY) {
    const middle = (start + end) / 2;
    start = middle - DAY / 2;
    end = middle + DAY / 2;
  }
  return { start, end };
}

/** Time → x (px) over `width`, keeping `pad` at both ends. */
export function timeScale(domain: Domain, width: number, pad = 12) {
  const span = Math.max(1, domain.end - domain.start);
  const usable = Math.max(1, width - pad * 2);
  return (t: number) => pad + ((t - domain.start) / span) * usable;
}
/** x (px) → time, the inverse of `timeScale`. */
export function timeAt(domain: Domain, width: number, x: number, pad = 12) {
  const usable = Math.max(1, width - pad * 2);
  const share = Math.min(1, Math.max(0, (x - pad) / usable));
  return domain.start + share * (domain.end - domain.start);
}

/**
 * Label lanes: entries sorted by x take the first lane whose last label ends `gap` before them.
 * Returns the lane of each id (0 = first). Greedy interval packing.
 */
export function packLanes(
  entries: readonly { id: string; x: number; width: number }[],
  gap = 6,
): Map<string, number> {
  const lanes: number[] = [];
  const out = new Map<string, number>();
  for (const entry of [...entries].sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))) {
    let lane = lanes.findIndex((end) => end + gap <= entry.x);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(0);
    }
    lanes[lane] = entry.x + entry.width;
    out.set(entry.id, lane);
  }
  return out;
}

/** Places rows top to bottom and each item at its time on its row, labels in lanes. */
export function layoutChart(model: ChartModel, options: LayoutOptions): ChartLayout {
  const rowHeight = options.rowHeight ?? 28;
  const laneHeight = options.laneHeight ?? 14;
  const charWidth = options.charWidth ?? 6.5;
  const pad = options.pad ?? 12;
  const domain = timeDomain(model);
  const x = timeScale(domain, options.width, pad);
  const items = new Map<string, PlacedItem>();
  const rows: PlacedRow[] = [];
  let y = 0;
  for (const row of model.rows) {
    const own = model.items.filter((item) => item.row === row.id);
    const xs = own.map((item) => ({
      id: item.id,
      x: item.t === null ? pad : x(item.t),
      width: 12 + item.label.length * charWidth,
    }));
    const lanes = packLanes(xs);
    const laneCount = Math.max(1, ...[...lanes.values()].map((lane) => lane + 1));
    const height = Math.max(rowHeight, rowHeight / 2 + laneCount * laneHeight + 6);
    for (const entry of xs)
      items.set(entry.id, {
        id: entry.id,
        x: entry.x,
        y: y + rowHeight / 2,
        lane: lanes.get(entry.id) ?? 0,
      });
    rows.push({ id: row.id, label: row.label, y, height });
    y += height;
  }
  return { rows, items, width: options.width, height: y, domain };
}

/**
 * Everything tied to `start` through the links (both directions, the whole chain), with the
 * link kind each one was first reached by. The start items themselves are included (kind null).
 */
export function connectedSet(
  links: readonly ChartLink[],
  start: string | readonly string[],
  options: { maxDepth?: number; until?: number } = {},
): Map<string, string | null> {
  const seeds = typeof start === 'string' ? [start] : start;
  const out = new Map<string, string | null>(seeds.map((id) => [id, null]));
  const usable = links.filter(
    (link) => options.until === undefined || link.t == null || link.t <= options.until,
  );
  let frontier = [...seeds];
  for (let depth = 0; frontier.length && depth < (options.maxDepth ?? Infinity); depth++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const link of usable) {
        const other = link.from === id ? link.to : link.to === id ? link.from : undefined;
        if (other === undefined || out.has(other)) continue;
        out.set(other, link.kind);
        next.push(other);
      }
    frontier = next;
  }
  return out;
}

/** The links whose both ends are in `ids`. */
export const linksWithin = (
  links: readonly ChartLink[],
  ids: ReadonlySet<string> | Map<string, unknown>,
) => links.filter((link) => ids.has(link.from) && ids.has(link.to));

/** Milestone counts in `buckets` equal slices of the domain (the density strip). */
export function densityStrip(times: readonly number[], domain: Domain, buckets: number): number[] {
  const out = new Array<number>(Math.max(1, buckets)).fill(0);
  const span = Math.max(1, domain.end - domain.start);
  for (const t of times) {
    if (t < domain.start || t > domain.end) continue;
    const index = Math.min(out.length - 1, Math.floor(((t - domain.start) / span) * out.length));
    out[index]!++;
  }
  return out;
}

/** Month starts inside the domain (else the day starts when it spans under two months). */
export function timeTicks(domain: Domain): { t: number; label: string }[] {
  const out: { t: number; label: string }[] = [];
  const start = new Date(domain.start);
  const months = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  for (
    let at = months;
    at.getTime() <= domain.end;
    at = new Date(at.getFullYear(), at.getMonth() + 1, 1)
  )
    out.push({
      t: at.getTime(),
      label: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`,
    });
  if (out.length >= 2) return out;
  const days: { t: number; label: string }[] = [];
  const first = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  const span = domain.end - domain.start;
  const step = Math.max(1, Math.ceil(span / DAY / 10));
  for (
    let at = first;
    at.getTime() <= domain.end;
    at = new Date(at.getFullYear(), at.getMonth(), at.getDate() + step)
  )
    days.push({
      t: at.getTime(),
      label: `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`,
    });
  return days;
}

/** What the cursor shows: links and milestones at or before `cursor` are 'on', later ones 'later'. */
export function atCursor<T extends { t?: number | null }>(entries: readonly T[], cursor: number) {
  const on: T[] = [];
  const later: T[] = [];
  for (const entry of entries) (entry.t == null || entry.t <= cursor ? on : later).push(entry);
  return { on, later };
}

/** The next cursor time when playing: `steps` steps over the domain, stopping at its end. */
export function stepCursor(cursor: number, domain: Domain, steps = 60) {
  const step = (domain.end - domain.start) / Math.max(1, steps);
  return Math.min(domain.end, cursor + step);
}

/** 'MM-DD HH:mm' in local time (tooltips, the cursor's date). */
export function shortTime(t: number) {
  const at = new Date(t);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}
