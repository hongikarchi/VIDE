// `npm run jig:pack -- <jig folder> --data-dir <data folder> [--out <folder>] [--no-bundle]`:
// validate, self-test, bundle the steps, digest and sign with this PC's key (ARCH-03 §12).
// The data folder holds `jig-signing.key`; the installed build's is %LOCALAPPDATA%\VIDE and
// the dev engine's is .vide/dev-data — name the one whose VIDE will import the pack.
import { packJig } from '../../src/jigs/runtime/pack.ts';
import { parseArgs, printIssues, printSelftest, sourceDir } from './common.mjs';

const options = parseArgs(process.argv.slice(2));
const dir = sourceDir(
  options,
  '사용법: npm run jig:pack -- <jig 폴더> --data-dir <데이터 폴더> [--out <폴더>] [--no-bundle] [--skip-tests]',
);
if (!options['data-dir']) {
  console.error('--data-dir <데이터 폴더>가 필요합니다 (jig-signing.key 위치)');
  process.exit(2);
}
try {
  const result = await packJig(dir, {
    dataDir: options['data-dir'],
    outDir: options.out ?? '.vide/jig-packs',
    bundle: !options['no-bundle'],
    skipTests: !!options['skip-tests'],
  });
  printIssues(result.jig.issues);
  if (result.selftest) printSelftest(result.selftest);
  console.log(
    `묶음: ${result.file} (${result.bytes.length} bytes, digest ${result.pack.digest.slice(0, 16)}, keyId ${result.pack.sig.keyId})`,
  );
} catch (error) {
  console.error(`실패: ${error.code ?? error.message}`);
  if (error.issues) printIssues(error.issues);
  process.exit(1);
}
