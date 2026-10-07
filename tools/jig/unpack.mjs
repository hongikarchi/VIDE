// `npm run jig:unpack -- <pack.vjig> --digest <sha256> [--out extensions/jigs] [--force]`:
// the admins' tool for a jig a user submitted (ADR-041, SPEC-07.19 8). Download the pack from the
// account site's jig 제출함 and pass the SHA-256 the box shows. The tool checks that digest and the
// pack's content digest (not the other PC's signature), refuses paths outside the package and
// forbidden files, writes the sources to `<out>/<name>/` (an existing folder only with --force)
// and prints the format check. Review the change in git, then `npm run jig:test -- <folder>`.
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { unpackSubmission } from '../../src/jigs/runtime/unpack.ts';
import { parseArgs, printIssues } from './common.mjs';

const MESSAGES = {
  DIGEST_REQUIRED:
    '--digest <sha256>가 필요합니다. 사이트의 jig 제출함에 보이는 SHA-256을 넣으세요.',
  DIGEST_MISMATCH: '파일의 SHA-256이 사이트에 기록된 값과 다릅니다. 다시 내려받으세요.',
  JIG_INVALID: 'jig 묶음 형식이 아닙니다.',
  PATH_OUTSIDE: '묶음에 패키지 밖을 가리키는 경로가 있어 풀지 않았습니다.',
  PACK_DIGEST_MISMATCH: '묶음 안의 파일이 묶음의 내용 지문과 맞지 않아 풀지 않았습니다.',
  JIG_FORBIDDEN_FILE: '묶음에 금지 파일이 있어 풀지 않았습니다.',
  FOLDER_EXISTS: '같은 이름의 폴더가 이미 있습니다. 바꾸려면 --force를 붙이세요.',
};

const options = parseArgs(process.argv.slice(2));
// `--force <file>` reads as a value; a flag that holds a path is the path.
if (typeof options.force === 'string') {
  options._.unshift(options.force);
  options.force = true;
}
const file = options._[0];
if (!file) {
  console.error(
    '사용법: npm run jig:unpack -- <묶음.vjig> --digest <sha256> [--out extensions/jigs] [--force]',
  );
  process.exit(2);
}
try {
  const result = await unpackSubmission(readFileSync(resolve(file)), {
    digest: typeof options.digest === 'string' ? options.digest : '',
    outRoot: typeof options.out === 'string' ? options.out : 'extensions/jigs',
    force: options.force === true,
  });
  console.log(
    `${result.replaced ? '바꿈' : '풂'}: ${result.id} v${result.version} → ${relative(process.cwd(), result.dir) || result.dir} (파일 ${result.files.length}개)`,
  );
  for (const path of result.files) console.log(`  ${path}`);
  if (result.validation.ok) console.log('형식 점검: 통과');
  else console.log('형식 점검: 실패 — 파일은 남겨 두었습니다. 고친 뒤 다시 점검하세요.');
  printIssues(result.validation.issues);
  if (!result.validation.ok) process.exitCode = 1;
} catch (error) {
  const code = error?.code ?? 'FAILED';
  console.error(
    `실패: ${MESSAGES[code] ?? code}${error?.paths ? ` (${error.paths.join(', ')})` : ''}`,
  );
  if (!error?.code) console.error(error);
  process.exit(1);
}
