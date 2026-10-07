// 도면 읽기 (SPEC-14.3 2, PLAN-47 T-227): one hidden ZWCAD started and owned by the engine runs the
// worker's VIDEDRAWINGINSPECT (DrawingInspect.cs) on the engine's copies listed in a manifest and
// writes one JSON line per drawing; then only that process is stopped (`runHiddenZwcad` through
// `runWorker`). Side databases only; originals and the user's ZWCAD are never touched.
import { access, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { runWorker } from './xref-dwg.ts';
import { inspectorOptions } from './inspector.ts';
import {
  inspectionOf,
  type DrawingInspection,
  type DrawingInspector,
} from '../../src/core/drawing-layers.ts';

/** A crashed host idles (T-225 결과 4): no new drawing and no new step for this long ends the run. */
const STALL_MS = 90_000;

export function zwcadDrawingInspector(options = inspectorOptions()): DrawingInspector {
  return {
    async available() {
      try {
        await Promise.all([access(options.executable), access(options.plugin)]);
        return true;
      } catch {
        return false;
      }
    },
    async inspect(files, work, progress, signal) {
      const results = new Map<number, DrawingInspection>();
      if (!files.length) return results;
      // Its own short folder: an earlier `.done` must not end this run; ZWCAD refuses a long `/b` path.
      const folder = join(work, 'i' + randomBytes(4).toString('hex'));
      await mkdir(folder, { recursive: true });
      const manifest = join(folder, 'manifest.tsv'),
        output = join(folder, 'inspect.jsonl');
      await writeFile(manifest, files.map((f) => `${f.id}\t${f.path}`).join('\n'), 'utf8');
      const rows = await runWorker(
        options,
        'VIDEDRAWINGINSPECT',
        { VIDE_DRAWING_MANIFEST: manifest, VIDE_DRAWING_OUT: output },
        output,
        folder,
        progress,
        signal,
        STALL_MS,
      );
      for (const [id, row] of rows) results.set(id, inspectionOf(row));
      return results;
    },
  };
}
