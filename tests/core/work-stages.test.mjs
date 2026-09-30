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

test('each stage shows how long it took; the one in progress counts up to now', async () => {
  const { workStages, formatElapsed } = await import('../../src/ui/work-stages.ts');
  const t0 = Date.parse('2026-09-29T06:00:00.000Z');
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const activity = [
    { kind: 'host', text: '작업 사본 준비', at: at(0.5) },
    { kind: 'thinking', text: '보를 찾는다', at: at(5.2) },
    { kind: 'query', text: '조회', at: at(9) },
  ];
  const running = workStages({
    state: 'running',
    host: 'rhino',
    activity,
    startedAt: t0,
    now: t0 + 12_300,
  });
  const byKey = Object.fromEntries(running.map((stage) => [stage.key, stage.elapsedMs]));
  assert.equal(byKey.prepare, 5200); // received → first AI note
  assert.equal(byKey.understand, 3800); // → first query
  assert.equal(byKey.query, 3300); // in progress: → now
  assert.equal(byKey.execute, undefined);
  assert.equal(byKey.result, undefined);
  // Finished: the last stage ends at the last recorded event.
  const done = workStages({
    state: 'succeeded',
    host: 'rhino',
    activity: [...activity, { kind: 'result', text: '검증', at: at(20) }],
    startedAt: t0,
  });
  assert.equal(done.find((stage) => stage.key === 'verify').elapsedMs, 0);
  assert.equal(done.find((stage) => stage.key === 'query').elapsedMs, 11_000);
  assert.equal(formatElapsed(5200), '5.2s');
  assert.equal(formatElapsed(125_000), '2:05');
});

test('a direct turn has its own stages: no save-and-reopen check, the final answer timed', () => {
  const t0 = Date.parse('2026-09-30T06:00:00.000Z');
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const activity = [
    { kind: 'host', text: '열린 Rhino 문서에 연결 · 자동', at: at(0.1) },
    { kind: 'thinking', text: '벽을 찾는다', at: at(6) },
    { kind: 'query', text: '문서 조회 1회차', at: at(8) },
    { kind: 'thinking', text: '이제 실행', at: at(9) },
    { kind: 'execute', text: 'Rhino 문서에 바로 실행 1회차', at: at(10) },
    { kind: 'result', text: '문서에 반영 · 추가 1 · 수정 0 · 삭제 0 · 되돌리기 1단계', at: at(11) },
    { kind: 'message', text: '정리 중', at: at(14) },
  ];
  const done = workStages({
    state: 'succeeded',
    host: 'rhino',
    direct: true,
    activity,
    maxHostCommands: 12,
    startedAt: t0,
    endedAt: t0 + 20_000,
  });
  assert.equal(
    states(done),
    'prepare:done understand:done query:done execute:done answer:done result:done',
  );
  assert.deepEqual(
    done.map((stage) => stage.label),
    ['준비', '요청 이해', '모델 조회', '실행', '답변 정리', '결과'],
  );
  assert.equal(done[2].detail, '조회 1회'); // the note between tools is not a query
  assert.equal(done[3].detail, '실행 1/12회 · 되돌리기 1단계');
  const ms = Object.fromEntries(done.map((stage) => [stage.key, stage.elapsedMs]));
  assert.equal(ms.prepare, 6000); // received → the model's first note
  assert.equal(ms.understand, 2000);
  assert.equal(ms.query, 2000);
  assert.equal(ms.execute, 1000); // first execute → its host result
  assert.equal(ms.answer, 9000); // last host result → the end of the request
  // While the model writes after the last host result, the answer stage is current.
  const running = workStages({
    state: 'running',
    host: 'rhino',
    direct: true,
    activity,
    startedAt: t0,
    now: t0 + 16_000,
  });
  assert.equal(
    states(running),
    'prepare:done understand:done query:done execute:done answer:active result:pending',
  );
  assert.equal(running[4].elapsedMs, 5000);
  // A direct turn that only reads: no execute, the answer still has its stage.
  const read = workStages({
    state: 'succeeded',
    host: 'rhino',
    direct: true,
    activity: activity.slice(0, 3),
    startedAt: t0,
  });
  assert.equal(
    states(read),
    'prepare:done understand:done query:done execute:skipped answer:done result:done',
  );
  // The work copy path keeps its save-and-reopen check.
  assert.equal(
    workStages({
      state: 'succeeded',
      host: 'rhino',
      activity: events('host', 'execute', 'result'),
    })[4].label,
    '저장·재열기 검증',
  );
});
