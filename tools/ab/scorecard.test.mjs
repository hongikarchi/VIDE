// node --test tools/ab/scorecard.test.mjs — verdicts of the verify-loop scorecard on fabricated runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildScorecard, median, readPersona, slowestStage, writeScorecard } from './scorecard.mjs';

const script = fileURLToPath(new URL('./scorecard.mjs', import.meta.url));

/** A route-only attempt as tools/ab/run.mjs writes it. */
const routeRecord = (
  id,
  { target = 'jig', jig = 'vide/site-model', ok = true, ms = 800, ...rest } = {},
) => ({
  id,
  title: id,
  body: id + ' 문장',
  kind: 'route-only',
  host: null,
  attempt: 1,
  repeat: 1,
  alertMs: 10000,
  expectedFail: false,
  expectChange: false,
  requestId: null,
  ms,
  state: 'route-only',
  route: { target, jig, by: 'jev', reason: null, ms },
  stages: null,
  end: null,
  activityTail: [],
  crashes: 0,
  runStatus: 'completed',
  joinedStages: true,
  checks: [
    { type: 'route', ok, detail: ok ? `${target} ${jig}` : `expected jig x, got ${target}` },
  ],
  success: ok,
  executions: [],
  changes: null,
  answer: null,
  ...rest,
});
const stages = (totalMs, extra = {}) => ({
  queuedMs: 5,
  providerMs: 1000,
  spawnMs: 1500,
  firstOutputMs: 4000,
  firstToolMs: 5000,
  lastToolMs: 9000,
  answerMs: 2000,
  totalMs,
  queries: 2,
  executes: 1,
  ...extra,
});
/** A request attempt that changed one object and was reverted. */
const requestRecord = (attempt, rest = {}) => ({
  ...routeRecord('R1-COLOR'),
  kind: 'request',
  host: 'rhino',
  attempt,
  repeat: 3,
  alertMs: 30000,
  expectChange: true,
  requestId: 'req-' + attempt,
  ms: 12000,
  state: 'succeeded',
  route: { target: 'document', jig: null, by: 'jev', reason: null, ms: 300 },
  stages: stages(11000),
  end: { state: 'succeeded', code: null },
  activityTail: [{ kind: 'tool' }, { kind: 'answer' }],
  checks: [
    { type: 'added', ok: true, detail: 'added 0' },
    { type: 'modifiedMin', ok: true, detail: 'modified 1' },
  ],
  executions: [{ state: 'applied', changes: { added: 0, changed: 1, removed: 0 } }],
  changes: { added: 0, removed: 0, modified: 1 },
  restored: { added: 0, removed: 0, modified: 0 },
  undo: [{ executionId: 'e', ok: true }],
  answer: '기둥 1개를 빨간색으로 바꿨습니다.',
  ...rest,
});
const runOf = (results) => ({
  startedAt: '2026-10-08T00:00:00.000Z',
  endedAt: '2026-10-08T00:10:00.000Z',
  plan: 'tools/ab/scenarios-round1.json',
  engineKind: 'dev',
  engine: 'http://127.0.0.1:50000',
  logsDir: 'x',
  results,
});
const persona = (scenario, rest = {}) => ({
  scenario,
  status: 'completed',
  canary: { asked: true, answeredUnknown: true },
  steps: 4,
  stuck: 0,
  wrongClicks: 0,
  unknownWords: [],
  bannedWords: [],
  requestIds: [],
  typedInputs: 1,
  reachedGoal: null,
  dir: 'p-' + scenario,
  ...rest,
});
const verdictOf = (card, id) => card.scenarios.find((s) => s.id === id).verdict;

test('completed route-only scenario passes; a route mismatch is P0', () => {
  const card = buildScorecard(
    runOf([routeRecord('R1-B'), routeRecord('R1-C', { jig: 'sync', ok: false })]),
  );
  assert.equal(verdictOf(card, 'R1-B'), 'PASS');
  assert.equal(verdictOf(card, 'R1-C'), 'P0');
  assert.match(card.scenarios[1].reasons[0], /경로 불일치/);
  assert.equal(card.summary.passRate, 0.5);
});

test('expectedFail is honoured, and a crash is still P0 under expectedFail', () => {
  const mismatch = (attempt, rest = {}) =>
    routeRecord('R1-A', {
      target: 'document',
      jig: null,
      ok: false,
      expectedFail: true,
      attempt,
      repeat: 3,
      ...rest,
    });
  let card = buildScorecard(runOf([mismatch(1), mismatch(2), mismatch(3)]));
  assert.equal(verdictOf(card, 'R1-A'), 'EXPECTED-FAIL');
  assert.equal(card.summary.counts['EXPECTED-FAIL'], 1);
  assert.equal(card.summary.denominator, 0);
  assert.equal(card.summary.passRate, null);
  card = buildScorecard(runOf([mismatch(1), mismatch(2, { crashes: 1 })]));
  assert.equal(verdictOf(card, 'R1-A'), 'P0');
  // Expected to fail but now routed right: passes, with a note to drop expectedFail.
  card = buildScorecard(runOf([routeRecord('R1-A', { jig: 'sync', expectedFail: true })]));
  assert.equal(verdictOf(card, 'R1-A'), 'PASS');
  assert.match(card.scenarios[0].note, /expectedFail/);
});

test('misreport M1 (succeeded but last activity is an error) is P0', () => {
  const card = buildScorecard(
    runOf([
      requestRecord(1, { activityTail: [{ kind: 'tool' }, { kind: 'error', code: 'HOST_GONE' }] }),
    ]),
  );
  assert.equal(verdictOf(card, 'R1-COLOR'), 'P0');
  assert.deepEqual(card.scenarios[0].misreport.flags, ['M1']);
});

test('a request that did not succeed or failed a result check is P0', () => {
  let card = buildScorecard(runOf([requestRecord(1, { state: 'failed' })]));
  assert.equal(verdictOf(card, 'R1-COLOR'), 'P0');
  card = buildScorecard(
    runOf([
      requestRecord(1, { checks: [{ type: 'modifiedMin', ok: false, detail: 'modified 0' }] }),
    ]),
  );
  assert.equal(verdictOf(card, 'R1-COLOR'), 'P0');
});

test('median over the alert line is P1 (route ms for route-only, totalMs for requests)', () => {
  let card = buildScorecard(runOf([routeRecord('R1-D', { jig: 'vide/x', ms: 12000 })]));
  assert.equal(verdictOf(card, 'R1-D'), 'P1');
  card = buildScorecard(
    runOf([
      requestRecord(1, { stages: stages(20000) }),
      requestRecord(2, { stages: stages(40000) }),
      requestRecord(3, { stages: stages(35000) }),
    ]),
  );
  assert.equal(verdictOf(card, 'R1-COLOR'), 'P1');
  assert.equal(card.scenarios[0].medianMs, 35000);
});

test('persona banned words are P2; a stuck persona is P0', () => {
  let card = buildScorecard(runOf([routeRecord('R1-B')]), [
    persona('R1-B', { bannedWords: ['SPEC-'] }),
  ]);
  assert.equal(verdictOf(card, 'R1-B'), 'P2');
  card = buildScorecard(runOf([routeRecord('R1-B')]), [persona('R1-B', { stuck: 1 })]);
  assert.equal(verdictOf(card, 'R1-B'), 'P0');
  // A persona that did not complete (canary failed) does not count either way.
  card = buildScorecard(runOf([routeRecord('R1-B')]), [
    persona('R1-B', { status: 'untested', stuck: 3, reason: 'canary' }),
  ]);
  assert.equal(verdictOf(card, 'R1-B'), 'PASS');
  assert.match(card.scenarios[0].untested.join(), /페르소나 untested/);
  // A persona-only scenario has no result evidence: never PASS.
  card = buildScorecard(runOf([]), [persona('R1-HIDE')]);
  assert.equal(verdictOf(card, 'R1-HIDE'), 'untested');
});

test('persona stuck marks: two flagged steps are P0, one is not (T-278)', () => {
  let card = buildScorecard(runOf([routeRecord('R1-C')]), [persona('R1-C', { stuckFlagged: 5 })]);
  assert.equal(verdictOf(card, 'R1-C'), 'P0');
  assert.match(card.scenarios[0].reasons.join(), /막힘 표시 5단계/);
  card = buildScorecard(runOf([routeRecord('R1-C')]), [persona('R1-C', { stuckFlagged: 1 })]);
  assert.equal(verdictOf(card, 'R1-C'), 'PASS');
  // stuck (declared + no-progress pairs) stays P0 on its own.
  card = buildScorecard(runOf([routeRecord('R1-C')]), [
    persona('R1-C', { stuck: 1, stuckDeclared: 0, noProgressPairs: 1 }),
  ]);
  assert.equal(verdictOf(card, 'R1-C'), 'P0');
});

test('persona-only scenario: PASS only with the operator goalReached true (T-278)', () => {
  // Not reached (null) is untested, and the P2 words go into the reasons.
  let card = buildScorecard(runOf([]), [persona('R1-HIDE', { unknownWords: ['Sync'] })]);
  assert.equal(verdictOf(card, 'R1-HIDE'), 'untested');
  assert.match(card.scenarios[0].reasons.join(), /goalReached 미기입/);
  card = buildScorecard(runOf([]), [persona('R1-HIDE', { goalReached: true })]);
  assert.equal(verdictOf(card, 'R1-HIDE'), 'PASS');
  card = buildScorecard(runOf([]), [
    persona('R1-HIDE', { goalReached: true, unknownWords: ['Sync'] }),
  ]);
  assert.equal(verdictOf(card, 'R1-HIDE'), 'P2');
  // Reached but stuck, or banned words: never PASS.
  card = buildScorecard(runOf([]), [persona('R1-HIDE', { goalReached: true, stuck: 1 })]);
  assert.equal(verdictOf(card, 'R1-HIDE'), 'P0');
  card = buildScorecard(runOf([]), [
    persona('R1-HIDE', { goalReached: true, bannedWords: ['세션'] }),
  ]);
  assert.equal(verdictOf(card, 'R1-HIDE'), 'P2');
  // The operator marked it not reached: P0, also beside a runner record.
  card = buildScorecard(runOf([]), [persona('R1-HIDE', { goalReached: false })]);
  assert.equal(verdictOf(card, 'R1-HIDE'), 'P0');
  card = buildScorecard(runOf([routeRecord('R1-B')]), [persona('R1-B', { goalReached: false })]);
  assert.equal(verdictOf(card, 'R1-B'), 'P0');
  // One of two runs without a verdict: not a pass.
  card = buildScorecard(runOf([]), [
    persona('R1-HIDE', { goalReached: true }),
    persona('R1-HIDE', { dir: 'p2' }),
  ]);
  assert.equal(verdictOf(card, 'R1-HIDE'), 'untested');
});

test('readPersona counts stuck marks from steps.jsonl for runs before T-278', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scorecard-persona-'));
  try {
    await writeFile(join(dir, 'run.json'), JSON.stringify({ ...persona('R1-C'), dir: undefined }));
    await writeFile(
      join(dir, 'steps.jsonl'),
      [true, false, true, true]
        .map((stuck, i) => JSON.stringify({ step: i + 1, persona: { stuck } }))
        .join('\n') + '\n',
    );
    const card = buildScorecard(runOf([routeRecord('R1-C')]), [readPersona(dir)]);
    assert.equal(card.scenarios[0].persona[0].stuckFlagged, 3);
    assert.equal(verdictOf(card, 'R1-C'), 'P0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('driver-failed is untested and left out of the pass-rate denominator', () => {
  const card = buildScorecard(
    runOf([
      routeRecord('R1-B'),
      routeRecord('R1-C', { runStatus: 'driver-failed', state: 'not-sent', error: 'ECONNREFUSED' }),
    ]),
  );
  assert.equal(verdictOf(card, 'R1-C'), 'untested');
  assert.equal(card.summary.counts.untested, 1);
  assert.equal(card.summary.denominator, 1);
  assert.equal(card.summary.passRate, 1);
});

test('a request whose request-stages was not joined is untested', () => {
  const card = buildScorecard(runOf([requestRecord(1, { stages: null, joinedStages: false })]));
  assert.equal(verdictOf(card, 'R1-COLOR'), 'untested');
  assert.match(card.scenarios[0].reasons[0], /미조인/);
});

test('medians and slowest stage over repeats', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([null, undefined]), null);
  const card = buildScorecard(
    runOf([
      requestRecord(1, { stages: stages(10000, { providerMs: 500 }) }),
      requestRecord(2, { stages: stages(14000, { providerMs: 3000 }) }),
      requestRecord(3, { stages: stages(12000, { providerMs: 1000 }) }),
    ]),
  );
  const row = card.scenarios[0];
  assert.equal(row.attempts, 3);
  assert.equal(row.medianMs, 12000);
  assert.equal(row.medianStages.providerMs, 1000);
  // provider 1000, spawn 500, firstOutput 2500, tools 4000, answer 2000.
  assert.deepEqual(row.slowestStage, { name: 'tools', ms: 4000 });
  assert.equal(verdictOf(card, 'R1-COLOR'), 'PASS');
  assert.equal(slowestStage(null), null);
});

test('CLI writes scorecard.json and scorecard.md with the §7.3 columns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scorecard-'));
  try {
    const runDir = join(dir, 'run');
    const personaDir = join(dir, 'persona');
    await mkdir(runDir);
    await mkdir(personaDir);
    await writeFile(
      join(runDir, 'results.json'),
      JSON.stringify(
        runOf([routeRecord('R1-B'), requestRecord(1), requestRecord(2), requestRecord(3)]),
      ),
    );
    await writeFile(
      join(personaDir, 'run.json'),
      JSON.stringify(persona('R1-B', { unknownWords: ['Sync'] })),
    );
    const out = join(dir, 'out');
    const result = spawnSync(
      process.execPath,
      [script, '--run', runDir, '--persona', personaDir, '--out', out],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const card = JSON.parse(await readFile(join(out, 'scorecard.json'), 'utf8'));
    assert.equal(verdictOf(card, 'R1-B'), 'P2');
    assert.equal(verdictOf(card, 'R1-COLOR'), 'PASS');
    const md = await readFile(join(out, 'scorecard.md'), 'utf8');
    assert.match(
      md,
      /\| 시나리오 \| 사용자 입력 \| 실제 동작 \| 보이는 결과 \| 다음 행동 \| 원본 보호 \| 미시험 \| 판정 \|/,
    );
    assert.match(md, /되돌림 확인 3회/);
    // The pure entry gives the same verdicts.
    const { card: again } = await writeScorecard({
      runDir,
      personaDirs: [personaDir],
      outDir: out,
    });
    assert.equal(verdictOf(again, 'R1-B'), 'P2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repeats: PASS needs every planned attempt judged; a hang or lost engine is P0', () => {
  // #1 aborted, #2 driver-failed, #3 succeeded: not a pass.
  let card = buildScorecard(
    runOf([
      requestRecord(1, {
        runStatus: 'aborted',
        state: 'running',
        stages: null,
        joinedStages: false,
      }),
      requestRecord(2, { runStatus: 'driver-failed', state: 'not-sent', stages: null }),
      requestRecord(3),
    ]),
  );
  assert.equal(verdictOf(card, 'R1-COLOR'), 'untested');
  assert.match(card.scenarios[0].reasons[0], /부분 측정 1\/3/);
  assert.equal(card.summary.denominator, 0);
  // Fewer records than planned (the runner stopped) is not a pass either.
  card = buildScorecard(runOf([requestRecord(1), requestRecord(2)]));
  assert.equal(verdictOf(card, 'R1-COLOR'), 'untested');
  assert.match(card.scenarios[0].untested.join(), /기록 없음 1회/);
  // A timeout is judged (no stages needed) and is P0.
  card = buildScorecard(
    runOf([
      requestRecord(1, { state: 'timeout', timedOut: true, stages: null, joinedStages: false }),
      requestRecord(2),
      requestRecord(3),
    ]),
  );
  assert.equal(verdictOf(card, 'R1-COLOR'), 'P0');
  assert.match(card.scenarios[0].reasons.join(), /timeout/);
  // An engine lost after acceptance counts as a crash: P0.
  card = buildScorecard(
    runOf([
      requestRecord(1, {
        state: 'engine-lost',
        engineLost: true,
        crashes: 1,
        stages: null,
        joinedStages: false,
      }),
      requestRecord(2),
      requestRecord(3),
    ]),
  );
  assert.equal(verdictOf(card, 'R1-COLOR'), 'P0');
  assert.match(card.scenarios[0].reasons.join(), /엔진 종료 1건/);
});

test('a planned scenario without any record is listed as untested', () => {
  const run = {
    ...runOf([routeRecord('R1-B')]),
    scenarios: [
      { id: 'R1-B', title: 'B', body: 'B 문장', kind: 'route-only', repeat: 1 },
      { id: 'R1-C', title: 'C', body: 'C 문장', kind: 'route-only', repeat: 1 },
    ],
  };
  const card = buildScorecard(run);
  assert.deepEqual(
    card.scenarios.map((s) => [s.id, s.verdict]),
    [
      ['R1-B', 'PASS'],
      ['R1-C', 'untested'],
    ],
  );
  assert.match(card.scenarios[1].reasons[0], /기록 없음/);
  assert.equal(card.scenarios[1].body, 'C 문장');
  assert.equal(card.summary.counts.untested, 1);
  assert.equal(card.summary.passRate, 1);
});

test('an older run without run.scenarios takes the planned ids from its plan file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scorecard-plan-'));
  try {
    await writeFile(
      join(dir, 'results.json'),
      JSON.stringify({ ...runOf([routeRecord('R1-B')]), only: 'R1-B,R1-C' }),
    );
    const { card } = await writeScorecard({ runDir: dir });
    assert.deepEqual(
      card.scenarios.map((s) => [s.id, s.verdict]),
      [
        ['R1-C', 'untested'],
        ['R1-B', 'PASS'],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('persona expect.aiRequests: a screen-only scenario with an AI request is P0 (T-278)', () => {
  let card = buildScorecard(runOf([]), [
    persona('R1-HIDE', { expect: { aiRequests: 0 }, requestIds: ['86b1b312'] }),
  ]);
  assert.equal(verdictOf(card, 'R1-HIDE'), 'P0');
  assert.match(card.scenarios[0].reasons.join(), /AI 요청 1건\(기대 0건\)/);
  // No AI request and the operator's goal verdict: PASS.
  card = buildScorecard(runOf([]), [
    persona('R1-HIDE', { expect: { aiRequests: 0 }, requestIds: [], goalReached: true }),
  ]);
  assert.equal(verdictOf(card, 'R1-HIDE'), 'PASS');
  // Without the expectation an AI request is no finding by itself.
  card = buildScorecard(runOf([]), [persona('R1-HIDE', { requestIds: ['x'], goalReached: true })]);
  assert.equal(verdictOf(card, 'R1-HIDE'), 'PASS');
});

test('readPersona fills expect from tools/persona/scenarios.json for older runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-expect-'));
  await writeFile(
    join(dir, 'run.json'),
    JSON.stringify({ scenario: 'R1-HIDE', status: 'completed', requestIds: ['a'], stuck: 0 }),
  );
  const run = readPersona(dir);
  await rm(dir, { recursive: true, force: true });
  assert.deepEqual(run.expect, { aiRequests: 0 });
  assert.equal(verdictOf(buildScorecard(runOf([]), [run]), 'R1-HIDE'), 'P0');
});
