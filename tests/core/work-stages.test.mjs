import test from 'node:test';
import assert from 'node:assert/strict';
import { workStages } from '../../src/ui/work-stages.ts';

const states = (stages) => stages.map((stage) => stage.key + ':' + stage.state).join(' ');
const events = (...kinds) => kinds.map((kind) => ({ kind, text: kind }));

test('a running host request shows the stage of its latest event and real counts', () => {
  const stages = workStages({
    state: 'running',
    host: 'rhino',
    activity: events('host', 'model', 'thinking', 'query', 'query', 'execute', 'error', 'execute'),
    maxHostCommands: 12,
  });
  assert.equal(
    states(stages),
    'prepare:done understand:done query:done execute:active verify:pending result:pending',
  );
  assert.equal(stages[2].detail, '조회 2회');
  assert.equal(stages[3].detail, '실행 2/12회 · 오류 1회 (AI가 고쳐 다시 시도)');
});

test('querying again after a verified write marks the query stage as current', () => {
  const stages = workStages({
    state: 'running',
    host: 'rhino',
    activity: events('host', 'query', 'execute', 'result', 'query'),
  });
  assert.equal(
    states(stages),
    'prepare:done understand:done query:active execute:done verify:done result:pending',
  );
});

test('a finished review request skips the stages that did not happen', () => {
  const stages = workStages({
    state: 'succeeded',
    host: 'rhino',
    activity: events('host', 'model', 'query'),
  });
  assert.equal(
    states(stages),
    'prepare:done understand:done query:done execute:skipped verify:skipped result:done',
  );
});

test('a failure is shown at the stage where it stopped', () => {
  const stages = workStages({
    state: 'failed',
    host: 'rhino',
    activity: events('host', 'query', 'execute', 'error'),
  });
  assert.equal(
    states(stages),
    'prepare:done understand:done query:done execute:failed verify:skipped result:failed',
  );
});

test('queued work, progress counts without activity, questions and Syncs', () => {
  assert.match(
    states(workStages({ state: 'queued', host: 'rhino', activity: [] })),
    /^prepare:pending/,
  );
  const cad = workStages({
    state: 'running',
    host: 'zwcad',
    phase: 'host',
    activity: [],
    progress: { queries: 3, attempts: 1, completed: 1 },
  });
  assert.equal(cad[4].detail, '검증 성공 1회');
  assert.equal(cad[4].state, 'active');
  assert.equal(
    states(workStages({ state: 'succeeded', jig: 'sync-review', host: 'rhino', activity: [] })),
    'model:done result:done',
  );
  assert.equal(
    states(workStages({ state: 'running', source: 'document', host: 'rhino', activity: [] })),
    'capture:active result:pending',
  );
});
