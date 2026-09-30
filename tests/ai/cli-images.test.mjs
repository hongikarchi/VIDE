import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { ClaudeCli, buildPacket, packetImage } from '../../src/ai/claude-cli.ts';
import { CodexCli } from '../../src/ai/codex-cli.ts';
import { requestInputSchema } from '../../src/contracts/workspace.ts';

// Images to the model (PLAN-24): image items leave the JSON packet and go as image content
// (Claude stream-json input) or image files (Codex --image).
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex').toString('base64');
const context = (images = [`data:image/png;base64,${png}`]) => ({
  goal: '화면을 보고 설명',
  revision: 1,
  items: [
    { id: 'text', type: 'text', data: 'synthetic' },
    ...images.map((dataUrl, i) => ({
      id: `image-${i}`,
      type: 'image',
      data: { kind: 'annotated', name: '고정·스케치 화면', dataUrl },
    })),
  ],
  includedIds: ['text', ...images.map((_, i) => `image-${i}`)],
});

test('buildPacket moves image items out of the JSON packet and keeps their place', () => {
  const selected = buildPacket(
    context([`data:image/png;base64,${png}`, `data:image/jpeg;base64,${jpeg}`]),
  );
  assert.deepEqual(selected.images, [
    { mediaType: 'image/png', data: png },
    { mediaType: 'image/jpeg', data: jpeg },
  ]);
  const text = JSON.stringify(selected.packet);
  assert.ok(!text.includes(png) && !text.includes('base64'));
  assert.deepEqual(selected.packet.items[1].data, {
    kind: 'annotated',
    name: '고정·스케치 화면',
    image: 1,
  });
  assert.deepEqual(selected.packet.items[2].data.image, 2);
  // No images: the packet is as before.
  assert.deepEqual(buildPacket({ ...context([]) }).images, []);
});

test('image items are limited to 3 per turn, 1 MB each, PNG or JPEG data URLs', () => {
  const four = Array.from({ length: 4 }, () => `data:image/png;base64,${png}`);
  assert.throws(() => buildPacket(context(four)), { code: 'CONTEXT_TOO_LARGE' });
  assert.throws(() => buildPacket(context(['data:image/gif;base64,R0lGOD=='])), {
    code: 'INVALID_CONTEXT',
  });
  assert.throws(() => buildPacket(context(['https://example.invalid/a.png'])), {
    code: 'INVALID_CONTEXT',
  });
  const big = Buffer.alloc(1_000_001).toString('base64');
  assert.throws(() => packetImage(`data:image/png;base64,${big}`), { code: 'CONTEXT_TOO_LARGE' });
  assert.equal(
    packetImage(`data:image/png;base64,${Buffer.alloc(1_000_000).toString('base64')}`).mediaType,
    'image/png',
  );
});

test('the request contract accepts up to 3 image items of at most 1 MB', () => {
  const base = {
    id: 'r1',
    body: '이 부분',
    permission: 'review',
    provider: 'claude-cli',
    pins: [],
    sketches: [],
    files: [],
  };
  const image = { kind: 'annotated', dataUrl: `data:image/jpeg;base64,${jpeg}` };
  assert.ok(requestInputSchema.safeParse({ ...base, images: [image] }).success);
  assert.ok(
    !requestInputSchema.safeParse({ ...base, images: [image, image, image, image] }).success,
  );
  assert.ok(
    !requestInputSchema.safeParse({
      ...base,
      images: [{ ...image, dataUrl: 'data:text/html;base64,AA==' }],
    }).success,
  );
  assert.ok(!requestInputSchema.safeParse({ ...base, images: [{ ...image, extra: 1 }] }).success);
  const big = {
    kind: 'viewport',
    dataUrl: `data:image/png;base64,${Buffer.alloc(1_000_003).toString('base64')}`,
  };
  assert.ok(!requestInputSchema.safeParse({ ...base, images: [big] }).success);
});

function transport(events, { onSpawn = () => {}, codex = false } = {}) {
  const calls = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.unref = () => {};
    const call = { args, options, input: '' };
    calls.push(call);
    child.stdin.on('data', (data) => {
      call.input += data;
    });
    const close = () => {
      child.exitCode = 0;
      child.emit('exit', 0);
      child.emit('close', 0);
    };
    const reply = (text, stream = child.stdout) =>
      queueMicrotask(() => {
        stream.write(text + '\n');
        close();
      });
    if (args[0] === '--version') reply(codex ? 'codex-cli 0.157.1' : '2.1.284 (Claude Code)');
    else if (args[0] === 'auth') reply(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
    else if (args[0] === 'login') reply('Logged in using ChatGPT', child.stderr);
    else {
      onSpawn(call);
      child.stdin.on('finish', () => {
        for (const event of events) child.stdout.write(JSON.stringify(event) + '\n');
        setTimeout(close, 5);
      });
    }
    return child;
  };
  return { spawnProcess, calls };
}

test('Claude gets the images as image content of one stream-json user message', async () => {
  const fake = transport([
    { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
    { type: 'result', subtype: 'success', is_error: false, result: '보았습니다', usage: {} },
  ]);
  const cli = new ClaudeCli({ executable: process.execPath, spawnProcess: fake.spawnProcess });
  const value = await cli.run(context());
  assert.equal(value.text, '보았습니다');
  const call = fake.calls.find((entry) => entry.args[0] === '-p');
  assert.equal(call.args[call.args.indexOf('--input-format') + 1], 'stream-json');
  assert.ok(call.input.endsWith('\n'));
  const message = JSON.parse(call.input);
  assert.equal(message.type, 'user');
  const [text, image] = message.message.content;
  assert.equal(text.type, 'text');
  assert.equal(JSON.parse(text.text).items[1].data.image, 1);
  assert.deepEqual(image, {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: png },
  });
  // Without images the input stays the plain packet (text input format).
  const plain = transport([
    { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} },
  ]);
  await new ClaudeCli({ executable: process.execPath, spawnProcess: plain.spawnProcess }).run(
    context([]),
  );
  const plainCall = plain.calls.find((entry) => entry.args[0] === '-p');
  assert.ok(!plainCall.args.includes('--input-format'));
  assert.equal(JSON.parse(plainCall.input).goal, '화면을 보고 설명');
});

test('Codex gets the images as --image files in the run folder, before the prompt', async () => {
  const seen = [];
  const fake = transport(
    [
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'VIDE_OK' } },
      { type: 'turn.completed', usage: {} },
    ],
    {
      codex: true,
      onSpawn: ({ args, options }) => {
        for (let i = 0; i < args.length; i++)
          if (args[i] === '--image') {
            assert.ok(args[i + 1].startsWith(options.cwd));
            seen.push([args[i + 1], readFileSync(args[i + 1]).toString('base64')]);
          }
      },
    },
  );
  const cli = new CodexCli({ executable: process.execPath, spawnProcess: fake.spawnProcess });
  const value = await cli.run(
    context([`data:image/png;base64,${png}`, `data:image/jpeg;base64,${jpeg}`]),
  );
  assert.equal(value.text, 'VIDE_OK');
  assert.deepEqual(
    seen.map(([file, data]) => [file.slice(-11), data]),
    [
      ['image-1.png', png],
      ['image-2.jpg', jpeg],
    ],
  );
  const call = fake.calls.find((entry) => entry.args[0] === 'exec');
  assert.equal(call.args[1], '--json');
  assert.equal(call.args[2], '--image');
  assert.equal(call.args.at(-1), '-');
  assert.ok(!call.input.includes('base64') && !call.input.includes(png));
});

test('a Codex session turn with images keeps its isolation check', async () => {
  const session = { id: '0b8f3f33-9a4b-4c4f-9e5e-1c2d3e4f5a6b', resume: true };
  const fake = transport(
    [
      { type: 'thread.started', thread_id: session.id },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'VIDE_OK' } },
      { type: 'turn.completed', usage: {} },
    ],
    { codex: true },
  );
  const cli = new CodexCli({
    executable: process.execPath,
    session,
    spawnProcess: fake.spawnProcess,
  });
  const value = await cli.run(context());
  assert.equal(value.text, 'VIDE_OK');
  const call = fake.calls.find((entry) => entry.args[0] === 'exec');
  assert.deepEqual(call.args.slice(0, 5), ['exec', 'resume', session.id, '--json', '--image']);
  assert.ok(call.args[5].endsWith('image-1.png'));
});
