#!/usr/bin/env node
// Scenario runner (PLAN-51 T-264; first the AI parity A/B, SPIKE-2026-09-30-ai-parity-ab). Sends the
// scenarios of a plan through a RUNNING engine's API and records results.json:
//   - route-only: asks /route where the sentence goes and compares it with the expected route
//     (no conversation, no request);
//   - request: records the route, then sends the sentence as a conversation request, waits, checks
//     the changed model (mm), reverts applied executions and joins the engine log's stage times;
//   - sync: not run here (tests/integration/rhino-sync-perf.mjs measures Sync); marked untested.
// Without --plan it runs tools/ab/requests.json (five Rhino requests, kind 'request').
// It never launches Rhino. Engines: 'dev' (default) refuses the installed engine and the person's
// `npm run dev` engine (unless --allow-dev-port). Both are recognised by port (47821 / 47831), by
// the origin in their launch.json, or by a launch file / logs dir inside their data folders
// (%LOCALAPPDATA%\VIDE, .vide/dev-data): an engine may sit on a fallback port (main.ts, EADDRINUSE).
// 'installed' allows the installed engine for route-only scenarios in a project named '검증 루프…'.
//
//   node tools/ab/run.mjs [--plan tools/ab/scenarios-round1.json] [--engine dev|installed]
//     (--launch-file <run data>/launch.json | --launch <url#token> --logs <run data>/logs)
//     [--allow-dev-port] [--project <id>] [--base <sync request id>] [--match ab-fixture]
//     [--provider claude-cli|codex-cli] [--model <id>] [--effort <level>] [--fresh-project]
//     [--only R1,R3] [--chain] [--timeout 900] [--scale auto|<n>] [--out <dir>] [--dry-run]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
// A namespace import: misreport() is optional (a checks.mjs without it still loads).
import * as checks from './checks.mjs';
import {
  countCrashes,
  countLogLines,
  identifyEngine,
  personEngines,
  readRouteLine,
  readStages,
} from './stages.mjs';

const { captureSvg, diff, evaluate, objectOf, routeCheck } = checks;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const { values: args } = parseArgs({
  options: {
    plan: { type: 'string' },
    engine: { type: 'string', default: 'dev' },
    launch: { type: 'string' },
    'launch-file': { type: 'string' },
    'allow-dev-port': { type: 'boolean', default: false },
    logs: { type: 'string' },
    project: { type: 'string' },
    base: { type: 'string' },
    match: { type: 'string', default: 'ab-fixture' },
    provider: { type: 'string', default: 'claude-cli' },
    model: { type: 'string' },
    effort: { type: 'string' },
    only: { type: 'string' },
    chain: { type: 'boolean', default: false },
    'fresh-project': { type: 'boolean', default: false },
    timeout: { type: 'string', default: '900' },
    scale: { type: 'string', default: 'auto' },
    out: { type: 'string' },
    'keep-applied': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

// --- plan --------------------------------------------------------------------------------------
const LOOP_PROJECT = '검증 루프';
const KINDS = new Set(['route-only', 'request', 'sync']);
if (!['dev', 'installed'].includes(args.engine))
  throw new Error('--engine takes dev or installed, not ' + args.engine);

const planPath = args.plan ? resolve(args.plan) : join(here, 'requests.json');
const planLabel = args.plan ? relative(root, planPath).replace(/\\/g, '/') : 'requests.json';
const planFile = JSON.parse(await readFile(planPath, 'utf8'));
/** One scenario in the contract shape (PLAN-51 contract 1); requests.json rows become Rhino requests. */
function scenarioOf(row) {
  const kind = row.kind ?? 'request';
  if (!KINDS.has(kind)) throw new Error(`${row.id}: unknown kind ${kind}`);
  return {
    id: row.id,
    title: row.title ?? row.id,
    body: row.body,
    kind,
    host: row.host === undefined ? (kind === 'request' ? 'rhino' : null) : row.host,
    expect: {
      route: row.expect?.route ?? null,
      // requests.json rows are modelling edits: they expect a change.
      change: typeof row.expect?.change === 'boolean' ? row.expect.change : kind === 'request',
      // R1-RECONNECT: judged by the reconnectHonest check (checks.mjs recordCheck).
      ...(row.expect?.reconnect === true ? { reconnect: true } : {}),
    },
    expectedFail: row.expectedFail === true,
    repeat: Math.max(1, Number(row.repeat ?? 1) || 1),
    alertMs: Number.isFinite(row.alertMs) ? row.alertMs : null,
    checks: Array.isArray(row.checks) ? row.checks : [],
    pin: row.pin ?? null,
  };
}
const all = (planFile.scenarios ?? planFile.requests ?? []).map(scenarioOf);
const chosen = args.only ? new Set(args.only.split(',').map((s) => s.trim())) : undefined;
const scenarios = all.filter((s) => !chosen || chosen.has(s.id));
if (!scenarios.length) throw new Error('No scenario matches --only ' + args.only);
if (args['dry-run']) {
  console.log(`plan ${planLabel}: ${scenarios.length} scenario(s)`);
  for (const s of scenarios) {
    const route = s.expect.route
      ? `route ${s.expect.route.target}${s.expect.route.jig ? ' ' + s.expect.route.jig : ''}`
      : 'route -';
    console.log(
      `${s.id} [${s.kind}${s.host ? ' ' + s.host : ''}] ×${s.repeat}${s.expectedFail ? ' expected-fail' : ''} ${s.title}: ${s.body}\n` +
        `  expect ${route}, change ${s.expect.change}, alert ${s.alertMs ?? '-'} ms` +
        (s.checks.length ? `, checks: ${s.checks.map((c) => c.type).join(', ')}` : ''),
    );
  }
  process.exit(0);
}

// --- engine guard (before any call) --------------------------------------------------------------
if (!args.launch && !args['launch-file'])
  throw new Error('Pass --launch-file <run data>/launch.json (or --launch <url#token> with --logs).');
// The logs must be the driven engine's: another dir joins no request-stages (every request comes
// out untested) and reads another engine's exits and route reasons.
if (args.launch && !args.logs)
  throw new Error("--launch needs --logs <that engine's data>/logs (stages, exits and route lines are read there).");
const launchFile = args['launch-file'] ? resolve(args['launch-file']) : null;
const launch = new URL(args.launch ?? JSON.parse(await readFile(launchFile, 'utf8')).url);
const logsDir = resolve(args.logs ?? join(dirname(launchFile), 'logs'));
const identity = identifyEngine({
  origin: launch.origin,
  launchFile,
  logsDir,
  engines: personEngines({ root }),
});
if (args.engine === 'dev') {
  if (identity.kind === 'installed')
    throw new Error(
      `That is the installed work engine (${identity.why}); use a loop dev engine (or --engine installed for route-only).`,
    );
  if (identity.kind === 'dev' && !args['allow-dev-port'])
    throw new Error(
      `That is the person's \`npm run dev\` engine (${identity.why}); start a loop engine with its own VIDE_DATA_DIR, or pass --allow-dev-port.`,
    );
} else {
  const others = scenarios.filter((s) => s.kind !== 'route-only').map((s) => s.id);
  if (others.length)
    throw new Error(`--engine installed runs route-only scenarios only; drop ${others.join(', ')} (--only).`);
  if (args['fresh-project']) throw new Error('--fresh-project is not allowed with --engine installed.');
}

// --- engine session ----------------------------------------------------------------------------
const origin = launch.origin;
const session = await fetch(origin + '/api/v1/session', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: launch.hash.slice(1) }),
});
const cookie = session.headers.getSetCookie?.()[0]?.split(';')[0];
if (!session.ok || !cookie) throw new Error('Engine session failed: ' + session.status);
async function call(path, data) {
  const response = await fetch(origin + '/api/v1' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}

/**
 * One request in full. A display Sync answers JSON with 406 GEOMETRY_BINARY_REQUIRED (T-127); its
 * scene then comes from the binary geometry view (src/contracts/geometry-transfer.ts).
 */
let geometryTransfer;
async function getRequest(projectId, id) {
  const path = `/projects/${projectId}/requests/${id}`;
  try {
    return await call(path);
  } catch (error) {
    if (!/: 406 /.test(String(error?.message))) throw error;
  }
  const response = await fetch(origin + '/api/v1' + path, {
    headers: { Origin: origin, Cookie: cookie, Accept: 'application/vnd.vide.geometry' },
  });
  if (!response.ok) throw new Error(`${path} (binary): ${response.status}`);
  geometryTransfer ??= await import(
    pathToFileURL(join(root, 'src', 'contracts', 'geometry-transfer.ts')).href
  );
  return geometryTransfer.decodeGeometry(new Uint8Array(await response.arrayBuffer()));
}
/** A capture reply without its scene (display Sync) is read again in full. */
const withScene = async (projectId, row) =>
  row?.result?.scene || !row?.id ? row : getRequest(projectId, row.id);

// --- project -----------------------------------------------------------------------------------
const projects = await call('/projects');
const loopProject = (p) => typeof p?.name === 'string' && p.name.startsWith(LOOP_PROJECT);
let project = args.project
  ? projects.find((p) => p.id === args.project)
  : args.engine === 'installed'
    ? projects.find(loopProject)
    : projects[0];
if (!project)
  throw new Error(
    'No project ' +
      (args.project ??
        (args.engine === 'installed' ? `named '${LOOP_PROJECT}…' on the installed engine` : '(the engine has none)')),
  );
if (args.engine === 'installed' && !loopProject(project))
  throw new Error(`--engine installed runs only in a project named '${LOOP_PROJECT}…', not '${project.name}'.`);

// The base Sync is looked up only when a request scenario needs it (route-only plans need none).
let basis;
const scaleOf = (result) =>
  args.scale !== 'auto' ? Number(args.scale) : result?.displayOnly === true ? 1000 : 1;
async function baseOf(projectId) {
  let baseId = args.base;
  if (!baseId) {
    // The newest Rhino Sync of the linked fixture (the list omits scenes: `sceneOmitted`).
    const syncs = (await call(`/projects/${projectId}/requests`)).filter(
      (r) =>
        r.state === 'succeeded' &&
        r.result?.sceneOmitted &&
        (r.result.host ?? 'rhino') === 'rhino' &&
        JSON.stringify([r.result.sourceDocument, r.result.filename]).includes(args.match),
    );
    baseId = syncs.at(-1)?.id; // the list is in submission order
    if (!baseId)
      throw new Error(`No Rhino Sync whose document matches "${args.match}"; pass --base <id>.`);
  }
  return getRequest(projectId, baseId);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(args.out ?? join('.vide', 'ab', stamp));
await mkdir(out, { recursive: true });
const run = {
  startedAt: new Date().toISOString(),
  plan: planLabel,
  engineKind: args.engine,
  engine: origin,
  logsDir,
  // engine-*.jsonl lines in logsDir during the run; 0 means the dir is not this engine's.
  logLines: null,
  only: args.only ?? null,
  // Every planned scenario, so the scorecard lists one that never got a record as untested.
  scenarios: scenarios.map((s) => ({
    id: s.id,
    title: s.title,
    body: s.body,
    kind: s.kind,
    host: s.host,
    repeat: s.repeat,
    expectedFail: s.expectedFail,
    alertMs: s.alertMs,
  })),
  project: project.id,
  base: null,
  provider: args.provider,
  model: args.model ?? 'auto',
  effort: args.effort ?? 'default',
  chain: args.chain,
  results: [],
};
console.log(`run ${planLabel} → ${origin} (${args.engine}), project ${project.id}, logs ${logsDir}, out ${out}`);

// --- route ---------------------------------------------------------------------------------------
/** The screen's own rules (src/ui/request-route.ts), used when /route leaves the choice to them. */
let localRules;
async function rulesRoute(body) {
  localRules ??= await import(pathToFileURL(join(root, 'src', 'ui', 'request-route.ts')).href).catch(
    () => null,
  );
  if (!localRules) return null;
  return localRules.routeRequest(body, [], [], { jigs: localRules.officialRouteJigs() });
}
const jigId = (jig) => (typeof jig === 'string' ? jig : (jig?.id ?? null));
/**
 * Where the sentence goes: the server's /route decision (Jev, or its word rules), else — `target:
 * null`, as the screen does — the screen's rules with the official jigs (by 'rules', reason marked
 * 'local'). The project's own jigs are not in that fallback.
 */
async function routeOf(projectId, body) {
  const startedAt = new Date().toISOString();
  const began = Date.now();
  const decision = await call(`/projects/${projectId}/route`, { body, subjects: [] });
  const ms = Date.now() - began;
  if (decision?.target) {
    return {
      target: decision.target,
      jig: jigId(decision.jig),
      by: decision.by ?? 'jev',
      // /route sends the decision only (its reason goes to the log line); jigName/task stand in.
      reason: decision.reason ?? decision.jigName ?? decision.task ?? null,
      ms,
    };
  }
  const rules = await rulesRoute(body);
  // The engine logs why there is no Jev decision (the `route` line; flushed within a second).
  await wait(1200);
  const line = readRouteLine({ logsDir, startedAt, endedAt: new Date().toISOString() });
  return {
    target: rules?.target ?? null,
    jig: jigId(rules?.jig),
    by: 'rules',
    reason: [rules ? `local: ${rules.reason ?? ''}` : 'local rules unavailable', line?.reason]
      .filter(Boolean)
      .join(' · '),
    ms,
  };
}

const TERMINAL = new Set(['succeeded', 'failed', 'unknown', 'cancelled', 'interrupted']);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const blank = (s, attempt) => ({
  id: s.id,
  title: s.title,
  body: s.body,
  kind: s.kind,
  host: s.host,
  attempt,
  repeat: s.repeat,
  alertMs: s.alertMs,
  expectedFail: s.expectedFail,
  expectChange: s.expect.change,
  expectRoute: s.expect.route,
  project: project.id,
  requestId: null,
  ms: null,
  state: null,
  route: null,
  stages: null,
  end: null,
  activityTail: [],
  crashes: 0,
  runStatus: 'completed',
  joinedStages: false,
  checks: [],
  success: false,
  executions: [],
  toolCalls: null,
  changes: null,
  answer: null,
});

async function routeOnly(s, record) {
  const startedAt = new Date().toISOString();
  try {
    record.route = await routeOf(project.id, s.body);
    record.ms = record.route.ms;
    record.state = 'route-only';
    record.checks = [routeCheck(s.expect.route, record.route, s.host)];
    record.success = record.checks.every((c) => c.ok);
  } catch (error) {
    record.runStatus = 'driver-failed';
    record.error = String(error?.message ?? error);
    record.state = 'not-sent';
    record.checks = [{ type: 'route', ok: false, detail: record.error }];
  }
  record.joinedStages = true; // nothing to join for a route
  record.crashes = countCrashes({ logsDir, startedAt, endedAt: new Date().toISOString() });
}

async function request(s, record) {
  const startedAt = new Date().toISOString();
  const began = Date.now();
  let done;
  let accepted = false;
  try {
    basis ??= await baseOf(project.id);
    run.base ??= basis.id;
    record.base = basis.id;
    record.route = await routeOf(project.id, s.body).catch((error) => ({
      target: null,
      jig: null,
      by: null,
      reason: 'route call failed: ' + String(error?.message ?? error),
      ms: null,
    }));
    const basisScene = basis.result?.scene ?? [];
    // The request contract has no 'auto' permission: `mode` carries plan/auto and permission
    // 'candidate' is auto (src/contracts/workspace.ts). A change is expected → auto, applied to
    // the attached document; otherwise plan (no file change).
    const mode = s.expect.change ? 'auto' : 'plan';
    record.mode = mode;
    const pins = [];
    if (s.pin) {
      const target = basisScene.find((row) => objectOf(row).layer === s.pin.layer);
      if (target) pins.push({ id: target.id, basis: basis.id, role: s.pin.role ?? 'target' });
      else {
        // "이 기둥" with nothing pinned refers to nothing: a correct change cannot be judged, so the
        // request is not sent and the attempt is untested (fixture.py builds the S-COLUMN object).
        record.pinMissing = s.pin.layer;
        throw Object.assign(new Error(`pin: the base Sync has no object on ${s.pin.layer}`), {
          untested: true,
        });
      }
    }
    const conversation = await call(`/projects/${project.id}/conversations`, {
      title: `${s.id} ${s.title}`,
      body: s.body,
      provider: args.provider,
      ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(s.host ? { host: s.host } : {}),
      permission: mode === 'auto' ? 'candidate' : 'review',
    });
    const id = randomUUID();
    record.requestId = id;
    await call(`/projects/${project.id}/requests`, {
      id,
      conversationId: conversation.id,
      body: s.body,
      mode,
      permission: mode === 'auto' ? 'candidate' : 'review',
      provider: args.provider,
      ...(args.effort ? { effort: args.effort } : {}),
      ...(s.host ? { host: s.host } : {}),
      baseRequestId: basis.id,
      pins,
      sketches: [],
      files: [],
    });
    accepted = true;
    for (const end = began + Number(args.timeout) * 1000; ; ) {
      done = await getRequest(project.id, id);
      if (TERMINAL.has(done.state)) break;
      if (Date.now() > end) {
        // A product hang, not a driver fault: judged (state 'timeout' → P0 in the scorecard).
        await call(`/projects/${project.id}/requests/${id}/cancel`, {}).catch(() => {});
        record.timedOut = true;
        break;
      }
      await wait(2000);
    }
  } catch (error) {
    record.error = String(error?.message ?? error);
    if (error?.untested) record.runStatus = 'untested';
    else if (!accepted) record.runStatus = 'driver-failed';
    else {
      // The engine took the request and then stopped answering: unless it answers a health call
      // now, count it as an engine loss (a dev engine has no shell to write engine-exits.jsonl).
      const alive = await call('/projects').then(
        () => true,
        () => false,
      );
      if (alive) record.runStatus = 'aborted';
      else record.engineLost = true;
    }
  }
  record.ms = Date.now() - began;
  const basisScene = basis?.result?.scene ?? [];
  const basisScale = scaleOf(basis?.result);
  let result = done?.result ?? {};
  // Auto mode applies directly to the attached document (ADR-022): the request result carries
  // executions, not a candidate scene. Sync the linked document again and diff it against the
  // basis, then (unless --keep-applied / --chain) revert every applied execution with the
  // product's [되돌리기] so the next request starts from the untouched fixture.
  const executions = Array.isArray(result.executions) ? result.executions : [];
  if (done && !result.scene && basis?.input?.linkId && basis.result?.sourceDocument) {
    try {
      const target = {
        instance: basis.result.sourceDocument.instance,
        documentId: basis.result.sourceDocument.documentId,
      };
      const synced = await withScene(project.id, await call(`/projects/${project.id}/capture`, {
        ...target,
        id: randomUUID(),
        linkId: basis.input.linkId,
      }));
      const rows = synced.result?.scene ?? [];
      result = {
        ...result,
        scene: rows,
        displayOnly: synced.result?.displayOnly,
        changes: diff(basisScene, rows),
      };
      record.afterSync = synced.id;
      if (!args['keep-applied'] && !args.chain) {
        record.undo = [];
        for (const entry of [...executions].reverse().filter((e) => e.state === 'applied')) {
          const undone = await call(`/projects/${project.id}/requests/${record.requestId}/undo`, {
            executionId: entry.executionId,
          }).catch((error) => ({ ok: false, reason: String(error?.message ?? error) }));
          record.undo.push({
            executionId: entry.executionId,
            ok: undone.ok ?? !undone.reason,
            reason: undone.reason,
          });
        }
        const restored = await withScene(project.id, await call(`/projects/${project.id}/capture`, {
          ...target,
          id: randomUUID(),
          linkId: basis.input.linkId,
        }));
        const left = diff(basisScene, restored.result?.scene ?? []);
        record.restored = {
          added: left.added.length,
          removed: left.removed.length,
          modified: left.modified.length,
        };
      }
    } catch (error) {
      record.syncError = String(error?.message ?? error);
    }
  }
  record.executions = executions.map((e) => ({
    state: e.state,
    changes: e.changes && {
      added: (e.changes.added ?? []).length,
      changed: (e.changes.changed ?? []).length,
      removed: (e.changes.removed ?? []).length,
    },
  }));
  record.state = record.engineLost
    ? 'engine-lost'
    : record.timedOut
      ? 'timeout'
      : (done?.state ?? 'not-sent');
  record.provider = done?.input?.provider;
  record.model = done?.input?.model ?? null;
  record.usage = result.usage ?? null;
  record.tokens =
    result.usage &&
    ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'].reduce(
      (sum, key) => sum + (result.usage[key] ?? 0),
      0,
    );
  const activity = Array.isArray(result.activity) ? result.activity : [];
  record.activityTail = activity.slice(-5).map((e) => ({
    kind: e?.kind,
    ...(e?.code != null ? { code: e.code } : {}),
    ...(typeof e?.text === 'string' ? { text: e.text.slice(0, 300) } : {}),
  }));
  record.toolCalls = {
    hostQueries: result.progress?.queries ?? null,
    hostCommands: result.progress?.attempts ?? null,
    reported: result.toolCalls ?? null,
    activity: activity.reduce((map, e) => ({ ...map, [e.kind]: (map[e.kind] ?? 0) + 1 }), {}),
  };
  record.changes = result.changes
    ? {
        added: result.changes.added.length,
        removed: result.changes.removed.length,
        modified: result.changes.modified.length,
      }
    : null;
  const scale = scaleOf(result);
  record.checks =
    done?.state === 'succeeded' && result.scene
      ? evaluate(s.checks, {
          scene: result.scene,
          changes: result.changes,
          baseScene: basisScene,
          scale,
          baseScale: basisScale,
        })
      : [{ type: 'state', ok: false, detail: record.error ?? `state ${record.state}` }];
  if (s.expect.route) record.checks.push(routeCheck(s.expect.route, record.route, s.host));
  record.success = record.checks.every((c) => c.ok);
  record.answer = typeof result.text === 'string' ? result.text.slice(0, 2000) : null;
  if (result.scene) {
    const highlight = [
      ...(result.changes?.added ?? []),
      ...(result.changes?.modified ?? []).map((m) => m.id),
    ];
    record.capture = `${s.id}-${record.attempt}.svg`;
    await writeFile(
      join(out, record.capture),
      captureSvg(result.scene, { scale, highlight, title: `${s.id} ${s.body}` }),
    );
  }
  // The engine writes request-stages/request-end when the run ends (gathered, flushed within ~1 s).
  const endedAt = new Date().toISOString();
  if (accepted) {
    for (let tries = 0; tries < 5; tries++) {
      const joined = readStages({ logsDir, requestId: record.requestId, startedAt, endedAt });
      record.stages = joined.stages;
      record.end = joined.end;
      if (joined.stages && joined.end) break;
      await wait(1000);
    }
  }
  record.joinedStages = record.stages !== null;
  record.end ??= done ? { state: done.state, code: done.result?.code ?? null, from: 'request' } : null;
  // Record-level checks (reconnectHonest, R1-RECONNECT, T-279) judge how the request ended; they
  // replace the scene checks and the plain 'state' failure.
  const fromRecord = s.checks.filter((c) => checks.RECORD_CHECKS?.has(c.type));
  if (fromRecord.length) {
    record.checks = [
      ...fromRecord.map((c) => checks.recordCheck(c, record)),
      ...record.checks.filter((c) => c.type === 'route'),
    ];
    record.success = record.checks.every((c) => c.ok);
  }
  record.crashes =
    countCrashes({ logsDir, startedAt, endedAt: new Date().toISOString() }) + (record.engineLost ? 1 : 0);
  // --chain: the next request starts from this candidate (like one terminal session without undo).
  if (args.chain && done?.state === 'succeeded' && result.scene) basis = done;
  return done;
}

// --- scenarios ---------------------------------------------------------------------------------
for (const s of scenarios) {
  for (let attempt = 1; attempt <= s.repeat; attempt++) {
    const record = blank(s, attempt);
    let done;
    if (s.kind === 'sync') {
      record.runStatus = 'untested';
      record.state = 'not-run';
      record.note = 'Sync performance is measured by tests/integration/rhino-sync-perf.mjs, not here.';
      record.checks = [{ type: 'state', ok: false, detail: 'untested (sync)' }];
    } else {
      // A driver fault in one attempt must not end the plan: the attempt is recorded driver-failed
      // and the next one runs (every planned scenario keeps a run status, T-267).
      try {
        if (s.kind === 'route-only') await routeOnly(s, record);
        else done = await request(s, record);
      } catch (error) {
        record.runStatus = 'driver-failed';
        record.error = 'driver: ' + String(error?.message ?? error);
        record.checks = [{ type: 'state', ok: false, detail: record.error }];
        record.success = false;
      }
    }
    record.misreport = typeof checks.misreport === 'function' ? checks.misreport(record) : null;
    // --fresh-project: a request that ended 'unknown' leaves the project's document state in
    // doubt; the following scenarios run in a new project (its base Sync is looked up again).
    if (args['fresh-project'] && done?.state === 'unknown') {
      try {
        const created = await call('/projects', { name: `${LOOP_PROJECT} fresh ${stamp}-${s.id}-${attempt}` });
        record.freshProjectAfter = created.id;
        project = created;
        basis = undefined;
      } catch (error) {
        record.freshProjectError = String(error?.message ?? error);
      }
    }
    run.results.push(record);
    const flags = record.misreport?.flags?.length ? ' ' + record.misreport.flags.join(',') : '';
    const route = record.route ? ` → ${record.route.target ?? '-'}${record.route.jig ? ' ' + record.route.jig : ''} (${record.route.by ?? '-'})` : '';
    const stages = record.stages ? `, total ${(record.stages.totalMs / 1000).toFixed(1)} s` : '';
    console.log(
      `${s.id}#${attempt} ${record.runStatus === 'completed' ? (record.success ? 'PASS' : 'FAIL') : record.runStatus.toUpperCase()} ` +
        `${record.state} ${record.ms == null ? '-' : (record.ms / 1000).toFixed(1) + ' s'}${route}${stages}` +
        (s.kind === 'request' ? `, tokens ${record.tokens ?? '-'}, stages ${record.joinedStages ? 'joined' : 'missing'}` : '') +
        (record.crashes ? `, crashes ${record.crashes}` : '') +
        flags +
        (record.success || record.runStatus === 'untested'
          ? ''
          : ' — ' +
            record.checks
              .filter((c) => !c.ok)
              .map((c) => c.detail)
              .join('; ')),
    );
    await writeFile(join(out, 'results.json'), JSON.stringify(run, null, 2));
  }
}
run.endedAt = new Date().toISOString();
run.logLines = countLogLines({ logsDir, startedAt: run.startedAt, endedAt: run.endedAt });
if (!run.logLines)
  console.warn(
    `logs: no engine line in ${logsDir} during the run — is it this engine's logs dir? (stages, exits and route reasons were not read)`,
  );
await writeFile(join(out, 'results.json'), JSON.stringify(run, null, 2));

// Rows to paste into the SPIKE table (engine column).
const rows = run.results.map(
  (r) =>
    `| ${r.id}${r.repeat > 1 ? '#' + r.attempt : ''} | VIDE | ${r.runStatus !== 'completed' ? '미시험' : r.success ? '성공' : '실패'} | ` +
    `${r.ms == null ? '-' : (r.ms / 1000).toFixed(r.kind === 'route-only' ? 1 : 0)} | ${r.tokens ?? '-'} | ` +
    `${r.toolCalls ? `${r.toolCalls.hostQueries ?? '-'}+${r.toolCalls.hostCommands ?? '-'}` : r.route ? `${r.route.target ?? '-'}${r.route.jig ? ' ' + r.route.jig : ''}` : '-'} | ${r.capture ?? '-'} | ` +
    `${
      r.checks
        .map((c) => (c.ok ? '' : c.detail))
        .filter(Boolean)
        .join('; ') || '-'
    } |`,
);
await writeFile(join(out, 'rows.md'), rows.join('\n') + '\n');
console.log('\n' + rows.join('\n') + `\n\nSaved ${join(out, 'results.json')}`);
