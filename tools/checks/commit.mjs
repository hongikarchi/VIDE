import { spawnSync, execFileSync } from 'node:child_process';
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
const staged = git(['diff', '--cached', '--name-only', '-z']);
const code = (name) =>
  /^(\.prettier|\.gitleaks)/.test(name) ||
  /^(src|hosts|extensions|tests|tools\/checks|\.github|\.githooks)\//.test(name) ||
  /(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vite[^/]*\.ts)$/.test(name);
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) process.exit(1);
}
run(process.execPath, ['tools/checks/secrets.mjs', 'staged']);
// Example env files are tracked: secret-like variables must stay empty (real values go to .env).
// Deleted example files have no staged content to inspect.
const present = new Set(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']));
for (const name of staged.filter(
  (file) => present.has(file) && /(^|\/)\.[\w.-]*\.example$|\.env\.example$/.test(file),
)) {
  const text = execFileSync('git', ['show', ':' + name], { encoding: 'utf8' });
  const filled = text
    .split(/\r?\n/)
    .filter((line) => /^\s*[\w.]*(KEY|TOKEN|SECRET|PASSWORD)[\w.]*\s*=\s*\S/i.test(line));
  if (filled.length) {
    console.error(
      `${name}에 비밀값이 들어 있습니다. 실제 값은 .env(Git 무시)에 넣고 예시 파일은 비워 두세요.`,
    );
    process.exit(1);
  }
}
if (staged.some(code)) {
  const unstaged = git(['diff', '--name-only', '-z']).filter(code);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).filter(code);
  if (unstaged.length || untracked.length) {
    console.error(
      'Stage all affected code inputs before commit; working-tree checks must match the commit.',
    );
    process.exit(1);
  }
  run(process.execPath, [
    'node_modules/prettier/bin/prettier.cjs',
    '--check',
    '{src,hosts,extensions,tests,tools/checks}/**/*.{ts,tsx,js,mjs,css,json,jsonc}',
    '*.{json,ts}',
  ]);
  // No write-mode formatter and no automatic staging of user edits.
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.ui.json']);
  run(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '-p',
    'tsconfig.server.json',
    '--noEmit',
  ]);
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'src/sharing/tsconfig.json']);
  run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
  run(process.execPath, [
    '--test',
    'tests/core/*.test.mjs',
    'tests/ai/*.test.mjs',
    'tests/server/*.test.mjs',
  ]);
}
