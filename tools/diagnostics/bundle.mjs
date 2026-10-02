#!/usr/bin/env node
// [진단 묶음 내보내기] from the command line (T-126): the same zip the engine's
// `POST /api/v1/diagnostics/bundle` writes — logs, exit records, versions and a settings summary,
// never keys, logins, the workspace DB or request text.
//
//   node tools/diagnostics/bundle.mjs [--data <folder>] [--days N] [--dumps] [--out <folder>]
//
// Default data folder: %LOCALAPPDATA%\VIDE (the installed work engine's).
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeDiagnosticBundle } from '../../src/server/diagnostic-bundle.ts';

const args = process.argv.slice(2);
const value = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
if (args.includes('--help')) {
  console.log(
    'node tools/diagnostics/bundle.mjs [--data <folder>] [--days N] [--dumps] [--out <folder>]',
  );
  process.exit(0);
}
const directory = resolve(value('--data') ?? join(process.env.LOCALAPPDATA || homedir(), 'VIDE'));
const days = value('--days') ? Math.max(1, Math.min(14, Number(value('--days')))) : undefined;
const bundle = await writeDiagnosticBundle({
  directory,
  days,
  dumps: args.includes('--dumps'),
  ...(value('--out') ? { output: resolve(value('--out')) } : {}),
});
console.log(`${bundle.file} (${Math.round(bundle.bytes / 1024)} KB, ${bundle.files.length} files)`);
for (const name of bundle.files) console.log('  ' + name);
