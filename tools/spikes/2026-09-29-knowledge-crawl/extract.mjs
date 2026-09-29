// Stage 3: deterministic text extraction into excerpts (no AI). Only files whose hash changed
// since the last extraction are read. Mail in Node; PDF/Office/HWP through extract.py.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logRun, tx } from './db.mjs';
import { readMail } from './mail.mjs';
import { pool } from './llm.mjs';

const sha = (text) => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
const PY = fileURLToPath(new URL('./extract.py', import.meta.url));

function chunk(text, locator, max = 1200) {
  const out = [];
  let buf = '';
  for (const p of text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    if (buf && buf.length + p.length > max) (out.push(buf), (buf = ''));
    buf = buf ? buf + '\n' + p : p;
    while (buf.length > max) (out.push(buf.slice(0, max)), (buf = buf.slice(max)));
  }
  if (buf) out.push(buf);
  return out.map((t, i) => ({ locator: out.length > 1 ? `${locator}#${i + 1}` : locator, text: t, kind: 'mail' }));
}

function python(items) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [PY], { windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', () => {
      // Libraries may print warnings on stdout; results are the JSON lines.
      const lines = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      if (!lines.length && items.length) reject(new Error(err.slice(0, 500)));
      else resolve(lines);
    });
    child.stdin.end(JSON.stringify(items));
  });
}

export async function extract(db, root) {
  const started = performance.now();
  const todo = db
    .prepare(`select id, rel_path, ext, kind, sha256 from source
      where skip is null and kind in ('mail','pdf','office','hwp','text') and sha256 is not null
      and (extracted_sha is null or extracted_sha <> sha256)`)
    .all();
  const clear = db.prepare('delete from excerpt where source_id = ?');
  const add = db.prepare('insert into excerpt(source_id, locator, text, text_sha, kind) values(?, ?, ?, ?, ?)');
  const done = db.prepare('update source set extracted_sha = sha256, extract_error = ? where id = ?');
  const putMail = db.prepare(`insert or replace into mail(source_id, message_id, in_reply_to, refs, thread, sent_at,
    from_addr, from_name, to_addrs, cc_addrs, subject) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const clearAtt = db.prepare('delete from attachment where mail_source_id = ?');
  const putAtt = db.prepare('insert into attachment(mail_source_id, filename, ext, size, sha256) values(?, ?, ?, ?, ?)');
  const save = (id, excerpts, error) =>
    tx(db, () => {
      clear.run(id);
      for (const e of excerpts) add.run(id, e.locator, e.text, sha(e.text), e.kind);
      done.run(error, id);
    });
  const counts = { files: todo.length, excerpts: 0, errors: 0, byKind: {} };
  const tally = (row, excerpts, error) => {
    counts.excerpts += excerpts.length;
    if (error) counts.errors++;
    const k = (counts.byKind[row.ext] ??= { files: 0, excerpts: 0, empty: 0, errors: 0 });
    k.files++;
    k.excerpts += excerpts.length;
    if (!excerpts.length) k.empty++;
    if (error) k.errors++;
  };
  // Mail
  for (const row of todo.filter((r) => r.kind === 'mail')) {
    const mail = readMail(await readFile(join(root, row.rel_path)));
    const excerpts = chunk(mail.body, 'body');
    tx(db, () => {
      putMail.run(row.id, mail.messageId, mail.inReplyTo, mail.refs, mail.thread, mail.sentAt, mail.from.addr,
        mail.from.name, JSON.stringify(mail.to), JSON.stringify(mail.cc), mail.subject);
      clearAtt.run(row.id);
      for (const a of mail.attachments) putAtt.run(row.id, a.filename, extname(a.filename).slice(1).toLowerCase(), a.size, a.sha256);
    });
    save(row.id, excerpts, null);
    tally(row, excerpts, null);
  }
  // Documents: small batches, 4 Python processes in parallel.
  const docs = todo.filter((r) => r.kind !== 'mail');
  const batches = [];
  for (let i = 0; i < docs.length; i += 8) batches.push(docs.slice(i, i + 8));
  await pool(batches, 4, async (batch) => {
    const results = await python(batch.map((r) => ({ id: r.id, path: join(root, r.rel_path), ext: r.ext })));
    for (const result of results) {
      const row = batch.find((r) => r.id === result.id);
      save(result.id, result.excerpts, result.error);
      tally(row, result.excerpts, result.error);
    }
  });
  db.exec("insert into excerpt_fts(excerpt_fts) values('rebuild')");
  counts.ms = logRun(db, 'extract', started, { items: counts.excerpts, note: JSON.stringify(counts) });
  return counts;
}
