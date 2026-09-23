import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';

test('incompatible and unreadable databases are rejected without changing their bytes or retaining controller ownership', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vide-database-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, sql, code] of [
    [
      'future',
      'CREATE TABLE schema_version(version); INSERT INTO schema_version VALUES(99)',
      'UNSUPPORTED_SCHEMA',
    ],
    [
      'ambiguous',
      'CREATE TABLE schema_version(version); INSERT INTO schema_version VALUES(1),(2)',
      'UNSUPPORTED_SCHEMA',
    ],
    [
      'foreign',
      'CREATE TABLE other_app(secret); INSERT INTO other_app VALUES(123)',
      'UNSUPPORTED_SCHEMA',
    ],
    ['broken', null, 'DATABASE_READ_FAILED'],
  ]) {
    const filename = join(root, name + '.sqlite');
    if (sql) {
      const db = new DatabaseSync(filename);
      db.exec(sql);
      db.close();
    } else writeFileSync(filename, 'not a database');
    const before = readFileSync(filename);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(
        () => new Store(filename),
        (error) => error.code === code,
      );
      assert.deepEqual(readFileSync(filename), before);
    }
  }
});
