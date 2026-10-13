// host-link.ps1 offline: parser check and the pure helpers' self-test (host-link.test.ps1) in
// Windows PowerShell 5.1. No host is launched.
//   node --test tools/persona/host-link.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

test(
  'host-link helpers pass their PowerShell self-test',
  { skip: process.platform !== 'win32' },
  async () => {
    const { stdout } = await run(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'host-link.test.ps1')],
      { windowsHide: true, encoding: 'utf8' },
    ).catch((error) => {
      throw new Error(`self-test failed:\n${error.stdout}\n${error.stderr}`);
    });
    assert.match(stdout, /all passed/);
    assert.doesNotMatch(stdout, /^FAIL/m);
  },
);

test('the PowerShell files start with a UTF-8 BOM (5.1 reads Korean literals right)', async () => {
  for (const file of ['host-link.ps1', 'host-link.lib.ps1', 'host-link.test.ps1']) {
    const bytes = await readFile(join(here, file));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], file);
  }
});
