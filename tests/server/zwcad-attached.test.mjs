import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AttachedZwcadDocuments, readDisplayPages } from '../../hosts/zwcad/attached-documents.ts';
import { ZwcadSdkExecution } from '../../src/server/zwcad-sdk-execution.ts';

test('CAD display-only baseline cannot launch AI code or become an editable source', async () => {
  const execution = new ZwcadSdkExecution({
    directory: 'unused',
    tools: {},
    origin: () => 'http://127.0.0.1',
  });
  await assert.rejects(execution.run({ input: {}, previous: { result: { displayOnly: true } } }), {
    code: 'ZWCAD_ATTACHED_EDIT_UNAVAILABLE',
  });
});

test('CAD discovery ignores malformed and mismatched session records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-cad-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const adapter = new AttachedZwcadDocuments(directory);
  await writeFile(join(directory, session + '.json'), '{invalid');
  assert.equal(await adapter.has(`1:2:${session}`), false);
  await writeFile(
    join(directory, session + '.json'),
    JSON.stringify({
      attached: true,
      identity: {
        pid: 1,
        startTicks: '2',
        sessionId: session,
        documentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        port: 12345,
      },
      token: '0'.repeat(64),
      executable: 'C:/ZWCAD.exe',
    }),
  );
  assert.equal(await adapter.has(`1:2:${session}`), false);
});

for (const code of ['HOST_READ_FAILED', 'HOST_RESPONSE_TOO_LARGE']) {
  test(`read-only CAD pages isolate ${code} without dropping neighbours`, async () => {
    const calls = [];
    const pages = await readDisplayPages(
      async (offset, limit) => {
        calls.push([offset, limit]);
        if (offset <= 1 && offset + limit > 1) throw Object.assign(new Error(code), { code });
        return {
          ok: true,
          offset,
          next: offset + limit,
          total: 3,
          revision: 7,
          objects: [],
          scene: [],
          displayed: 0,
          omitted: limit,
          omittedTypes: { Hidden: limit },
          displayWarnings: {},
        };
      },
      0,
      3,
      3,
      7,
    );
    assert.deepEqual(
      pages.map((p) => [p.offset, p.next]),
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    );
    assert.equal(
      pages[1].omittedTypes[code === 'HOST_READ_FAILED' ? 'UnreadableObject' : 'OversizedDisplay'],
      1,
    );
    assert.deepEqual(
      calls,
      code === 'HOST_RESPONSE_TOO_LARGE'
        ? [
            [0, 3],
            [0, 1],
            [1, 1],
            [2, 1],
          ]
        : [
            [0, 3],
            [0, 1],
            [1, 2],
            [1, 1],
            [2, 1],
          ],
    );
  });
}
for (const code of ['UNAUTHORIZED', 'SOURCE_CHANGED', 'HOST_RESULT_UNKNOWN']) {
  test(`CAD ${code} aborts instead of pretending partial success`, async () => {
    let calls = 0;
    await assert.rejects(
      readDisplayPages(
        async () => {
          calls++;
          throw Object.assign(new Error(code), { code });
        },
        0,
        100,
        100,
        1,
      ),
      { code },
    );
    assert.equal(calls, 1);
  });
}
