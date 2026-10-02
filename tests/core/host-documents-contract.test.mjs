import test from 'node:test';
import assert from 'node:assert/strict';
import { hostDocumentsSchema, hostSelectionSchema } from '../../src/contracts/host-documents.ts';
test('host document boundary rejects invalid identity and incomplete geometry counts', () => {
  const document = { id: 1, name: 'Untitled', units: 'Meters', objectCount: 0, modified: false };
  assert.equal(
    hostDocumentsSchema.safeParse({ instance: '1:2', documents: [document] }).success,
    true,
  );
  for (const item of [
    { ...document, id: 0 },
    { ...document, id: 4294967296 },
    { ...document, objectCount: NaN },
    { ...document, objectCount: -1 },
    { ...document, units: undefined },
  ])
    assert.equal(
      hostDocumentsSchema.safeParse({ instance: '1:2', documents: [item] }).success,
      false,
    );
  assert.equal(
    hostDocumentsSchema.safeParse({ instance: 'unknown', documents: [] }).success,
    false,
  );
  assert.equal(
    hostSelectionSchema.safeParse({
      instance: '1:2',
      documentId: 1,
      documentHash: 'invalid',
      selectedIds: [],
      observedAt: 'now',
    }).success,
    false,
  );
});

const { editorMethods } = await import('../../hosts/rhino/editor-channel.ts');
const { directExecuteInputSchema, directExecuteResultSchema } =
  await import('../../hosts/rhino/application-contract.ts');
const nativeId = '6bde756c-cb1f-45bc-90fa-784c098c2c38';
const hash = 'a'.repeat(64);
const fake = (replies, sent = []) =>
  editorMethods(async (method, extra = {}) => {
    sent.push({ method, ...extra });
    return replies[method];
  });

test('direct-execute input defaults the guard and bounds the code', () => {
  const input = directExecuteInputSchema.parse({ requestId: 'r1', code: 'var a = 1;' });
  assert.deepEqual(input.guard, { confirmed: false, maxDeletes: 50 });
  assert.equal(directExecuteInputSchema.safeParse({ requestId: 'r1', code: '' }).success, false);
  assert.equal(
    directExecuteInputSchema.safeParse({
      requestId: 'r1',
      code: 'x',
      guard: { confirmed: true, maxDeletes: -1 },
    }).success,
    false,
  );
});

test('direct-execute returns changes with an undo id and sends the guard', async () => {
  const sent = [];
  const channel = fake(
    {
      'direct-execute': {
        ok: true,
        undoId: '42',
        changes: {
          added: [{ nativeId, hash, layer: '구조::보' }],
          changed: [],
          removed: [{ nativeId, layer: '기존' }],
          counts: { added: 1, changed: 0, removed: 1 },
          layers: { added: ['구조::보'], removed: [] },
        },
        log: '보 1개 추가',
        value: null,
        units: 'Millimeters',
      },
    },
    sent,
  );
  const result = await channel.directExecute({
    requestId: 'r1',
    code: 'var a = 1;',
    label: '보 추가',
  });
  assert.equal(result.ok, true);
  assert.equal(result.undoId, '42');
  assert.equal(result.changes.added[0].layer, '구조::보');
  assert.deepEqual(sent[0].guard, { confirmed: false, maxDeletes: 50 });
  assert.equal(sent[0].method, 'direct-execute');
});

test('a tripped guard, a compile error and a failed run are results; a busy host throws', async () => {
  const guarded = await fake({
    'direct-execute': {
      ok: false,
      reverted: true,
      guarded: {
        kind: 'bulk-delete',
        detail: '객체 120개를 지웁니다 (기준 50개).',
        deletes: 120,
        layers: 0,
      },
      log: '',
    },
  }).directExecute({ requestId: 'r2', code: 'x' });
  assert.equal(guarded.ok, false);
  assert.equal(guarded.guarded.kind, 'bulk-delete');
  const compile = await fake({
    'direct-execute': { ok: false, code: 'COMPILE_ERROR', diagnostics: ['CS1002'] },
  }).directExecute({ requestId: 'r3', code: 'x' });
  assert.equal(compile.code, 'COMPILE_ERROR');
  const failed = await fake({
    'direct-execute': {
      ok: false,
      code: 'EXECUTION_FAILED',
      reverted: true,
      log: '',
      exceptionType: 'System.Exception',
      message: 'no curve',
    },
  }).directExecute({ requestId: 'r4', code: 'x' });
  assert.equal(failed.reverted, true);
  await assert.rejects(
    fake({ 'direct-execute': { ok: false, code: 'HOST_BUSY' } }).directExecute({
      requestId: 'r5',
      code: 'x',
    }),
    { code: 'HOST_BUSY' },
  );
  assert.equal(
    directExecuteResultSchema.safeParse({
      ok: false,
      guarded: { kind: 'format-disk', detail: '' },
    }).success,
    false,
  );
});

test('direct-undo reports not-latest and fingerprint returns the change token', async () => {
  const channel = fake({
    'direct-undo': { ok: false, reason: 'not-latest' },
    fingerprint: { ok: true, documentHash: hash, revision: 7 },
  });
  assert.deepEqual(await channel.directUndo('42'), { ok: false, reason: 'not-latest' });
  await assert.rejects(channel.directUndo('abc'), { code: 'INVALID_INPUT' });
  assert.deepEqual(await channel.fingerprint(), { ok: true, documentHash: hash, revision: 7 });
});

// ADR-029 (T-106): the form travels to the plugin; a policy refusal the plugin found is a result.
test('direct-execute sends a command or Python form and reads the plugin policy refusal', async () => {
  assert.equal(
    directExecuteInputSchema.safeParse({ requestId: 'r1', code: 'x', language: 'lisp' }).success,
    false,
  );
  const sent = [];
  const channel = fake(
    {
      'direct-execute': {
        ok: false,
        code: 'CODE_POLICY_REJECTED',
        reverted: true,
        log: 'Save: Success\n',
        diagnostics: ['Rhino command not permitted in VIDE: Save (started through an alias)'],
      },
    },
    sent,
  );
  const result = await channel.directExecute({
    requestId: 'r2',
    code: '_-SelDup _Enter',
    language: 'command',
    label: '중복 선택',
  });
  assert.equal(sent[0].language, 'command');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CODE_POLICY_REJECTED');
  assert.match(result.diagnostics[0], /alias/);
});
