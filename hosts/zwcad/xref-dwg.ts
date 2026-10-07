// xref relations and display of project drawings (SPEC-01.11 11, PLAN-43 T-200): one hidden ZWCAD
// started and owned by the engine runs the worker's VIDEXREFGRAPH command (XrefGraph.cs) on the
// copies listed in a manifest and writes one JSON line per drawing; then only that process is
// stopped. The user's own ZWCAD is never attached to or ended; originals are never opened.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchHiddenZwcad } from './crash-prompt.ts';
import { inspectorOptions } from './inspector.ts';
import type {
  XrefDisplayRead,
  XrefFileRead,
  XrefReader,
  XrefReadFile,
} from '../../src/core/xref-graph.ts';

/** No new drawing result for this long ends the read. */
const STALL_MS = 5 * 60_000;

type Row = Record<string, unknown> & { id: number };

async function runWorker(
  options: { executable: string; plugin: string },
  command: string,
  environment: Record<string, string>,
  output: string,
  script: string,
  progress: (done: number) => void,
  signal?: AbortSignal,
) {
  const rows = new Map<number, Row>();
  await writeFile(
    script,
    `(command "_NETLOAD" ${JSON.stringify(options.plugin.replaceAll('\\', '/'))})\n${command}\n`,
  );
  const owner = await launchHiddenZwcad({
    executable: options.executable,
    args: ['/b', script],
    visible: false,
    environment: { ...process.env, ...environment },
  });
  const collect = async () => {
    let text = '';
    try {
      text = await readFile(output, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Row;
        rows.set(row.id, row);
      } catch {
        /* A line still being written. */
      }
    }
  };
  try {
    let last = Date.now(),
      seen = 0;
    while (!existsSync(output + '.done')) {
      if (signal?.aborted) throw new Error('STOPPED');
      await new Promise((accept) => setTimeout(accept, 500));
      await collect();
      if (rows.size !== seen) {
        seen = rows.size;
        owner.settled();
        last = Date.now();
        progress(seen);
      } else if (Date.now() - last > STALL_MS) break;
    }
    await collect();
    progress(rows.size);
    return rows;
  } finally {
    await owner.stop().catch(() => {});
  }
}

const common = (row: Row) => ({
  error: typeof row.error === 'string' ? row.error : null,
  units: typeof row.units === 'number' ? row.units : null,
  scale: typeof row.scale === 'number' ? row.scale : null,
  unitsAssumed: row.unitsAssumed === true,
});

export function zwcadXrefReader(options = inspectorOptions()): XrefReader {
  // Each run its own folder: the worker's `.done` of an earlier run must not end this one. The
  // name is short: ZWCAD refuses a `/b` script path longer than about 250 characters.
  const runFolder = async (work: string) => {
    const folder = join(work, 'r' + randomBytes(4).toString('hex'));
    await mkdir(folder, { recursive: true });
    return folder;
  };
  const manifestOf = async (files: readonly XrefReadFile[], work: string) => {
    const manifest = join(work, 'xref-manifest.tsv');
    await writeFile(manifest, files.map((f) => `${f.id}\t${f.path}`).join('\n'), 'utf8');
    return manifest;
  };
  return {
    async available() {
      try {
        await Promise.all([access(options.executable), access(options.plugin)]);
        return true;
      } catch {
        return false;
      }
    },
    async graph(files, work, progress, signal) {
      const results = new Map<number, XrefFileRead>();
      if (!files.length) return results;
      work = await runFolder(work);
      const output = join(work, 'xref-graph.jsonl');
      const rows = await runWorker(
        options,
        'VIDEXREFGRAPH',
        {
          VIDE_XREF_MANIFEST: await manifestOf(files, work),
          VIDE_XREF_OUT: output,
          VIDE_XREF_MODE: 'graph',
        },
        output,
        join(work, 'xref-graph.scr'),
        progress,
        signal,
      );
      for (const [id, row] of rows)
        results.set(id, {
          ...common(row),
          xrefs: Array.isArray(row.xrefs) ? (row.xrefs as XrefFileRead['xrefs']) : [],
          inserts: Array.isArray(row.inserts) ? (row.inserts as XrefFileRead['inserts']) : [],
        });
      return results;
    },
    async display(files, work, progress, signal) {
      const results = new Map<number, XrefDisplayRead>();
      if (!files.length) return results;
      work = await runFolder(work);
      const output = join(work, 'xref-display.jsonl');
      const rows = await runWorker(
        options,
        'VIDEXREFGRAPH',
        {
          VIDE_XREF_MANIFEST: await manifestOf(files, work),
          VIDE_XREF_OUT: output,
          VIDE_XREF_MODE: 'display',
        },
        output,
        join(work, 'xref-display.scr'),
        progress,
        signal,
      );
      for (const [id, row] of rows) {
        const base = common(row);
        if (base.error || typeof row.file !== 'string') {
          results.set(id, { ...base, error: base.error ?? 'NO_OUTPUT' });
          continue;
        }
        try {
          const model = JSON.parse(await readFile(row.file, 'utf8')) as Omit<
            XrefDisplayRead,
            'error' | 'units' | 'scale' | 'unitsAssumed'
          >;
          results.set(id, { ...base, ...model });
        } catch (cause) {
          results.set(id, { ...base, error: (cause as Error).message });
        }
      }
      return results;
    },
  };
}

/** Test seam (tests/integration/zwcad-xref.mjs): the synthetic drawings into an empty folder. */
export async function writeXrefFixture(folder: string, options = inspectorOptions()) {
  const done = join(folder, 'fixture.done');
  let failure: Error | undefined;
  await runWorker(
    options,
    'VIDEXREFFIXTURE',
    { VIDE_XREF_FIXTURE: folder },
    join(folder, 'fixture'),
    join(folder, 'fixture.scr'),
    () => {},
  ).catch((cause) => {
    failure = cause as Error;
  });
  if (!existsSync(done)) {
    const error = existsSync(join(folder, 'fixture.error'))
      ? await readFile(join(folder, 'fixture.error'), 'utf8')
      : (failure?.message ?? 'no result');
    throw new Error('XREF_FIXTURE_FAILED: ' + error);
  }
}
