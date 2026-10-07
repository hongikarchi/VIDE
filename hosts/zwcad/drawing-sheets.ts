// Title block read for the preview (SPEC-14.15, PLAN-47 T-235): one hidden ZWCAD that the engine
// starts and owns runs the worker's VIDEDRAWINGSHEETS (DrawingSheets.cs) on the copies listed in a
// manifest — the root and the drawings it shows through xrefs — and is then stopped
// (`runHiddenZwcad` through `runWorker`). Side databases only: nothing is saved, no document is
// opened, the user's ZWCAD is never touched. One JSON line per drawing; display rows in files.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { inspectorOptions } from './inspector.ts';
import { runWorker } from './xref-dwg.ts';
import { runHiddenZwcad } from './hidden-run.ts';
import type { SheetsFileResult, SheetsReader } from '../../src/core/drawing-sheets.ts';

const list = <T>(value: unknown) => (Array.isArray(value) ? (value as T[]) : []);

export function zwcadSheetsReader(options = inspectorOptions()): SheetsReader {
  return {
    async available() {
      try {
        await Promise.all([access(options.executable), access(options.plugin)]);
        return true;
      } catch {
        return false;
      }
    },
    async read(files, work, blocks, progress, signal) {
      const results = new Map<number, SheetsFileResult>();
      if (!files.length) return results;
      // Its own short folder: ZWCAD refuses a long `/b` script path.
      const folder = join(work, 's' + randomBytes(4).toString('hex'));
      await mkdir(folder, { recursive: true });
      const manifest = join(folder, 'manifest.tsv'),
        names = join(folder, 'blocks.txt'),
        output = join(folder, 'sheets.jsonl');
      await writeFile(
        manifest,
        files.map((f) => `${f.id}\t${f.path}\t${f.root ? 1 : 0}`).join('\n'),
        'utf8',
      );
      await writeFile(names, blocks.join('\n'), 'utf8');
      const rows = await runWorker(
        options,
        'VIDEDRAWINGSHEETS',
        { VIDE_SHEETS_MANIFEST: manifest, VIDE_SHEETS_OUT: output, VIDE_SHEETS_BLOCKS: names },
        output,
        folder,
        progress,
        signal,
      );
      for (const [id, row] of rows)
        results.set(id, {
          // The worker's step where reading stopped, for the diagnosis.
          error:
            typeof row.error === 'string'
              ? row.error + (typeof row.step === 'string' ? ` @ ${row.step}` : '')
              : null,
          units: typeof row.units === 'number' ? row.units : null,
          scale: typeof row.scale === 'number' ? row.scale : null,
          unitsAssumed: row.unitsAssumed === true,
          xrefs: list(row.xrefs),
          inserts: list(row.inserts),
          layouts: list(row.layouts),
          frames: list(row.frames),
          display: typeof row.file === 'string' ? row.file : null,
        });
      return results;
    },
  };
}

/** Test seam (tests/integration/zwcad-drawing-sheets.mjs): synthetic drawings into an empty folder. */
export async function writeSheetsFixture(folder: string, options = inspectorOptions()) {
  await runHiddenZwcad({
    label: 'drawing-sheets-fixture',
    executable: options.executable,
    plugin: options.plugin,
    command: 'VIDEDRAWINGSHEETSFIXTURE',
    folder,
    environment: { VIDE_SHEETS_FIXTURE: folder },
    finished: async () =>
      existsSync(join(folder, 'fixture.done')) || existsSync(join(folder, 'fixture.error')),
    timeoutMs: 3 * 60_000,
  });
  if (!existsSync(join(folder, 'fixture.done')))
    throw new Error(
      'SHEETS_FIXTURE_FAILED: ' + (await readFile(join(folder, 'fixture.error'), 'utf8')),
    );
  return JSON.parse(await readFile(join(folder, 'fixture.json'), 'utf8')) as {
    modelWindow?: boolean;
    layoutWindow?: boolean;
    layout?: string;
  };
}
