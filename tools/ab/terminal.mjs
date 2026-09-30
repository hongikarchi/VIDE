#!/usr/bin/env node
// AI parity A/B, terminal side (SPIKE-2026-09-30-ai-parity-ab): scores one request run in the
// terminal Claude Code with the same checks as the engine run. Reads two scene dumps written by
// dump_scene.py (the fixture before, the document after) and, when given, the Claude Code log.
//
//   node tools/ab/terminal.mjs --request R1 --after .vide/ab/terminal/R1.json
//     [--before .vide/ab/terminal/fixture.json] [--log R1.jsonl] [--seconds 95 --tokens 41000 --tools 14]
//
// --log: `claude -p … --output-format stream-json --verbose > R1.jsonl` (tool calls counted from
// tool_use blocks, time and tokens from the result line) or `--output-format json` (no tool count).
// Hand-recorded numbers (--seconds, --tokens, --tools) override the log.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { captureSvg, diff, evaluate } from './checks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    request: { type: 'string' },
    before: { type: 'string', default: '.vide/ab/terminal/fixture.json' },
    after: { type: 'string' },
    log: { type: 'string' },
    seconds: { type: 'string' },
    tokens: { type: 'string' },
    tools: { type: 'string' },
    out: { type: 'string', default: '.vide/ab/terminal' },
  },
});
const plan = JSON.parse(await readFile(join(here, 'requests.json'), 'utf8'));
const item = plan.requests.find((r) => r.id === args.request);
if (!item) throw new Error('--request must be one of ' + plan.requests.map((r) => r.id).join(', '));
const after = resolve(args.after ?? join(args.out, item.id + '.json'));
const readScene = async (path) => JSON.parse(await readFile(path, 'utf8')).scene;
const before = await readScene(resolve(args.before));
const scene = await readScene(after);

const changes = diff(before, scene);
const checks = evaluate(item.checks, { scene, changes, baseScene: before });

const metrics = { seconds: null, tokens: null, usage: null, toolCalls: null, rhinoToolCalls: null };
if (args.log) {
  const text = await readFile(resolve(args.log), 'utf8');
  const lines = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const uses = lines
    .filter((l) => l.type === 'assistant')
    .flatMap((l) => l.message?.content ?? [])
    .filter((c) => c.type === 'tool_use');
  const final = lines.findLast((l) => l.type === 'result');
  if (lines.some((l) => l.type === 'assistant')) {
    metrics.toolCalls = uses.length;
    metrics.rhinoToolCalls = uses.filter((u) => String(u.name).startsWith('mcp__rhino__')).length;
  }
  if (final) {
    metrics.seconds = final.duration_ms != null ? Math.round(final.duration_ms / 1000) : null;
    metrics.usage = final.usage ?? null;
    metrics.tokens = final.usage
      ? [
          'input_tokens',
          'output_tokens',
          'cache_read_input_tokens',
          'cache_creation_input_tokens',
        ].reduce((sum, key) => sum + (final.usage[key] ?? 0), 0)
      : null;
    metrics.turns = final.num_turns ?? null;
  }
}
if (args.seconds) metrics.seconds = Number(args.seconds);
if (args.tokens) metrics.tokens = Number(args.tokens);
if (args.tools) metrics.toolCalls = Number(args.tools);

const success = checks.every((c) => c.ok);
await mkdir(resolve(args.out), { recursive: true });
const capture = join(resolve(args.out), item.id + '.svg');
await writeFile(
  capture,
  captureSvg(scene, {
    highlight: [...changes.added, ...changes.modified.map((m) => m.id)],
    title: `${item.id} ${item.body} (터미널)`,
  }),
);
const record = {
  id: item.id,
  body: item.body,
  success,
  checks,
  changes: {
    added: changes.added.length,
    removed: changes.removed.length,
    modified: changes.modified.length,
  },
  ...metrics,
  capture,
};
const resultsPath = join(resolve(args.out), 'results.json');
const results = await readFile(resultsPath, 'utf8')
  .then((t) => JSON.parse(t))
  .catch(() => ({ results: [] }));
results.results = [...results.results.filter((r) => r.id !== item.id), record];
await writeFile(resultsPath, JSON.stringify(results, null, 2));
console.log(
  `| ${item.id} | 터미널 | ${success ? '성공' : '실패'} | ${metrics.seconds ?? '-'} | ${metrics.tokens ?? '-'} | ` +
    `${metrics.toolCalls ?? '-'}${metrics.rhinoToolCalls != null ? ` (rhino ${metrics.rhinoToolCalls})` : ''} | ` +
    `${item.id}.svg | ${
      checks
        .map((c) => (c.ok ? '' : c.detail))
        .filter(Boolean)
        .join('; ') || '-'
    } |`,
);
