// `npm run jig:test -- <jig folder> [--runner engine|child]`: the self-test fixtures with the step
// runner and no host.
import { selftestJig, validateJig } from '../../src/jigs/runtime/pack.ts';
import { parseArgs, printIssues, printSelftest, sourceDir } from './common.mjs';

const options = parseArgs(process.argv.slice(2));
const dir = sourceDir(options, '사용법: npm run jig:test -- <jig 폴더> [--runner engine|child]');
const validation = await validateJig(dir, { source: options.source });
printIssues(validation.issues);
if (!validation.ok) {
  console.log('형식 점검 실패');
  process.exit(1);
}
const report = await selftestJig(dir, { runner: options.runner, source: options.source });
console.log(
  `${report.ok ? '통과' : '실패'} ${report.id}@${report.version} (${report.cases.length}건)`,
);
printSelftest(report);
process.exit(report.ok ? 0 : 1);
