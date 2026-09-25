import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/core/store.ts';
import { backupWorkspace, verifyBackup } from '../../src/core/backup.ts';

test('offline backup preserves records and model files, excludes launch secrets, rejects active control and detects corruption', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vide-backup-')),
    source = join(root, 'data'),
    destination = join(root, 'backup');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(source);
  const store = new Store(join(source, 'vide.sqlite'));
  t.after(() => store.close());
  const project = store.createProject('saved project');
  await mkdir(join(source, 'models', project.id), { recursive: true });
  await writeFile(join(source, 'models', project.id, 'candidate.3dm'), 'synthetic native bytes');
  await mkdir(join(source, 'sdk-models', 'worker'), { recursive: true });
  await writeFile(join(source, 'sdk-models', 'worker', 'candidate.3dm'), 'synthetic SDK candidate');
  await writeFile(join(source, 'sdk-models', 'worker', 'receipt.json'), 'synthetic SDK receipt');
  await writeFile(join(source, 'launch.json'), 'private launch token');
  await writeFile(join(source, 'sdk-models.editors.json'), 'private editor pairing tokens');
  await assert.rejects(backupWorkspace(source, destination), { code: 'CONTROLLER_BUSY' });
  store.close();
  const original = await readFile(join(source, 'vide.sqlite'));
  await assert.rejects(backupWorkspace(source, join(source, 'nested')), {
    code: 'BACKUP_LOCATION_INVALID',
  });
  await mkdir(join(source, 'cli-profiles', 'test-profile'), { recursive: true });
  await writeFile(
    join(source, 'cli-profiles', 'test-profile', 'auth.json'),
    'synthetic credential marker',
  );
  const manifest = await backupWorkspace(source, destination);
  await assert.rejects(readFile(join(destination, 'cli-profiles', 'test-profile', 'auth.json')), {
    code: 'ENOENT',
  });
  assert.equal(manifest.files.length, 4);
  assert.equal((await verifyBackup(destination)).source, source);
  assert.equal(
    await readFile(join(destination, 'sdk-models', 'worker', 'candidate.3dm'), 'utf8'),
    'synthetic SDK candidate',
  );
  assert.equal(
    await readFile(join(destination, 'sdk-models', 'worker', 'receipt.json'), 'utf8'),
    'synthetic SDK receipt',
  );
  await assert.rejects(readFile(join(destination, 'launch.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(destination, 'sdk-models.editors.json')), { code: 'ENOENT' });
  const restored = new DatabaseSync(join(destination, 'vide.sqlite'), { readOnly: true });
  assert.equal(
    restored.prepare('SELECT name FROM projects WHERE id=?').get(project.id).name,
    'saved project',
  );
  restored.close();
  await verifyBackup(destination);
  assert.deepEqual(await readFile(join(source, 'vide.sqlite')), original);
  await assert.rejects(backupWorkspace(source, destination), { code: 'EEXIST' });
  await writeFile(join(destination, 'models', project.id, 'candidate.3dm'), 'tampered');
  await assert.rejects(verifyBackup(destination), { code: 'BACKUP_INVALID' });
});
