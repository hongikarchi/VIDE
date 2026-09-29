// `npm run jig:validate -- <jig folder>`: manifest, references, gates, capabilities, files.
import { validateJig } from '../../src/jigs/runtime/pack.ts';
import { parseArgs, printIssues, sourceDir } from './common.mjs';

const options = parseArgs(process.argv.slice(2));
const dir = sourceDir(
  options,
  '사용법: npm run jig:validate -- <jig 폴더> [--source dev-source|dev-pack|builtin|ai-draft]',
);
const report = await validateJig(dir, { source: options.source });
console.log(
  `${report.ok ? '통과' : '실패'} ${report.id ?? dir}${report.version ? '@' + report.version : ''}${report.digest ? ' digest ' + report.digest.slice(0, 16) : ''}`,
);
printIssues(report.issues);
process.exit(report.ok ? 0 : 1);
