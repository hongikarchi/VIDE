import { DatabaseSync } from 'node:sqlite';
import { schemaVersion } from './migrations.ts';
import { statSync } from 'node:fs';

// Runs while the controller lock is held, before opening the application DB for writes.
export function checkDatabase(filename:string):number {
  if (filename === ':memory:') return 0;
  try { if (statSync(filename).size === 0) return 0; }
  catch (error) { if (error&&typeof error==='object'&&'code' in error&&error.code === 'ENOENT') return 0; throw error; }
  let db:DatabaseSync|undefined;
  const fail = (code:string):never => { throw Object.assign(new Error(code), { code }); };
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    const check = db.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') fail('DATABASE_CORRUPT');
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    if (!table) fail('UNSUPPORTED_SCHEMA');
    const versions = db.prepare('SELECT version FROM schema_version').all();
    if (versions.length !== 1 || ![1,schemaVersion].includes(Number(versions[0].version))) fail('UNSUPPORTED_SCHEMA');
    return Number(versions[0].version);
  } catch (error) {
    if(error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&['DATABASE_CORRUPT', 'UNSUPPORTED_SCHEMA'].includes(error.code)) throw error;
    return fail('DATABASE_READ_FAILED');
  } finally { db?.close(); }
}
