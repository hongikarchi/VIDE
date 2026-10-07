// 도곽 미리보기 (SPEC-14.15, PLAN-47 T-235, Design SCR-30): the sheets of one project drawing and a
// white-paper preview of each with the project's plot style table. The drawing and the drawings it
// shows through xrefs (the 도면 관계 read, xref-store.ts) are copied into a work folder and read by
// one hidden ZWCAD (hosts/zwcad/drawing-sheets.ts); originals are never opened and no file is
// written for the person (no plot, no PDF). One job per project; the last result stays in memory
// with its work folder (the display files the preview reads) until the next read.
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join, win32 } from 'node:path';
import { DomainError } from '../core/store.ts';
import { buildXrefGraph, pathKey, placementsOf, type Placement } from '../core/xref-graph.ts';
import type { XrefStore } from '../core/xref-store.ts';
import type { DrawingSheetsStore, DrawingSheetSettings } from '../core/drawing-sheets-store.ts';
import {
  clipRow,
  findSheets,
  instancesOf,
  rowBox,
  touches,
  transformBox,
  transformPoint,
  type Box,
  type Sheet,
  type SheetCandidate,
  type SheetText,
  type SheetsDisplay,
  type SheetsFileRead,
  type SheetsReader,
} from '../core/drawing-sheets.ts';
import { readCtb, type CtbTable } from '../core/ctb.ts';

/** .ctb files listed at most, and how deep the project folders are walked for them. */
const MAX_CTB = 200;
const CTB_DEPTH = 4;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.vide', '$recycle.bin']);

export interface CtbChoice {
  path: string;
  name: string;
  where: 'project' | 'cad';
}
export interface PlotStyleState {
  /** `project`: the registered file; `drawing`: the table the drawing names, found in a folder. */
  source: 'project' | 'drawing' | 'builtin';
  name: string;
  path: string | null;
  /** Why the built-in table is used: NO_CTB, CTB_MISSING, CTB_HEADER, CTB_CORRUPT, STB_UNSUPPORTED… */
  notice: string | null;
}
interface Result {
  root: string;
  readAt: string;
  work: string;
  files: {
    path: string;
    name: string;
    xref: boolean;
    error: string | null;
    display: string | null;
  }[];
  placements: Placement[];
  reads: Map<string, SheetsFileRead>;
  texts: { model: SheetText[]; paper: Record<string, SheetText[]> };
  missing: { name: string; point: [number, number] }[];
  styleNames: string[];
  sheets: Sheet[];
  candidates: SheetCandidate[];
}
export interface DrawingSheetsState {
  state: 'idle' | 'reading' | 'done' | 'failed';
  done: number;
  total: number;
  error: string | null;
  drawings: { path: string; name: string }[];
  settings: DrawingSheetSettings;
  ctbChoices: CtbChoice[];
  plotStyle: PlotStyleState;
  result: {
    root: string;
    name: string;
    readAt: string;
    files: { name: string; xref: boolean; error: string | null }[];
    sheets: Sheet[];
    candidates: SheetCandidate[];
    missingXrefs: string[];
    /** Plot style table names the drawing uses (shown; the registered table is used). */
    styleNames: string[];
  } | null;
}
export interface DrawingSheetsOptions {
  xref: XrefStore;
  store: DrawingSheetsStore;
  reader: SheetsReader | undefined;
  folders: (projectId: string) => string[];
  denied: (path: string) => boolean;
  workRoot: string;
  /** CAD support folders searched for .ctb files (ZWCAD 2023 Printstyle folders by default). */
  supportFolders?: () => Promise<string[]>;
}

/** ZWCAD 2023's plot style folders: the user's per-locale one and the installed one. */
export async function zwcadPrintStyleFolders(
  appData = process.env.APPDATA,
  programFiles = process.env.ProgramFiles || 'C:\\Program Files',
) {
  const out: string[] = [];
  if (appData) {
    const root = join(appData, 'ZWSOFT', 'ZWCAD', '2023');
    try {
      for (const locale of await readdir(root)) out.push(join(root, locale, 'Printstyle'));
    } catch {
      /* No ZWCAD user folder. */
    }
  }
  out.push(join(programFiles, 'ZWSOFT', 'ZWCAD 2023', 'UserDataCache', 'Printstyle'));
  return out.filter((folder) => existsSync(folder));
}

async function listCtb(folders: readonly string[], depth: number, denied: (p: string) => boolean) {
  const out: string[] = [];
  const walk = async (folder: string, level: number) => {
    if (out.length >= MAX_CTB || denied(folder)) return;
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (level < depth && !SKIP_DIRS.has(entry.name.toLowerCase())) await walk(path, level + 1);
      } else if (
        entry.isFile() &&
        /\.ctb$/i.test(entry.name) &&
        !denied(path) &&
        out.length < MAX_CTB
      )
        out.push(path);
    }
  };
  for (const folder of folders) await walk(folder, 0);
  return [...new Map(out.map((path) => [pathKey(path), path])).values()];
}

interface Indexed {
  scene: Record<string, unknown>[];
  objects: Record<string, unknown>[];
  boxes: (Box | null)[];
  union: Box | null;
}
interface Parsed {
  model: Indexed;
  paper: Record<string, Indexed>;
}
function indexed(part: SheetsDisplay['model']): Indexed {
  const scene = part?.scene ?? [];
  const boxes = scene.map((row) => rowBox(row as Parameters<typeof rowBox>[0]));
  let union: Box | null = null;
  for (const box of boxes)
    if (box)
      union = union
        ? [
            Math.min(union[0], box[0]),
            Math.min(union[1], box[1]),
            Math.max(union[2], box[2]),
            Math.max(union[3], box[3]),
          ]
        : [...box];
  return { scene, objects: part?.objects ?? [], boxes, union };
}
const displayCache = new WeakMap<Result, Map<string, Promise<Parsed>>>();

export class DrawingSheetsService {
  private readonly options: DrawingSheetsOptions;
  private readonly jobs = new Map<string, { done: number; total: number }>();
  private readonly last = new Map<string, { error: string | null; result: Result | null }>();
  constructor(options: DrawingSheetsOptions) {
    this.options = options;
  }

  private graph(projectId: string, fresh?: ReadonlyMap<string, SheetsFileRead>) {
    const reads = new Map(this.options.xref.files(projectId).map((row) => [row.path, row.read]));
    for (const [path, read] of fresh ?? []) if (!read.error) reads.set(path, read);
    return buildXrefGraph(reads, (path) => existsSync(path));
  }
  /** Drawings of the project folders that 도면 관계 read. */
  drawings(projectId: string) {
    return this.options.xref
      .files(projectId)
      .filter((row) => row.inFolders && !row.read.error)
      .map((row) => ({ path: row.path, name: win32.basename(row.path) }));
  }
  async ctbChoices(projectId: string): Promise<CtbChoice[]> {
    const project = await listCtb(this.options.folders(projectId), CTB_DEPTH, this.options.denied);
    const cad = await listCtb(
      await (this.options.supportFolders ?? (() => zwcadPrintStyleFolders()))(),
      0,
      () => false,
    );
    const seen = new Set<string>();
    const out: CtbChoice[] = [];
    for (const [paths, where] of [
      [project, 'project'],
      [cad, 'cad'],
    ] as const)
      for (const path of paths)
        if (!seen.has(pathKey(path))) {
          seen.add(pathKey(path));
          out.push({ path, name: win32.basename(path), where });
        }
    return out;
  }

  /**
   * The table to plot with (SPEC-14.15 3, decision 4 as adopted 2026-10-08): the registered .ctb;
   * else the table the drawing names when a file of that name is in the project or CAD folders;
   * else the built-in monochrome with the reason. Named tables (.stb) are not supported.
   */
  async plotStyle(projectId: string): Promise<{ state: PlotStyleState; table: CtbTable | null }> {
    const { ctb } = this.options.store.settings(projectId);
    const builtin = (notice: string) => ({
      state: { source: 'builtin' as const, name: 'monochrome.ctb', path: null, notice },
      table: null,
    });
    const load = async (path: string, source: 'project' | 'drawing') => {
      try {
        const { table } = readCtb(await readFile(path), win32.basename(path));
        return { state: { source, name: table.name, path, notice: null }, table };
      } catch (cause) {
        return builtin((cause as { code?: string }).code ?? 'CTB_MISSING');
      }
    };
    if (ctb) return existsSync(ctb) ? load(ctb, 'project') : builtin('CTB_MISSING');
    const names = this.last.get(projectId)?.result?.styleNames ?? [];
    if (names.some((name) => /\.stb$/i.test(name))) return builtin('STB_UNSUPPORTED');
    const choices = await this.ctbChoices(projectId);
    for (const name of names) {
      const found = choices.find((c) => c.name.toLowerCase() === basename(name).toLowerCase());
      if (found) return load(found.path, 'drawing');
    }
    return builtin('NO_CTB');
  }

  async status(projectId: string): Promise<DrawingSheetsState> {
    const job = this.jobs.get(projectId);
    const last = this.last.get(projectId);
    const result = last?.result ?? null;
    return {
      state: job ? 'reading' : last ? (last.error ? 'failed' : 'done') : 'idle',
      done: job?.done ?? 0,
      total: job?.total ?? 0,
      error: job ? null : (last?.error ?? null),
      drawings: this.drawings(projectId),
      settings: this.options.store.settings(projectId),
      ctbChoices: await this.ctbChoices(projectId),
      plotStyle: (await this.plotStyle(projectId)).state,
      result: result && {
        root: result.root,
        name: win32.basename(result.root),
        readAt: result.readAt,
        files: result.files.map(({ name, xref, error }) => ({ name, xref, error })),
        sheets: result.sheets,
        candidates: result.candidates,
        missingXrefs: [...new Set(result.missing.map((m) => m.name))],
        styleNames: result.styleNames,
      },
    };
  }

  /** [도곽 찾기]: copy the drawing and the drawings it shows, read them, find the sheets. */
  async read(projectId: string, root: string, wait = false) {
    const reader = this.options.reader;
    if (!reader || !(await reader.available())) throw new DomainError('NO_ZWCAD');
    const known = this.drawings(projectId).find((d) => pathKey(d.path) === pathKey(root));
    if (!known) throw new DomainError('NOT_FOUND');
    if (this.jobs.has(projectId)) throw new DomainError('PROJECT_BUSY');
    const placements = placementsOf(this.graph(projectId), known.path);
    if (!placements.length) throw new DomainError('NOT_FOUND');
    const job = { done: 0, total: placements.length };
    this.jobs.set(projectId, job);
    const work = join(this.options.workRoot, randomBytes(4).toString('hex'));
    const running = (async () => {
      try {
        await mkdir(work, { recursive: true });
        const copies: { id: number; path: string; root: boolean }[] = [];
        const copyFailed = new Map<number, string>();
        for (const [index, placement] of placements.entries())
          if (this.options.denied(placement.path)) copyFailed.set(index + 1, 'DENIED');
          else
            try {
              const copy = join(work, `d${index + 1}.dwg`);
              await copyFile(placement.path, copy);
              copies.push({ id: index + 1, path: copy, root: index === 0 });
            } catch {
              copyFailed.set(index + 1, 'COPY_FAILED');
            }
        const settings = this.options.store.settings(projectId);
        const results = await reader.read(
          copies,
          work,
          settings.blocks,
          (done) => (job.done = done),
        );
        const reads = new Map<string, SheetsFileRead>();
        const files: Result['files'] = placements.map((placement, index) => {
          const read = results.get(index + 1);
          const error = copyFailed.get(index + 1) ?? read?.error ?? (read ? null : 'NOT_READ');
          if (read && !read.error) reads.set(placement.path, read);
          return {
            path: placement.path,
            name: placement.name || win32.basename(placement.path),
            xref: index > 0,
            error,
            display: read?.display ?? null,
          };
        });
        if (!reads.has(placements[0].path)) throw new DomainError(files[0].error ?? 'NOT_READ');
        // The fresh reads decide the placements (the drawing may have changed since 도면 관계).
        const graph = this.graph(projectId, reads);
        // Every insert of a sheet xref counts (its frame appears once per insert).
        const fresh = instancesOf(graph, placements[0].path).filter((p) => reads.has(p.path));
        const result: Result = {
          root: placements[0].path,
          readAt: new Date().toISOString(),
          work,
          files,
          placements: fresh,
          reads,
          texts: { model: [], paper: {} },
          missing: [],
          styleNames: [],
          sheets: [],
          candidates: [],
        };
        await this.collectTexts(result);
        const byKey = new Map(graph.nodes.map((node) => [pathKey(node.path), node]));
        for (const placement of fresh)
          for (const edge of graph.edges)
            if (pathKey(edge.parent) === pathKey(placement.path) && edge.missing) {
              const scale = byKey.get(pathKey(placement.path))?.scale ?? 0.001;
              for (const insert of edge.inserts)
                if (insert.space === 'model' && !insert.nested)
                  result.missing.push({
                    name: edge.name,
                    point: transformPoint(
                      placement.matrix,
                      (insert.position[0] ?? 0) * scale,
                      (insert.position[1] ?? 0) * scale,
                    ),
                  });
            }
        result.styleNames = [
          ...new Set(
            (reads.get(result.root)?.layouts ?? [])
              .map((layout) => layout.styleSheet)
              .filter((name): name is string => !!name),
          ),
        ];
        this.compute(projectId, result);
        const previous = this.last.get(projectId)?.result;
        this.last.set(projectId, { error: null, result });
        if (previous) await rm(previous.work, { recursive: true, force: true }).catch(() => {});
      } catch (cause) {
        await rm(work, { recursive: true, force: true }).catch(() => {});
        const previous = this.last.get(projectId)?.result ?? null;
        this.last.set(projectId, {
          error: (cause as { code?: string }).code ?? (cause as Error).message,
          result: previous,
        });
      } finally {
        this.jobs.delete(projectId);
      }
    })();
    if (wait) await running;
    return this.status(projectId);
  }

  /** A display file, parsed once per result with each row's box and the union of them. */
  private display(result: Result, path: string): Promise<Parsed> {
    let cache = displayCache.get(result);
    if (!cache) displayCache.set(result, (cache = new Map()));
    let loading = cache.get(path);
    if (!loading) {
      loading = readFile(path, 'utf8')
        .then((text) => JSON.parse(text) as SheetsDisplay)
        .catch(() => ({}) as SheetsDisplay)
        .then((display) => ({
          model: indexed(display.model),
          paper: Object.fromEntries(
            Object.entries(display.paper ?? {}).map(([name, part]) => [name, indexed(part)]),
          ),
        }));
      // A bounded cache: a big project keeps the drawings of recent previews parsed.
      if (cache.size >= 24) cache.delete(cache.keys().next().value!);
      cache.set(path, loading);
    }
    return loading;
  }
  /** The texts of every display row (for sheet numbers and titles), in the root's metres. */
  private async collectTexts(result: Result) {
    const rows = (scene: Record<string, unknown>[] | undefined, matrix: number[] | null) => {
      const out: SheetText[] = [];
      for (const row of scene ?? [])
        for (const text of (row.texts as { s?: unknown; p?: number[]; h?: number }[]) ?? []) {
          if (typeof text.s !== 'string' || !Array.isArray(text.p)) continue;
          const [x, y] = transformPoint(matrix, text.p[0], text.p[1]);
          const factor = matrix ? Math.hypot(matrix[0], matrix[4]) : 1;
          out.push({ s: text.s, x, y, h: (text.h ?? 0) * factor });
        }
      return out;
    };
    for (const placement of result.placements) {
      const file = result.files.find((f) => pathKey(f.path) === pathKey(placement.path));
      if (!file?.display) continue;
      const display = await this.display(result, file.display);
      result.texts.model.push(...rows(display.model.scene, placement.matrix));
      if (!placement.matrix)
        for (const [layout, part] of Object.entries(display.paper))
          result.texts.paper[layout] = rows(part.scene, null);
    }
  }
  private compute(projectId: string, result: Result) {
    const { sheets, candidates } = findSheets({
      root: result.root,
      files: result.reads,
      placements: result.placements,
      blocks: this.options.store.settings(projectId).blocks,
      texts: result.texts,
      missing: result.missing,
    });
    result.sheets = sheets;
    result.candidates = candidates;
  }

  /** The person's settings: the title block list and the registered .ctb (one of the choices). */
  async saveSettings(projectId: string, change: { blocks?: string[]; ctb?: string | null }) {
    const settings = this.options.store.settings(projectId);
    if (change.blocks)
      settings.blocks = [
        ...new Map(
          change.blocks
            .map((b) => b.trim())
            .filter(Boolean)
            .map((b) => [b.toUpperCase(), b]),
        ).values(),
      ];
    if (change.ctb !== undefined) {
      if (change.ctb !== null) {
        const choice = (await this.ctbChoices(projectId)).find(
          (c) => pathKey(c.path) === pathKey(change.ctb!),
        );
        if (!choice) throw new DomainError('NOT_FOUND');
        settings.ctb = choice.path;
      } else settings.ctb = null;
    }
    this.options.store.save(projectId, settings);
    const result = this.last.get(projectId)?.result;
    if (result && change.blocks) this.compute(projectId, result);
    return this.status(projectId);
  }
  /** [도곽으로 쓰기] on a candidate: its block joins the list and the sheets are found again. */
  async pick(projectId: string, block: string) {
    const result = this.last.get(projectId)?.result;
    if (!result?.candidates.some((c) => c.block.toUpperCase() === block.trim().toUpperCase()))
      throw new DomainError('NOT_FOUND');
    const { blocks } = this.options.store.settings(projectId);
    return this.saveSettings(projectId, { blocks: [...blocks, block.trim()] });
  }

  /** The display rows inside one sheet (children carry their xref placement). */
  async preview(projectId: string, sheetId: string) {
    const result = this.last.get(projectId)?.result;
    const sheet = result?.sheets.find((s) => s.id === sheetId);
    if (!result || !sheet) throw new DomainError('NOT_FOUND');
    const scene: Record<string, unknown>[] = [];
    const take = (part: Indexed | undefined, matrix: number[] | null, prefix: string) => {
      // An appearance whose whole drawing misses the sheet is skipped at once.
      if (!part?.union || !touches(transformBox(matrix, part.union), sheet.box)) return;
      part.scene.forEach((row, index) => {
        const own = part.boxes[index];
        if (!own || !touches(transformBox(matrix, own), sheet.box)) return;
        // Only what lies in the sheet travels (a big block or hatch is cut to it).
        const cut = clipRow(row, matrix, sheet.box);
        if (cut)
          scene.push({
            ...cut,
            id: prefix + String(row.id),
            ...(matrix ? { placement: matrix } : {}),
          });
      });
    };
    if (sheet.space === 'paper') {
      const file = result.files[0];
      if (file.display)
        take((await this.display(result, file.display)).paper[sheet.layout ?? ''], null, '');
    } else
      for (const [index, placement] of result.placements.entries()) {
        const file = result.files.find((f) => pathKey(f.path) === pathKey(placement.path));
        if (!file?.display) continue;
        take(
          (await this.display(result, file.display)).model,
          placement.matrix,
          index ? `x${index}-` : '',
        );
      }
    return { sheet, scene };
  }
}
