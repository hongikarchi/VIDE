import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { liveLaunch } from '../../src/server/lifecycle.ts';
test('desktop startup reuses the authenticated controller and preserves project data after graceful shutdown and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-lifecycle-')),
    children = [];
  const spawnApp = () => {
    const child = spawn(
      process.execPath,
      ['src/server/main.ts', '--open', '--no-browser', '--quiet'],
      {
        env: { ...process.env, VIDE_DATA_DIR: directory, VIDE_PORT: '0' },
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    const done = new Promise((resolve, reject) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', reject);
    });
    children.push({ child, done });
    return { child, done };
  };
  const connect = async () => {
    const deadline = Date.now() + 15000;
    let url;
    while (!(url = await liveLaunch(directory))) {
      if (Date.now() > deadline) throw Error('Startup timed out');
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const origin = new URL(url).origin;
    const auth = await fetch(origin + '/api/v1/session', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: new URL(url).hash.slice(1) }),
    });
    const cookie = auth.headers.get('set-cookie').split(';')[0];
    return (path, method = 'GET', data) =>
      fetch(origin + '/api/v1' + path, {
        method,
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
  };
  try {
    const first = spawnApp();
    let api = await connect();
    const project = await (
      await api('/projects', 'POST', { name: 'Persistent desktop project' })
    ).json();
    const second = spawnApp();
    assert.equal(await second.done, 0);
    assert.equal(first.child.exitCode, null);
    assert.equal((await (await api('/projects')).json())[0].id, project.id);
    assert.equal((await api('/shutdown', 'POST', {})).status, 200);
    assert.equal(await first.done, 0);
    const restarted = spawnApp();
    api = await connect();
    assert.equal((await (await api('/projects')).json())[0].id, project.id);
    await api('/shutdown', 'POST', {});
    assert.equal(await restarted.done, 0);
    await writeFile(
      join(directory, 'launch.json'),
      JSON.stringify({ url: 'https://example.com/#' + 'a'.repeat(64) }),
    );
    assert.equal(await liveLaunch(directory), null);
  } finally {
    for (const { child, done } of children)
      if (child.exitCode === null) {
        child.kill();
        await done;
      }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
