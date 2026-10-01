import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SdkExecution } from '../../src/server/sdk-execution.ts';

// PLAN-27 T-087 (2026-10-01): a full-document capture of the attached Rhino is deleted once
// nothing needs it — the copy after the work copy read it, the receipt once no candidate made
// from it can still be applied — and the folder it was imported into once the run ended.
function setup(t) {
  const data = mkdtempSync(join(tmpdir(), 'vide-release-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const models = join(data, 'sdk-models'),
    session = join(data, 'rhino-connections', randomUUID());
  mkdirSync(models, { recursive: true });
  mkdirSync(session, { recursive: true });
  let answer = () => ({
    ok: true,
    revision: 1,
    operationId: randomUUID(),
    filename: join(models, 'run', 'saved.3dm'),
    fileHash: 'b'.repeat(64),
    snapshot: { ok: true, revision: 1, uncertain: false, units: 'Meters', objects: [] },
    readbackVerified: true,
    changes: { added: ['x'], removed: [], modified: [] },
  });
  const launches = [];
  const sdk = new SdkExecution({
    directory: models,
    executable: 'rhino',
    plugin: 'plugin',
    bootstrap: 'bootstrap',
    origin: () => 'http://127.0.0.1:1',
    tools: {},
    launch: async (options) => {
      launches.push(options);
      mkdirSync(options.directory);
      return {
        identity: { sessionId: 'owned' },
        execute: async (operationId) => ({
          ...answer(),
          operationId,
          filename: join(options.directory, operationId + '.3dm'),
        }),
        exportModel: async () => ({ objects: [], scene: [] }),
        stop: async () => {},
      };
    },
  });
  const capture = () => {
    const filename = join(session, randomUUID() + '.3dm');
    writeFileSync(filename, 'copy of the whole document');
    writeFileSync(filename + '.capture.json', '{"objects":{}}');
    return filename;
  };
  return { sdk, launches, capture, setAnswer: (next) => (answer = next) };
}

test('the capture copy goes once the work copy has read it; its receipt stays', async (t) => {
  const { sdk, capture, launches } = setup(t);
  const filename = capture();
  sdk.editors.capture = async () => ({
    filename,
    fileHash: createHash('sha256').update('copy of the whole document').digest('hex'),
    documentHash: 'c'.repeat(64),
    revisionHash: 'd'.repeat(64),
    name: 'a.3dm',
    units: 'Meters',
    selectedIds: [],
    documentId: 3,
    ok: true,
  });
  sdk.editors.connectionKind = async () => 'attached-editor';
  const result = await sdk.captureEditor({ instance: '1:2:x', documentId: 3 }, () => {});
  assert.equal(existsSync(filename), false);
  assert.equal(existsSync(filename + '.capture.json'), true);
  assert.equal(result.sourceDocument.capture, filename);
  assert.equal(result.workerDirectory, launches[0].directory);
  assert.equal(existsSync(result.workerDirectory), true, 'the Sync result still points at it');
});

test('a run from a display Sync drops its import folder, and the receipt unless a candidate remains', async (t) => {
  const { sdk, capture, setAnswer } = setup(t);
  const runs = [];
  sdk.captureEditor = async () => {
    const filename = capture();
    const folder = join(sdk.copies.roots[0], randomUUID());
    mkdirSync(folder);
    writeFileSync(join(folder, 'op.3dm'), 'imported');
    const prepared = {
      filename: join(folder, 'op.3dm'),
      fileHash: createHash('sha256').update('imported').digest('hex'),
      verified: true,
      workerDirectory: folder,
      sourceDocument: { instance: '1:2:x', documentId: 3, capture: filename },
    };
    runs.push(prepared);
    return prepared;
  };
  const task = {
    input: { id: 'r', body: 'b', provider: 'claude-cli', permission: 'candidate', pins: [] },
    previous: {
      id: 'sync',
      result: {
        displayOnly: true,
        sourceDocument: { instance: '1:2:x', documentId: 3, documentHash: 'rev' },
      },
    },
    signal: new AbortController().signal,
    update: () => {},
  };
  // A candidate was made: it can still be applied, so the receipt stays.
  const made = await sdk.runFixed({ ...task, codes: ['a'] });
  assert.equal(made.sourceDocument.capture, runs[0].sourceDocument.capture);
  assert.equal(existsSync(runs[0].workerDirectory), false);
  assert.equal(existsSync(runs[0].sourceDocument.capture + '.capture.json'), true);
  // A failed run leaves no candidate: everything from its capture goes.
  setAnswer(() => ({ ok: false, code: 'CODE_POLICY_REJECTED', revision: 0, diagnostics: [] }));
  await assert.rejects(sdk.runFixed({ ...task, codes: ['bad'] }), {
    code: 'BAKE_TEMPLATE_REJECTED',
  });
  assert.equal(existsSync(runs[1].workerDirectory), false);
  assert.equal(existsSync(runs[1].sourceDocument.capture), false);
  assert.equal(existsSync(runs[1].sourceDocument.capture + '.capture.json'), false);
});
