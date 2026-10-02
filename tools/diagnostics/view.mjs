#!/usr/bin/env node
// Reads VIDE's diagnostic logs (T-126): the engine's, the Rhino and ZWCAD plugins' and the PC
// program's lines of a day merged by time, filtered to failures, one request's timeline or one event.
//
//   node tools/diagnostics/view.mjs [--data <folder>] [--day YYYY-MM-DD|all] [--failures]
//        [--request <id>] [--event <name>] [--part engine,rhino,zwcad,shell] [--json]
//
// --data takes the VIDE data folder (default %LOCALAPPDATA%\VIDE), its logs folder or an unzipped
// diagnostic bundle. Unreadable lines are counted and reported, never fatal.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
if (args.includes('--help')) {
  console.log(
    'node tools/diagnostics/view.mjs [--data <folder>] [--day YYYY-MM-DD|all] [--failures] [--request <id>] [--event <name>] [--part engine,rhino,zwcad,shell] [--json]',
  );
  process.exit(0);
}
const data = resolve(value('--data') ?? join(process.env.LOCALAPPDATA || homedir(), 'VIDE'));
const folder = existsSync(join(data, 'logs')) ? join(data, 'logs') : data;
const day = value('--day') ?? new Date().toISOString().slice(0, 10);
const parts = (value('--part') ?? 'engine,rhino,zwcad,shell').split(',');
const request = value('--request');
const event = value('--event');
const failures = args.includes('--failures');

const FAILED_EVENT = /fail|error|crash|unhandled|refused|cap|given-up|exception/i;
const FAILED_STATE = new Set(['failed', 'unknown', 'interrupted', 'cancelled']);
/** A line that reports something going wrong. */
export function isFailure(line) {
  return (
    FAILED_EVENT.test(String(line.event)) ||
    line.ok === false ||
    FAILED_STATE.has(line.state) ||
    (line.event === 'engine-exit' && line.code !== 0 && line.asked !== true) ||
    (line.event === 'cli-exit' && line.code !== 0)
  );
}

const lines = [];
let unreadable = 0;
const name = /^(engine|rhino|zwcad|shell)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const files = existsSync(folder) ? readdirSync(folder) : [];
for (const file of files.sort()) {
  const match = name.exec(file);
  const fixed = file === 'engine-exits.jsonl' && parts.includes('shell');
  if (!fixed && (!match || !parts.includes(match[1]) || (day !== 'all' && match[2] !== day)))
    continue;
  const part = match ? match[1] : 'shell';
  for (const text of readFileSync(join(folder, file), 'utf8').split('\n')) {
    if (!text.trim()) continue;
    let line;
    try {
      line = JSON.parse(text);
    } catch {
      unreadable++;
      continue;
    }
    if (fixed && day !== 'all' && !String(line.at).startsWith(day)) continue;
    lines.push({ part, ...line });
  }
}
const chosen = lines
  .filter(
    (line) =>
      (!request || line.requestId === request || line.request === request) &&
      (!event || line.event === event) &&
      (!failures || isFailure(line)),
  )
  .sort((a, b) => String(a.at).localeCompare(String(b.at)));

const short = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 160 ? text.slice(0, 157) + '…' : text;
};
for (const line of chosen) {
  if (args.includes('--json')) {
    console.log(JSON.stringify(line));
    continue;
  }
  const { at, part, event: name, v, sid, stack, stderrTail, ...rest } = line;
  const fields = Object.entries(rest)
    .map(([key, value]) => `${key}=${short(value)}`)
    .join(' ');
  console.log(`${String(at).slice(11, 23)} ${part.padEnd(6)} ${String(name).padEnd(18)} ${fields}`);
  if (failures || request) {
    if (stack) console.log('    ' + String(stack).split('\n').slice(0, 6).join('\n    '));
    if (stderrTail)
      console.log('    stderr: ' + String(stderrTail).slice(-600).replace(/\n/g, '\n    '));
  }
}
const versions = [...new Set(lines.map((line) => `${line.part}@${line.v ?? '?'}`))].join(', ');
console.error(
  `${chosen.length} of ${lines.length} lines (${day}${failures ? ', failures' : ''}${request ? ', request ' + request : ''})` +
    (versions ? ` · versions ${versions}` : '') +
    (unreadable ? ` · ${unreadable} unreadable line(s) skipped` : ''),
);
