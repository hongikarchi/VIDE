import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Test run folders (user decision 2026-10-01): removed after a successful run, kept on failure or
// with VIDE_KEEP_TEST_OUTPUT=1; evidence goes to docs/assets only with VIDE_WRITE_EVIDENCE=1.
const helper = pathToFileURL(resolve('tests/integration/run-directory.mjs')).href;
const run = (body, env = {}) => {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import * as h from ${JSON.stringify(helper)};\n${body}`],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        VIDE_KEEP_TEST_OUTPUT: '',
        VIDE_WRITE_EVIDENCE: '',
        ...env,
      },
    },
  );
  return { status: child.status, out: child.stdout.trim(), err: child.stderr };
};

test('a run folder goes after success and stays after a failure or when asked to', () => {
  const ok = run(`console.log(h.runDirectory('run-directory-check'));`);
  assert.equal(ok.status, 0, ok.err);
  assert.match(ok.out, /[\\/]\.vide[\\/]run-directory-check[\\/][0-9a-f-]{36}$/);
  assert.equal(existsSync(ok.out), false, 'removed after a successful run');

  const failed = run(`console.log(h.runDirectory('run-directory-check')); process.exitCode = 1;`);
  assert.equal(failed.status, 1);
  assert.equal(existsSync(failed.out), true, 'kept for debugging');
  rmSync(failed.out, { recursive: true, force: true });

  const thrown = run(`console.log(h.runDirectory('run-directory-check')); throw new Error('x');`);
  assert.notEqual(thrown.status, 0);
  const left = thrown.out.split('\n')[0];
  assert.equal(existsSync(left), true, 'an uncaught error keeps it');
  rmSync(left, { recursive: true, force: true });

  const kept = run(`console.log(h.runDirectory('run-directory-check'));`, {
    VIDE_KEEP_TEST_OUTPUT: '1',
  });
  assert.equal(existsSync(kept.out), true);
  rmSync(kept.out, { recursive: true, force: true });

  // A folder named by the caller (a harness reads it afterwards) stays.
  const named = run(
    `console.log(h.runDirectory('run-directory-check', { id: '00000000-0000-4000-8000-000000000000' }));`,
  );
  assert.equal(existsSync(named.out), true);
  rmSync(resolve('.vide', 'run-directory-check'), { recursive: true, force: true });
});

test('evidence goes to the run folder unless VIDE_WRITE_EVIDENCE=1', () => {
  const target = '.vide/run-directory-evidence/shot.png';
  const plain = run(`console.log(h.evidencePath(${JSON.stringify(target)}));`);
  assert.match(plain.out, /[\\/]\.vide[\\/]evidence[\\/][0-9a-f-]{36}[\\/]shot\.png$/);
  const written = run(`console.log(h.evidencePath(${JSON.stringify(target)}));`, {
    VIDE_WRITE_EVIDENCE: '1',
  });
  assert.equal(written.out, join(resolve('.'), target));
  rmSync(resolve('.vide', 'run-directory-evidence'), { recursive: true, force: true });
});
