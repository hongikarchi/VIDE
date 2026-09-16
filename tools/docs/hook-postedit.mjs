#!/usr/bin/env node
// Claude Code PostToolUse hook (see .claude/settings.json).
// After Edit/Write of a .md file inside this repo, regenerate the HTML renders.
// Never blocks the agent: any failure is reported and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
let file = '';
try {
  const j = JSON.parse(input || '{}');
  file = (j.tool_input && (j.tool_input.file_path || j.tool_input.notebook_path)) || '';
} catch { /* not json */ }
if (!file || !/\.md$/i.test(file)) process.exit(0);
const abs = path.resolve(file);
if (!abs.toLowerCase().startsWith(ROOT.toLowerCase())) process.exit(0);
if (/[\\/]node_modules[\\/]/.test(abs)) process.exit(0);
if (!fs.existsSync(path.join(ROOT, 'tools', 'docs', 'node_modules'))) {
  console.log('docs: tools/docs/node_modules 가 없어 HTML을 재생성하지 못했습니다. `npm --prefix tools/docs install` 후 `npm --prefix tools/docs run build`.');
  process.exit(0);
}
const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'docs', 'build.mjs'), '--quiet'], { cwd: ROOT, encoding: 'utf8' });
if (r.status !== 0) {
  console.log('docs: HTML 재생성 실패 — ' + (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | '));
  process.exit(0);
}
const changed = (r.stdout || '').trim().split('\n').filter(Boolean);
console.log(changed.length ? 'docs: HTML 재생성 — ' + changed.join(', ') : 'docs: HTML 변경 없음');
