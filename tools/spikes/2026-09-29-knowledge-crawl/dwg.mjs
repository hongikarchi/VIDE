// Stage 3b: DWG text through a hidden ZWCAD that reads copies under .vide/ (AI.md §8: agents never
// open originals in a host). One ZWCAD process reads every changed drawing, then it is stopped.
import { copyFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { launchOwnedHost } from '../../../hosts/common/owned-process.ts';
import { logRun, tx } from './db.mjs';
import { pool } from './llm.mjs';

const ZWCAD = 'C:/Program Files/ZWSOFT/ZWCAD 2023/ZWCAD.exe';
const PLUGIN = resolve('.vide/build/knowledge-dwg/VIDE.KnowledgeDwg.dll');
const WORK = resolve('.vide/knowledge-crawl/dwg');
const sha = (text) => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
const USEFUL = new Set(['text', 'mtext', 'leader', 'attribute', 'dimtext']);

/** Pack one layout's or block's texts (top-to-bottom, left-to-right) into excerpts for selection. */
function excerpts(items) {
  const groups = new Map();
  for (const it of items) {
    if (!USEFUL.has(it.k) || it.t.replace(/\s/g, '').length < 8) continue;
    const key = it.l ? `layout:${it.l}` : `block:${it.b}`;
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(it.t.trim(), it);
  }
  const out = [];
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

export async function dwg(db, root) {
  const started = performance.now();
  const todo = db
    .prepare(`select id, rel_path, sha256 from source where kind = 'dwg' and skip is null and sha256 is not null
      and (extracted_sha is null or extracted_sha <> sha256)`)
    .all();
  if (!todo.length) return { files: 0 };
  await mkdir(WORK, { recursive: true });
  const unique = new Map();
  for (const row of todo) if (!unique.has(row.sha256)) unique.set(row.sha256, row);
  const copyStarted = performance.now();
  await pool([...unique.values()], 4, async (row) => {
    const target = join(WORK, row.sha256 + '.dwg');
    if (!existsSync(target)) await copyFile(join(root, row.rel_path), target);
  });
  const copyMs = Math.round(performance.now() - copyStarted);
  const manifest = join(WORK, 'manifest.tsv'),
    output = join(WORK, 'out.jsonl'),
    script = join(WORK, 'start.scr');
  await rm(output + '.done', { force: true });
  await writeFile(manifest, [...unique.values()].map((r) => `${r.id}\t${join(WORK, r.sha256 + '.dwg')}`).join('\n'), 'utf8');
  await writeFile(script, `(command "_NETLOAD" ${JSON.stringify(PLUGIN.replaceAll('\\', '/'))})\nVIDEKNOWLEDGEDWG\n`);
  const hostStarted = performance.now();
  const owner = await launchOwnedHost({
    executable: ZWCAD,
    args: ['/b', script],
    visible: false,
    environment: { ...process.env, VIDE_KNOWLEDGE_MANIFEST: manifest, VIDE_KNOWLEDGE_OUT: output },
  });
  try {
    const deadline = Date.now() + 30 * 60000;
    while (!existsSync(output + '.done')) {
      if (Date.now() > deadline) throw new Error('ZWCAD extraction timed out');
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await owner.stop();
  }
  const hostMs = Math.round(performance.now() - hostStarted);
  const results = (await readFile(output, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const bySha = new Map(results.map((r) => [unique.get(todo.find((t) => t.id === r.id).sha256).sha256, r]));
  const clearText = db.prepare('delete from dwg_text where source_id = ?');
  const addText = db.prepare('insert into dwg_text(source_id, layout, block, entity, layer, handle, x, y, text) values(?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const clear = db.prepare('delete from excerpt where source_id = ?');
  const add = db.prepare('insert into excerpt(source_id, locator, text, text_sha, kind) values(?, ?, ?, ?, ?)');
  const done = db.prepare('update source set extracted_sha = sha256, extract_error = ? where id = ?');
  const counts = { files: todo.length, uniqueFiles: unique.size, copyMs, hostMs, items: 0, excerpts: 0, errors: 0, byKind: {}, fileMs: [] };
  tx(db, () => {
    for (const row of todo) {
      const r = bySha.get(row.sha256);
      clearText.run(row.id);
      clear.run(row.id);
      if (!r) { done.run('not read', row.id); counts.errors++; continue; }
      // Text rows once per distinct drawing; duplicates are found through source.sha256.
      if (r.id === row.id) {
        for (const it of r.items) {
          addText.run(row.id, it.l, it.b, it.k, it.y, it.h, it.x, it.v, it.t);
          counts.byKind[it.k] = (counts.byKind[it.k] ?? 0) + 1;
        }
        counts.items += r.items.length;
        counts.fileMs.push(r.ms);
      }
      const parts = excerpts(r.items);
      for (const e of parts) add.run(row.id, e.locator, e.text, sha(e.text), e.kind);
      counts.excerpts += parts.length;
      if (r.error) counts.errors++;
      done.run(r.error, row.id);
    }
  });
  db.exec("insert into excerpt_fts(excerpt_fts) values('rebuild')");
  const ms = [...counts.fileMs].sort((a, b) => a - b);
  counts.fileMs = { median: ms[ms.length >> 1] ?? 0, max: ms.at(-1) ?? 0, total: ms.reduce((a, b) => a + b, 0) };
  counts.ms = logRun(db, 'dwg', started, { items: counts.items, note: JSON.stringify(counts) });
  return counts;
}
