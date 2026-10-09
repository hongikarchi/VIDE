#!/usr/bin/env node
// Scorecard of one verify-loop round (PLAN-51 T-265, contract item 4). Reads a scenario run's
// results.json (tools/ab/run.mjs) and, optionally, persona runs (tools/persona run.json), and gives
// each scenario one verdict:
//   untested      — no attempt completed (driver-failed / aborted / untested), a request whose
//                   `request-stages` line was never joined (except a 'timeout' or 'engine-lost'
//                   state, judged without it), a planned scenario with no record, or one that would
//                   pass with fewer judged attempts than planned; never a pass (§1 조용한 통과 방지)
//   EXPECTED-FAIL — the plan marks the scenario expectedFail and its expectation (route, request
//                   state, result checks) failed; misreports and engine exits stay P0 under it
//   P0            — a request that did not succeed (incl. timeout / engine-lost), a failed result
//                   check (beyond the contract: a wrong result is a P0 outcome), a misreport flag
//                   (M1/M2/M4), a new engine exit, a route mismatch, a stuck persona (run.json
//                   `stuck` > 0 — declared + no-progress pairs — or `stuckFlagged` >= 2 steps the
//                   persona marked stuck), a persona run the operator marked `goalReached: false`,
//                   a persona run with more AI requests than its `expect.aiRequests` (R1-HIDE: 0)
//   P1            — the median time of the judged attempts is over the scenario's alertMs
//   P2            — the persona met unknown or internal words, or clicked wrong more than once
//   PASS          — none of the above, with every planned attempt judged
// A persona-only scenario (no runner record) passes only when the operator set `goalReached: true`
// in every completed run.json after reading its screenshots; with goalReached null it is untested.
// Attempts of a repeated scenario (same id) are folded: P0 when any attempt hits P0, times as medians.
// The planned scenarios come from results.json `scenarios` (or the plan file of an older run).
// The pass rate leaves untested and EXPECTED-FAIL scenarios out of its denominator.
//
//   node tools/ab/scorecard.mjs --run <dir with results.json> [--persona <dir with run.json>]...
//     [--out <dir>]          (writes scorecard.json and scorecard.md; --out defaults to --run)
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { misreport } from './checks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
export const VERDICTS = ['P0', 'P1', 'P2', 'EXPECTED-FAIL', 'PASS', 'untested'];
const STAGE_FIELDS = [
  'queuedMs',
  'contextMs',
  'providerMs',
  'authMs',
  'spawnMs',
  'firstOutputMs',
  'firstNoteMs',
  'firstToolMs',
  'lastToolMs',
  'answerMs',
  'totalMs',
  'queries',
  'executes',
];
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export function median(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The stage that took longest, from the cumulative stage marks (contract item 4). */
export function slowestStage(stages) {
  if (!stages) return null;
  const s = stages;
  const delta = (a, b) => (finite(a) && finite(b) ? a - b : null);
  const parts = {
    provider: finite(s.providerMs) ? s.providerMs : null,
    spawn: delta(s.spawnMs, s.providerMs),
    firstOutput: delta(s.firstOutputMs, s.spawnMs),
    tools: delta(s.lastToolMs, s.firstToolMs),
    answer: finite(s.answerMs) ? s.answerMs : null,
  };
  let best = null;
  for (const [name, ms] of Object.entries(parts))
    if (ms != null && (best === null || ms > best.ms)) best = { name, ms };
  return best;
}

/** Medians of the stage fields over attempts (null when no attempt joined its stages). */
function medianStages(records) {
  const joined = records.map((r) => r.stages).filter(Boolean);
  if (!joined.length) return null;
  const out = {};
  for (const key of STAGE_FIELDS) {
    const m = median(joined.map((s) => s[key]));
    if (m !== null) out[key] = m;
  }
  return out;
}

/** Why one attempt cannot be judged, or null when it can. */
function untestedReason(record) {
  if (record.runStatus !== 'completed')
    return `${record.runStatus ?? 'no run status'}${record.error ? ': ' + record.error : ''}`;
  // A hang (timeout) or a lost engine is judged on its state even when no stages line was written.
  if (record.kind === 'request' && !record.joinedStages && !LOST_STATES.has(record.state))
    return 'request-stages 미조인';
  return null;
}
const LOST_STATES = new Set(['timeout', 'engine-lost']);

const routeCheckOf = (record) => (record.checks ?? []).find((c) => c.type === 'route');
const resultChecksOf = (record) => (record.checks ?? []).filter((c) => c.type !== 'route');
/** The attempt's time against alertMs: route ms for route-only, stages.totalMs or ms for requests. */
const timeOf = (record) =>
  record.kind === 'route-only'
    ? (record.route?.ms ?? record.ms ?? null)
    : (record.stages?.totalMs ?? record.ms ?? null);

/**
 * P0 findings of one judged attempt, split into the expectation (route, state, result checks —
 * what expectedFail may cover) and the faults expectedFail never covers (misreport, crashes).
 */
function findingsOf(record) {
  const expectation = [];
  const faults = [];
  const route = routeCheckOf(record);
  if (route && !route.ok) expectation.push(`경로 불일치: ${route.detail}`);
  if (record.kind === 'request') {
    if (record.state !== 'succeeded') expectation.push(`요청 상태 ${record.state ?? '-'}`);
    else
      for (const c of resultChecksOf(record).filter((c) => !c.ok))
        expectation.push(`결과 검사 ${c.type}: ${c.detail}`);
  }
  const m = misreport(record); // recomputed: the stored copy may be null or older
  for (const flag of m.flags) faults.push(`오보 ${flag}`);
  if (record.crashes > 0) faults.push(`엔진 종료 ${record.crashes}건`);
  return { expectation, faults, misreport: m };
}

/** The operator's goal verdict of a persona run (goalReached; older runs: reachedGoal), or null. */
const goalOf = (p) =>
  typeof p.goalReached === 'boolean'
    ? p.goalReached
    : typeof p.reachedGoal === 'boolean'
      ? p.reachedGoal
      : null;

function personaFindings(personas) {
  const p0 = [];
  const p2 = [];
  const untested = [];
  for (const p of personas) {
    if (p.status !== 'completed') {
      untested.push(`페르소나 ${p.status ?? '-'}${p.reason ? ': ' + p.reason : ''}`);
      continue;
    }
    if (p.stuck > 0) p0.push(`페르소나 막힘 ${p.stuck}회`);
    if (p.stuckFlagged >= 2) p0.push(`페르소나 막힘 표시 ${p.stuckFlagged}단계`);
    if (goalOf(p) === false) p0.push('목표 미도달(검수자 판정)');
    // A result check of the scenario (PLAN-51 T-278): a screen-only request must send no AI request.
    const aiRequests = p.expect?.aiRequests;
    if (Number.isFinite(aiRequests) && (p.requestIds?.length ?? 0) > aiRequests)
      p0.push(`경로 불일치: AI 요청 ${p.requestIds.length}건(기대 ${aiRequests}건)`);
    if (p.unknownWords?.length) p2.push(`모르는 말: ${p.unknownWords.join(', ')}`);
    if (p.bannedWords?.length) p2.push(`내부 용어 노출: ${p.bannedWords.join(', ')}`);
    if (p.wrongClicks > 1) p2.push(`잘못 누름 ${p.wrongClicks}회`);
  }
  return { p0, p2, untested };
}

/** One scenario's row: all attempts of `id` plus the persona runs for it. */
export function scoreScenario(records, personas = [], planned = null) {
  const first = { ...(planned ?? {}), ...(records[0] ?? {}) };
  const id = first.id ?? personas[0]?.scenario;
  // Attempts the plan asked for; fewer records (the runner stopped) leave the rest unmeasured.
  const plannedAttempts = Math.max(
    records.length,
    Number(planned?.repeat ?? first.repeat ?? 1) || 1,
  );
  const judged = records.filter((r) => untestedReason(r) === null);
  const untested = records
    .map((r) => [r, untestedReason(r)])
    .filter(([, why]) => why)
    .map(([r, why]) => `#${r.attempt ?? 1} ${why}`);
  if (records.length && records.length < plannedAttempts)
    untested.push(`기록 없음 ${plannedAttempts - records.length}회(러너 중단)`);
  const persona = personaFindings(personas);
  const row = {
    id,
    title: first.title ?? personas[0]?.scenario ?? id,
    body: first.body ?? null,
    kind: first.kind ?? (records.length ? null : 'persona'),
    host: first.host ?? null,
    attempts: plannedAttempts,
    recordedAttempts: records.length,
    judgedAttempts: judged.length,
    expectedFail: first.expectedFail === true,
    alertMs: finite(first.alertMs) ? first.alertMs : null,
    medianMs: median(judged.map(timeOf)),
    medianStages: medianStages(judged),
    slowestStage: null,
    routes: judged.map((r) => r.route).filter(Boolean),
    states: judged.map((r) => r.state),
    misreport: { flags: [], suspects: [], answerDominates: 0 },
    crashes: records.reduce((n, r) => n + (r.crashes ?? 0), 0),
    restored: records.map((r) => r.restored ?? null).filter(Boolean),
    undo: records.flatMap((r) => r.undo ?? []),
    answer: judged.map((r) => r.answer).find((a) => typeof a === 'string') ?? null,
    persona: personas.map((p) => ({
      dir: p.dir,
      status: p.status,
      steps: p.steps,
      stuck: p.stuck,
      stuckFlagged: p.stuckFlagged ?? null,
      noProgressPairs: p.noProgressPairs ?? null,
      wrongClicks: p.wrongClicks,
      unknownWords: p.unknownWords ?? [],
      bannedWords: p.bannedWords ?? [],
      typedInputs: p.typedInputs,
      reachedGoal: p.reachedGoal ?? null,
      goalReached: goalOf(p),
    })),
    untested: [...untested, ...persona.untested],
    reasons: [],
    verdict: 'untested',
    note: null,
  };
  row.slowestStage = slowestStage(row.medianStages);

  // A planned scenario with no record at all (the runner died before it): untested.
  if (!records.length && planned && !personas.length) {
    row.untested = ['기록 없음(러너가 이 시나리오 전에 멈춤)'];
    row.reasons = row.untested;
    return row;
  }
  // A scenario only the persona ran: its done is not result evidence (PLAN-51 §2 ⑤). Only the
  // operator's goalReached:true (from the screenshots) on every completed run can make it pass.
  if (!records.length) {
    const completed = personas.filter((p) => p.status === 'completed');
    if (persona.p0.length) Object.assign(row, { verdict: 'P0', reasons: persona.p0 });
    else if (!completed.length) row.reasons = ['페르소나 런 미완료'];
    else if (!completed.every((p) => goalOf(p) === true))
      row.reasons = [
        '목표 도달 증거 없음(goalReached 미기입 — 페르소나 done만으로는 불인정)',
        ...persona.p2,
      ];
    else if (persona.p2.length) Object.assign(row, { verdict: 'P2', reasons: persona.p2 });
    else row.verdict = 'PASS';
    return row;
  }
  if (!judged.length) {
    row.reasons = untested;
    return row;
  }

  const expectation = [];
  const faults = [];
  for (const r of judged) {
    const f = findingsOf(r);
    const tag = records.length > 1 ? `#${r.attempt ?? 1} ` : '';
    expectation.push(...f.expectation.map((x) => tag + x));
    faults.push(...f.faults.map((x) => tag + x));
    for (const flag of f.misreport.flags)
      if (!row.misreport.flags.includes(flag)) row.misreport.flags.push(flag);
    for (const s of f.misreport.suspects)
      if (!row.misreport.suspects.includes(s)) row.misreport.suspects.push(s);
    if (f.misreport.answerDominates) row.misreport.answerDominates++;
  }
  const slow = row.alertMs !== null && row.medianMs !== null && row.medianMs > row.alertMs;

  if (faults.length || persona.p0.length) {
    row.verdict = 'P0';
    row.reasons = [...faults, ...persona.p0, ...expectation];
  } else if (row.expectedFail && expectation.length) {
    row.verdict = 'EXPECTED-FAIL';
    row.reasons = expectation;
  } else if (expectation.length) {
    row.verdict = 'P0';
    row.reasons = expectation;
  } else if (slow) {
    row.verdict = 'P1';
    row.reasons = [`중앙값 ${seconds(row.medianMs)} > 경보선 ${seconds(row.alertMs)}`];
  } else if (persona.p2.length) {
    row.verdict = 'P2';
    row.reasons = persona.p2;
  } else if (judged.length < plannedAttempts) {
    // A pass needs every planned attempt judged: 1 of 3 succeeding beside a hang is not a pass.
    row.verdict = 'untested';
    row.reasons = [
      `부분 측정 ${judged.length}/${plannedAttempts}회 — 통과로 세지 않음`,
      ...untested,
    ];
  } else row.verdict = 'PASS';
  if (row.expectedFail && !expectation.length)
    row.note = 'expectedFail인데 기대대로 동작함 — 플랜의 expectedFail을 내릴지 확인';
  if (slow && row.verdict !== 'P1') row.reasons.push(`속도 경보: 중앙값 ${seconds(row.medianMs)}`);
  if (row.verdict !== 'P2' && persona.p2.length && row.verdict !== 'untested')
    row.reasons.push(...persona.p2);
  return row;
}

/** The whole scorecard from a results.json object and persona run.json objects ({...run, dir}). */
export function buildScorecard(run, personaRuns = []) {
  const order = [];
  const byId = new Map();
  // The planned scenarios first (run.scenarios, written by run.mjs; readRun fills it from the plan
  // file for older runs), so one without any record still gets a row.
  const plannedOf = new Map();
  for (const p of Array.isArray(run.scenarios) ? run.scenarios : []) {
    if (!p?.id || plannedOf.has(p.id)) continue;
    plannedOf.set(p.id, p);
    byId.set(p.id, []);
    order.push(p.id);
  }
  for (const record of run.results ?? []) {
    if (!byId.has(record.id)) {
      byId.set(record.id, []);
      order.push(record.id);
    }
    byId.get(record.id).push(record);
  }
  const personasOf = new Map();
  for (const p of personaRuns) {
    if (!personasOf.has(p.scenario)) personasOf.set(p.scenario, []);
    personasOf.get(p.scenario).push(p);
    if (!byId.has(p.scenario)) {
      byId.set(p.scenario, []);
      order.push(p.scenario);
    }
  }
  const scenarios = order.map((id) =>
    scoreScenario(byId.get(id), personasOf.get(id) ?? [], plannedOf.get(id) ?? null),
  );
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const s of scenarios) counts[s.verdict]++;
  const denominator = scenarios.length - counts.untested - counts['EXPECTED-FAIL'];
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    run: {
      plan: run.plan ?? null,
      engineKind: run.engineKind ?? null,
      engine: run.engine ?? null,
      logsDir: run.logsDir ?? null,
      provider: run.provider ?? null,
      model: run.model ?? null,
      startedAt: run.startedAt ?? null,
      endedAt: run.endedAt ?? null,
      // A run without endedAt stopped part-way (the runner writes it after the last scenario).
      finished: Boolean(run.endedAt),
      logLines: run.logLines ?? null,
    },
    personas: personaRuns.map((p) => ({ dir: p.dir, scenario: p.scenario, status: p.status })),
    summary: {
      scenarios: scenarios.length,
      counts,
      denominator,
      passRate: denominator > 0 ? counts.PASS / denominator : null,
      graduationBlocked: counts.P0 > 0,
    },
    scenarios,
  };
}

// --- Markdown (PLAN §7.3: 사용자 입력 / 실제 동작 / 보이는 결과 / 다음 행동 / 원본 보호 / 미시험) ----
const seconds = (ms) => (finite(ms) ? `${(ms / 1000).toFixed(1)} s` : '-');
const cell = (text) =>
  String(text ?? '-')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim() || '-';
const clip = (text, n) => (text && text.length > n ? text.slice(0, n - 1) + '…' : text);
const routeText = (r) => `${r.target ?? '-'}${r.jig ? ' ' + r.jig : ''}`;

function actionText(s) {
  const parts = [];
  if (s.routes.length) {
    const counts = new Map();
    for (const r of s.routes) counts.set(routeText(r), (counts.get(routeText(r)) ?? 0) + 1);
    parts.push(
      '경로 ' +
        [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ') +
        ` (${s.routes[0].by ?? '-'})`,
    );
  }
  if (s.kind === 'request' && s.states.length)
    parts.push(`상태 ${[...new Set(s.states)].join('/')}`);
  if (s.medianMs !== null) parts.push(`중앙값 ${seconds(s.medianMs)}`);
  if (s.slowestStage) parts.push(`최장 단계 ${s.slowestStage.name} ${seconds(s.slowestStage.ms)}`);
  if (s.kind === 'persona' || (!s.attempts && s.persona.length))
    parts.push(s.persona.map((p) => `페르소나 ${p.steps ?? 0}단계`).join(', '));
  return parts.join(' · ') || '-';
}

function visibleText(s) {
  const parts = [];
  if (s.answer) parts.push(`"${clip(s.answer.replace(/\s+/g, ' '), 80)}"`);
  else if (s.routes[0]?.reason) parts.push(clip(s.routes[0].reason, 80));
  if (s.misreport.suspects.length) parts.push(`의심 ${s.misreport.suspects.join(',')}`);
  for (const p of s.persona.filter((p) => p.status === 'completed'))
    parts.push(
      `페르소나 막힘 ${p.stuck ?? 0}·잘못 누름 ${p.wrongClicks ?? 0}·입력 ${p.typedInputs ?? 0}`,
    );
  return parts.join(' · ') || '-';
}

function nextText(s) {
  switch (s.verdict) {
    case 'PASS':
      return s.note ?? '-';
    case 'EXPECTED-FAIL':
      return '알려진 결함 유지: ' + s.reasons.join('; ');
    case 'untested':
      return '재측정: ' + s.reasons.join('; ');
    default:
      return `수정 티켓(${s.verdict}): ` + s.reasons.join('; ') + (s.note ? ` — ${s.note}` : '');
  }
}

function protectionText(s) {
  if (s.kind === 'route-only') return '해당 없음(문서 미접촉)';
  if (s.kind === 'persona' || !s.attempts) return '전용 프로젝트(페르소나)';
  if (!s.restored.length) return s.undo.length ? '되돌림 시도, 재조회 없음' : '되돌림 기록 없음';
  const left = s.restored.filter((r) => r.added || r.removed || r.modified).length;
  const failed = s.undo.filter((u) => !u.ok).length;
  return left || failed
    ? `잔여 변경 ${left}회${failed ? `·되돌리기 실패 ${failed}건` : ''}`
    : `되돌림 확인 ${s.restored.length}회`;
}

export function renderMarkdown(card) {
  const { summary, run } = card;
  const lines = [
    `# 검증 루프 스코어카드`,
    '',
    `- 플랜: ${run.plan ?? '-'} · 엔진: ${run.engineKind ?? '-'} ${run.engine ?? ''} · 모델: ${run.provider ?? '-'} ${run.model ?? ''}`,
    `- 런: ${run.startedAt ?? '-'} ~ ${run.endedAt ?? '(끝나지 않음)'}`,
    `- 판정: ${VERDICTS.map((v) => `${v} ${summary.counts[v]}`).join(' · ')}`,
    `- 통과율: ${summary.passRate === null ? '-' : `${Math.round(summary.passRate * 100)}% (${summary.counts.PASS}/${summary.denominator})`} — 미시험·EXPECTED-FAIL은 분모에서 제외`,
    '',
    '| 시나리오 | 사용자 입력 | 실제 동작 | 보이는 결과 | 다음 행동 | 원본 보호 | 미시험 | 판정 |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const s of card.scenarios)
    lines.push(
      '| ' +
        [
          `${s.id}${s.attempts > 1 ? ` (${s.judgedAttempts}/${s.attempts}회)` : ''}`,
          s.body,
          actionText(s),
          visibleText(s),
          nextText(s),
          protectionText(s),
          s.untested.length ? s.untested.join('; ') : '-',
          s.verdict,
        ]
          .map(cell)
          .join(' | ') +
        ' |',
    );
  return lines.join('\n') + '\n';
}

// --- files -------------------------------------------------------------------------------------
export function readRun(dir) {
  const file = join(resolve(dir), 'results.json');
  if (!existsSync(file)) throw new Error('No results.json in ' + dir);
  const run = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(run.scenarios)) run.scenarios = plannedFromFile(run);
  return run;
}

/** The planned scenarios of an older run (no run.scenarios), from its plan file; [] when unreadable. */
function plannedFromFile(run) {
  if (!run.plan) return [];
  const file = run.plan === 'requests.json' ? join(here, 'requests.json') : resolve(root, run.plan);
  try {
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    const only = run.only
      ? new Set(
          String(run.only)
            .split(',')
            .map((x) => x.trim()),
        )
      : null;
    return (plan.scenarios ?? plan.requests ?? [])
      .filter((p) => p?.id && (!only || only.has(p.id)))
      .map((p) => ({
        id: p.id,
        title: p.title ?? p.id,
        body: p.body ?? null,
        kind: p.kind ?? 'request',
        host: p.host ?? null,
        repeat: Math.max(1, Number(p.repeat ?? 1) || 1),
        expectedFail: p.expectedFail === true,
        alertMs: Number.isFinite(p.alertMs) ? p.alertMs : null,
      }));
  } catch {
    return [];
  }
}

/** The `expect` of a persona scenario in tools/persona/scenarios.json, or null. */
function personaExpect(id) {
  try {
    const file = join(root, 'tools', 'persona', 'scenarios.json');
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    return (plan.scenarios ?? []).find((s) => s.id === id)?.expect ?? null;
  } catch {
    return null;
  }
}

export function readPersona(dir) {
  const file = join(resolve(dir), 'run.json');
  if (!existsSync(file))
    return { dir, scenario: null, status: 'untested', reason: 'run.json 없음' };
  const run = { ...JSON.parse(readFileSync(file, 'utf8')), dir };
  // Runs before the expect field: the scenario's checks from tools/persona/scenarios.json.
  if (run.expect === undefined && run.scenario) run.expect = personaExpect(run.scenario);
  // Runs before T-278 lack stuckFlagged: count the persona's stuck marks from steps.jsonl.
  const steps = join(resolve(dir), 'steps.jsonl');
  if (run.stuckFlagged === undefined && existsSync(steps))
    run.stuckFlagged = readFileSync(steps, 'utf8')
      .split('\n')
      .filter((line) => {
        try {
          return JSON.parse(line).persona?.stuck === true;
        } catch {
          return false;
        }
      }).length;
  return run;
}

export async function writeScorecard({ runDir, personaDirs = [], outDir }) {
  const run = readRun(runDir);
  const personas = personaDirs.map(readPersona).filter((p) => p.scenario);
  const card = buildScorecard(run, personas);
  const out = resolve(outDir ?? runDir);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'scorecard.json'), JSON.stringify(card, null, 2));
  await writeFile(join(out, 'scorecard.md'), renderMarkdown(card));
  return { card, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: args } = parseArgs({
    options: {
      run: { type: 'string' },
      persona: { type: 'string', multiple: true, default: [] },
      out: { type: 'string' },
    },
  });
  if (!args.run) throw new Error('Pass --run <dir with results.json>.');
  const { card, out } = await writeScorecard({
    runDir: args.run,
    personaDirs: args.persona,
    outDir: args.out,
  });
  for (const s of card.scenarios)
    console.log(`${s.id} ${s.verdict}${s.reasons.length ? ' — ' + s.reasons.join('; ') : ''}`);
  const { counts, passRate, denominator } = card.summary;
  console.log(
    `\n${VERDICTS.map((v) => `${v} ${counts[v]}`).join(' · ')}; pass rate ` +
      (passRate === null ? '-' : `${counts.PASS}/${denominator}`) +
      `\nSaved ${join(out, 'scorecard.json')} and scorecard.md`,
  );
}
