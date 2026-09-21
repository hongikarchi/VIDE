import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/core/store.ts';

test('실제 제어 프로세스 강제 종료 후 잠금이 풀리고 입력·불명확 쓰기가 복원된다', { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'vide-crash-test-')), filename = join(root, 'crash.sqlite');
  const child = fork(new URL('../fixtures/store-crash.mjs', import.meta.url), [filename], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let store;
  t.after(async () => {
    if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill();await closed;}
    store?.close();rmSync(root,{recursive:true,force:true});
  });
  const [ready] = await once(child, 'message');
  assert.equal(typeof ready.projectId,'string');assert.equal(typeof ready.inputId,'string');
  assert.throws(() => new Store(filename), { code: 'CONTROLLER_BUSY' });
  const exit = once(child, 'exit'); child.kill(); await exit;
  store = new Store(filename);
  assert.equal(store.getInput(ready.projectId, ready.inputId).body.text, '저장 완료 입력');
  assert.equal(store.getCommand(ready.projectId, 'in-flight').state, 'unknown');
});
