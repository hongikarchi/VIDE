// 역반영 in hidden ZWCADs (SPEC-14.8·14.11 2, PLAN-47 T-233): the worker's VIDEDRAWINGENTITIES reads the
// engine's copies of closed drawings (entities, dimensions, layers) and VIDEDRAWINGAPPLY applies ops
// to copies and writes the results through an output token (DrawingBackflow.cs, BackflowOps.cs).
// Every run is `runHiddenZwcad`: a hidden ZWCAD this engine starts and stops, side databases only;
// originals and the user's ZWCAD are never touched.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { runWorker } from './xref-dwg.ts';
import { HiddenRunError, runHiddenZwcad, type HiddenRunOptions } from './hidden-run.ts';
import { inspectorOptions } from './inspector.ts';
import { dwgVersionOf, type OutputTokens } from '../../src/core/drawing-output.ts';
import {
  stateFromRow,
  type BackflowOp,
  type DrawingState,
  type FileApply,
} from '../../src/core/drawing-backflow-apply.ts';

/** A crashed host idles (T-225 결과 4): no new drawing and no new step for this long ends the run. */
const STALL_MS = 90_000;
const failure = (code: string, details?: Record<string, unknown>) =>
  Object.assign(new Error(code), { code, ...details });

export interface ClosedRead extends DrawingState {
  id: number;
  version: string | null;
  units: number | null;
  error: string | null;
}

/** Entities of the copies (`{id, path}`), by id; a copy the host could not read has `error`. */
export async function readDrawingEntities(
  files: readonly { id: number; path: string }[],
  work: string,
  options = inspectorOptions(),
  signal?: AbortSignal,
): Promise<Map<number, ClosedRead>> {
  const results = new Map<number, ClosedRead>();
  if (!files.length) return results;
  const folder = join(work, 'e' + randomBytes(4).toString('hex'));
  await mkdir(folder, { recursive: true });
  const manifest = join(folder, 'manifest.tsv'),
    output = join(folder, 'entities.jsonl');
  await writeFile(manifest, files.map((f) => `${f.id}\t${f.path}`).join('\n'), 'utf8');
  const rows = await runWorker(
    options,
    'VIDEDRAWINGENTITIES',
    { VIDE_DRAWING_MANIFEST: manifest, VIDE_DRAWING_OUT: output },
    output,
    folder,
    () => {},
    signal,
    STALL_MS,
  );
  for (const [id, row] of rows)
    results.set(id, {
      id,
      ...stateFromRow(row),
      version: typeof row.version === 'string' ? row.version : null,
      units: typeof row.units === 'number' ? row.units : null,
      error: typeof row.error === 'string' ? row.error : null,
    });
  return results;
}

export interface ApplyJob {
  id: string;
  /** The engine's copy of the drawing (in its work folder). */
  source: string;
  /** Where the result goes (a token file). */
  target: string;
  ops: BackflowOp[];
  /** The origin marks' revision (1071). */
  revision: number;
}
export interface ClosedApply extends FileApply {
  id: string;
  path: string;
}

/**
 * Applies the jobs (one DWG version: one token) in one hidden ZWCAD and writes every result through
 * the token, or none: a refused op or a failed job leaves no file (`APPLY_FAILED` with each job's
 * `failed` ops). A host that ended mid-write with a target on disk is `OUTPUT_UNCLEAR`.
 */
export async function applyDrawingCopies({
  tokens,
  token,
  jobs,
  work,
  options = inspectorOptions(),
  timeoutMs = 10 * 60_000,
  signal,
  run = runHiddenZwcad,
}: {
  tokens: OutputTokens;
  token: string;
  jobs: readonly ApplyJob[];
  work: string;
  options?: { executable: string; plugin: string };
  timeoutMs?: number;
  signal?: AbortSignal;
  run?: (options: HiddenRunOptions) => ReturnType<typeof runHiddenZwcad>;
}): Promise<ClosedApply[]> {
  if (!jobs.length) return [];
  if (!isAbsolute(work) || jobs.some((job) => !isAbsolute(job.source)))
    throw failure('OUTPUT_PATH_DENIED');
  const allowed = jobs.map((job) => tokens.authorize(token, job.target));
  for (const [i, job] of jobs.entries())
    if ((await dwgVersionOf(job.source)) !== allowed[i].version)
      throw failure('OUTPUT_VERSION_MISMATCH');
  const folder = join(work, 'a' + randomBytes(4).toString('hex'));
  await mkdir(folder, { recursive: true });
  const grant = join(folder, 'grant.json'),
    input = join(folder, 'jobs.json'),
    result = join(folder, 'result.json');
  await writeFile(grant, JSON.stringify(tokens.grant(token)), { flag: 'wx' });
  await writeFile(
    input,
    JSON.stringify(jobs.map((job, i) => ({ ...job, target: allowed[i].path }))),
    'utf8',
  );
  const written = () => allowed.filter((a) => existsSync(a.path)).map((a) => a.path);
  try {
    await run({
      label: 'drawing-apply',
      executable: options.executable,
      plugin: options.plugin,
      command: 'VIDEDRAWINGAPPLY',
      folder,
      environment: {
        VIDE_OUTPUT_GRANT: grant,
        VIDE_OUTPUT_TOKEN: token,
        VIDE_BACKFLOW_JOBS: input,
        VIDE_DRAWING_RESULT: result,
      },
      finished: async () => existsSync(result + '.done'),
      timeoutMs,
      signal,
    });
  } catch (error) {
    // A host that ended mid-write may have left files: never write them again blindly.
    const left = written();
    if (left.length) {
      for (const path of left) tokens.written(token, path);
      throw failure('OUTPUT_UNCLEAR', { paths: left });
    }
    if (error instanceof HiddenRunError)
      throw failure(error.code, { lastStep: error.details.lastStep, exit: error.details.exit });
    throw error;
  }
  const answer = JSON.parse(await readFile(result, 'utf8')) as {
    ok: boolean;
    code?: string;
    message?: string;
    jobs: {
      id: string;
      ok: boolean;
      code?: string;
      path?: string;
      results?: { id: string; handle: string }[];
      failed?: { id: string; code: string; message?: string }[];
      before?: unknown;
      after?: unknown;
    }[];
  };
  for (const path of written()) tokens.written(token, path);
  if (!answer.ok)
    throw failure(answer.code || 'APPLY_FAILED', {
      jobs: (answer.jobs ?? []).map((job) => ({
        id: job.id,
        code: job.code ?? null,
        failed: job.failed ?? [],
      })),
    });
  const out: ClosedApply[] = [];
  for (const [i, job] of answer.jobs.entries()) {
    // The engine reads the header itself: the file must be in the source's version.
    if ((await dwgVersionOf(allowed[i].path)) !== allowed[i].version)
      throw failure('OUTPUT_VERSION_MISMATCH', { path: allowed[i].path });
    out.push({
      id: job.id,
      path: allowed[i].path,
      results: job.results ?? [],
      before: stateFromRow(job.before),
      after: stateFromRow(job.after),
    });
  }
  return out;
}

/** Test seam (tests/integration/zwcad-drawing-backflow.mjs): synthetic root + xref child. */
export async function writeBackflowFixture(folder: string, options = inspectorOptions()) {
  await runHiddenZwcad({
    label: 'backflow-fixture',
    executable: options.executable,
    plugin: options.plugin,
    command: 'VIDEBACKFLOWFIXTURE',
    folder,
    environment: { VIDE_BACKFLOW_FIXTURE: folder },
    finished: async () =>
      existsSync(join(folder, 'fixture.done')) || existsSync(join(folder, 'fixture.error')),
    timeoutMs: 3 * 60_000,
  });
  if (!existsSync(join(folder, 'fixture.done')))
    throw new Error(
      'BACKFLOW_FIXTURE_FAILED: ' + (await readFile(join(folder, 'fixture.error'), 'utf8')),
    );
}
