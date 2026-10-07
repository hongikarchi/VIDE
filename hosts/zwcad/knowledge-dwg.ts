// Drawing text for the project knowledge collector (SPEC-08.9 2, PLAN-42 T-194): one hidden ZWCAD
// started and owned by the engine reads the copies listed in a manifest with the worker's
// VIDEKNOWLEDGEDWG command (KnowledgeDwg.cs) and writes one JSON line per drawing; then only that
// process is stopped (`runHiddenZwcad`, PLAN-47 T-226). The user's own ZWCAD is never attached to
// or ended.
import { access, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HiddenRunError, runHiddenZwcad } from './hidden-run.ts';
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
        output = join(work, 'out.jsonl');
      await writeFile(manifest, files.map((f) => `${f.id}\t${f.path}`).join('\n'), 'utf8');
      const collect = async () => {
        let text = '';
        try {
          text = await readFile(output, 'utf8');
        } catch {
          return results.size;
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
        return results.size;
      };
      let reported = 0;
      // A host that ended by itself leaves the drawings read so far (as a stall did before).
      await runHiddenZwcad({
        label: 'knowledge-dwg',
        executable: options.executable,
        plugin: options.plugin,
        command: 'VIDEKNOWLEDGEDWG',
        folder: work,
        environment: { VIDE_KNOWLEDGE_MANIFEST: manifest, VIDE_KNOWLEDGE_OUT: output },
        finished: async () => existsSync(output + '.done'),
        progress: async () => {
          const count = await collect();
          if (count !== reported) progress((reported = count));
          return count;
        },
        timeoutMs: Infinity,
        stallMs: STALL_MS,
        onStall: 'end',
        intervalMs: 1000,
        signal,
      }).catch((error: unknown) => {
        if (!(error instanceof HiddenRunError && error.code === 'HIDDEN_HOST_EXITED')) throw error;
      });
      await collect();
      progress(results.size);
      return results;
    },
  };
}
