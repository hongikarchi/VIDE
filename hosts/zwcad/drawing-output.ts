// Writing a drawing file through an output token (PLAN-47 T-226, SPEC-14.7): the engine checks the
// token, puts the grant in a new run folder and lets the worker's VIDEDRAWINGCOPY write the file in
// a hidden ZWCAD it starts and stops (`runHiddenZwcad`). The source is the engine's copy of the
// drawing; the original is never opened. T-230·T-233 put their edits into the same write.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { runHiddenZwcad, HiddenRunError, type HiddenRunOptions } from './hidden-run.ts';
import { inspectorOptions } from './inspector.ts';
import { dwgVersionOf, type OutputTokens } from '../../src/core/drawing-output.ts';

export interface DrawingSummary {
  version: string;
  units: number;
  handles: string[];
  layers: string[];
}
const failure = (code: string, details?: Record<string, unknown>) =>
  Object.assign(new Error(code), { code, ...details });

export async function writeDrawingCopy({
  tokens,
  token,
  source,
  target,
  work,
  options = inspectorOptions(),
  timeoutMs = 5 * 60_000,
  signal,
  run = runHiddenZwcad,
}: {
  tokens: OutputTokens;
  token: string;
  /** The engine's copy of the drawing (in its work folder). */
  source: string;
  target: string;
  /** The engine's work folder; this write gets its own short run folder in it. */
  work: string;
  options?: { executable: string; plugin: string };
  timeoutMs?: number;
  signal?: AbortSignal;
  run?: (options: HiddenRunOptions) => ReturnType<typeof runHiddenZwcad>;
}): Promise<{ path: string; version: string; source: DrawingSummary; written: DrawingSummary }> {
  if (![source, work].every((path) => typeof path === 'string' && isAbsolute(path)))
    throw failure('OUTPUT_PATH_DENIED');
  const allowed = tokens.authorize(token, target);
  if ((await dwgVersionOf(source)) !== allowed.version) throw failure('OUTPUT_VERSION_MISMATCH');
  const folder = join(work, 'w' + randomBytes(4).toString('hex'));
  await mkdir(folder, { recursive: true });
  const grant = join(folder, 'grant.json'),
    result = join(folder, 'result.json');
  await writeFile(grant, JSON.stringify(tokens.grant(token)), { flag: 'wx' });
  try {
    await run({
      label: 'drawing-copy',
      executable: options.executable,
      plugin: options.plugin,
      command: 'VIDEDRAWINGCOPY',
      folder,
      environment: {
        VIDE_OUTPUT_GRANT: grant,
        VIDE_OUTPUT_TOKEN: token,
        VIDE_DRAWING_SOURCE: source,
        VIDE_DRAWING_TARGET: allowed.path,
        VIDE_DRAWING_RESULT: result,
      },
      finished: async () => existsSync(result + '.done'),
      timeoutMs,
      signal,
    });
  } catch (error) {
    // A host that ended mid-write may or may not have left the file: never write it again blindly.
    if (existsSync(allowed.path)) {
      tokens.written(token, allowed.path);
      throw failure('OUTPUT_UNCLEAR', { path: allowed.path });
    }
    if (error instanceof HiddenRunError)
      throw failure(error.code, { lastStep: error.details.lastStep, exit: error.details.exit });
    throw error;
  }
  const row = JSON.parse(await readFile(result, 'utf8')) as {
    ok: boolean;
    code?: string;
    path?: string;
    source?: DrawingSummary;
    written?: DrawingSummary;
  };
  if (!row.ok) {
    if (existsSync(allowed.path)) tokens.written(token, allowed.path);
    throw failure(row.code || 'WRITE_FAILED');
  }
  tokens.written(token, allowed.path);
  // The engine reads the header itself: the file must be in the source's version.
  const version = await dwgVersionOf(allowed.path);
  if (version !== allowed.version || row.written?.version !== allowed.version)
    throw failure('OUTPUT_VERSION_MISMATCH', { path: allowed.path });
  return { path: allowed.path, version, source: row.source!, written: row.written! };
}

/** Test seam (tests/integration/zwcad-drawing-output.mjs): synthetic 2013/2018 drawings. */
export async function writeDrawingFixture(folder: string, options = inspectorOptions()) {
  await runHiddenZwcad({
    label: 'drawing-fixture',
    executable: options.executable,
    plugin: options.plugin,
    command: 'VIDEDRAWINGFIXTURE',
    folder,
    environment: { VIDE_DRAWING_FIXTURE: folder },
    finished: async () =>
      existsSync(join(folder, 'fixture.done')) || existsSync(join(folder, 'fixture.error')),
    timeoutMs: 3 * 60_000,
  });
  if (!existsSync(join(folder, 'fixture.done')))
    throw new Error(
      'DRAWING_FIXTURE_FAILED: ' + (await readFile(join(folder, 'fixture.error'), 'utf8')),
    );
}
