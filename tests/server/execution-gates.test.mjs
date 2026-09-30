// Jig review gates (SPEC-06.9, RESEARCH-05 `ref-whitelist`): the gate module and its use from a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';
import { jigCheck } from '../../src/server/jig-gates.ts';

const draftSummary = JSON.stringify({
  counts: { column: 2, girder: 1 },
  assumedMembers: [
    { id: 'M1', role: 'column' },
    { id: 'M2', role: 'column' },
    { id: 'M3', role: 'girder' },
  ],
  issues: [{ level: 'warning', code: 'NEAR_NODES', message: 'N4와 N5가 가까움' }],
});
const structureInput = (jig = { kind: 'structure-draft-review' }) => ({
  jig,
  files: [{ name: 'structure-draft.json', text: draftSummary }],
});

test('sync-review keeps its row whitelist and warning', () => {
  const input = { jig: { kind: 'sync-review', rows: ['R1', 'R2'] } };
  assert.deepEqual(jigCheck(input, 'R1과 R2는 같다'), {
    jigCheck: { gate: 'ref-whitelist', kind: 'sync-review', cited: 2, unknown: [] },
  });
  const out = jigCheck(input, 'R1, R9 확인');
  assert.deepEqual(out.jigCheck.unknown, ['R9']);
  assert.match(out.text, /표에 없는 행 R9/);
});

test('structure-draft-review cites only members and nodes of the attached draft', () => {
  const ok = jigCheck(structureInput(), 'M1·M3 단면을 H-400x200x8x13으로, N4와 N5를 병합');
  assert.deepEqual(ok.jigCheck, {
    gate: 'ref-whitelist',
    kind: 'structure-draft-review',
    cited: 4,
    unknown: [],
  });
  assert.equal(ok.text, undefined, 'a clean answer is passed unchanged');
  const bad = jigCheck(structureInput(), 'M1은 괜찮고 M42와 N99가 문제입니다. M42를 바꾸세요.');
  assert.deepEqual(bad.jigCheck.unknown, ['M42', 'N99']);
  assert.match(bad.text, /^M1은 괜찮고/);
  assert.match(bad.text, /표에 없는 부재·절점 M42, N99/);
});

test('an explicit refs list wins over the attachment', () => {
  const out = jigCheck(structureInput({ kind: 'structure-draft-review', refs: ['M7'] }), 'M7, M1');
  assert.deepEqual(out.jigCheck.unknown, ['M1']);
});

test('no table, other kinds and malformed jigs pass without a gate', () => {
  assert.deepEqual(jigCheck({ jig: { kind: 'structure-draft-review' } }, 'M1'), {});
  assert.deepEqual(jigCheck({ jig: { kind: 'input-roles', roles: [] } }, 'M1 R1'), {});
  assert.deepEqual(jigCheck({ jig: { kind: 'sync-review', rows: 'R1' } }, 'R1'), {});
  assert.deepEqual(jigCheck({}, 'R1'), {});
  // Words that only contain the pattern are not ids.
  assert.equal(jigCheck(structureInput(), 'SM355 강종, HM1 표기').jigCheck.cited, 0);
});

test('a structure draft review run stores the gate result with the answer', async () => {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('test');
  const execution = new Execution(workspace, {
    // A stub provider: no CLI runs.
    providerFactory: () => ({
      run: async () => ({
        text: JSON.stringify({ message: 'M2를 거더로, M77은 삭제', operations: [] }),
      }),
    }),
  });
  const request = workspace.submit(project.id, {
    id: 'structure-review',
    body: '구조 분석 jig 초안을 검토해 줘',
    provider: 'claude-cli',
    permission: 'review',
    pins: [],
    sketches: [],
    ...structureInput(),
  }).request;
  execution.start(request);
  await Promise.all([...execution.active.values()].map((item) => item.completion));
  const done = workspace.get(project.id, request.id);
  assert.equal(done.state, 'succeeded', JSON.stringify(done.result));
  assert.deepEqual(done.result.jigCheck.unknown, ['M77']);
  assert.match(done.result.text, /표에 없는 부재·절점 M77/);
});
