#!/usr/bin/env node
// Persona driver (PLAN-51 T-266, L1): a non-developer persona AI drives the engine's web UI from
// screenshots only. Each step: screenshot → personaStep (a new isolated `claude -p`) → one action
// (click / type / wait) → new data-request-id values → steps.jsonl. Stops on done, declare_stuck or
// --max-steps. Writes run.json (PLAN-51 contract item 5). The persona's thinking time is not product
// speed; this tool measures intuition and ease only.
//
//   node tools/persona/run.mjs --scenario R1-HIDE --project <id>
//     [--launch-file .vide/dev-data/launch.json | --launch <url#token>]
//     [--persona intern] [--max-steps 12] [--out .vide/persona/<stamp>] [--claude claude] [--headless]
//     [--no-fresh-conversation] [--idle-timeout 600]
//
// Isolation (T-280): by default each run starts in a new conversation (POST …/conversations, shown
// by presetting the UI's remembered tab) after the project's queued/running requests have ended.
// The document is not isolated here: the operator links a fresh .vide/ copy per run.
//
// On the person's engines — the installed one or their `npm run dev` one, recognised by port, by the
// origin in their launch.json or by the launch file's folder (tools/ab/stages.mjs identifyEngine) —
// it only runs in a project whose name starts with '검증 루프'. On every engine the page may write only
// inside that project (apiAllowed), and the run stops 'aborted' when the screen switches project.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { identifyEngine, personEngines } from '../ab/stages.mjs';
import { VIEWPORT, apiAllowed, canaryStep, personaStep } from './persona-step.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const { values: args } = parseArgs({
  options: {
    scenario: { type: 'string' },
    launch: { type: 'string' },
    'launch-file': { type: 'string', default: '.vide/dev-data/launch.json' },
    project: { type: 'string' },
    persona: { type: 'string', default: 'intern' },
    'max-steps': { type: 'string', default: '12' },
    out: { type: 'string' },
    claude: { type: 'string', default: 'claude' },
    headless: { type: 'boolean', default: false },
    'fresh-conversation': { type: 'boolean', default: true },
    'idle-timeout': { type: 'string', default: '600' },
  },
  allowNegative: true,
});
if (!args.scenario || !args.project)
  throw new Error('Usage: run.mjs --scenario <id> --project <id> [--launch-file|--launch] …');

const plan = JSON.parse(await readFile(join(here, 'scenarios.json'), 'utf8'));
const scenario = plan.scenarios.find((s) => s.id === args.scenario);
if (!scenario) throw new Error('No persona scenario ' + args.scenario);
const goal = plan.goalFrame.replace('{body}', scenario.body);
const personaFile = join(here, 'personas', `${args.persona}.md`);
const maxSteps = Number(args['max-steps']);

// BANNED words on screen (PLAN-51 §2 ①): internal terms a non-developer must never see.
const BANNED = /SPEC-|PLAN-|JIG|hostUse|LINK_NOT_LIVE|세션|토큰|bake|overlay|handoff|stale/g;

// --- engine session --------------------------------------------------------------------------
const launchFile = args.launch ? null : resolve(args['launch-file']);
const launch = new URL(args.launch ?? JSON.parse(await readFile(launchFile, 'utf8')).url);
const origin = launch.origin;
const identity = identifyEngine({
  origin,
  launchFile,
  logsDir: launchFile && join(dirname(launchFile), 'logs'),
  engines: personEngines({ root }),
});
const session = await fetch(origin + '/api/v1/session', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: launch.hash.slice(1) }),
});
const setCookie = session.headers.getSetCookie?.()[0];
const cookie = setCookie?.split(';')[0];
if (!session.ok || !cookie) throw new Error('Engine session failed: ' + session.status);
const projects = await (
  await fetch(origin + '/api/v1/projects', { headers: { Origin: origin, Cookie: cookie } })
).json();
const project = Array.isArray(projects) ? projects.find((p) => p.id === args.project) : undefined;
if (!project) throw new Error('No project ' + args.project);
if (identity.kind && !String(project.name ?? '').startsWith('검증 루프'))
  throw new Error(
    `That is the person's ${identity.kind} engine (${identity.why}): run only in a dedicated project named '검증 루프 …' (got '${project.name}').`,
  );

// --- output --------------------------------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(args.out ?? join('.vide', 'persona', `${stamp}-${scenario.id}`));
await mkdir(join(out, 'steps'), { recursive: true });
const run = {
  scenario: scenario.id,
  status: 'untested',
  canary: { asked: false, answeredUnknown: false },
  steps: 0,
  stuck: 0, // = stuckDeclared + noProgressPairs (PLAN-51 §2 '2단계 연속 무진전')
  stuckDeclared: 0, // declare_stuck actions
  stuckFlagged: 0, // steps the persona marked stuck:true (counted apart; scorecard P0 at ≥2)
  noProgressPairs: 0, // consecutive step pairs: no new request id, same visible text, same action type
  wrongClicks: 0,
  unknownWords: [],
  bannedWords: [],
  requestIds: [],
  typedInputs: 0,
  reachedGoal: null, // the persona's done is not accepted as result evidence (PLAN-51 §2 ⑤)
  goalReached: null, // set by the operator after reading the screenshots (true|false); scorecard reads it
  personaDone: false,
  startedAt: new Date().toISOString(),
  endedAt: null,
  model: null,
  engine: origin,
  project: project.id,
  persona: args.persona,
  goal,
  expertSteps: scenario.expertSteps,
  goalEvidence: scenario.goalEvidence,
  expect: scenario.expect ?? null, // result checks the scorecard applies (e.g. aiRequests: 0)
  engineKind: identity.kind ?? 'loop',
  blockedApi: [], // API calls the guard refused: { at, method, path, reason }
  conversation: null, // the fresh conversation of this run (--fresh-conversation)
};
const save = () => writeFile(join(out, 'run.json'), JSON.stringify(run, null, 2));
let aborted = false;
process.on('SIGINT', () => {
  aborted = true;
});
console.log(
  `persona ${args.persona} → ${origin}, project ${project.id}, ${scenario.id}, out ${out}`,
);

const api = async (path, body) => {
  const response = await fetch(origin + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
};
/** Waits until the project has no queued/running request (an earlier run's turn still going). */
async function waitIdle(timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (let said = false; ; ) {
    const rows = await api(`/projects/${project.id}/requests`);
    const busy = (Array.isArray(rows) ? rows : []).filter((r) =>
      ['queued', 'running'].includes(r.state),
    );
    if (!busy.length) return;
    if (Date.now() > end)
      throw new Error(
        `project still busy after ${timeoutMs / 1000} s: ${busy.map((r) => r.id).join(', ')}`,
      );
    if (!said) console.log(`waiting for ${busy.length} running request(s) in the project…`);
    said = true;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

let browser;
try {
  // Canary: the persona must not already know the product words (else the run is 미시험).
  const canary = await canaryStep({ personaFile, claude: args.claude });
  run.canary = { asked: true, answeredUnknown: canary.answeredUnknown, answer: canary.answer };
  run.model = canary.model;
  if (!canary.answeredUnknown) {
    run.status = 'untested';
    run.reason = 'canary: the persona did not answer that it does not know the words';
    throw Object.assign(new Error(run.reason), { handled: true });
  }

  if (args['fresh-conversation']) {
    try {
      await waitIdle(Number(args['idle-timeout']) * 1000);
    } catch (error) {
      run.status = 'untested';
      run.reason = 'isolation: ' + String(error?.message ?? error);
      throw Object.assign(new Error(run.reason), { handled: true });
    }
    // Same call as the [+] tab button (src/ui/conversations.tsx): an empty general conversation.
    run.conversation = (await api(`/projects/${project.id}/conversations`, { kind: 'general' })).id;
  }

  browser = await chromium.launch({ channel: 'chrome', headless: args.headless });
  const context = await browser.newContext({ viewport: VIEWPORT }); // fresh: no storage
  // The UI reopens the tab remembered under vide:conversation:<project> (src/ui/draft-storage.ts
  // lastConversation); a fresh context has none, so preset it once to this run's conversation.
  if (run.conversation)
    await context.addInitScript(
      ([key, id]) => {
        try {
          if (!localStorage.getItem(key)) localStorage.setItem(key, id);
        } catch {
          /* storage unavailable: the default conversation shows */
        }
      },
      ['vide:conversation:' + project.id, run.conversation],
    );
  const [name, ...rest] = cookie.split('=');
  await context.addCookies([{ name, value: rest.join('='), url: origin }]);
  // Never leave the engine's origin: other-origin page navigations are aborted, popups closed.
  // On the engine's API the page writes only inside the loop project (apiAllowed).
  await context.route('**/*', (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && new URL(request.url()).origin !== origin)
      return route.abort();
    const verdict = apiAllowed({
      method: request.method(),
      url: request.url(),
      origin,
      projectId: project.id,
    });
    if (!verdict.allow) {
      run.blockedApi.push({
        at: new Date().toISOString(),
        method: request.method(),
        path: new URL(request.url()).pathname,
        reason: verdict.reason,
      });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await context.newPage();
  context.on('page', (opened) => opened !== page && opened.close().catch(() => {}));
  page.setDefaultTimeout(20_000);
  await page.goto(`${origin}/?project=${encodeURIComponent(project.id)}`);
  await page
    .waitForFunction(() => document.querySelector('#project-picker')?.value, null, {
      timeout: 30_000,
    })
    .catch(() => {});
  await page.waitForTimeout(1500);

  const requestIdsOnPage = () =>
    page.$$eval('[data-request-id]', (nodes) =>
      nodes.map((n) => n.getAttribute('data-request-id')),
    );
  const seen = new Set(await requestIdsOnPage()); // ids already on screen are not this run's
  // The project on screen (picker value, else ?project=): another one stops the run.
  const shownProject = () =>
    page
      .evaluate(
        () =>
          document.querySelector('#project-picker')?.value ||
          new URL(location.href).searchParams.get('project') ||
          null,
      )
      .catch(() => null);
  const unknown = new Set();
  const banned = new Set();
  const history = [];
  let previous;
  run.status = 'completed';
  for (let step = 1; step <= maxSteps; step++) {
    if (aborted) {
      run.status = 'aborted';
      break;
    }
    const shown = await shownProject();
    if (shown && shown !== project.id) {
      run.status = 'aborted';
      run.reason = `the screen switched to project ${shown}; the persona stays in ${project.id}`;
      break;
    }
    const screenshot = join('steps', `${String(step).padStart(2, '0')}.png`);
    await page.screenshot({ path: join(out, screenshot) });
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    const textHash = createHash('sha256').update(text).digest('hex');
    for (const match of text.matchAll(BANNED)) banned.add(match[0]);
    let persona;
    try {
      persona = await personaStep({
        goal,
        screenshotPath: join(out, screenshot),
        history,
        personaFile,
        claude: args.claude,
      });
    } catch (error) {
      run.status = 'driver-failed';
      run.reason = String(error?.message ?? error);
      break;
    }
    run.model ??= persona.meta?.model ?? null;
    const action = persona.action;
    if (action.type === 'click') await page.mouse.click(action.x, action.y);
    if (action.type === 'type') {
      if (action.x != null) await page.mouse.click(action.x, action.y);
      await page.keyboard.type(action.text ?? '');
      if (action.submit) await page.keyboard.press('Enter');
      run.typedInputs++;
    }
    await page.waitForTimeout(action.type === 'wait' ? 5000 : 1500);
    const fresh = (await requestIdsOnPage()).filter((id) => id && !seen.has(id));
    for (const id of fresh) seen.add(id);
    run.requestIds.push(...fresh);

    for (const word of persona.unknownWords) unknown.add(word);
    if (persona.wrongTurn) run.wrongClicks++;
    if (action.type === 'declare_stuck') run.stuckDeclared++;
    if (persona.stuck === true) run.stuckFlagged++;
    // No progress (PLAN-51 §2): two consecutive steps that both brought no new request id, saw the
    // same visible text (innerText hash, so a blinking cursor does not hide it) and chose the same
    // action type.
    if (
      previous &&
      !previous.fresh &&
      !fresh.length &&
      previous.textHash === textHash &&
      previous.actionType === action.type
    )
      run.noProgressPairs++;
    previous = { textHash, actionType: action.type, fresh: fresh.length };
    run.stuck = run.stuckDeclared + run.noProgressPairs;

    const { meta, ...said } = persona;
    const entry = {
      step,
      at: new Date().toISOString(),
      screenshot: screenshot.replace(/\\/g, '/'),
      persona: said,
      visibleTextLength: text.length,
      textHash: textHash.slice(0, 16),
      requestIds: fresh,
      ms: meta?.ms,
    };
    history.push(entry);
    await appendFile(join(out, 'steps.jsonl'), JSON.stringify(entry) + '\n');
    run.steps = step;
    run.unknownWords = [...unknown];
    run.bannedWords = [...banned];
    await save();
    console.log(
      `${step}. ${action.type}${action.x != null ? ` (${action.x},${action.y})` : ''}${action.text ? ` "${action.text}"` : ''} — ${persona.sees.slice(0, 80)}`,
    );
    if (action.type === 'done' || persona.done) {
      run.personaDone = true;
      break;
    }
    if (action.type === 'declare_stuck') break;
  }
  if (run.steps === 0 && run.status === 'completed') {
    run.status = 'untested';
    run.reason = 'no screenshot step was taken';
  }
} catch (error) {
  if (!error?.handled) {
    run.status = 'driver-failed';
    run.reason ??= String(error?.message ?? error);
  }
} finally {
  if (aborted && run.status === 'completed') run.status = 'aborted';
  run.endedAt = new Date().toISOString();
  await save();
  await browser?.close().catch(() => {});
}
console.log(
  `${run.scenario} ${run.status}: steps ${run.steps}, stuck ${run.stuck} (declared ${run.stuckDeclared}, ` +
    `no-progress ${run.noProgressPairs}, flagged ${run.stuckFlagged}), wrong ${run.wrongClicks}, ` +
    `unknown [${run.unknownWords.join(', ')}], banned [${run.bannedWords.join(', ')}]\nSaved ${join(out, 'run.json')}`,
);
