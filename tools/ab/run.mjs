#!/usr/bin/env node
// AI parity A/B, engine side (SPIKE-2026-09-30-ai-parity-ab). Sends the five fixed modelling
// requests of requests.json through a RUNNING dev engine's conversation API, waits for each, and
// records success (checked on the candidate model), time, tokens, tool calls and a picture.
// It never launches Rhino and never applies to the source document (candidate permission only).
//
//   node tools/ab/run.mjs [--launch <url#token> | --launch-file .vide/dev-data/launch.json]
//     [--project <id>] [--base <sync request id>] [--match ab-fixture]
//     [--provider claude-cli|codex-cli] [--model <id>] [--effort <level>]
//     [--only R1,R3] [--chain] [--timeout 900] [--scale auto|<n>] [--out <dir>] [--dry-run]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { captureSvg, diff, evaluate, objectOf } from './checks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    launch: { type: 'string' },
    'launch-file': { type: 'string', default: '.vide/dev-data/launch.json' },
    project: { type: 'string' },
    base: { type: 'string' },
    match: { type: 'string', default: 'ab-fixture' },
    provider: { type: 'string', default: 'claude-cli' },
    model: { type: 'string' },
    effort: { type: 'string' },
    only: { type: 'string' },
    chain: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '900' },
    scale: { type: 'string', default: 'auto' },
    out: { type: 'string' },
    'keep-applied': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

const plan = JSON.parse(await readFile(join(here, 'requests.json'), 'utf8'));
const chosen = args.only ? new Set(args.only.split(',').map((s) => s.trim())) : undefined;
const requests = plan.requests.filter((r) => !chosen || chosen.has(r.id));
if (!requests.length) throw new Error('No request matches --only ' + args.only);
if (args['dry-run']) {
  for (const r of requests)
    console.log(
      `${r.id} ${r.title}: ${r.body}\n  checks: ${r.checks.map((c) => c.type).join(', ')}`,
    );
  process.exit(0);
}

// --- engine session --------------------------------------------------------------------------
const launch = new URL(
  args.launch ?? JSON.parse(await readFile(resolve(args['launch-file']), 'utf8')).url,
);
if (launch.port === '47821')
  throw new Error('47821 is the installed work engine; run the A/B against a dev engine.');
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

// --- project and base Sync ---------------------------------------------------------------------
const projects = await call('/projects');
const project = args.project ? projects.find((p) => p.id === args.project) : projects[0];
if (!project) throw new Error('No project ' + (args.project ?? '(the engine has none)'));
let baseId = args.base;
if (!baseId) {
  // The newest Rhino Sync of the linked fixture (the list omits scenes: `sceneOmitted`).
  const syncs = (await call(`/projects/${project.id}/requests`)).filter(
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
const baseRequest = await call(`/projects/${project.id}/requests/${baseId}`);
const scaleOf = (result) =>
  args.scale !== 'auto' ? Number(args.scale) : result?.displayOnly === true ? 1000 : 1;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(args.out ?? join('.vide', 'ab', stamp));
await mkdir(out, { recursive: true });
const run = {
  startedAt: new Date().toISOString(),
  engine: origin,
  project: project.id,
  base: baseId,
  provider: args.provider,
  model: args.model ?? 'auto',
  effort: args.effort ?? 'default',
  chain: args.chain,
  results: [],
};
console.log(`A/B → ${origin}, project ${project.id}, base ${baseId}, out ${out}`);

const TERMINAL = new Set(['succeeded', 'failed', 'unknown', 'cancelled', 'interrupted']);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let basis = baseRequest;
for (const item of requests) {
  const basisScene = basis.result?.scene ?? [];
  const basisScale = scaleOf(basis.result);
  const conversation = await call(`/projects/${project.id}/conversations`, {
    title: `A/B ${item.id} ${item.title}`,
    body: item.body,
    provider: args.provider,
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    host: 'rhino',
    permission: 'candidate',
  });
  const pins = [];
  if (item.pin) {
    const target = basisScene.find((row) => objectOf(row).layer === item.pin.layer);
    if (target) pins.push({ id: target.id, basis: basis.id, role: item.pin.role });
  }
  const id = randomUUID();
  const began = Date.now();
  const record = { id: item.id, title: item.title, body: item.body, requestId: id };
  let done;
  try {
    await call(`/projects/${project.id}/requests`, {
      id,
      conversationId: conversation.id,
      body: item.body,
      permission: 'candidate',
      provider: args.provider,
      ...(args.effort ? { effort: args.effort } : {}),
      host: 'rhino',
      baseRequestId: basis.id,
      pins,
      sketches: [],
      files: [],
    });
    for (const end = began + Number(args.timeout) * 1000; ; ) {
      done = await call(`/projects/${project.id}/requests/${id}`);
      if (TERMINAL.has(done.state)) break;
      if (Date.now() > end) {
        await call(`/projects/${project.id}/requests/${id}/cancel`, {}).catch(() => {});
        record.timedOut = true;
        break;
      }
      await wait(2000);
    }
  } catch (error) {
    record.error = String(error?.message ?? error);
  }
  record.ms = Date.now() - began;
  let result = done?.result ?? {};
  // Auto mode applies directly to the attached document (ADR-022): the request result carries
  // executions, not a candidate scene. Sync the linked document again and diff it against the
  // basis, then (unless --keep-applied / --chain) revert every applied execution with the
  // product's [되돌리기] so the next request starts from the untouched fixture.
  const executions = Array.isArray(result.executions) ? result.executions : [];
  if (done && !result.scene && basis.input?.linkId && basis.result?.sourceDocument) {
    const target = {
      instance: basis.result.sourceDocument.instance,
      documentId: basis.result.sourceDocument.documentId,
    };
    const synced = await call(`/projects/${project.id}/capture`, {
      ...target,
      id: randomUUID(),
      linkId: basis.input.linkId,
    });
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
        const undone = await call(`/projects/${project.id}/requests/${id}/undo`, {
          executionId: entry.executionId,
        }).catch((error) => ({ ok: false, reason: String(error?.message ?? error) }));
        record.undo.push({
          executionId: entry.executionId,
          ok: undone.ok ?? !undone.reason,
          reason: undone.reason,
        });
      }
      const restored = await call(`/projects/${project.id}/capture`, {
        ...target,
        id: randomUUID(),
        linkId: basis.input.linkId,
      });
      const left = diff(basisScene, restored.result?.scene ?? []);
      record.restored = {
        added: left.added.length,
        removed: left.removed.length,
        modified: left.modified.length,
      };
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
  record.state = done?.state ?? 'not-sent';
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
      ? evaluate(item.checks, {
          scene: result.scene,
          changes: result.changes,
          baseScene: basisScene,
          scale,
          baseScale: basisScale,
        })
      : [{ type: 'state', ok: false, detail: record.error ?? `state ${record.state}` }];
  record.success = record.checks.every((c) => c.ok);
  record.answer = typeof result.text === 'string' ? result.text.slice(0, 2000) : null;
  if (result.scene) {
    const highlight = [
      ...(result.changes?.added ?? []),
      ...(result.changes?.modified ?? []).map((m) => m.id),
    ];
    record.capture = `${item.id}.svg`;
    await writeFile(
      join(out, record.capture),
      captureSvg(result.scene, { scale, highlight, title: `${item.id} ${item.body}` }),
    );
  }
  run.results.push(record);
  console.log(
    `${item.id} ${record.success ? 'PASS' : 'FAIL'} ${record.state} ${(record.ms / 1000).toFixed(1)} s, ` +
      `tokens ${record.tokens ?? '-'}, host ${record.toolCalls.hostQueries ?? '-'}/${record.toolCalls.hostCommands ?? '-'}` +
      (record.success
        ? ''
        : ' — ' +
          record.checks
            .filter((c) => !c.ok)
            .map((c) => c.detail)
            .join('; ')),
  );
  // --chain: the next request starts from this candidate (like one terminal session without undo).
  if (args.chain && done?.state === 'succeeded' && result.scene) basis = done;
  await writeFile(join(out, 'results.json'), JSON.stringify(run, null, 2));
}

// Rows to paste into the SPIKE table (engine column).
const rows = run.results.map(
  (r) =>
    `| ${r.id} | VIDE | ${r.success ? '성공' : '실패'} | ${(r.ms / 1000).toFixed(0)} | ${r.tokens ?? '-'} | ` +
    `${r.toolCalls.hostQueries ?? '-'}+${r.toolCalls.hostCommands ?? '-'} | ${r.capture ?? '-'} | ` +
    `${
      r.checks
        .map((c) => (c.ok ? '' : c.detail))
        .filter(Boolean)
        .join('; ') || '-'
    } |`,
);
await writeFile(join(out, 'rows.md'), rows.join('\n') + '\n');
console.log('\n' + rows.join('\n') + `\n\nSaved ${join(out, 'results.json')}`);
