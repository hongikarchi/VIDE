import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';

// Runs while the controller lock is held, before opening the application DB for writes.
export function checkDatabase(filename:string) {
  if (filename === ':memory:') return;
  try { if (statSync(filename).size === 0) return; }
  catch (error) { if (error&&typeof error==='object'&&'code' in error&&error.code === 'ENOENT') return; throw error; }
  let db:DatabaseSync|undefined;
  const fail = (code:string) => { throw Object.assign(new Error(code), { code }); };
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    const check = db.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') fail('DATABASE_CORRUPT');
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    if (!table) fail('UNSUPPORTED_SCHEMA');
    const versions = db.prepare('SELECT version FROM schema_version').all();
    if (versions.length !== 1 || versions[0].version !== 1) fail('UNSUPPORTED_SCHEMA');
  } catch (error) {
    if(error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&['DATABASE_CORRUPT', 'UNSUPPORTED_SCHEMA'].includes(error.code)) throw error;
    fail('DATABASE_READ_FAILED');
  } finally { db?.close(); }
}
