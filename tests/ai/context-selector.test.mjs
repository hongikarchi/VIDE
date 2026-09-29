import test from 'node:test';
import assert from 'node:assert/strict';
import { selectContext } from '../../src/ai/context-selector.ts';

const history = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: 'r' + i, request: '요청 ' + i, response: '답 ' + i }));

test('six or fewer earlier exchanges all go, without calling Jev', async () => {
  const called = [];
  const choice = await selectContext('보 단면 바꿔줘', history(5), {
    key: () => 'k',
    fetchImpl: async () => called.push(1),
  });
  assert.deepEqual(choice.ids, ['r0', 'r1', 'r2', 'r3', 'r4']);
  assert.equal(choice.by, 'all');
  assert.equal(called.length, 0);
});

test('Jev picks related exchanges; the latest always goes; order is kept', async () => {
  let sent;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    // 30 earlier exchanges: the window is the last 20 (r10..r29 → c0..c19).
    return Response.json({
      answers: {
        c2: { noul: 0.9 }, // r12
        c5: { noul: 0.7 }, // r15
        c6: { noul: 0.3 }, // r16: below the bar
        c11: { noul: 0.8 }, // r21
      },
    });
  };
  const choice = await selectContext('아까 그 보 다시 옮겨줘', history(30), {
    key: () => 'k',
    fetchImpl,
  });
  assert.equal(choice.by, 'jev');
  assert.deepEqual(choice.ids, ['r12', 'r15', 'r21', 'r29']);
  assert.equal(Object.keys(sent.questions).length, 20);
  assert.match(sent.state, /아까 그 보 다시 옮겨줘/);
  assert.match(sent.questions.c0.instructions, /요청 10/);
});

test('at most six go, highest fit first', async () => {
  const answers = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [`c${i}`, { noul: 0.5 + i / 100 }]),
  );
  const choice = await selectContext('x', history(20 + 3), {
    key: () => 'k',
    fetchImpl: async () => Response.json({ answers }),
  });
  assert.equal(choice.ids.length, 6);
  assert.deepEqual(choice.ids, ['r17', 'r18', 'r19', 'r20', 'r21', 'r22']);
});

test('no key, HTTP failure or an error keeps the last six', async () => {
  const last = ['r4', 'r5', 'r6', 'r7', 'r8', 'r9'];
  const none = await selectContext('x', history(10), { key: () => '' });
  assert.deepEqual([none.ids, none.by, none.reason], [last, 'fallback', 'NO_KEY']);
  const failed = await selectContext('x', history(10), {
    key: () => 'k',
    fetchImpl: async () => new Response('busy', { status: 529 }),
  });
  assert.deepEqual([failed.ids, failed.reason], [last, 'HTTP_529']);
  const thrown = await selectContext('x', history(10), {
    key: () => 'k',
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.deepEqual([thrown.ids, thrown.reason], [last, 'ERROR']);
});
