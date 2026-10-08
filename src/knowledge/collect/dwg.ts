// Stage 2b of the collector (SPEC-08.9 2): text of changed drawings. Copies of the drawings go
// into the project's data folder (originals are never opened in a host, AI.md §8); one hidden ZWCAD
// owned by the engine reads them all and is then stopped (hosts/zwcad/knowledge-dwg.ts). Without
// ZWCAD 2023 the drawings are recorded as not read. Texts are grouped by layout or block into
// excerpts (the spike's dwg.mjs).
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tx, type KnowledgeDb } from './schema.ts';
import { changedSources, rebuildSearch, saveExcerpts } from './extract.ts';
import type { Excerpt } from './documents.ts';

/** One text-like item of a drawing (KnowledgeDwg.cs): kind, layout, block, layer, handle, x, y, text. */
export interface DwgItem {
  k: string;
  l: string | null;
  b: string | null;
  y: string | null;
  h: string | null;
  x: number;
  v: number;
  t: string;
}
export interface DwgResult {
  items: DwgItem[];
  error: string | null;
  ms: number;
}
/** Reads drawing copies; `progress(done)` after each one. */
export interface DwgReader {
  available(): Promise<boolean>;
  read(
    files: readonly { id: number; path: string }[],
    work: string,
    progress: (done: number) => void,
    signal?: AbortSignal,
  ): Promise<Map<number, DwgResult>>;
}

const USEFUL = new Set(['text', 'mtext', 'leader', 'attribute', 'dimtext']);
/** One layout's or block's texts, top to bottom and left to right, packed into excerpts. */
export function dwgExcerpts(items: readonly DwgItem[]): Excerpt[] {
  const groups = new Map<string, Map<string, DwgItem>>();
  for (const it of items) {
    if (!USEFUL.has(it.k) || it.t.replace(/\s/g, '').length < 8) continue;
    const key = it.l ? `layout:${it.l}` : `block:${it.b}`;
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key)!.set(it.t.trim(), it);
  }
  const out: Excerpt[] = [];
  for (const [key, unique] of groups) {
    const sorted = [...unique.values()].sort((a, b) => b.v - a.v || a.x - b.x);
    let buf = '',
      part = 0;
    const flush = () => {
      if (buf) out.push({ locator: `${key}#${++part}`, text: buf, kind: 'dwg' });
      buf = '';
    };
    for (const it of sorted) {
      const line = it.t.replace(/\s*\n\s*/g, ' ');
      if (buf.length + line.length > 1200) flush();
      buf = buf ? buf + '\n' + line : line;
    }
    flush();
  }
  return out;
}

export async function extractDrawings(
  db: KnowledgeDb,
  root: string,
  work: string,
  reader: DwgReader | undefined,
  progress: (done: number, total: number) => void,
  signal?: AbortSignal,
) {
  const todo = changedSources(db, ['dwg']);
  if (!todo.length) return { files: 0 };
  progress(0, todo.length);
  if (!reader || !(await reader.available())) {
    tx(db, () => {
      for (const row of todo) saveExcerpts(db, row.id, [], 'no-zwcad', null);
    });
    return { files: todo.length, read: 0, status: 'no-zwcad' };
  }
  await mkdir(work, { recursive: true });
  // One copy per distinct drawing (same bytes, same copy).
  const unique = new Map<string, (typeof todo)[number]>();
  for (const row of todo) if (!unique.has(row.sha256)) unique.set(row.sha256, row);
  const files: { id: number; path: string }[] = [];
  try {
    for (const row of unique.values()) {
      if (signal?.aborted) throw new Error('STOPPED');
      const copy = join(work, row.sha256 + '.dwg');
      try {
        // Relative to the root, or absolute for a folder outside it (SPEC-08.9 1).
        await copyFile(resolve(root, row.rel_path), copy);
        files.push({ id: row.id, path: copy });
      } catch {
        /* Unreadable original: recorded as an error below. */
      }
    }
    const results = await reader.read(files, work, (done) => progress(done, todo.length), signal);
    const byId = new Map(todo.map((row) => [row.id, row]));
    const bySha = new Map<string, DwgResult>();
    for (const [id, result] of results) bySha.set(byId.get(id)!.sha256, result);
    let items = 0;
    tx(db, () => {
      const clearText = db.prepare('delete from dwg_text where source_id = ?');
      const addText = db.prepare(
        'insert into dwg_text(source_id, layout, block, entity, layer, handle, x, y, text) values(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const row of todo) {
        const result = bySha.get(row.sha256);
        clearText.run(row.id);
        if (!result) {
          // Not reached (stopped, or the copy failed): read again next time.
          if (!signal?.aborted) saveExcerpts(db, row.id, [], 'error', 'not read');
          continue;
        }
        for (const it of result.items)
          addText.run(row.id, it.l, it.b, it.k, it.y, it.h, it.x, it.v, it.t);
        items += result.items.length;
        saveExcerpts(
          db,
          row.id,
          dwgExcerpts(result.items),
          result.error ? 'error' : 'done',
          result.error,
        );
      }
    });
    rebuildSearch(db);
    return { files: todo.length, read: results.size, items };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
