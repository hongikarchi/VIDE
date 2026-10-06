import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteAccess } from '../../src/server/remote-access.ts';
import { CLOUDFLARED_SHA256, downloadCloudflared } from '../../src/server/cloudflared.ts';

// PLAN-38 T-177 (ADR-039 2·3): the remote access tool is fetched once in the background and when
// remote access is turned on without it, kept only when its SHA-256 matches; signing in leaves
// remote access off; turning it off clears the tunnel's errors. No real download in these tests.
const device = {
  workerOrigin: 'https://sharing.example',
  hostId: '356ff01d-b586-460c-8e2b-8c9f3c083e96',
  secret: 'a'.repeat(64),
  name: 'Studio PC',
};
const okFetch = async (url) =>
  new Response(
    JSON.stringify(
      String(url).endsWith('/device/login')
        ? { hostId: device.hostId, secret: device.secret }
        : { ok: true, projects: [] },
    ),
    { status: 200 },
  );
/** A cloudflared that prints its address at once. */
const tunnel = (spawned) => (command) => {
  spawned.push(command);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  setTimeout(
    () => child.stderr.emit('data', Buffer.from('https://quick-test.trycloudflare.com')),
    5,
  );
  return child;
};
async function setup(t, { linked = true, remote = false, download } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-cloudflared-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (linked)
    await writeFile(join(directory, 'remote-host.json'), JSON.stringify({ ...device, remote }));
  const spawned = [],
    downloads = [];
  const saved = process.env.VIDE_CLOUDFLARED;
  // Nothing of this PC (its own cloudflared, PATH) is found.
  process.env.VIDE_CLOUDFLARED = '';
  const path = process.env.PATH;
  process.env.PATH = '';
  t.after(() => {
    process.env.PATH = path;
    if (saved === undefined) delete process.env.VIDE_CLOUDFLARED;
    else process.env.VIDE_CLOUDFLARED = saved;
  });
  const remoteAccess = new RemoteAccess({
    directory,
    port: () => 1234,
    status: async () => ({}),
    heartbeatMs: 3_600_000,
    fetcher: okFetch,
    spawnProcess: tunnel(spawned),
    download: async (target) => {
      downloads.push(target);
      if (download) return download(target);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'tool');
    },
  });
  t.after(() => remoteAccess.close());
  return { directory, remoteAccess, spawned, downloads };
}

test('downloadCloudflared keeps the file only when its SHA-256 matches', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-cloudflared-dl-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('cloudflared bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fetcher = async () => new Response(bytes, { status: 200 });
  const target = join(directory, 'bin', 'cloudflared.exe');
  await assert.rejects(() => downloadCloudflared(target, { fetcher, sha256: '0'.repeat(64) }), {
    code: 'CLOUDFLARED_VERIFY_FAILED',
  });
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(target + '.download'), false);
  await assert.rejects(
    () => downloadCloudflared(target, { fetcher: async () => new Response('', { status: 404 }) }),
    { code: 'CLOUDFLARED_DOWNLOAD_FAILED' },
  );
  await assert.rejects(
    () =>
      downloadCloudflared(target, {
        fetcher: async () => {
          throw new TypeError('offline');
        },
      }),
    { code: 'CLOUDFLARED_DOWNLOAD_FAILED' },
  );
  assert.equal(await downloadCloudflared(target, { fetcher, sha256 }), target);
  assert.deepEqual(await readFile(target), bytes);
  // The pinned value is the official 2026.9.3 release's.
  assert.match(CLOUDFLARED_SHA256, /^[0-9a-f]{64}$/);
});

test('signing in leaves remote access off and opens no tunnel', async (t) => {
  const { remoteAccess, spawned, downloads } = await setup(t, { linked: false });
  const status = await remoteAccess.link('user', 'pw', 'PC', 'https://sharing.example');
  assert.equal(status.linked, true);
  assert.equal(status.remote, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(spawned, []);
  assert.deepEqual(downloads, []);
  assert.equal((await remoteAccess.status()).running, false);
});

test('the background fetch gets the tool once and skips it when it is there', async (t) => {
  const { directory, remoteAccess, downloads } = await setup(t);
  const target = join(directory, 'bin', 'cloudflared.exe');
  assert.equal(await remoteAccess.prefetch(), true);
  assert.deepEqual(downloads, [target]);
  assert.equal(await remoteAccess.prefetch(), true);
  assert.deepEqual(downloads, [target], 'already there: not fetched again');
});

test('a failed background fetch is quiet; turning remote on fetches and starts', async (t) => {
  let fail = true;
  const { directory, remoteAccess, spawned, downloads } = await setup(t, {
    download: async (target) => {
      if (fail) throw Object.assign(new Error('offline'), { code: 'CLOUDFLARED_DOWNLOAD_FAILED' });
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, 'tool');
    },
  });
  assert.equal(await remoteAccess.prefetch(), false);
  assert.equal((await remoteAccess.status()).error, undefined, 'nothing shown');
  fail = false;
  await remoteAccess.setRemote(true);
  for (let i = 0; i < 100 && !(await remoteAccess.status()).running; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const status = await remoteAccess.status();
  assert.equal(status.running, true);
  assert.equal(downloads.length, 2);
  assert.deepEqual(spawned, [join(directory, 'bin', 'cloudflared.exe')]);
});

test('a tool that cannot be fetched fails remote access; turning it off clears the error', async (t) => {
  const { remoteAccess, spawned } = await setup(t, {
    download: async () => {
      const { DomainError } = await import('../../src/core/store.ts');
      throw new DomainError('CLOUDFLARED_VERIFY_FAILED');
    },
  });
  await remoteAccess.setRemote(true);
  for (let i = 0; i < 100 && !(await remoteAccess.status()).error; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  let status = await remoteAccess.status();
  assert.equal(status.error, 'CLOUDFLARED_VERIFY_FAILED');
  assert.equal(status.running, false);
  assert.deepEqual(spawned, []);
  status = await remoteAccess.setRemote(false);
  assert.equal(status.error, undefined);
  assert.equal(status.remote, false);
});
