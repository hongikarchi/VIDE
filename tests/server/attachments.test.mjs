import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AttachmentStore,
  readableAttachments,
  sniff,
  MAX_VIEWABLE_IMAGE_BYTES,
} from '../../src/server/attachments.ts';
import { AgentTools } from '../../src/server/agent-tools.ts';
import { agentConnection, agentToolNames, turnRules } from '../../src/ai/agent-connection.ts';
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

test('an upload has no size cap; one that breaks off leaves nothing behind', async (t) => {
  assert.equal(MAX_ATTACHMENT_BYTES, Number.POSITIVE_INFINITY);
  const store = new AttachmentStore(join(await folder(t), 'attachments'));
  async function* broken() {
    yield Buffer.alloc(16 * 1024 * 1024);
    throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
  }
  await assert.rejects(store.save('p1', 'big.bin', broken()), { code: 'ECONNRESET' });
  assert.deepEqual(await readdir(store.directory('p1')), []);
});

test('the request takes any number and size of kept attachments, and still reads inline text files', () => {
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
  // No count or size cap (ADR-031 7).
  assert.equal(
    requestInputSchema.safeParse(input(Array.from({ length: 21 }, (_, i) => kept(i)))).success,
    true,
  );
  assert.equal(
    requestInputSchema.safeParse(
      input([kept(1, 200 * 1024 * 1024), kept(2, 200 * 1024 * 1024), kept(3, 200 * 1024 * 1024)]),
    ).success,
    true,
  );
  assert.equal(requestInputSchema.safeParse(input([{ name: 'x', id: 'nope' }])).success, false);
});

test('the store reads pages of text, images and descriptions; only the allowed ids', async (t) => {
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
  const call = (args) => store.read('p1', allowed, args);
  const first = await call({ id: text.id });
  assert.equal(first.kind, 'text');
  assert.equal(first.offset, 0);
  assert.equal(first.nextOffset, 19998); // cut back to a whole character
  assert.equal(first.text, '가'.repeat(6666));
  const second = await call({ id: text.id, offset: 19998, limit: 40000 });
  assert.equal(second.text, '가'.repeat(13333));
  // An offset inside a character starts at the next whole one.
  const inside = await call({ id: text.id, offset: 1, limit: 6 });
  assert.equal(inside.offset, 3);
  assert.equal(inside.text, '가');
  const shown = await call({ id: image.id });
  assert.equal(shown.mimeType, 'image/png');
  assert.equal(shown.image, PNG.toString('base64'));
  assert.equal(shown.about.name, 'shot.png');
  const described = await call({ id: pdf.id });
  assert.equal(described.kind, 'pdf');
  assert.match(described.note, /not available/);
  // Another conversation's attachment and an unknown id are refused alike.
  for (const id of [other.id, 'f'.repeat(24), '../x'])
    await assert.rejects(call({ id }), (error) =>
      ['ATTACHMENT_NOT_FOUND', 'INVALID_INPUT'].includes(error.code),
    );
  // The CLI's own Read reads them at their path now (ADR-031 8): no VIDE tool for it.
  assert.ok(!agentToolNames.includes('attachment_read'));
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

test('a turn reads its attachments at their path with the CLI tools (ADR-031 8)', async (t) => {
  const store = new AttachmentStore(join(await folder(t), 'attachments'));
  const kept = await store.save('p1', 'brief.txt', chunks('요구 사항'));
  const tools = new AgentTools({ origin: 'http://127.0.0.1:47999' });
  const seen = [];
  const execution = new Execution(
    { list: () => [] },
    {
      tools,
      attachments: store,
      providerFactory: (options) => {
        seen.push(options);
        return { run: async () => ({ text: '' }), status: async () => ({}) };
      },
    },
  );
  const own = input([kept]);
  const signal = new AbortController().signal;
  // A turn without VIDE tools gets no MCP scope, only the work folder with its attachment.
  execution.provider(own, undefined, undefined, { mode: 'data', projectId: 'p1' });
  const alone = seen.at(-1);
  assert.equal(alone.agent, undefined);
  assert.deepEqual(alone.builtinTools.files.attachments, [kept.path]);
  assert.deepEqual(
    await alone.toolPermission({ tool: 'Read', input: { file_path: kept.path } }, signal),
    { allow: true },
  );
  // Another file of the attachment folder is not the turn's (no question outside a conversation).
  const other = await alone.toolPermission(
    { tool: 'Read', input: { file_path: join(store.directory('p1'), 'x.txt') } },
    signal,
  );
  assert.equal(other.allow, false);
  assert.match(
    turnRules(undefined, 'claude', alone.builtinTools),
    /attached files are read at the path/,
  );
  // A host turn keeps its tools; the attachment comes the same way.
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
  const joined = agentConnection(seen.at(-1).agent);
  assert.deepEqual(joined.tools, ['query']);
  assert.deepEqual(seen.at(-1).builtinTools.files.attachments, [kept.path]);
  // No attachments and no folder store: no file tools at all.
  execution.provider(input([]), undefined, undefined, { mode: 'data', projectId: 'p1' });
  assert.equal(seen.at(-1).agent, undefined);
  assert.equal(seen.at(-1).builtinTools, undefined);
});

test('over HTTP: upload any type, preview images only, requests keep the kept record', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-attachments-http-'));
  const seen = [];
  const app = await startServer({
    filename: join(directory, 'store.sqlite'),
    providerFactory: (options) => ({
      run: async () => {
        // The model reads the attachment with the CLI's own Read at its kept path (ADR-031 8).
        const signal = new AbortController().signal;
        seen.push(options.builtinTools.files.attachments);
        for (const path of [seen.path, 'C:/Windows/win.ini'])
          seen.push(
            (await options.toolPermission({ tool: 'Read', input: { file_path: path } }, signal))
              .allow,
          );
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
  seen.path = image.path;
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
  // The kept path is the turn's attachment; the forged path is not read.
  assert.deepEqual(seen.slice(0, 3), [[image.path], true, false]);
  // Deleting the project deletes its attachments.
  assert.equal((await call(`/projects/${project.id}`, 'DELETE')).status, 200);
  assert.equal(existsSync(model.path), false);
});
