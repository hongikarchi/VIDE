import test from 'node:test';
import assert from 'node:assert/strict';
import { linkedRequestDraft, interventionTargetDraft } from '../../src/ui/linked-draft.ts';
import { initial } from '../../src/ui/model.ts';
import { draftSnapshot, restoreDraft } from '../../src/ui/draft-storage.ts';

function fixture() {
  const state = initial();
  const input = {
    body: 'Update both documents',
    host: 'rhino',
    provider: 'codex-cli',
    permission: 'candidate',
    pins: [],
    sketches: [],
    files: [],
  };
  const candidate = (id, host) => ({
    id,
    state: 'succeeded',
    input: { ...input, id, host },
    result: { host, hostExecuted: true, objects: [{ id: 'same-id', nativeId: `${host}-native` }] },
  });
  const a = candidate('a', 'rhino'),
    b = candidate('b', 'zwcad');
  const ca = candidate('ca', 'rhino'),
    cb = candidate('cb', 'zwcad');
  ca.input = { ...ca.input, parentRequestId: 'parent', baseRequestId: 'a' };
  cb.input = { ...cb.input, parentRequestId: 'parent', baseRequestId: 'b' };
  const parent = {
    id: 'parent',
    state: 'failed',
    input: {
      ...input,
      id: 'parent',
      coordinateBasis: 'shared-metre-axes',
      linkedTargets: [
        { baseRequestId: 'a', host: 'rhino' },
        { baseRequestId: 'b', host: 'zwcad' },
      ],
      pins: [
        { id: 'same-id', basis: 'a', role: 'preserve' },
        { id: 'same-id', basis: 'b', role: 'target' },
      ],
      files: [{ name: 'rules', text: 'height 4 m' }],
      executionLimits: { maxHostCommands: 3, maxToolCalls: 8, timeoutSeconds: 60 },
    },
    result: {
      targetResults: [
        { requestId: 'cb', state: 'unknown' },
        { requestId: 'ca', state: 'succeeded' },
      ],
    },
  };
  state.messages = [a, b, ca, cb, parent].map((request) => ({ id: request.id, request }));
  return { state, parent, ca, cb, a };
}

test('linked follow-up uses current verified children and preserves input without mutable aliases', () => {
  const { state, parent } = fixture();
  const draft = linkedRequestDraft(state, parent);
  assert.deepEqual(draft.linkedTargets, [
    { baseRequestId: 'ca', host: 'rhino' },
    { baseRequestId: 'cb', host: 'zwcad' },
  ]);
  assert.equal(draft.baseRequestId, null);
  assert.deepEqual(
    draft.pins.map((p) => [p.basis, p.role]),
    [
      ['ca', 'preserve'],
      ['cb', 'target'],
    ],
  );
  assert.equal(draft.permission, 'candidate');
  assert.equal(draft.executionLimits.maxHostCommands, 3);
  assert.match(draft.body, /반복하지 말고/);
  const restored = restoreDraft(draftSnapshot({ ...state, ...draft }), state.messages);
  assert.deepEqual(restored.linkedTargets, draft.linkedTargets);
  draft.files[0].text = 'changed';
  assert.equal(parent.input.files[0].text, 'height 4 m');
  assert.equal(parent.input.pins[0].basis, 'a');
  assert.equal(state.body, '');
});

test('linked follow-up rejects incomplete state, wrong lineage and unproven identity', () => {
  const mutations = [
    (f) => (f.parent.state = 'running'),
    (f) => (f.cb.state = 'unknown'),
    (f) => (f.cb.state = 'failed'),
    (f) => (f.cb.state = 'running'),
    (f) => (f.cb.result.hostExecuted = false),
    (f) => (f.cb.input.parentRequestId = 'other'),
    (f) => (f.cb.input.baseRequestId = 'a'),
    (f) => (f.cb.result.host = 'rhino'),
    (f) => (f.ca.result.objects[0].nativeId = 'replacement'),
    (f) => (f.ca.result.objects = []),
    (f) => (f.parent.result.targetResults[0].requestId = 'ca'),
    (f) => (f.state.messages = f.state.messages.filter((m) => m.id !== 'a')),
    (f) => (f.parent.input.coordinateBasis = undefined),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.throws(() => linkedRequestDraft(f.state, f.parent), undefined, mutate.toString());
  }
});

test('held linked intervention reuses verified predecessors while retaining revised conditions', () => {
  const { state, parent } = fixture();
  const held = {
    id: 'held',
    state: 'interrupted',
    input: {
      ...structuredClone(parent.input),
      id: 'held',
      supersedesRequestId: parent.id,
      body: parent.input.body + '\nHeight 4.5 m',
    },
    result: { code: 'INTERVENTION_REVIEW_REQUIRED' },
  };
  const draft = linkedRequestDraft(state, held);
  assert.match(draft.body, /Height 4.5 m/);
  assert.deepEqual(
    draft.linkedTargets.map((t) => t.baseRequestId),
    ['ca', 'cb'],
  );
  assert.equal(draft.supersedesRequestId, undefined);
  assert.throws(() =>
    linkedRequestDraft(state, { ...held, input: { ...held.input, permission: 'review' } }),
  );
  parent.state = 'running';
  assert.throws(() => linkedRequestDraft(state, held));
});

test('text-only linked intervention inherits parent targets without changing explicit choices', () => {
  const state = initial();
  const parent = {
    input: {
      linkedTargets: [
        { host: 'rhino', baseRequestId: 'a' },
        { host: 'zwcad', baseRequestId: 'b' },
      ],
      coordinateBasis: 'shared-metre-axes',
    },
  };
  const draft = interventionTargetDraft(state, parent);
  assert.deepEqual(draft.linkedTargets, parent.input.linkedTargets);
  assert.equal(draft.coordinateBasis, 'shared-metre-axes');
  assert.equal(state.linkedTargets, undefined);
  const existing = { ...state, baseRequestId: 'b' };
  assert.deepEqual(
    interventionTargetDraft(existing, { input: { ...parent.input, baseRequestId: 'b' } })
      .linkedTargets,
    parent.input.linkedTargets,
  );
  const other = { ...state, baseRequestId: 'different' };
  assert.equal(interventionTargetDraft(other, parent), other);
  const linked = { ...state, linkedTargets: [...parent.input.linkedTargets].reverse() };
  assert.equal(interventionTargetDraft(linked, parent), linked);
  assert.equal(interventionTargetDraft(state, { input: {} }), state);
  const review = interventionTargetDraft({ ...state, permission: 'review', host: 'zwcad' }, parent);
  assert.equal(review.permission, 'review');
  assert.equal(review.host, 'zwcad');
});
