import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRoute } from '../../src/ai/request-router.ts';

const subjects = [
  { id: 'kind:문자', label: '문자 (text annotations), 3 objects' },
  { id: 'layer:A-WALL', label: 'layer "A-WALL", 2 objects' },
];
const reply = (answers) => async (_url, init) => {
  reply.sent = JSON.parse(init.body);
  return Response.json({ answers });
};

test('Jev decides view actions and objects; the file words decide file work without a call', async () => {
  const view = await decideRoute(
    { body: '벽만 보여줘', subjects },
    {
      key: () => 'k',
      fetchImpl: reply({
        target: { choice: 'view', confidence: 0.99 },
        action: { choice: 'isolate', confidence: 0.9 },
        subject: { choice: 's1', confidence: 0.9 },
      }),
    },
  );
  assert.deepEqual([view.target, view.action, view.subject], ['view', 'isolate', 'layer:A-WALL']);
  assert.match(reply.sent.questions.subject.criteria.s0, /문자/);
  assert.ok(reply.sent.questions.subject.criteria.none);
  const file = await decideRoute(
    { body: '보 단면 바꿔줘', subjects },
    { key: () => 'k', fetchImpl: reply({ target: { choice: 'document', confidence: 0.95 } }) },
  );
  assert.equal(file.target, 'document');
  let called = false;
  const named = await decideRoute(
    { body: 'CAD에서 해치 숨겨줘', subjects },
    { key: () => 'k', fetchImpl: async () => ((called = true), Response.json({})) },
  );
  assert.equal(named.target, 'document');
  assert.equal(called, false);
});

test('no key, an unsure answer, an unknown action or a failure leaves it to the rules', async () => {
  assert.equal(await decideRoute({ body: '숨겨', subjects }, { key: () => '' }), undefined);
  assert.equal(
    await decideRoute(
      { body: '숨겨', subjects },
      { key: () => 'k', fetchImpl: reply({ target: { choice: 'view', confidence: 0.4 } }) },
    ),
    undefined,
  );
  assert.equal(
    await decideRoute(
      { body: '숨겨', subjects },
      {
        key: () => 'k',
        fetchImpl: reply({
          target: { choice: 'view', confidence: 0.9 },
          action: { choice: 'paint' },
        }),
      },
    ),
    undefined,
  );
  assert.equal(
    await decideRoute(
      { body: '숨겨', subjects },
      { key: () => 'k', fetchImpl: async () => new Response('x', { status: 500 }) },
    ),
    undefined,
  );
  assert.equal(
    await decideRoute(
      { body: '숨겨', subjects },
      {
        key: () => 'k',
        fetchImpl: async () => {
          throw new Error('offline');
        },
      },
    ),
    undefined,
  );
});
