import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteAccess } from '../../src/server/remote-access.ts';

// cloudflared that cannot start (blocked, quarantined, locked after sleep) emits 'error' and maybe
// no 'exit'. Unheard, that 'error' ended the whole engine (RESEARCH-13 §5); now only the tunnel
// start fails and the engine carries on (PLAN-27 step 0).
test('a tunnel program that fails to start fails the tunnel, not the engine', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-tunnel-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'remote-host.json'),
    JSON.stringify({
      workerOrigin: 'https://sharing.example',
      hostId: '356ff01d-b586-460c-8e2b-8c9f3c083e96',
      secret: 'a'.repeat(64),
      name: 'Studio PC',
      remote: false,
    }),
  );
  const children = [];
  const remote = new RemoteAccess({
    directory,
    port: () => 1234,
    status: async () => ({}),
    executable: 'cloudflared',
    heartbeatMs: 3_600_000,
    fetcher: async () => new Response(JSON.stringify({ ok: true, projects: [] }), { status: 200 }),
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      children.push(child);
      setTimeout(
        () => child.emit('error', Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })),
        5,
      );
      return child;
    },
  });
  t.after(() => remote.close());
  await assert.rejects(() => remote.start(), { code: 'TUNNEL_START_FAILED' });
  // A later 'error' of the same child is heard too.
  children[0].emit('error', new Error('late'));
  assert.equal((await remote.status()).running, false);
});
