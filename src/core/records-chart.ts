// 부위×시간 차트 data and layout (PLAN-53 T-327, SPEC-17.4, Design SCR-45 「구현 기준」): records,
// parts and milestones in → rows (부위 / 유형 / 장), one item per record and row, follows links,
// chains, the 알려짐 선 of existing parts, density per day and chapter, month grid, numbers and the
// index; then a layout with label lanes above and below each row's dot line (no overlaps). Pure and
// deterministic: no DOM, no clock, no random — the same input gives the same chart.
import type {
  ChartItem,
  ChartLink,
  ChartMilestone,
  ChartModel,
  ChartRow,
  PlacedItem,
  PlacedRow,
} from '../ui/chart/layout.ts';
import type {
  MilestoneRow,
  PartRow,
  RecordChain,
  RecordRow,
  RecordState,
  RecordType,
} from '../contracts/records.ts';

export type RowMode = 'part' | 'type' | 'chapter';
/** 본문 (first line), 번호와 색인 (numbers only), 주요 이야기만 (chain ends only). */
export type LabelMode = 'text' | 'number' | 'episodes';
/** 모두 같은 선 / 이야기마다 다른 점선 ('작은 차트' is not in this wave). */
export type ChainStyle = 'same' | 'dashed';

export const CHART_TYPES: Exclude<RecordType, '?'>[] = ['R', 'I', 'K', 'E', 'D'];
/** Dashes the chains take in turn (Design SCR-45: 실선 · 4 2 · 1 2 · 6 2 1 2). */
export const CHAIN_DASHES: (string | undefined)[] = [undefined, '4 2', '1 2', '6 2 1 2'];
const NO_PART = '-part';
const NO_CHAPTER = '-chapter';
const TYPE_ROW_NAME: Record<RecordType, string> = {
  R: '요구',
  I: '의도',
  K: '앎',
  E: '근거',
  D: '결정',
  '?': '미정',
};
const LABEL_CHARS = 24;
const DAY = 86_400_000;

export interface RecordsChartInput {
  records: readonly RecordRow[];
  parts: readonly PartRow[];
  milestones: readonly MilestoneRow[];
  rowMode: RowMode;
  /** States drawn (default: 남김 only). */
  states?: readonly RecordState[];
  /** Types drawn (default: all; '?' only shows when candidates are drawn). */
  types?: readonly RecordType[];
  /** 신설/기존 묶기 (part rows by group; default on). */
  groupByGrp?: boolean;
  labelMode?: LabelMode;
  chainStyle?: ChainStyle;
  /** Chains to use (default: computed from the drawn records' follows). */
  chains?: readonly RecordChain[];
  /** Date span 'YYYY-MM-DD' (default: the records' and milestones'). */
  from?: string;
  to?: string;
}

export interface RecordsChartRow extends ChartRow {
  /** Part group (신설 · 기존 …) in part mode, else null. */
  group: string | null;
  /** Part id in part mode. */
  part: string | null;
  /** 부위 역할 'from → to' (part mode). */
  role: string | null;
}
export interface RecordsChartItem extends ChartItem {
  kind: `record:${RecordType}`;
  record: string;
  /** Local day number (days since 1970-01-01 of the record's date). */
  day: number;
  /** A candidate: drawn hollow. */
  hollow: boolean;
  /** 1-based, by date and time of the drawn records (the index number). */
  number: number;
  /** The record starts a chain. */
  root: boolean;
  /** The full label text wanted (before lanes; '' = none). */
  text: string;
}
export interface RecordsChartLink extends ChartLink {
  /** 'follows' (same line) or 'follows-<n>' (n = dash of its chain). */
  kind: string;
  chain: number;
}
export interface IndexEntry {
  number: number;
  record: string;
  date: string;
  parts: string[];
  type: RecordType;
  text: string;
}
export interface KnownLine {
  row: string;
  /** Before the part was first opened (ms span), or null. */
  dashed: [number, number] | null;
  /** From the opening day on, or null when it was never opened. */
  solid: [number, number] | null;
}
export interface RecordsChartModel extends ChartModel {
  rows: RecordsChartRow[];
  items: RecordsChartItem[];
  links: RecordsChartLink[];
  milestones: ChartMilestone[];
  chains: RecordChain[];
  /** Every drawn record by number (the index table). */
  index: IndexEntry[];
  /** Counts per type before the type toggles (the switch labels). */
  typeCounts: Record<RecordType, number>;
  /** Records per day and chapter ('' = no chapter); day = local midnight ms. */
  density: { t: number; chapter: string; count: number }[];
  known: KnownLine[];
  monthGrid: { t: number; label: string }[];
  /** Local ms span: midnight of the first day to the end of the last. */
  domain: { start: number; end: number };
  /** Drawn record times (ms) for the time axis' density strip. */
  times: number[];
}

// ---- Time ----

const two = (n: number) => String(n).padStart(2, '0');
const dateParts = (date: string) => date.split('-').map(Number) as [number, number, number];
/** Local ms of a record's date and time (time null → midnight). */
function recordTime(row: Pick<RecordRow, 'date' | 'time'>): number {
  const [y, m, d] = dateParts(row.date);
  const [hh, mm] = row.time ? row.time.split(':').map(Number) : [0, 0];
  return new Date(y, m - 1, d, hh ?? 0, mm ?? 0).getTime();
}
/** Days since 1970-01-01 of a 'YYYY-MM-DD' date (time zone free). */
export function dayNumber(date: string): number {
  const [y, m, d] = dateParts(date);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}
const midnight = (date: string) => recordTime({ date, time: null });
const dateOf = (day: number) => {
  const at = new Date(day * DAY);
  return `${at.getUTCFullYear()}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}`;
};

// ---- Chains ----

const compareRows = (a: RecordRow, b: RecordRow) =>
  a.date.localeCompare(b.date) ||
  (a.time ?? '').localeCompare(b.time ?? '') ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.id.localeCompare(b.id);

/**
 * Each root (no incoming follows among `records`, at least one outgoing) with every record it
 * reaches, in list order — the same rule as `Records.chains` (src/core/records.ts).
 */
export function recordChains(records: readonly RecordRow[]): RecordChain[] {
  const rows = [...records].sort(compareRows);
  const order = new Map(rows.map((row, i) => [row.id, i]));
  const out = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const row of rows)
    for (const to of row.follows) {
      if (!order.has(to)) continue;
      const list = out.get(row.id);
      if (list) list.push(to);
      else out.set(row.id, [to]);
      incoming.add(to);
    }
  const chains: RecordChain[] = [];
  for (const row of rows) {
    if (incoming.has(row.id) || !out.has(row.id)) continue;
    const seen = new Set([row.id]);
    const stack = [row.id];
    while (stack.length)
      for (const next of out.get(stack.pop()!) ?? [])
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
    chains.push({ root: row.id, ids: [...seen].sort((a, b) => order.get(a)! - order.get(b)!) });
  }
  return chains;
}

/** Every record of the chains `record` sits in (itself alone when in none). */
export function chainMembers(chains: readonly RecordChain[], record: string): Set<string> {
  const out = new Set([record]);
  for (const chain of chains)
    if (chain.ids.includes(record)) for (const id of chain.ids) out.add(id);
  return out;
}

// ---- The model ----

/** The label text of a record: its first line, cut at 24 characters. */
export function shortText(text: string) {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > LABEL_CHARS ? `${line.slice(0, LABEL_CHARS)}…` : line;
}

const GROUP_ORDER = ['신설', '기존'];
const groupRank = (grp: string | null) => {
  if (grp === null || !grp.trim()) return GROUP_ORDER.length + 1;
  const at = GROUP_ORDER.indexOf(grp.trim());
  return at < 0 ? GROUP_ORDER.length : at;
};

export function buildRecordsChart(input: RecordsChartInput): RecordsChartModel {
  const states = new Set(input.states ?? ['kept']);
  const labelMode = input.labelMode ?? 'text';
  const groupByGrp = input.groupByGrp ?? true;
  const fromDay = input.from ? dayNumber(input.from) : -Infinity;
  const toDay = input.to ? dayNumber(input.to) : Infinity;
  const inSpan = (date: string) => {
    const day = dayNumber(date);
    return day >= fromDay && day <= toDay;
  };
  const base = [...input.records]
    .filter((row) => states.has(row.state) && !row.supersededBy && inSpan(row.date))
    .sort(compareRows);
  const typeCounts = { R: 0, I: 0, K: 0, E: 0, D: 0, '?': 0 } as Record<RecordType, number>;
  for (const row of base) typeCounts[row.type]++;
  const types = new Set(input.types ?? [...CHART_TYPES, '?']);
  const drawn = base.filter((row) => types.has(row.type));
  const drawnIds = new Set(drawn.map((row) => row.id));
  const chains = (input.chains ?? recordChains(drawn))
    .map((chain) => ({ root: chain.root, ids: chain.ids.filter((id) => drawnIds.has(id)) }))
    .filter((chain) => drawnIds.has(chain.root) && chain.ids.length > 1);
  const roots = new Set(chains.map((chain) => chain.root));
  const ends = new Set(chains.flatMap((chain) => [chain.ids[0]!, chain.ids.at(-1)!]));
  const partById = new Map(input.parts.map((part) => [part.id, part]));
  const chapterOf = (row: RecordRow) =>
    row.chapter ?? row.parts.map((id) => partById.get(id)?.chapter).find(Boolean) ?? null;

  // Rows.
  let rows: RecordsChartRow[];
  const rowIdsOf = (row: RecordRow): string[] => {
    if (input.rowMode === 'type') return [`type:${row.type}`];
    if (input.rowMode === 'chapter') {
      const chapter = chapterOf(row);
      return [chapter ? `chapter:${chapter}` : NO_CHAPTER];
    }
    const known = row.parts.filter((id) => partById.has(id));
    return known.length ? known : [NO_PART];
  };
  const used = new Set(drawn.flatMap(rowIdsOf));
  if (input.rowMode === 'type') {
    rows = [...CHART_TYPES, '?' as const]
      .filter((type) => used.has(`type:${type}`))
      .map((type) => ({
        id: `type:${type}`,
        label: TYPE_ROW_NAME[type],
        group: null,
        part: null,
        role: null,
      }));
  } else if (input.rowMode === 'chapter') {
    const names = [...used]
      .filter((id) => id !== NO_CHAPTER)
      .map((id) => id.slice('chapter:'.length))
      .sort((a, b) => a.localeCompare(b, 'ko'));
    rows = names.map((name) => ({
      id: `chapter:${name}`,
      label: name,
      group: null,
      part: null,
      role: null,
    }));
    if (used.has(NO_CHAPTER))
      rows.push({ id: NO_CHAPTER, label: '장 없음', group: null, part: null, role: null });
  } else {
    const order = new Map(input.parts.map((part, i) => [part.id, i]));
    const parts = [...input.parts].sort(
      (a, b) =>
        (groupByGrp ? groupRank(a.grp) - groupRank(b.grp) : 0) ||
        (groupByGrp ? (a.grp ?? '').localeCompare(b.grp ?? '', 'ko') : 0) ||
        order.get(a.id)! - order.get(b.id)!,
    );
    rows = parts.map((part) => ({
      id: part.id,
      label: part.name,
      group: groupByGrp ? (part.grp?.trim() ?? null) || null : null,
      part: part.id,
      role: part.roleFrom || part.roleTo ? `${part.roleFrom ?? '—'} → ${part.roleTo ?? '—'}` : null,
    }));
    if (used.has(NO_PART))
      rows.push({ id: NO_PART, label: '부위 없음', group: null, part: null, role: null });
  }

  // Items (one per record and row; the first row's item takes the record id).
  const numberOf = new Map(drawn.map((row, i) => [row.id, i + 1]));
  const items: RecordsChartItem[] = [];
  const itemsOf = new Map<string, RecordsChartItem[]>();
  for (const row of drawn) {
    const text =
      labelMode === 'number'
        ? String(numberOf.get(row.id))
        : labelMode === 'episodes' && !ends.has(row.id)
          ? ''
          : shortText(row.text);
    const own: RecordsChartItem[] = rowIdsOf(row).map((rowId, i) => ({
      id: i ? `${row.id}@${rowId}` : row.id,
      row: rowId,
      t: recordTime(row),
      kind: `record:${row.type}`,
      label: text,
      record: row.id,
      day: dayNumber(row.date),
      hollow: row.state === 'candidate',
      number: numberOf.get(row.id)!,
      root: roots.has(row.id),
      text,
    }));
    items.push(...own);
    itemsOf.set(row.id, own);
  }

  // Links: each follows between drawn records, between the items on the same row when both have
  // one there, else the first items; dashed by the first chain holding both ends.
  const chainOf = (from: string, to: string) =>
    chains.findIndex((chain) => chain.ids.includes(from) && chain.ids.includes(to));
  const links: RecordsChartLink[] = [];
  for (const row of drawn)
    for (const to of row.follows) {
      const fromItems = itemsOf.get(row.id);
      const toItems = itemsOf.get(to);
      if (!fromItems || !toItems) continue;
      const pair =
        fromItems
          .map((a) => [a, toItems.find((b) => b.row === a.row)] as const)
          .find(([, b]) => b !== undefined) ?? ([fromItems[0]!, toItems[0]!] as const);
      const chain = chainOf(row.id, to);
      links.push({
        from: pair[0].id,
        to: pair[1]!.id,
        kind:
          input.chainStyle === 'dashed'
            ? `follows-${Math.max(0, chain) % CHAIN_DASHES.length}`
            : 'follows',
        chain,
        t: null,
      });
    }

  // Domain, milestones, grid, density, known lines.
  const milestoneRows = input.milestones
    .filter((milestone) => inSpan(milestone.date))
    .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
  const days = [
    ...drawn.map((row) => dayNumber(row.date)),
    ...milestoneRows.map((milestone) => dayNumber(milestone.date)),
  ];
  const first = input.from ? fromDay : days.length ? Math.min(...days) : 0;
  const last = input.to ? toDay : days.length ? Math.max(...days) : first;
  const domain = { start: midnight(dateOf(first)), end: midnight(dateOf(last + 1)) };
  const milestones: ChartMilestone[] = milestoneRows.map((milestone) => ({
    t: midnight(milestone.date),
    kind: 'milestone',
    label: milestone.label,
    items: [],
  }));
  const monthGrid: { t: number; label: string }[] = [];
  const startAt = new Date(domain.start);
  for (
    let at = new Date(startAt.getFullYear(), startAt.getMonth(), 1);
    at.getTime() < domain.end;
    at = new Date(at.getFullYear(), at.getMonth() + 1, 1)
  )
    if (at.getTime() >= domain.start)
      monthGrid.push({ t: at.getTime(), label: `${at.getFullYear()}-${two(at.getMonth() + 1)}` });
  const densityMap = new Map<string, { t: number; chapter: string; count: number }>();
  for (const row of drawn) {
    const chapter = chapterOf(row) ?? '';
    const key = `${row.date}\u0000${chapter}`;
    const entry = densityMap.get(key) ?? { t: midnight(row.date), chapter, count: 0 };
    entry.count++;
    densityMap.set(key, entry);
  }
  const density = [...densityMap.values()].sort(
    (a, b) => a.t - b.t || a.chapter.localeCompare(b.chapter),
  );
  const known: KnownLine[] = [];
  if (input.rowMode === 'part')
    for (const row of rows) {
      const part = row.part ? partById.get(row.part) : undefined;
      if (!part || part.grp?.trim() !== '기존') continue;
      const firstK = drawn.find((record) => record.type === 'K' && record.parts.includes(part.id));
      const seenDate = part.seenAt?.slice(0, 10) ?? firstK?.date;
      const seen = seenDate
        ? Math.min(domain.end, Math.max(domain.start, midnight(seenDate)))
        : null;
      known.push({
        row: row.id,
        dashed:
          seen === null
            ? [domain.start, domain.end]
            : seen > domain.start
              ? [domain.start, seen]
              : null,
        solid: seen === null ? null : [seen, domain.end],
      });
    }

  const index: IndexEntry[] = drawn.map((row) => ({
    number: numberOf.get(row.id)!,
    record: row.id,
    date: row.date,
    parts: row.parts.map((id) => partById.get(id)?.name).filter((name): name is string => !!name),
    type: row.type,
    text: shortText(row.text),
  }));

  return {
    rows,
    items,
    links,
    milestones,
    chains,
    index,
    typeCounts,
    density,
    known,
    monthGrid,
    domain,
    times: drawn.map(recordTime),
  };
}

// ---- Layout ----

export interface RecordsLayoutOptions {
  /** Width of the time area (px). */
  width: number;
  laneHeight?: number;
  pad?: number;
  /** Label width per character: Hangul (11px font) and other characters. */
  hangulWidth?: number;
  charWidth?: number;
  /** Labels whose glyph is this close to the right edge end at the glyph (px). */
  rightEdge?: number;
}
export interface PlacedLabel {
  side: 'above' | 'below';
  lane: number;
  text: string;
  /** Left and right ends (px) and the baseline. */
  x0: number;
  x1: number;
  y: number;
  anchor: 'start' | 'end';
  /** The text did not fit; the number stands in (and the index lists it). */
  numbered: boolean;
}
export interface RecordsPlacedItem extends PlacedItem {
  label: PlacedLabel | null;
}
export interface RecordsChartLayout {
  rows: PlacedRow[];
  items: Map<string, RecordsPlacedItem>;
  width: number;
  height: number;
  domain: { start: number; end: number };
  /** x (px) of a time (ms). */
  x: (t: number) => number;
  /** Records whose label became a number (or has no room at all). */
  numbered: Set<string>;
}

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
/** Estimated width (px) of a label at 11px: Hangul ≈ 11px, the rest 6.5px. */
export function labelWidth(text: string, hangulWidth = 11, charWidth = 6.5) {
  let width = 0;
  for (const char of text) width += HANGUL.test(char) ? hangulWidth : charWidth;
  return width;
}

const SLOTS = [
  ['above', 0],
  ['below', 0],
  ['above', 1],
  ['below', 1],
] as const;
const GAP = 4;
const ROW_PAD = 4;
const GLYPH_HALF = 8;

/**
 * Rows top to bottom; each item at its time on its row's dot line; labels in the first free slot
 * of 위1 → 아래1 → 위2 → 아래2 (else the number, else none). A row grows by the lanes it uses.
 */
export function layoutRecordsChart(
  model: RecordsChartModel,
  options: RecordsLayoutOptions,
): RecordsChartLayout {
  const lane = options.laneHeight ?? 14;
  const pad = options.pad ?? 12;
  const hangul = options.hangulWidth ?? 11;
  const other = options.charWidth ?? 6.5;
  const rightEdge = options.rightEdge ?? 140;
  const span = Math.max(1, model.domain.end - model.domain.start);
  const usable = Math.max(1, options.width - pad * 2);
  const x = (t: number) => pad + ((t - model.domain.start) / span) * usable;
  const items = new Map<string, RecordsPlacedItem>();
  const rows: PlacedRow[] = [];
  const numbered = new Set<string>();
  const byRow = new Map<string, RecordsChartItem[]>();
  for (const item of model.items) {
    const list = byRow.get(item.row);
    if (list) list.push(item);
    else byRow.set(item.row, [item]);
  }
  let top = 0;
  for (const row of model.rows) {
    const own = [...(byRow.get(row.id) ?? [])].sort(
      (a, b) => (a.t ?? 0) - (b.t ?? 0) || a.number - b.number || a.id.localeCompare(b.id),
    );
    const taken: [number, number][][] = SLOTS.map(() => []);
    const placed: {
      item: RecordsChartItem;
      x: number;
      slot: number;
      label: Omit<PlacedLabel, 'y'> | null;
    }[] = [];
    const fits = (slot: number, x0: number, x1: number) =>
      taken[slot]!.every(([a, b]) => x1 + GAP <= a || b + GAP <= x0);
    for (const item of own) {
      const at = x(item.t ?? model.domain.start);
      const end = at > options.width - rightEdge;
      const spanOf = (text: string): [number, number] => {
        const width = labelWidth(text, hangul, other);
        return end ? [at + 5 - width, at + 5] : [at - 5, at - 5 + width];
      };
      let label: Omit<PlacedLabel, 'y'> | null = null;
      let slot = -1;
      const tries = item.text
        ? item.text === String(item.number)
          ? [[item.text, false] as const]
          : [[item.text, false] as const, [String(item.number), true] as const]
        : [];
      for (const [text, isNumber] of tries) {
        const [x0, x1] = spanOf(text);
        slot = SLOTS.findIndex((_, i) => fits(i, x0, x1));
        if (slot >= 0) {
          taken[slot]!.push([x0, x1]);
          label = {
            side: SLOTS[slot]![0],
            lane: SLOTS[slot]![1],
            text,
            x0,
            x1,
            anchor: end ? 'end' : 'start',
            numbered: isNumber,
          };
          if (isNumber) numbered.add(item.record);
          break;
        }
      }
      if (item.text && !label) numbered.add(item.record);
      placed.push({ item, x: at, slot, label });
    }
    const above = taken[2]!.length ? 2 : taken[0]!.length ? 1 : 0;
    const below = taken[3]!.length ? 2 : taken[1]!.length ? 1 : 0;
    const centre = top + ROW_PAD + above * lane + GLYPH_HALF;
    const height = Math.max(28, ROW_PAD + above * lane + GLYPH_HALF * 2 + below * lane + ROW_PAD);
    for (const { item, x: at, label } of placed)
      items.set(item.id, {
        id: item.id,
        x: at,
        y: centre,
        lane: label ? label.lane : 0,
        label: label
          ? {
              ...label,
              // Baselines: above lanes end 7px over the dot line, below lanes start 8px under it.
              y:
                label.side === 'above'
                  ? centre - GLYPH_HALF - 1 - label.lane * lane
                  : centre + GLYPH_HALF + 10 + label.lane * lane,
            }
          : null,
      });
    rows.push({ id: row.id, label: row.label, y: top, height });
    top += height;
  }
  return { rows, items, width: options.width, height: top, domain: model.domain, x, numbered };
}

/** Pairs of labels whose boxes (11px tall from 9px over the baseline) overlap — 0 expected. */
export function labelsOverlap(layout: RecordsChartLayout): number {
  const boxes = [...layout.items.values()]
    .flatMap((item) => (item.label ? [item.label] : []))
    .map((label) => ({ x0: label.x0, x1: label.x1, y0: label.y - 9, y1: label.y + 2 }))
    .sort((a, b) => a.x0 - b.x0);
  let count = 0;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length && boxes[j]!.x0 < boxes[i]!.x1; j++) {
      const a = boxes[i]!,
        b = boxes[j]!;
      if (a.y0 < b.y1 && b.y0 < a.y1) count++;
    }
  return count;
}
