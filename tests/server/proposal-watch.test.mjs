// 갱신 제안 (PLAN-54 T-349·T-351, SPEC-05.12): a fake Sync of one side of a designated pair gives one
// card; undesignated files none; the same mismatch again updates that card; [무시] keeps the same
// set quiet until a new row; both sides changed → no card; a closed side → no card, compared once
// when it opens; [적용] goes through the backflow apply (stubbed) and makes one D candidate; a
// remote session cannot write. No host, no SDK: the comparison and the apply are stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProposalWatch } from '../../src/server/proposal-watch.ts';
import { syncPairRoutes } from '../../src/server/sync-pair-routes.ts';
import { attachRecordSources } from '../../src/server/record-sources.ts';
import { candidateFromProposal } from '../../src/core/record-candidates.ts';
import { recordAttachmentsSchema } from '../../src/contracts/records.ts';

const P = 'project-1';
const relation = { rotation: 0, translation: [0, 0], dz: 0, confirmedAt: '2026-10-15T00:00:00Z' };
const pair = {
  id: 'pairaaaaaaaa',
  model: { role: 'rhino', path: 'A.3dm' },
  drawing: { role: 'cad', path: 'A-평면.dwg' },
  relation,
  createdBy: 'user',
  createdAt: '2026-10-15T00:00:00Z',
  absolute: { model: 'C:\\w\\A.3dm', drawing: 'C:\\w\\A-평면.dwg' },
  where: 'manifest',
};
const offsetRow = (id, deviation, handle = '2A') => ({
  id,
  state: 'offset',
  rhino: { id: 'o-' + id, nativeId: 'guid-' + id, layer: '기둥', name: 'C3', type: 'curve' },
  cad: { id: 'e-' + id, nativeId: handle, layer: 'COL', type: 'LINE' },
  deviation,
  ends: {
    rhino: [
      [0, 0, 0],
      [1, 0, 0],
    ],
    cad: [
      [0.5, 0, 0],
      [1.5, 0, 0],
    ],
  },
  inRhino: [
    [0.5, 0, 0],
    [1.5, 0, 0],
  ],
});

function harness(overrides = {}) {
  const state = {
    rows: [offsetRow('R1', 0.5)],
    open: { model: true, drawing: true },
    busy: false,
    syncs: { model: 'sync-m1', drawing: 'sync-d1' },
    dismissed: {},
    applied: [],
    records: [],
    pairs: [pair],
  };
  const watch = new ProposalWatch({
    pairs: async () => state.pairs,
    sides: async () => ({
      model: { exists: true, linkId: 'link-m', syncId: state.syncs.model },
      drawing: { exists: true, linkId: 'link-d', syncId: state.syncs.drawing },
    }),
    open: async (_p, linkId) => ({
      open: linkId === 'link-m' ? state.open.model : state.open.drawing,
      busy: state.busy,
    }),
    compute: () => ({
      rows: [
        { id: 'R9', state: 'match', rhino: { id: 'x', nativeId: 'x', layer: 'a', type: 'curve' } },
        ...state.rows,
      ],
      layers: [{ rhino: '기둥', cad: 'COL', pairs: 3 }],
    }),
    linkOf: (_p, requestId) => (requestId === 'sync-m1' ? 'link-m' : undefined),
    dismissed: {
      read: async () => structuredClone(state.dismissed),
      write: async (_p, value) => void (state.dismissed = value),
    },
    apply: async (_p, input) => {
      state.applied.push(input);
      return { state: 'applied', id: 'a'.repeat(24), files: [] };
    },
    record: (event) => state.records.push(event),
    quietMs: 0,
    defer: (task) => task(),
    ...overrides,
  });
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await watch.idle();
  };
  return { watch, state, settle };
}

test('a Sync of one side of a designated pair gives one card; its rows are the mismatches', async () => {
  const { watch, settle } = harness();
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  const cards = watch.proposals(P);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].changedSide, 'model');
  assert.equal(cards[0].rows.length, 1);
  assert.equal(cards[0].rows[0].id, 'R1');
  assert.deepEqual(cards[0].names, { model: 'A.3dm', drawing: 'A-평면.dwg' });
  // The overlay: the drawing now (in model coordinates) and the model's line after.
  assert.deepEqual(cards[0].rows[0].overlay.now[0], [0.5, 0, 0]);
  assert.deepEqual(cards[0].rows[0].overlay.after[1], [1, 0, 0]);
  // A request id alone finds its link.
  const second = harness();
  second.watch.notifySynced({ projectId: P, requestId: 'sync-m1', kind: 'manual' });
  await second.settle();
  assert.equal(second.watch.proposals(P).length, 1);
});

test('files that are not a designated pair give no card', async () => {
  const { watch, settle } = harness();
  watch.notifySynced({ projectId: P, linkId: 'link-other', kind: 'live' });
  await settle();
  assert.equal(watch.proposals(P).length, 0);
  const none = harness();
  none.state.pairs = [];
  none.watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await none.settle();
  assert.equal(none.watch.proposals(P).length, 0);
});

test('the same pair changing again updates its one card; matched by hand closes it', async () => {
  const { watch, state, settle } = harness();
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  const first = watch.proposals(P)[0];
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  assert.equal(watch.proposals(P).length, 1);
  assert.equal(watch.proposals(P)[0].id, first.id);
  state.rows = [offsetRow('R1', 0.9)];
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  assert.equal(watch.proposals(P).length, 1);
  assert.equal(watch.proposals(P)[0].id, first.id);
  assert.equal(watch.proposals(P)[0].rows[0].deviation, 0.9);
  state.rows = [];
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  assert.equal(watch.proposals(P).length, 0);
});

test('[무시] keeps the same set quiet; a new mismatch shows the card again', async () => {
  const { watch, state, settle } = harness();
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  const card = watch.proposals(P)[0];
  await watch.dismiss(P, card.id);
  assert.equal(watch.proposals(P).length, 0);
  assert.equal(state.dismissed[pair.id].rowKeys.length, 1);
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  assert.equal(watch.proposals(P).length, 0);
  state.rows = [offsetRow('R1', 0.5), offsetRow('R2', 0.2, '2B')];
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  assert.equal(watch.proposals(P).length, 1);
  // [무시] is a D candidate.
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].action, 'dismiss');
});

test('[나중에] folds the card until the pair changes again', async () => {
  const { watch, settle } = harness();
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  watch.later(P, watch.proposals(P)[0].id);
  assert.equal(watch.proposals(P).length, 0);
  await watch.reopened(P);
  assert.equal(watch.proposals(P).length, 0);
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  assert.equal(watch.proposals(P).length, 1);
});

test('both sides changed: no card and the pair shows it', async () => {
  const { watch, settle } = harness();
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  assert.equal(watch.proposals(P).length, 1);
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  watch.notifySynced({ projectId: P, linkId: 'link-d', kind: 'live' });
  await settle();
  assert.equal(watch.proposals(P).length, 0);
  assert.equal((await watch.status(P, pair)).status, 'both-changed');
});

test('a closed side: no card, compared once when it opens again', async () => {
  const { watch, state, settle } = harness();
  state.open.drawing = false;
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  assert.equal(watch.proposals(P).length, 0);
  assert.equal((await watch.status(P, pair)).status, 'link-closed');
  state.open.drawing = true;
  await watch.reopened(P);
  assert.equal(watch.proposals(P).length, 1);
});

test('[적용] computes again, calls the backflow apply once and makes one D candidate', async () => {
  const { watch, state, settle } = harness();
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  const card = watch.proposals(P)[0];
  const answer = await watch.apply(P, card.id);
  assert.equal(answer.result.state, 'applied');
  assert.equal(answer.proposal, null);
  assert.equal(state.applied.length, 1);
  assert.deepEqual(state.applied[0].rows, [
    { id: 'R1', state: 'offset', rhino: 'guid-R1', cad: '2A' },
  ]);
  assert.equal(state.applied[0].rhino, 'sync-m1');
  assert.equal(state.applied[0].cad, 'sync-d1');
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].action, 'apply');
  assert.equal(state.records[0].applyId, 'a'.repeat(24));
  // The drawing's Sync after our own apply is not a new 'drawing changed' card.
  watch.notifySynced({ projectId: P, linkId: 'link-d', kind: 'live' });
  await settle();
  const after = watch.proposals(P);
  assert.ok(after.every((entry) => entry.changedSide === 'model'));
});

test('[적용] without chosen rows leaves a deletion (CAD에만) out; chosen, it goes (SPEC-14.10 3)', async () => {
  const { watch, state, settle } = harness();
  state.rows = [
    offsetRow('R1', 0.5),
    {
      id: 'R2',
      state: 'cad-only',
      cad: { id: 'e-R2', nativeId: '2B', layer: 'COL', type: 'LINE' },
      length: 1,
    },
  ];
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  const card = watch.proposals(P)[0];
  assert.equal(card.rows.length, 2);
  await watch.apply(P, card.id);
  assert.deepEqual(
    state.applied[0].rows.map((row) => row.id),
    ['R1'],
  );
  const again = harness();
  again.state.rows = state.rows;
  again.watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await again.settle();
  await again.watch.apply(P, again.watch.proposals(P)[0].id, { rows: ['R1', 'R2'] });
  assert.deepEqual(
    again.state.applied[0].rows.map((row) => row.id),
    ['R1', 'R2'],
  );
});

test('[적용] refuses a changed list, a closed side, a busy host and the drawing direction', async () => {
  const stale = harness();
  stale.watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await stale.settle();
  const card = stale.watch.proposals(P)[0];
  stale.state.rows = [offsetRow('R1', 0.7)];
  await assert.rejects(stale.watch.apply(P, card.id), (error) => {
    assert.equal(error.code, 'PROPOSAL_STALE');
    assert.equal(error.proposal.rows[0].deviation, 0.7);
    return true;
  });
  assert.equal(stale.state.applied.length, 0);
  stale.state.busy = true;
  await assert.rejects(stale.watch.apply(P, card.id), { code: 'HOST_BUSY' });
  stale.state.busy = false;
  stale.state.open.drawing = false;
  await assert.rejects(stale.watch.apply(P, card.id), { code: 'PAIR_LINK_CLOSED' });
  await assert.rejects(stale.watch.apply(P, 'ffffffffffff'), { code: 'PROPOSAL_NOT_FOUND' });
  const drawing = harness();
  drawing.watch.notifySynced({ projectId: P, linkId: 'link-d', kind: 'live' });
  await drawing.settle();
  const other = drawing.watch.proposals(P)[0];
  assert.equal(other.changedSide, 'drawing');
  await assert.rejects(drawing.watch.apply(P, other.id), { code: 'PROPOSAL_DIRECTION_PENDING' });
  // A closed connection reported by the backflow apply is the card's '연결이 닫혔습니다'.
  const closed = harness({
    apply: async () => {
      const error = new Error('x');
      error.code = 'ZWCAD_ATTACHED_EDIT_UNAVAILABLE';
      Object.setPrototypeOf(
        error,
        (await import('../../src/contracts/errors.ts')).DomainError.prototype,
      );
      throw error;
    },
  });
  closed.watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await closed.settle();
  await assert.rejects(closed.watch.apply(P, closed.watch.proposals(P)[0].id), {
    code: 'PAIR_LINK_CLOSED',
  });
});

test('a failing comparison shows no card and the pair shows the error', async () => {
  const { watch, settle } = harness({
    compute: () => {
      throw Object.assign(new Error('STALE_REFERENCE'), { code: 'STALE_REFERENCE' });
    },
  });
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  assert.equal(watch.proposals(P).length, 0);
  assert.equal((await watch.status(P, pair)).status, 'error');
});

test('routes: a remote session reads only; GET lists cards', async () => {
  const { watch, settle } = harness();
  watch.notifySynced({ projectId: P, linkId: 'link-m', kind: 'live' });
  await settle();
  const sent = [];
  const deps = (remote, body = {}) => ({
    pairs: { list: async () => [pair] },
    watch,
    project: () => ({}),
    body: async () => body,
    send: (status, value) => sent.push({ status, value }),
    noContent: () => sent.push({ status: 204 }),
    remote,
    prepare: async () => ({ compared: false }),
  });
  const at = (path) => new URL('http://x/api/v1/projects/' + P + path);
  assert.equal(await syncPairRoutes(at('/proposals'), 'GET', deps(true)), true);
  assert.equal(sent.at(-1).value.proposals.length, 1);
  assert.equal(await syncPairRoutes(at('/workspace/pairs'), 'GET', deps(true)), true);
  assert.equal(sent.at(-1).value.pairs[0].status, 'ok');
  assert.equal(sent.at(-1).value.pairs[0].names.drawing, 'A-평면.dwg');
  const id = watch.proposals(P)[0].id;
  for (const action of ['apply', 'dismiss', 'later'])
    await assert.rejects(syncPairRoutes(at(`/proposals/${id}/${action}`), 'POST', deps(true)), {
      code: 'FORBIDDEN',
    });
  await assert.rejects(
    syncPairRoutes(
      at('/workspace/pairs'),
      'POST',
      deps(true, { model: 'C:\\a', drawing: 'C:\\b' }),
    ),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    syncPairRoutes(
      at('/workspace/pairs'),
      'POST',
      deps(false, { model: 'C:\\w\\A.3dm', drawing: 'C:\\w\\B.dwg' }),
    ),
    { code: 'PAIR_NOT_COMPARED' },
  );
  assert.equal(await syncPairRoutes(at('/other'), 'GET', deps(false)), false);
});

test('[적용]·[무시] candidates are D, source sync, keyed by the card', async () => {
  const event = {
    projectId: P,
    action: 'apply',
    proposalId: 'abcdefabcdef',
    pairId: pair.id,
    names: { model: 'A.3dm', drawing: 'A-평면.dwg' },
    rows: ['R1', 'R2'],
    objects: ['guid-R1'],
    applyId: 'a'.repeat(24),
    at: '2026-10-15T05:00:00Z',
  };
  const candidate = candidateFromProposal(event);
  assert.equal(candidate.type, 'D');
  assert.equal(candidate.source, 'sync');
  assert.equal(candidate.sourceKey, 'proposal:abcdefabcdef:apply');
  assert.match(candidate.text, /A\.3dm ↔ A-평면\.dwg/);
  assert.ok(recordAttachmentsSchema.safeParse(candidate.attachments).success);
  const added = [];
  const sources = attachRecordSources({
    records: {
      add: (projectId, input, options) => added.push({ projectId, input, options }),
      list: () => ({ total: 0, records: [] }),
      parts: () => [],
      bySourceKey: () => null,
    },
    log: () => {},
    defer: (task) => task(),
  });
  sources.proposalAction(event);
  await sources.idle();
  assert.equal(added.length, 1);
  assert.equal(added[0].options.by, 'ai');
  assert.equal(added[0].options.state, 'candidate');
  assert.equal(added[0].options.source, 'sync');
  assert.equal(added[0].input.attachments.applyId, 'a'.repeat(24));
});

test('engine: pairs and cards answer through the server; an uncompared pair is refused', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startServer } = await import('../../src/server/server.ts');
  const directory = await mkdtemp(join(tmpdir(), 'vide-proposals-'));
  const app = await startServer({ filename: join(directory, 'store.sqlite') });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const headers = {
    Origin: app.origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const api = async (path, method = 'GET', value) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: value ? JSON.stringify(value) : undefined,
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const project = (await api('/projects', 'POST', { name: '쌍' })).json;
  assert.deepEqual((await api(`/projects/${project.id}/workspace/pairs`)).json, { pairs: [] });
  assert.deepEqual((await api(`/projects/${project.id}/proposals`)).json, { proposals: [] });
  const refused = await api(`/projects/${project.id}/workspace/pairs`, 'POST', {
    model: join(directory, 'A.3dm'),
    drawing: join(directory, 'A.dwg'),
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'PAIR_NOT_COMPARED');
  const missing = await api(`/projects/${project.id}/proposals/abcdefabcdef/later`, 'POST', {});
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'PROPOSAL_NOT_FOUND');
});
