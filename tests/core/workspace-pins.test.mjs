import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';

import { soleDb } from '../fixtures/store.mjs';
// T-103 (SPEC-01.11 5): every pin is a change pin and the AI picks which linked file it edits, so
// a change pin in another linked file of the same host is not stale for the starting document.
test('change pins in two linked files of one host are accepted; an older Sync of the same file is stale', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vide-pins-test-'));
  const store = new Store(join(root, 'test.sqlite'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = store.createProject('P');
  const workspace = new Workspace(store);
  const base = {
    provider: 'codex-cli',
    host: 'rhino',
    permission: 'candidate',
    pins: [],
    sketches: [],
    files: [],
  };
  const sync = (id, instance, object, at) =>
    soleDb(store)
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        id,
        project.id,
        JSON.stringify({
          ...base,
          id,
          body: 'sync',
          source: 'document',
          sourceDocument: { instance, documentId: 1 },
        }),
        'succeeded',
        JSON.stringify({
          host: 'rhino',
          hostExecuted: true,
          text: '끝',
          objects: [{ id: object }],
          sourceDocument: {
            connection: 'attached-editor',
            instance,
            documentId: 1,
            documentHash: 'h',
          },
        }),
        at,
      );
  sync('sync-a-old', 'win-a', 'a1', '2026-10-01T00:00:00.000Z');
  sync('sync-a', 'win-a', 'a1', '2026-10-01T00:00:01.000Z');
  sync('sync-b', 'win-b', 'b1', '2026-10-01T00:00:02.000Z');
  const request = (id, pins) => ({ ...base, id, body: '옮겨줘', baseRequestId: 'sync-a', pins });
  const { request: sent } = workspace.submit(
    project.id,
    request('r1', [
      { id: 'a1', basis: 'sync-a', role: 'target' },
      { id: 'b1', basis: 'sync-b', role: 'target' },
    ]),
  );
  assert.equal(sent.id, 'r1');
  // A change pin from an older Sync of the starting document itself is still stale.
  assert.throws(
    () =>
      workspace.submit(
        project.id,
        request('r2', [{ id: 'a1', basis: 'sync-a-old', role: 'target' }]),
      ),
    { code: 'STALE_REFERENCE' },
  );
});
