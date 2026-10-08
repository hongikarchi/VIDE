// What a 자료 정리 run would process, before it starts (SPEC-08.9 1·5, PLAN-42 T-261): the files to
// read by kind, what is skipped and why (data files, environment and generated folders, images and
// models, folders the person left out), and a rough count of excerpts and filter calls. Read only:
// folder listing, file sizes and the first 64 KB of .txt/.csv files; the knowledge DB is opened
// read-only to tell new and changed files from unchanged ones and to count excerpts already read
// but not yet filtered (a stopped or failed run leaves them; the next run sends them).
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

/** Rough bytes of a file per excerpt, by kind (the estimate only; the run counts real ones). */
export const BYTES_PER_EXCERPT: Record<string, number> = {
  text: 2000,
  pdf: 40_000,
  office: 10_000,
  hwp: 10_000,
};
/** Rough excerpts per mail and per drawing. */
export const MAIL_EXCERPTS = 2;
export const DRAWING_EXCERPTS = 5;
/** The filter stage: texts per call, calls at once, and seconds per call seen in a real run. */
export const FILTER_BATCH = 40;
export const FILTER_PARALLEL = 4;
export const FILTER_SECONDS_PER_CALL = 25;
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
  estimate: { excerpts: number; filterCalls: number; minutes: number };
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
async function estimate(path: string, ext: string, kind: string, size: number) {
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
  const per = BYTES_PER_EXCERPT[kind] ?? BYTES_PER_EXCERPT.text;
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
    estimate: { excerpts: 0, filterCalls: 0, minutes: 0 },
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
      const guess = await estimate(sourceFile(roots.root, rel), ext, kind, info.size);
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
  out.estimate.filterCalls = Math.ceil(out.estimate.excerpts / FILTER_BATCH);
  out.estimate.minutes = Math.ceil(
    (out.estimate.filterCalls / FILTER_PARALLEL) * (FILTER_SECONDS_PER_CALL / 60),
  );
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
