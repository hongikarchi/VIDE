// A late request action ([진행]·[되돌리기]·[확인함]) on a request that already ended or runs again
// answers 409: the screen re-reads the request and says so, never "다른 화면에서 변경" (SPEC-02.13 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errors, requestAction } from '../../src/ui/gateway.ts';

function stub(t, status, body) {
  const events = [];
  const previous = { fetch: globalThis.fetch, window: globalThis.window };
  globalThis.fetch = async () => ({
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  });
  globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
  globalThis.CustomEvent ??= class {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  t.after(() => {
    globalThis.fetch = previous.fetch;
    globalThis.window = previous.window;
  });
  return events;
}

test('a 409 from a request action re-reads the request and says it already ended', async (t) => {
  const events = stub(t, 409, { code: 'REVISION_CONFLICT' });
  let reread = 0;
  await assert.rejects(
    requestAction('/projects/p/requests/r/confirm', {}, async () => reread++),
    (error) => {
      assert.equal(error.code, 'REQUEST_SETTLED');
      assert.equal(
        error.message,
        '이 작업은 이미 끝났거나 진행 중입니다. 최신 상태로 다시 읽었습니다.',
      );
      assert.doesNotMatch(error.message, /다른 화면/);
      return true;
    },
  );
  assert.equal(reread, 1);
  // No app-wide 'other screen' notice for it.
  assert.deepEqual(events, []);
  assert.match(errors.REVISION_CONFLICT, /다른 화면/);
});

test('other refusals of a request action pass through unchanged', async (t) => {
  const events = stub(t, 404, { code: 'NOT_FOUND' });
  let reread = 0;
  await assert.rejects(
    requestAction('/projects/p/requests/r/undo', { executionId: 'x' }, async () => reread++),
    { code: 'NOT_FOUND' },
  );
  assert.equal(reread, 0);
  assert.deepEqual(events, ['vide:api-error']);
});

test('an answered request action returns its reply', async (t) => {
  stub(t, 200, { ok: true, id: 'r' });
  assert.deepEqual(await requestAction('/projects/p/requests/r/acknowledge', {}, async () => {}), {
    ok: true,
    id: 'r',
  });
});
