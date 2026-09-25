import test from 'node:test';
import assert from 'node:assert/strict';
import { failedRequestDraft, recoveredRequestDraft, initial } from '../../src/ui/model.ts';

test('failed input restoration preserves original basis and settings without request identity or shared mutable references', () => {
  const state = initial();
  state.messages = [
    { id: 'old', request: { result: { hostExecuted: true } } },
    { id: 'latest', request: { result: { hostExecuted: true } } },
  ];
  const request = {
    id: 'failed',
    state: 'interrupted',
    input: {
      id: 'failed',
      body: 'Change this',
      baseRequestId: 'old',
      pins: [{ id: 'one', basis: 'old', role: 'preserve' }],
      sketches: [
        {
          points: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
      files: [{ name: 'context.md', text: 'kept' }],
      host: 'rhino',
      model: 'unavailable-model',
      effort: 'high',
      permission: 'candidate',
    },
  };
  const draft = failedRequestDraft(state, request);
  assert.equal(draft.baseRequestId, 'old');
  assert.equal(draft.model, 'unavailable-model');
  assert.equal(draft.permission, 'candidate');
  assert.equal(draft.id, undefined);
  draft.pins[0].role = 'target';
  assert.equal(request.input.pins[0].role, 'preserve');
  assert.equal(state.body, '');
  assert.throws(() => failedRequestDraft(state, { ...request, state: 'unknown' }));
  assert.throws(() =>
    failedRequestDraft(state, {
      ...request,
      input: { ...request.input, baseRequestId: 'missing' },
    }),
  );
  assert.equal(
    failedRequestDraft(state, { ...request, input: { ...request.input, baseRequestId: undefined } })
      .baseRequestId,
    undefined,
  );
});

test('recovered follow-up keeps conditions and only rebinds proven native identities', () => {
  const state = initial();
  state.messages = [
    {
      id: 'base',
      request: {
        result: { hostExecuted: true, objects: [{ id: 'wall', nativeId: 'native-wall' }] },
      },
    },
  ];
  const request = {
    id: 'recovered',
    state: 'succeeded',
    input: {
      id: 'recovered',
      body: 'Keep wall and resize roof',
      baseRequestId: 'base',
      provider: 'codex-cli',
      permission: 'candidate',
      host: 'rhino',
      pins: [{ id: 'wall', basis: 'base', role: 'preserve' }],
      sketches: [],
      files: [{ name: 'rules', text: 'height 4 m' }],
    },
    result: {
      executionMode: 'sdk',
      recovered: true,
      hostExecuted: true,
      objects: [{ id: 'wall', nativeId: 'native-wall' }],
    },
  };
  const draft = recoveredRequestDraft(state, request);
  assert.equal(draft.baseRequestId, 'recovered');
  assert.deepEqual(draft.pins, [{ id: 'wall', basis: 'recovered', role: 'preserve' }]);
  assert.equal(draft.permission, 'candidate');
  assert.match(draft.body, /Keep wall and resize roof/);
  assert.match(draft.body, /반복하지 말고/);
  assert.equal(request.input.pins[0].basis, 'base');
  draft.files[0].text = 'different';
  assert.equal(request.input.files[0].text, 'height 4 m');
  for (const result of [
    { ...request.result, recovered: false },
    { ...request.result, objects: [] },
    { ...request.result, objects: [{ id: 'wall', nativeId: 'replaced' }] },
  ])
    assert.throws(() => recoveredRequestDraft(state, { ...request, result }));
  assert.throws(() => recoveredRequestDraft(state, { ...request, state: 'unknown' }));
  assert.throws(() =>
    recoveredRequestDraft(state, {
      ...request,
      input: { ...request.input, linkedTargets: [{}, {}] },
    }),
  );
});
