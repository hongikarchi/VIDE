// Shared bits of the jig CLI wrappers (`npm run jig:validate|test|pack`): argument parsing and
// the printed report. The work itself is `src/jigs/runtime/pack.ts`, the same code the
// make-conversation's `jig_validate`/`jig_test` tools use.

import { isAbsolute, relative, resolve } from 'node:path';
import { officialJigRoot } from '../../src/jigs/runtime/loader.ts';

export function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=');
      if (inline !== undefined) options[name] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) options[name] = argv[++i];
      else options[name] = true;
    } else options._.push(arg);
  }
  return options;
}

export function sourceDir(options, usage) {
  const dir = options._[0];
  if (!dir) {
    console.error(usage);
    process.exit(2);
  }
  const folder = resolve(dir);
  // An official tool jig (`src/jigs/official/jigs/<name>`) is built in: its steps run in the engine.
  const inside = relative(officialJigRoot(), folder);
  if (options.source === undefined && inside && !inside.startsWith('..') && !isAbsolute(inside))
    options.source = 'builtin';
  return folder;
}

export function printIssues(issues) {
  for (const issue of issues)
    console.log(`  [${issue.level}] ${issue.code} ${issue.path}: ${issue.message}`);
}

export function printSelftest(report) {
  for (const testCase of report.cases) {
    console.log(`  ${testCase.ok ? 'PASS' : 'FAIL'} ${testCase.name}`);
    for (const step of testCase.steps) {
      const gates = step.gates
        .filter((g) => !g.ok)
        .map((g) => `${g.name}(${g.level}): ${g.message}`);
      console.log(
        `    ${step.id}: ${step.status}${step.ms !== null ? ` ${step.ms} ms` : ''}${step.error ? ` ${step.error.code} ${step.error.message}` : ''}${gates.length ? ` | ${gates.join('; ')}` : ''}`,
      );
    }
    for (const mismatch of testCase.mismatches)
      console.log(
        `    - ${mismatch.path}: 기대 ${JSON.stringify(mismatch.expected)} 실제 ${JSON.stringify(mismatch.actual)}`,
      );
    if (testCase.error) console.log(`    ! ${testCase.error}`);
  }
}
