import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RhinoWorkspace } from '../../hosts/rhino/workspace.ts';

test('externally edited source is refused before any Rhino command or output overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-source-test-'));
  try {
    const source = join(directory, 'source.3dm');
    await writeFile(source, 'changed by user');
    const host = new RhinoWorkspace(directory);
    await assert.rejects(
      host.build('project', 'request', [], { filename: source, fileHash: 'old-hash', objects: [] }),
      { code: 'SOURCE_CHANGED' },
    );
    assert.equal(await readFile(source, 'utf8'), 'changed by user');
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), 'vide-source-test-')));
    await rm(directory, { recursive: true, force: true });
  }
});
