import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { sendHostCommand } from '../../hosts/common/transport.ts';

async function reply(t, responder) {
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () => void responder(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, timeoutMs: 5000 };
}
function header(length) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(length);
  return bytes;
}

test('fragmented header and multi-megabyte UTF-8 body decode one complete frame', async (t) => {
  const value = { text: '건물🧱'.repeat(300000) };
  const body = Buffer.from(JSON.stringify({ result: value }));
  const options = await reply(t, async (socket) => {
    const bytes = header(body.length);
    for (const byte of bytes) {
      socket.write(Buffer.from([byte]));
      await delay(2);
    }
    for (let i = 0; i < body.length; i += 4093) {
      if (!socket.write(body.subarray(i, i + 4093)))
        await new Promise((resolve) => socket.once('drain', resolve));
    }
    socket.end();
  });
  assert.deepEqual(await sendHostCommand('probe', {}, options), value);
});

for (const length of [0, 16 * 1024 * 1024 + 1])
  test(`invalid frame length ${length} closes without waiting for body`, async (t) => {
    const options = await reply(t, (socket) => socket.write(header(length)));
    await assert.rejects(sendHostCommand('probe', {}, options), { code: 'HOST_INVALID_RESPONSE' });
  });
test('incomplete body never parses uninitialized bytes or becomes a successful response', async (t) => {
  const options = await reply(t, (socket) =>
    socket.end(Buffer.concat([header(100), Buffer.from('{}')])),
  );
  await assert.rejects(sendHostCommand('probe', {}, options), { code: 'HOST_RESULT_UNKNOWN' });
});
test('malformed JSON is invalid and a host error retains rejection semantics', async (t) => {
  const invalid = await reply(t, (socket) =>
    socket.end(Buffer.concat([header(1), Buffer.from('{')])),
  );
  await assert.rejects(sendHostCommand('probe', {}, invalid), { code: 'HOST_INVALID_RESPONSE' });
  const body = Buffer.from(JSON.stringify({ status: 'error' }));
  const rejected = await reply(t, (socket) =>
    socket.end(Buffer.concat([header(body.length), body])),
  );
  await assert.rejects(sendHostCommand('probe', {}, rejected), { code: 'HOST_REJECTED' });
});
