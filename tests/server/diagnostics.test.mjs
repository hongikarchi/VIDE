import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Diagnostics } from '../../src/server/diagnostics.ts';
import { startServer } from '../../src/server/server.ts';

const lines = async (directory, day) =>
  (await readFile(join(directory, 'logs', `engine-${day}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('diagnostic lines go to a dated file; files older than the keep period are removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-diag-'));
  try {
    await mkdir(join(directory, 'logs'));
    for (const name of [
      'engine-2026-09-01.jsonl',
      'engine-stderr-2026-09-01.log',
      'engine-2026-09-20.jsonl',
      'model-routing.jsonl',
    ])
      await writeFile(join(directory, 'logs', name), '');
    const log = new Diagnostics({ directory, now: () => new Date('2026-09-29T10:00:00Z') });
    log.write('probe', {
      requestId: 'r1',
      ...Diagnostics.error(Object.assign(new Error('boom'), { code: 'E_X' })),
    });
    const [line] = await lines(directory, '2026-09-29');
    assert.deepEqual(
      [line.event, line.requestId, line.message, line.code],
      ['probe', 'r1', 'boom', 'E_X'],
    );
    assert.match(line.stack, /boom/);
    assert.deepEqual((await readdir(join(directory, 'logs'))).sort(), [
      'engine-2026-09-20.jsonl',
      'engine-2026-09-29.jsonl',
      'model-routing.jsonl',
    ]);
    new Diagnostics({}).write('ignored');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an internal error is logged with the request number shown to the user; runs log start and end', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-diag-server-'));
  const app = await startServer({
    filename: join(directory, 'workspace.sqlite'),
    host: { status: async () => ({ available: true }) },
    providerFactory: () => ({
      run: async () => ({ text: JSON.stringify({ message: '검토', operations: [] }) }),
    }),
  });
  try {
    const login = await fetch(app.origin + '/api/v1/session', {
      method: 'POST',
      headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
    });
    const headers = {
      Origin: app.origin,
      'Content-Type': 'application/json',
      Cookie: login.headers.get('set-cookie').split(';')[0],
    };
    const api = async (path, method = 'GET', data) =>
      fetch(app.origin + '/api/v1' + path, {
        method,
        headers,
        body: data ? JSON.stringify(data) : undefined,
      });
    const project = await (await api('/projects', 'POST', { name: 'diag' })).json();
    // A damaged knowledge DB makes the reader throw an unexpected error.
    await mkdir(join(directory, 'knowledge'));
    await writeFile(join(directory, 'knowledge', project.id + '.sqlite'), 'not a database');
    const failed = await api(`/projects/${project.id}/jigs/knowledge`);
    assert.equal(failed.status, 500);
    const { code, requestId } = await failed.json();
    assert.equal(code, 'INTERNAL_ERROR');
    const input = {
      id: 'diag-run',
      provider: 'codex-cli',
      permission: 'review',
      body: '비밀 요청 문장',
      pins: [],
      sketches: [],
      files: [],
    };
    assert.equal((await api(`/projects/${project.id}/requests`, 'POST', input)).status, 202);
    for (
      let i = 0;
      i < 50 &&
      (await (await api(`/projects/${project.id}/requests/diag-run`)).json()).state !== 'succeeded';
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const day = new Date().toISOString().slice(0, 10);
    const log = await lines(directory, day);
    const error = log.find((line) => line.event === 'server-error');
    assert.equal(error.requestId, requestId);
    assert.equal(error.path, `/api/v1/projects/${project.id}/jigs/knowledge`);
    assert.ok(error.stack);
    assert.ok(log.some((line) => line.event === 'engine-start'));
    const end = log.find((line) => line.event === 'request-end' && line.requestId === 'diag-run');
    assert.equal(end.state, 'succeeded');
    assert.equal(typeof end.ms, 'number');
    assert.ok(log.some((line) => line.event === 'request-start' && line.requestId === 'diag-run'));
    assert.ok(!JSON.stringify(log).includes('비밀 요청 문장'), 'request text is never logged');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
