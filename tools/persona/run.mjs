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
//     [--no-fresh-conversation] [--no-fresh-jigs] [--idle-timeout 600] [--answers <json | file.json>]
//     [--no-host-check] [--logs <engine logs dir>] [--no-after-goal]
//
// Native selects (T-292): a click that lands on a <select> (document.elementFromPoint) does not
// open Chrome's popup, which a screenshot never shows; the driver reads the options and lists them
// in the next prompt, and the persona answers {"type":"select","index"|"text"}; the driver applies
// it with selectOption (input + change events). After the goal (T-292): a scenario's `afterGoal`
// (R1-HIDE: undo) runs once the persona loop ends — U (or the toast's 되돌리기) — and records
// whether the view's hidden count went back to 0 (`afterGoal.undoRestored`).
//
// Hosts (T-286): the scenario's `hosts` (e.g. ["rhino"]) must match the project's open links before
// the run starts (GET …/links); an open link of another host or a missing one ends the run
// 'untested' with the reason — round 2 ran Rhino scenarios with ZWCAD linked and every request went
// to zwcad. Operator answers (T-286): when the persona asks (`ask_operator`, a fact such as the site
// address), the driver answers from the scenario's `operator` block merged with --answers, logs it
// in steps.jsonl and run.json (`operatorAnswers`), and the persona goes on with the answer.
//
// Isolation (T-280): by default each run starts in a new conversation (POST …/conversations, shown
// by presetting the UI's remembered tab) after the project's queued/running requests have ended.
// Jigs (T-280, --fresh-jigs, default on): for the scenario's `jigs`, the conversations bound to
// that jig's workbooks are closed and a new workbook is made, so the run's jig start opens it and a
// new conversation instead of resuming an earlier run's (isolation.mjs; `isolation` in run.json).
// After the run each request's CLI start (`resume`) is read from the engine log (`cliSessions`).
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
import { identifyEngine, personEngines, readStages } from '../ab/stages.mjs';
import { cliSessions, isolateJigs, scenarioJigs } from './isolation.mjs';
import {
  VIEWPORT,
  apiAllowed,
  canaryStep,
  hostsCheck,
  operatorAnswer,
  personaStep,
  resolveSelect,
  selectChoices,
  undoVerdict,
} from './persona-step.mjs';

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
    'fresh-jigs': { type: 'boolean', default: true },
    logs: { type: 'string' },
    'idle-timeout': { type: 'string', default: '600' },
    answers: { type: 'string' },
    'host-check': { type: 'boolean', default: true },
    'after-goal': { type: 'boolean', default: true },
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
// Facts the operator (a senior) tells when the persona asks: the scenario's block, then --answers
// (inline JSON or a .json file) over it.
const answersArg = args.answers?.trim();
const operator = {
  ...(scenario.operator ?? {}),
  ...(answersArg
    ? JSON.parse(
        answersArg.startsWith('{') ? answersArg : await readFile(resolve(answersArg), 'utf8'),
      )
    : {}),
};
const hosts = Array.isArray(scenario.hosts) ? scenario.hosts : null;
const jigs = scenarioJigs(scenario); // the jigs the run is expected to open (T-280)

// BANNED words on screen (PLAN-51 §2 ①): internal terms a non-developer must never see.
const BANNED = /SPEC-|PLAN-|JIG|hostUse|LINK_NOT_LIVE|세션|토큰|bake|overlay|handoff|stale/g;

// --- engine session --------------------------------------------------------------------------
const launchFile = args.launch ? null : resolve(args['launch-file']);
const launch = new URL(args.launch ?? JSON.parse(await readFile(launchFile, 'utf8')).url);
const origin = launch.origin;
const engines = personEngines({ root });
const identity = identifyEngine({
  origin,
  launchFile,
  logsDir: launchFile && join(dirname(launchFile), 'logs'),
  engines,
});
// The engine log, read only (CLI starts per request): --logs, the launch file's, or the engine's.
const engineDir = engines.find((engine) => engine.kind === identity.kind)?.dir;
const logsDir = args.logs
  ? resolve(args.logs)
  : launchFile
    ? join(dirname(launchFile), 'logs')
    : engineDir
      ? join(engineDir, 'logs')
      : null;
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
  hosts, // the scenario's hosts (T-286); null when the scenario does not say
  hostCheck: null, // { ok, reason?, open[] } from GET …/links before the run
  operatorAnswers: [], // { step, field, question?, answer|null, reason? } (ask_operator)
  jigs, // the scenario's expected jigs (T-280); null when the scenario does not say
  isolation: null, // { status: full|partial|none|off, jigs[], limits[] } (isolation.mjs)
  logsDir,
  cliSessions: [], // { requestId, cliStarts, resume|null, provider, model } from the engine log
  selects: 0, // select actions applied to a native <select> (T-292)
  afterGoal: null, // the scenario's afterGoal check (T-292): { type, how, hiddenBefore, hiddenAfter, undoRestored, … }
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
  // Hosts (T-286): the project's open links must be exactly the scenario's hosts.
  if (hosts && args['host-check']) {
    run.hostCheck = hostsCheck(await api(`/projects/${project.id}/links`), hosts);
    if (!run.hostCheck.ok) {
      run.status = 'untested';
      run.reason = run.hostCheck.reason;
      throw Object.assign(new Error(run.reason), { handled: true });
    }
  }

  // Canary: the persona must not already know the product words (else the run is 미시험).
  const canary = await canaryStep({ personaFile, claude: args.claude });
  run.canary = { asked: true, answeredUnknown: canary.answeredUnknown, answer: canary.answer };
  run.model = canary.model;
  if (!canary.answeredUnknown) {
    run.status = 'untested';
    run.reason = 'canary: the persona did not answer that it does not know the words';
    throw Object.assign(new Error(run.reason), { handled: true });
  }

  if (args['fresh-conversation'] || (args['fresh-jigs'] && jigs?.length)) {
    try {
      await waitIdle(Number(args['idle-timeout']) * 1000);
    } catch (error) {
      run.status = 'untested';
      run.reason = 'isolation: ' + String(error?.message ?? error);
      throw Object.assign(new Error(run.reason), { handled: true });
    }
  }
  // Jigs (T-280): close the conversations on the jig's workbooks and make a new latest workbook.
  if (!args['fresh-jigs']) run.isolation = { status: 'off', jigs: [], limits: [] };
  else if (jigs?.length) {
    run.isolation = await isolateJigs({ api, projectId: project.id, jigs });
    for (const row of run.isolation.jigs)
      console.log(
        `isolation ${row.jig}: ${row.kind ?? 'unknown'}, closed ${row.closedConversations.length}` +
          `, unbound ${row.unboundConversations.length}, new workbook ${row.freshWorkbook ?? '-'}` +
          (row.errors.length ? ` — ${row.errors.join('; ')}` : ''),
      );
  } else run.isolation = { status: 'none', jigs: [], limits: [] };
  if (args['fresh-conversation']) {
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
  // The native <select> the last click landed on (T-292): its handle, point and numbered choices.
  let open = null;
  const closeSelect = async () => {
    await open?.handle.dispose().catch(() => {});
    open = null;
  };
  /** The enabled <select> under a point (or the one its <label> names), as a handle, or null. */
  const selectAt = async (x, y) => {
    const handle = await page.evaluateHandle(
      ([px, py]) => {
        const hit = document.elementFromPoint(px, py);
        const select = hit?.closest?.('select') ?? (hit?.tagName === 'LABEL' ? hit.control : null);
        return select instanceof HTMLSelectElement && !select.disabled ? select : null;
      },
      [x, y],
    );
    const element = handle.asElement();
    if (!element) await handle.dispose();
    return element;
  };
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
        choices: open?.choices ?? null,
      });
    } catch (error) {
      run.status = 'driver-failed';
      run.reason = String(error?.message ?? error);
      break;
    }
    run.model ??= persona.meta?.model ?? null;
    const action = persona.action;
    let selectOpened; // the choices offered after a click on a native <select>
    let selected; // the outcome of a select action
    if (action.type === 'select') {
      const resolved = resolveSelect(action, open?.choices);
      if (!resolved.ok) selected = { ok: false, reason: resolved.reason };
      else {
        const { n, text: optionText, value, optionIndex } = resolved.choice;
        selected = { n, text: optionText, value };
        try {
          // A re-render may have replaced the element: find it again at the clicked point.
          let target = open.handle;
          if (!(await target.evaluate((el) => el.isConnected).catch(() => false)))
            target = (await selectAt(open.x, open.y)) ?? target;
          await target.selectOption({ index: optionIndex }); // dispatches input and change
          selected.ok = true;
          run.selects++;
        } catch (error) {
          selected.ok = false;
          selected.reason = String(error?.message ?? error).split('\n')[0];
        }
      }
      await closeSelect();
    } else if (action.type === 'click') {
      await closeSelect();
      const element = await selectAt(action.x, action.y);
      const options = element
        ? await element.evaluate((el) =>
            [...el.options].map((o) => ({ text: o.text, value: o.value, disabled: o.disabled })),
          )
        : [];
      const choices = selectChoices(options);
      if (element && choices.length) {
        // Chrome draws the opened list outside the page (no screenshot shows it): focus the field
        // and hand the persona its options as text instead.
        await element.focus().catch(() => {});
        const label = await element
          .evaluate((el) => el.getAttribute('aria-label') || el.labels?.[0]?.innerText || '')
          .catch(() => '');
        open = { handle: element, x: action.x, y: action.y, choices };
        selectOpened = {
          label,
          choices: choices.map(({ n, text: t, value }) => ({ n, text: t, value })),
        };
      } else {
        await element?.dispose();
        await page.mouse.click(action.x, action.y);
      }
    } else await closeSelect();
    if (action.type === 'type') {
      if (action.x != null) await page.mouse.click(action.x, action.y);
      await page.keyboard.type(action.text ?? '');
      if (action.submit) await page.keyboard.press('Enter');
      run.typedInputs++;
    }
    // ask_operator: no screen action; the operator's answer goes into the persona's next prompt.
    let told;
    if (action.type === 'ask_operator') {
      told = operatorAnswer(operator, action, run.operatorAnswers.length);
      run.operatorAnswers.push({ step, ...told });
    }
    await page.waitForTimeout(action.type === 'wait' ? 5000 : told ? 300 : 1500);
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
    // An answered ask is progress (the persona learnt a fact), not a no-progress step.
    const answered = !!told?.answer;
    if (
      !answered &&
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
      ...(told ? { operatorAnswers: [told] } : {}),
      ...(selectOpened ? { selectOpened } : {}),
      ...(selected ? { selected } : {}),
      ms: meta?.ms,
    };
    history.push(entry);
    await appendFile(join(out, 'steps.jsonl'), JSON.stringify(entry) + '\n');
    run.steps = step;
    run.unknownWords = [...unknown];
    run.bannedWords = [...banned];
    await save();
    console.log(
      `${step}. ${action.type}${action.x != null ? ` (${action.x},${action.y})` : ''}${action.text ? ` "${action.text}"` : ''}` +
        (told ? ` ${told.field} → ${told.answer ?? `(no answer: ${told.reason})`}` : '') +
        (selectOpened ? ` select [${selectOpened.choices.length} choices]` : '') +
        (selected
          ? ` → ${selected.ok ? `'${selected.text}'` : `failed: ${selected.reason}`}`
          : '') +
        ` — ${persona.sees.slice(0, 80)}`,
    );
    if (action.type === 'done' || persona.done) {
      run.personaDone = true;
      break;
    }
    if (action.type === 'declare_stuck') break;
  }
  await closeSelect();
  // After the goal (T-292): e.g. R1-HIDE's undo — U (or the toast's 되돌리기) must bring the
  // hidden objects back. Read through the viewport API the screen itself uses (window.videViewport).
  const after = scenario.afterGoal;
  if (after?.type === 'undo' && args['after-goal'] && run.status === 'completed' && run.steps) {
    const hiddenCount = () =>
      page
        .evaluate(() => {
          const viewport = window.videViewport;
          return typeof viewport?.hiddenCount === 'function' ? viewport.hiddenCount() : null;
        })
        .catch(() => null);
    const hiddenBefore = await hiddenCount();
    const label = after.toastButton ?? '되돌리기';
    const button = page
      .locator('#message:not([hidden]) .message-action', { hasText: label })
      .first();
    let how;
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      how = 'toast:' + label;
    } else {
      // Keys reach the 3D view only when no input has focus (src/ui/app/viewport.ts viewKeys).
      await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
      await page.keyboard.press(after.key ?? 'u');
      how = 'key:' + (after.key ?? 'u');
    }
    await page.waitForTimeout(1500);
    const hiddenAfter = await hiddenCount();
    const screenshot = 'steps/after-goal.png';
    await page.screenshot({ path: join(out, screenshot) }).catch(() => {});
    run.afterGoal = {
      type: 'undo',
      how,
      personaDone: run.personaDone,
      hiddenBefore,
      hiddenAfter,
      ...undoVerdict(hiddenBefore, hiddenAfter),
      screenshot,
    };
    console.log(
      `after goal: ${how}, hidden ${hiddenBefore} → ${hiddenAfter}, undoRestored ${run.afterGoal.undoRestored}`,
    );
  } else if (after)
    run.afterGoal = {
      type: after.type,
      skipped: args['after-goal'] ? `run ${run.status}` : 'off',
      undoRestored: null,
    };
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
  // Each request's CLI start from the engine log: resume true = it went on an earlier session.
  try {
    run.cliSessions = cliSessions(
      run.requestIds,
      (requestId) =>
        readStages({ logsDir, requestId, startedAt: run.startedAt, endedAt: run.endedAt }).lines,
    );
  } catch {
    /* the log is optional evidence */
  }
  await save();
  await browser?.close().catch(() => {});
}
console.log(
  `${run.scenario} ${run.status}: steps ${run.steps}, stuck ${run.stuck} (declared ${run.stuckDeclared}, ` +
    `no-progress ${run.noProgressPairs}, flagged ${run.stuckFlagged}), wrong ${run.wrongClicks}, ` +
    `unknown [${run.unknownWords.join(', ')}], banned [${run.bannedWords.join(', ')}]\nSaved ${join(out, 'run.json')}`,
);
