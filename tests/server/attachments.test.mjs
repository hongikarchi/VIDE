import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  AttachmentStore,
  readableAttachments,
  sniff,
  MAX_VIEWABLE_IMAGE_BYTES,
} from '../../src/server/attachments.ts';
import { AgentTools, PLAN_MODE_TOOLS, attachmentHandlers } from '../../src/server/agent-tools.ts';
import {
  agentConnection,
  agentToolNames,
  instructionFor,
  turnRules,
} from '../../src/ai/agent-connection.ts';
import { Execution } from '../../src/server/execution.ts';
import { requestInputSchema, MAX_ATTACHMENT_BYTES } from '../../src/contracts/workspace.ts';
import { startServer } from '../../src/server/server.ts';

// Composer attachments (SPEC-01.12, ARCH-01 §3 「첨부 보관과 읽기 도구」, PLAN-26 T-089).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
async function* chunks(...parts) {
  for (const part of parts) yield Buffer.isBuffer(part) ? part : Buffer.from(part);
}
async function folder(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-attachments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const input = (files, extra = {}) => ({
  id: 'r1',
  provider: 'claude-cli',
  body: '첨부를 읽어줘',
  pins: [],
  sketches: [],
  files,
  ...extra,
});

test('the store keeps each content once, under the project, with what the content is', async (t) => {
  const store = new AttachmentStore(join(await folder(t), 'attachments'));
  const text = await store.save('p1', 'C:\\Users\\me\\notes.md', chunks('# 제목\n', '본문'));
  assert.match(text.id, /^[0-9a-f]{24}$/);
  assert.deepEqual(
    [text.name, text.kind, text.type, text.size, text.copied],
    ['notes.md', 'text', 'text/plain', Buffer.byteLength('# 제목\n본문'), true],
  );
  assert.ok(text.path.startsWith(store.directory('p1')));
  assert.ok(text.path.endsWith(text.id + '.md'));
  // The same content under another name is the same kept file.
  const again = await store.save('p1', 'copy.md', chunks('# 제목\n본문'));
  assert.equal(again.id, text.id);
  assert.equal(again.name, 'copy.md');
  assert.equal((await readdir(store.directory('p1'))).length, 2);
  const image = await store.save('p1', 'shot.png', chunks(PNG));
  assert.deepEqual([image.kind, image.type], ['image', 'image/png']);
  const pdf = await store.save('p1', 'a.pdf', chunks('%PDF-1.7\n...'), 'application/pdf');
  assert.equal(pdf.kind, 'pdf');
  assert.equal(
    (await store.save('p1', 'm.3dm', chunks('3D Geometry File Format  '))).kind,
    'rhino-3dm',
  );
  assert.equal((await store.save('p1', 'd.dwg', chunks('AC1032\0\0'))).kind, 'dwg');
  const binary = await store.save('p1', 'x.bin', chunks(Buffer.from([0, 1, 2, 0xff])));
  assert.deepEqual([binary.kind, binary.type], ['binary', 'application/octet-stream']);
  // Another project does not see it; ids and project ids cannot leave the folder.
  assert.equal(store.get('p2', text.id), undefined);
  assert.equal(store.get('p1', '../' + text.id), undefined);
  assert.throws(() => store.directory('../p1'));
  assert.equal(sniff(Buffer.from('a,b\n1,2\n')).kind, 'text');
  assert.equal(sniff(Buffer.from([0xc3, 0x28])).kind, 'binary');
});

test('an upload over 200 MB stops and leaves nothing behind', async (t) => {
  const store = new AttachmentStore(join(await folder(t), 'attachments'));
  async function* huge() {
    const block = Buffer.alloc(16 * 1024 * 1024);
    for (let sent = 0; sent <= MAX_ATTACHMENT_BYTES; sent += block.length) yield block;
  }
  await assert.rejects(store.save('p1', 'big.bin', huge()), { code: 'INPUT_TOO_LARGE' });
  assert.deepEqual(await readdir(store.directory('p1')), []);
});

test('the request takes up to 20 kept attachments and 500 MB, and still reads inline text files', () => {
  const kept = (i, size = 1) => ({
    id: i.toString(16).padStart(24, '0'),
    name: `f${i}.bin`,
    size,
    type: 'application/octet-stream',
    kind: 'binary',
    path: `C:/data/attachments/p1/${i}`,
    copied: true,
  });
  assert.equal(requestInputSchema.safeParse(input([kept(1)])).success, true);
  // Before SPEC-01.12 the text travelled in the request; such requests still parse.
  assert.equal(
    requestInputSchema.safeParse(
      input([{ name: 'a.txt', text: 'hello', contentStatus: 'included' }]),
    ).success,
    true,
  );
  assert.equal(
    requestInputSchema.safeParse(input(Array.from({ length: 21 }, (_, i) => kept(i)))).success,
    false,
  );
  assert.equal(
    requestInputSchema.safeParse(
      input([kept(1, 200 * 1024 * 1024), kept(2, 200 * 1024 * 1024), kept(3, 200 * 1024 * 1024)]),
    ).success,
    false,
  );
  assert.equal(requestInputSchema.safeParse(input([{ name: 'x', id: 'nope' }])).success, false);
});

test('attachment_read pages text, shows images and describes the rest; only the allowed ids', async (t) => {
  const store = new AttachmentStore(join(await folder(t), 'attachments'));
  const long = '가'.repeat(30000); // 90,000 bytes of 3-byte characters
  const text = await store.save('p1', 'long.txt', chunks(long));
  const image = await store.save('p1', 'shot.png', chunks(PNG));
  const pdf = await store.save('p1', 'spec.pdf', chunks('%PDF-1.7\n'));
  const other = await store.save('p1', 'other.txt', chunks('다른 대화'));
  const allowed = readableAttachments({ conversationId: 'c1', files: [text, image] }, [
    { conversationId: 'c1', files: [pdf] },
    { conversationId: 'c2', files: [other] },
  ]);
  assert.deepEqual([...allowed.keys()].sort(), [text.id, image.id, pdf.id].sort());
  const tools = new AgentTools();
  const scope = tools.issue({
    targetRef: 'attachments:r1',
    isCurrent: () => true,
    handlers: attachmentHandlers(store, 'p1', allowed),
  });
  const call = async (args) => tools.call(scope.token, 'attachment_read', args);
  const first = JSON.parse((await call({ id: text.id })).content[0].text);
  assert.equal(first.kind, 'text');
  assert.equal(first.offset, 0);
  assert.equal(first.nextOffset, 19998); // cut back to a whole character
  assert.equal(first.text, '가'.repeat(6666));
  const second = JSON.parse(
    (await call({ id: text.id, offset: 19998, limit: 40000 })).content[0].text,
  );
  assert.equal(second.text, '가'.repeat(13333));
  // An offset inside a character starts at the next whole one.
  const inside = JSON.parse((await call({ id: text.id, offset: 1, limit: 6 })).content[0].text);
  assert.equal(inside.offset, 3);
  assert.equal(inside.text, '가');
  const shown = await call({ id: image.id });
  assert.equal(shown.content[0].type, 'image');
  assert.equal(shown.content[0].mimeType, 'image/png');
  assert.equal(shown.content[0].data, PNG.toString('base64'));
  assert.equal(JSON.parse(shown.content[1].text).name, 'shot.png');
  const described = JSON.parse((await call({ id: pdf.id })).content[0].text);
  assert.equal(described.kind, 'pdf');
  assert.match(described.note, /not available/);
  // Another conversation's attachment and an unknown id are refused alike.
  for (const id of [other.id, 'f'.repeat(24)]) {
    const refused = await call({ id });
    assert.equal(refused.isError, true);
    assert.equal(JSON.parse(refused.content[0].text).code, 'ATTACHMENT_NOT_FOUND');
  }
  assert.equal((await call({ id: '../x' })).isError, true);
  assert.ok(PLAN_MODE_TOOLS.has('attachment_read'));
  assert.ok(agentToolNames.includes('attachment_read'));
});

test('a large image is shown through its view copy, or described without one', async (t) => {
  const store = new AttachmentStore(join(await folder(t), 'attachments'));
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_VIEWABLE_IMAGE_BYTES)]);
  const kept = await store.save('p1', 'photo.png', chunks(big));
  const allowed = new Map([[kept.id, kept.name]]);
  const before = await store.read('p1', allowed, { id: kept.id });
  assert.match(before.note, /cannot be shown/);
  await assert.rejects(store.saveView('p1', kept.id, chunks('not an image')), {
    code: 'INVALID_INPUT',
  });
  await store.saveView('p1', kept.id, chunks(PNG));
  const after = await store.read('p1', allowed, { id: kept.id });
  assert.equal(after.image, PNG.toString('base64'));
  assert.match(after.about.shown, /view copy/);
  assert.deepEqual((await store.image('p1', kept.id)).bytes, PNG);
});

test('a turn gets attachment_read: added to its scope, or alone, with rules that name it', async (t) => {
  const store = new AttachmentStore(join(await folder(t), 'attachments'));
  const kept = await store.save('p1', 'brief.txt', chunks('요구 사항'));
  const tools = new AgentTools({ origin: 'http://127.0.0.1:47999' });
  const agents = [];
  const execution = new Execution(
    { list: () => [] },
    {
      tools,
      attachments: store,
      providerFactory: (options) => {
        agents.push(options.agent);
        return { run: async () => ({ text: '' }), status: async () => ({}) };
      },
    },
  );
  const own = input([kept]);
  // A turn without tools gets a scope of its own with only attachment_read.
  execution.provider(own, undefined, undefined, { mode: 'data', projectId: 'p1' });
  const alone = agentConnection(agents.at(-1));
  assert.deepEqual(alone.tools, ['attachment_read']);
  const read = await tools.call(alone.token, 'attachment_read', { id: kept.id });
  assert.equal(JSON.parse(read.content[0].text).text, '요구 사항');
  assert.match(instructionFor(alone), /attachment_read\(\{id\}\)/);
  assert.match(turnRules(alone), /attachment_read/);
  // A host turn keeps its tools and gains attachment_read on the same token.
  const host = tools.issue({
    targetRef: 'rhino:doc',
    isCurrent: () => true,
    handlers: { query: () => ({ ok: true }) },
  });
  execution.provider(
    own,
    {
      url: 'http://127.0.0.1:47999/mcp',
      targetRef: 'rhino:doc',
      token: host.token,
      tools: ['query'],
    },
    undefined,
    { mode: 'modeling', projectId: 'p1' },
  );
  const joined = agentConnection(agents.at(-1));
  assert.deepEqual(joined.tools, ['query', 'attachment_read']);
  assert.equal(
    (await tools.call(host.token, 'attachment_read', { id: kept.id })).isError,
    undefined,
  );
  assert.match(instructionFor(joined), /Use query to observe/);
  assert.match(instructionFor(joined), /attachment_read/);
  // No attachments: nothing changes.
  execution.provider(input([]), undefined, undefined, { mode: 'data', projectId: 'p1' });
  assert.equal(agents.at(-1), undefined);
});

test('over HTTP: upload any type, preview images only, requests keep the kept record', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-attachments-http-'));
  const seen = [];
  const app = await startServer({
    filename: join(directory, 'store.sqlite'),
    providerFactory: (options) => ({
      run: async () => {
        // The model reads the attachment over MCP while the turn runs.
        const agent = agentConnection(options.agent);
        const client = new Client({ name: 'synthetic-agent', version: '1.0.0' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(agent.url), {
            requestInit: { headers: { Authorization: `Bearer ${agent.token}` } },
          }),
        );
        const listed = await client.listTools();
        seen.push(listed.tools.map((tool) => tool.name));
        const file = await client.callTool({
          name: 'attachment_read',
          arguments: { id: seen.id },
        });
        seen.push(file.content[0].type);
        await client.close();
        return { text: JSON.stringify({ message: '읽었습니다', operations: [] }) };
      },
      status: async () => ({ available: true }),
    }),
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (path, method = 'GET', body, type = 'application/json') =>
    fetch(app.origin + '/api/v1' + path, {
      method,
      headers: { Origin: app.origin, Cookie: cookie, ...(body ? { 'Content-Type': type } : {}) },
      body,
    });
  const project = await (await call('/projects', 'POST', JSON.stringify({ name: 'p' }))).json();
  const upload = (name, bytes) =>
    call(
      `/projects/${project.id}/attachments?name=${encodeURIComponent(name)}`,
      'POST',
      bytes,
      'application/octet-stream',
    );
  const image = await (await upload('사진.png', PNG)).json();
  assert.equal(image.kind, 'image');
  const model = await (await upload('model.3dm', Buffer.from('3D Geometry File Format  '))).json();
  assert.equal(model.kind, 'rhino-3dm');
  assert.ok(existsSync(model.path));
  const preview = await call(`/projects/${project.id}/attachments/${image.id}`);
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), PNG);
  assert.equal((await call(`/projects/${project.id}/attachments/${model.id}`)).status, 404);
  assert.equal((await upload('x.txt', undefined)).status, 400);
  // The request names kept files only; what the browser says of them is replaced.
  const requests = `/projects/${project.id}/requests`;
  const unknown = { ...image, id: 'e'.repeat(24) };
  assert.equal((await call(requests, 'POST', JSON.stringify(input([unknown])))).status, 400);
  seen.id = image.id;
  const forged = { ...image, size: 1, path: 'C:/Windows/win.ini' };
  const accepted = await call(
    requests,
    'POST',
    JSON.stringify(input([forged], { provider: 'codex-cli', permission: 'review' })),
  );
  assert.equal(accepted.status, 202);
  let stored;
  for (let i = 0; i < 100; i++) {
    stored = await (await call(`${requests}/r1`)).json();
    if (stored.state !== 'queued' && stored.state !== 'running') break;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(stored.input.files[0].path, image.path);
  assert.equal(stored.input.files[0].size, PNG.length);
  // Every instructed turn also has the project file tools (SPEC-01.13).
  assert.deepEqual(seen.slice(0, 2), [['attachment_read', 'file_list', 'file_read'], 'image']);
  // Deleting the project deletes its attachments.
  assert.equal((await call(`/projects/${project.id}`, 'DELETE')).status, 200);
  assert.equal(existsSync(model.path), false);
});
