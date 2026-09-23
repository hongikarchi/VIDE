import { spawnSync, execFileSync } from 'node:child_process';
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
const staged = git(['diff', '--cached', '--name-only', '-z']);
const code = (name) =>
  /^(src|hosts|extensions|tests|tools\/checks)\//.test(name) ||
  /(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vite[^/]*\.ts)$/.test(name);
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) process.exit(1);
}
run(process.execPath, ['tools/checks/secrets.mjs', 'staged']);
if (staged.some(code)) {
  const unstaged = git(['diff', '--name-only', '-z']).filter(code);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).filter(code);
  if (unstaged.length || untracked.length) {
    console.error(
      'Stage all affected code inputs before commit; working-tree checks must match the commit.',
    );
    process.exit(1);
  }
  // No write-mode formatter and no automatic staging of user edits.
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.ui.json']);
  run(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '-p',
    'tsconfig.server.json',
    '--noEmit',
  ]);
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'src/sharing/tsconfig.json']);
}
