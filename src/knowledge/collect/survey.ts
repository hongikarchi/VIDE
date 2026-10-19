// What a 자료 정리 run would process, before it starts (SPEC-08.9 1·5, PLAN-42 T-261): the files to
// read by kind, what is skipped and why (data files, environment and generated folders, images and
// models, folders the person left out), and a rough count of excerpts and filter calls. Read only:
// folder listing, file sizes and the first 64 KB of .txt/.csv files; the knowledge DB is opened
// read-only to tell new and changed files from unchanged ones, to count excerpts already read
// but not yet filtered (a stopped or failed run leaves them; the next run sends them), and for the
// cost of the last run by stage (`run` table) and each kind's bytes per excerpt (T-363).
import { open, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pool } from './ai.ts';
import { KINDS, generatedFile, listFiles, sourceFile, type Roots } from './inventory.ts';
import {
  DATA_FILE_EXTENSIONS,
  DATA_FILE_SAMPLE_CHARS,
  TEXT_READER_VERSION,
  dataFile,
  excerptCap,
  ruleOf,
} from './filters.ts';

/** Images and 3D models: listed, never read (SPEC-01.13 4 reads no pixels or geometry here). */
export const IMAGE_EXTENSIONS = new Set(
  'png jpg jpeg gif bmp tif tiff webp heic psd ai svg'.split(' '),
);
export const MODEL_EXTENSIONS = new Set(
  '3dm 3dmbak rvt rfa rte skp ifc fbx obj stl dxf dgn nwd nwc max blend gh ghx'.split(' '),
);

/**
 * Rough bytes of a file per excerpt, by kind, before any file of that kind was read (the estimate
 * only; the run counts real ones). A first real run (T-363) read 6,434 excerpts where the older
 * ratios (pdf 40,000 · office and hwp 10,000 bytes) guessed 73,574: drawings and images make those
 * files large, so their ratios are ten times larger now; text kept its ratio (an incremental run
 * guessed 136 for 130). Once the knowledge DB holds read files of a kind, that kind's own bytes per
 * excerpt are used instead (`measured`).
 */
export const BYTES_PER_EXCERPT: Record<string, number> = {
  text: 2000,
  pdf: 400_000,
  office: 100_000,
  hwp: 100_000,
};
/** Rough excerpts per mail and per drawing. */
export const MAIL_EXCERPTS = 2;
export const DRAWING_EXCERPTS = 5;
/** The filter stage: texts per call (stages.ts selectExcerpts). */
export const FILTER_BATCH = 40;
/** The AI stages of a run, in order (collector.ts logs each in the `run` table). */
export const AI_STAGES = ['select', 'statements', 'issues', 'proposals'] as const;
export type AiStage = (typeof AI_STAGES)[number];
export interface StageRatio {
  /** AI calls per excerpt read in the run. */
  callsPerExcerpt: number;
  /** Wall seconds per call (calls run several at once). */
  secondsPerCall: number;
}
/**
 * Before any measured run (the first one is off the most): rounded up from the first real run
 * (6,434 excerpts: select 107 calls in 1,292 s · statements 217 in 1,464 s · issues 1,384 in
 * 2,735 s · proposals 20 in 69 s). `select` is one call per `FILTER_BATCH` texts.
 */
export const STAGE_DEFAULTS: Record<AiStage, StageRatio> = {
  select: { callsPerExcerpt: 1 / FILTER_BATCH, secondsPerCall: 12 },
  statements: { callsPerExcerpt: 0.04, secondsPerCall: 7 },
  issues: { callsPerExcerpt: 0.25, secondsPerCall: 2 },
  proposals: { callsPerExcerpt: 0.004, secondsPerCall: 4 },
};
/** Files of a kind read before, at least this many, to use that kind's own bytes per excerpt. */
const MEASURED_FILES = 3;
/** Folders listed as the heaviest ones (by estimated excerpts), at most this many. */
const HEAVY_FOLDERS = 8;

export interface CollectSurvey {
  /** The common folder; folder paths below are relative to it. */
  root: string;
  /** New or changed files that will be read, by kind (text·mail·pdf·office·hwp·dwg·legacy). */
  read: { files: number; byKind: Record<string, number> };
  /** Readable files unchanged since the last run (not read again). */
  unchanged: number;
  /**
   * Excerpts of unchanged files read before but not filtered yet (a stopped or failed run), which
   * the next run sends to the filter AI; included in `estimate` and `heavy`.
   */
  pending: number;
  skipped: {
    /** .txt/.csv number dumps: only their first lines are kept. */
    data: number;
    /** Python or tool environment and cache folders. */
    env: number;
    /** Version control, package and build folders. */
    generatedDirs: number;
    /** Generated, lock and hidden files. */
    generatedFiles: number;
    /** Images and 3D models. */
    media: number;
    /** Other files never read (archives, executables …). */
    other: number;
    /** Folders the person left out. */
    excluded: number;
  };
  estimate: {
    excerpts: number;
    /** The select stage's calls (also `stages.select`). */
    filterCalls: number;
    /** AI calls of every stage. */
    calls: number;
    minutes: number;
    /** AI calls by stage. */
    stages: Record<AiStage, number>;
    /** The ratios come from the last run in the knowledge DB (false: first-run constants). */
    measured: boolean;
  };
  /** The folders with the most estimated excerpts (to leave one out). */
  heavy: { path: string; files: number; excerpts: number }[];
  /** The folders left out, relative to the root ('/'-separated; absolute when outside it). */
  exclude: string[];
}

/** The start of a text file: UTF-8 (a character cut at the end is dropped), else EUC-KR. */
function sampleText(bytes: Buffer) {
  for (let cut = 0; cut < 4 && cut < bytes.length; cut++)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, bytes.length - cut),
      );
    } catch {
      /* Try without the last bytes, then EUC-KR. */
    }
  try {
    return new TextDecoder('euc-kr').decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** Estimated excerpts of one changed readable file (0 for a data file). */
async function estimate(
  path: string,
  ext: string,
  kind: string,
  size: number,
  bytes: Record<string, number>,
) {
  if (kind === 'legacy' || ext === 'msg') return { excerpts: 0, data: false };
  if (kind === 'mail') return { excerpts: MAIL_EXCERPTS, data: false };
  if (kind === 'dwg') return { excerpts: DRAWING_EXCERPTS, data: false };
  if (DATA_FILE_EXTENSIONS.has(ext)) {
    const handle = await open(path, 'r').catch(() => undefined);
    if (handle)
      try {
        const buffer = Buffer.alloc(Math.min(size, DATA_FILE_SAMPLE_CHARS * 3));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (dataFile(sampleText(buffer.subarray(0, bytesRead)))) return { excerpts: 0, data: true };
      } finally {
        await handle.close();
      }
  }
  const per = bytes[kind] ?? BYTES_PER_EXCERPT[kind] ?? BYTES_PER_EXCERPT.text;
  return { excerpts: Math.min(excerptCap(ext), Math.max(1, Math.ceil(size / per))), data: false };
}

interface Known {
  size: number;
  mtime: string;
  changed: boolean;
  /** Read as a data file last time. */
  data: boolean;
  /** Excerpts read but not filtered yet (rule verdicts left out: they need no AI call). */
  pending: number;
}
function knownRows(file: string | undefined) {
  const known = new Map<string, Known>();
  if (!file || !existsSync(file)) return known;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const has = (table: string) =>
        new Set(
          (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map(
            (c) => c.name,
          ),
        );
      const source = has('source');
      const reader = source.has('reader') ? 'reader' : 'null as reader';
      const status = source.has('status') ? 'status' : 'null as status';
      for (const r of db
        .prepare(
          `select rel_path, ext, size, mtime, sha256, extracted_sha, ${status}, ${reader} from source`,
        )
        .all() as {
        rel_path: string;
        ext: string;
        size: number;
        mtime: string;
        sha256: string | null;
        extracted_sha: string | null;
        status: string | null;
        reader: number | null;
      }[])
        known.set(r.rel_path, {
          size: Number(r.size),
          mtime: r.mtime,
          // A .txt/.csv file read by an older reader is read again (extract.ts STALE_READER).
          changed:
            !r.sha256 ||
            r.extracted_sha !== r.sha256 ||
            (DATA_FILE_EXTENSIONS.has(r.ext) && Number(r.reader ?? 0) < TEXT_READER_VERSION),
          data: r.status === 'data',
          pending: 0,
        });
      // Unique texts not filtered yet, as the filter stage picks them (stages.ts selectExcerpts).
      if (has('selection').size) {
        const kind = has('excerpt').has('kind') ? "and e2.kind <> 'data'" : '';
        const live = source.has('status')
          ? "and coalesce(s.status, 'done') in ('done', 'data')"
          : '';
        for (const r of db
          .prepare(
            `select s.rel_path, e.text from excerpt e join source s on s.id = e.source_id
              where e.id in (select min(e2.id) from excerpt e2 join source s on s.id = e2.source_id
                where s.skip is null ${live} ${kind} group by e2.text_sha)
              and e.text_sha not in (select text_sha from selection)`,
          )
          .all() as { rel_path: string; text: string }[]) {
          const row = known.get(r.rel_path);
          if (row && !ruleOf(r.text)) row.pending++;
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* An unreadable DB: every file counts as new. */
  }
  return known;
}

export interface Measured {
  /** Bytes per excerpt of the kinds read before. */
  bytes: Record<string, number>;
  /** By stage, from the last run that read excerpts (none: `STAGE_DEFAULTS`). */
  stages?: Record<AiStage, StageRatio>;
}
interface RunRow {
  stage: string;
  ms: number;
  items: number;
  llm_calls: number;
}
/**
 * What the knowledge DB tells about cost: each kind's bytes per excerpt, and the stages of the last
 * run that read excerpts (its `extract` row, then select, statements and issues; proposals may be
 * missing). A stage's ratio is its AI calls per excerpt read in that run.
 */
export function measured(file: string | undefined): Measured {
  const out: Measured = { bytes: {} };
  if (!file || !existsSync(file)) return out;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = new Set(
        (
          db.prepare("select name from sqlite_master where type = 'table'").all() as {
            name: string;
          }[]
        ).map((t) => t.name),
      );
      const columns = (table: string) =>
        new Set(
          (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map(
            (c) => c.name,
          ),
        );
      if (tables.has('source') && tables.has('excerpt')) {
        const status = columns('source').has('status')
          ? "and coalesce(s.status, 'done') = 'done'"
          : '';
        const notData = columns('excerpt').has('kind') ? "where coalesce(kind, '') <> 'data'" : '';
        for (const r of db
          .prepare(
            `select s.kind, sum(s.size) as bytes, sum(x.n) as excerpts, count(*) as files from source s
              join (select source_id, count(*) as n from excerpt ${notData} group by source_id) x
                on x.source_id = s.id
              where s.skip is null ${status} group by s.kind`,
          )
          .all() as { kind: string; bytes: number; excerpts: number; files: number }[])
          if (r.kind in BYTES_PER_EXCERPT && Number(r.files) >= MEASURED_FILES && r.excerpts > 0)
            out.bytes[r.kind] = Math.max(1, Number(r.bytes) / Number(r.excerpts));
      }
      if (tables.has('run')) {
        const rows = db
          .prepare('select stage, ms, items, llm_calls from run order by id')
          .all() as unknown as RunRow[];
        for (let i = rows.length - 1; i >= 0 && !out.stages; i--) {
          if (rows[i].stage !== 'extract' || !(Number(rows[i].items) > 0)) continue;
          const after: Partial<Record<string, RunRow>> = {};
          for (let j = i + 1; j < rows.length && rows[j].stage !== 'inventory'; j++)
            after[rows[j].stage] ??= rows[j];
          // A stopped or failed run did not reach its later stages: it tells nothing.
          if (!after.select || !after.statements || !after.issues) continue;
          const excerpts = Number(rows[i].items);
          out.stages = Object.fromEntries(
            AI_STAGES.map((stage) => {
              const calls = Number(after[stage]?.llm_calls ?? 0);
              const ms = Number(after[stage]?.ms ?? 0);
              return [
                stage,
                {
                  callsPerExcerpt: calls / excerpts,
                  secondsPerCall: calls ? ms / 1000 / calls : STAGE_DEFAULTS[stage].secondsPerCall,
                },
              ];
            }),
          ) as Record<AiStage, StageRatio>;
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* An unreadable DB: first-run constants. */
  }
  return out;
}

/** AI calls and minutes of a run that reads `excerpts`, by stage. */
export function estimateCost(excerpts: number, ratios?: Record<AiStage, StageRatio>) {
  const stages = { select: 0, statements: 0, issues: 0, proposals: 0 };
  let seconds = 0;
  for (const stage of AI_STAGES) {
    const { callsPerExcerpt, secondsPerCall } = (ratios ?? STAGE_DEFAULTS)[stage];
    stages[stage] = excerpts > 0 ? Math.ceil(excerpts * callsPerExcerpt) : 0;
    seconds += stages[stage] * secondsPerCall;
  }
  return {
    stages,
    calls: AI_STAGES.reduce((sum, stage) => sum + stages[stage], 0),
    minutes: Math.ceil(seconds / 60),
    measured: !!ratios,
  };
}

/** Surveys the project folders: what the next run reads, skips, and roughly costs. */
export async function surveyFolders(
  roots: Roots,
  denied: (path: string) => boolean,
  exclude: readonly string[],
  dbFile?: string,
  signal?: AbortSignal,
): Promise<CollectSurvey> {
  const walked = await listFiles(roots, denied, exclude, signal);
  const known = knownRows(dbFile);
  const cost = measured(dbFile);
  const out: CollectSurvey = {
    root: roots.root,
    read: { files: 0, byKind: {} },
    unchanged: 0,
    pending: 0,
    skipped: {
      data: 0,
      env: walked.skipped.env.length,
      generatedDirs: walked.skipped.generated.length,
      generatedFiles: 0,
      media: 0,
      other: 0,
      excluded: walked.skipped.excluded.length,
    },
    estimate: {
      excerpts: 0,
      filterCalls: 0,
      calls: 0,
      minutes: 0,
      stages: { select: 0, statements: 0, issues: 0, proposals: 0 },
      measured: false,
    },
    heavy: [],
    exclude: [],
  };
  const groups = new Map<string, { files: number; excerpts: number }>();
  const count = (rel: string, local: string, excerpts: number) => {
    // Folders by their place below the project folder; the key is the recorded path (relative
    // to the root, or absolute for a folder outside it) so [빼기] can name it.
    const prefix = rel.slice(0, rel.length - local.length);
    const parts = local.split('/').slice(0, -1);
    for (let depth = 1; depth <= Math.min(2, parts.length); depth++) {
      const key = prefix + parts.slice(0, depth).join('/');
      const group = groups.get(key) ?? { files: 0, excerpts: 0 };
      group.files++;
      group.excerpts += excerpts;
      groups.set(key, group);
    }
  };
  await pool(
    walked.files,
    16,
    async ({ rel, local }) => {
      const ext = extname(rel).slice(1).toLowerCase();
      if (generatedFile(basename(rel))) {
        out.skipped.generatedFiles++;
        return;
      }
      const kind = KINDS[ext];
      if (!kind) {
        if (IMAGE_EXTENSIONS.has(ext) || MODEL_EXTENSIONS.has(ext)) out.skipped.media++;
        else out.skipped.other++;
        return;
      }
      const info = await stat(sourceFile(roots.root, rel)).catch(() => undefined);
      if (!info) return;
      const old = known.get(rel);
      if (old && !old.changed && old.size === info.size && old.mtime === info.mtime.toISOString()) {
        if (old.data) out.skipped.data++;
        else out.unchanged++;
        if (old.pending) {
          out.pending += old.pending;
          out.estimate.excerpts += old.pending;
          count(rel, local, old.pending);
        }
        return;
      }
      const guess = await estimate(sourceFile(roots.root, rel), ext, kind, info.size, cost.bytes);
      if (guess.data) {
        out.skipped.data++;
        return;
      }
      out.read.files++;
      out.read.byKind[kind] = (out.read.byKind[kind] ?? 0) + 1;
      out.estimate.excerpts += guess.excerpts;
      count(rel, local, guess.excerpts);
    },
    signal,
  );
  if (signal?.aborted) throw new Error('STOPPED');
  const priced = estimateCost(out.estimate.excerpts, cost.stages);
  out.estimate = { ...out.estimate, ...priced, filterCalls: priced.stages.select };
  // The heaviest folders; a folder whose one subfolder holds all of it gives way to that subfolder.
  const list = [...groups].map(([path, g]) => ({ path, ...g }));
  out.heavy = list
    .filter(
      (g) =>
        g.excerpts > 0 &&
        !list.some((c) => c.path.startsWith(g.path + '/') && c.excerpts === g.excerpts),
    )
    .sort((a, b) => b.excerpts - a.excerpts || a.path.localeCompare(b.path))
    .slice(0, HEAVY_FOLDERS);
  return out;
}
