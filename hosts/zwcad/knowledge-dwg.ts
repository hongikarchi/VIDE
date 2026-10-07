// Drawing text for the project knowledge collector (SPEC-08.9 2, PLAN-42 T-194): one hidden ZWCAD
// started and owned by the engine reads the copies listed in a manifest with the worker's
// VIDEKNOWLEDGEDWG command (KnowledgeDwg.cs) and writes one JSON line per drawing; then only that
// process is stopped. The user's own ZWCAD is never attached to or ended.
import { access, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchHiddenZwcad } from './crash-prompt.ts';
import { inspectorOptions } from './inspector.ts';
import type { DwgReader, DwgResult } from '../../src/knowledge/collect/dwg.ts';

/** No new drawing result for this long ends the read. */
const STALL_MS = 5 * 60_000;

export function zwcadKnowledgeReader(options = inspectorOptions()): DwgReader {
  return {
    async available() {
      try {
        await Promise.all([access(options.executable), access(options.plugin)]);
        return true;
      } catch {
        return false;
      }
    },
    async read(files, work, progress, signal) {
      const results = new Map<number, DwgResult>();
      if (!files.length) return results;
      const manifest = join(work, 'manifest.tsv'),
        output = join(work, 'out.jsonl'),
        script = join(work, 'start.scr');
      await writeFile(manifest, files.map((f) => `${f.id}\t${f.path}`).join('\n'), 'utf8');
      await writeFile(
        script,
        `(command "_NETLOAD" ${JSON.stringify(options.plugin.replaceAll('\\', '/'))})\nVIDEKNOWLEDGEDWG\n`,
      );
      const owner = await launchHiddenZwcad({
        executable: options.executable,
        args: ['/b', script],
        visible: false,
        environment: {
          ...process.env,
          VIDE_KNOWLEDGE_MANIFEST: manifest,
          VIDE_KNOWLEDGE_OUT: output,
        },
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
            const row = JSON.parse(line) as DwgResult & { id: number };
            results.set(row.id, { items: row.items ?? [], error: row.error ?? null, ms: row.ms });
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
          await new Promise((accept) => setTimeout(accept, 1000));
          await collect();
          if (results.size !== seen) {
            seen = results.size;
            owner.settled();
            last = Date.now();
            progress(seen);
          } else if (Date.now() - last > STALL_MS) break;
        }
        await collect();
        progress(results.size);
        return results;
      } finally {
        await owner.stop().catch(() => {});
      }
    },
  };
}
