import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyPackageSources } from '../../src/desktop/package-source.mjs';

test('package includes indexed source but excludes untracked local files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vide-package-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  await mkdir(join(root, 'src/core'), {recursive:true});
  await writeFile(join(root, 'src/core/store.ts'), 'source');
  await writeFile(join(root, 'src/core/.env'), 'SYNTHETIC_ONLY=1');
  await writeFile(join(root, 'src/core/private.sqlite'), 'synthetic');
  const out = join(root, 'out');
  assert.equal(await copyPackageSources(root,out,['src/core/store.ts'],['src/core']),1);
  assert.equal(await readFile(join(out,'src/core/store.ts'),'utf8'),'source');
  assert.deepEqual(await readdir(join(out,'src/core')),['store.ts']);
  for (const name of ['src/core/.env','src/core/private.sqlite','src/core/../private.txt']) {
    await assert.rejects(copyPackageSources(root,out,[name],['src/core']), /FORBIDDEN_PACKAGE_SOURCE|INVALID_PACKAGE_SOURCE_PATH/);
  }
});
