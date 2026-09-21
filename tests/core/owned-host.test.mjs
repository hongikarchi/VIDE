import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { launchOwnedRhino } from '../../hosts/rhino/owned-process.mjs';
import { rhinoCommand } from '../../hosts/rhino/transport.mjs';

async function leaseFixture() {
  const child = new EventEmitter(); child.pid = 123;
  const executable = resolve('synthetic-rhino.exe');
  let observed = { pid: 123, startTicks: '638940000000000001', executable, listeners: [123] };
  const lease = await launchOwnedRhino({ executable,
    spawnProcess: () => { queueMicrotask(() => child.emit('spawn')); return child; },
    inspect: async () => ({ ...observed }) });
  return { lease, child, change: patch => { observed = { ...observed, ...patch }; } };
}

test('owned host lease rejects a foreign listener, reused PID, and ended launch', async () => {
  const { lease, child, change } = await leaseFixture();
  assert.equal((await lease.verify(1999)).pid, 123);
  change({ listeners: [456] });
  await assert.rejects(lease.verify(1999), { code: 'HOST_OWNERSHIP_MISMATCH' });
  change({ listeners: [123], startTicks: '638940000000000002' });
  await assert.rejects(lease.verify(1999), { code: 'HOST_OWNERSHIP_MISMATCH' });
  change({ startTicks: '638940000000000001' });
  child.emit('exit', 0);
  await assert.rejects(lease.verify(1999), { code: 'HOST_LEASE_EXPIRED' });
});

test('revocation during OS inspection cannot issue a valid lease', async () => {
  const { lease } = await leaseFixture();
  const pending = lease.verify(1999); lease.revoke();
  await assert.rejects(pending, { code: 'HOST_LEASE_EXPIRED' });
});

test('every TCP connection verifies ownership before transmission; foreign listener receives zero bytes', async t => {
  const { lease, change } = await leaseFixture();
  let received = 0;
  const server = createServer(socket => socket.on('data', chunk => {
    received += chunk.length;
    const payload = Buffer.from(JSON.stringify({ result: { ok: true } }));
    const header = Buffer.alloc(4); header.writeUInt32BE(payload.length);
    socket.end(Buffer.concat([header, payload]));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const options = { port, beforeSend: () => lease.verify(port) };
  assert.deepEqual(await rhinoCommand('fixed_probe', {}, options), { ok: true });
  const first = received;
  change({ listeners: [456] });
  await assert.rejects(rhinoCommand('fixed_probe', {}, options), { code: 'HOST_OWNERSHIP_MISMATCH' });
  assert.equal(received, first);
});

test('timeout while inspecting ownership never sends a late command', async t => {
  let received = 0, release;
  const server = createServer(socket => socket.on('data', chunk => { received += chunk.length; }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const pending = rhinoCommand('fixed_probe', {}, { port: server.address().port, timeoutMs: 30,
    beforeSend: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(pending, { code: 'HOST_UNAVAILABLE' });
  release(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(received, 0);
});
