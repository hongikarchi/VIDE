// Title blocks of a drawing → sheets (SPEC-14.15 2, PLAN-47 T-235, decision 3 as adopted
// 2026-10-08). Pure: the hidden ZWCAD's read of the root drawing and of the drawings it shows
// (hosts/zwcad/drawing-sheets.ts) and their xref placements (xref-graph.ts) come in; sheets and
// candidates go out. Sources, in this order:
//  1. inserts of the blocks on the project's title block list (model and paper space of the root,
//     model space of the drawings it shows through xrefs, by the xref insert transform);
//  2. the root's model tab plot window (a drawing plotted from the model tab by window);
//  3. paper layouts with content and a plot range, unless a listed block already makes the sheet.
// Candidates are other inserts whose outer frame has an ISO A-series ratio (with or without
// attributes); they become sheets only when the person picks them (the name joins the list).
// Sheet information comes from the attributes, or else from the text inside the frame.
// Everything is in metres (the display's coordinates); paper space boxes are in that layout's.
import {
  IDENTITY,
  multiply,
  pathKey,
  type Placement,
  type XrefEdge,
  type XrefFileRead,
  type XrefGraph,
} from './xref-graph.ts';

export type Box = [number, number, number, number];
export interface SheetLayoutRead {
  name: string;
  model: boolean;
  tab: number;
  /** `Window`, `Extents`, `Limits`, `Layout`, `Display`, `View`. */
  plotType: string;
  /** Plot window (metres; model space for the model tab, else that layout's paper space). */
  window: Box | null;
  /** Paper size in mm. */
  paper: [number, number] | null;
  media: string | null;
  styleSheet: string | null;
  limits: Box | null;
  extents: Box | null;
  /** Paper space entities other than viewports (0 for the model tab). */
  entities: number;
}
export interface SheetFrameRead {
  name: string;
  handle: string;
  space: 'model' | 'paper';
  layout: string | null;
  box: Box;
  attributes: { tag: string; value: string; invisible?: boolean }[];
}
export interface SheetsFileRead extends XrefFileRead {
  layouts: SheetLayoutRead[];
  frames: SheetFrameRead[];
}
/** One drawing read by the hidden ZWCAD; `display` is the file of its display rows. */
export interface SheetsFileResult extends SheetsFileRead {
  display: string | null;
}
export interface SheetsReadFile {
  id: number;
  path: string;
  /** The root: its paper spaces are displayed too. */
  root: boolean;
}
/** The hidden ZWCAD read (hosts/zwcad/drawing-sheets.ts); tests give a fake. */
export interface SheetsReader {
  available(): Promise<boolean>;
  read(
    files: readonly SheetsReadFile[],
    work: string,
    blocks: readonly string[],
    progress: (done: number) => void,
    signal?: AbortSignal,
  ): Promise<Map<number, SheetsFileResult>>;
}
/** A display file: model space rows and, for the root, every paper space's rows. */
export interface SheetsDisplay {
  model?: { objects?: Record<string, unknown>[]; scene?: Record<string, unknown>[] };
  paper?: Record<
    string,
    { objects?: Record<string, unknown>[]; scene?: Record<string, unknown>[] }
  >;
}
export interface SheetText {
  s: string;
  x: number;
  y: number;
  h: number;
}
export interface Sheet {
  id: string;
  source: 'list' | 'window' | 'layout';
  space: 'model' | 'paper';
  layout: string | null;
  box: Box;
  /** `A1 · 1/100`, `A3`, or `A계열 비율`/`용지 범위`. */
  paper: string;
  block: string | null;
  /** The drawing that holds the frame (the root, or a drawing shown through an xref). */
  file: string;
  xref: boolean;
  number: string | null;
  title: string | null;
  info: 'attributes' | 'text' | null;
  attributes: { tag: string; value: string }[];
  /** The plot style table the drawing names for this sheet (shown, not used: SPEC-14.15 3). */
  styleSheet: string | null;
  /** The model tab plot window is this frame. */
  plotWindow: boolean;
  /** Missing xrefs inserted inside the sheet. */
  missingXrefs: string[];
}
export interface SheetCandidate {
  block: string;
  count: number;
  attributed: boolean;
  xref: boolean;
  paper: string;
  /** One of its frames is the model tab plot window. */
  plotted: boolean;
  boxes: { space: 'model' | 'paper'; layout: string | null; box: Box }[];
}
export interface SheetsInput {
  root: string;
  files: ReadonlyMap<string, SheetsFileRead>;
  placements: readonly Placement[];
  /** The project's title block list (case-insensitive names). */
  blocks: readonly string[];
  texts?: { model: readonly SheetText[]; paper: Readonly<Record<string, readonly SheetText[]>> };
  /** Missing xrefs (name and insert point in the root's metres). */
  missing?: readonly { name: string; point: [number, number] }[];
}

const SQRT2 = Math.SQRT2;
/** Long/short within 3 % of √2 (the spike's test) and at least 0.2 m long (A4 is 0.297 m). */
export function isoRatio(box: Box) {
  const w = box[2] - box[0],
    h = box[3] - box[1];
  const long = Math.max(w, h),
    short = Math.min(w, h);
  if (!(short > 0) || long < 0.2) return false;
  return Math.abs(long / short - SQRT2) / SQRT2 < 0.03;
}
const A_SIZES: [string, number][] = [
  ['A0', 1189],
  ['A1', 841],
  ['A2', 594],
  ['A3', 420],
  ['A4', 297],
];
/** Most usual first: A sizes double, so 42 m is A3 at 1/100 before A1 at 1/50. */
const SCALES = [
  1, 100, 50, 200, 300, 500, 150, 250, 600, 1000, 1200, 1500, 2000, 2500, 3000, 5000, 400, 120, 60,
  30, 25, 20, 10, 5, 2,
];
/** The A size and scale a frame box matches (long side within 2 %), e.g. `A1 · 1/100`. */
export function paperOf(box: Box) {
  const long = Math.max(box[2] - box[0], box[3] - box[1]) * 1000;
  for (const scale of SCALES)
    for (const [name, size] of A_SIZES)
      if (Math.abs(long / scale - size) / size < 0.02)
        return scale === 1 ? name : `${name} · 1/${scale}`;
  return 'A계열 비율';
}

/** Row-major 4x4 applied to (x, y, 0). */
export function transformPoint(
  m: readonly number[] | null,
  x: number,
  y: number,
): [number, number] {
  if (!m) return [x, y];
  return [m[0] * x + m[1] * y + m[3], m[4] * x + m[5] * y + m[7]];
}
export function transformBox(m: readonly number[] | null, box: Box): Box {
  if (!m) return box;
  const corners = [
    transformPoint(m, box[0], box[1]),
    transformPoint(m, box[2], box[1]),
    transformPoint(m, box[2], box[3]),
    transformPoint(m, box[0], box[3]),
  ];
  return [
    Math.min(...corners.map((c) => c[0])),
    Math.min(...corners.map((c) => c[1])),
    Math.max(...corners.map((c) => c[0])),
    Math.max(...corners.map((c) => c[1])),
  ];
}
const inside = (box: Box, x: number, y: number) =>
  x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
const area = (box: Box) => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
/** Intersection over union of two boxes. */
export function overlap(a: Box, b: Box) {
  const common: Box = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  const shared = common[2] > common[0] && common[3] > common[1] ? area(common) : 0;
  const union = area(a) + area(b) - shared;
  return union > 0 ? shared / union : 0;
}
const validBox = (box: unknown): box is Box =>
  Array.isArray(box) &&
  box.length === 4 &&
  box.every((v) => Number.isFinite(v)) &&
  box[2] > box[0] &&
  box[3] > box[1];

/** MText formatting codes removed (`\P`, `\fArial|b0;`, braces, `%%c`). */
export function plainText(value: string) {
  return value
    .replace(/\\[PpNn~]/g, ' ')
    .replace(/\\[A-Za-z][^;\\{}]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/%%[cdpuo]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const NUMBER = /^[A-Z]{1,4}[-_. ]?\d{1,4}(?:[-_.]\d{1,3})?[A-Z]?$/i;
const LABEL_NUMBER = /^(?:도면\s*번호|도\s*번|DWG\.?\s*NO\.?|DRAWING\s*NO\.?|SHEET\s*NO\.?)\s*:?$/i;
const LABEL_TITLE =
  /^(?:도면\s*명|도\s*명|도면\s*이름|DWG\.?\s*TITLE|DRAWING\s*TITLE|SHEET\s*TITLE|TITLE)\s*:?$/i;
const LABEL_OTHER =
  /^(?:축\s*척|SCALE|날\s*짜|DATE|공\s*사\s*명|PROJECT|설\s*계|DESIGNED|DRAWN|CHECKED|APPROVED|검\s*토|승\s*인|작\s*성|비\s*고|NOTE|REMARKS?)\s*(?:BY)?\s*:?$/i;
const isLabel = (s: string) => LABEL_NUMBER.test(s) || LABEL_TITLE.test(s) || LABEL_OTHER.test(s);

/** The text next to a label: to its right on the same line, or else just below it. */
function nextTo(label: SheetText, texts: readonly SheetText[], accept: (s: string) => boolean) {
  let best: SheetText | undefined,
    score = Infinity;
  const reach = Math.max(label.h, 1e-6) * 40;
  for (const text of texts) {
    if (text === label || !accept(text.s)) continue;
    const dx = text.x - label.x,
      dy = text.y - label.y;
    const right = dx > 0 && Math.abs(dy) < label.h * 2.5;
    const below = dy < 0 && Math.abs(dx) < reach / 2 && -dy < label.h * 6;
    if (!right && !below) continue;
    const d = Math.hypot(dx, dy) + (below ? reach / 4 : 0);
    if (d < reach && d < score) {
      best = text;
      score = d;
    }
  }
  return best;
}
/** Sheet number and title from the text inside a frame (no attributes). */
export function infoFromText(box: Box, texts: readonly SheetText[]) {
  const within = texts
    .filter((t) => inside(box, t.x, t.y))
    .map((t) => ({ ...t, s: plainText(t.s) }))
    .filter((t) => t.s && t.s.length <= 60);
  if (!within.length) return { number: null, title: null };
  const numberLabel = within.find((t) => LABEL_NUMBER.test(t.s));
  const titleLabel = within.find((t) => LABEL_TITLE.test(t.s));
  let number =
    (numberLabel && nextTo(numberLabel, within, (s) => NUMBER.test(s))?.s) ??
    within
      .filter((t) => NUMBER.test(t.s))
      .sort((a, b) => b.h - a.h || b.x - a.x)
      .at(0)?.s ??
    null;
  const titleOk = (s: string) => !isLabel(s) && !NUMBER.test(s) && /[가-힣A-Za-z]/.test(s);
  let title = (titleLabel && nextTo(titleLabel, within, titleOk)?.s) ?? null;
  if (!title) {
    // The title block: the right 35 % or the bottom 25 % of the frame; its largest text.
    const w = box[2] - box[0],
      h = box[3] - box[1];
    title =
      within
        .filter((t) => (t.x >= box[2] - w * 0.35 || t.y <= box[1] + h * 0.25) && titleOk(t.s))
        .filter((t) => t.s !== number)
        .sort((a, b) => b.h - a.h)
        .at(0)?.s ?? null;
  }
  if (number) number = number.replace(/\s+/g, '');
  return { number, title };
}
/** Sheet number and title from attribute tags. */
export function infoFromAttributes(attributes: readonly { tag: string; value: string }[]) {
  const value = (pattern: RegExp, not?: RegExp) =>
    attributes
      .find((a) => pattern.test(a.tag) && !not?.test(a.tag) && a.value.trim())
      ?.value.trim() ?? null;
  const number =
    value(/도면\s*번호|DWG_?NO|DRAWING_?NO|SHEET_?NO|SHEET_?NUM/i) ??
    value(/번호|NO$|NUM/i, /공사|PROJECT|프로젝트|REV/i);
  const title =
    value(/도면\s*명|DWG_?TITLE|DRAWING_?TITLE|SHEET_?TITLE|^TITLE$/i) ??
    value(/명|TITLE|NAME/i, /공사|PROJECT|프로젝트|회사|COMPANY|설계자|DESIGNER/i);
  return { number: number ? plainText(number) : null, title: title ? plainText(title) : null };
}

const scaling = (s: number) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
/**
 * Every model space appearance of the drawings a root shows, with its placement (row-major, the
 * drawing's metres → the root's). Unlike `placementsOf` (one placement per drawing, for linked
 * files) a sheet xref inserted at several places gives each of its frames once per insert. As in
 * CAD an overlay shows only from the root, inserts in paper space or inside blocks place nothing,
 * and a cycle stops; at most `limit` appearances.
 */
export function instancesOf(graph: XrefGraph, root: string, limit = 2000): Placement[] {
  const byKey = new Map(graph.nodes.map((node) => [pathKey(node.path), node]));
  const outgoing = new Map<string, XrefEdge[]>();
  for (const edge of graph.edges) {
    const key = pathKey(edge.parent);
    outgoing.set(key, [...(outgoing.get(key) ?? []), edge]);
  }
  const rootNode = byKey.get(pathKey(root));
  if (!rootNode) return [];
  const out: Placement[] = [
    {
      path: rootNode.path,
      name: rootNode.name,
      matrix: null,
      depth: 0,
      parent: null,
      handle: null,
    },
  ];
  const visit = (path: string, matrix: number[], depth: number, stack: Set<string>) => {
    const parentScale = byKey.get(pathKey(path))?.scale ?? 0.001;
    for (const edge of outgoing.get(pathKey(path)) ?? []) {
      if (!edge.child || edge.cycle || (edge.overlay && depth > 0)) continue;
      const key = pathKey(edge.child);
      if (stack.has(key)) continue;
      const child = byKey.get(key);
      if (!child) continue;
      const childScale = child.scale ?? parentScale;
      for (const insert of edge.inserts) {
        if (insert.space !== 'model' || insert.nested || insert.transform.length !== 16) continue;
        if (out.length >= limit) return;
        const placed = multiply(
          matrix,
          multiply(scaling(parentScale), multiply(insert.transform, scaling(1 / childScale))),
        );
        out.push({
          path: child.path,
          name: child.name,
          matrix: placed,
          depth: depth + 1,
          parent: path,
          handle: insert.handle,
        });
        visit(child.path, placed, depth + 1, new Set([...stack, key]));
      }
    }
  };
  visit(rootNode.path, IDENTITY, 0, new Set([pathKey(root)]));
  return out;
}

const naturalKey = (s: string) => s.replace(/\d+/g, (d) => d.padStart(6, '0')).toUpperCase();

/** Sheets and candidates of one root drawing (SPEC-14.15 2). */
export function findSheets(input: SheetsInput): {
  sheets: Sheet[];
  candidates: SheetCandidate[];
} {
  const listed = new Set(input.blocks.map((name) => name.trim().toUpperCase()).filter(Boolean));
  const root = input.files.get(input.root);
  const placements = input.placements.length
    ? input.placements
    : [{ path: input.root, name: '', matrix: null, depth: 0, parent: null, handle: null }];
  const texts = input.texts ?? { model: [], paper: {} };
  const missing = input.missing ?? [];
  const sheets: Sheet[] = [];
  const candidates = new Map<string, SheetCandidate>();
  const missingIn = (sheet: Pick<Sheet, 'space' | 'box'>) =>
    sheet.space === 'model'
      ? [
          ...new Set(
            missing.filter((m) => inside(sheet.box, m.point[0], m.point[1])).map((m) => m.name),
          ),
        ]
      : [];
  const textsOf = (space: 'model' | 'paper', layout: string | null) =>
    space === 'model' ? texts.model : (texts.paper[layout ?? ''] ?? []);
  const withInfo = (sheet: Omit<Sheet, 'number' | 'title' | 'info' | 'missingXrefs'>): Sheet => {
    let info: Sheet['info'] = null;
    let found: { number: string | null; title: string | null } = { number: null, title: null };
    if (sheet.attributes.length) {
      found = infoFromAttributes(sheet.attributes);
      if (found.number || found.title) info = 'attributes';
    }
    if (!info) {
      found = infoFromText(sheet.box, textsOf(sheet.space, sheet.layout));
      if (found.number || found.title) info = 'text';
    }
    return { ...sheet, ...found, info, missingXrefs: missingIn(sheet) };
  };
  const styleOf = (layout: string | null, space: 'model' | 'paper') =>
    root?.layouts.find((l) => (space === 'model' ? l.model : l.name === layout))?.styleSheet ??
    null;

  // 1. Listed blocks (and candidates) in the root and in the drawings it shows.
  placements.forEach((placement, index) => {
    const file = input.files.get(placement.path);
    if (!file || file.error) return;
    for (const frame of file.frames) {
      // A drawing shown through an xref adds only its model space.
      if (index > 0 && frame.space !== 'model') continue;
      if (!validBox(frame.box)) continue;
      const box = frame.space === 'model' ? transformBox(placement.matrix, frame.box) : frame.box;
      const name = frame.name.trim();
      if (listed.has(name.toUpperCase())) {
        sheets.push(
          withInfo({
            id: `f${index}:${frame.handle}`,
            source: 'list',
            space: frame.space,
            layout: frame.space === 'paper' ? frame.layout : null,
            box,
            paper: paperOf(box),
            block: name,
            file: placement.path,
            xref: index > 0,
            attributes: frame.attributes
              .filter((a) => !a.invisible || a.value)
              .map(({ tag, value }) => ({ tag, value })),
            styleSheet: styleOf(frame.layout, frame.space),
            plotWindow: false,
          }),
        );
      } else if (isoRatio(box)) {
        const key = name.toUpperCase();
        const entry = candidates.get(key) ?? {
          block: name,
          count: 0,
          attributed: false,
          xref: false,
          paper: paperOf(box),
          plotted: false,
          boxes: [],
        };
        entry.count++;
        entry.attributed ||= frame.attributes.length > 0;
        entry.xref ||= index > 0;
        if (entry.boxes.length < 50)
          entry.boxes.push({
            space: frame.space,
            layout: frame.space === 'paper' ? frame.layout : null,
            box,
          });
        candidates.set(key, entry);
      }
    }
  });

  // 2. The root's model tab plot window.
  const model = root?.layouts.find((layout) => layout.model);
  if (model && /window/i.test(model.plotType) && validBox(model.window)) {
    const same = sheets.find((s) => s.space === 'model' && overlap(s.box, model.window!) > 0.8);
    if (same) same.plotWindow = true;
    else
      sheets.push(
        withInfo({
          id: 'w:model',
          source: 'window',
          space: 'model',
          layout: null,
          box: model.window,
          paper: isoRatio(model.window) ? paperOf(model.window) : '창 범위',
          block: null,
          file: input.root,
          xref: false,
          attributes: [],
          styleSheet: model.styleSheet,
          plotWindow: true,
        }),
      );
  }

  // 3. Paper layouts with content and a plot range, unless a listed block makes the sheet there.
  for (const layout of [...(root?.layouts ?? [])].sort((a, b) => a.tab - b.tab)) {
    if (layout.model || layout.entities < 1) continue;
    if (sheets.some((s) => s.space === 'paper' && s.layout === layout.name)) continue;
    const range = /window/i.test(layout.plotType)
      ? layout.window
      : /extents/i.test(layout.plotType)
        ? layout.extents
        : (layout.limits ?? layout.extents);
    if (!validBox(range)) continue;
    sheets.push(
      withInfo({
        id: `l:${layout.name}`,
        source: 'layout',
        space: 'paper',
        layout: layout.name,
        box: range,
        paper: isoRatio(range) ? paperOf(range) : '용지 범위',
        block: null,
        file: input.root,
        xref: false,
        attributes: [],
        styleSheet: layout.styleSheet,
        plotWindow: /window/i.test(layout.plotType),
      }),
    );
  }

  // Order: by sheet number when every sheet has one; else model sheets top-to-bottom,
  // left-to-right, then layouts in tab order (already appended in that order).
  const tab = (s: Sheet) => root?.layouts.find((l) => l.name === s.layout)?.tab ?? 0;
  if (sheets.length && sheets.every((s) => s.number))
    sheets.sort((a, b) => naturalKey(a.number!).localeCompare(naturalKey(b.number!)));
  else {
    const rowHeight = Math.max(
      1e-6,
      Math.min(...sheets.filter((s) => s.space === 'model').map((s) => s.box[3] - s.box[1])) / 2,
    );
    sheets.sort((a, b) =>
      a.space !== b.space
        ? a.space === 'model'
          ? -1
          : 1
        : a.space === 'paper'
          ? tab(a) - tab(b)
          : Math.round(b.box[3] / rowHeight) - Math.round(a.box[3] / rowHeight) ||
            a.box[0] - b.box[0],
    );
  }
  // Candidates the person most likely wants first: the frame the model tab plots, then frames
  // of an A size at a usual scale, then the rest (A ratio only: often symbols, kept last).
  const windowBox = model && validBox(model.window) ? model.window : null;
  for (const candidate of candidates.values())
    candidate.plotted =
      !!windowBox &&
      candidate.boxes.some((b) => b.space === 'model' && overlap(b.box, windowBox) > 0.8);
  const rank = (c: SheetCandidate) => (c.plotted ? 0 : c.paper !== 'A계열 비율' ? 1 : 2);
  return {
    sheets,
    candidates: [...candidates.values()].sort(
      (a, b) => rank(a) - rank(b) || b.count - a.count || a.block.localeCompare(b.block),
    ),
  };
}

/** Display rows of one drawing that touch a box (in the root's metres) under a placement. */
export function rowBox(row: {
  segments?: number[];
  fills?: { loops: number[][] }[];
  texts?: { p: number[] }[];
}): Box | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  const segments = row.segments ?? [];
  for (let i = 0; i + 1 < segments.length; i += 3) add(segments[i], segments[i + 1]);
  for (const fill of row.fills ?? [])
    for (const loop of fill.loops ?? [])
      for (let i = 0; i + 1 < loop.length; i += 3) add(loop[i], loop[i + 1]);
  for (const text of row.texts ?? []) if (text.p) add(text.p[0], text.p[1]);
  return minX <= maxX ? [minX, minY, maxX, maxY] : null;
}
export function touches(a: Box, b: Box) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;
/**
 * One display row cut to a sheet (the root's metres; `matrix` places the row there): segments,
 * fills and texts that touch the box stay, the style runs follow the kept segments, coordinates are
 * rounded to 0.01 mm. Null when nothing of it is in the sheet. The viewport still clips exactly.
 */
export function clipRow(
  row: Record<string, unknown>,
  matrix: readonly number[] | null,
  box: Box,
): Record<string, unknown> | null {
  const segments = (row.segments as number[] | undefined) ?? [];
  const runs = (row.segmentStyles as { n: number }[] | undefined) ?? [];
  const keptSegments: number[] = [];
  const keptRuns: { n: number }[] = [];
  // Segments past the declared runs keep the last style (as cad-annotations.ts runStyles).
  let run = 0,
    used = 0,
    lastKept = -1;
  for (let i = 0; i + 5 < segments.length; i += 6) {
    while (run < runs.length - 1 && used >= runs[run].n) {
      run++;
      used = 0;
    }
    used++;
    const [ax, ay] = transformPoint(matrix, segments[i], segments[i + 1]);
    const [bx, by] = transformPoint(matrix, segments[i + 3], segments[i + 4]);
    const own: Box = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
    if (!touches(own, box)) continue;
    for (let k = 0; k < 6; k++) keptSegments.push(round(segments[i + k]));
    if (!runs.length) continue;
    if (lastKept === run) keptRuns[keptRuns.length - 1].n++;
    else keptRuns.push({ ...runs[run], n: 1 });
    lastKept = run;
  }
  const fills = ((row.fills as { loops: number[][] }[] | undefined) ?? []).filter((fill) => {
    const own = rowBox({ fills: [fill] });
    return own && touches(transformBox(matrix, own), box);
  });
  const margin = Math.max(box[2] - box[0], box[3] - box[1]) * 0.02;
  const texts = ((row.texts as { p: number[] }[] | undefined) ?? []).filter((text) => {
    const [x, y] = transformPoint(matrix, text.p[0], text.p[1]);
    return (
      x >= box[0] - margin && x <= box[2] + margin && y >= box[1] - margin && y <= box[3] + margin
    );
  });
  if (!keptSegments.length && !fills.length && !texts.length) return null;
  const out: Record<string, unknown> = { ...row, segments: keptSegments };
  if (runs.length) out.segmentStyles = keptRuns;
  if (row.fills) out.fills = fills.map((f) => ({ ...f, loops: f.loops.map((l) => l.map(round)) }));
  if (row.texts) out.texts = texts.map((t) => ({ ...t, p: t.p.map(round) }));
  return out;
}
